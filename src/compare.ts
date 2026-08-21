const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const ZOOM_LEVELS = [1, 2, 4, 8] as const;

/**
 * Split-screen before/after viewer with zoom and pan.
 *
 * Both layers get the identical transform, so they stay registered no matter
 * how far in you go — which is the whole point, since a 2x upscale is invisible
 * until one output pixel is at least one screen pixel. The divider is clipped in
 * the container's own coordinate space, so it stays put while the images move
 * underneath it.
 */
export class CompareView {
  private readonly root: HTMLElement;
  private readonly layers: HTMLElement[];
  private readonly divider: HTMLElement;

  private split = 50;
  private zoom = 1;
  /** Normalised image coordinates currently at the centre of the viewport. */
  private originX = 0.5;
  private originY = 0.5;

  private onZoom?: (zoom: number) => void;

  constructor(root: HTMLElement, options: { onZoom?: (zoom: number) => void } = {}) {
    this.root = root;
    this.onZoom = options.onZoom;
    this.layers = [...root.querySelectorAll<HTMLElement>('.compare-layer')];
    this.divider = root.querySelector<HTMLElement>('.compare-divider')!;

    this.divider.addEventListener('pointerdown', this.startSplitDrag);
    this.divider.addEventListener('keydown', this.onDividerKey);
    this.root.addEventListener('pointerdown', this.startPan);
    this.root.addEventListener('wheel', this.onWheel, { passive: false });

    // Canvas resizes and window resizes both change the box the maths uses.
    new ResizeObserver(() => this.apply()).observe(root);

    this.apply();
  }

  getZoom() {
    return this.zoom;
  }

  setZoom(zoom: number, focus?: { x: number; y: number }) {
    const next = clamp(zoom, 1, 16);
    if (focus) {
      const { width, height } = this.box();
      // Keep whatever sits under the focus point pinned there.
      const u = this.originX + (focus.x - width / 2) / (width * this.zoom);
      const v = this.originY + (focus.y - height / 2) / (height * this.zoom);
      this.originX = u + (width / 2 - focus.x) / (width * next);
      this.originY = v + (height / 2 - focus.y) / (height * next);
    }
    this.zoom = next;
    this.clampPan();
    this.apply();
    this.onZoom?.(next);
  }

  reset() {
    this.zoom = 1;
    this.originX = 0.5;
    this.originY = 0.5;
    this.split = 50;
    this.apply();
    this.onZoom?.(1);
  }

  private box() {
    const rect = this.root.getBoundingClientRect();
    return { width: rect.width, height: rect.height, left: rect.left, top: rect.top };
  }

  private clampPan() {
    // At zoom z only 1/z of the image fits, so the centre can travel that far.
    const reach = this.zoom <= 1 ? 0 : 0.5 - 0.5 / this.zoom;
    this.originX = clamp(this.originX, 0.5 - reach, 0.5 + reach);
    this.originY = clamp(this.originY, 0.5 - reach, 0.5 + reach);
  }

  private apply() {
    const { width, height } = this.box();
    const x = width / 2 - this.originX * width * this.zoom;
    const y = height / 2 - this.originY * height * this.zoom;
    const transform = `translate(${x}px, ${y}px) scale(${this.zoom})`;
    for (const layer of this.layers) layer.style.transform = transform;

    this.root.style.setProperty('--split', `${this.split}%`);
    this.root.classList.toggle('zoomed', this.zoom > 1);
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.split)));
  }

  private setSplitFromPointer(clientX: number) {
    const { width, left } = this.box();
    if (!width) return;
    this.split = clamp(((clientX - left) / width) * 100, 0, 100);
    this.apply();
  }

  private startSplitDrag = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation(); // don't also start a pan
    this.divider.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => this.setSplitFromPointer(moveEvent.clientX);
    const up = () => {
      this.divider.removeEventListener('pointermove', move);
      this.divider.removeEventListener('pointerup', up);
      this.divider.removeEventListener('pointercancel', up);
    };
    this.divider.addEventListener('pointermove', move);
    this.divider.addEventListener('pointerup', up);
    this.divider.addEventListener('pointercancel', up);
  };

  private onDividerKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') this.split = clamp(this.split - step, 0, 100);
    else if (event.key === 'ArrowRight') this.split = clamp(this.split + step, 0, 100);
    else return;
    event.preventDefault();
    this.apply();
  };

  private startPan = (event: PointerEvent) => {
    if (this.zoom <= 1) return;
    event.preventDefault();
    this.root.setPointerCapture(event.pointerId);
    this.root.classList.add('panning');

    const { width, height } = this.box();
    let lastX = event.clientX;
    let lastY = event.clientY;

    const move = (moveEvent: PointerEvent) => {
      this.originX -= (moveEvent.clientX - lastX) / (width * this.zoom);
      this.originY -= (moveEvent.clientY - lastY) / (height * this.zoom);
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      this.clampPan();
      this.apply();
    };
    const up = () => {
      this.root.classList.remove('panning');
      this.root.removeEventListener('pointermove', move);
      this.root.removeEventListener('pointerup', up);
      this.root.removeEventListener('pointercancel', up);
    };
    this.root.addEventListener('pointermove', move);
    this.root.addEventListener('pointerup', up);
    this.root.addEventListener('pointercancel', up);
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const { left, top } = this.box();
    const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
    this.setZoom(this.zoom * factor, { x: event.clientX - left, y: event.clientY - top });
  };
}
