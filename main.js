// Start-up: settings, sound switch, title screen, and the ways to the table (practice, the local match, online).
import { GAME_NAME, PLAYTEST, PLAYTEST_DATE } from './version.js';
import { loadSettings, saveSettings, saveChoices, QUALITY_CHOICES, FELT_CHOICES } from './save.js';
import { initAudio, setMuted, setVolume, isMuted, isForcedMute, audioState, loadSounds } from './audio/audio.js';
import { startTitleScene } from './view/titleScene.js';
import { createInput, bindPageButton } from './input/input.js';
import { createOnline } from './online.js';
import { createSettingsScreen } from './settingsScreen.js';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
const settings = loadSettings();
// Test switches in the address win over the saved settings for this run only, and are never saved:
// ?mute=1 (silent), ?quality=low|medium|high, ?felt=green|blue|red|purple|black. A choice made on the settings screen replaces them.
const forced = {
  quality: QUALITY_CHOICES.includes(query.get('quality')) ? query.get('quality') : null,
  felt: FELT_CHOICES.includes(query.get('felt')) ? query.get('felt') : null,
};
/** The picture settings in use now. */
const look = () => ({ quality: forced.quality || settings.quality, felt: forced.felt || settings.felt });

initAudio({ volume: settings.volume, muted: settings.muted, forcedMute: query.get('mute') === '1' });

$('stamp').textContent = 'Play-test ' + PLAYTEST + ' · ' + PLAYTEST_DATE;

const muteBtn = $('muteBtn');
function showMute() {
  muteBtn.textContent = isForcedMute() ? 'Sound: off (muted by the address)' : (isMuted() ? 'Sound: off' : 'Sound: on');
  muteBtn.disabled = isForcedMute();
}
bindPageButton(muteBtn, () => { changeSetting('muted', !settings.muted); settingsScreen.draw(); });
showMute();

/** @type {ReturnType<typeof startTitleScene>|null} */
let titleScene = null;
/** @type {ReturnType<typeof createOnline>|null} */
let online = null;
/** The table while it is open (practice, the local match or online). */
let liveTable = null;

/**
 * A choice changed (on the settings screen, the title's sound button or the F key): apply it at once and save it.
 * Saving keeps the kept online match as it is in the save now (saveChoices), so another copy of the game on this
 * PC cannot lose it.
 * @param {string} name
 * @param {any} value
 */
function changeSetting(name, value) {
  if (name === 'volume') { settings.volume = Math.max(0, Math.min(1, Number(value) || 0)); setVolume(settings.volume); }
  else if (name === 'muted') { settings.muted = !!value; setMuted(settings.muted); showMute(); }
  else if (name === 'aimSpeed') { settings.aimSpeed = value; if (input) input.setAimSpeed(value); }
  else if (name === 'fineAim') { settings.fineAim = !!value; if (input) input.setFineAim(settings.fineAim); showFineNote(); }
  else if (name === 'quality' && QUALITY_CHOICES.includes(value)) {
    settings.quality = value; forced.quality = null;
    if (titleScene) titleScene.setQuality(value);
    if (liveTable) liveTable.setQuality(value);
  } else if (name === 'felt' && FELT_CHOICES.includes(value)) {
    settings.felt = value; forced.felt = null;
    if (titleScene) titleScene.setFelt(value);
    if (liveTable) liveTable.setFelt(value);
  } else return;
  saveChoices(settings);
}
/** The small "Fine aim on" line at the table. */
function showFineNote() { $('fineNote').hidden = !settings.fineAim; }
showFineNote();

