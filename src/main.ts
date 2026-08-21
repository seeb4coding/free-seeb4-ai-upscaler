import {
  PRESETS,
  WEIGHT_SETS,
  probeWeightSets,
  type Availability,
  type Preset,
  type WeightSet,
} from './models';
import { PreviewSession, type Thumbnail } from './preview';
import { ImageSession, isImageFile } from './image';
import { targetsFor, type Target } from './resolutions';
import { isSupported, upscaleVideo, type Progress } from './pipeline';
import { CompareView, ZOOM_LEVELS } from './compare';
import { initLandingUi } from './ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  hero: $('hero'),
  gpuBadge: $('gpu-badge'),
  unsupported: $('unsupported'),
  unsupportedDetail: $('unsupported-detail'),

  stepPick: $('step-pick'),
  stepSettings: $('step-settings'),
  stepProgress: $('step-progress'),
  stepDone: $('step-done'),

  dropzone: $('dropzone'),
  file: $<HTMLInputElement>('file'),

  previewCompare: $('preview-compare'),
  previewBefore: $<HTMLCanvasElement>('preview-before'),
  previewAfter: $<HTMLCanvasElement>('preview-after'),
  previewZoom: $('preview-zoom'),
  previewBusy: $('preview-busy'),
  tagBefore: $('tag-before'),
  tagAfter: $('tag-after'),
  filmstrip: $('filmstrip'),
  stageHint: $('stage-hint'),

  resolution: $('resolution'),
  resolutionHint: $('resolution-hint'),
  preset: $('preset'),
  presetHint: $('preset-hint'),
  weights: $('weights'),
  weightsHint: $('weights-hint'),
  modelHelp: $('model-help'),
  summary: $('summary'),
  start: $<HTMLButtonElement>('start'),
  reset: $('reset'),

  bar: $('bar'),
  progressText: $('progress-text'),
  cancel: $('cancel'),

  doneText: $('done-text'),
  resultCompare: $('result-compare'),
  before: $<HTMLVideoElement>('before'),
  after: $<HTMLVideoElement>('after'),
  beforeImg: $<HTMLImageElement>('before-img'),
  afterImg: $<HTMLImageElement>('after-img'),
  resultZoom: $('result-zoom'),
  download: $('download'),
  downloadLabel: $('download-label'),
  again: $('again'),
};

const previewView = new CompareView(el.previewCompare, {
  onZoom: (zoom) => markZoom(el.previewZoom, zoom),
});
const resultView = new CompareView(el.resultCompare, {
  onZoom: (zoom) => markZoom(el.resultZoom, zoom),
});

const state = {
  file: null as File | null,
  session: null as PreviewSession | ImageSession | null,
  thumbnails: [] as Thumbnail[],
  frame: 0,
  targets: [] as Target[],
  targetIndex: 0,
  preset: 'balanced' as Preset,
  weightSet: 'default' as WeightSet,
  /** Which tiers each weight set can actually serve, filled in at startup. */
  available: {
    default: { fast: true, balanced: true, quality: true },
    own: { fast: false, balanced: false, quality: false },
  } as Availability,
  controller: null as AbortController | null,
  result: null as { url: string; name: string } | null,
  sourceUrl: null as string | null,
};

/** Bumped on every settings change so stale renders can drop their result. */
let previewToken = 0;
let previewPromise: Promise<unknown> = Promise.resolve();

const target = () => state.targets[state.targetIndex] as Target;

function show(step: HTMLElement) {
  for (const section of [el.stepPick, el.stepSettings, el.stepProgress, el.stepDone]) {
    section.hidden = section !== step;
  }
  // The hero is a whole viewport tall, so it steps aside once a file is loaded
  // and the tool takes the top of the page. Everything below it stays put —
  // the nav anchors have to keep working, and a long upscale should leave
  // something to read while it runs.
  el.hero.hidden = step !== el.stepPick;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatClock(seconds: number) {
  if (!seconds || !Number.isFinite(seconds)) return '0:00';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function fail(error: unknown) {
  el.unsupported.hidden = false;
  el.unsupportedDetail.textContent = error instanceof Error ? error.message : String(error);
  show(el.stepPick);
}

function blit(source: HTMLCanvasElement, destination: HTMLCanvasElement) {
  destination.width = source.width;
  destination.height = source.height;
  const context = destination.getContext('2d');
  if (!context) return;
  context.drawImage(source, 0, 0);
}

// --- segmented controls -------------------------------------------------

interface Segment {
  value: string;
  label: string;
}

function fillSegmented(host: HTMLElement, segments: Segment[], onPick: (value: string) => void) {
  host.replaceChildren();
  for (const { value, label } of segments) {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'radio';
    button.textContent = label;
    button.dataset.value = value;
    button.addEventListener('click', () => onPick(value));
    host.append(button);
  }
}

function markChecked(host: HTMLElement, value: string) {
  for (const button of host.querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === value));
  }
}

