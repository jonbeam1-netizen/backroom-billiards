// The models: table, balls, cue. Each is built in code by its own function and needs no game state
// (build rule 11). The table is built from the same measurements the rules use (build rule 7): the cloth, the
// cushion noses, the pocket holes and jaws sit exactly where the rules have them. Everything else (the rail's
// wood, the corner castings, the pocket liners, the cabinet) is decoration added round them.
import * as THREE from '../lib/three.module.min.js';
import { feltSurfaceTexture, feltColourTexture, feltDetailNormal, woodTexture, ballTexture, cueTextures, makeRandom, radialTexture } from './textures.js';

/** Felt colours (sRGB), chosen to stay rich under the warm lamp light. */
export const FELT_COLOURS = { green: 0x17643c, blue: 0x1a4f86, red: 0x6e1822 };

/**
 * Picture quality. Low still looks right; it draws fewer pixels, with smaller pictures and simpler finishes.
 * @typedef {{name:string, pixelRatio:number, feltW:number, detail:number, wood:number[], ball:number, cue:number,
 *   sphere:number[], lathe:number, physical:boolean, anisotropy:number, ballShadowsOnBalls:boolean}} Quality
 */
/** @type {Object<string, Quality>} */
export const QUALITY = {
  low:    { name: 'low',    pixelRatio: 1,   feltW: 512,  detail: 128, wood: [1024, 128], ball: 512,  cue: 1024, sphere: [32, 22], lathe: 14, physical: false, anisotropy: 2, ballShadowsOnBalls: false },
  medium: { name: 'medium', pixelRatio: 1.5, feltW: 768,  detail: 256, wood: [2048, 256], ball: 512,  cue: 2048, sphere: [48, 32], lathe: 20, physical: true,  anisotropy: 4, ballShadowsOnBalls: true },
  high:   { name: 'high',   pixelRatio: 2,   feltW: 1024, detail: 256, wood: [2048, 256], ball: 1024, cue: 2048, sphere: [64, 44], lathe: 28, physical: true,  anisotropy: 8, ballShadowsOnBalls: true },
};

// pictures are slow-ish to make, so each is made once per size and kept
const texCache = new Map();
function cached(key, make) { if (!texCache.has(key)) texCache.set(key, make()); return texCache.get(key); }

// ---------------------------------------------------------------- small geometry helpers

/** Join geometries that have the same attributes into one (one draw call). */
function mergeGeometries(list) {
  const geos = list.map(g => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(geos[0].attributes);
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const size = geos[0].attributes[n].itemSize;
    let len = 0; for (const g of geos) len += g.attributes[n].count * size;
    const arr = new Float32Array(len);
    let o = 0; for (const g of geos) { arr.set(g.attributes[n].array, o); o += g.attributes[n].count * size; }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  return out;
}

/** Give a geometry a vertex colour from its height: a lit top fading to black below (things fade into the dark). */
function heightShade(geo, yTop, yBottom, top, bottom) {
  const p = geo.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, Math.min(1, (yTop - p.getY(i)) / (yTop - yBottom)));
    const v = top + (bottom - top) * t * (2 - t);
    c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}
function whiteColours(geo) { return heightShade(geo, 1, 0, 1, 1); }

/** Points along an arc in the flat (x, z) plane. */
function arc(cx, cz, r, a0, a1, step = 0.004) {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / step)), pts = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]); }
  return pts;
}

/** Extrude a flat outline, given as world (x, z) points, upward between y0 and y1 with rounded edges. */
function slab(pts, y0, y1, bevel, segs = 3, curveSegs = 6) {
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0 - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: segs, curveSegments: curveSegs });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0 + bevel, 0);
  return geo;
}

/**
 * The cushion box grown by `grow`, opened up round each pocket by a circle of the hole's radius plus `lip`,
 * as shape points (x, -z).
 * @returns {THREE.Vector2[]}
 */
function bedOutline(geom, grow, lip) {
  const ix = geom.halfW + grow, iz = geom.halfL + grow, pts = [], N = 720;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2, ux = Math.cos(th), uz = Math.sin(th);
    let r = Math.min(ix / Math.max(1e-9, Math.abs(ux)), iz / Math.max(1e-9, Math.abs(uz)));
    for (const p of geom.pockets) {
      const R = p.r + lip, uc = ux * p.x + uz * p.z, disc = uc * uc - (p.x * p.x + p.z * p.z) + R * R;
      if (disc >= 0) r = Math.max(r, uc + Math.sqrt(disc));
    }
    pts.push(new THREE.Vector2(ux * r, -uz * r));
  }
  return pts;
}

