// Renders the Glint logo (gradient tile + white sparkles) to PNG icons and an SVG,
// without any image dependencies: shapes are flattened to polygons and
// rasterized with supersampling, then encoded with a tiny PNG writer.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

// Geometry in a 24x24 design space (same as the SVG viewBox).
const VIEW = 24;
const TILE_RADIUS = 5.6;
const GRADIENT = [
  [0, [99, 102, 241]], // indigo-500
  [1, [168, 85, 247]], // purple-500
];
const SPARKLES = [
  { cx: 10.6, cy: 13.2, r: 7.4, t: 0.32, alpha: 1 },
  { cx: 17.6, cy: 6.4, r: 3.1, t: 0.32, alpha: 0.92 },
];

function sparklePath({ cx, cy, r, t }) {
  // Four cubic segments: top -> right -> bottom -> left -> top.
  const k = r * t;
  return [
    [cx, cy - r],
    [[cx, cy - k], [cx + k, cy], [cx + r, cy]],
    [[cx + k, cy], [cx, cy + k], [cx, cy + r]],
    [[cx, cy + k], [cx - k, cy], [cx - r, cy]],
    [[cx - k, cy], [cx, cy - k], [cx, cy - r]],
  ];
}

function flatten(path, steps = 24) {
  const [start, ...curves] = path;
  const pts = [start];
  let p0 = start;
  for (const [c1, c2, p3] of curves) {
    for (let i = 1; i <= steps; i++) {
      const s = i / steps;
      const u = 1 - s;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * s * c1[0] + 3 * u * s * s * c2[0] + s * s * s * p3[0],
        u * u * u * p0[1] + 3 * u * u * s * c1[1] + 3 * u * s * s * c2[1] + s * s * s * p3[1],
      ]);
    }
    p0 = p3;
  }
  return pts;
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideRoundedRect(x, y, size, r) {
  const qx = Math.abs(x - size / 2) - (size / 2 - r);
  const qy = Math.abs(y - size / 2) - (size / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

function gradientAt(x, y) {
  const s = Math.min(Math.max((x + y) / (2 * VIEW), 0), 1);
  const [[s0, c0], [s1, c1]] = GRADIENT;
  const k = (s - s0) / (s1 - s0);
  return c0.map((v, i) => v + (c1[i] - v) * k);
}

function render(size) {
  const SS = 4; // supersamples per axis
  const scale = VIEW / size;
  const polys = SPARKLES.map((s) => ({ poly: flatten(sparklePath(s)), alpha: s.alpha }));
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (!insideRoundedRect(x, y, VIEW, TILE_RADIUS)) continue;
          let [cr, cg, cb] = gradientAt(x, y);
          for (const { poly, alpha } of polys) {
            if (insidePolygon(x, y, poly)) {
              cr += (255 - cr) * alpha;
              cg += (255 - cg) * alpha;
              cb += (255 - cb) * alpha;
            }
          }
          r += cr; g += cg; b += cb; a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svgPathData(s) {
  const [start, ...curves] = sparklePath(s);
  const f = (n) => +n.toFixed(2);
  return (
    `M${f(start[0])} ${f(start[1])}` +
    curves.map(([c1, c2, p]) => `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p[0])} ${f(p[1])}`).join('') +
    'Z'
  );
}

function renderSvg() {
  const stops = GRADIENT.map(([o, c]) => `<stop offset="${o}" stop-color="rgb(${c.join(',')})"/>`).join('');
  const sparkles = SPARKLES.map(
    (s) => `<path d="${svgPathData(s)}" fill="#fff"${s.alpha < 1 ? ` fill-opacity="${s.alpha}"` : ''}/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs>` +
    `<rect width="${VIEW}" height="${VIEW}" rx="${TILE_RADIUS}" fill="url(#g)"/>${sparkles}</svg>\n`
  );
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(join(OUT, `icon-${size}.png`), render(size));
}
writeFileSync(join(OUT, 'logo.svg'), renderSvg());
console.log(`icons written to ${OUT}`);
