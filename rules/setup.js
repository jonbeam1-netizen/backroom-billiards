// A new game: the 8-ball rack and the cue ball on the line. No trig.

import { buildTable } from './table.js';
import { getConst } from './physics.js';
import { random } from './rng.js';

/** @typedef {import('./types.js').Ball} Ball */
/** @typedef {import('./types.js').GameState} GameState */

/**
 * A ball at rest on the felt, facing the default way.
 * @param {number} id @param {number} x @param {number} y @param {number} z
 * @returns {Ball}
 */
export function makeBall(id, x, y, z) {
  /** @type {'cue'|'solid'|'stripe'|'eight'} */
  let kind = 'solid';
  if (id === 0) kind = 'cue'; else if (id === 8) kind = 'eight'; else if (id > 8) kind = 'stripe';
  return {
    id, kind, where: 'table', pocket: -1,
    x, y, z, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    moving: false,
  };
}

/**
 * Makes a new game: standard 8-ball triangle, front ball on the rack spot, apex toward the break end,
 * 8 in the middle, one solid and one stripe in the back corners, the rest placed by the seeded generator.
 * Practice: the cue ball sits on the head spot, phase 'aim'.
 * Match (opts.mode 'match'): the extra MatchState fields; the breaker (opts.breaker, or a coin flip from the
 * seeded generator, drawn after the rack) has the cue ball in hand behind the line.
 * @param {{table:Object, physics:Object}} data
 * @param {{size?:string, seed?:number, mode?:'practice'|'match', foulRule?:'anywhere'|'behindLine', noHitFoul?:boolean, breaker?:number}} opts
 * @returns {GameState}
 */
export function createGame(data, opts) {
  const o = opts || {};
  const size = o.size ? String(o.size) : String(data.table.defaultSize);
  const geo = buildTable(data, size);
  const k = getConst(data);
  /** @type {GameState} */
  const state = {
    tick: 0, mode: 'practice', size,
    seed: (typeof o.seed === 'number' ? o.seed : 1) | 0,
    phase: 'aim', balls: [], shots: 0,
  };
  state.balls = makeRack(state, geo, k);
  if (o.mode === 'match') setUpMatch(state, o);
  return state;
}

/**
 * The extra fields of a match, and the cue ball in hand for the breaker.
 * @param {Object} state  a fresh GameState (mutated into a MatchState)
 * @param {{foulRule?:string, noHitFoul?:boolean, breaker?:number}} o
 */
function setUpMatch(state, o) {
  const s = /** @type {any} */ (state);
  s.mode = 'match';
  s.settings = { foulRule: o.foulRule === 'behindLine' ? 'behindLine' : 'anywhere', noHitFoul: o.noHitFoul === true };
  let breaker = 0;
  if (o.breaker === 0 || o.breaker === 1) breaker = o.breaker;
  else breaker = random(state) < 0.5 ? 0 : 1;
  s.breaker = breaker;
  s.turn = breaker;
  s.breakShot = true;
  s.groups = ['open', 'open'];
  s.calledPocket = -1;
  s.placeBehindLine = true;
  s.winner = -1;
  s.overReason = '';
  s.lastFoul = '';
  s.shot = emptyShot();
  s.phase = 'place';
  putCueInHand(state.balls[0]);
}

/**
 * What a shot has done so far, before it starts. `target` is extra: what the shooter had to hit first
 * when the shot was played; `pottedPockets` is extra: the pocket of each ball in `potted`.
 * @returns {{firstHit:number, cushionAfterHit:boolean, potted:number[], pottedPockets:number[], off:number[], cuePotted:boolean, cueOff:boolean, target:string}}
 */
export function emptyShot() {
  return { firstHit: -1, cushionAfterHit: false, potted: [], pottedPockets: [], off: [], cuePotted: false, cueOff: false, target: '' };
}

/**
 * Takes the cue ball off the table into the player's hand. Where it is stays as a hint for the view.
 * A ball that dropped keeps its pocket; one taken up from the table counts as 'potted' with pocket -1.
 * @param {Ball} cue
 */
export function putCueInHand(cue) {
  if (cue.where === 'table') { cue.where = 'potted'; cue.pocket = -1; }
  cue.vx = 0; cue.vy = 0; cue.vz = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
  cue.moving = false;
}

/**
 * All 16 balls for a new rack: the triangle as described at createGame, the cue ball on the head spot.
 * Draws from the state's seeded generator.
 * @param {{seed:number}} state
 * @param {import('./types.js').TableGeometry} geo
 * @param {import('./physics.js').PhysicsConst} k
 * @returns {Ball[]}
 */
export function makeRack(state, geo, k) {
  const R = k.R;
  // Slots of the triangle: row i (0 = apex at the front) has i + 1 balls.
  const slots = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j <= i; j++) slots.push([i, j]);
  const EIGHT = 4, BACK_LEFT = 10, BACK_RIGHT = 14;   // indexes into slots
  /** @type {number[]} ball id per slot */
  const order = [];
  for (let s = 0; s < 15; s++) order.push(0);
  order[EIGHT] = 8;

  const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
  const solid = solids.splice(Math.floor(random(state) * solids.length), 1)[0];
  const stripe = stripes.splice(Math.floor(random(state) * stripes.length), 1)[0];
  if (random(state) < 0.5) { order[BACK_LEFT] = solid; order[BACK_RIGHT] = stripe; }
  else { order[BACK_LEFT] = stripe; order[BACK_RIGHT] = solid; }
  const rest = solids.concat(stripes);
  for (let i = rest.length - 1; i > 0; i--) {          // seeded Fisher-Yates shuffle
    const j = Math.floor(random(state) * (i + 1));
    const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp;
  }
  let next = 0;
  for (let s = 0; s < 15; s++) if (order[s] === 0) order[s] = rest[next++];

  const balls = [];
  for (let id = 0; id < 16; id++) balls.push(makeBall(id, 0, R, 0));
  balls[0].z = geo.lineZ;

  const step = 2 * R + k.rackGap;
  const rowStep = step * Math.sqrt(3) / 2;
  for (let s = 0; s < 15; s++) {
    const i = slots[s][0], j = slots[s][1];
    const b = balls[order[s]];
    b.x = geo.rackX + (j - i / 2) * step + (random(state) * 2 - 1) * k.rackJitter;
    b.z = geo.rackZ - i * rowStep + (random(state) * 2 - 1) * k.rackJitter;
  }
  return balls;
}
