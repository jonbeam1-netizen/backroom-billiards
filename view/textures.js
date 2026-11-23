// Every picture the table, balls and cue are painted with, made in code (no image files).
// Decoration only: a small seeded random keeps the look the same from run to run.
import * as THREE from '../lib/three.module.min.js';

/** A small seeded random generator (0 to 1), for decoration only. */
export function makeRandom(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** Smooth value noise that wraps every px cells across and py cells down. Returns 0 to 1. */
function makeNoise(seed, px, py = px) {
  const rnd = makeRandom(seed), g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py, x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g[y0 * px + x0], b = g[y0 * px + x1], c = g[y1 * px + x0], d = g[y1 * px + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function dataTexture(data, w, h, srgb) {
  if (srgb) {
    // colour pictures go through a plain 8-bit canvas (flipped so row 0 stays at the bottom), the most dependable path on every graphics card
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), img = g.createImageData(w, h);
    for (let j = 0; j < h; j++) img.data.set(data.subarray(j * w * 4, (j + 1) * w * 4), (h - 1 - j) * w * 4);
    g.putImageData(img, 0, 0);
    const ct = new THREE.CanvasTexture(c);
    ct.colorSpace = THREE.SRGBColorSpace;
    ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
    return ct;
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Distance from (x, z) to the segment a-b. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / l2) : 0;
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

/**
 * The cloth of the bed, covering the whole bed from rail edge to rail edge, as four plain fields (not a picture):
 * brightness (contact darkening at the cushions and holes, mottling, fine grain), wear, the white spot stickers,
 * and blue chalk dust. feltColourTexture turns them into the colour picture for one felt colour.
 * Pixel (i, j) is world x = -outerHalfW + (i + .5) / W * 2 outerHalfW, z = outerHalfL - (j + .5) / H * 2 outerHalfL.
 * @param {import('../rules/types.js').TableGeometry} geom
 * @param {number} W  across the table
 */
export function feltSurfaceTexture(geom, W) {
  const H = W * 2, ox = geom.outerHalfW, oz = geom.outerHalfL, R = geom.ballRadius || 0.028575;
  const data = new Uint8Array(W * H * 4);
  const rnd = makeRandom(7731);
  const n1 = makeNoise(11, 64), n2 = makeNoise(23, 64), n3 = makeNoise(37, 64), n4 = makeNoise(41, 64);
  const noses = geom.cushions.filter(c => c.kind === 'nose');
  const jaws = geom.cushions.filter(c => c.kind === 'jaw');

  // chalk marks: mostly near the cushions and pockets, where a cue is chalked and laid down
  const marks = [];
  for (let k = 0; k < 9; k++) {
    let x, z;
    const r = rnd() * 0.85;
    if (r < 0.65) {          // along a cushion, a few centimetres out
      const c = noses[Math.floor(rnd() * noses.length)], t = 0.08 + rnd() * 0.84, out = 0.015 + rnd() * 0.05;
      x = c.ax + (c.bx - c.ax) * t + c.nx * out; z = c.az + (c.bz - c.az) * t + c.nz * out;
    } else if (r < 0.85) {   // by a pocket
      const p = geom.pockets[Math.floor(rnd() * 6)];
      x = p.x * 0.93 + (rnd() - 0.5) * 0.08; z = p.z * (p.kind === 'side' ? 1 : 0.95) + (rnd() - 0.5) * 0.12;
      if (p.kind === 'side') x = Math.sign(p.x) * (geom.halfW - 0.03 - rnd() * 0.05);
    } else {                 // out on the cloth
      x = (rnd() - 0.5) * geom.width * 0.7; z = (rnd() - 0.5) * geom.length * 0.8;
    }
    const ang = rnd() * Math.PI, big = rnd() < 0.3;
    marks.push({ x, z, ca: Math.cos(ang), sa: Math.sin(ang), su: (big ? 0.022 : 0.009) + rnd() * 0.012, sv: 0.003 + rnd() * 0.006,
      peak: 0.06 + rnd() * (big ? 0.08 : 0.14), seed: rnd() * 50 });
  }

  for (let j = 0; j < H; j++) {
    const z = oz - (j + 0.5) / H * 2 * oz;
    for (let i = 0; i < W; i++) {
      const x = -ox + (i + 0.5) / W * 2 * ox;
      // brightness: large soft mottling, smaller cloudiness, a fine grain
      let b = 0.80 + (n1(x * 3.2 + 20, z * 3.2 + 20) - 0.5) * 0.05 + (n2(x * 18 + 5, z * 18 + 5) - 0.5) * 0.03 + (rnd() - 0.5) * 0.028;
      // contact darkening where the cloth runs under a cushion
      let ao = 1;
      for (const c of noses) {
        const d = segDist(x, z, c.ax, c.az, c.bx, c.bz);
        const side = (x - c.ax) * c.nx + (z - c.az) * c.nz;   // > 0 on the playing side
        if (d < 0.05) ao *= 1 - (side > 0 ? 0.42 * Math.exp(-d / 0.007) + 0.08 * Math.exp(-d / 0.03) : 0.5);
      }
      for (const c of jaws) {
        const d = segDist(x, z, c.ax, c.az, c.bx, c.bz);
        if (d < 0.03) ao *= 1 - 0.3 * Math.exp(-d / 0.006);
      }
      // the cloth darkens as it rolls into each hole
      for (const p of geom.pockets) {
        const d = Math.hypot(x - p.x, z - p.z) - p.r;
        if (d < 0.04) ao *= 1 - 0.55 * Math.exp(-Math.max(0, d) / 0.006);
      }
      b *= ao;

      // wear: the break area, the rack area, the lane between, the pocket mouths and the cushion lines
      const wn = n3(x * 9 + 3, z * 9 + 3);
      let wear = 0;
      wear += 0.55 * Math.exp(-((x * x) / 0.012 + ((z - geom.lineZ) ** 2) / 0.02));
      wear += 0.6 * Math.exp(-((x * x) / 0.016 + ((z - geom.rackZ + 0.08) ** 2) / 0.03));
      wear += 0.18 * Math.exp(-(x * x) / 0.02) * smooth(-geom.halfL, geom.rackZ, z) * (1 - smooth(geom.lineZ, geom.halfL, z));
      for (const p of geom.pockets) wear += 0.35 * Math.exp(-((x - p.x) ** 2 + (z - p.z) ** 2) / 0.012);
      const edge = Math.min(geom.halfW - Math.abs(x), geom.halfL - Math.abs(z));
      if (edge > 0) wear += 0.22 * Math.exp(-((edge - R) ** 2) / 0.0002);
      wear *= 0.55 + 0.9 * wn;
      wear = clamp01(wear);
      b += wear * 0.05;

      // the spot stickers: the foot spot (where the rack's front ball sits) and the head spot
      let spot = 0;
      const fs = Math.hypot(x, z - geom.rackZ), hs = Math.hypot(x, z - geom.lineZ);
      spot = Math.max(clamp01((0.0062 - fs) / 0.0007 + 0.5), clamp01((0.0045 - hs) / 0.0007 + 0.5) * 0.9);

      // chalk
      let chalk = 0;
      for (const m of marks) {
        const dx = x - m.x, dz = z - m.z;
        if (dx * dx + dz * dz > 0.004) continue;
        const u = dx * m.ca + dz * m.sa, v = -dx * m.sa + dz * m.ca;
        const g = Math.exp(-((u / m.su) ** 2 + (v / m.sv) ** 2));
        if (g < 0.01) continue;
        const streak = 0.75 + 0.35 * n4(u * 120 + m.seed, v * 40 + m.seed);
        chalk += m.peak * g * streak;
      }
      chalk = clamp01(chalk);

      const o = (j * W + i) * 4;
      data[o] = Math.round(clamp01(b) * 255);
      data[o + 1] = Math.round(wear * 255);
      data[o + 2] = Math.round(spot * 255);
      data[o + 3] = Math.round(chalk * 255);
    }
  }
  return { data, W, H };
}

const toLin = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const toSRGB = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

/**
 * The cloth's colour picture for one felt colour: a plain 8-bit sRGB canvas texture, so it draws the same on
 * every graphics card. Made from the fields of feltSurfaceTexture (brightness, wear, spots, chalk).
 * @param {{data:Uint8Array, W:number, H:number}} fields
 * @param {number} hex  the felt colour, sRGB
 * @param {HTMLCanvasElement} [canvas]  reuse this canvas (when the colour changes)
 */
export function feltColourTexture(fields, hex, canvas) {
  const { data, W, H } = fields;
  const c = canvas || document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H), out = img.data;
  const base = [toLin(((hex >> 16) & 255) / 255), toLin(((hex >> 8) & 255) / 255), toLin((hex & 255) / 255)];
  const luma = base[0] * 0.2126 + base[1] * 0.7152 + base[2] * 0.0722;
  const spotC = [toLin(0.85), toLin(0.83), toLin(0.77)], chalkC = [toLin(0.3), toLin(0.5), toLin(0.78)];
  // a lookup from 8-bit linear-ish value to sRGB byte, for speed
  const lut = new Uint8Array(4096); for (let i = 0; i < 4096; i++) lut[i] = Math.round(toSRGB(i / 4095) * 255);
  for (let j = 0; j < H; j++) {
    const row = (H - 1 - j) * W;   // the canvas's top row is the far end (texture v = 1)
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4, p = (row + i) * 4;
      const b = data[o] / 255 * 1.22, w = data[o + 1] / 255 * 0.14, s = data[o + 2] / 255, k = data[o + 3] / 255;
      for (let ch = 0; ch < 3; ch++) {
        let v = (base[ch] + (luma - base[ch]) * w) * b * (1 + w * 0.5);
        v += (spotC[ch] - v) * s;
        v += (chalkC[ch] - v) * k;
        out[p + ch] = lut[Math.max(0, Math.min(4095, Math.round(v * 4095)))];
      }
      out[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * The fine weave and nap of the cloth, as a repeating normal map. The fibres lie along the table (the nap).
 * @param {number} S  size in pixels (square, repeats)
 */
export function feltDetailNormal(S) {
  const hgt = new Float32Array(S * S);
  const fib = makeNoise(5, 32, 4), fib2 = makeNoise(9, 64, 8), pill = makeNoise(13, 16);
  const weave = S / 10;   // threads per tile
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    const w = Math.sin(2 * Math.PI * (u * weave + v * weave * 0.5)) * 0.5 + Math.sin(2 * Math.PI * u * weave * 2) * 0.15;
    const f = (fib(u * 32, v * 4) - 0.5) * 1.3 + (fib2(u * 64, v * 8) - 0.5) * 0.8 + (pill(u * 16, v * 16) - 0.5) * 0.5;
    hgt[y * S + x] = w * 0.35 + f;
  }
  const data = new Uint8Array(S * S * 4), k = 1.2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const l = hgt[y * S + ((x - 1 + S) % S)], r = hgt[y * S + ((x + 1) % S)];
    const d = hgt[((y - 1 + S) % S) * S + x], u = hgt[((y + 1) % S) * S + x];
    let nx = (l - r) * k, ny = (d - u) * k, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const o = (y * S + x) * 4;
    data[o] = (nx * 0.5 + 0.5) * 255; data[o + 1] = (ny * 0.5 + 0.5) * 255; data[o + 2] = (nz * 0.5 + 0.5) * 255; data[o + 3] = 255;
  }
  return dataTexture(data, S, S, false);
}

/**
 * Wood with a varnished, flat-sawn grain: long streaks along the texture's width.
 * The picture covers about 1.6 m along the grain and 0.25 m across.
 * @param {number} W  @param {number} H  @param {number} seed
 * @param {number[][]} pal  [dark, mid, light] colours, sRGB 0 to 255
 */
export function woodTexture(W, H, seed, pal) {
  const data = new Uint8Array(W * H * 4);
  const warp = makeNoise(seed + 1, 3, 4), warp2 = makeNoise(seed + 2, 12, 24), pores = makeNoise(seed + 3, 384, 96);
  const fig = makeNoise(seed + 4, 6, 6), rnd = makeRandom(seed + 5);
  const [dk, md, lt] = pal;
  for (let j = 0; j < H; j++) {
    const v = j / H;
    for (let i = 0; i < W; i++) {
      const u = i / W;
      // growth rings: long straight lines along the board, drifting gently, as in a quarter-sawn rail
      const f = v * 22 + warp(u * 3, v * 4) * 3.2 + warp2(u * 12, v * 24) * 0.35;
      const ring = f - Math.floor(f);
      const late = smooth(0.55, 0.85, ring) * (1 - smooth(0.9, 1, ring));
      // open pores: short dark dashes along the grain
      const p = pores(u * 384, v * 96);
      const pore = p < 0.2 ? (0.2 - p) * 2.5 : 0;
      const figure = (fig(u * 6, v * 6) - 0.5) * 0.3;
      let t = 0.55 + figure - late * 0.4 - pore * 0.3 + (rnd() - 0.5) * 0.04;
      t = clamp01(t);
      const a = t < 0.5 ? dk : md, b = t < 0.5 ? md : lt, s = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const o = (j * W + i) * 4;
      data[o] = a[0] + (b[0] - a[0]) * s; data[o + 1] = a[1] + (b[1] - a[1]) * s; data[o + 2] = a[2] + (b[2] - a[2]) * s; data[o + 3] = 255;
    }
  }
  return dataTexture(data, W, H, true);
}

// ---------------------------------------------------------------- balls

const IVORY = [246, 240, 224];
/** Ball colours, sRGB. 0 is the cue ball; 1 to 8 are the solids (and the stripes 9 to 15 reuse 1 to 7). */
export const BALL_RGB = [IVORY, [245, 184, 0], [28, 62, 166], [212, 35, 31], [78, 44, 138], [242, 102, 28], [14, 122, 70], [124, 29, 36], [16, 16, 18]];
const STRIPE_LAT = 38 * Math.PI / 180;   // the stripe covers 38 degrees either side of the middle
const CIRCLE_ANG = 24 * Math.PI / 180;   // the number circle's angular radius

let glyphCanvas = null;
/** The number, black on clear, drawn once on a small canvas. */
function glyph(id) {
  const S = 256;
  if (!glyphCanvas) { glyphCanvas = document.createElement('canvas'); glyphCanvas.width = glyphCanvas.height = S; }
  const g = glyphCanvas.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#000';
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const two = id >= 10;
  g.font = 'bold ' + (two ? 150 : 168) + 'px "Arial", "Helvetica", sans-serif';
  g.save();
  g.translate(S / 2, S / 2);
  g.scale(two ? 0.78 : 0.92, 1);
  const m = g.measureText(String(id));
  const asc = m.actualBoundingBoxAscent || 120, desc = m.actualBoundingBoxDescent || 0;
  g.fillText(String(id), 0, (asc - desc) / 2);
  g.restore();
  if (id === 6 || id === 9) { g.fillRect(S / 2 - 34, S / 2 + 70, 68, 13); }   // the bar under 6 and 9
  return g.getImageData(0, 0, S, S).data;
}

/**
 * The picture wrapped round a ball (the sphere's own UV layout): colour, stripe, number circles, numbers.
 * Worked out per pixel on the sphere, so the circles are round on the ball and the edges are smooth.
 * @param {number} id  @param {number} W  width (height is half)
 */
export function ballTexture(id, W) {
  const H = W / 2, data = new Uint8Array(W * H * 4);
  const solid = id >= 1 && id <= 8, stripe = id >= 9;
  const col = BALL_RGB[id === 0 ? 0 : id <= 8 ? id : id - 8];
  const g = id > 0 ? glyph(id) : null;
  const aa = Math.PI / H * 1.2;
  const tanC = Math.tan(CIRCLE_ANG) * 1.02;
  const ink = [22, 22, 24];
  // cue ball: six small dots on the three axes, so its spin shows
  const dots = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], dotAng = 4.2 * Math.PI / 180, dotCol = [168, 38, 40];
  for (let j = 0; j < H; j++) {
    const th = Math.PI * (1 - (j + 0.5) / H), st = Math.sin(th), dy = Math.cos(th);
    for (let i = 0; i < W; i++) {
      const ph = 2 * Math.PI * (i + 0.5) / W;
      const dx = -Math.cos(ph) * st, dz = Math.sin(ph) * st;
      let r = col[0], gg = col[1], b = col[2];
      if (stripe) {
        const lat = Math.asin(Math.max(-1, Math.min(1, dy)));
        const cover = clamp01((STRIPE_LAT - Math.abs(lat)) / aa + 0.5);
        r = IVORY[0] + (col[0] - IVORY[0]) * cover; gg = IVORY[1] + (col[1] - IVORY[1]) * cover; b = IVORY[2] + (col[2] - IVORY[2]) * cover;
      }
      if (id === 0) {
        for (const d of dots) {
          const a = Math.acos(Math.max(-1, Math.min(1, dx * d[0] + dy * d[1] + dz * d[2])));
          const c = clamp01((dotAng - a) / aa + 0.5);
          if (c > 0) { r += (dotCol[0] - r) * c; gg += (dotCol[1] - gg) * c; b += (dotCol[2] - b) * c; }
        }
      } else {
        // the two number circles face +z and -z
        for (const s of [1, -1]) {
          const cd = dz * s;
          if (cd < Math.cos(CIRCLE_ANG) - 0.05) continue;
          const a = Math.acos(Math.min(1, cd));
          const c = clamp01((CIRCLE_ANG - a) / aa + 0.5);
          if (c <= 0) continue;
          r += (IVORY[0] - r) * c; gg += (IVORY[1] - gg) * c; b += (IVORY[2] - b) * c;
          // the number: flatten the sphere onto the circle's tangent plane and read the drawn digit
          const px = (dx * s) / cd, py = dy / cd;   // right is +x seen from +z, and -x seen from -z
          const gx = (px / tanC * 0.5 + 0.5) * 255, gy = (0.5 - py / tanC * 0.5) * 255;
          if (gx >= 0 && gx < 255 && gy >= 0 && gy < 255) {
            const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
            const A = (yy, xx) => g[(yy * 256 + xx) * 4 + 3] / 255;
            const al = (A(y0, x0) * (1 - fx) + A(y0, x0 + 1) * fx) * (1 - fy) + (A(y0 + 1, x0) * (1 - fx) + A(y0 + 1, x0 + 1) * fx) * fy;
            const k = al * c;
            r += (ink[0] - r) * k; gg += (ink[1] - gg) * k; b += (ink[2] - b) * k;
          }
        }
      }
      if (id === 8 && solid) { /* the 8 is a solid with black ground: already handled by its colour */ }
      const o = (j * W + i) * 4;
      data[o] = r; data[o + 1] = gg; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  const t = dataTexture(data, W, H, true);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------- the cue

/**
 * The cue's paint, laid out along its length (texture height = tip to butt) and round it (width).
 * Returns the colour picture and a second picture of the finish: R clearcoat, G roughness, B metal.
 * @param {number} length metres  @param {number} H pixels along
 * @param {{z:number, name:string}[]} marks  where each part starts, metres from the tip
 */
export function cueTextures(length, H, marks) {
  const W = 128;
  const col = document.createElement('canvas'); col.width = W; col.height = H;
  const fin = document.createElement('canvas'); fin.width = W; fin.height = H;
  const c = col.getContext('2d'), f = fin.getContext('2d');
  const at = z => z / length * H;   // canvas row for a distance from the tip (row 0 = tip; flipY puts it at v = 1, fixed in the geometry)
  const band = (z0, z1, colour, cc, rough, metal) => {
    c.fillStyle = colour; c.fillRect(0, at(z0), W, Math.max(1, at(z1) - at(z0)));
    f.fillStyle = 'rgb(' + Math.round(cc * 255) + ',' + Math.round(rough * 255) + ',' + Math.round(metal * 255) + ')';
    f.fillRect(0, at(z0), W, Math.max(1, at(z1) - at(z0)));
  };
  const M = {}; for (const m of marks) M[m.name] = m.z;
  const rnd = makeRandom(99);

  band(0, M.ferrule, '#5b3a26', 0, 0.85, 0);                    // the leather tip
  band(0, 0.0025, '#3d6fa0', 0, 0.95, 0);                       // blue chalk on its face
  band(M.ferrule, M.shaft, '#f1ead8', 0.6, 0.3, 0);             // ferrule
  band(M.shaft, M.joint, '#e9d3a6', 0.7, 0.35, 0);              // maple shaft
  // faint maple grain on the shaft
  for (let k = 0; k < 90; k++) {
    const x = rnd() * W, z0 = M.shaft + rnd() * (M.joint - M.shaft), len = 0.05 + rnd() * 0.25;
    c.strokeStyle = 'rgba(150,105,50,' + (0.05 + rnd() * 0.08) + ')'; c.lineWidth = 0.6 + rnd();
    c.beginPath(); c.moveTo(x, at(z0)); c.lineTo(x + (rnd() - 0.5) * 3, at(Math.min(M.joint, z0 + len))); c.stroke();
  }
  // shaft darkens a touch toward the tip from hands and chalk
  const grd = c.createLinearGradient(0, at(M.shaft), 0, at(M.shaft + 0.3));
  grd.addColorStop(0, 'rgba(120,100,70,0.18)'); grd.addColorStop(1, 'rgba(120,100,70,0)');
  c.fillStyle = grd; c.fillRect(0, at(M.shaft), W, at(M.shaft + 0.3) - at(M.shaft));
  // the joint: ivory collar between two black rings, with a steel ring in the middle
  band(M.joint, M.joint + 0.003, '#121212', 0.8, 0.25, 0);
  band(M.joint + 0.003, M.joint + 0.017, '#efe7d2', 0.8, 0.25, 0);
  band(M.joint + 0.008, M.joint + 0.012, '#b8b4ac', 0, 0.25, 1);
  band(M.joint + 0.017, M.forearm, '#121212', 0.8, 0.25, 0);
  // forearm: dark rosewood with four long points of pale maple, edged in black and red
  band(M.forearm, M.wrap, '#3a1a0e', 0.9, 0.3, 0);
  for (let k = 0; k < 60; k++) {
    const x = rnd() * W, z0 = M.forearm + rnd() * (M.wrap - M.forearm);
    c.strokeStyle = 'rgba(15,5,2,' + (0.15 + rnd() * 0.25) + ')'; c.lineWidth = 0.5 + rnd() * 1.5;
    c.beginPath(); c.moveTo(x, at(z0)); c.lineTo(x + (rnd() - 0.5) * 4, at(Math.min(M.wrap, z0 + 0.04 + rnd() * 0.12))); c.stroke();
  }
  const pointTop = M.forearm + (M.wrap - M.forearm) * 0.22;
  const point = (cx, half, colour) => {
    c.fillStyle = colour; c.beginPath();
    c.moveTo(cx - half, at(M.wrap)); c.lineTo(cx, at(pointTop) - half * 2.2); c.lineTo(cx + half, at(M.wrap)); c.closePath(); c.fill();
  };
  for (let k = 0; k < 4; k++) {
    const cx = (k + 0.5) * W / 4;
    point(cx, 12.5, '#0c0c0c'); point(cx, 11, '#8e1f1c'); point(cx, 9.5, '#0c0c0c'); point(cx, 8.5, '#e6cf9c');
    // a small pearl diamond floating ahead of each point
    const dz = at(pointTop) - 46;
    c.fillStyle = '#efe9dc'; c.beginPath(); c.moveTo(cx, dz - 9); c.lineTo(cx + 4, dz); c.lineTo(cx, dz + 9); c.lineTo(cx - 4, dz); c.closePath(); c.fill();
  }
  // rings and the wrap
  band(M.wrap - 0.004, M.wrap, '#d9d2c2', 0.8, 0.25, 0);
  band(M.wrap - 0.0025, M.wrap - 0.0015, '#151515', 0.8, 0.25, 0);
  band(M.wrap, M.sleeve, '#1a1714', 0, 0.92, 0);
  for (let y = Math.floor(at(M.wrap)); y < at(M.sleeve); y += 2) {   // linen: fine crossing threads
    for (let x = 0; x < W; x += 2) {
      const v = ((x + y) >> 1) % 2 ? 0.06 : 0.0;
      c.fillStyle = 'rgba(200,190,170,' + (v + rnd() * 0.05) + ')'; c.fillRect(x, y, 2, 2);
    }
  }
  band(M.sleeve, M.sleeve + 0.004, '#d9d2c2', 0.8, 0.25, 0);
  band(M.sleeve + 0.0015, M.sleeve + 0.0025, '#151515', 0.8, 0.25, 0);
  // butt sleeve: the same dark wood, a band of pearl diamonds between two thin rings
  band(M.sleeve + 0.004, M.cap, '#30150b', 0.9, 0.3, 0);
  const mid = (M.sleeve + M.cap) / 2;
  band(mid - 0.02, mid - 0.018, '#d9d2c2', 0.8, 0.25, 0); band(mid + 0.018, mid + 0.02, '#d9d2c2', 0.8, 0.25, 0);
  for (let k = 0; k < 6; k++) {
    const cx = (k + 0.5) * W / 6, cz = at(mid);
    c.fillStyle = '#efe9dc'; c.beginPath(); c.moveTo(cx, cz - 16); c.lineTo(cx + 6, cz); c.lineTo(cx, cz + 16); c.lineTo(cx - 6, cz); c.closePath(); c.fill();
  }
  band(M.cap, M.bumper, '#0e0e0e', 0.9, 0.25, 0);
  band(M.bumper, length, '#161616', 0, 0.8, 0);

  const ct = new THREE.CanvasTexture(col); ct.colorSpace = THREE.SRGBColorSpace; ct.anisotropy = 4;
  const ft = new THREE.CanvasTexture(fin); ft.colorSpace = THREE.NoColorSpace;
  return { map: ct, finish: ft };
}

/** A soft round dark-to-clear spot, for the faint glow on the floor and similar. */
export function radialTexture(size, stops) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