/** Keep only the side walls of an extruded outline (drop its flat top and bottom). */
function sidesOnly(geo) {
  const side = geo.groups.find(g => g.materialIndex === 1);
  const out = new THREE.BufferGeometry();
  for (const n of Object.keys(geo.attributes)) {
    const a = geo.attributes[n];
    out.setAttribute(n, new THREE.BufferAttribute(a.array.slice(side.start * a.itemSize, (side.start + side.count) * a.itemSize), a.itemSize));
  }
  geo.dispose();
  return out;
}

// ---------------------------------------------------------------- the cushion

/**
 * One strip of cushion between two pockets: the real profile (undercut face, rounded nose at the rules' nose
 * height, top rising to the rail), ends cut along the pocket jaws, all covered in cloth.
 */
function cushionGeometry(seg, table, pk) {
  const d = table.cushion.depth, hN = table.cushion.noseHeight, hT = table.cushion.railTopHeight;
  const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az), tx = (seg.bx - seg.ax) / len, tz = (seg.bz - seg.az) / len;
  const runAt = (x, z) => (Math.abs(z) < len * 0.25 && Math.abs(tz) > 0.5) ? pk.sideJawRun : pk.cornerJawRun;
  const ra = runAt(seg.ax, seg.az), rb = runAt(seg.bx, seg.bz);
  // profile: [distance back from the nose line, height, sharp corner]
  const prof = [[d, 0, 1], [0.014, 0, 1], [0.0055, 0.02, 0], [0.0016, 0.031, 0], [0, hN, 0], [0.0012, hN + 0.0022, 0],
    [0.0045, hN + 0.004, 0], [0.012, hT - 0.0008, 0], [0.03, hT - 0.0002, 0], [d, hT, 1]];
  const n = prof.length;
  const nx = seg.nx, nz = seg.nz;   // into the playing area
  const A = k => [seg.ax - nx * prof[k][0] - tx * ra * prof[k][0] / d, prof[k][1], seg.az - nz * prof[k][0] - tz * ra * prof[k][0] / d];
  const B = k => [seg.bx - nx * prof[k][0] + tx * rb * prof[k][0] / d, prof[k][1], seg.bz - nz * prof[k][0] + tz * rb * prof[k][0] / d];
  // the profile runs round clockwise (b right, h up); the outward normal of an edge (db, dh) is (-dh, db)
  const edgeN = [];
  for (let k = 0; k < n; k++) {
    const p = prof[k], q = prof[(k + 1) % n], db = q[0] - p[0], dh = q[1] - p[1], l = Math.hypot(db, dh);
    edgeN.push([-dh / l, db / l]);
  }
  const to3 = (nb, nh) => [-nx * nb, nh, -nz * nb];
  const pos = [], nor = [], uv = [];
  let vAcc = 0;
  const centre = [(seg.ax + seg.bx) / 2 - nx * d * 0.5, hT * 0.5, (seg.az + seg.bz) / 2 - nz * d * 0.5];
  const tri = (a, b, c, na, nb, nc, ua, ub, uc) => {
    // keep the winding facing the way the normal points
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const want = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
    if (fn[0] * want[0] + fn[1] * want[1] + fn[2] * want[2] < 0) { [b, c] = [c, b]; [nb, nc] = [nc, nb]; [ub, uc] = [uc, ub]; }
    pos.push(...a, ...b, ...c); nor.push(...na, ...nb, ...nc); uv.push(...ua, ...ub, ...uc);
  };
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const e = edgeN[k];
    const nAt = (idx, which) => {   // smooth across soft profile points
      if (prof[idx][2]) return to3(e[0], e[1]);
      const o = edgeN[which === 0 ? (idx - 1 + n) % n : idx];
      const m = [e[0] + o[0], e[1] + o[1]], l = Math.hypot(m[0], m[1]);
      return to3(m[0] / l, m[1] / l);
    };
    const nA = nAt(k, 0), nB = nAt(k2, 1);
    const segLen = Math.hypot(prof[k2][0] - prof[k][0], prof[k2][1] - prof[k][1]);
    const a0 = A(k), b0 = B(k), a1 = A(k2), b1 = B(k2);
    const ua0 = [(a0[0] * tx + a0[2] * tz), vAcc], ub0 = [(b0[0] * tx + b0[2] * tz), vAcc];
    const ua1 = [(a1[0] * tx + a1[2] * tz), vAcc + segLen], ub1 = [(b1[0] * tx + b1[2] * tz), vAcc + segLen];
    tri(a0, b0, b1, nA, nA, nB, ua0, ub0, ub1);
    tri(a0, b1, a1, nA, nB, nB, ua0, ub1, ua1);
    vAcc += segLen;
  }
  // the two ends, cut along the jaws
  for (const end of [A, B]) {
    const p0 = end(0), c3 = [0, 0, 0];
    for (let k = 0; k < n; k++) { const p = end(k); c3[0] += p[0] / n; c3[1] += p[1] / n; c3[2] += p[2] / n; }
    let fnx = c3[0] - centre[0], fnz = c3[2] - centre[2];
    // the face's true normal: perpendicular to the jaw line, horizontal
    const jaw = [end(n - 1)[0] - end(1)[0], end(n - 1)[2] - end(1)[2]];
    let px = -jaw[1], pz = jaw[0];
    if (px * fnx + pz * fnz < 0) { px = -px; pz = -pz; }
    const pl = Math.hypot(px, pz); px /= pl; pz /= pl;
    const fN = [px, 0, pz];
    for (let k = 1; k < n - 1; k++) {
      const a = end(k), b = end(k + 1);
      tri(p0, a, b, fN, fN, fN, [p0[0] * pz - p0[2] * px, p0[1]], [a[0] * pz - a[2] * px, a[1]], [b[0] * pz - b[2] * px, b[1]]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** A surface of revolution round a vertical axis at (cx, cz), from angle a0 to a1, through profile points [radius, y]. */
function revolve(cx, cz, prof, a0, a1, segs, uvScale = 1) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * i / segs, c = Math.cos(a), s = Math.sin(a);
    let v = 0;
    for (let k = 0; k < prof.length; k++) {
      if (k) v += Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]);
      pos.push(cx + prof[k][0] * c, prof[k][1], cz + prof[k][0] * s);
      uv.push(a * prof[k][0] * uvScale, v * uvScale);
    }
  }
  const m = prof.length;
  for (let i = 0; i < segs; i++) for (let k = 0; k < m - 1; k++) {
    const a = i * m + k, b = (i + 1) * m + k;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The angles (in the flat plane round (cx, cz)) where a circle of radius r lies outside the cushion box. */
function outsideArc(cx, cz, r, bx, bz) {
  const out = a => Math.abs(cx + r * Math.cos(a)) > bx + 1e-6 || Math.abs(cz + r * Math.sin(a)) > bz + 1e-6;
  // the middle of the outside part points away from the table's centre
  const mid = Math.atan2(cz, cx);
  let lo = mid, hi = mid;
  const step = 0.01;
  while (out(lo - step) && lo - step > mid - Math.PI) lo -= step;
  while (out(hi + step) && hi + step < mid + Math.PI) hi += step;
  // refine both ends
  for (let k = 0; k < 20; k++) { const m = (lo - step + lo) / 2; if (out(m)) lo = m; else break; }
  return [lo, hi];
}

// ---------------------------------------------------------------- the table

/**
 * Teach the bed's cloth the tracks from play (item 36): a one-channel picture laid over the bed with the same
 * layout as the cloth's colour picture. Where it is bright, the cloth's colour is paled toward markColour before
 * the light falls on it, so a track takes the lamp light, the ball shadows and the weave like the cloth round it.
 * @param {THREE.Material} felt
 * @param {{uniforms:{feltMarks:{value:THREE.Texture}, feltMarkColour:{value:THREE.Color}}}} marks
 */
function patchFeltMarks(felt, marks) {
  const before = felt.onBeforeCompile, key = felt.customProgramCacheKey();
  felt.onBeforeCompile = (shader, r) => {
    before.call(felt, shader, r);
    shader.uniforms.feltMarks = marks.uniforms.feltMarks;
    shader.uniforms.feltMarkColour = marks.uniforms.feltMarkColour;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D feltMarks;\nuniform vec3 feltMarkColour;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tdiffuseColor.rgb = mix( diffuseColor.rgb, feltMarkColour, texture2D( feltMarks, vMapUv ).r );');
  };
  felt.customProgramCacheKey = () => key + 'M';
  felt.needsUpdate = true;
}

/**
 * The whole table.
 * @param {import('../rules/types.js').TableGeometry} geom
 * @param {Object} table   data/table.json
 * @param {number} feltColour
 * @param {{quality?: Quality, occlusion?: ReturnType<import('./occlusion.js').createOcclusion>, marks?: Object}} [opts]
 *        marks: the tracks from play (see patchFeltMarks); the title screen has none
 * @returns {{group: THREE.Group, feltMaterials: THREE.Material[], dispose: () => void}}
 */
export function buildTableModel(geom, table, feltColour, opts = {}) {
  const q = opts.quality || QUALITY.high, occ = opts.occlusion;
  const group = new THREE.Group();
  const d = table.cushion.depth, hT = table.cushion.railTopHeight;
  const ox = geom.outerHalfW, oz = geom.outerHalfL, hw = geom.halfW, hl = geom.halfL;
  const lip = 0.004;
  const railThick = 0.07;
  const disposables = [];
  const keep = x => { disposables.push(x); return x; };
  const rnd = makeRandom(4242);

  // ---- pictures
  const feltFields = cached('felt' + q.feltW + geom.size, () => feltSurfaceTexture(geom, q.feltW));
  const feltCanvas = feltColourTexture(feltFields, feltColour);
  const feltTex = keep(new THREE.CanvasTexture(feltCanvas));
  feltTex.colorSpace = THREE.SRGBColorSpace; feltTex.anisotropy = q.anisotropy;
  const detail = cached('detail' + q.detail, () => feltDetailNormal(q.detail));
  const tile = 0.02;   // one repeat of the weave, metres
  const bedDetail = keep(detail.clone()); bedDetail.repeat.set(ox * 2 / tile, oz * 2 / tile); bedDetail.anisotropy = q.anisotropy; bedDetail.needsUpdate = true;
  const cushDetail = keep(detail.clone()); cushDetail.repeat.set(1 / tile, 1 / tile); cushDetail.needsUpdate = true;
  const railWood = cached('wood' + q.wood[0], () => woodTexture(q.wood[0], q.wood[1], 17, [[52, 22, 9], [104, 50, 22], [150, 82, 40]]));
  railWood.anisotropy = q.anisotropy;
  const bodyWood = cached('woodb' + q.wood[0], () => woodTexture(q.wood[0] / 2, q.wood[1] / 2, 61, [[26, 12, 6], [52, 26, 12], [76, 40, 20]]));

  // ---- materials
  const fc = new THREE.Color(feltColour);
  const sheenOf = c => c.clone().multiplyScalar(1.6).lerp(new THREE.Color(1, 1, 1), 0.06);
  const Felt = q.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const feltProps = q.physical ? { sheen: 0.6, sheenRoughness: 0.55, sheenColor: sheenOf(fc) } : {};
  const felt = keep(new Felt({ color: 0xffffff, roughness: 0.92, metalness: 0, map: feltTex, normalMap: bedDetail, normalScale: new THREE.Vector2(0.4, 0.4), ...feltProps }));
  const cushionFelt = keep(new Felt({ color: fc, roughness: 0.9, metalness: 0, normalMap: cushDetail, normalScale: new THREE.Vector2(0.4, 0.4), ...feltProps }));
  if (occ) {
    occ.patch(felt, { balls: true, cue: true, ambient: true });
    occ.patch(cushionFelt, { balls: true, cue: true, ambient: true });
  }
  if (opts.marks) patchFeltMarks(felt, opts.marks);
  const Wood = q.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const wood = keep(new Wood({ map: railWood, roughness: q.physical ? 0.6 : 0.45, metalness: 0, envMapIntensity: 0.35, ...(q.physical ? { clearcoat: 0.6, clearcoatRoughness: 0.12 } : {}) }));
  if (occ) occ.patch(wood, { balls: true, cue: true, ambient: true });
  const body = keep(new THREE.MeshStandardMaterial({ map: bodyWood, roughness: 0.5, vertexColors: true }));
  const liner = keep(new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.62, vertexColors: true, side: THREE.DoubleSide }));
  const metal = keep(new THREE.MeshStandardMaterial({ color: 0x6a5a46, metalness: 1, roughness: 0.24 }));
  const Pearl = q.physical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const pearl = keep(new Pearl({ color: 0xece6d8, roughness: 0.25, ...(q.physical ? { iridescence: 0.7, iridescenceIOR: 1.6, clearcoat: 0.8 } : {}), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const inlayRim = keep(new THREE.MeshStandardMaterial({ color: 0x9a7a48, metalness: 1, roughness: 0.3, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));

  // ---- the bed: cloth from rail edge to rail edge, with the six holes
  {
    // its edge runs just under the rails: the cushion box, opened round each pocket
    const s = new THREE.Shape(bedOutline(geom, d + 0.012, lip + 0.003));
    for (const p of geom.pockets) { const h = new THREE.Path(); h.absarc(p.x, -p.z, p.r + 0.0035, 0, Math.PI * 2, true); s.holes.push(h); }
    const g = new THREE.ShapeGeometry(s, 40);
    g.rotateX(-Math.PI / 2);
    const P = g.attributes.position, U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) U.setXY(i, (P.getX(i) + ox) / (2 * ox), (oz - P.getZ(i)) / (2 * oz));
    const bed = new THREE.Mesh(keep(g), felt);
    bed.name = 'bed';
    group.add(bed);
  }

  // ---- cushions, and the cloth rolling over the edge of each hole
  {
    const parts = [];
    for (const seg of geom.cushions) if (seg.kind === 'nose') parts.push(cushionGeometry(seg, table, table.pockets));
    for (const p of geom.pockets) {
      const g = revolve(p.x, p.z, [[p.r + 0.0035, 0], [p.r + 0.0013, -0.0007], [p.r + 0.0002, -0.0026], [p.r - 0.001, -0.0066]], 0, Math.PI * 2, 64, 1);
      parts.push(g.toNonIndexed());
    }
    const m = new THREE.Mesh(keep(mergeGeometries(parts)), cushionFelt);
    m.name = 'cushions';
    group.add(m);
  }

  // ---- pocket liners: the rubber wall in the rail's cut, and the dark cup below the hole
  {
    const parts = [];
    for (const p of geom.pockets) {
      const Rc = p.r + lip;
      // the cup stays inside everything else (the rail's wood goes below the cloth round the hole)
      const cup = revolve(p.x, p.z, [[p.r - 0.001, -0.0065], [p.r - 0.0035, -0.02], [p.r * 0.95, -0.075], [p.r * 0.9, -0.13], [0, -0.135]], 0, Math.PI * 2, 64);
      heightShade(cup, -0.006, -0.11, 0.55, 0.0);
      parts.push(cup.toNonIndexed());
      const [a0, a1] = outsideArc(p.x, p.z, Rc, hw + d, hl + d);
      const wall = revolve(p.x, p.z, [[Rc - 0.004, hT - 0.001], [Rc - 0.0062, hT - 0.006], [Rc - 0.0062, 0.004], [p.r - 0.0009, -0.003], [p.r - 0.0014, -0.0072]], a0, a1, 48);
      heightShade(wall, hT, -0.008, 1.0, 0.45);
      parts.push(wall.toNonIndexed());
    }
    const m = new THREE.Mesh(keep(mergeGeometries(parts)), liner);
    m.name = 'liners';
    group.add(m);
  }

  // ---- the wooden rails: six boards between the pockets, mitred through the corner pockets
  const corners = geom.pockets.filter(p => p.kind === 'corner'), sides = geom.pockets.filter(p => p.kind === 'side');
  const cornerAt = (sx, sz) => corners.find(p => Math.sign(p.x) === sx && Math.sign(p.z) === sz);
  const sideAt = sx => sides.find(p => Math.sign(p.x) === sx);
  const Ain = hw + d, Bin = hl + d;
  const c0 = corners[0], ca = Math.abs(c0.x), cb = Math.abs(c0.z), Rc = c0.r + lip, Ro = ox - ca;
  const s0 = sides[0], sa = Math.abs(s0.x), Rs = s0.r + lip;
  const D45 = Math.PI / 4;
  {
    const parts = [];
    const bev = 0.0045;
    const addPiece = (pts, alongX, offset) => {
      const g = slab(pts, hT - railThick, hT, bev, 4, 8);
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i), top = Math.abs(N.getY(i)) > 0.6;
        const along = alongX ? x : z, across = alongX ? z : x;
        U.setXY(i, along / 1.6 + offset, (top ? across : y * 1.3 + across * 0.2) / 0.25 + offset * 3.1);
      }
      parts.push(g);
    };
    // long rails (between a side pocket and a corner), in local coordinates a = |x|, b = |z|
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const thS = Math.acos((Ain - sa) / Rs);
      const bc = cb - Math.sqrt(Rc * Rc - (Ain - ca) ** 2), ph0 = Math.atan2(bc - cb, Ain - ca);
      const loc = [[ox, 0], ...arc(sa, 0, Rs, 0, thS), ...arc(ca, cb, Rc, ph0, D45),
        [ca + Ro * Math.cos(D45), cb + Ro * Math.sin(D45)], ...arc(ca, cb, Ro, D45, 0)];
      addPiece(loc.map(([a, b]) => [sx * a, sz * b]), false, rnd() * 3);
    }
    // short rails (between the two corners of one end)
    for (const sz of [-1, 1]) {
      const ph1 = Math.PI - Math.asin((Bin - cb) / Rc);
      const loc = [...arc(ca, cb, Rc, D45, ph1), ...arc(-ca, cb, Rc, Math.PI - ph1, 3 * D45),
        [-ca + Ro * Math.cos(3 * D45), cb + Ro * Math.sin(3 * D45)], ...arc(-ca, cb, Ro, 3 * D45, Math.PI / 2), ...arc(ca, cb, Ro, Math.PI / 2, D45)];
      addPiece(loc.map(([a, b]) => [a, sz * b]), true, rnd() * 3);
    }
    const m = new THREE.Mesh(keep(mergeGeometries(parts)), wood);
    m.name = 'rails';
    group.add(m);
  }

  // ---- castings: rounded metal caps over each pocket, wrapping the rail's edge
  {
    const parts = [], bev = 0.002, ov = 0.004, top = hT + 0.0045, bottom = hT - railThick - 0.004;
    const cap = 0.118;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const bc = cb - Math.sqrt(Rc * Rc - (Ain - ca) ** 2), ph0 = Math.atan2(bc - cb, Ain - ca);
      const ph1 = Math.PI - Math.asin((Bin - cb) / Rc);
      const loc = [[Ain + bev, bc], [Ain + bev, cb - cap], [ox + ov, cb - cap], ...arc(ca, cb, Ro + ov, 0, Math.PI / 2),
        [ca - cap, oz + ov], [ca - cap, Bin + bev], [ca + Rc * Math.cos(ph1), Bin + bev], ...arc(ca, cb, Rc, ph1, ph0).slice(1)];
      parts.push(slab(loc.map(([a, b]) => [sx * a, sz * b]), bottom, top, bev, 2, 6));
    }
    for (const sx of [-1, 1]) {
      const thS = Math.acos((Ain - sa) / Rs), yS = Rs * Math.sin(thS), capS = 0.1, Rb = Rs + 0.024;
      const bB = Math.sqrt(Rb * Rb - (ox + ov - sa) ** 2), aB = Math.atan2(bB, ox + ov - sa);
      const loc = [[Ain + bev, yS], [Ain + bev, capS], [ox + ov, capS], ...arc(sa, 0, Rb, aB, -aB), [ox + ov, -capS], [Ain + bev, -capS],
        [Ain + bev, -yS], ...arc(sa, 0, Rs, -thS, thS).slice(1, -1)];
      parts.push(slab(loc.map(([a, b]) => [sx * a, b]), bottom, top, bev, 2, 6));
    }
    const m = new THREE.Mesh(keep(mergeGeometries(parts)), metal);
    m.name = 'castings';
    group.add(m);
  }

  // ---- sights: pearl diamonds set in thin brass, along the rails
  {
    const railMid = d + table.cushion.railWidth * 0.5;
    const diamond = (x, z, alongX, l, w, y) => {
      const pts = alongX ? [[x - l, z], [x, z - w], [x + l, z], [x, z + w]] : [[x, z - l], [x + w, z], [x, z + l], [x - w, z]];
      const s = new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, -b)));
      const g = new THREE.ShapeGeometry(s); g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
      return g;
    };
    const P = [], Rm = [];
    const add = (x, z, alongX) => { P.push(diamond(x, z, alongX, 0.0085, 0.0042, hT + 0.0003)); Rm.push(diamond(x, z, alongX, 0.0102, 0.0056, hT + 0.00015)); };
    for (let i = 1; i <= 7; i++) {
      if (i === 4) continue;
      const z = -hl + (geom.length * i) / 8;
      add(hw + railMid, z, false); add(-hw - railMid, z, false);
    }
    for (let i = 1; i <= 3; i++) {
      const x = -hw + (geom.width * i) / 4;
      add(x, hl + railMid, true); add(x, -hl - railMid, true);
    }
    group.add(new THREE.Mesh(keep(mergeGeometries(P)), pearl), new THREE.Mesh(keep(mergeGeometries(Rm)), inlayRim));
  }

  // ---- the cabinet below the rails and four legs, fading into the dark
  {
    const inset = 0.016, top = hT - railThick + 0.001, low = -0.3, floor = table.floorY;
    const loc = [];
    for (const [sx, sz, a0] of [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, 3 * Math.PI / 2]]) {
      loc.push(...arc(sx * ca, sz * cb, Ro - inset, a0, a0 + Math.PI / 2, 0.01));
    }
    // walls only, no top: the pocket cups go down through it
    const box = sidesOnly(slab(loc, low, top, 0.006, 2, 8));
    const P = box.attributes.position, N = box.attributes.normal, U = box.attributes.uv;
    for (let i = 0; i < P.count; i++) U.setXY(i, (Math.abs(N.getX(i)) > Math.abs(N.getZ(i)) ? P.getZ(i) : P.getX(i)) / 0.8, P.getY(i) / 0.12);
    heightShade(box, top, low, 0.9, 0.18);
    const parts = [box];
    // a darker band under the rail, like a moulding
    const band = sidesOnly(slab(loc.map(([x, z]) => [x * 1.004, z * 1.002]), top - 0.022, top - 0.004, 0.003, 2, 8));
    heightShade(band, top, top - 0.03, 0.45, 0.35);
    parts.push(band);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const legX = sx * (ox - 0.13), legZ = sz * (oz - 0.15);
      const g = new THREE.CylinderGeometry(0.052, 0.04, low - floor, 4, 1, true);
      g.rotateY(Math.PI / 4); g.translate(legX, (low + floor) / 2, legZ);
      heightShade(g, low, low - 0.35, 0.22, 0.0);
      parts.push(g);
    }
    const m = new THREE.Mesh(keep(mergeGeometries(parts.map(g => { if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); return g; }))), body);
    m.name = 'cabinet';
    group.add(m);
  }

  // ---- a faint pool of lamp light on the floor, so the dark has depth (no floor detail)
  {
    const tex = cached('floor', () => radialTexture(256, [[0, 'rgba(8,6,4,1)'], [0.22, 'rgba(22,16,10,1)'], [0.42, 'rgba(12,9,6,1)'], [0.75, 'rgba(3,2,1,1)'], [1, 'rgba(0,0,0,1)']]));
    const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(7, 7)), keep(new THREE.MeshBasicMaterial({ map: tex, depthWrite: false })));
    m.rotation.x = -Math.PI / 2; m.position.y = table.floorY; m.renderOrder = -1;
    m.name = 'floor';
    group.add(m);
  }

  return {
    group,
    feltMaterials: [felt, cushionFelt],
    /** Change the cloth colour. */
    setFelt(hex) {
      const c = new THREE.Color(hex);
      feltColourTexture(feltFields, hex, feltCanvas); feltTex.needsUpdate = true;
      cushionFelt.color.copy(c);
      for (const m of [felt, cushionFelt]) if (m.sheenColor) m.sheenColor.copy(sheenOf(c));
    },
    dispose() { for (const x of disposables) x.dispose(); },
  };
}

