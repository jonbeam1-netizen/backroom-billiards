// The rules' front door. Plain data in, plain data out: no DOM, no clock, no Math.random.
// step() advances the game by exactly one tick (1/60 s) and returns what happened.

import { buildTable } from './table.js';
import { createGame } from './setup.js';
import { getConst, simulateTick, allAtRest, strike } from './physics.js';
import { canPlaceCue, firstContact } from './contact.js';
import { hashState, cloneState } from './hash.js';
import { previewShot } from './preview.js';
import { applyMatchAction, recordShot, judgeShot, shooterTarget, ballsLeft } from './match.js';
import { applyNudge, applyNudgeSetting, canNudge } from './nudge.js';

export { buildTable, createGame, canPlaceCue, firstContact, previewShot, hashState, cloneState, shooterTarget, ballsLeft, canNudge };

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').GameEvent} GameEvent */
/** @typedef {import('./types.js').Action} Action */

/** Safety cap for runReplay's wait for the last shot to settle: 10 minutes of game time. */
const SETTLE_CAP_TICKS = 60 * 600;

/**
 * Advances the game by one tick, mutating `state` in place.
 * 'shoot' is taken only in phase 'aim'; 'place' only in phase 'place'. Other actions are ignored.
 * In a match (mode 'match') the rules of match.js apply: the 8-ball rules, and the referee's
 * events in the tick the balls settle.
 * 'nudge' (item 41, rules/nudge.js) in both modes: only while the nudge is on, a shot is in play and that
 * player's wait is over; everything it causes is part of the shot in play. 'nudgeSetting': practice only.
 * The actions of one tick are applied in the order given, before the balls move.
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
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a && a.type === 'nudge') applyNudge(state, data, /** @type {any} */ (a), events);
      else applyMatchAction(m, data, geo, k, a, events);
    }
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
  if (a.type === 'nudge') applyNudge(state, data, /** @type {any} */ (a), events);
  else if (a.type === 'nudgeSetting') applyNudgeSetting(state, /** @type {any} */ (a));
  else if (a.type === 'shoot' && state.phase === 'aim' && cue.where === 'table') {
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
 * then steps until the last shot has settled. Actions recorded on the same tick (for example a shot and a
 * nudge, or two players' nudges) are applied together in that one tick, in the recorded order.
 * The record's actions must be in tick order.
 * @param {{table:Object, physics:Object}} data
 * @param {{opts:{size?:string, seed?:number, mode?:'practice'|'match', foulRule?:string, noHitFoul?:boolean, nudge?:boolean, breaker?:number}, shots:{tick:number, action:Action}[]}} record
 * @returns {{hash:string, state:GameState}}
 */
export function runReplay(data, record) {
  const state = createGame(data, record.opts);
  const shots = record.shots || [];
  let i = 0;
  while (i < shots.length) {
    const t = shots[i].tick;
    while (state.tick < t) step(state, data, []);
    const acts = [];
    while (i < shots.length && shots[i].tick === t) { acts.push(shots[i].action); i++; }
    step(state, data, acts);
  }
  let n = 0;
  while (state.phase === 'rolling' && n < SETTLE_CAP_TICKS) { step(state, data, []); n++; }
  return { hash: hashState(state), state };
}
