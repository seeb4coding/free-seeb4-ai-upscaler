# Contributing

Thanks for looking. This is a small, dependency-light project and the bar for a
change is simply that it is understandable a year from now.

## Setup

```bash
npm install
npm run dev      # dev server
npm run build    # typecheck + production bundle into dist/
```

You need **Chrome / Edge / Opera 113+** on a machine with a GPU — the app is
WebGPU and WebCodecs end to end, and there is no CPU fallback. The badge in the
header tells you whether your browser qualifies.

`npm run build` runs `tsc --noEmit` first, so it is also the typecheck. CI runs
exactly that on every pull request; run it locally before you push.

## Weights in a fresh clone

The repository ships one weight set: the in-house files at
`public/assets/sr-*.bin`. The set labelled *Default* on the deployed site is
**not** in the repository — those files came from a third party with no stated
licence, so they are not ours to redistribute. See
[`docs/WEIGHTS.md`](docs/WEIGHTS.md).

So a clone starts on the in-house set, and a quality tier with no file behind it
appears disabled. That is expected, not a bug.

Please do not open a pull request that adds weight files unless you trained them
yourself or they carry a licence that permits redistribution — say which in the
description.

## Style

There is no formatter or linter to argue with; match the surrounding code.

- Two-space indent, single quotes, semicolons, trailing commas.
- Comments explain *why*, not what. The existing ones are the reference — most
  of them exist because something non-obvious bit us, and those are the comments
  worth writing.
- TypeScript is `strict`. Prefer making a type honest over reaching for a cast.
- No new runtime dependencies without a reason in the pull request. Everything
  in `scripts/` is plain Node for the same reason.

## Scope

A few things are deliberate rather than unfinished:

- **No backend, ever.** Nothing may upload the user's file, phone home, or add
  analytics. This is the whole point of the project.
- **2× is the ceiling.** All shipped networks are 2×; higher factors are
  resampling, and [`src/resolutions.ts`](src/resolutions.ts) already handles
  that honestly. A "4× AI" mode is not wanted.
- **WebSR stays unforked.** Width-generic layers live in
  [`src/websr-ext/`](src/websr-ext/) and register into WebSR's registry at
  runtime.

If you want a bigger problem to chew on, the *Known limits* section of the
[README](README.md) is the honest backlog — the main-thread inference, the
in-memory output buffer and a WGSL Real-ESRGAN tier are the three that would
change the most for users.

## Pull requests

- One concern per pull request; a rename and a fix in the same diff are hard to
  review.
- Say how you tested it: which browser, which GPU, and what file — video and
  image paths differ enough that "works for me" on a 480p clip proves little.
- Screenshots or numbers for anything touching the pipeline or the UI.
- By opening a pull request you agree your contribution ships under the
  [MIT licence](LICENSE), like the rest of the source.

## Reporting bugs

Include your browser version, GPU, and the source file's resolution, codec and
duration. `chrome://gpu` output helps for anything that renders black or
silently produces a tiny output file — that failure mode is almost always a
destroyed `GPUDevice`, which the README's *Gotchas* section describes.
