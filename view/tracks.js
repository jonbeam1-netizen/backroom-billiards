// Tracks on the felt that come from play (item 36): a faint pale track where the cue ball started on a hard shot,
// like the pale burn a real cloth gets. Drawing only: the rules never see them and they never change how a ball rolls.
// Each track is worked out from the shot alone (where the cue ball was, which way it went, how fast), and its small
// unevenness from a generator seeded by those same numbers, so both players online draw exactly the same tracks.
// Never Math.random. Wiped on every re-rack and new game. The numbers are in data/tracks.json.
import * as THREE from '../lib/three.module.min.js';
import { makeRandom } from './textures.js';

/** Used when data/tracks.json is missing (an old copy of the game's data): the same numbers. */
const DEFAULTS = { minSpeed: 6.5, fullSpeed: 10, length: [0.05, 0.13], strength: [0.18, 0.4], width: 0.0024, markColour: [0.36, 0.38, 0.38], texelsAcross: 1024 };

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/**
 * A one-channel picture over the whole bed (the same layout as the cloth's colour picture: pixel (i, j) is
 * x = -outerHalfW + (i + .5) / W * 2 outerHalfW, z = outerHalfL - (j + .5) / H * 2 outerHalfL), and the two
 * shader inputs the cloth reads it with (see patchFeltMarks in models.js).
 * @param {import('../rules/types.js').TableGeometry} geom
 * @param {Object} [cfg]  data/tracks.json
 */
export function createTracks(geom, cfg) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const W = Math.max(64, Math.round(c.texelsAcross)), H = W * 2;
  const ox = geom.outerHalfW, oz = geom.outerHalfL;
  const px = 2 * ox / W, pz = 2 * oz / H;   // metres per pixel across and along
  const data = new Uint8Array(W * H);
  const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace; tex.anisotropy = 8;
  tex.needsUpdate = true;
  const uniforms = {
    feltMarks: { value: tex },
    feltMarkColour: { value: new THREE.Color(c.markColour[0], c.markColour[1], c.markColour[2]) },
  };
  let count = 0;

  /** A seed from the shot's own numbers (the same on both PCs). */
  function seedOf(x, z, dx, dz, speed) {
    let h = 2166136261 >>> 0;
    for (const v of [x, z, dx, dz, speed]) { h ^= (Math.round(v * 10000) | 0) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }

  /**
   * A hard shot: the cue ball started at (x, z) going along (dx, dz) at this speed. Leaves a track only from
   * minSpeed up. Returns whether it left one.
   */
  function add(x, z, dx, dz, speed) {
    if (!(speed >= c.minSpeed)) return false;
    const dl = Math.hypot(dx, dz);
    if (!(dl > 1e-9)) return false;
    dx /= dl; dz /= dl;
    const t = clamp01((speed - c.minSpeed) / Math.max(1e-6, c.fullSpeed - c.minSpeed));
    const L = c.length[0] + (c.length[1] - c.length[0]) * t;
    const peak = c.strength[0] + (c.strength[1] - c.strength[0]) * t;
    const w = c.width, halo = w * 2.5;
    const rnd = makeRandom(seedOf(x, z, dx, dz, speed));
    // the skid is not even: a few brighter patches where the ball pressed hardest, a faint line between them,
    // and the line wanders a hair sideways
    const patches = [];
    const n = 3 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const at = k === 0 ? 0.04 + rnd() * 0.06 : (k / n) * 0.85 + rnd() * 0.12;
      patches.push({ u: at * L, len: L * (0.06 + rnd() * 0.08), s: k === 0 ? 1 : 0.55 + rnd() * 0.45 });
    }
    const wob = 0.0004 + rnd() * 0.0005, wobK = 60 + rnd() * 80, wobP = rnd() * 6.3;
    // the cloth's fibres: fine lines along the skid and a speckle, so it reads as flattened nap and not paint
    const seed = Math.floor(rnd() * 4294967296) >>> 0;
    const hash = (a, b) => { let h = Math.imul(a ^ seed, 2654435761) ^ Math.imul(b + 0x9e3779b9, 1597334677); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
    const fibre = v => { const f = v / 0.0006, k = Math.floor(f), t = f - k, s = t * t * (3 - 2 * t); return hash(k, 7) * (1 - s) + hash(k + 1, 7) * s; };
    // the pixels round the track: along from -1 cm to L + 1 cm, across 4 halo widths each side
    const nx = -dz, nz = dx, reach = halo * 4;
    const ends = [[-0.01, -reach], [-0.01, reach], [L + 0.01, -reach], [L + 0.01, reach]].map(([u, v]) => [x + dx * u + nx * v, z + dz * u + nz * v]);
    const xs = ends.map(e => e[0]), zs = ends.map(e => e[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) + ox) / px)), i1 = Math.min(W - 1, Math.ceil((Math.max(...xs) + ox) / px));
    const j0 = Math.max(0, Math.floor((oz - Math.max(...zs)) / pz)), j1 = Math.min(H - 1, Math.ceil((oz - Math.min(...zs)) / pz));
    for (let j = j0; j <= j1; j++) {
      const wz = oz - (j + 0.5) * pz;
      for (let i = i0; i <= i1; i++) {
        const wx = -ox + (i + 0.5) * px;
        const rx = wx - x, rz = wz - z;
        const u = rx * dx + rz * dz;
        if (u < -0.01 || u > L + 0.01) continue;
        const v = rx * nx + rz * nz - wob * Math.sin(u * wobK + wobP);
        if (Math.abs(v) > reach) continue;
        const env = smooth(-0.003, 0.008, u) * (1 - smooth(L * 0.45, L, u));
        if (env <= 0) continue;
        let p = 0;
        for (const q of patches) p = Math.max(p, q.s * Math.exp(-(((u - q.u) / q.len) ** 2)));
        const across = Math.exp(-((v / w) ** 2)) + Math.exp(-((v / halo) ** 2)) / 5;
        const grain = 0.55 * fibre(v) + 0.45 * hash(i, j);
        const val = peak * env * (0.35 + 0.65 * p) * across * (0.3 + 0.7 * grain);
        if (val < 0.002) continue;
        const o = j * W + i, old = data[o] / 255;
        data[o] = Math.round(Math.min(1, 1 - (1 - old) * (1 - Math.min(1, val))) * 255);
      }
    }
    tex.needsUpdate = true;
    count++;
    return true;
  }

  /** Clean cloth (re-rack, new game). */
  function clear() {
    if (count === 0) return;
    data.fill(0);
    tex.needsUpdate = true;
    count = 0;
  }

  /** Test only: a fingerprint of the picture, to see that two PCs drew the same tracks. */
  function fingerprint() {
    let h = 2166136261 >>> 0, lit = 0;
    for (let i = 0; i < data.length; i++) { const v = data[i]; if (v) { lit++; h = Math.imul(h ^ (v + i * 31), 16777619) >>> 0; } }
    return { count, lit, hash: h.toString(16) };
  }

  return { uniforms, add, clear, count: () => count, fingerprint, dispose() { tex.dispose(); } };
}
