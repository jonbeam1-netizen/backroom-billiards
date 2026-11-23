// Every message the two PCs send each other, in this one file (build rule 10).
// Messages are plain objects with a `type` and are sent as JSON through PeerJS.
// The host is player 0, the friend (guest) is player 1.
//
// Who sends what:
//   connection (net/net.js):  hello, welcome, refuse, ping, bye
//   lobby (online.js):        lobby, start, resume
//   the table (practice.js):  act, aim, check, needState, state, rematch (and start again for a rematch)

/** Raised when a message changes shape; both sides must have the same one (the play-test number is checked too). */
export const PROTOCOL = 1;

/** Join codes: 4 characters, no look-alikes (no I, L, O, 0, 1). */
export const CODE_LENGTH = 4;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** The PeerJS id of the host is this prefix plus the code in lower case. */
export const PEER_PREFIX = 'backroom-billiards-';

/** A new random join code. Math.random is fine here: this is not game rules. */
export function makeCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}
/**
 * What the player typed, made into a code: upper case, only allowed characters, at most 4.
 * @param {string} text
 * @returns {string}
 */
export function cleanCode(text) {
  let s = '';
  for (const ch of String(text || '').toUpperCase()) if (CODE_ALPHABET.includes(ch) && s.length < CODE_LENGTH) s += ch;
  return s;
}
/** @param {string} code */
export function isCode(code) { return typeof code === 'string' && code.length === CODE_LENGTH && cleanCode(code) === code; }
/** @param {string} code @returns {string} */
export function peerIdFor(code) { return PEER_PREFIX + code.toLowerCase(); }

/**
 * The host's choices in the lobby.
 * @typedef {Object} MatchSettings
 * @property {'short'|'full'|'none'} aimHelp
 * @property {'anywhere'|'behindLine'} foulRule   where the cue ball goes after a foul
 * @property {'7'|'8'|'9'} size                   table size in feet
 * @property {boolean} allowTop                   the view from above may be used (placing the cue ball always uses it)
 */
export const SETTING_CHOICES = {
  aimHelp: ['short', 'full', 'none'],
  foulRule: ['anywhere', 'behindLine'],
  size: ['9', '8', '7'],
  allowTop: [true, false],
};
/** @returns {MatchSettings} */
export function defaultSettings() { return { aimHelp: 'short', foulRule: 'anywhere', size: '9', allowTop: true }; }
/**
 * Settings from a message or a save, with anything odd replaced by the default.
 * @param {any} s
 * @returns {MatchSettings}
 */
export function cleanSettings(s) {
  const d = defaultSettings(), o = s && typeof s === 'object' ? s : {};
  return {
    aimHelp: SETTING_CHOICES.aimHelp.includes(o.aimHelp) ? o.aimHelp : d.aimHelp,
    foulRule: SETTING_CHOICES.foulRule.includes(o.foulRule) ? o.foulRule : d.foulRule,
    size: SETTING_CHOICES.size.includes(String(o.size)) ? String(o.size) : d.size,
    allowTop: typeof o.allowTop === 'boolean' ? o.allowTop : d.allowTop,
  };
}

