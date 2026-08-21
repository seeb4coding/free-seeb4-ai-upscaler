// Slices brand/logo-master.png into everything the site serves:
// header/footer lockups (light + dark ink), the icon set and the og card.
//
//   node scripts/brand-assets.cjs
//
// The master is ink-on-white artwork at 1536x1024. Regions below are in
// master pixels, found from the ink profile (see the band comments), so
// re-exporting the logo at the same size keeps them valid.
const path = require('path');
const L = require(path.join(__dirname, 'pnglib.cjs'));

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public');
const BRAND = path.join(ROOT, 'brand');
const master = L.keyWhite(L.readPNG(path.join(ROOT, 'brand', 'logo-master.png')));
// The icon ships as its own artwork - the <> mark with its pixel dissolve,
// drawn at icon proportions rather than cropped out of the wide lockup.
const iconArt = L.keyWhite(L.readPNG(path.join(ROOT, 'brand', 'icon-master.png')));

// Bands of the master, top to bottom:
//   86-185   pixel dissolve above the mark
//   187-452  SEEB4 wordmark + the <> mark
//   485-556  AI UPSCALER rule
//   607-715  by seeb4coding.in pill
//   762-882  Your Media | Your GPU | Your Privacy
//   913-953  closing flourish
const REGION = {
  word: { x: 60, y: 80, w: 1424, h: 379 }, // wordmark + mark + dissolve
  lockup: { x: 60, y: 80, w: 1424, h: 483 }, // the above + AI UPSCALER
  full: L.bbox(master), // everything, for og and README
};

const wrote = [];
function emit(name, img, dir = OUT) {
  const bytes = L.writePNG(path.join(dir, name), img);
  const where = path.relative(ROOT, dir).split(path.sep).join('/');
  wrote.push(`${where}/${name}  ${img.w}x${img.h}  ${(bytes / 1024).toFixed(1)} kB`);
}

// --- header / footer lockup ------------------------------------------------
const word = L.crop(master, REGION.word);
emit('logo-word.png', L.resize(word, 720));
emit('logo-word-dark.png', L.resize(L.lightenInk(word), 720));

// --- full lockup ----------------------------------------------------------
// Only the README uses these, so they stay beside the master rather than in
// public/, where they would be deployed but never fetched.
const full = L.crop(master, REGION.full, 8);
emit('logo.png', L.resize(full, 900), BRAND);
emit('logo-dark.png', L.resize(L.lightenInk(full), 900), BRAND);

// --- icons ----------------------------------------------------------------
// Trim the paper, then pad to square so no icon size crops the dissolve.
const mark = L.square(L.crop(iconArt, L.bbox(iconArt)), 14);
emit('logo-mark.png', L.resize(mark, 256));
L.writeICO(
  path.join(OUT, 'favicon.ico'),
  [64, 48, 32, 16].map((s) => L.resize(mark, s, s)),
);
wrote.push('favicon.ico  16,32,48,64');
// iOS flattens transparency onto black, so ship the plate baked in.
emit('apple-touch-icon.png', L.onColour(L.resize(mark, 180, 180), [0xff, 0xff, 0xff]));
// Maskable install icon: Android crops to a circle inscribed in the middle
// 80%, so the mark sits at 60% of the canvas to stay clear of every mask.
const maskable = L.onColour({ w: 512, h: 512, px: Buffer.alloc(512 * 512 * 4) }, [0xff, 0xff, 0xff]);
const inlay = L.resize(mark, 308, 308);
L.paste(maskable, inlay, (512 - inlay.w) >> 1, (512 - inlay.h) >> 1);
emit('icon-maskable.png', maskable);

// --- social card ----------------------------------------------------------
// 1200x630 is the aspect every scraper crops to; letterbox the lockup on the
// same white paper the artwork was drawn on.
const card = L.onColour({ w: 1200, h: 630, px: Buffer.alloc(1200 * 630 * 4) }, [0xff, 0xff, 0xff]);
const inner = L.resize(L.crop(master, REGION.lockup), 940);
L.paste(card, inner, (card.w - inner.w) >> 1, (card.h - inner.h) >> 1);
emit('og.png', card);

console.log(wrote.join('\n'));
