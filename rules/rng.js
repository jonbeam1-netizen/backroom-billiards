// The one small seeded generator (build rule 5). Its whole memory is one 32-bit number,
// kept in state.seed, so a state can be copied, sent and replayed exactly.

/**
 * Next value from mulberry32.
 * @param {number} seed  current generator value (32-bit integer)
 * @returns {{value:number, seed:number}}  value in [0, 1) and the new generator value
 */
export function nextRandom(seed) {
  const a = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, seed: a };
}

/**
 * Draws one value from the state's generator and stores the new generator value.
 * @param {{seed:number}} state
 * @returns {number} in [0, 1)
 */
export function random(state) {
  const r = nextRandom(state.seed);
  state.seed = r.seed;
  return r.value;
}
