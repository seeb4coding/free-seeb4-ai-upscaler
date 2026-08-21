// Minimal PNG read/write plus the few pixel ops the brand assets need.
// The project ships no image dependency, so this is zlib and arithmetic:
// enough to slice, key, recolour and downscale the master logo PNG.
const zlib = require('zlib');
const fs = require('fs');

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** Reads an 8-bit RGB or RGBA, non-interlaced PNG into {w, h, px} RGBA. */
function readPNG(path) {
  const buf = fs.readFileSync(path);
  let off = 8;
  let w;
  let h;
  let ctype;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ctype = data[9];
      if (data[8] !== 8 || (ctype !== 2 && ctype !== 6)) {
        throw new Error(`unsupported PNG: depth ${data[8]} colour type ${ctype}`);
      }
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const s = x * bpp;
      const d = (y * w + x) * 4;
      px[d] = line[s];
      px[d + 1] = line[s + 1];
      px[d + 2] = line[s + 2];
      px[d + 3] = bpp === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, px };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Encodes {w, h, px} RGBA as a PNG buffer (sub filter, max deflate). */
function encodePNG(img) {
  const { w, h, px } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? px[y * stride + i - 4] : 0;
      raw[y * (stride + 1) + 1 + i] = (px[y * stride + i] - left) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePNG(path, img) {
  const buf = encodePNG(img);
  fs.writeFileSync(path, buf);
  return buf.length;
}

/** Packs PNGs into a multi-size .ico (Vista-style PNG payloads). */
function writeICO(path, images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const blobs = images.map((img) => encodePNG(img));
  let offset = 6 + images.length * 16;
  const dir = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = img.w === 256 ? 0 : img.w;
    e[1] = img.h === 256 ? 0 : img.h;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(blobs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += blobs[i].length;
    return e;
  });
  fs.writeFileSync(path, Buffer.concat([header, ...dir, ...blobs]));
}

/** The master logo is ink on white paper: drop the paper, keep glyph edges. */
function keyWhite(img) {
  const { w, h, px } = img;
  for (let i = 0; i < w * h; i++) {
    const max = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    const sat = max - Math.min(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    if (sat > 26) continue; // saturated: part of the gradient artwork
    let a = 255;
    if (max >= 250) a = 0;
    else if (max > 214) a = Math.round(((250 - max) / 36) * 255);
    px[i * 4 + 3] = Math.min(px[i * 4 + 3], a);
  }
  return img;
}

function bbox(img, x0 = 0, y0 = 0, x1 = img.w, y1 = img.h, thresh = 24) {
  let minX = x1;
  let minY = y1;
  let maxX = x0;
  let maxY = y0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (img.px[(y * img.w + x) * 4 + 3] > thresh) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function crop(img, r, pad = 0) {
  const x0 = Math.max(0, Math.round(r.x - pad));
  const y0 = Math.max(0, Math.round(r.y - pad));
  const x1 = Math.min(img.w, Math.round(r.x + r.w + pad));
  const y1 = Math.min(img.h, Math.round(r.y + r.h + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.px.copy(px, y * w * 4, ((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1) * 4);
  }
  return { w, h, px };
}

/** Pads to a square canvas, centring the art - for icons. */
function square(img, pad = 0) {
  const side = Math.max(img.w, img.h) + pad * 2;
  const px = Buffer.alloc(side * side * 4);
  const ox = Math.round((side - img.w) / 2);
  const oy = Math.round((side - img.h) / 2);
  for (let y = 0; y < img.h; y++) {
    img.px.copy(px, ((oy + y) * side + ox) * 4, y * img.w * 4, (y + 1) * img.w * 4);
  }
  return { w: side, h: side, px };
}

/** Area-average resample, premultiplied so transparency does not bleed. */
function resize(img, tw, th = Math.max(1, Math.round((img.h * tw) / img.w))) {
  const px = Buffer.alloc(tw * th * 4);
  const sx = img.w / tw;
  const sy = img.h / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.w + xx) * 4;
          const al = img.px[i + 3] / 255;
          r += img.px[i] * al;
          g += img.px[i + 1] * al;
          b += img.px[i + 2] * al;
          a += al;
          n++;
        }
      }
      const d = (y * tw + x) * 4;
      px[d] = a > 0 ? Math.round(r / a) : 0;
      px[d + 1] = a > 0 ? Math.round(g / a) : 0;
      px[d + 2] = a > 0 ? Math.round(b / a) : 0;
      px[d + 3] = Math.round((a / n) * 255);
    }
  }
  return { w: tw, h: th, px };
}

/** Dark-theme variant: near-black ink flips light, brand gradient untouched. */
function lightenInk(img, tone = [0xee, 0xf0, 0xfa]) {
  const out = { w: img.w, h: img.h, px: Buffer.from(img.px) };
  for (let i = 0; i < img.w * img.h; i++) {
    const r = out.px[i * 4];
    const g = out.px[i * 4 + 1];
    const b = out.px[i * 4 + 2];
    const max = Math.max(r, g, b);
    if (max - Math.min(r, g, b) > 30 || max > 170) continue;
    const t = 1 - max / 170; // deeper ink -> closer to the light tone
    for (let c = 0; c < 3; c++) {
      out.px[i * 4 + c] = Math.round(max + (tone[c] - max) * t);
    }
  }
  return out;
}

/** Flattens onto an opaque colour - for the maskable and og renders. */
function onColour(img, [r, g, b]) {
  const out = { w: img.w, h: img.h, px: Buffer.from(img.px) };
  for (let i = 0; i < img.w * img.h; i++) {
    const a = out.px[i * 4 + 3] / 255;
    out.px[i * 4] = Math.round(out.px[i * 4] * a + r * (1 - a));
    out.px[i * 4 + 1] = Math.round(out.px[i * 4 + 1] * a + g * (1 - a));
    out.px[i * 4 + 2] = Math.round(out.px[i * 4 + 2] * a + b * (1 - a));
    out.px[i * 4 + 3] = 255;
  }
  return out;
}

/** Composites src over dst at (ox, oy). */
function paste(dst, src, ox, oy) {
  for (let y = 0; y < src.h; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.w) continue;
      const s = (y * src.w + x) * 4;
      const d = (dy * dst.w + dx) * 4;
      const a = src.px[s + 3] / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        dst.px[d + c] = Math.round(src.px[s + c] * a + dst.px[d + c] * (1 - a));
      }
      dst.px[d + 3] = Math.max(dst.px[d + 3], src.px[s + 3]);
    }
  }
  return dst;
}

module.exports = {
  readPNG,
  writePNG,
  encodePNG,
  writeICO,
  keyWhite,
  bbox,
  crop,
  square,
  resize,
  lightenInk,
  onColour,
  paste,
};
