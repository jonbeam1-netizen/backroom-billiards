// Builds the table's hit shapes from data/table.json for one size. No trig: only sqrt.
//
// Pocket order (index into TableGeometry.pockets):
//   0 rack end, left (-X, -Z)    1 rack end, right (+X, -Z)
//   2 side, left (-X, Z 0)       3 side, right (+X, Z 0)
//   4 break end, left (-X, +Z)   5 break end, right (+X, +Z)
// "Left" and "right" as seen standing at the break end looking down the table.

/** @typedef {import('./types.js').TableGeometry} TableGeometry */

/**
 * One straight cushion piece, with extra fields the rules use.
 * @typedef {Object} CushionPiece
 * @property {number} ax @property {number} az @property {number} bx @property {number} bz
 * @property {number} nx @property {number} nz   unit normal into the playing area
 * @property {number} ux @property {number} uz   unit direction from a to b
 * @property {number} len
 * @property {'nose'|'jaw'} kind
 */

/** Built tables, per table data object and size. The result depends only on the data, so caching cannot change results. */
const cache = new WeakMap();

/**
 * Builds the table for one size.
 * @param {Object} data  either the GameData ({table, physics}) or data/table.json itself
 * @param {string} size  '7', '8' or '9'
 * @returns {TableGeometry}
 */
export function buildTable(data, size) {
  const t = data.table ? data.table : data;
  let bySize = cache.get(t);
  if (!bySize) { bySize = {}; cache.set(t, bySize); }
  const key = String(size);
  if (bySize[key]) return bySize[key];
  const geo = makeTable(t, key);
  bySize[key] = geo;
  return geo;
}

/**
 * @param {number} ax @param {number} az @param {number} bx @param {number} bz
 * @param {number} towardX @param {number} towardZ  a point on the side the normal must face
 * @param {'nose'|'jaw'} kind
 * @returns {CushionPiece}
 */
function makePiece(ax, az, bx, bz, towardX, towardZ, kind) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  const ux = dx / len, uz = dz / len;
  let nx = -uz, nz = ux;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  if (nx * (towardX - mx) + nz * (towardZ - mz) < 0) { nx = -nx; nz = -nz; }
  return { ax, az, bx, bz, nx, nz, ux, uz, len, kind };
}

/**
 * @param {Object} t     data/table.json
 * @param {string} size
 * @returns {TableGeometry}
 */
function makeTable(t, size) {
  const dims = t.sizes[size];
  if (!dims) throw new Error('table.json has no size ' + size);
  const length = dims.length, width = dims.width;
  const halfL = length / 2, halfW = width / 2;
  const p = t.pockets, c = t.cushion;
  const depth = c.depth;
  const ct = p.cornerMouth / Math.sqrt(2);        // corner tip distance from the corner point, along each rail
  const sm = p.sideMouth / 2;
  const cornerOut = (p.cornerShelf + p.cornerHoleRadius) / Math.sqrt(2);  // per axis, along the diagonal
  /** @type {CushionPiece[]} */
  const cushions = [];
  /** @type {{x:number, z:number, r:number, kind:'corner'|'side', quad:number[]}[]} */
  const pockets = [];

  /** @param {number} sx @param {number} sz */
  function corner(sx, sz) {
    const t1x = sx * halfW, t1z = sz * (halfL - ct);                  // tip on the long rail
    const t2x = sx * (halfW - ct), t2z = sz * halfL;                  // tip on the short rail
    const j1x = sx * (halfW + depth), j1z = sz * (halfL - ct + p.cornerJawRun);
    const j2x = sx * (halfW - ct + p.cornerJawRun), j2z = sz * (halfL + depth);
    const hx = sx * (halfW - ct / 2) + sx * cornerOut;
    const hz = sz * (halfL - ct / 2) + sz * cornerOut;
    cushions.push(makePiece(t1x, t1z, j1x, j1z, hx, hz, 'jaw'));
    cushions.push(makePiece(t2x, t2z, j2x, j2z, hx, hz, 'jaw'));
    pockets.push({ x: hx, z: hz, r: p.cornerHoleRadius, kind: 'corner', quad: [t1x, t1z, j1x, j1z, j2x, j2z, t2x, t2z] });
  }
  /** @param {number} sx */
  function side(sx) {
    const tx = sx * halfW;
    const jx = sx * (halfW + depth), jz = sm - p.sideJawRun;
    const hx = sx * (halfW + p.sideShelf + p.sideHoleRadius);
    cushions.push(makePiece(tx, sm, jx, jz, hx, 0, 'jaw'));
    cushions.push(makePiece(tx, -sm, jx, -jz, hx, 0, 'jaw'));
    pockets.push({ x: hx, z: 0, r: p.sideHoleRadius, kind: 'side', quad: [tx, sm, jx, jz, jx, -jz, tx, -sm] });
  }

  corner(-1, -1); corner(1, -1); side(-1); side(1); corner(-1, 1); corner(1, 1);

  // Noses: two on each long rail (split by the side pocket), one on each short rail.
  for (const sx of [-1, 1]) {
    cushions.push(makePiece(sx * halfW, -(halfL - ct), sx * halfW, -sm, 0, 0, 'nose'));
    cushions.push(makePiece(sx * halfW, sm, sx * halfW, halfL - ct, 0, 0, 'nose'));
  }
  for (const sz of [-1, 1]) {
    cushions.push(makePiece(-(halfW - ct), sz * halfL, halfW - ct, sz * halfL, 0, 0, 'nose'));
  }

  const R = t.ball.radius;
  const lift = c.noseHeight - R;
  return {
    size, length, width, halfL, halfW,
    cushions, pockets,
    lineZ: t.spots.lineZ * length,
    rackX: 0,
    rackZ: -t.spots.rackZ * length,
    outerHalfL: halfL + depth + c.railWidth,
    outerHalfW: halfW + depth + c.railWidth,
    // Extra fields (not in types.js) the rules and view may use:
    ballRadius: R,
    noseHeight: c.noseHeight,
    railTopHeight: c.railTopHeight,
    floorY: t.floorY,
    noseReach: Math.sqrt(R * R - lift * lift),   // flat distance from a resting ball's centre to the nose line when touching
  };
}