const settingsScreen = createSettingsScreen({
  ui: {
    layer: $('settingsLayer'), volSlider: $('volSlider'), volVal: $('volVal'), soundBtn: $('soundBtn'), soundNote: $('soundNote'),
    aimSlider: $('aimSlider'), aimVal: $('aimVal'), fineBtn: $('fineBtn'), qualityChoice: $('qualityChoice'), feltChoice: $('feltChoice'),
    lookNote: $('lookNote'), doneBtn: $('settingsDone'),
  },
  get: () => ({ volume: settings.volume, muted: settings.muted, forcedMute: isForcedMute(), aimSpeed: settings.aimSpeed, fineAim: settings.fineAim,
    ...look(), lookFromAddress: !!(forced.quality || forced.felt) }),
  set: changeSetting,
  // while the panel is open over the table, the table takes no clicks or keys (an online match goes on regardless)
  onOpenChange: open => { if (input) input.setPaused(open); },
});
bindPageButton($('settingsBtn'), () => settingsScreen.open());
bindPageButton($('hudSettingsBtn'), () => settingsScreen.open());

// Full screen (item 39): on one screen the cursor cannot slide off the game while setting power.
const fullBtn = $('fullBtn');
const showFull = () => { fullBtn.textContent = document.fullscreenElement ? 'Leave full screen' : 'Full screen'; };
if (!document.documentElement.requestFullscreen) fullBtn.hidden = true;
bindPageButton(fullBtn, () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else { const p = document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
});
document.addEventListener('fullscreenchange', showFull);
showFull();

// Debug helpers hang off this one object and nowhere else.
window.GAME = {
  name: GAME_NAME,
  playtest: PLAYTEST,
  date: PLAYTEST_DATE,
  debug: {
    audio: audioState,
    /** The saved settings (what this copy of the game would save; ?quality= and ?felt= are not in here). */
    settings: () => ({ ...settings }),
    /** The picture settings in use now, and which of them the address set for this run. */
    look: () => ({ ...look(), forced: { ...forced } }),
    scene: () => (titleScene ? titleScene.info() : null),
    /** The settings screen: open, close, and what it shows. */
    settingsScreen: { open: () => settingsScreen.open(), close: () => settingsScreen.close(), isOpen: () => settingsScreen.isOpen(), shown: () => settingsScreen.shown() },
    /** The turning rates the input layer uses now (null until the table has been opened once). */
    aimRates: () => (input ? input.aimRates() : null),
  },
};

function showTitle() {
  liveTable = null;
  $('title').hidden = false; $('stamp').hidden = false; $('hud').hidden = true;
  $('game').hidden = true; $('scene').hidden = false;
  if (online) online.showTitlePanel();
  if (titleScene) return;
  try { titleScene = startTitleScene(/** @type {HTMLCanvasElement} */ ($('scene')), look()); }
  catch (e) { $('note').textContent = 'The 3D picture could not start on this PC: ' + (e && e.message || e); }
}

/** The numbers the game runs on. Loaded once. */
let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    const get = name => fetch(new URL('./data/' + name + '.json', import.meta.url)).then(r => { if (!r.ok) throw new Error(name + '.json: ' + r.status); return r.json(); });
    dataPromise = Promise.all([get('table'), get('physics'), get('controls'), get('audio'), get('net'), get('tracks')])
      .then(([table, physics, controls, audio, net, tracks]) => ({ table, physics, controls, audio, net, tracks }));
  }
  return dataPromise;
}

const gameCanvas = /** @type {HTMLCanvasElement} */ ($('game'));
let input = null;

/**
 * Opens the table: the practice table, an 8-ball match for two players at this PC, or an online match.
 * @param {'practice'|'match'|'online'} [mode]
 * @param {Object} [link]   online only: what online.js gives the table
 * @returns {Promise<Object>} the table
 */
