import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableVideoCodec,
  type InputVideoTrack,
} from 'mediabunny';
import { PRESETS, loadWeights, type Preset, type WeightSet } from './models';
import type { Target } from './resolutions';
import { acquire, release } from './websr-instance';

export interface Progress {
  stage: 'preparing' | 'upscaling' | 'finalizing';
  /** Frames pushed to the encoder so far. */
  frames: number;
  /** Presentation time reached, in seconds. */
  seconds: number;
  /** Source duration in seconds, or 0 when the container doesn't say. */
  duration: number;
  /** Throughput over the whole run, in frames per second. */
  fps: number;
}

export interface UpscaleOptions {
  preset: Preset;
  weightSet: WeightSet;
  target: Target;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export interface UpscaleResult {
  blob: Blob;
  width: number;
  height: number;
  frames: number;
  elapsed: number;
}

export async function isSupported(): Promise<boolean> {
  return typeof navigator !== 'undefined' && !!navigator.gpu && 'VideoEncoder' in globalThis;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Upscale canceled', 'AbortError');
}

/**
 * Reads a file end to end, running every decoded frame through the WebGPU
 * network and re-muxing into MP4. Audio is copied packet for packet, so it is
 * never re-encoded and stays in sync via the original timestamps.
 */
export async function upscaleVideo(file: File, options: UpscaleOptions): Promise<UpscaleResult> {
  const { preset, weightSet, target, signal, onProgress } = options;
  const startedAt = performance.now();

  onProgress?.({ stage: 'preparing', frames: 0, seconds: 0, duration: 0, fps: 0 });

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('That file has no video track.');
  if (!(await videoTrack.canDecode())) {
    throw new Error('Your browser cannot decode this video codec. Try an H.264 MP4.');
  }

  const audioTrack = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();

  const srCanvas = document.createElement('canvas');
  const websr = await acquire({
    canvas: srCanvas,
    network: PRESETS[preset].network,
    weights: await loadWeights(preset, weightSet),
    resolution: { width: videoTrack.displayWidth, height: videoTrack.displayHeight },
  });

  // The network always outputs 2x. When the user asked for a lower rung we
  // resample once into a second canvas and encode that instead.
  const needsResample = !target.native;
  const outCanvas = needsResample ? document.createElement('canvas') : srCanvas;
  let outContext: CanvasRenderingContext2D | null = null;
  if (needsResample) {
    outCanvas.width = target.width;
    outCanvas.height = target.height;
    outContext = outCanvas.getContext('2d');
    if (!outContext) throw new Error('Could not get a 2D context for the output canvas.');
    outContext.imageSmoothingEnabled = true;
    outContext.imageSmoothingQuality = 'high';
  }

  const format = new Mp4OutputFormat();
  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
    width: outCanvas.width,
    height: outCanvas.height,
  });
  if (!codec) throw new Error('No hardware encoder available for the chosen resolution.');

  const output = new Output({ format, target: new BufferTarget() });
  const videoSource = new CanvasSource(outCanvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(videoSource, { frameRate: await estimateFrameRate(videoTrack) });

  const audioSource =
    audioTrack && audioTrack.codec ? new EncodedAudioPacketSource(audioTrack.codec) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  let frames = 0;
  const pumpVideo = async () => {
    const sink = new VideoSampleSink(videoTrack);
    for await (const sample of sink.samples()) {
      throwIfAborted(signal);
      const frame = sample.toVideoFrame();
      try {
        await websr.render(frame);
      } finally {
        frame.close();
      }
      outContext?.drawImage(srCanvas, 0, 0, target.width, target.height);

      // add() resolves once the encoder queue has room, which is what keeps
      // decode from running ahead of the GPU and exhausting memory.
      await videoSource.add(sample.timestamp, sample.duration);
      frames += 1;
      onProgress?.({
        stage: 'upscaling',
        frames,
        seconds: sample.timestamp,
        duration,
        fps: frames / ((performance.now() - startedAt) / 1000),
      });
      sample.close();
    }
  };

  const pumpAudio = async () => {
    if (!audioSource || !audioTrack) return;
    const decoderConfig = await audioTrack.getDecoderConfig();
    const sink = new EncodedPacketSink(audioTrack);
    for await (const packet of sink.packets()) {
      throwIfAborted(signal);
      await audioSource.add(packet, decoderConfig ? { decoderConfig } : undefined);
    }
  };

  try {
    await Promise.all([pumpVideo(), pumpAudio()]);
  } catch (error) {
    await output.cancel().catch(() => {});
    await release();
    throw error;
  }

  onProgress?.({ stage: 'finalizing', frames, seconds: duration, duration, fps: 0 });
  await output.finalize();
  await release();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('Muxing produced no output.');

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    width: outCanvas.width,
    height: outCanvas.height,
    frames,
    elapsed: (performance.now() - startedAt) / 1000,
  };
}

async function estimateFrameRate(track: InputVideoTrack) {
  try {
    const stats = await track.computePacketStats(120);
    return Math.round(stats.averagePacketRate) || 30;
  } catch {
    return 30;
  }
}
