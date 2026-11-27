// The nudge (HANDOFF item 41): a joke button that shoves the table a little, like a pinball table.
// Plain data in, plain data out. No randomness: the player chooses the way with W A S D (the input and view
// turn the key into one of the four table directions; the rules only check it is one of them).
//
// The setting lives in the state as `state.nudge`, an object that is there only while the nudge is on
// (practice: the table's own button, through the 'nudgeSetting' action; a match: the host's lobby setting,
// given to createGame as opts.nudge). A state without it (every game and saved match from before item 41)
// has the nudge off, and hashes exactly as before.
//
// Direction convention: the action's and the event's dirX, dirZ is the way the BALLS are kicked, relative to the
// table (one of +X, -X, +Z, -Z): the way the key points on the screen. Physically the table was shoved the other
// way and the balls stayed behind by inertia; the view jerks the table that other way (data/controls.json).

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').GameEvent} GameEvent */

/**
 * The nudge numbers from data/physics.json (with safe fallbacks if the data file lacks them).
 * @param {{physics:Object}} data
 * @returns {{kickSpeed:number, waitTicks:number}}
 */
export function nudgeConst(data) {
  const n = data.physics.nudge || {};
  return {
    kickSpeed: typeof n.kickSpeed === 'number' ? n.kickSpeed : 0.105,
    waitTicks: typeof n.waitTicks === 'number' ? Math.max(0, Math.floor(n.waitTicks)) : 120,
  };
}

/**
 * A fresh nudge record for a game with the nudge on: each player may nudge from tick 0.
 * @returns {import('./types.js').NudgeState}
 */
export function newNudge() {
  return { next: [0, 0] };
}

/**
 * True when (dx, dz) is exactly one of the four table directions +X, -X, +Z, -Z.
 * @param {*} dx @param {*} dz
 * @returns {boolean}
 */
export function isNudgeDir(dx, dz) {
  return (dx === 1 || dx === -1) && dz === 0 || (dz === 1 || dz === -1) && dx === 0;
}

/**
 * Whether player `by` may nudge now: the nudge is on, a shot is in play (phase 'rolling'), the player is
 * 0 or 1 (always 0 in practice), and that player's own wait is over.
 * @param {GameState} state @param {number} by
 * @returns {boolean}
 */
export function canNudge(state, by) {
  const n = /** @type {any} */ (state).nudge;
  if (!n || state.phase !== 'rolling') return false;
  if (by !== 0 && by !== 1) return false;
  if (state.mode !== 'match' && by !== 0) return false;
  return state.tick >= n.next[by];
}

/**
 * The 'nudge' action: if allowed and the direction is one of the four, every ball on the table gets a small
 * kick that way (moving or at rest, no spin), and that player's wait starts. Anything else is ignored and changes nothing.
 * @param {GameState} state @param {{physics:Object}} data
 * @param {{type:'nudge', by:number, dirX:number, dirZ:number}} a @param {GameEvent[]} events
 */
export function applyNudge(state, data, a, events) {
  const by = a.by === 1 ? 1 : a.by === 0 ? 0 : -1;
  if (!isNudgeDir(a.dirX, a.dirZ) || !canNudge(state, by)) return;
  const c = nudgeConst(data);
  const n = /** @type {any} */ (state).nudge;
  const dx = a.dirX, dz = a.dirZ;
  n.next[by] = state.tick + c.waitTicks;
  for (let j = 0; j < state.balls.length; j++) {
    const b = state.balls[j];
    if (b.where !== 'table') continue;
    b.vx += dx * c.kickSpeed;
    b.vz += dz * c.kickSpeed;
    b.moving = true;
  }
  events.push({ type: 'nudge', player: by, dirX: dx, dirZ: dz, speed: c.kickSpeed });
}

/**
 * The practice table's on/off button ('nudgeSetting' action). Practice only (a match keeps the host's setting).
 * Switching it off and on again starts the wait afresh.
 * @param {GameState} state @param {{type:'nudgeSetting', on:boolean}} a
 */
export function applyNudgeSetting(state, a) {
  if (state.mode === 'match') return;
  const s = /** @type {any} */ (state);
  if (a.on === true) { if (!s.nudge) s.nudge = newNudge(); }
  else if (a.on === false) delete s.nudge;
}
