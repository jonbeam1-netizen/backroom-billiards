// The look-ahead for the full aim help (HANDOFF item 40): plays the shot ahead on a copy of the table with the
// real rules (the same strike and the same ticks as the game) and records where the cue ball and the first ball
// it hits really go, spin, raised cue and power included. Read only: the real state is never touched (the copy is
// made with cloneState). No clock, no DOM, no Math.random: the same inputs always give the same lines.
// Self-contained on purpose so it can be copied to C# with the rest of the rules.

import { buildTable } from './table.js';
import { getConst, strike, simulateTick } from './physics.js';
import { cloneState } from './hash.js';

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').GameEvent} GameEvent */
/** @typedef {import('./types.js').ShootAction} ShootAction */
/** @typedef {import('./types.js').TableGeometry} TableGeometry */

/**
 * How far the look-ahead runs (data/controls.json, aimHelp.preview). Metres and ticks (60 a second).
 * @typedef {Object} PreviewLimits
 * @property {number} maxTicks         the whole look-ahead never runs longer than this
 * @property {number} cueAfterLength   metres of the cue ball's path kept after its first contact
 * @property {number} cueAfterTicks    and at most this many ticks after it
 * @property {number} targetLength     metres of the first-hit ball's path
 * @property {number} pointSpacing     the drawn lines keep a point only this far from the last one kept (the end always stays)
 */

/**
 * What the look-ahead found.
 * @typedef {Object} ShotPreview
 * @property {boolean} ok                         false when no shot can be played now (not aiming, no cue ball on the table)
 * @property {'ball'|'cushion'|'pocket'|'none'} kind   the cue ball's first contact
 * @property {number} x  @property {number} z      the cue ball's centre at the first contact (its start when kind is 'none')
 * @property {number} ballId                       the first ball hit, or -1
 * @property {number} contactTick                  the tick of the first contact (1 = the strike's own tick), or -1
 * @property {'cut'|'hit'|'rest'|'potted'|'off'|'cap'} cueEnd     why the cue ball's line ends
 * @property {'cut'|'hit'|'rest'|'potted'|'off'|'cap'|''} targetEnd  why the hit ball's line ends ('' when no ball is hit)
 * @property {number} ticks                        how many ticks were played ahead
 * @property {number[]} cueTicks                   the cue ball's centre x, y, z: the start, then after every tick while its line runs
 * @property {number[]} cueLine                    x, z pairs on the felt: from the cue ball's edge to the first contact (thinned)
 * @property {number[]} cueAfter                   x, z pairs: from the first contact on, cut at the limits (thinned)
 * @property {number[]} targetLine                 x, z pairs: the hit ball from its edge on, cut at the limits (thinned)
 */

/**
 * Plays `shot` ahead on a copy of `state` and records the cue ball's path and the first-hit ball's path.
 * @param {GameState} state   the real state (only read)
 * @param {{table:Object, physics:Object}} data
 * @param {ShootAction} shot  exactly the action the game would send if the shot were let go now
 * @param {PreviewLimits} limits
 * @returns {ShotPreview}
 */
