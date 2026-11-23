// The rules' front door. Plain data in, plain data out: no DOM, no clock, no Math.random.
// step() advances the game by exactly one tick (1/60 s) and returns what happened.

import { buildTable } from './table.js';
import { createGame } from './setup.js';
import { getConst, simulateTick, allAtRest, strike } from './physics.js';
import { canPlaceCue, firstContact } from './contact.js';
import { hashState, cloneState } from './hash.js';
import { applyMatchAction, recordShot, judgeShot, shooterTarget, ballsLeft } from './match.js';

export { buildTable, createGame, canPlaceCue, firstContact, hashState, cloneState, shooterTarget, ballsLeft };

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').GameEvent} GameEvent */
/** @typedef {import('./types.js').Action} Action */

/** Safety cap for runReplay's wait for the last shot to settle: 10 minutes of game time. */
const SETTLE_CAP_TICKS = 60 * 600;

/**
 * Advances the game by one tick, mutating `state` in place.
 * 'shoot' is taken only in phase 'aim'; 'place' only in phase 'place'. Other actions are ignored.
 * In a match (mode 'match') the rules of match.js apply: 'call', the 8-ball rules, and the referee's
 * events in the tick the balls settle.
 * @param {GameState} state
 * @param {{table:Object, physics:Object}} data
 * @param {Action[]} actions  what the players did on this tick (may be empty)
 * @returns {GameEvent[]}
 */
export function step(state, data, actions) {
  const geo = buildTable(data, state.size);
  const k = getConst(data);
  /** @type {GameEvent[]} */
  const events = [];
  const list = actions || [];
  if (state.mode === 'match') {
    const m = /** @type {any} */ (state);
    for (let i = 0; i < list.length; i++) applyMatchAction(m, data, geo, k, list[i], events);
    if (state.phase === 'rolling') {
      const from = events.length;
      simulateTick(state, geo, k, events);
      recordShot(m, events, from);
      if (allAtRest(state)) {
        events.push({ type: 'settled' });
        judgeShot(m, data, geo, k, events);
      }
    }
    state.tick += 1;
    return events;
  }
  for (let i = 0; i < list.length; i++) applyAction(state, data, geo, k, list[i], events);
  if (state.phase === 'rolling') {
    simulateTick(state, geo, k, events);
    if (allAtRest(state)) {
      events.push({ type: 'settled' });
      const cue = state.balls[0];
      state.phase = cue.where === 'table' ? 'aim' : 'place';
    }
  }
  state.tick += 1;
  return events;
}

/**
 * @param {GameState} state @param {{table:Object, physics:Object}} data
 * @param {import('./types.js').TableGeometry} geo @param {import('./physics.js').PhysicsConst} k
 * @param {Action} a @param {GameEvent[]} events
 */
function applyAction(state, data, geo, k, a, events) {
  if (!a) return;
  const cue = state.balls[0];
  if (a.type === 'shoot' && state.phase === 'aim' && cue.where === 'table') {
    strike(cue, a, geo, k, events);
    state.phase = 'rolling';
    state.shots += 1;
  } else if (a.type === 'place' && state.phase === 'place' && canPlaceCue(state, data, a.x, a.z)) {
    cue.where = 'table'; cue.pocket = -1;
    cue.x = a.x; cue.y = k.R; cue.z = a.z;
    cue.vx = 0; cue.vy = 0; cue.vz = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
    cue.moving = false;
    state.phase = 'aim';
  }
}

/**
 * Plays a recorded game from scratch: makes the game, applies each action on its tick,
 * then steps until the last shot has settled.
 * @param {{table:Object, physics:Object}} data
 * @param {{opts:{size?:string, seed?:number, mode?:'practice'|'match', foulRule?:string, noHitFoul?:boolean, breaker?:number}, shots:{tick:number, action:Action}[]}} record
 * @returns {{hash:string, state:GameState}}
 */
export function runReplay(data, record) {
  const state = createGame(data, record.opts);
  const shots = record.shots || [];
  for (let i = 0; i < shots.length; i++) {
    while (state.tick < shots[i].tick) step(state, data, []);
    step(state, data, [shots[i].action]);
  }
  let n = 0;
  while (state.phase === 'rolling' && n < SETTLE_CAP_TICKS) { step(state, data, []); n++; }
  return { hash: hashState(state), state };
}