// ---------------------------------------------------------------- the messages
// Field kinds: 'number', 'string', 'boolean', 'object' (a plain object), 'array', 'object?' (object or null).
const FIELDS = {
  // -- connection (net/net.js)
  /** friend -> host, first thing on a new connection: who I am and which version I run */
  hello: { protocol: 'number', version: 'string', guestId: 'string' },
  /** host -> friend: you are in */
  welcome: { protocol: 'number', version: 'string' },
  /** host -> friend: you are not let in. reason 'full' (two players already) or 'version' (different play-test number) */
  refuse: { reason: 'string', version: 'string' },
  /** both ways, every keepalive: still here */
  ping: {},
  /** both ways: I am leaving on purpose (do not wait for me) */
  bye: {},

  // -- lobby (online.js)
  /** host -> friend: the lobby settings, sent on every change */
  lobby: { settings: 'object' },
  /** host -> friend: a game starts (from the lobby, or a rematch). opts go straight into createGame */
  start: { game: 'number', opts: 'object', settings: 'object' },
  /** host -> friend after a reconnect: everything needed to carry on. queue: actions known but not yet applied */
  resume: { game: 'number', opts: 'object', settings: 'object', state: 'object', seq: 'number', queue: 'array', rematch: 'object' },

  // -- the table (practice.js, online mode)
  /** both ways: a player's action (place, call or shoot). seq counts actions from 1 in each game; by = 0 host, 1 friend.
   *  pull (0 to 1) is only for drawing the cue's stroke */
  act: { game: 'number', seq: 'number', by: 'number', action: 'object', pull: 'number' },
  /** shooter -> other, about 12 times a second: the cue as it is now, for drawing. ghost is the cue ball in hand or null */
  aim: { game: 'number', seq: 'number', yaw: 'number', pull: 'number', offX: 'number', offY: 'number', elevDeg: 'number', ghost: 'object?' },
  /** host -> friend: the state's fingerprint once action `seq` has come to rest */
  check: { game: 'number', seq: 'number', tick: 'number', hash: 'string' },
  /** friend -> host: my fingerprint was different, send me your state */
  needState: { game: 'number' },
  /** host -> friend: my whole state after action `seq`, plus the actions still waiting; take it over */
  state: { game: 'number', seq: 'number', state: 'object', queue: 'array' },
  /** both ways: I pressed Rematch (want true) */
  rematch: { game: 'number', want: 'boolean' },
};
/** The message type names, for code that wants to spell them once. */
export const MSG = Object.freeze(Object.fromEntries(Object.keys(FIELDS).map(k => [k, k])));

/**
 * Whether a received value is a message we know, with every field of the right kind.
 * @param {any} m
 * @returns {boolean}
 */
export function validate(m) {
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !Object.prototype.hasOwnProperty.call(FIELDS, m.type)) return false;
  const f = FIELDS[m.type];
  for (const key in f) {
    const want = f[key], v = m[key];
    if (want === 'object?') { if (v !== null && (typeof v !== 'object' || Array.isArray(v))) return false; }
    else if (want === 'object') { if (!v || typeof v !== 'object' || Array.isArray(v)) return false; }
    else if (want === 'array') { if (!Array.isArray(v)) return false; }
    else if (want === 'number') { if (typeof v !== 'number' || !isFinite(v)) return false; }
    else if (typeof v !== want) return false;
  }
  return true;
}

/** Makers: one per message, so the fields are always complete. */
export const make = {
  hello: (version, guestId) => ({ type: 'hello', protocol: PROTOCOL, version, guestId }),
  welcome: version => ({ type: 'welcome', protocol: PROTOCOL, version }),
  refuse: (reason, version) => ({ type: 'refuse', reason, version }),
  ping: () => ({ type: 'ping' }),
  bye: () => ({ type: 'bye' }),
  lobby: settings => ({ type: 'lobby', settings }),
  start: (game, opts, settings) => ({ type: 'start', game, opts, settings }),
  /** @param {{game:number, opts:Object, settings:Object, state:Object, seq:number, queue:Object[], rematch:{host:boolean, guest:boolean}}} s */
  resume: s => ({ type: 'resume', game: s.game, opts: s.opts, settings: s.settings, state: s.state, seq: s.seq, queue: s.queue, rematch: s.rematch }),
  act: (game, seq, by, action, pull) => ({ type: 'act', game, seq, by, action, pull }),
  aim: (game, seq, a) => ({ type: 'aim', game, seq, yaw: a.yaw, pull: a.pull, offX: a.offX, offY: a.offY, elevDeg: a.elevDeg, ghost: a.ghost }),
  check: (game, seq, tick, hash) => ({ type: 'check', game, seq, tick, hash }),
  needState: game => ({ type: 'needState', game }),
  state: (game, seq, state, queue) => ({ type: 'state', game, seq, state, queue }),
  rematch: (game, want) => ({ type: 'rematch', game, want }),
};