export function previewShot(state, data, shot, limits) {
  const geo = buildTable(data, state.size);
  const k = getConst(data);
  const R = k.R;
  const cue0 = state.balls[0];
  /** @type {ShotPreview} */
  const out = { ok: false, kind: 'none', x: cue0.x, z: cue0.z, ballId: -1, contactTick: -1, cueEnd: 'cap', targetEnd: '', ticks: 0,
    cueTicks: [], cueLine: [], cueAfter: [], targetLine: [] };
  if (state.phase !== 'aim' || cue0.where !== 'table') return out;
  out.ok = true;

  const s = cloneState(state);
  const balls = s.balls;
  const cue = balls[0];
  /** @type {GameEvent[]} */
  const events = [];
  const prev = new Array(balls.length * 3);     // every ball's centre at the start of the tick
  const prevV = new Array(balls.length * 2);    // and its speed along the felt
  strike(cue, shot, geo, k, events);

  /** @type {number[]} */ const before = [cue.x, cue.z];        // x, z: start to first contact
  /** @type {number[]} */ const after = [];                     // x, z: first contact on
  /** @type {number[]} */ const target = [];                    // x, z: the hit ball
  out.cueTicks.push(cue.x, cue.y, cue.z);
  let cueStage = 0;            // 0 before the first contact, 1 after it, 2 done
  let targetStage = 0;         // 0 no ball hit, 1 running, 2 done
  let targetId = -1;
  let afterLen = 0, targetLen = 0;
  let firstEventTick = -1, firstOther = -1;

  const maxTicks = limits.maxTicks;
  for (let t = 1; t <= maxTicks; t++) {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      prev[i * 3] = b.x; prev[i * 3 + 1] = b.y; prev[i * 3 + 2] = b.z; prevV[i * 2] = b.vx; prevV[i * 2 + 1] = b.vz;
    }
    if (t > 1) events.length = 0;            // the strike's own events stay with the first tick
    simulateTick(s, geo, k, events);
    out.ticks = t;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const isCue = e.ball === 0 || (e.type === 'ballBall' && e.other === 0);
      if (isCue && cueStage === 0) {
        if (e.type === 'ballBall') {
          const other = e.ball === 0 ? /** @type {number} */ (e.other) : e.ball;
          // the hit ball was still at the start of the tick, so the contact point is halfway between the two centres
          const bx = prev[other * 3], bz = prev[other * 3 + 2];
          setContact(out, 'ball', 2 * e.x - bx, 2 * e.z - bz, other, t);
          before.push(out.x, out.z); after.push(out.x, out.z);
          targetId = other; targetStage = 1; target.push(bx, bz);
          firstEventTick = t; firstOther = other; cueStage = 1;
        } else if (e.type === 'cushion') {
          const c = cushionCentre(geo, R, e.x, e.y, e.z, prev[0], prev[1], prev[2], prevV[0], prevV[1]);
          setContact(out, 'cushion', c[0], c[1], -1, t);
          before.push(out.x, out.z); after.push(out.x, out.z);
          firstEventTick = t; firstOther = -1; cueStage = 1;
        } else if (e.type === 'pocket') {
          setContact(out, 'pocket', e.x, e.z, -1, t);
          before.push(out.x, out.z);
          cueStage = 2; out.cueEnd = 'potted';
        } else if (e.type === 'offTable') {
          before.push(e.x, e.z);
          cueStage = 2; out.cueEnd = 'off';
        }
      } else if (isCue && cueStage === 1) {
        if (e.type === 'ballBall' || e.type === 'cushion') {
          const other = e.type === 'ballBall' ? (e.ball === 0 ? /** @type {number} */ (e.other) : e.ball) : -1;
          if (t === firstEventTick && other === firstOther) continue;   // the same hit, seen again in the same tick
          if (e.type === 'cushion') {                                   // the line stops where the ball meets the cushion
            const c = cushionCentre(geo, R, e.x, e.y, e.z, prev[0], prev[1], prev[2], prevV[0], prevV[1]);
            after.push(c[0], c[1]);
          } else after.push(e.x, e.z);                                  // or reaches the ball it hits next
          cueStage = 2; out.cueEnd = 'hit';
        } else if (e.type === 'pocket' || e.type === 'offTable') {
          after.push(e.x, e.z);
          cueStage = 2; out.cueEnd = e.type === 'pocket' ? 'potted' : 'off';
        }
      }
      if (targetStage === 1 && !(t === firstEventTick && e.type === 'ballBall' && isCue && (e.ball === targetId || e.other === targetId))) {
        const isTarget = e.ball === targetId || (e.type === 'ballBall' && e.other === targetId);
        if (isTarget && e.type === 'cushion') {
          const j = targetId;
          const c = cushionCentre(geo, R, e.x, e.y, e.z, prev[j * 3], prev[j * 3 + 1], prev[j * 3 + 2], prevV[j * 2], prevV[j * 2 + 1]);
          target.push(c[0], c[1]); targetStage = 2; out.targetEnd = 'hit';
        } else if (isTarget && e.type === 'ballBall') {
          target.push(e.x, e.z); targetStage = 2; out.targetEnd = 'hit';
        } else if (isTarget && (e.type === 'pocket' || e.type === 'offTable')) {
          target.push(e.x, e.z); targetStage = 2; out.targetEnd = e.type === 'pocket' ? 'potted' : 'off';
        }
      }
    }

    // the cue ball's place after this tick
    if (cueStage < 2) {
      out.cueTicks.push(cue.x, cue.y, cue.z);
      if (cueStage === 0) before.push(cue.x, cue.z);
      else {
        afterLen += lastStep(after, cue.x, cue.z);
        after.push(cue.x, cue.z);
        if (afterLen >= limits.cueAfterLength || t - out.contactTick >= limits.cueAfterTicks) { cueStage = 2; out.cueEnd = 'cut'; }
      }
      if (cueStage < 2 && !cue.moving) { cueStage = 2; out.cueEnd = 'rest'; }
    }
    if (targetStage === 1) {
      const b = balls[targetId];
      targetLen += lastStep(target, b.x, b.z);
      target.push(b.x, b.z);
      if (targetLen >= limits.targetLength) { targetStage = 2; out.targetEnd = 'cut'; }
      else if (!b.moving) { targetStage = 2; out.targetEnd = 'rest'; }
    }
    if (cueStage === 2 && targetStage !== 1) break;
  }
  if (targetStage === 1) out.targetEnd = 'cap';

  out.cueLine = thin(trimStart(before, R), limits.pointSpacing);
  out.cueAfter = thin(cutLength(after, limits.cueAfterLength), limits.pointSpacing);
  out.targetLine = thin(cutLength(trimStart(target, R), limits.targetLength - R), limits.pointSpacing);
  return out;
}

/**
 * @param {ShotPreview} out @param {'ball'|'cushion'|'pocket'} kind @param {number} x @param {number} z
 * @param {number} ballId @param {number} tick
 */
