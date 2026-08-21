/**
 * Hero backdrop that never autoplays — the clip only moves when the pointer
 * moves horizontally. Move right to scrub forward, left to scrub back.
 *
 * The clip must be encoded all-intra (every frame a keyframe). Scrub-seeking a
 * normally-encoded video is slow, because the decoder has to walk forward from
 * the nearest keyframe; with one keyframe per frame every seek is a single
 * decode. To re-encode a replacement:
 *
 *   ffmpeg -i in.mp4 -an -vf scale=1440:-2 -c:v libx264 -preset slow -crf 26 \
 *     -g 1 -keyint_min 1 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart \
 *     public/video/character-scrub.mp4
 */

const SOURCE = 'video/character-scrub.mp4';

/** How much of the clip a full-width pointer sweep covers. */
const SENSITIVITY = 0.8;

/**
 * The clip is 24fps. Seeking finer than half a frame lands on the frame already
 * on screen, so it costs a decode and shows nothing new.
 */
const FRAME_EPSILON = 1 / 48;

export function initBackgroundVideo() {
  const video = document.querySelector<HTMLVideoElement>('#hero-video');
  if (!video) return;

  // Resolve against the deploy base — a root-relative path would break when the
  // app is served from a subdirectory.
  video.src = import.meta.env.BASE_URL + SOURCE;

  let previousX: number | null = null;
  let pendingDelta = 0;
  let targetTime = 0;

  // mousemove can fire several times per displayed frame, so it only ever
  // accumulates distance; the seek itself happens once per frame below.
  window.addEventListener('mousemove', (event) => {
    // The first sample only establishes a baseline, so the clip doesn't jump
    // when the pointer first enters the page.
    if (previousX === null) {
      previousX = event.clientX;
      return;
    }
    pendingDelta += event.clientX - previousX;
    previousX = event.clientX;
  });

  const tick = () => {
    requestAnimationFrame(tick);

    const { duration } = video;
    if (!duration || Number.isNaN(duration)) return;

    if (pendingDelta !== 0) {
      const offset = (pendingDelta / window.innerWidth) * SENSITIVITY * duration;
      pendingDelta = 0;
      targetTime = Math.min(Math.max(targetTime + offset, 0), duration);
    }

    // A write issued mid-seek is discarded by the browser, so leave the target
    // queued and retry next frame rather than losing it.
    if (video.seeking) return;
    if (Math.abs(video.currentTime - targetTime) < FRAME_EPSILON) return;

    video.currentTime = targetTime;
  };
  requestAnimationFrame(tick);
}
