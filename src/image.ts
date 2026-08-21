import { PRESETS, loadWeights, type Preset, type WeightSet } from './models';
import type { Target } from './resolutions';
import { acquire, release, swapNetwork } from './websr-instance';
import type { PreviewFrame } from './preview';

/**
 * Tile edge, in source pixels. Every stage buffer is
 * `tile * tile * 4 channels * 4 bytes`, and the widest network allocates about
 * 73 of them, so 512 keeps a full-quality pass near 300 MB. Running a photo
 * whole would need tens of gigabytes — a 12MP image at width 7 works out to
 * roughly 13 GB.
 */
const TILE = 512;

/**
 * Overlap discarded from each tile edge. The network sees 3x3 over seven
 * stages, so a pixel is influenced by at most 7 pixels around it; 16 is
 * comfortably past that and keeps seams invisible.
 */
const OVERLAP = 16;

export interface ImageInfo {
  width: number;
  height: number;
  type: string;
}

/**
 * Image counterpart to {@link PreviewSession}. Exposes the same surface so the
 * UI can drive either without caring which it has.
 */
export class ImageSession {
  readonly kind = 'image' as const;
  readonly width: number;
  readonly height: number;
  readonly duration = 0;
  readonly codec: string;
  readonly hasAudio = false;

  private readonly bitmap: ImageBitmap;
  private readonly srCanvas = document.createElement('canvas');
  private readonly outCanvas = document.createElement('canvas');
  private readonly origCanvas = document.createElement('canvas');

  /** Last render, so the export doesn't redo the work the preview just did. */
  private cacheKey = '';

  private ready = false;
  private tiled = false;

  private constructor(bitmap: ImageBitmap, type: string) {
    this.bitmap = bitmap;
    this.width = bitmap.width;
    this.height = bitmap.height;
    this.codec = type.replace(/^image\//, '') || 'image';
  }

  static async open(file: File): Promise<ImageSession> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('That image could not be decoded. Try PNG, JPEG or WebP.');
    }
    return new ImageSession(bitmap, file.type);
  }

  /** No filmstrip for a still. */
  async thumbnails(): Promise<never[]> {
    return [];
  }

  /**
   * Upscales the whole image and resamples to `target`.
   *
   * `_timestamp` exists only to match the video session's signature.
   */
  async render(
    _timestamp: number,
    preset: Preset,
    set: WeightSet,
    target: Target,
  ): Promise<PreviewFrame> {
    const key = `${preset}:${set}:${target.width}x${target.height}`;
    if (key !== this.cacheKey) {
      await this.upscale(preset, set);
      this.cacheKey = key;

      this.outCanvas.width = target.width;
      this.outCanvas.height = target.height;
      draw(this.outCanvas, (context) =>
        context.drawImage(this.srCanvas, 0, 0, target.width, target.height),
      );

      this.origCanvas.width = this.width;
      this.origCanvas.height = this.height;
      draw(this.origCanvas, (context) => context.drawImage(this.bitmap, 0, 0));
    }
    return { original: this.origCanvas, upscaled: this.outCanvas };
  }

  /** PNG so the upscale isn't immediately thrown away by JPEG quantisation. */
  async toBlob(preset: Preset, set: WeightSet, target: Target): Promise<Blob> {
    await this.render(0, preset, set, target);
    const blob = await new Promise<Blob | null>((resolve) =>
      this.outCanvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('Could not encode the upscaled image.');
    return blob;
  }

  /** Renders the 2x result into `srCanvas`, tiling when the image is large. */
  private async upscale(preset: Preset, set: WeightSet) {
    const weights = await loadWeights(preset, set);
    const network = PRESETS[preset].network;
    const needsTiling = this.width > TILE || this.height > TILE;

    // Changing tiling mode changes the network's input size, so rebuild.
    if (this.ready && this.tiled !== needsTiling) await release();

    this.srCanvas.width = this.width * 2;
    this.srCanvas.height = this.height * 2;

    if (!needsTiling) {
      const websr = await this.instance(network, weights, this.width, this.height);
      await websr.render(this.bitmap);
      // The network drew straight into its own canvas at 2x, which is already
      // the size we want, so just copy it across.
      draw(this.srCanvas, (context) => context.drawImage(websr.canvas, 0, 0));
      this.tiled = false;
      return;
    }

    const websr = await this.instance(network, weights, TILE, TILE);
    this.tiled = true;

    const context = this.srCanvas.getContext('2d');
    if (!context) throw new Error('Could not get a 2D context for the output image.');
    context.imageSmoothingEnabled = false;

    // Every tile is exactly TILE square — edge tiles are shifted inwards rather
    // than shrunk, so the network never has to resize (which would rebuild the
    // whole GPU context per tile).
    const step = TILE - 2 * OVERLAP;
    for (let top = 0; top < this.height; top += step) {
      for (let left = 0; left < this.width; left += step) {
        const sx = Math.min(left, Math.max(0, this.width - TILE));
        const sy = Math.min(top, Math.max(0, this.height - TILE));

        const tile = await createImageBitmap(
          this.bitmap,
          sx,
          sy,
          Math.min(TILE, this.width - sx),
          Math.min(TILE, this.height - sy),
        );
        try {
          await websr.render(tile);
        } finally {
          tile.close();
        }

        // Keep the tile's interior; trim the overlap except at the image edges,
        // where there is no neighbouring tile to blend with.
        const trimLeft = sx === 0 ? 0 : OVERLAP;
        const trimTop = sy === 0 ? 0 : OVERLAP;
        const keepWidth = Math.min(TILE - trimLeft, this.width - sx - trimLeft);
        const keepHeight = Math.min(TILE - trimTop, this.height - sy - trimTop);

        context.drawImage(
          websr.canvas,
          trimLeft * 2,
          trimTop * 2,
          keepWidth * 2,
          keepHeight * 2,
          (sx + trimLeft) * 2,
          (sy + trimTop) * 2,
          keepWidth * 2,
          keepHeight * 2,
        );
      }
    }
  }

  private async instance(network: string, weights: unknown, width: number, height: number) {
    const existing = this.ready ? swapNetwork(network, weights) : null;
    if (existing) return existing;
    const websr = await acquire({
      canvas: document.createElement('canvas'),
      network,
      weights,
      resolution: { width, height },
    });
    this.ready = true;
    return websr;
  }

  async suspend(): Promise<void> {
    this.ready = false;
    this.cacheKey = '';
    await release();
  }

  async close(): Promise<void> {
    await this.suspend();
    this.bitmap.close();
  }
}

function draw(canvas: HTMLCanvasElement, paint: (context: CanvasRenderingContext2D) => void) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D context.');
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, canvas.width, canvas.height);
  paint(context);
}

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|webp|gif|bmp|avif)$/i;

export function isImageFile(file: File): boolean {
  return IMAGE_TYPES.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
}
