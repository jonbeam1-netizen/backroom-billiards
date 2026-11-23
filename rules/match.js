// The 8-ball match: actions, what a shot did, and the referee's judgement once the balls stop.
// The owner's rules in words are at the bottom of types.js. Plain data only, no maths beyond comparisons.

import { makeRack, emptyShot, putCueInHand } from './setup.js';
import { strike } from './physics.js';
import { canPlaceCue } from './contact.js';

/** @typedef {import('./types.js').GameEvent} GameEvent */
/** @typedef {import('./types.js').TableGeometry} TableGeometry */
/** @typedef {import('./physics.js').PhysicsConst} PhysicsConst */

/**
 * The group of a numbered ball: 'solid' (1-7), 'stripe' (9-15), 'eight' (8) or 'cue' (0).
 * @param {number} id
 * @returns {string}
 */
function kindOf(id) {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id < 8 ? 'solid' : 'stripe';
}

/**
 * How many balls of a group are still on the table.
 * @param {Object} state @param {string} group 'solid' or 'stripe'
 * @returns {number}
 */
function countOnTable(state, group) {
  let n = 0;
  for (let i = 1; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (b.where === 'table' && kindOf(b.id) === group) n++;
  }
  return n;
}

/**
 * Balls of that player's group still on the table (7 while the table is open).
 * @param {Object} state  a match state
 * @param {number} player 0 or 1
 * @returns {number}
 */
export function ballsLeft(state, player) {
  const g = state.groups ? state.groups[player] : 'open';
  if (g !== 'solid' && g !== 'stripe') return 7;
  return countOnTable(state, g);
}

/**
 * What the player to shoot must hit first: 'open' (any ball but the 8), 'solid', 'stripe', or 'eight'
 * (their group is gone). An open table with no solids and no stripes left on it also gives 'eight'
 * (otherwise nobody could ever play a legal shot).
 * @param {Object} state  a match state
 * @returns {'open'|'solid'|'stripe'|'eight'}
 */
export function shooterTarget(state) {
  const g = state.groups[state.turn];
  if (g === 'solid' || g === 'stripe') return countOnTable(state, g) > 0 ? g : 'eight';
  if (countOnTable(state, 'solid') + countOnTable(state, 'stripe') > 0) return 'open';
  return 'eight';
}

/**
 * One action in a match. 'place' obeys placeBehindLine; 'call' only while the shooter is on the 8 in
 * phase 'aim'; 'shoot' only in phase 'aim', and on the 8 only once a pocket is called.
 * @param {Object} state @param {{table:Object, physics:Object}} data @param {TableGeometry} geo
 * @param {PhysicsConst} k @param {Object} a @param {GameEvent[]} events
 */
export function applyMatchAction(state, data, geo, k, a, events) {
  if (!a) return;
  const cue = state.balls[0];
  if (a.type === 'shoot') {
    if (state.phase !== 'aim' || cue.where !== 'table') return;
    const target = shooterTarget(state);
    if (target === 'eight' && state.calledPocket < 0) return;
    const shot = emptyShot();
    shot.target = target;
    state.shot = shot;
    strike(cue, a, geo, k, events);
    state.phase = 'rolling';
    state.shots += 1;
  } else if (a.type === 'place') {
    if (state.phase !== 'place' || !canPlaceCue(state, data, a.x, a.z)) return;
    cue.where = 'table'; cue.pocket = -1;
    cue.x = a.x; cue.y = k.R; cue.z = a.z;
    cue.vx = 0; cue.vy = 0; cue.vz = 0; cue.wx = 0; cue.wy = 0; cue.wz = 0;
    cue.moving = false;
    state.placeBehindLine = false;
    state.phase = 'aim';
  } else if (a.type === 'call') {
    if (state.phase !== 'aim' || shooterTarget(state) !== 'eight') return;
    const p = a.pocket;
    if (typeof p !== 'number' || p !== Math.floor(p) || p < 0 || p >= geo.pockets.length) return;
    state.calledPocket = p;
  }
}

/**
 * Notes into state.shot what the physics events of this tick did (in the order they happened).
 * @param {Object} state @param {GameEvent[]} events @param {number} from  first event of this tick's roll
 */
export function recordShot(state, events, from) {
  const sh = state.shot;
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'ballBall') {
      if (sh.firstHit < 0 && (e.ball === 0 || e.other === 0)) sh.firstHit = e.ball === 0 ? e.other : e.ball;
    } else if (e.type === 'cushion') {
      if (sh.firstHit >= 0) sh.cushionAfterHit = true;
    } else if (e.type === 'pocket') {
      if (sh.firstHit >= 0) sh.cushionAfterHit = true;
      if (e.ball === 0) sh.cuePotted = true;
      else { sh.potted.push(e.ball); sh.pottedPockets.push(e.pocket); }
    } else if (e.type === 'offTable') {
      if (e.ball === 0) sh.cueOff = true;
      else sh.off.push(e.ball);
    }
  }
}

