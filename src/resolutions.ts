export interface Target {
  label: string;
  width: number;
  height: number;
  /** True when this is exactly what the network outputs, with no resample after. */
  native: boolean;
}

const LADDER: Array<[height: number, label: string]> = [
  [720, '720p'],
  [1080, '1080p'],
  [1440, '2K'],
  [2160, '4K'],
];

/** Codecs want even dimensions, and chroma subsampling breaks on odd ones. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function fit(label: string, srcWidth: number, srcHeight: number, height: number, native: boolean): Target {
  return {
    label,
    width: even((height * srcWidth) / srcHeight),
    height: even(height),
    native,
  };
}

/**
 * The networks output exactly 2x, so that is the ceiling — anything beyond it
 * would just be interpolation dressed up as AI. Standard rungs below the
 * ceiling are offered too, reached by downsampling the 2x result.
 */
export function targetsFor(srcWidth: number, srcHeight: number): Target[] {
  const ceiling = even(srcHeight * 2);
  const targets = LADDER.filter(([height]) => height > srcHeight && height < ceiling).map(
    ([height, label]) => fit(label, srcWidth, srcHeight, height, false),
  );

  const ceilingLabel = LADDER.find(([height]) => even(height) === ceiling)?.[1] ?? '2×';
  targets.push(fit(ceilingLabel, srcWidth, srcHeight, ceiling, true));

  return targets;
}