// ---------------------------------------------------------------- balls

const sphereCache = new Map();

/**
 * One ball. id 0 is the cue ball.
 * @param {number} id
 * @param {number} radius
 * @param {{quality?: Quality, occlusion?: ReturnType<import('./occlusion.js').createOcclusion>}} [opts]
 * @returns {THREE.Mesh}
 */
export function buildBallModel(id, radius, opts = {}) {
  const q = opts.quality || QUALITY.high, occ = opts.occlusion;
  const key = radius + ':' + q.sphere.join('x');
  if (!sphereCache.has(key)) sphereCache.set(key, new THREE.SphereGeometry(radius, q.sphere[0], q.sphere[1]));
  const map = cached('ball' + id + ':' + q.ball, () => ballTexture(id, q.ball));
  map.anisotropy = q.anisotropy;
  const mat = q.physical
    ? new THREE.MeshPhysicalMaterial({ map, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.035, specularIntensity: 0.6 })
    : new THREE.MeshStandardMaterial({ map, roughness: 0.12 });
  if (occ) occ.patch(mat, { balls: q.ballShadowsOnBalls, cue: true, ambient: true, floor: true, below: true, self: id });
  const m = new THREE.Mesh(sphereCache.get(key), mat);
  m.name = 'ball' + id;
  return m;
}

