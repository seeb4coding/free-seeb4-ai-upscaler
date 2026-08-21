import NeuralNetwork from '@websr/websr/src/networks/base_network';
import Anime4KConv3x4 from '@websr/websr/src/layers/anime4k/conv2d-3x4';
import DisplayLayer3C from '@websr/websr/src/layers/anime4k/display_3c';
import type Layer from '@websr/websr/src/layers/base_layer';
import {
  getSourceHeight,
  getSourceWidth,
  isHTMLVideoElement,
  isImageBitmap,
  isVideoFrame,
  type MediaSource,
} from '@websr/websr/src/utils';
import { GenericConv1x1Pass, GenericConv3x3, GenericSum } from './layers';
import type { BinWeights } from './bin-weights';

/** Stage 0 plus six refinement stages, all read by the final layer. */
const STAGES = 7;
/** The display layer consumes three colour planes. */
const PLANES = 3;

/** conv2d_tf, conv2d_tf1, … and conv2d_3_tf, conv2d_3_tf1, … */
const bufferName = (stage: number, index: number) =>
  `${stage === 0 ? 'conv2d_tf' : `conv2d_${stage}_tf`}${index === 0 ? '' : index}`;

const planeName = (plane: number) => `conv2d_last_tf${plane === 0 ? '' : plane}`;

/**
 * The Anime4K 2x CNN, generalised over network width.
 *
 * `width` counts 4-channel buffers per stage, so width 2 is the 8-channel
 * network WebSR ships, and widths 4 and 7 are the 16- and 28-channel networks.
 * Layer counts come out as width * 7 + 3, which matches the shipped weight
 * files exactly (17 / 31 / 52).
 */
export function makeCNN2X(width: number) {
  return class CNN2XN extends NeuralNetwork {
    model(): Layer[] {
      const layers: Layer[] = [];
      const context = this.context;
      const weights = (this.weights as BinWeights).layers;

      const need = (name: string) => {
        const layer = weights[name];
        if (!layer) throw new Error(`Weights are missing layer "${name}".`);
        return layer;
      };

      // Stage 0 reads the source texture directly — no activation to split yet.
      for (let index = 0; index < width; index++) {
        const name = bufferName(0, index);
        layers.push(new Anime4KConv3x4([context.input], context.buffer(name), need(name)));
      }

      // Each later stage convolves the whole previous stage.
      for (let stage = 1; stage < STAGES; stage++) {
        const sources = Array.from({ length: width }, (_, i) =>
          context.buffer(bufferName(stage - 1, i)),
        );
        for (let index = 0; index < width; index++) {
          const name = bufferName(stage, index);
          layers.push(new GenericConv3x3(sources, context.buffer(name), need(name), width));
        }
      }

      // The final 1x1 sees every stage at once. That is STAGES * width buffers,
      // far past the per-shader storage limit, so it runs as `width` passes of
      // STAGES buffers and the partials are summed.
      for (let plane = 0; plane < PLANES; plane++) {
        const name = planeName(plane);
        const planeWeights = need(name);
        const partials: GPUBuffer[] = [];

        for (let pass = 0; pass < width; pass++) {
          const sources = Array.from({ length: STAGES }, (_, stage) =>
            context.buffer(bufferName(stage, pass)),
          );
          const partial = context.buffer(`conv2d_last_${plane}_pt${pass}`);
          partials.push(partial);
          layers.push(new GenericConv1x1Pass(sources, partial, planeWeights, width, pass));
        }

        layers.push(new GenericSum(partials, context.buffer(name), planeWeights));
      }

      layers.push(
        new DisplayLayer3C(
          [
            ...Array.from({ length: PLANES }, (_, plane) => context.buffer(planeName(plane))),
            context.input,
          ],
          context.texture('output'),
        ),
      );

      return layers;
    }

    /**
     * The stage-0 convolutions and the display layer read the source texture,
     * which only exists once a frame arrives. Bind it and rebuild just those
     * layers, then run the graph.
     *
     * WebSR's own implementation patches layers 0 and 1 by index because it is
     * fixed at width 2; here the first `width` layers are stage 0.
     */
    async feedForward(source?: MediaSource) {
      const context = this.context;

      if (isHTMLVideoElement(source) || isVideoFrame(source)) {
        // Video frames can be sampled straight from their native format.
        context.input = context.device.importExternalTexture({ source });
      } else if (source) {
        const bitmap = isImageBitmap(source) ? source : await createImageBitmap(source);
        context.device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture: context.texture('input', { format: 'rgba8unorm' }) },
          [getSourceWidth(source), getSourceHeight(source)],
        );
        context.input = context.texture('input');
      }

      const rebind = (layer: Layer, slot: number) => {
        layer.inputs[slot] = context.input;
        layer.lazyLoadSetup();
      };

      for (let index = 0; index < width; index++) rebind(this.layers[index]!, 0);
      rebind(this.layers[this.layers.length - 1]!, PLANES);

      for (const layer of this.layers) layer.run();
    }
  };
}