function setContact(out, kind, x, z, ballId, tick) {
  out.kind = kind; out.x = x; out.z = z; out.ballId = ballId; out.contactTick = tick;
}

/**
 * Distance on the felt from the last point of a list of x, z pairs to (x, z); 0 for an empty list.
 * @param {number[]} pts @param {number} x @param {number} z
 * @returns {number}
 */
function lastStep(pts, x, z) {
  const n = pts.length;
  if (n < 2) return 0;
  const dx = x - pts[n - 2], dz = z - pts[n - 1];
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * The ball's centre when it touched a cushion edge at (qx, qy, qz). Along a straight piece: one radius out from
 * the edge, along the cushion's normal. At a rounded tip: where the ball's way at the start of the tick comes
 * within that distance of the tip (or, if it never does, toward where the ball was at the start of the tick).
 * @param {TableGeometry} geo @param {number} R
 * @param {number} qx @param {number} qy @param {number} qz   the touched point on the cushion edge (from the event)
 * @param {number} px @param {number} py @param {number} pz   the ball's centre at the start of the tick
 * @param {number} vx @param {number} vz                     the ball's speed along the felt at the start of the tick
 * @returns {number[]} [x, z]
 */
function cushionCentre(geo, R, qx, qy, qz, px, py, pz, vx, vz) {
  const dy = py - qy;
  const h = dy * dy < R * R ? Math.sqrt(R * R - dy * dy) : 0;
  let best = 1e9, nx = 0, nz = 0, tip = false;
  for (let i = 0; i < geo.cushions.length; i++) {
    const c = geo.cushions[i];
    const s = (qx - c.ax) * c.ux + (qz - c.az) * c.uz;
    const cs = s < 0 ? 0 : s > c.len ? c.len : s;
    const dx = qx - (c.ax + c.ux * cs), dz = qz - (c.az + c.uz * cs);
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      if (s > 1e-9 && s < c.len - 1e-9) { nx = c.nx; nz = c.nz; tip = false; }
      else {
        tip = true;
        const tx = px - qx, tz = pz - qz, tl = Math.sqrt(tx * tx + tz * tz);
        if (tl > 1e-12) { nx = tx / tl; nz = tz / tl; } else { nx = c.nx; nz = c.nz; }
      }
    }
  }
  if (tip) {
    // the ray from the start of the tick along the ball's way, against a circle of radius h round the tip
    const vl = Math.sqrt(vx * vx + vz * vz);
    if (vl > 1e-12) {
      const ux = vx / vl, uz = vz / vl, mx = qx - px, mz = qz - pz;
      const b = mx * ux + mz * uz, c = mx * mx + mz * mz - h * h, disc = b * b - c;
      if (disc >= 0) {
        const t = c <= 0 ? 0 : b - Math.sqrt(disc);
        if (t >= 0) return [px + ux * t, pz + uz * t];
      }
    }
  }
  return [qx + nx * h, qz + nz * h];
}

/**
 * The same line without its first `len` metres (the part under the ball).
 * @param {number[]} pts  x, z pairs @param {number} len
 * @returns {number[]}
 */
function trimStart(pts, len) {
  let left = len;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const d = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    if (d >= left) {
      const f = d > 0 ? left / d : 0;
      const outPts = [ax + (bx - ax) * f, az + (bz - az) * f];
      for (let j = i; j < pts.length; j++) outPts.push(pts[j]);
      return outPts;
    }
    left -= d;
  }
  return [];
}

/**
 * The same line cut off after `len` metres.
 * @param {number[]} pts  x, z pairs @param {number} len
 * @returns {number[]}
 */
function cutLength(pts, len) {
  if (pts.length < 2) return [];
  /** @type {number[]} */
  const outPts = [pts[0], pts[1]];
  let left = len;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const d = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
    if (d >= left) {
      const f = d > 0 ? left / d : 0;
      outPts.push(ax + (bx - ax) * f, az + (bz - az) * f);
      return outPts;
    }
    outPts.push(bx, bz);
    left -= d;
  }
  return outPts;
}

/**
 * Keeps a point only when it is at least `spacing` from the last one kept; the first and the last always stay.
 * @param {number[]} pts  x, z pairs @param {number} spacing
 * @returns {number[]}
 */
function thin(pts, spacing) {
  const n = pts.length;
  if (n <= 4) return pts.slice();
  /** @type {number[]} */
  const outPts = [pts[0], pts[1]];
  const s2 = spacing * spacing;
  for (let i = 2; i < n - 2; i += 2) {
    const dx = pts[i] - outPts[outPts.length - 2], dz = pts[i + 1] - outPts[outPts.length - 1];
    if (dx * dx + dz * dz >= s2) outPts.push(pts[i], pts[i + 1]);
  }
  const lx = pts[n - 2], lz = pts[n - 1];
  const dx = lx - outPts[outPts.length - 2], dz = lz - outPts[outPts.length - 1];
  if (dx * dx + dz * dz < 1e-14 && outPts.length > 2) { outPts[outPts.length - 2] = lx; outPts[outPts.length - 1] = lz; }
  else outPts.push(lx, lz);
  return outPts;
}