// ---------------------------------------------------------------- the cue

/**
 * The cue. Its tip is at the group's origin and the butt lies along the group's +Z.
 * One turned piece with one painted picture: tip, ferrule, maple shaft, joint, forearm with points, wrap, sleeve, bumper.
 * @param {number} length
 * @param {{quality?: Quality}} [opts]
 * @returns {THREE.Group}
 */
export function buildCueModel(length, opts = {}) {
  const q = opts.quality || QUALITY.high;
  const L = length;
  const marks = [
    { name: 'ferrule', z: 0.012 }, { name: 'shaft', z: 0.034 }, { name: 'joint', z: L * 0.49 },
    { name: 'forearm', z: L * 0.49 + 0.024 }, { name: 'wrap', z: L * 0.71 }, { name: 'sleeve', z: L * 0.87 },
    { name: 'cap', z: L - 0.016 }, { name: 'bumper', z: L - 0.007 },
  ];
  const M = {}; for (const m of marks) M[m.name] = m.z;
  // the turned outline: [radius, distance from the tip]
  const prof = [
    [0, 0], [0.0035, 0.0003], [0.0058, 0.0012], [0.0062, 0.003], [0.0062, M.ferrule - 0.0005], [0.0064, M.ferrule],
    [0.0064, M.shaft], [0.0065, M.shaft + 0.0005], [0.0066, 0.3], [0.0086, M.joint - 0.15], [0.0105, M.joint],
    [0.0108, M.joint + 0.0006], [0.0108, M.forearm], [0.0124, M.wrap - 0.004], [0.0126, M.wrap],
    [0.0124, M.wrap + 0.0008], [0.0136, M.sleeve - 0.0008], [0.0139, M.sleeve], [0.0148, M.cap - 0.002],
    [0.0148, M.cap], [0.0146, M.bumper], [0.0128, M.bumper + 0.001], [0.0124, L - 0.002], [0.009, L - 0.0002], [0, L],
  ];
  const pts = prof.map(([r, z]) => new THREE.Vector2(r, z));
  const geo = new THREE.LatheGeometry(pts, q.lathe);
  geo.rotateX(Math.PI / 2);   // the lathe's Y (along the cue) becomes +Z
  const P = geo.attributes.position, U = geo.attributes.uv;
  for (let i = 0; i < P.count; i++) U.setY(i, 1 - P.getZ(i) / L);
  const tex = cached('cue' + q.cue + ':' + L, () => cueTextures(L, q.cue, marks));
  const mat = q.physical
    ? new THREE.MeshPhysicalMaterial({ map: tex.map, roughnessMap: tex.finish, metalnessMap: tex.finish, clearcoatMap: tex.finish, roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.12 })
    : new THREE.MeshStandardMaterial({ map: tex.map, roughnessMap: tex.finish, metalnessMap: tex.finish, roughness: 1, metalness: 1 });
  const g = new THREE.Group();
  const m = new THREE.Mesh(geo, mat);
  m.name = 'cue';
  g.add(m);
  g.userData.radiusAt = s => s < 0.3 ? 0.0066 : s < M.joint ? 0.0066 + (0.0105 - 0.0066) * (s - 0.3) / (M.joint - 0.3) : 0.0108 + (0.0148 - 0.0108) * Math.min(1, (s - M.joint) / (L - M.joint));
  g.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return g;
}