async function openPractice(mode, link) {
  mode = mode === 'match' || mode === 'online' ? mode : 'practice';
  $('note').textContent = '';
  try {
    const [{ table, physics, controls, audio, tracks }, practice] = await Promise.all([loadData(), import('./practice.js')]);
    loadSounds(audio);   // starts loading the recordings; a muted test run skips this
    if (titleScene) { titleScene.stop(); titleScene = null; }
    $('title').hidden = true; $('stamp').hidden = true; $('scene').hidden = true;
    $('game').hidden = false; $('hud').hidden = false;
    if (!input) {
      input = createInput(gameCanvas, controls);
      input.bindButton($('viewBtn'), 'switchView');
      input.bindButton($('aimHelpBtn'), 'aimHelp');
      input.bindButton($('rackBtn'), 'rack');
      input.bindButton($('exitBtn'), 'exit');
      input.bindButton($('overTitleBtn'), 'exit');
      input.bindButton($('rematchBtn'), 'rematch');
      input.bindSpinPad($('spinPad'));
      input.bindElevation(/** @type {HTMLInputElement} */ ($('elevSlider')));
      input.setAimSpeed(settings.aimSpeed);
      input.setFineAim(settings.fineAim);
      input.onFineAim(on => { changeSetting('fineAim', on); settingsScreen.draw(); });   // the F key at the table
    }
    input.setPaused(settingsScreen.isOpen());
    const opened = practice.startPractice({
      canvas: gameCanvas, data: { table, physics }, controls, tracks, input, look: look(),
      mode, online: link, foulRule: query.get('foul') === 'line' ? 'behindLine' : 'anywhere',   // the local match: ?foul=line (online: the lobby setting)
      noHitFoul: query.get('nohit') === 'foul',   // the local match: ?nohit=foul makes the cue ball hitting nothing a foul (online: the lobby setting)
      hud: { matchBar: $('matchBar'), matchMsg: $('matchMsg'), overPanel: $('overPanel'), overText: $('overText'), overWhy: $('overWhy'),
        overWait: $('overWait'), rematchBtn: $('rematchBtn'),
        who: [$('who0'), $('who1')], grp: [$('grp0'), $('grp1')], rackBtn: $('rackBtn'),
        hint: $('hint'), power: $('power'), powerFill: $('powerFill'), aimHelpBtn: $('aimHelpBtn'), viewBtn: $('viewBtn'),
        spinBox: $('spinBox'), spinPad: $('spinPad'), spinDot: $('spinDot'), elevText: $('elevText'), elevSlider: /** @type {HTMLInputElement} */ ($('elevSlider')),
        miniFrame: $('miniFrame') },
      onExit: () => { if (online) online.tableClosed(); showTitle(); },
    });
    liveTable = opened;
    return opened;
  } catch (e) {
    console.error(e);
    showTitle();
    $('note').textContent = 'The table could not start: ' + (e && e.message || e);
    throw e;
  }
}
bindPageButton($('practiceBtn'), () => { openPractice('practice').catch(() => {}); });
bindPageButton($('matchBtn'), () => { openPractice('match').catch(() => {}); });

// Online play. ?fakeVersion= is test-only: it pretends this copy is another play-test version.
online = createOnline({
  version: query.get('fakeVersion') || PLAYTEST,
  loadTiming: () => loadData().then(d => d.net),
  ui: {
    titlePanel: $('titlePanel'), titleButtons: $('titleButtons'), note: $('note'),
    hostBtn: $('hostBtn'), joinBtn: $('joinBtn'), resumeBtn: $('resumeBtn'),
    joinBox: $('joinBox'), codeBox: $('codeBox'), joinGoBtn: $('joinGoBtn'), joinBackBtn: $('joinBackBtn'),
    lobby: $('lobby'), lobbyCode: $('lobbyCode'), lobbyHost: $('lobbyHost'), lobbyFriend: $('lobbyFriend'),
    setAim: $('setAim'), setFoul: $('setFoul'), setSize: $('setSize'), setTop: $('setTop'), setNoHit: $('setNoHit'),
    lobbyNote: $('lobbyNote'), lobbyStatus: $('lobbyStatus'), startBtn: $('startBtn'), leaveBtn: $('leaveBtn'),
  },
  openTable: link => openPractice('online', link),
  showTitle,
  saveMatch: m => { settings.online = m; saveSettings(settings); },
  savedMatch: () => loadSettings().online,
});
window.GAME.debug.online = online.debug;

showTitle();
if (query.get('practice') === '1') openPractice('practice').catch(() => {});   // straight to the table, for test runs
else if (query.get('match') === '1') openPractice('match').catch(() => {});
if (query.get('settings') === '1') settingsScreen.open();   // test only: open the settings screen at start
