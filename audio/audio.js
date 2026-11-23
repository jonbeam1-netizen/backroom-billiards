// All sound goes through this file. No sound files exist yet (they come in the sound stage);
// this holds the master switch: volume, mute, and silence while the tab is hidden (build rule 13).
// Later every sound gets its own play function here (build rule 11).

/** @type {AudioContext|null} */
let ctx = null;
/** @type {GainNode|null} */
let master = null;
let volume = 0.8;
let muted = false;
let forcedMute = false;   // ?mute=1 in the address: silent for this run, whatever the saved setting says
let hidden = false;

/** The loudness that should reach the speakers right now. */
function level() {
  return (muted || forcedMute || hidden) ? 0 : volume;
}

function apply() {
  if (master) master.gain.value = level();
  if (ctx) {
    if (hidden && ctx.state === 'running') ctx.suspend();
    if (!hidden && ctx.state === 'suspended' && level() > 0) ctx.resume();
  }
}

/**
 * @param {{volume:number, muted:boolean, forcedMute:boolean}} opts
 */
export function initAudio(opts) {
  volume = opts.volume; muted = opts.muted; forcedMute = opts.forcedMute;
  hidden = document.hidden;
  document.addEventListener('visibilitychange', () => { hidden = document.hidden; apply(); });
}

/**
 * The shared output every sound connects to. Made on first use, and never while forced mute is on,
 * so a muted test run cannot make a sound.
 * @returns {GainNode|null}
 */
export function output() {
  if (forcedMute) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
    apply();
  }
  return master;
}

// ---------------------------------------------------------------------------------------------------
// The recorded sounds. They are WAV files under audio/sfx (see CREDITS.md); data/audio.json says how
// each kind follows the strength of the hit. Each kind of sound is played through its own function.

/** @type {Object|null} */
let cfg = null;
/** @type {Object<string, AudioBuffer[]>} */
const buffers = {};
const stats = { loaded: 0, failed: 0, played: { ball: 0, cushion: 0, cue: 0, pocket: 0, bounce: 0 } };
let loading = null;

/**
 * Loads the recordings. Call it from a click (the browser only lets sound start after one).
 * Does nothing in a muted test run (?mute=1), so such a run never touches the sound system.
 * @param {Object} config   data/audio.json
 * @returns {Promise<void>}
 */
export function loadSounds(config) {
  cfg = config;
  if (forcedMute || loading) return loading || Promise.resolve();
  if (!output() || !ctx) return Promise.resolve();
  const c = ctx, jobs = [];
  for (const kind of ['ball', 'cushion', 'cue', 'pocket', 'bounce']) {
    buffers[kind] = [];
    config[kind].files.forEach((name, i) => {
      jobs.push(fetch(new URL('../' + config.folder + name, import.meta.url))
        .then(r => { if (!r.ok) throw new Error(name + ': ' + r.status); return r.arrayBuffer(); })
        .then(a => c.decodeAudioData(a))
        .then(b => { buffers[kind][i] = b; stats.loaded++; })
        .catch(e => { stats.failed++; console.error('sound', name, e); }));
    });
  }
  // the browser may hold the sound back until the first click or key
  const wake = () => { if (ctx && ctx.state === 'suspended' && !hidden) ctx.resume(); };
  window.addEventListener('pointerdown', wake); window.addEventListener('keydown', wake);
  loading = Promise.all(jobs).then(() => {});
  return loading;
}

/**
 * Plays one recording of a kind, shaped by how hard the hit was.
 * @param {'ball'|'cushion'|'cue'|'pocket'|'bounce'} kind
 * @param {number} speed   how hard the hit was, metres a second
 */
function play(kind, speed) {
  if (!cfg || !ctx || !master || level() === 0) return;
  const k = cfg[kind], list = (buffers[kind] || []).filter(Boolean);
  if (!list.length || speed <= k.quietSpeed) return;
  const s = Math.max(0, Math.min(1, (speed - k.quietSpeed) / (k.fullSpeed - k.quietSpeed)));
  const src = ctx.createBufferSource();
  src.buffer = list[Math.floor(Math.random() * list.length)];   // which recording: variety only
  src.playbackRate.value = (k.rateLow + (k.rateHigh - k.rateLow) * s) * (1 + (Math.random() * 2 - 1) * cfg.rateJitter);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = k.dullHz * Math.pow(k.sharpHz / k.dullHz, s); filter.Q.value = 0.5;
  const gain = ctx.createGain();
  gain.gain.value = k.gain * Math.pow(s, k.curve);
  src.connect(filter); filter.connect(gain); gain.connect(master);
  src.start();
  stats.played[kind]++;
}

/** A ball hits a ball. @param {number} speed */
export function playBallHit(speed) { play('ball', speed); }
/** A ball hits a cushion. @param {number} speed */
export function playCushionHit(speed) { play('cushion', speed); }
/** The cue tip strikes the cue ball. @param {number} speed */
export function playCueStrike(speed) { play('cue', speed); }
/** A ball drops into a pocket. @param {number} speed */
export function playPocketDrop(speed) { play('pocket', speed); }
/** A ball that was in the air lands on the felt or the rail. @param {number} speed */
export function playBounce(speed) { play('bounce', speed); }

const EVENT_SOUND = { ballBall: playBallHit, cushion: playCushionHit, cueStrike: playCueStrike, pocket: playPocketDrop, tableBounce: playBounce, railBounce: playBounce };

/**
 * Plays the sounds for one tick's events from the rules. A break makes dozens of hits in a tick,
 * so only the hardest few are played.
 * @param {import('../rules/types.js').GameEvent[]} events
 */
export function playEvents(events) {
  if (!cfg || !ctx || level() === 0) return;
  const hits = events.filter(e => EVENT_SOUND[e.type] && typeof e.speed === 'number');
  if (hits.length > cfg.maxPerTick) hits.sort((a, b) => b.speed - a.speed).length = cfg.maxPerTick;
  for (const e of hits) EVENT_SOUND[e.type](e.type === 'pocket' ? Math.max(e.speed, 0.3) : e.speed);
}

/** @param {boolean} m */
export function setMuted(m) { muted = m; apply(); }
/** @param {number} v 0 to 1 */
export function setVolume(v) { volume = Math.max(0, Math.min(1, v)); apply(); }
export function isMuted() { return muted || forcedMute; }
export function isForcedMute() { return forcedMute; }
/** For window.GAME.debug. */
export function audioState() {
  return { volume, muted, forcedMute, hidden, level: level(), context: ctx ? ctx.state : 'none', loaded: stats.loaded, failed: stats.failed, played: { ...stats.played } };
}
