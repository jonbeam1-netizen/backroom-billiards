// The one save entry (build rule 12): one plain object holding the settings,
// plus the host's online match while one is going (so a closed or crashed game can carry on).
import { SAVE_VERSION } from './version.js';

const KEY = 'backroomBilliards.v' + SAVE_VERSION;

/**
 * The host's online match, saved every time the balls come to rest. Cleared when the match ends or the
 * host leaves on purpose.
 * @typedef {Object} SavedMatch
 * @property {string} code       the join code
 * @property {number} side       0: this PC was the host
 * @property {number} game       which game of the match (goes up with each rematch)
 * @property {Object} opts       the createGame options of this game
 * @property {Object} settings   the lobby settings
 * @property {Object} state      the game state (plain data)
 * @property {number} seq        actions applied so far in this game
 * @property {Object[]} queue    actions known but not yet applied
 * @property {{host:boolean, guest:boolean}} rematch
 * @property {number} savedAt    Date.now() when saved
 */

/** The choices the settings screen offers (anything else in the save falls back to the default). */
export const QUALITY_CHOICES = ['low', 'medium', 'high'];
export const FELT_CHOICES = ['green', 'blue', 'red'];
export const AIM_SPEED_MIN = 0.25, AIM_SPEED_MAX = 3;

/**
 * @typedef {Object} Settings
 * @property {number} volume  0 to 1
 * @property {boolean} muted
 * @property {number} aimSpeed   aim sensitivity, a multiplier on the turning rates in data/controls.json (0.25 to 3)
 * @property {boolean} fineAim   fine aim always on (without holding Shift)
 * @property {'low'|'medium'|'high'} quality   picture quality
 * @property {'green'|'blue'|'red'} felt       felt colour (this player only, never sent)
 * @property {SavedMatch|null} online
 */

/** @returns {Settings} */
export function defaultSettings() {
  return { volume: 0.8, muted: false, aimSpeed: 1, fineAim: false, quality: 'high', felt: 'green', online: null };
}

/** @param {any} m @returns {boolean} */
function looksLikeMatch(m) {
  return !!m && typeof m === 'object' && typeof m.code === 'string' && m.code.length === 4 && m.side === 0
    && typeof m.game === 'number' && !!m.opts && typeof m.opts === 'object' && !!m.settings && typeof m.settings === 'object'
    && !!m.state && typeof m.state === 'object' && Array.isArray(m.state.balls) && typeof m.seq === 'number';
}

/**
 * Reads the saved settings. Anything missing or broken falls back to the defaults.
 * @returns {Settings}
 */
export function loadSettings() {
  const s = defaultSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      if (typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1) s.volume = raw.volume;
      if (typeof raw.muted === 'boolean') s.muted = raw.muted;
      if (typeof raw.aimSpeed === 'number' && raw.aimSpeed >= AIM_SPEED_MIN && raw.aimSpeed <= AIM_SPEED_MAX) s.aimSpeed = raw.aimSpeed;
      if (typeof raw.fineAim === 'boolean') s.fineAim = raw.fineAim;
      if (QUALITY_CHOICES.includes(raw.quality)) s.quality = raw.quality;
      if (FELT_CHOICES.includes(raw.felt)) s.felt = raw.felt;
      if (looksLikeMatch(raw.online)) {
        s.online = raw.online;
        if (!Array.isArray(s.online.queue)) s.online.queue = [];
        if (!s.online.rematch || typeof s.online.rematch !== 'object') s.online.rematch = { host: false, guest: false };
      }
    }
  } catch (e) { /* private window or blocked storage: play with the defaults */ }
  return s;
}

/** @param {Settings} settings */
export function saveSettings(settings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* not saved, the game still runs */ }
}

/**
 * Saves this player's choices (sound, aim, picture) and leaves the kept online match as it is in the save now:
 * another copy of the game on this PC may have saved or cleared it since this one loaded.
 * `settings.online` is brought up to date with the save.
 * @param {Settings} settings
 */
export function saveChoices(settings) {
  settings.online = loadSettings().online;
  saveSettings(settings);
}

/** The name of the save entry in localStorage (for the test pages). */
export const SAVE_KEY = KEY;
