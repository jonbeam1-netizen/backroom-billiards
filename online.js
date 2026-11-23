// Online play around the table: hosting and joining by code, the lobby, starting the match, and keeping it
// going through dropped connections and a closed host game. The table itself (practice.js, mode 'online')
// plays the match; net/net.js is the connection; net/protocol.js lists every message.
import { createNet } from './net/net.js';
import { make, cleanCode, isCode, cleanSettings, defaultSettings, SETTING_CHOICES } from './net/protocol.js';
import { bindPageButton, bindTextField } from './input/input.js';

const LABEL = {
  aimHelp: v => 'Aim help: ' + v,
  foulRule: v => 'After a foul: ' + (v === 'behindLine' ? 'behind the line' : 'cue ball anywhere'),
  size: v => 'Table: ' + v + '-foot',
  allowTop: v => 'View from above: ' + (v ? 'allowed' : 'off'),
  noHitFoul: v => 'Cue ball hits nothing: ' + (v ? 'foul' : 'no foul'),
};
const FAILED = {
  unreachable: () => 'Could not reach the join-code service. Check your internet connection and try again.',
  noPeerJs: () => 'The online part of the game could not start (lib/peerjs.min.js did not load).',
  notFound: code => 'No game found with code ' + code + '. Check the code with your friend.',
  full: () => 'That game is full: two players are already in it.',
  cannotConnect: () => 'Found the game, but could not connect to the host\'s PC. Try again in a moment.',
  taken: code => (code ? 'Code ' + code + ' is still in use at the join-code service. Try Resume again in a minute.' : 'Could not get a free join code. Try again in a moment.'),
};

/**
 * @param {Object} o
 * @param {string} o.version                       this game's play-test number (a test-only address switch may fake it)
 * @param {() => Promise<Object>} o.loadTiming      data/net.json
 * @param {Object<string, HTMLElement>} o.ui        the title and lobby elements (see main.js)
 * @param {(link:Object) => Promise<{stop:Function, onMessage:Function, snapshot:Function, running:Function}>} o.openTable
 * @param {() => void} o.showTitle
 * @param {(m:Object|null) => void} o.saveMatch     keep the host's match (null clears it)
 * @param {() => Object|null} o.savedMatch          the kept match, or null
 */