function syncControls() {
  const session = state.session;
  if (!session) return;

  markChecked(el.resolution, String(state.targetIndex));
  markChecked(el.preset, state.preset);
  markChecked(el.weights, state.weightSet);

  // A tier can only be offered if the chosen set actually has a file for it.
  const usableTiers = state.available[state.weightSet];
  for (const button of el.preset.querySelectorAll('button')) {
    const preset = button.dataset.value as Preset;
    button.disabled = !usableTiers[preset];
    button.title = usableTiers[preset] ? '' : 'No weight file for this tier';
  }

  const missing = (Object.keys(PRESETS) as Preset[]).filter((p) => !usableTiers[p]);
  el.weightsHint.textContent = missing.length
    ? `${WEIGHT_SETS[state.weightSet].note} Missing: ${missing.map((p) => PRESETS[p].label).join(', ')}.`
    : WEIGHT_SETS[state.weightSet].note;

  const chosen = target();
  el.resolutionHint.textContent = `${session.width}×${session.height} → ${chosen.width}×${chosen.height}`;
  el.presetHint.textContent = PRESETS[state.preset].hint;
  el.tagBefore.textContent = `${session.height}p Original`;
  el.tagAfter.textContent = `${chosen.label} Upscaled`;
}

// --- preview ------------------------------------------------------------

function buildZoomBar(host: HTMLElement, view: CompareView) {
  host.replaceChildren();
  for (const level of ZOOM_LEVELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = level === 1 ? 'Fit' : `${level}×`;
    button.dataset.zoom = String(level);
    button.addEventListener('click', (event) => {
      event.stopPropagation(); // don't start a pan on the compare surface
      view.setZoom(level);
    });
    // Keep the wheel over the bar as a zoom gesture, not a page scroll.
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    host.append(button);
  }
  markZoom(host, view.getZoom());
}

/** The wheel produces arbitrary factors, so only exact levels light up. */
function markZoom(host: HTMLElement, zoom: number) {
  for (const button of host.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.zoom) === zoom));
  }
}

async function renderPreview() {
  const session = state.session;
  if (!session) return;

  const token = ++previewToken;
  el.previewBusy.hidden = false;

  const job = (async () => {
    const timestamp = state.thumbnails[state.frame]?.timestamp ?? 0;
    const frame = await session.render(timestamp, state.preset, state.weightSet, target());
    if (token !== previewToken) return; // a newer request has superseded this one
    blit(frame.original, el.previewBefore);
    blit(frame.upscaled, el.previewAfter);
  })();

  previewPromise = job;

  try {
    await job;
  } catch (error) {
    if (token === previewToken) fail(error);
  } finally {
    if (token === previewToken) el.previewBusy.hidden = true;
  }
}

let previewTimer: number | undefined;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void renderPreview(), 120);
}

function buildFilmstrip() {
  el.filmstrip.replaceChildren();
  state.thumbnails.forEach((thumbnail, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.setAttribute('aria-selected', String(index === state.frame));

    const image = document.createElement('img');
    image.src = thumbnail.url;
    image.alt = `Frame at ${formatClock(thumbnail.timestamp)}`;

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = formatClock(thumbnail.timestamp);

    button.append(image, stamp);
    button.addEventListener('click', () => {
      state.frame = index;
      for (const [i, other] of [...el.filmstrip.children].entries()) {
        other.setAttribute('aria-selected', String(i === index));
      }
      schedulePreview();
    });
    el.filmstrip.append(button);
  });
}

// --- file handling ------------------------------------------------------

