import { NetworkList, NetworkScales } from '@websr/websr/src/networks/network_list';
import { makeCNN2X } from './cnn-2x-n';
import { inferWidth, parseBinWeights, type BinWeights } from './bin-weights';

/**
 * WebSR resolves networks through a module-level registry, so wider variants can
 * be added at runtime without forking the package. Widths are in 4-channel
 * buffers: 2 = 8 channels (what WebSR ships), 4 = 16, 7 = 28.
 */
const EXTRA_NETWORKS: Record<string, number> = {
  'anime4k/cnn-2x-8': 2,
  'anime4k/cnn-2x-16': 4,
  'anime4k/cnn-2x-28': 7,
};

let registered = false;

export function registerExtraNetworks() {
  if (registered) return;
  const list = NetworkList as unknown as Record<string, unknown>;
  const scales = NetworkScales as unknown as Record<string, number>;

  for (const [name, width] of Object.entries(EXTRA_NETWORKS)) {
    list[name] = makeCNN2X(width);
    scales[name] = 2;
  }
  registered = true;
}

const cache = new Map<string, Promise<BinWeights>>();

/** Fetches and parses a packed `.bin` weight file, memoised per URL. */
export function loadBinWeights(url: string): Promise<BinWeights> {
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load weights (${response.status})`);
      const parsed = parseBinWeights(await response.arrayBuffer());
      return parsed;
    });
    cache.set(url, pending);
  }
  return pending;
}

export { inferWidth };