/**
 * True when the list holds the value.
 * @param {number[]} list @param {number} v
 * @returns {boolean}
 */
function has(list, v) {
  for (let i = 0; i < list.length; i++) if (list[i] === v) return true;
  return false;
}

/**
 * The foul of the finished shot, or ''. When several happen, the first in this order is named:
 * scratch, cueOffTable, noHit, wrongBall, ballOffTable, noCushion.
 * @param {Object} sh  state.shot
 * @returns {string}
 */
export function shotFoul(sh) {
  if (sh.cuePotted) return 'scratch';
  if (sh.cueOff) return 'cueOffTable';
  if (sh.firstHit < 0) return 'noHit';
  const first = kindOf(sh.firstHit);
  if (sh.target === 'open') { if (first === 'eight') return 'wrongBall'; }
  else if (first !== sh.target) return 'wrongBall';
  if (sh.off.length > 0) return 'ballOffTable';
  if (!sh.cushionAfterHit) return 'noCushion';
  return '';
}

/**
 * Everything has stopped: judge the shot by the owner's rules, push the match events, set up the next shot.
 * Order: the 8 dropping on the break (rack again); the 8 dropping or leaving the table (win or loss);
 * fouls; groups; who shoots next.
 * @param {Object} state @param {{table:Object, physics:Object}} data @param {TableGeometry} geo
 * @param {PhysicsConst} k @param {GameEvent[]} events
 */
export function judgeShot(state, data, geo, k, events) {
  const sh = state.shot;
  const me = state.turn, other = 1 - me;
  const wasBreak = state.breakShot;
  const eightDown = has(sh.potted, 8), eightOff = has(sh.off, 8);

  // 1. The 8 dropping on the break: rack again, same breaker. Not a foul, whatever else happened.
  if (wasBreak && eightDown) {
    events.push({ type: 'rerack' });
    state.balls = makeRack(state, geo, k);
    putCueInHand(state.balls[0]);
    state.turn = state.breaker;
    state.breakShot = true;
    state.groups = ['open', 'open'];
    state.calledPocket = -1;
    state.lastFoul = '';
    state.placeBehindLine = true;
    state.shot = emptyShot();
    state.phase = 'place';
    return;
  }

  const foul = shotFoul(sh);

  // 2. The 8 is gone: the game ends.
  if (eightDown || eightOff) {
    let reason = '';
    if (eightOff) reason = 'eightOffTable';
    else if (sh.target !== 'eight') reason = 'eightEarly';
    else if (foul !== '') reason = 'eightOnFoul';
    else if (sh.pottedPockets[indexOf(sh.potted, 8)] !== state.calledPocket) reason = 'eightWrongPocket';
    else reason = 'eight';
    if (foul !== '') events.push({ type: 'foul', player: me, reason: foul });
    const winner = reason === 'eight' ? me : other;
    events.push({ type: 'gameOver', winner, reason });
    state.winner = winner;
    state.overReason = reason;
    state.lastFoul = foul;
    state.calledPocket = -1;
    state.breakShot = false;
    state.placeBehindLine = false;
    state.phase = 'over';
    return;
  }

  // 3. A foul: the other player has the cue ball in hand.
  if (foul !== '') {
    events.push({ type: 'foul', player: me, reason: foul });
    state.lastFoul = foul;
    state.turn = other;
    state.breakShot = false;
    state.calledPocket = -1;
    putCueInHand(state.balls[0]);
    state.placeBehindLine = state.settings.foulRule === 'behindLine';
    state.phase = 'place';
    events.push({ type: 'turn', player: other });
    return;
  }

  // 4. A clean shot. On an open table after the break, the first ball to drop decides the groups.
  state.lastFoul = '';
  if (!wasBreak && state.groups[me] === 'open' && sh.potted.length > 0) {
    const g = kindOf(sh.potted[0]);
    if (g === 'solid' || g === 'stripe') {
      state.groups[me] = g;
      state.groups[other] = g === 'solid' ? 'stripe' : 'solid';
      events.push({ type: 'groups', player: me, group: g });
    }
  }

  // 5. Who goes on: the break keeps the table for any ball sunk; later, a ball of your own group
  //    (on the open table, any ball but the 8; the 8 cannot be here, it ended the game above).
  let goesOn = false;
  for (let i = 0; i < sh.potted.length; i++) {
    const g = kindOf(sh.potted[i]);
    if (wasBreak || sh.target === 'open' || g === state.groups[me]) goesOn = true;
  }
  const next = goesOn ? me : other;
  state.turn = next;
  state.breakShot = false;
  state.calledPocket = -1;
  state.placeBehindLine = false;
  state.phase = 'aim';
  events.push({ type: 'turn', player: next });
}

/**
 * Index of a value in a list, or -1.
 * @param {number[]} list @param {number} v
 * @returns {number}
 */
function indexOf(list, v) {
  for (let i = 0; i < list.length; i++) if (list[i] === v) return i;
  return -1;
}
