import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack } from 'mediabunny';
import { PRESETS, loadWeights, type Preset, type WeightSet } from './models';
import type { Target } from './resolutions';
import { acquire, current, release, swapNetwork } from './websr-instance';

export interface Thumbnail {
  timestamp: number;
  /** JPEG data URL, small enough to keep all of them in memory. */
  url: string;
}

export interface PreviewFrame {
  original: HTMLCanvasElement;
  upscaled: HTMLCanvasElement;
}

const THUMB_HEIGHT = 72;

/**
 * Keeps a decoded view of the chosen file open so the settings screen can pull
 * arbitrary frames and upscale them on demand, without re-parsing the container
 * on every slider nudge.
 */
export class PreviewSession {
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly codec: string | null;
  readonly hasAudio: boolean;

  private readonly sink: VideoSampleSink;

  /** Canvas WebSR draws into — always 2x the source. */
  private readonly srCanvas = document.createElement('canvas');
  /** Canvas shown to the user — the 2x result resampled to the chosen target. */
  private readonly outCanvas = document.createElement('canvas');
  private readonly origCanvas = document.createElement('canvas');

  private ready = false;

  private constructor(track: InputVideoTrack, duration: number, hasAudio: boolean) {
    this.sink = new VideoSampleSink(track);
    this.width = track.displayWidth;
    this.height = track.displayHeight;
    this.duration = duration;
    this.codec = track.codec;
    this.hasAudio = hasAudio;
  }

  static async open(file: File): Promise<PreviewSession> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('That file has no video track.');
    if (!(await track.canDecode())) {
      throw new Error('Your browser cannot decode this video codec. Try an H.264 MP4.');
    }
    const audio = await input.getPrimaryAudioTrack();
    return new PreviewSession(track, await input.computeDuration(), !!audio);
  }

  /** Evenly spaced stills for the filmstrip. */
  async thumbnails(count = 5): Promise<Thumbnail[]> {
    const timestamps = Array.from({ length: count }, (_, i) => (i / count) * this.duration);
    const canvas = document.createElement('canvas');
    canvas.height = THUMB_HEIGHT;
    canvas.width = Math.round((THUMB_HEIGHT * this.width) / this.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get a 2D context for thumbnails.');

    const out: Thumbnail[] = [];
    let index = 0;
    for await (const sample of this.sink.samplesAtTimestamps(timestamps)) {
      const timestamp = timestamps[index++] ?? 0;
      if (!sample) continue;
      sample.draw(context, 0, 0, canvas.width, canvas.height);
      sample.close();
      out.push({ timestamp, url: canvas.toDataURL('image/jpeg', 0.62) });
    }
    return out;
  }

  /**
   * Decodes one frame, runs it through the network and resamples to `target`.
   * Returns canvases rather than images so the compare view can size them with
   * plain CSS.
   */
  async render(
    timestamp: number,
    preset: Preset,
    set: WeightSet,
    target: Target,
  ): Promise<PreviewFrame> {
    const weights = await loadWeights(preset, set);
    const network = PRESETS[preset].network;

    // An export releases the shared instance, so re-acquire whenever it's gone.
    let websr = this.ready ? swapNetwork(network, weights) : null;
    if (!websr) {
      websr = await acquire({
        canvas: this.srCanvas,
        network,
        weights,
        resolution: { width: this.width, height: this.height },
      });
      this.ready = true;
    }

    const sample = await this.sink.getSample(timestamp);
    if (!sample) throw new Error('Could not decode a frame at that position.');

    try {
      const frame = sample.toVideoFrame();
      try {
        await websr.render(frame);
      } finally {
        frame.close();
      }

      this.origCanvas.width = this.width;
      this.origCanvas.height = this.height;
      draw2d(this.origCanvas, (context) => sample.draw(context, 0, 0, this.width, this.height));
    } finally {
      sample.close();
    }

    this.outCanvas.width = target.width;
    this.outCanvas.height = target.height;
    draw2d(this.outCanvas, (context) =>
      context.drawImage(this.srCanvas, 0, 0, target.width, target.height),
    );

    return { original: this.origCanvas, upscaled: this.outCanvas };
  }

  /** Frees the GPU instance so an export can take it over. */
  async suspend(): Promise<void> {
    this.ready = false;
    await release();
  }

  async close(): Promise<void> {
    await this.suspend();
  }

  /** True while this session still owns the shared WebSR instance. */
  get holdsGpu(): boolean {
    return this.ready && current() !== null;
  }
}

function draw2d(canvas: HTMLCanvasElement, paint: (context: CanvasRenderingContext2D) => void) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not get a 2D context.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, canvas.width, canvas.height);
  paint(context);
}