async function pickFile(file: File) {
  await state.session?.close();
  state.session = null;
  state.file = file;
  state.frame = 0;
  el.unsupported.hidden = true;
  el.start.disabled = true;
  previewView.reset();
  show(el.stepSettings);

  const isImage = isImageFile(file);
  let session: PreviewSession | ImageSession;
  try {
    session = isImage ? await ImageSession.open(file) : await PreviewSession.open(file);
  } catch (error) {
    fail(error);
    return;
  }
  state.session = session;

  state.targets = targetsFor(session.width, session.height);
  // Default to the best rung the network can actually produce.
  state.targetIndex = state.targets.length - 1;

  fillSegmented(
    el.resolution,
    state.targets.map((entry, index) => ({ value: String(index), label: entry.label })),
    (value) => {
      state.targetIndex = Number(value);
      syncControls();
      schedulePreview();
    },
  );

  el.summary.replaceChildren();
  const rows: Array<[string, string]> = isImage
    ? [
        ['Source', `${session.width}×${session.height}`],
        ['Size', formatBytes(file.size)],
        ['Format', session.codec ?? 'image'],
        ['Output', 'PNG'],
      ]
    : [
        ['Duration', formatClock(session.duration)],
        ['Size', formatBytes(file.size)],
        ['Codec', session.codec ?? 'unknown'],
        ['Audio', session.hasAudio ? 'copied' : 'none'],
      ];
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dd.title = value;
    // A wrapper per pair, so the grid can't split a term from its value.
    const cell = document.createElement('div');
    cell.append(dt, dd);
    el.summary.append(cell);
  }

  syncControls();

  // A still has no frames to choose between, so the filmstrip goes away.
  if (isImage) {
    state.thumbnails = [];
    el.filmstrip.hidden = true;
    el.stageHint.textContent = 'Zoom in to judge the detail — scroll to zoom, drag to pan.';
  } else {
    el.filmstrip.hidden = false;
    el.stageHint.textContent =
      'Zoom in to judge the detail — scroll to zoom, drag to pan, drag the divider to compare.';
    try {
      state.thumbnails = await (session as PreviewSession).thumbnails(session.duration > 0 ? 5 : 1);
    } catch {
      state.thumbnails = [{ timestamp: 0, url: '' }];
    }
  }
  buildFilmstrip();

  el.start.disabled = false;
  await renderPreview();
}

// --- export -------------------------------------------------------------

function renderProgress(progress: Progress) {
  if (progress.stage === 'preparing') {
    el.progressText.textContent = 'Reading the file…';
    return;
  }
  if (progress.stage === 'finalizing') {
    el.bar.style.width = '100%';
    el.progressText.textContent = 'Writing the MP4…';
    return;
  }

  const ratio = progress.duration ? Math.min(progress.seconds / progress.duration, 1) : 0;
  el.bar.style.width = `${(ratio * 100).toFixed(1)}%`;

  const parts = [`${progress.frames} frames`, `${progress.fps.toFixed(1)} fps`];
  if (ratio > 0.01) {
    parts.unshift(`${(ratio * 100).toFixed(0)}%`);
    // fps is measured over the whole run, so elapsed is just frames / fps.
    const elapsed = progress.frames / (progress.fps || 1);
    parts.push(`~${formatClock((elapsed * (1 - ratio)) / ratio)} left`);
  }
  el.progressText.textContent = parts.join(' · ');
}

async function run() {
  const file = state.file;
  const session = state.session;
  if (!file || !session) return;

  // The preview owns the shared WebSR instance — let any in-flight render
  // settle, then hand the GPU over to the export.
  previewToken += 1;
  await previewPromise.catch(() => {});
  await session.suspend();

  el.unsupported.hidden = true;
  el.bar.style.width = '0%';
  el.progressText.textContent = 'Preparing…';
  show(el.stepProgress);

  state.controller = new AbortController();

  try {
    if (session instanceof ImageSession) {
      el.progressText.textContent = 'Upscaling…';
      el.bar.style.width = '40%';
      const blob = await session.toBlob(state.preset, state.weightSet, target());
      el.bar.style.width = '100%';

      if (state.result) URL.revokeObjectURL(state.result.url);
      if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
      state.result = {
        url: URL.createObjectURL(blob),
        name: `${file.name.replace(/\.[^.]+$/, '')}-${target().width}x${target().height}.png`,
      };
      state.sourceUrl = URL.createObjectURL(file);

      el.doneText.textContent = [
        `${target().width}×${target().height}`,
        'PNG',
        formatBytes(blob.size),
      ].join(' · ');

      showResultMedia('image');
      el.beforeImg.src = state.sourceUrl;
      el.afterImg.src = state.result.url;
      resultView.reset();
      show(el.stepDone);
      return;
    }

    const result = await upscaleVideo(file, {
      preset: state.preset,
      weightSet: state.weightSet,
      target: target(),
      signal: state.controller.signal,
      onProgress: renderProgress,
    });

    if (state.result) URL.revokeObjectURL(state.result.url);
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);

    state.result = {
      url: URL.createObjectURL(result.blob),
      name: `${file.name.replace(/\.[^.]+$/, '')}-${result.height}p.mp4`,
    };
    state.sourceUrl = URL.createObjectURL(file);

    el.doneText.textContent = [
      `${result.width}×${result.height}`,
      `${result.frames} frames`,
      formatBytes(result.blob.size),
      `took ${formatClock(result.elapsed)}`,
    ].join(' · ');

    showResultMedia('video');
    el.before.src = state.sourceUrl;
    el.after.src = state.result.url;
    resultView.reset();
    show(el.stepDone);
    void el.before.play();
    void el.after.play();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      show(el.stepSettings);
      void renderPreview();
      return;
    }
    fail(error);
  } finally {
    state.controller = null;
  }
}