export function createOnline(o) {
  const ui = o.ui;
  /** @type {ReturnType<typeof createNet>|null} */
  let net = null;
  let timing = null;
  let role = 'none';               // 'host' | 'guest' | 'none'
  let screen = 'title';            // 'title' | 'join' | 'lobby' | 'table'
  let settings = defaultSettings();
  let st = null;                   // the newest net status
  let table = null;                // the table while it is open
  let opening = false;             // the table is being opened
  let early = [];                  // messages that came while the table was opening
  let linkWas = false;
  let leftOnPurpose = false;

  // ---------------------------------------------------------------- the title buttons and the join box
  bindPageButton(ui.hostBtn, () => hostGame());
  bindPageButton(ui.joinBtn, () => showJoin(''));
  bindPageButton(ui.joinBackBtn, () => { screen = 'title'; showTitlePanel(); });
  bindPageButton(ui.joinGoBtn, () => joinGame(ui.codeBox.value));
  bindPageButton(ui.resumeBtn, () => resumeSaved());
  bindTextField(ui.codeBox, {
    clean: cleanCode,
    onChange: v => { ui.joinGoBtn.disabled = !isCode(v); },
    onEnter: v => { if (isCode(cleanCode(v))) joinGame(v); },
  });
  bindPageButton(ui.leaveBtn, () => { leave(); o.showTitle(); });
  bindPageButton(ui.startBtn, () => startMatch());
  const settingButtons = { aimHelp: ui.setAim, foulRule: ui.setFoul, size: ui.setSize, allowTop: ui.setTop, noHitFoul: ui.setNoHit };
  for (const name of Object.keys(settingButtons)) bindPageButton(settingButtons[name], () => cycleSetting(name));

  /** The title shows the normal buttons (and Resume when a match is kept). Called by main.js each time the title shows. */
  function showTitlePanel(note) {
    ui.titlePanel.hidden = false; ui.lobby.hidden = true;
    ui.titleButtons.hidden = false; ui.joinBox.hidden = true;
    const saved = o.savedMatch();
    ui.resumeBtn.hidden = !saved;
    if (saved) ui.resumeBtn.textContent = 'Resume online game ' + saved.code;
    if (note !== undefined) ui.note.textContent = note;
  }
  function showJoin(note) {
    screen = 'join';
    ui.titlePanel.hidden = false; ui.lobby.hidden = true;
    ui.titleButtons.hidden = true; ui.joinBox.hidden = false;
    ui.note.textContent = note || '';
    ui.joinGoBtn.disabled = !isCode(ui.codeBox.value);
    try { ui.codeBox.focus(); } catch (e) { /* fine */ }
  }
  function showLobby() {
    screen = 'lobby';
    ui.titlePanel.hidden = true; ui.lobby.hidden = false;
    drawLobby();
  }

  // ---------------------------------------------------------------- starting a connection

  async function getNet() {
    if (!timing) timing = await o.loadTiming();
    if (!net) net = createNet({ version: o.version, timing, onMessage, onStatus });
    return net;
  }
  async function hostGame() {
    o.saveMatch(null);                     // a new game: the kept match is given up
    role = 'host'; settings = defaultSettings(); leftOnPurpose = false; linkWas = false;
    st = null; showLobby();
    try { (await getNet()).host(); } catch (e) { failed('unreachable'); }
  }
  async function joinGame(text) {
    const code = cleanCode(text);
    if (!isCode(code)) { showJoin('A join code has 4 characters.'); return; }
    role = 'guest'; settings = defaultSettings(); leftOnPurpose = false; linkWas = false;
    st = { code, phase: 'opening', link: false, reason: '' };
    showLobby();
    try { (await getNet()).join(code); } catch (e) { failed('unreachable'); }
  }
  /** Host: carry on with the kept match: open the same code again and wait for the friend. */
  async function resumeSaved() {
    const saved = o.savedMatch();
    if (!saved) { showTitlePanel(); return; }
    role = 'host'; settings = cleanSettings(saved.settings); leftOnPurpose = false; linkWas = false;
    st = { code: saved.code, phase: 'opening', link: false, reason: '' };
    try { await getNet(); } catch (e) { failed('unreachable'); return; }
    net.host(saved.code);
    openTable({ game: saved.game, opts: saved.opts, resume: saved });
  }
  /** Leave on purpose (Leave, Title): tell the other side, and the host gives up the kept match. */
  function leave() {
    leftOnPurpose = true;
    if (role === 'host') o.saveMatch(null);
    if (net) net.close(false);
    const t = table;
    role = 'none'; screen = 'title'; table = null; early = [];
    if (t) t.stop();
  }
  function failed(reason) {
    const code = st && st.code ? st.code : '';
    const text = reason === 'version'
      ? 'Different versions: you have play-test ' + o.version + ', the other player has ' + (st && st.otherVersion ? st.otherVersion : 'another') + '. Both need the same version: reload the page.'
      : (FAILED[reason] ? FAILED[reason](reason === 'taken' && !table ? '' : code) : 'Online play stopped: ' + reason);
    const wasGuest = role === 'guest';
    if (net) net.close(true);
    role = 'none';
    if (table) { table.stop(); table = null; o.showTitle(); }
    if (wasGuest) { o.showTitle(); showJoin(text); ui.codeBox.value = code; ui.joinGoBtn.disabled = !isCode(code); }
    else { screen = 'title'; o.showTitle(); showTitlePanel(text); }
  }

  // ---------------------------------------------------------------- status and messages

  /** @param {import('./net/net.js').NetStatus} s */
  function onStatus(s) {
    if (s.role === 'none') return;
    st = s;
    if (s.phase === 'failed') { failed(s.reason); return; }
    const up = s.link;
    if (up && !linkWas && role === 'host') {
      // the friend is (back) in: the lobby settings, or everything to carry on with the match
      if (table) net.send(make.resume(table.snapshot()));
      else if (!opening) net.send(make.lobby(settings));
    }
    linkWas = up;
    if (screen === 'lobby') drawLobby();
  }
  /** A checked message from the other side. */
  function onMessage(msg) {
    if (msg.type === 'lobby' && role === 'guest') { settings = cleanSettings(msg.settings); if (screen === 'lobby') drawLobby(); return; }
    if (msg.type === 'start' && role === 'guest' && !table && !opening) {
      settings = cleanSettings(msg.settings);
      openTable({ game: msg.game, opts: msg.opts, resume: null });
      return;
    }
    if (msg.type === 'resume' && role === 'guest' && !table && !opening) {
      settings = cleanSettings(msg.settings);
      openTable({ game: msg.game, opts: msg.opts, resume: msg });
      return;
    }
    if (opening) { early.push(msg); return; }
    if (table) table.onMessage(msg);
  }

  // ---------------------------------------------------------------- the lobby

  function cycleSetting(name) {
    if (role !== 'host' || screen !== 'lobby') return;
    const list = SETTING_CHOICES[name], i = list.indexOf(settings[name]);
    settings = { ...settings, [name]: list[(i + 1) % list.length] };
    if (net) net.send(make.lobby(settings));
    drawLobby();
  }
  function startMatch() {
    if (role !== 'host' || !st || !st.link || table || opening) return;
    const opts = { size: settings.size, seed: (Date.now() % 4294967296) >>> 0, mode: 'match', foulRule: settings.foulRule, noHitFoul: settings.noHitFoul };
    net.send(make.start(1, opts, settings));
    openTable({ game: 1, opts, resume: null });
  }
  function drawLobby() {
    const host = role === 'host', code = st && st.code ? st.code : '';
    ui.lobbyCode.textContent = code || '····';
    const up = !!(st && st.link);
    ui.lobbyHost.textContent = host ? 'Host: you' : 'Host: ' + (up ? 'connected' : 'not connected');
    ui.lobbyFriend.textContent = host ? 'Friend: ' + (up ? 'connected' : 'waiting') : 'Friend: you';
    ui.lobbyHost.classList.toggle('on', host || up);
    ui.lobbyFriend.classList.toggle('on', !host || up);
    for (const name of Object.keys(settingButtons)) {
      settingButtons[name].textContent = LABEL[name](settings[name]);
      settingButtons[name].disabled = !host;
    }
    ui.lobbyNote.textContent = host ? 'Click a setting to change it. Your friend sees it too.' : 'The host chooses these settings.';
    ui.startBtn.hidden = !host;
    ui.startBtn.disabled = !(host && up);
    ui.lobbyStatus.textContent = lobbyLine();
  }
  function lobbyLine() {
    if (!st) return role === 'host' ? 'Getting a join code...' : '';
    const code = st.code;
    if (role === 'host') {
      if (st.phase === 'opening') return st.reason === 'codeBusy' ? busyLine() : 'Getting a join code...';
      if (st.link) return 'Your friend is here. Press Start when you are ready.';
      if (st.reason === 'friendLost') return 'Your friend lost the connection. Waiting for them to come back with code ' + code + '.';
      if (st.reason === 'friendLeft') return 'Your friend left. Waiting for someone to join with code ' + code + '.';
      if (!st.server && st.phase === 'open') return 'Lost the join-code service. Reconnecting...';
      return 'Waiting for your friend. Tell them the code: ' + code;
    }
    if (st.link) return 'Connected. Waiting for the host to start the game.';
    if (st.reason === 'hostLeft') return 'The host closed this game.';
    if (st.reason === 'hostLost') return 'Lost the connection to the host. Reconnecting...';
    return 'Looking for game ' + code + '...';
  }
  function busyLine() {
    return 'Getting code ' + st.code + ' back from the join-code service... (' + Math.round((st.busyMs || 0) / 1000) + ' s). Your friend\'s game keeps trying.';
  }
  /** The line the table shows while the other player is not connected ('' while they are). */
  function tableLine() {
    if (!st || st.link) return '';
    const code = st.code;
    if (role === 'host') {
      if (st.reason === 'codeBusy') return busyLine();
      if (st.reason === 'friendLeft') return 'Your friend left the game. They can come back with code ' + code;
      if (st.reason === 'friendLost') return 'Your friend lost the connection. Waiting for them to come back with code ' + code;
      if (st.phase === 'opening') return 'Opening code ' + code + '...';
      if (!st.server) return 'Reconnecting...';
      return 'Waiting for your friend to come back with code ' + code;
    }
    if (st.reason === 'hostLeft') return 'The host left the game. Press Title to go back';
    return 'Lost the connection to the host. Reconnecting...';
  }

  // ---------------------------------------------------------------- the table

  /** @param {{game:number, opts:Object, resume:Object|null}} g */
  async function openTable(g) {
    opening = true; early = [];
    screen = 'table';
    const upAtOpen = !!(st && st.link);
    const side = role === 'host' ? 0 : 1;
    const link = {
      side, code: st ? st.code : '', settings: { ...settings }, game: g.game, opts: g.opts, resume: g.resume, timing,
      send: m => (net ? net.send(m) : false),
      up: () => !!(net && st && st.link),
      statusText: tableLine,
      leave: () => leave(),
      save: snap => { if (role === 'host' && snap && st && st.code) o.saveMatch({ ...snap, code: st.code, side: 0, savedAt: Date.now() }); else if (role === 'host' && !snap) o.saveMatch(null); },
    };
    try {
      table = await o.openTable(link);
    } catch (e) {
      opening = false; table = null;
      console.error(e);
      return;
    }
    opening = false;
    const waiting = early; early = [];
    for (const m of waiting) table.onMessage(m);
    // the friend may have come in while the table was opening
    if (role === 'host' && st && st.link && (g.resume || !upAtOpen)) net.send(make.resume(table.snapshot()));
  }

  // a host that closes the page keeps its match (it is saved at every rest; this saves the moment too)
  window.addEventListener('pagehide', () => {
    if (role === 'host' && table && table.running() && !leftOnPurpose) {
      const snap = table.snapshot();
      if (snap.state.phase !== 'over') o.saveMatch({ ...snap, code: st.code, side: 0, savedAt: Date.now() });
    }
    if (net) net.close(true);
  });

  return {
    showTitlePanel,
    /** When the table closes by itself (Title on the end panel): forget it. */
    tableClosed() { table = null; screen = 'title'; },
    // test only (window.GAME.debug.online)
    debug: {
      host: () => hostGame(),
      join: code => joinGame(code),
      resume: () => resumeSaved(),
      leave: () => { leave(); o.showTitle(); },
      start: () => startMatch(),
      set(name, value) {
        if (role !== 'host' || !(name in SETTING_CHOICES)) return false;
        settings = cleanSettings({ ...settings, [name]: value });
        if (net) net.send(make.lobby(settings));
        if (screen === 'lobby') drawLobby();
        return { ...settings };
      },
      status: () => ({ role, screen, settings: { ...settings }, net: st ? { ...st } : null, table: !!table,
        lobbyLine: screen === 'lobby' ? ui.lobbyStatus.textContent : '', note: ui.note.textContent, tableLine: tableLine(),
        startEnabled: !ui.startBtn.disabled && !ui.startBtn.hidden, resumeOffered: !ui.resumeBtn.hidden && !ui.titlePanel.hidden ? ui.resumeBtn.textContent : '' }),
      saved: () => o.savedMatch(),
      /** The connection breaks on this side. */
      drop: () => { if (net) net.debug.drop(); },
      /** The connection silently stops carrying anything (only the keepalive notices). */
      deafen: () => { if (net) net.debug.deafen(); },
    },
  };
}
