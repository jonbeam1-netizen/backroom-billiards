// Plain-geometry questions about the table: where can the cue ball go down, and what does a
// level centre-hit cue ball meet first (for the aim-help line). Read only; never changes the state.

import { buildTable } from './table.js';

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').Contact} Contact */

const FAR = 1e9;

/**
 * Can the cue ball be put down at (x, z)? Inside the cushions, not touching a ball, not over a pocket.
 * In a match with placeBehindLine set, the cue ball's centre must also be on or behind the line (z >= lineZ).
 * @param {GameState} state @param {{table:Object, physics:Object}} data @param {number} x @param {number} z
 * @returns {boolean}
 */
export function canPlaceCue(state, data, x, z) {
  if (typeof x !== 'number' || typeof z !== 'number' || x !== x || z !== z) return false;
  const geo = buildTable(data, state.size);
  const R = geo.ballRadius;
  if (Math.abs(x) > geo.halfW - R || Math.abs(z) > geo.halfL - R) return false;
  if (state.mode === 'match' && /** @type {any} */ (state).placeBehindLine && z < geo.lineZ) return false;
  for (let i = 0; i < geo.pockets.length; i++) {
    const p = geo.pockets[i];
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < p.r * p.r) return false;
  }
  for (let i = 1; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (b.where !== 'table') continue;
    const dx = x - b.x, dz = z - b.z;
    if (dx * dx + dz * dz < 4 * R * R) return false;
  }
  return true;
}

/**
 * Distance along a ray (from px,pz in unit direction dx,dz) to where it enters a circle, or FAR.
 * @param {number} px @param {number} pz @param {number} dx @param {number} dz
 * @param {number} cx @param {number} cz @param {number} r
 * @returns {number}
 */
function rayCircle(px, pz, dx, dz, cx, cz, r) {
  const mx = cx - px, mz = cz - pz;
  const b = mx * dx + mz * dz;
  const c = mx * mx + mz * mz - r * r;
  if (c < 0) return b > 0 ? 0 : FAR;        // already inside: counts only when moving inward
  if (b <= 0) return FAR;
  const disc = b * b - c;
  if (disc < 0) return FAR;
  return b - Math.sqrt(disc);
}

/**
 * What a level, centre-hit cue ball rolling in direction (dirX, dirZ) meets first.
 * @param {GameState} state @param {{table:Object, physics:Object}} data @param {number} dirX @param {number} dirZ
 * @returns {Contact}
 */
export function firstContact(state, data, dirX, dirZ) {
  const geo = buildTable(data, state.size);
  const R = geo.ballRadius;
  const cue = state.balls[0];
  /** @type {Contact} */
  const none = { kind: 'none', x: cue.x, z: cue.z, ballId: -1, targetDirX: 0, targetDirZ: 0, cueDirX: 0, cueDirZ: 0 };
  const dl = Math.sqrt(dirX * dirX + dirZ * dirZ);
  if (cue.where !== 'table' || !(dl > 1e-12)) return none;
  const dx = dirX / dl, dz = dirZ / dl;
  const px = cue.x, pz = cue.z;

  let best = FAR, kind = 'none', ballId = -1, nx = 0, nz = 0;

  // Balls: the cue ball's centre meets a circle of radius 2R around each ball.
  for (let i = 1; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (b.where !== 'table') continue;
    const t = rayCircle(px, pz, dx, dz, b.x, b.z, 2 * R);
    if (t < best) { best = t; kind = 'ball'; ballId = i; }
  }

  // Cushion pieces: a capsule of radius noseReach around each piece (rounded tips).
  const rc = geo.noseReach;
  for (let i = 0; i < geo.cushions.length; i++) {
    const c = geo.cushions[i];
    const dn = dx * c.nx + dz * c.nz;
    if (dn < 0) {
      const off = (px - c.ax) * c.nx + (pz - c.az) * c.nz;   // height above the face line
      const t = (rc - off) / dn;                                // where the offset face is reached
      if (t >= 0 && t < best) {
        const hx = px + dx * t, hz = pz + dz * t;
        const s = (hx - c.ax) * c.ux + (hz - c.az) * c.uz;
        if (s >= 0 && s <= c.len) { best = t; kind = 'cushion'; ballId = -1; nx = c.nx; nz = c.nz; }
      }
    }
    const ends = [c.ax, c.az, c.bx, c.bz];
    for (let e = 0; e < 2; e++) {
      const ex = ends[e * 2], ez = ends[e * 2 + 1];
      const t = rayCircle(px, pz, dx, dz, ex, ez, rc);
      if (t < best) {
        const hx = px + dx * t, hz = pz + dz * t;
        const l = Math.sqrt((hx - ex) * (hx - ex) + (hz - ez) * (hz - ez));
        best = t; kind = 'cushion'; ballId = -1; nx = (hx - ex) / l; nz = (hz - ez) / l;
      }
    }
  }

  // Pocket holes: the centre crosses into the hole.
  for (let i = 0; i < geo.pockets.length; i++) {
    const p = geo.pockets[i];
    const t = rayCircle(px, pz, dx, dz, p.x, p.z, p.r);
    if (t < best) { best = t; kind = 'pocket'; ballId = -1; }
  }

  if (kind === 'none') return none;
  const hx = px + dx * best, hz = pz + dz * best;
  /** @type {Contact} */
  const out = { kind: /** @type {any} */ (kind), x: hx, z: hz, ballId, targetDirX: 0, targetDirZ: 0, cueDirX: dx, cueDirZ: dz };
  if (kind === 'ball') {
    const b = state.balls[ballId];
    let tx = b.x - hx, tz = b.z - hz;
    const tl = Math.sqrt(tx * tx + tz * tz);
    tx /= tl; tz /= tl;
    out.targetDirX = tx; out.targetDirZ = tz;
    const along = dx * tx + dz * tz;
    let cx = dx - along * tx, cz = dz - along * tz;
    const cl = Math.sqrt(cx * cx + cz * cz);
    if (cl > 1e-9) { cx /= cl; cz /= cl; } else { cx = 0; cz = 0; }
    out.cueDirX = cx; out.cueDirZ = cz;
  } else if (kind === 'cushion') {
    const dn = dx * nx + dz * nz;
    out.cueDirX = dx - 2 * dn * nx; out.cueDirZ = dz - 2 * dn * nz;
  }
  return out;
}
