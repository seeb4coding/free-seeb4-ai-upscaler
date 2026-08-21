/**
 * Reader for the packed `.bin` weight container used by the newer Anime4K
 * networks, which ship as binary rather than the JSON WebSR's loader expects.
 *
 * Layout, little-endian throughout:
 *
 *   magic[4]  "A4K\0"
 *   u32       version
 *   u32       layerCount
 *   per layer:
 *     u32     nameLength
 *     u8[]    name           (no padding — records are not aligned)
 *     u32     weightCount    (floats)
 *     u32     biasCount      (floats)
 *     f32[]   weights
 *     f32[]   bias
 *
 * Verified byte-exact against cnn-8 / cnn-16 / cnn-28: parsing consumes the
 * file with nothing left over.
 */

export interface LayerWeights {
  weights: Float32Array;
  bias: Float32Array;
}

export interface BinWeights {
  magic: string;
  version: number;
  /** Shaped like the JSON weights, so the existing layers can consume it. */
  layers: Record<string, LayerWeights>;
}

const MAGIC_ANIME4K = 'A4K';

export function parseBinWeights(buffer: ArrayBuffer): BinWeights {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!).replace(/\0+$/, '');
  if (magic !== MAGIC_ANIME4K) {
    throw new Error(`Unexpected weight format "${magic}" — expected ${MAGIC_ANIME4K}.`);
  }

  const version = view.getUint32(4, true);
  const layerCount = view.getUint32(8, true);
  let offset = 12;

  const layers: Record<string, LayerWeights> = {};
  for (let i = 0; i < layerCount; i++) {
    const nameLength = view.getUint32(offset, true);
    offset += 4;
    const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;

    const weightCount = view.getUint32(offset, true);
    const biasCount = view.getUint32(offset + 4, true);
    offset += 8;

    // The float arrays are not 4-byte aligned within the file, so they have to
    // be copied out rather than viewed in place.
    const weights = new Float32Array(weightCount);
    for (let w = 0; w < weightCount; w++) weights[w] = view.getFloat32(offset + w * 4, true);
    offset += weightCount * 4;

    const bias = new Float32Array(biasCount);
    for (let b = 0; b < biasCount; b++) bias[b] = view.getFloat32(offset + b * 4, true);
    offset += biasCount * 4;

    layers[name] = { weights, bias };
  }

  if (offset !== buffer.byteLength) {
    throw new Error(`Weight file did not parse cleanly (${offset} of ${buffer.byteLength} bytes).`);
  }

  return { magic, version, layers };
}

/**
 * Infers how many 4-channel buffers wide the network is from the first-stage
 * layer names (conv2d_tf, conv2d_tf1, … conv2d_tf6 → width 7).
 */
export function inferWidth(weights: BinWeights): number {
  let width = 0;
  while (weights.layers[width === 0 ? 'conv2d_tf' : `conv2d_tf${width}`]) width++;
  if (width === 0) throw new Error('Weights contain no conv2d_tf layer.');
  return width;
}
