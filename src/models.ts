import { loadBinWeights, registerExtraNetworks } from './websr-ext/register';
import type { BinWeights } from './websr-ext/bin-weights';

registerExtraNetworks();

/** How much GPU work we're willing to spend per frame. */
export type Preset = 'fast' | 'balanced' | 'quality';

/** Which set of trained weights to run through the network. */
export type WeightSet = 'default' | 'own';

interface PresetInfo {
  /** Registered WebSR network name. */
  network: string;
  /** One weight file per set — same architecture, different training. */
  files: Record<WeightSet, string>;
  label: string;
  hint: string;
  params: number;
}

/**
 * The three widths of the Anime4K 2x CNN. WebSR only implements the narrowest
 * of these; the other two run on the width-generic layers in `websr-ext/`.
 */
export const PRESETS: Record<Preset, PresetInfo> = {
  fast: {
    network: 'anime4k/cnn-2x-8',
    files: { default: 'assets/m1.dat', own: 'assets/sr-8ch.bin' },
    label: 'Fast',
    hint: '8 channels · ~8.6k params · realtime on most GPUs',
    params: 8612,
  },
  balanced: {
    network: 'anime4k/cnn-2x-16',
    files: { default: 'assets/m2.dat', own: 'assets/sr-16ch.bin' },
    label: 'Balanced',
    hint: '16 channels · ~31k params · a good default',
    params: 31036,
  },
  quality: {
    network: 'anime4k/cnn-2x-28',
    files: { default: 'assets/m3.dat', own: 'assets/sr-28ch.bin' },
    label: 'Quality',
    hint: '28 channels · ~91k params · slow without a dedicated GPU',
    params: 90592,
  },
};

export const WEIGHT_SETS: Record<WeightSet, { label: string; note: string }> = {
  default: { label: 'Default', note: 'The weights this build shipped with.' },
  own: { label: 'Ours', note: 'Trained in-house on a CC0 image set.' },
};

function url(preset: Preset, set: WeightSet): string {
  // Resolve against the deploy base. A bare relative URL would break on a page
  // served without a trailing slash (/ai-upscaler vs /ai-upscaler/).
  return import.meta.env.BASE_URL + PRESETS[preset].files[set];
}

export function loadWeights(preset: Preset, set: WeightSet): Promise<BinWeights> {
  return loadBinWeights(url(preset, set));
}

/** Which (set, tier) pairs have a weight file present. */
export type Availability = Record<WeightSet, Record<Preset, boolean>>;

async function present(preset: Preset, set: WeightSet): Promise<boolean> {
  try {
    const response = await fetch(url(preset, set), { method: 'HEAD' });
    // A dev server with SPA fallback answers 200 with index.html for files
    // that do not exist, so the status alone proves nothing — a real weight
    // file never comes back as HTML.
    const type = response.headers.get('content-type') ?? '';
    return response.ok && !type.includes('text/html');
  } catch {
    return false;
  }
}

/**
 * Probe every set and tier. Neither set can be assumed complete: in-house
 * weights arrive one width at a time, and a clone of the repository has no
 * `default` files at all — those are not ours to redistribute, so they are
 * gitignored. The UI has to cope with any subset being absent, including a
 * whole set.
 */
export async function probeWeightSets(): Promise<Availability> {
  const sets = Object.keys(WEIGHT_SETS) as WeightSet[];
  const presets = Object.keys(PRESETS) as Preset[];
  const pairs = sets.flatMap((set) => presets.map((preset) => ({ set, preset })));
  const found = await Promise.all(pairs.map(({ set, preset }) => present(preset, set)));

  const availability = Object.fromEntries(
    sets.map((set) => [set, Object.fromEntries(presets.map((preset) => [preset, false]))]),
  ) as Availability;
  for (const [i, pair] of pairs.entries()) availability[pair.set][pair.preset] = found[i];
  return availability;
}