/** The result viewer holds both a video pair and a still pair; show one. */
function showResultMedia(kind: 'video' | 'image') {
  const video = kind === 'video';
  el.before.hidden = !video;
  el.after.hidden = !video;
  el.beforeImg.hidden = video;
  el.afterImg.hidden = video;
  // Only the label — replacing the button's text would drop its arrow badge.
  el.downloadLabel.textContent = video ? 'Download MP4' : 'Download PNG';
}

async function backToPicker() {
  el.before.pause();
  el.after.pause();
  el.file.value = '';
  await state.session?.close();
  state.session = null;
  state.file = null;
  show(el.stepPick);
}

// --- wiring -------------------------------------------------------------

fillSegmented(
  el.weights,
  (Object.keys(WEIGHT_SETS) as WeightSet[]).map((value) => ({
    value,
    label: WEIGHT_SETS[value].label,
  })),
  (value) => {
    state.weightSet = value as WeightSet;
    // Fall to a tier this set can actually serve.
    if (!state.available[state.weightSet][state.preset]) {
      const usable = (Object.keys(PRESETS) as Preset[]).find(
        (p) => state.available[state.weightSet][p],
      );
      if (usable) state.preset = usable;
    }
    syncControls();
    schedulePreview();
  },
);

fillSegmented(
  el.preset,
  (Object.keys(PRESETS) as Preset[]).map((value) => ({ value, label: PRESETS[value].label })),
  (value) => {
    state.preset = value as Preset;
    syncControls();
    schedulePreview();
  },
);

el.modelHelp.title =
  'Bigger models see more context per pixel, so they recover more detail — ' +
  'and cost proportionally more GPU time per frame.';

el.file.addEventListener('change', () => {
  const file = el.file.files?.[0];
  if (file) void pickFile(file);
});

for (const type of ['dragenter', 'dragover'] as const) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add('dragging');
  });
}
for (const type of ['dragleave', 'drop'] as const) {
  el.dropzone.addEventListener(type, () => el.dropzone.classList.remove('dragging'));
}
el.dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void pickFile(file);
});

buildZoomBar(el.previewZoom, previewView);
buildZoomBar(el.resultZoom, resultView);

// Every pill marked data-pick opens the native file chooser.
for (const trigger of document.querySelectorAll<HTMLElement>('[data-pick]')) {
  trigger.addEventListener('click', () => el.file.click());
}
el.start.addEventListener('click', () => void run());
el.cancel.addEventListener('click', () => state.controller?.abort());
el.reset.addEventListener('click', () => void backToPicker());
el.again.addEventListener('click', () => void backToPicker());

el.download.addEventListener('click', () => {
  if (!state.result) return;
  const link = document.createElement('a');
  link.href = state.result.url;
  link.download = state.result.name;
  link.click();
});

initLandingUi();

void (async () => {
  state.available = await probeWeightSets();

  const sets = Object.keys(WEIGHT_SETS) as WeightSet[];
  const served = (set: WeightSet) => Object.values(state.available[set]).some(Boolean);
  for (const set of sets) {
    const button = el.weights.querySelector<HTMLButtonElement>(`button[data-value="${set}"]`);
    if (button && !served(set)) {
      button.disabled = true;
      button.title = 'No weight files installed for this set';
    }
  }

  // A clone of the repository ships only the in-house set, so the default may
  // not be there at all. Start on whichever set has files, and on a tier it
  // can serve.
  if (!state.available[state.weightSet][state.preset]) {
    const set = sets.find(served);
    if (set) {
      state.weightSet = set;
      const tier = (Object.keys(PRESETS) as Preset[]).find((p) => state.available[set][p]);
      if (tier) state.preset = tier;
    }
  }
  syncControls();
})();

void (async () => {
  if (await isSupported()) {
    el.gpuBadge.textContent = 'WebGPU ready';
    el.gpuBadge.classList.add('ok');
  } else {
    el.gpuBadge.textContent = 'WebGPU unavailable';
    el.gpuBadge.classList.add('bad');
    el.unsupported.hidden = false;
    el.unsupportedDetail.textContent = navigator.gpu
      ? 'WebCodecs is missing. Chrome, Edge or Opera 113+ is required.'
      : 'WebGPU is missing. Use Chrome, Edge or Opera 113+ on a machine with a GPU.';
  }
})();
