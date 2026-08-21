import WebSR from '@websr/websr';

/**
 * WebSR assigns its GPU context to `globalThis.context` on construction, so a
 * second live instance silently clobbers the first. Everything that needs the
 * network goes through here, which keeps exactly one alive at a time.
 */
let active: WebSR | null = null;
let device: GPUDevice | null = null;

export async function getDevice(): Promise<GPUDevice> {
  if (device) return device;
  const gpu = await WebSR.initWebGPU();
  if (!gpu) throw new Error('WebGPU is unavailable. Try Chrome, Edge or Opera 113+ on a machine with a GPU.');
  device = gpu;
  return gpu;
}

export interface AcquireParams {
  canvas: HTMLCanvasElement;
  network: string;
  weights: unknown;
  resolution: { width: number; height: number };
}

/** Tears down any previous instance and returns a fresh one. */
export async function acquire({ canvas, network, weights, resolution }: AcquireParams): Promise<WebSR> {
  await release();
  active = new WebSR({ canvas, gpu: await getDevice(), network_name: network as never, weights, resolution });
  return active;
}

/**
 * Swaps weights on the live instance, which is much cheaper than rebuilding the
 * GPU context. Falls back to nothing if there is no instance to swap on.
 */
export function swapNetwork(network: string, weights: unknown): WebSR | null {
  if (!active) return null;
  active.switchNetwork(network as never, weights);
  return active;
}

export function current(): WebSR | null {
  return active;
}

export async function release(): Promise<void> {
  if (!active) return;
  const instance = active;
  active = null;
  // WebSR.destroy() goes all the way down to GPUDevice.destroy(), so the cached
  // device dies with the instance. Drop it, or the next acquire() would hand
  // back a destroyed device whose renders silently produce nothing.
  device = null;
  await instance.destroy().catch(() => {});
}
