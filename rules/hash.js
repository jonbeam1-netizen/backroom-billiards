// Copying and fingerprinting a game state, for replays and the online check.

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').Ball} Ball */

const BALL_NUMBERS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz', 'qx', 'qy', 'qz', 'qw'];

/**
 * A deep copy of the state (plain data only).
 * @param {GameState} state
 * @returns {GameState}
 */
export function cloneState(state) {
  const balls = [];
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    balls.push({
      id: b.id, kind: b.kind, where: b.where, pocket: b.pocket,
      x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, wx: b.wx, wy: b.wy, wz: b.wz,
      qx: b.qx, qy: b.qy, qz: b.qz, qw: b.qw, moving: b.moving,
    });
  }
  const out = { tick: state.tick, mode: state.mode, size: state.size, seed: state.seed, phase: state.phase, balls, shots: state.shots };
  if (state.mode === 'match') {
    const s = /** @type {any} */ (state), o = /** @type {any} */ (out);
    o.settings = { foulRule: s.settings.foulRule };
    o.turn = s.turn;
    o.breaker = s.breaker;
    o.breakShot = s.breakShot;
    o.groups = [s.groups[0], s.groups[1]];
    o.calledPocket = s.calledPocket;
    o.placeBehindLine = s.placeBehindLine;
    o.winner = s.winner;
    o.overReason = s.overReason;
    o.lastFoul = s.lastFoul;
    const sh = s.shot;
    o.shot = {
      firstHit: sh.firstHit, cushionAfterHit: sh.cushionAfterHit,
      potted: sh.potted.slice(), pottedPockets: sh.pottedPockets.slice(), off: sh.off.slice(),
      cuePotted: sh.cuePotted, cueOff: sh.cueOff, target: sh.target,
    };
  }
  return out;
}

/**
 * Fingerprint of the state: two FNV-1a 32-bit hashes over every number's 8 bytes (bit for bit)
 * and every string's characters, in a fixed order. 16 hex characters.
 * @param {GameState} state
 * @returns {string}
 */
export function hashState(state) {
  const buf = new DataView(new ArrayBuffer(8));
  let h1 = 0x811c9dc5 | 0, h2 = 0x050c5d1f | 0;
  /** @param {number} byte */
  function addByte(byte) {
    h1 = Math.imul(h1 ^ byte, 0x01000193);
    h2 = Math.imul(h2 ^ byte, 0x01000193) ^ (h1 >>> 7);
  }
  /** @param {number} n */
  function addNumber(n) {
    buf.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) addByte(buf.getUint8(i));
  }
  /** @param {string} s */
  function addString(s) {
    addNumber(s.length);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); addByte(c & 255); addByte(c >>> 8); }
  }
  /** @param {number[]} list */
  function addList(list) {
    addNumber(list.length);
    for (let i = 0; i < list.length; i++) addNumber(list[i]);
  }
  addNumber(state.tick);
  addString(state.mode);
  addString(String(state.size));
  addNumber(state.seed);
  addString(state.phase);
  addNumber(state.shots);
  addNumber(state.balls.length);
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    addNumber(b.id);
    addString(b.kind);
    addString(b.where);
    addNumber(b.pocket);
    for (let j = 0; j < BALL_NUMBERS.length; j++) addNumber(b[BALL_NUMBERS[j]]);
    addNumber(b.moving ? 1 : 0);
  }
  if (state.mode === 'match') {
    // The match fields, only in a match so a practice hash is the same as before matches existed.
    const s = /** @type {any} */ (state);
    addString(s.settings.foulRule);
    addNumber(s.turn);
    addNumber(s.breaker);
    addNumber(s.breakShot ? 1 : 0);
    addNumber(s.groups.length);
    for (let i = 0; i < s.groups.length; i++) addString(s.groups[i]);
    addNumber(s.calledPocket);
    addNumber(s.placeBehindLine ? 1 : 0);
    addNumber(s.winner);
    addString(s.overReason);
    addString(s.lastFoul);
    const sh = s.shot;
    addNumber(sh.firstHit);
    addNumber(sh.cushionAfterHit ? 1 : 0);
    addList(sh.potted);
    addList(sh.pottedPockets);
    addList(sh.off);
    addNumber(sh.cuePotted ? 1 : 0);
    addNumber(sh.cueOff ? 1 : 0);
    addString(sh.target);
  }
  return hex(h1) + hex(h2);
}

/**
 * @param {number} n
 * @returns {string} 8 hex characters
 */
function hex(n) {
  return ('0000000' + (n >>> 0).toString(16)).slice(-8);
}
