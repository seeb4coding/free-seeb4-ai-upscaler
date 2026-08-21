/**
 * Replaces the native pointer with a small dot plus a ring that trails behind
 * it. Only runs where there is a real pointer to replace — touch devices keep
 * their own behaviour rather than ending up with no visible cursor at all.
 */

/** Fraction of the remaining gap the ring closes each frame. Lower trails further. */
const RING_EASE = 0.18;

export function initCursor() {
  if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;

  const layer = document.createElement('div');
  layer.className = 'cursor-layer';
  layer.setAttribute('aria-hidden', 'true');

  const ring = document.createElement('div');
  ring.className = 'cursor-ring';
  const dot = document.createElement('div');
  dot.className = 'cursor-dot';
  layer.append(ring, dot);
  document.body.append(layer);
  document.documentElement.classList.add('has-custom-cursor');

  const ease = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : RING_EASE;

  const pointer = { x: 0, y: 0 };
  const trail = { x: 0, y: 0 };
  let visible = false;

  const setVisible = (next: boolean) => {
    visible = next;
    layer.style.opacity = next ? '1' : '0';
  };

  window.addEventListener('mousemove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    // On the first sample, and on re-entry after leaving the window, drop the
    // ring straight onto the pointer so it doesn't fly in from its last spot.
    if (!visible) {
      trail.x = event.clientX;
      trail.y = event.clientY;
      setVisible(true);
    }
  });

  document.addEventListener('mouseleave', () => setVisible(false));

  // Grow the ring over anything clickable, which gives the pointer the same
  // affordance the native cursor would have.
  document.addEventListener('mouseover', (event) => {
    const target = event.target as Element | null;
    layer.classList.toggle('is-active', !!target?.closest('a, button, label, summary, [role="slider"]'));
  });

  const tick = () => {
    trail.x += (pointer.x - trail.x) * ease;
    trail.y += (pointer.y - trail.y) * ease;

    // translate3d only, so both nodes stay on the compositor and never force
    // layout while the page is busy decoding video.
    dot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0) translate(-50%, -50%)`;
    ring.style.transform = `translate3d(${trail.x}px, ${trail.y}px, 0) translate(-50%, -50%)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
