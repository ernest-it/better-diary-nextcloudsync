/* Generates build/icon.ico and build/icon.png from scratch — no image assets, no
   dependencies, no network. Draws a rounded ink-blue square with a white bookmark ribbon:
   two flat shapes, so it still reads at 16px in a taskbar. Run with `npm run icons`, add
   --verify to only check. */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = __dirname;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const PNG_SIZE = 512;
const INK = [0x55, 0x63, 0x8f];   // --accent from src/styles.css
const WHITE = [0xff, 0xff, 0xff];
const SAMPLES = 4;  // 4x4 supersampling gives clean edges without a rasteriser

/* ---------------------------------------------------------------- drawing */

/* Rounded square, full bleed, corner radius proportional to the icon size. */
function inRoundedSquare(x, y, size) {
  const radius = size * 0.22;
  const inset = size * 0.02;
  const min = inset;
  const max = size - inset;
  if (x < min || y < min || x > max || y > max) return false;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/* A bookmark ribbon: an upright rectangle with a V notched up out of its bottom edge. Both
   edges are straight lines, which is why it survives being drawn nine pixels tall. */
const RIBBON = { left: 0.35, right: 0.65, top: 0.19, bottom: 0.81, apex: 0.60 };

function inRibbon(x, y, size) {
  const u = x / size;
  const v = y / size;
  if (u < RIBBON.left || u > RIBBON.right || v < RIBBON.top || v > RIBBON.bottom) return false;
  const half = (RIBBON.right - RIBBON.left) / 2;
  const centre = (RIBBON.left + RIBBON.right) / 2;
  /* The notch starts at the apex in the middle and slopes down to the bottom at each edge,
     so everything below that line is cut away. */
  const notchTop = RIBBON.apex + (Math.abs(u - centre) / half) * (RIBBON.bottom - RIBBON.apex);
  return v < notchTop;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / SAMPLES;
  const offset = step / 2;
  const total = SAMPLES * SAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + offset + sx * step;
          const y = py + offset + sy * step;
          if (!inRoundedSquare(x, y, size)) continue;
          const colour = inRibbon(x, y, size) ? WHITE : INK;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const index = (py * size + px) * 4;
      const covered = a / 255;
      pixels[index] = covered ? Math.round(r / covered) : 0;
      pixels[index + 1] = covered ? Math.round(g / covered) : 0;
      pixels[index + 2] = covered ? Math.round(b / covered) : 0;
      pixels[index + 3] = Math.round(a / total);
    }
  }
  return pixels;
}

/* ---------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (stride + 1)] = 0;  // filter: none
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- ico */

/* PNG-compressed entries, which every Windows since Vista and electron-builder read. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, directory, ...images.map(image => image.data)]);
}

/* ---------------------------------------------------------------- verify */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngHeader(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('not a PNG');
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('missing IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), depth: buffer[24], colourType: buffer[25] };
}

/* Inflates the pixel data too, so a truncated or mis-encoded IDAT cannot pass. */
function verifyPng(file, expected) {
  const buffer = fs.readFileSync(file);
  const info = readPngHeader(buffer);
  if (info.width !== expected || info.height !== expected) throw new Error(`${file}: ${info.width}x${info.height}, expected ${expected}`);
  if (info.depth !== 8 || info.colourType !== 6) throw new Error(`${file}: unexpected depth/colour type`);
  let at = 8;
  const parts = [];
  let sawEnd = false;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString('ascii');
    const data = buffer.subarray(at + 8, at + 8 + length);
    const stored = buffer.readUInt32BE(at + 8 + length);
    if (crc32(buffer.subarray(at + 4, at + 8 + length)) !== stored) throw new Error(`${file}: bad CRC on ${type}`);
    if (type === 'IDAT') parts.push(data);
    if (type === 'IEND') sawEnd = true;
    at += 12 + length;
  }
  if (!sawEnd) throw new Error(`${file}: no IEND`);
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const wanted = (expected * 4 + 1) * expected;
  if (raw.length !== wanted) throw new Error(`${file}: ${raw.length} pixel bytes, expected ${wanted}`);
  return { ...info, bytes: buffer.length };
}

function verifyIco(file, expectedSizes) {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error(`${file}: not an ICO`);
  const count = buffer.readUInt16LE(4);
  if (count !== expectedSizes.length) throw new Error(`${file}: ${count} entries, expected ${expectedSizes.length}`);
  const found = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    const declared = buffer[at] === 0 ? 256 : buffer[at];
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (offset + length > buffer.length) throw new Error(`${file}: entry ${index} runs past the end`);
    const info = readPngHeader(buffer.subarray(offset, offset + length));
    if (info.width !== declared || info.height !== declared) throw new Error(`${file}: entry ${index} declares ${declared} but holds ${info.width}`);
    found.push(declared);
  }
  if (found.join(',') !== expectedSizes.join(',')) throw new Error(`${file}: sizes ${found.join(',')}`);
  return { count, sizes: found, bytes: buffer.length };
}

/* ---------------------------------------------------------------- run */

function build() {
  const png = path.join(OUT, 'icon.png');
  fs.writeFileSync(png, encodePng(PNG_SIZE, render(PNG_SIZE)));
  const images = ICO_SIZES.map(size => ({ size, data: encodePng(size, render(size)) }));
  fs.writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(images));
  // A 256px PNG is handy for Linux desktop entries that do not want the 512.
  fs.writeFileSync(path.join(OUT, 'icon-256.png'), images[images.length - 1].data);
}

function main() {
  const verifyOnly = process.argv.includes('--verify');
  if (!verifyOnly) build();
  const png = verifyPng(path.join(OUT, 'icon.png'), PNG_SIZE);
  const small = verifyPng(path.join(OUT, 'icon-256.png'), 256);
  const ico = verifyIco(path.join(OUT, 'icon.ico'), ICO_SIZES);
  console.log(`icon.png     ${png.width}x${png.height} rgba8  ${png.bytes} bytes`);
  console.log(`icon-256.png ${small.width}x${small.height} rgba8  ${small.bytes} bytes`);
  console.log(`icon.ico     ${ico.count} entries [${ico.sizes.join(', ')}]  ${ico.bytes} bytes`);
  console.log('icons verified');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`icon generation failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { encodeIco, encodePng, render, verifyIco, verifyPng };
