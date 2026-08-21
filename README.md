<img src="brand/logo.png#gh-light-mode-only" alt="SeeB4 AI Upscaler" width="250">
<img src="brand/logo-dark.png#gh-dark-mode-only" alt="SeeB4 AI Upscaler" width="250">

# SeeB4 AI Upscaler

**Your Media | Your GPU | Your Privacy**
[![CI](https://img.shields.io/github/actions/workflow/status/seeb4coding/free-seeb4-ai-upscaler/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/seeb4coding/free-seeb4-ai-upscaler/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue?style=flat-square)](LICENSE)
[![Live demo](https://img.shields.io/badge/live-seeb4coding.in-00a3a3?style=flat-square)](https://seeb4coding.in/ai-upscaler/)
[![WebGPU](https://img.shields.io/badge/WebGPU-WGSL-005a9c?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Backend: none](https://img.shields.io/badge/backend-none-brightgreen?style=flat-square)](#why-it-exists)


AI Upscale video and images 2× in the browser. A super-resolution CNN runs on your
own GPU through WebGPU — there is no backend, nothing is uploaded, and there is
no account, watermark or limit.

**Live:** https://seeb4coding.in/ai-upscaler/

---

## Why it exists

Most free upscalers are a queue in front of someone else's GPU: you upload your
file, wait, and hope the privacy policy means what it says. This one has no
server to upload to. Decode, inference and encode all happen inside the tab, so
the file physically never leaves the machine. You can pull the network cable
after the page loads and it still works.

## Running it

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production bundle into dist/
```

`dist/` is a fully static bundle — host it on any CDN or object store, no
runtime required.

Requires **Chrome / Edge / Opera 113+** (WebGPU + WebCodecs) on a machine with a
GPU. The badge in the header reports whether the browser qualifies.

Deploying somewhere other than a subdirectory? Change `base` in
[`vite.config.ts`](vite.config.ts) — it is currently `/ai-upscaler/`.

## How it works

The video pipeline in [`src/pipeline.ts`](src/pipeline.ts) is five stages:

| Stage   | Implementation                                          |
| ------- | ------------------------------------------------------- |
| Demux   | Mediabunny `Input` over a `BlobSource`                   |
| Decode  | Mediabunny `VideoSampleSink` (WebCodecs `VideoDecoder`)  |
| Upscale | WGSL compute shaders via WebGPU                          |
| Encode  | Mediabunny `CanvasSource` (WebCodecs `VideoEncoder`)     |
| Mux     | Mediabunny `Output` → `Mp4OutputFormat`                  |

Two details worth knowing:

- **Audio is copied, never re-encoded.** Packets are read straight off the input
  track and handed to an `EncodedAudioPacketSource`, so quality is untouched and
  A/V sync comes free from the original timestamps.
- **Backpressure is implicit.** `CanvasSource.add()` only resolves once the
  encoder queue has room, which stops the decoder running ahead of the GPU and
  exhausting memory on long files.

## Images

Stills go through [`src/image.ts`](src/image.ts), sharing the preview and compare
UI but skipping demux/encode/mux entirely — decode to an `ImageBitmap`, run the
network, write a PNG.

Every stage buffer is `width × height × 4 channels × 4 bytes` at *source*
resolution, and the widest network allocates ~73 of them, so a 12MP photo would
need roughly 13 GB. Images above 512px are therefore processed in **512px tiles**,
which pins a full-quality pass near 300 MB regardless of image size.

Tiles overlap by 16px and the overlap is trimmed. Seven stages of 3×3 give the
network a receptive field of only 7 pixels, so 16 is comfortably past where a
seam could appear — measured, the difference across tile boundaries is *lower*
than between neighbouring columns of ordinary image content. Edge tiles are
shifted inwards rather than shrunk, so every tile is identical in size; a
different size would make the network rebuild its whole GPU context per tile.

## Models

Three widths of the Anime4K 2× CNN:

| Tier     | Network              | Channels | Parameters |
| -------- | -------------------- | -------- | ---------- |
| Fast     | `anime4k/cnn-2x-8`   | 8        | 8,612      |
| Balanced | `anime4k/cnn-2x-16`  | 16       | 31,036     |
| Quality  | `anime4k/cnn-2x-28`  | 28       | 90,592     |

WebSR implements only the 8-channel network, and only as hardcoded per-width
layer classes. [`src/websr-ext/`](src/websr-ext/) adds width-generic equivalents
and registers the wider networks into WebSR's registry at runtime, so the
package stays unforked.

Topology is `width × 7 + 3` layers: `width` stage-0 convolutions reading the
source, six more stages of `width` 3×3 convolutions, then three 1×1 output
planes — 17 / 31 / 52 layers, matching the weight files exactly. Activations are
CReLU (`max(v, 0)` and `max(-v, 0)` through separate kernels), which is why every
weight count is twice a plain ReLU's.

The final 1×1 layer reads all seven stages at once — `7 × width` buffers, well
past the per-shader storage-buffer limit — so it runs as `width` passes of seven
buffers, summed afterwards.

### Correctness

The width-generic layers were verified against WebSR's own hand-written width-2
network using identical weights: **14,745,600 bytes compared, maximum absolute
difference 1** (rounding in the last bit), zero mean difference. Equivalence at
width 2 is what gives confidence in widths 4 and 7, whose kernel layouts were
recovered from the weight files rather than from a reference implementation.

## Resolution

The networks output exactly 2×, which is the ceiling — anything above would be
interpolation dressed up as AI. [`src/resolutions.ts`](src/resolutions.ts) offers
the standard rungs between the source and that ceiling (720p / 1080p / 2K / 4K),
reached by resampling the 2× result once. Picking the ceiling skips the resample.

## Weights

Two sets of weights, same architecture, different training. The UI lets you
switch between them:

| Set | Files | In this repository |
| --- | --- | --- |
| **Ours** | `public/assets/sr-{8,16,28}ch.bin` | yes — trained in-house on a CC0 image set |
| **Default** | `public/assets/m{1,2,3}.dat` | **no** — licence unresolved, see [`docs/WEIGHTS.md`](docs/WEIGHTS.md) |

The *Default* files came from a third party with no licence stated anywhere, so
they are gitignored rather than redistributed here. **A clone therefore runs on
our own weights**: [`src/models.ts`](src/models.ts) probes both sets at startup
and the UI disables whatever has no file behind it, so nothing 404s — a set or a
tier simply appears greyed out.

The network code is original, so swapping in your own weights means replacing
files and nothing else, provided they use the same container format and topology
(documented in [`src/websr-ext/bin-weights.ts`](src/websr-ext/bin-weights.ts)).

## SEO

The page is a single static URL, so the whole surface lives in `index.html`
plus three files in `public/`:

| File | Purpose |
| --- | --- |
| `public/robots.txt` | Crawl rules, and the `Sitemap:` pointer |
| `public/sitemap.xml` | The one URL, with `og.png` as an image entry |
| `public/site.webmanifest` | Install metadata and the PWA icon set |

`index.html` carries the canonical URL, a `robots` directive with
`max-image-preview:large`, Open Graph and Twitter cards pointing at
`og.png`, and two JSON-LD blocks: `WebApplication` (free, browser
requirements, feature list) and `BreadcrumbList`.

A third JSON-LD block, `FAQPage`, is **generated at build time** from the
visible FAQ by [`scripts/vite-seo.ts`](scripts/vite-seo.ts). Google only
honours FAQ markup that matches the copy on the page, so the schema is parsed
out of the `<details>` elements rather than hand-written twice — edit the FAQ
and the structured data follows. The plugin throws if the FAQ section stops
parsing, so a markup change fails the build instead of silently shipping no
schema.

Two things need doing outside this repo:

1. **`robots.txt` only counts at a domain root.** This app is served from
   `seeb4coding.in/ai-upscaler/`, so the rules in `public/robots.txt` are
   inert until the same lines appear in `https://seeb4coding.in/robots.txt`.
   The copy here keeps the rules with the app and works as-is if the app ever
   gets its own domain.
2. **Submit the sitemap** — `https://seeb4coding.in/ai-upscaler/sitemap.xml`
   — in Search Console, and bump `<lastmod>` when the page changes
   meaningfully.

## Brand assets

`brand/` holds the master artwork — `logo-master.png` (the full lockup) and
`icon-master.png` (the mark on its own). Everything the site serves is derived
from those two files:

```
node scripts/brand-assets.cjs
```

That writes into `public/`: `logo-word.png` and `logo-word-dark.png` (the header
and footer lockup, in dark ink and light ink), `logo-mark.png`, `favicon.ico`,
`apple-touch-icon.png`, `icon-maskable.png` (the 512×512 maskable PWA icon,
inset to survive Android's circular crop) and `og.png` (the 1200×630 social
card). The full-lockup
renders land in `brand/` instead — only this README uses them, so there is no
reason to deploy them. The generator is plain Node — PNG decoding,
white-keying, resampling and ICO packing live in
[`scripts/pnglib.cjs`](scripts/pnglib.cjs), so no image dependency is installed.

Re-run it after replacing either master. The crop regions are in master pixels,
so keep `logo-master.png` at 1536×1024 or adjust `REGION` in the script.

## Known limits

- **2× is the hard ceiling.** All shipped networks are 2×, and WebSR keeps its
  GPU context on a global singleton, which rules out chaining two instances.
- **No Real-ESRGAN tier.** It uses a different architecture. Running it via
  onnxruntime-web measured ~15 s per 720p frame, because the available ONNX
  export is fixed at 128×128 and needs 60 tiled inferences per frame — fine for a
  single preview frame, unusable for export. A WGSL implementation would be the
  way to make it practical.
- **Export is slower than preview.** Quality tier runs ~554 ms/frame end to end
  versus ~81 ms for inference alone, so most of it is pipeline overhead rather
  than the network.
- Output is buffered in memory before download. Long files should stream to disk
  via the File System Access API instead.
- Upscaling runs on the main thread. Moving it to a worker with an
  `OffscreenCanvas` would keep the UI responsive on heavy clips.
- No HDR / 10-bit support.

## Gotchas worth knowing

Three bugs here cost real time and are easy to reintroduce.

**`WebSR.destroy()` destroys the whole `GPUDevice`,** not just its own resources —
it bottoms out in `GPUDevice.destroy()`. Anything caching that device must drop
its reference on release. Renders against a destroyed device fail *silently*: no
exception, no warning, just black frames and a suspiciously small output file.

**`[hidden]` loses to any class rule that sets `display`.** The UA stylesheet's
`[hidden] { display: none }` is a single attribute selector, so
`.settings { display: grid }` quietly outranks it and the element never hides.
[`src/style.css`](src/style.css) pins `[hidden]` with `!important`.

**Overriding a CSS custom property does not reach inherited computed values.**
The hero pins the light palette over the video; redefining `--ink` alone left
`h1` untouched, because it inherits an already-computed `color` from `body`. The
property has to be re-declared where the tokens are overridden.

## Built on

- [WebSR](https://github.com/sb2702/websr) (MIT) — WebGPU super-resolution runtime
- [Mediabunny](https://github.com/Vanilagy/mediabunny) — demux / mux / codecs
- [Anime4K](https://github.com/bloc97/Anime4K) (MIT) — the CNN architecture

## Contributing

Issues and pull requests are welcome — [`CONTRIBUTING.md`](CONTRIBUTING.md)
covers setup, what a fresh clone does about weights, and which limitations are
deliberate.

## Licence

[MIT](LICENSE) — source, WGSL shaders, build scripts and the in-house weights in
`public/assets/sr-*.bin`. The third-party *Default* weights are not part of this
repository; see [`docs/WEIGHTS.md`](docs/WEIGHTS.md).
