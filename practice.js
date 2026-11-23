// The table screen. It joins the rules, the view and the input.
// mode 'practice': one player, no opponent. mode 'match': 8-ball for two players taking turns at this PC.
// mode 'online': 8-ball against a friend on another PC (online.js connects; this file plays the table).
//
// How online play stays in step (both PCs run the same rules, see HANDOFF.md):
// - Every action (place, call, shoot) gets a number (seq) in its game and is applied on both PCs in that order.
// - Online, the rules are stepped only while balls roll or when an action is applied; a resting table does not
//   tick. So both PCs make exactly the same ticks, whatever their frame rate or the network delay. An action that
//   arrives while this PC's balls still roll waits until they have settled.
// - Each time an action has come to rest, the host sends the state's fingerprint (hashState). If the friend's is
//   different, the friend takes over the host's whole state (the host's state is the final word).
// - The shooter sends the cue (aim, power, hit point, cue angle, cue ball in hand) about 12 times a second; the
//   other PC draws it from that, smoothed.
import * as rules from './rules/index.js';
import { buildTable, createGame, step, firstContact, canPlaceCue, hashState, runReplay } from './rules/index.js';
import { createGameView } from './view/gameView.js';
import { playEvents } from './audio/audio.js';
import { make } from './net/protocol.js';

const TICK = 1 / 60;
const AIM_HELP = ['short', 'full', 'none'];

/**
 * What online.js gives the table in online mode.
 * @typedef {Object} OnlineLink
 * @property {0|1} side                 0 host, 1 friend
 * @property {string} code
 * @property {import('./net/protocol.js').MatchSettings} settings
 * @property {number} game              the game number to start with
 * @property {Object} opts              createGame options of that game
 * @property {Object|null} resume       carry on from here: {game, opts, state, seq, queue, rematch} (a saved match or a 'resume' message)
 * @property {Object} timing            data/net.json
 * @property {(msg:Object) => boolean} send
 * @property {() => boolean} up         the other player is connected
 * @property {() => string} statusText  a plain line about the connection when it is not up, else ''
 * @property {() => void} leave         the player left on purpose (Title)
 * @property {(snap:Object|null) => void} save   host: keep this snapshot to resume after a crash (null clears it)
 */

/**
 * @param {Object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {{table:Object, physics:Object}} o.data
 * @param {Object} o.controls            data/controls.json
 * @param {ReturnType<import('./input/input.js').createInput>} o.input
 * @param {Object} o.hud                 the elements of the HUD (see main.js)
 * @param {() => void} o.onExit
 * @param {'practice'|'match'|'online'} [o.mode]
 * @param {'anywhere'|'behindLine'} [o.foulRule]   match only: where the cue ball may go after a foul
 * @param {OnlineLink} [o.online]                   online only
 * @param {{quality?:'low'|'medium'|'high', felt?:'green'|'blue'|'red'}} [o.look]   this player's picture settings (never sent)
 */
export function startPractice(o) {
  const { data, controls, input, hud } = o;
  const online = o.mode === 'online' && o.online ? o.online : null;
  const isMatch = o.mode === 'match' || !!online;
  const me = online ? online.side : -1;
  const NAMES = online ? (me === 0 ? ['You', 'Your friend'] : ['Your friend', 'You']) : ['Player 1', 'Player 2'];
  /** The verb that goes with a player's name ("You win", "Your friend wins"). */
  const says = (p, other, you) => NAMES[p] + ' ' + (NAMES[p] === 'You' ? you : other);
  const FOULS = {
    scratch: 'the cue ball went in a pocket', cueOffTable: 'the cue ball left the table', noHit: 'the cue ball hit nothing',
    wrongBall: 'the wrong ball was hit first', noCushion: 'no ball reached a cushion after the hit', ballOffTable: 'a ball left the table',
  };
  const ENDS = {
    eight: 'sank the 8 in the called pocket', eightEarly: 'sank the 8 too early', eightWrongPocket: 'sank the 8 in the wrong pocket',
    eightOnFoul: 'sank the 8 on a foul', eightOffTable: 'knocked the 8 off the table',
  };
  let message = '';            // the small text line: a foul, or who is to shoot
  // test only (look stage): ?view=top ?look=break|pot|rail|raised ?freeze=seconds ?cam=name
  // (picture quality and felt colour come from the settings in o.look; main.js lets ?quality= and ?felt= win for a test run)
  // test only: ?size=7|8|9 (practice and the local match), ?speed=N (online: the clock runs N times faster)
  const testQ = new URLSearchParams(location.search);
  const testSize = ['7', '8', '9'].includes(testQ.get('size')) ? testQ.get('size') : '';
  const size = online ? String(online.opts.size) : (testSize || data.table.defaultSize);
  const testSpeed = Math.max(1, Math.min(20, Number(testQ.get('speed')) || 1));
  const geom = buildTable(data, size);
  const picture = o.look || {};
  const view = createGameView(o.canvas, geom, data, controls, { quality: picture.quality, felt: picture.felt });
  const prev = new Float32Array(48);
  const phys = data.physics;
  const allowTop = online ? online.settings.allowTop !== false : true;

  /** @type {import('./rules/types.js').GameState} */
  let state;
  let record = { opts: null, shots: [] };
  let yaw = 0;                 // 0 aims down the table toward the rack; positive turns right
  let aimHelp = online ? Math.max(0, AIM_HELP.indexOf(online.settings.aimHelp)) : 0;
  let acc = 0, last = 0, running = true;
  /** @type {import('./rules/types.js').Action[]} */
  let pending = [];
  let ghost = null;            // the cue ball in hand
  let viewBeforePlace = null;
  /** @type {import('./rules/types.js').GameEvent[]} */
  let lastEvents = [];
  let eventCount = 0;
  let debugPull = -1;          // test only: a pull to show instead of the mouse's

  function savePrev() {
    for (let i = 0; i < 16; i++) { const b = state.balls[i]; prev[i * 3] = b.x; prev[i * 3 + 1] = b.y; prev[i * 3 + 2] = b.z; }
  }
  /** Starts a game from createGame options. */
  function newGame(opts) {
    state = createGame(data, opts);
    record = { opts, shots: [] };
    yaw = 0; pending = []; ghost = null; acc = 0;
    if (viewBeforePlace) { view.setMode(viewBeforePlace); viewBeforePlace = null; }
    savePrev(); view.snapCamera();
    if (isMatch) message = says(state.turn, 'breaks', 'break');
    if (state.phase === 'place') startPlacing();
  }
  /** A fresh rack. In a match `breaker` says who breaks (the winner of the last game); without it, a coin flip. */
  function rack(breaker) {
    const opts = { size, seed: (Date.now() % 4294967296) >>> 0, mode: isMatch ? 'match' : 'practice' };
    if (isMatch) { opts.foulRule = o.foulRule || 'anywhere'; if (breaker === 0 || breaker === 1) opts.breaker = breaker; }
    newGame(opts);
  }
  function showButtons() {
    hud.aimHelpBtn.textContent = 'Aim help: ' + AIM_HELP[aimHelp];
    hud.viewBtn.textContent = view.getMode() === 'top' ? 'View: from above (V)' : 'View: behind the ball (V)';
  }
  /** The speed a pull of 0 to 1 gives the cue ball. */
  function pullToSpeed(pull) {
    const p = controls.power;
    // a steeply raised cue cannot be swung as hard: full power when level, less the higher the butt is
    const raised = (elevDeg - minElev) / Math.max(1, maxElev - minElev);
    const share = 1 - (1 - controls.cue.raisedPowerShare) * Math.max(0, Math.min(1, raised));
    return phys.shot.maxShotSpeed * share * (p.minShare + (1 - p.minShare) * Math.pow(pull, p.curve));
  }
  // where the tip hits the cue ball (-1 to 1, 1 = the edge; the rules allow up to shot.maxTipOffset)
  // and how far the butt of the cue is raised, in degrees
  const minElev = Math.asin(phys.shot.defaultElevSin) * 180 / Math.PI, maxElev = controls.cue.maxElevDeg;
  const maxTip = phys.shot.maxTipOffset;
  let spinX = 0, spinY = 0, elevDeg = minElev;
  function setSpin(x, y) {
    if (!controls.spin.sideSpin) x = 0;
    const len = Math.hypot(x, y);
    if (len > maxTip) { x = x / len * maxTip; y = y / len * maxTip; }
    spinX = x; spinY = y;
  }
  function setElev(deg) { elevDeg = Math.max(minElev, Math.min(maxElev, deg)); }
  /** Sine and cosine of a cue angle. At the lowest angle these are exactly the numbers in physics.json. */
  function elevOf(deg) {
    if (deg <= minElev + 0.01) return { sin: phys.shot.defaultElevSin, cos: phys.shot.defaultElevCos };
    const r = deg * Math.PI / 180;
    return { sin: Math.sin(r), cos: Math.cos(r) };
  }
  function elev() { return elevOf(elevDeg); }
  function showSpin() {
    const half = hud.spinPad.clientWidth / 2;
    hud.spinDot.style.transform = 'translate(' + (spinX * half).toFixed(1) + 'px,' + (-spinY * half).toFixed(1) + 'px)';
    hud.elevText.textContent = 'Cue raised ' + Math.round(elevDeg) + '°';
    if (document.activeElement !== hud.elevSlider) hud.elevSlider.value = String(elevDeg);
  }
  hud.elevSlider.min = String(Math.round(minElev)); hud.elevSlider.max = String(maxElev);

  /**
   * A player's action. Practice and the local match: applied on the next tick. Online: numbered, sent to the
   * other PC and queued here, and only when it is this player's turn and the table is free.
   * @returns {boolean} whether it was taken
   */
  function act(action, pull) {
    if (!online) { pending.push(action); return true; }
    if (!myTurnFree()) return false;
    const entry = { seq: ++sync.known, by: me, action, pull: pull || 0 };
    sync.queue.push(entry); sync.mine.push(entry);
    online.send(make.act(sync.game, entry.seq, me, action, entry.pull));
    return true;
  }
  function shotAction(pull) {
    const e = elev();
    return { type: 'shoot', dirX: Math.sin(yaw), dirZ: -Math.cos(yaw), speed: pullToSpeed(pull), offX: spinX, offY: spinY,
      elevSin: e.sin, elevCos: e.cos };
  }
  function queueShot(pull) {
    const shot = shotAction(pull), cb = state.balls[0];
    if (!act(shot, pull)) return false;
    view.strike(cb.x, cb.y, cb.z, { dirX: shot.dirX, dirZ: shot.dirZ, elevSin: shot.elevSin, elevCos: shot.elevCos, offX: shot.offX, offY: shot.offY, pull });
    if (controls.spin.resetAfterShot) setSpin(0, 0);
    if (controls.cue.resetAfterShot) setElev(minElev);
    return true;
  }
  function startPlacing() {
    ghost = { x: 0, z: geom.lineZ + (geom.halfL - geom.lineZ) * 0.5, ok: true };
    ghost.ok = canPlaceCue(state, data, ghost.x, ghost.z);
    if (!viewBeforePlace) viewBeforePlace = view.getMode();
    view.setMode('top');      // the whole table in sight while the cue ball is in hand (also when the view from above is off)
    showButtons();
  }
  function endPlacing() {
    ghost = null;
    if (online) sync.shown.ghost = null;
    if (viewBeforePlace) { view.setMode(viewBeforePlace); viewBeforePlace = null; showButtons(); }
  }
  /** @param {import('./rules/types.js').GameEvent[]} events */
  function onEvents(events) {
    if (!events.length) return;
    view.onEvents(events);
    playEvents(events);   // the sounds follow the hits
    lastEvents = events; eventCount += events.length;
    let foul = '';
    for (const e of events) {
      if (e.type === 'foul') foul = 'Foul: ' + (FOULS[e.reason] || e.reason) + '. ';
      else if (e.type === 'rerack') { message = 'The 8 went in on the break: racked again, ' + says(state.turn, 'breaks again', 'break again'); savePrev(); view.snapCamera(); }
      else if (e.type === 'turn') message = foul + (foul ? says(e.player, 'has the cue ball in hand', 'have the cue ball in hand') : NAMES[e.player] + ' to shoot');
      else if (e.type === 'gameOver') message = '';
    }
    for (const e of events) {
      if (e.type === 'settled' && state.phase === 'place') startPlacing();
    }
  }
  /** One tick of the rules with these actions. */
  function tick(acts) {
    savePrev();
    for (const a of acts) record.shots.push({ tick: state.tick, action: a });
    onEvents(step(state, data, acts));
  }

  function frame(ms) {
    if (!running) return;
    requestAnimationFrame(frame);
    let dt = Math.min(0.1, last ? (ms - last) / 1000 : TICK); last = ms;
    if (document.hidden) return;
    if (testFreeze > 0) { testClock += dt; if (testClock >= testFreeze) dt = 0; }   // test only: stop the clock at a moment
    const simDt = dt * testSpeed;

    const fromAbove = view.getMode() === 'top';
    const free = !online || myTurnFree();       // this player may act now
    input.setMode(!free ? 'watch' : state.phase === 'aim' ? (fromAbove ? 'point' : 'aim') : state.phase === 'place' ? 'place' : 'off');
    const inp = input.poll(dt);
    const target = isMatch && rules.shooterTarget ? rules.shooterTarget(state) : 'open';
    for (const name of inp.pressed) {
      if (name === 'rematch' && isMatch && state.phase === 'over') { if (online) pressRematch(); else rack(state.winner); continue; }
      if (name === 'switchView' && !ghost && allowTop && !(online && state.phase === 'place')) { view.setMode(view.getMode() === 'top' ? 'aim' : 'top'); showButtons(); }
      else if (name === 'aimHelp' && !online) { aimHelp = (aimHelp + 1) % AIM_HELP.length; showButtons(); }
      else if (name === 'rack' && !isMatch) rack();
      else if (name === 'exit') { if (online) online.leave(); stop(); o.onExit(); return; }
    }

    let pull = 0;
    if (free && state.phase === 'aim') {
      yaw += inp.aimDelta; pull = debugPull >= 0 ? debugPull : inp.pull;
      const cb = state.balls[0];
      if (inp.pointing && inp.pointerX >= 0) {
        // from above the cue points at the cursor
        const t = view.screenToTable(inp.pointerX, inp.pointerY);
        if (t && Math.hypot(t.x - cb.x, t.z - cb.z) > data.table.ball.radius) yaw = Math.atan2(t.x - cb.x, -(t.z - cb.z));
      }
      // tell the input which way the cue points on the screen, so pulling back follows the cue
      if (fromAbove) {
        const a = view.tableToScreen(cb.x, cb.z), b = view.tableToScreen(cb.x + Math.sin(yaw) * 0.3, cb.z - Math.cos(yaw) * 0.3);
        input.setPullAxis(b.x - a.x, b.y - a.y);
      } else input.setPullAxis(0, -1);
      if (inp.spinSet) setSpin(inp.spinSet.x, inp.spinSet.y);
      if (inp.spinDX || inp.spinDY) setSpin(spinX + inp.spinDX, spinY + inp.spinDY);
      if (inp.elevSet !== null) setElev(inp.elevSet);
      if (inp.elevDelta) setElev(elevDeg + inp.elevDelta);
      // on the 8 you call the pocket first: a click on a pocket calls it, and that click never shoots
      let called = false;
      if (target === 'eight' && inp.tap) {
        let best = -1, bestD = 46;
        for (let i = 0; i < geom.pockets.length; i++) {
          const s = view.tableToScreen(geom.pockets[i].x, geom.pockets[i].z), d = Math.hypot(s.x - inp.tap.x, s.y - inp.tap.y);
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) { act({ type: 'call', pocket: best }, 0); called = true; }
      }
      if (inp.shoot && !called) {
        if (target === 'eight' && state.calledPocket < 0) message = NAMES[state.turn] + ': call the pocket for the 8 first. Click a pocket';
        else queueShot(inp.shoot.pull);
      }
    } else if (free && state.phase === 'place' && ghost) {
      // the cue ball in hand follows the cursor
      const t = inp.pointerX >= 0 ? view.screenToTable(inp.pointerX, inp.pointerY) : null;
      if (t) { ghost.x = t.x; ghost.z = t.z; }
      const R = data.table.ball.radius;
      ghost.x = Math.max(-geom.halfW + R, Math.min(geom.halfW - R, ghost.x));
      ghost.z = Math.max(-geom.halfL + R, Math.min(geom.halfL - R, ghost.z));
      ghost.ok = canPlaceCue(state, data, ghost.x, ghost.z);
      if (inp.confirm && ghost.ok) {
        if (act({ type: 'place', x: ghost.x, z: ghost.z }, 0)) endPlacing();
      }
    }

    if (online) onlineTicks(simDt);
    else {
      acc += dt;
      while (acc >= TICK) {
        acc -= TICK;
        const acts = pending; pending = [];
        tick(acts);
      }
    }

    // what the cue looks like: this player's own, or online while the other player shoots, theirs (smoothed)
    let dirX = Math.sin(yaw), dirZ = -Math.cos(yaw), e = elev(), offX = spinX, offY = spinY, shownGhost = ghost;
    if (online && state.turn !== me) {
      smoothRemote(dt);
      const s = sync.shown;
      dirX = Math.sin(s.yaw); dirZ = -Math.cos(s.yaw); e = elevOf(s.elevDeg); offX = s.offX; offY = s.offY; pull = s.pull;
      shownGhost = s.ghost;
    } else if (online && free) sendAim(pull);
    const aiming = state.phase === 'aim';
    const contact = aiming && AIM_HELP[aimHelp] !== 'none' ? firstContact(state, data, dirX, dirZ) : null;

    if (isMatch) showMatch(target);
    const mine = aiming && free;
    hud.power.style.visibility = mine ? 'visible' : 'hidden';
    hud.spinBox.style.visibility = mine ? 'visible' : 'hidden';
    showSpin();
    hud.powerFill.style.width = (pull * 100).toFixed(1) + '%';
    hud.hint.textContent = online && !free ? watchHint()
      : state.phase === 'place'
        ? 'Cue ball in hand' + (state.placeBehindLine ? ' behind the line' : '') + ': move it with the mouse, click to put it down'
        : aiming
          ? (inp.power ? 'Power: move the mouse back to draw the cue · Left click: shoot · Right click: aim · Cue ball picture or W A S D: where the tip hits · Wheel: raise cue'
            : (inp.pointing ? 'Aiming: the cue points at the mouse' : inp.free ? 'Aiming: mouse left or right of the middle turns' : 'Aiming: move the mouse')
              + ' · Left or right click: back to power')
          : '';

    view.render({ state, prev, alpha: acc / TICK, dt, dirX, dirZ, elevSin: e.sin, elevCos: e.cos, offX, offY,
      pull, aimHelp: AIM_HELP[aimHelp], contact, ghost: state.phase === 'place' ? shownGhost : null });
  }

  /** The match part of the screen: whose turn, which balls, the small text line, the called pocket, the end. */
  function showMatch(target) {
    for (let p = 0; p < 2; p++) {
      const g = state.groups[p], left = rules.ballsLeft ? rules.ballsLeft(state, p) : 7;
      hud.who[p].classList.toggle('turn', state.phase !== 'over' && state.turn === p);
      hud.grp[p].textContent = g === 'open' ? 'open table' : left > 0 ? (g === 'solid' ? 'solids' : 'stripes') + ' · ' + left + ' left' : 'on the 8';
    }
    const over = state.phase === 'over';
    const theirs = online && state.turn !== me;
    let line = over ? '' : target === 'eight' && state.phase === 'aim' && state.calledPocket < 0 && !message.includes('call the pocket')
      ? (theirs ? NAMES[state.turn] + ' is on the 8 and calls a pocket' : says(state.turn, 'is on the 8: click a pocket to call it', 'are on the 8: click a pocket to call it')) : message;
    const netLine = online ? online.statusText() : '';
    if (netLine) line = netLine;
    hud.matchMsg.textContent = line;
    const mark = state.phase === 'aim' && state.calledPocket >= 0 ? geom.pockets[state.calledPocket] : null;
    hud.pocketMark.hidden = !mark;
    if (mark) { const s = view.tableToScreen(mark.x, mark.z); hud.pocketMark.style.left = s.x + 'px'; hud.pocketMark.style.top = s.y + 'px'; }
    if (hud.overPanel.hidden === over) {
      hud.overPanel.hidden = !over;
      if (over) {
        hud.overText.textContent = says(state.winner, 'wins', 'win');
        const why = state.overReason;
        hud.overWhy.textContent = why === 'eight' ? NAMES[state.winner] + ' ' + ENDS.eight : NAMES[1 - state.winner] + ' ' + (ENDS[why] || why);
        input.release();
      }
    }
    if (online && over) {
      const other = 1 - me;
      hud.overWait.textContent = sync.rematch[me] ? 'Waiting for the other player' : sync.rematch[other] ? 'Your friend wants a rematch' : '';
      hud.overWait.hidden = !hud.overWait.textContent;
      hud.rematchBtn.disabled = sync.rematch[me] || !online.up();
    }
  }
  /** The bottom line for the player who waits. */
  function watchHint() {
    if (online.statusText()) return '';
    const p = state.turn;
    if (state.phase === 'over') return '';
    if (p === me) return state.phase === 'rolling' ? '' : 'Your shot in a moment';
    if (state.phase === 'rolling') return '';
    return state.phase === 'place' ? 'Your friend has the cue ball in hand' : 'Your friend is aiming' + (allowTop ? ' · V: view from above' : '');
  }
  const labels = hud.who.map(w => w.querySelector('b'));
  const oldLabels = labels.map(b => (b ? b.textContent : ''));
  if (online) labels.forEach((b, i) => { if (b) b.textContent = NAMES[i]; });
  hud.matchBar.hidden = !isMatch; hud.matchMsg.hidden = !isMatch; hud.rackBtn.hidden = isMatch;
  hud.aimHelpBtn.hidden = !!online; hud.viewBtn.hidden = !allowTop;
  hud.pocketMark.hidden = true; hud.overPanel.hidden = true; hud.overWait.hidden = true; hud.rematchBtn.disabled = false;

  function stop() {
    if (!running) return;
    hud.matchBar.hidden = true; hud.matchMsg.hidden = true; hud.pocketMark.hidden = true; hud.overPanel.hidden = true; hud.rackBtn.hidden = false;
    hud.aimHelpBtn.hidden = false; hud.viewBtn.hidden = false; hud.overWait.hidden = true; hud.rematchBtn.disabled = false;
    labels.forEach((b, i) => { if (b) b.textContent = oldLabels[i]; });
    running = false;
    input.setMode('off'); input.release();
    view.dispose();
    delete window.GAME.debug.practice;
  }

  // ==================================================================================== online
  const T = online ? online.timing : null;
  const sync = {
    game: 0,
    known: 0,          // the highest action number known (applied or waiting)
    applied: 0,        // the number of the last action applied
    restDone: -1,      // the action whose rest point was handled last
    /** @type {{seq:number, by:number, action:Object, pull:number}[]} */
    queue: [],         // known, not yet applied
    /** @type {{seq:number, by:number, action:Object, pull:number}[]} */
    mine: [],          // this player's own actions (sent again after taking over the host's state)
    myHash: new Map(), hostHash: new Map(),
    mismatches: 0, checks: 0, adopted: 0,
    aimOut: { at: 0, sig: '' },
    /** @type {Object|null} */
    aimIn: null, aimInCount: 0,
    shown: { yaw: 0, pull: 0, offX: 0, offY: 0, elevDeg: minElev, ghost: null },
    rematch: [false, false],
  };

  /** This player may act now: their turn, the table at rest, nothing waiting, and the friend connected. */
  function myTurnFree() {
    return !!online && online.up() && state.turn === me && state.phase !== 'rolling' && state.phase !== 'over' && sync.queue.length === 0;
  }
  /** A new game of the match, numbered `game`. */
  function startOnlineGame(game, opts) {
    sync.game = game; sync.known = 0; sync.applied = 0; sync.restDone = -1;
    sync.queue = []; sync.mine = []; sync.myHash.clear(); sync.hostHash.clear();
    sync.aimIn = null; sync.rematch = [false, false];
    newGame(opts);
    sync.shown.yaw = 0; sync.shown.ghost = null;
  }
  /**
   * Online ticking: only while balls roll or to apply an action, so both PCs make the same ticks.
   * @param {number} dt
   */
  function onlineTicks(dt) {
    acc += dt;
    while (acc >= TICK) {
      if (state.phase === 'rolling') tick([]);
      else if (sync.queue.length) {
        const q = sync.queue.shift();
        sync.applied = q.seq;
        // an action is only used on its player's turn; both PCs check this on the same state, so they agree
        if (state.turn === q.by && state.phase !== 'over') {
          if (q.by !== me) showRemoteAction(q);
          tick([q.action]);
        } else { restPoint(); continue; }
      } else { acc = 0; savePrev(); break; }
      acc -= TICK;
      if (state.phase !== 'rolling') restPoint();
    }
    if (state.phase !== 'rolling') restPoint();
  }
  /** The other player's action is being applied here: their cue strokes, and the aim stays where they shot. */
  function showRemoteAction(q) {
    const a = q.action;
    if (a.type === 'shoot') {
      const cb = state.balls[0];
      view.strike(cb.x, cb.y, cb.z, { dirX: a.dirX, dirZ: a.dirZ, elevSin: a.elevSin, elevCos: a.elevCos, offX: a.offX, offY: a.offY, pull: q.pull });
      yaw = Math.atan2(a.dirX, -a.dirZ); sync.shown.yaw = yaw;
    } else if (a.type === 'place') endPlacing();
  }
  /** The table has come to rest after action `applied`: fingerprint it (the host sends it, the friend compares). */
  function restPoint() {
    if (sync.restDone === sync.applied) return;
    sync.restDone = sync.applied;
    if (state.phase !== 'place' && ghost) endPlacing();
    else if (state.phase === 'place' && !ghost) startPlacing();
    const h ={ seq: sync.applied, tick: state.tick, hash: hashState(state) };
    if (me === 0) {
      online.send(make.check(sync.game, h.seq, h.tick, h.hash));
      online.save(state.phase === 'over' ? null : snapshot());
    } else {
      sync.myHash.set(h.seq, h);
      compareChecks();
    }
  }
  /** Friend: compare my fingerprints with the host's; on a difference, ask for the host's state. */
  function compareChecks() {
    for (const [seq, hh] of sync.hostHash) {
      const mine = sync.myHash.get(seq);
      if (!mine) continue;
      sync.hostHash.delete(seq); sync.myHash.delete(seq);
      sync.checks++;
      if (mine.hash !== hh.hash || mine.tick !== hh.tick) {
        sync.mismatches++;
        console.info('[online] state differs from the host after action ' + seq + ' (tick ' + mine.tick + '/' + hh.tick + '): taking the host\'s state');
        online.send(make.needState(sync.game));
      }
    }
    // keep the lists short: anything far behind will never be matched
    for (const m of [sync.hostHash, sync.myHash]) for (const k of m.keys()) if (k < sync.applied - 20) m.delete(k);
  }
  /**
   * Host: everything the friend needs to carry on from here. The host's own state is swapped for its JSON copy
   * first, so both PCs hold exactly the same numbers (JSON turns -0 into 0).
   */
  function snapshot(forSending) {
    const copy = JSON.parse(JSON.stringify(state));
    if (forSending) { state = copy; savePrev(); }
    return {
      game: sync.game, opts: record.opts, settings: online.settings, state: forSending ? JSON.parse(JSON.stringify(copy)) : copy,
      seq: sync.applied, queue: sync.queue.map(q => ({ ...q })), rematch: { host: sync.rematch[0], guest: sync.rematch[1] },
    };
  }
  /**
   * Take over a state from the host (after a difference, a reconnect, or a saved match).
   * @param {Object} s       the state (already a fresh copy)
   * @param {number} seq     the host's last applied action
   * @param {Object[]} queue the host's actions still waiting
   */
  function adoptState(s, seq, queue) {
    state = s;
    sync.applied = seq;
    sync.restDone = state.phase === 'rolling' ? -1 : seq;   // a rolling state gets its fingerprint checked when it rests
    const waiting = (queue || []).filter(q => q && typeof q.seq === 'number' && q.seq > seq).map(q => ({ ...q }));
    let top = waiting.length ? waiting[waiting.length - 1].seq : seq;
    // my own actions the host does not have yet: number them on and send them again
    const known = new Set(waiting.map(q => q.seq));
    const resend = [];
    for (const m of sync.mine) {
      if (m.seq <= seq || known.has(m.seq)) continue;
      const again = { ...m, seq: ++top };
      waiting.push(again); resend.push(again);
    }
    sync.queue = waiting; sync.mine = waiting.filter(q => q.by === me);
    sync.known = top;
    sync.myHash.clear();
    for (const k of [...sync.hostHash.keys()]) if (k <= seq) sync.hostHash.delete(k);
    sync.adopted++;
    pending = []; acc = 0;
    savePrev(); view.snapCamera();
    if (state.phase === 'place') { if (!ghost) startPlacing(); } else if (ghost || viewBeforePlace) endPlacing();
    message = state.phase === 'over' ? '' : state.phase === 'place' ? says(state.turn, 'has the cue ball in hand', 'have the cue ball in hand')
      : state.phase === 'aim' ? NAMES[state.turn] + ' to shoot' : message;
    for (const r of resend) online.send(make.act(sync.game, r.seq, r.by, r.action, r.pull));
  }
  /** Rematch pressed here. */
  function pressRematch() {
    if (!online.up() || sync.rematch[me]) return;
    sync.rematch[me] = true;
    online.send(make.rematch(sync.game, true));
    maybeRematch();
  }
  /** Host: once both pressed Rematch, the next game starts, with the winner breaking. */
  function maybeRematch() {
    if (me !== 0 || !sync.rematch[0] || !sync.rematch[1] || state.phase !== 'over') return;
    const opts = { size, seed: (Date.now() % 4294967296) >>> 0, mode: 'match', foulRule: online.settings.foulRule, breaker: state.winner };
    const game = sync.game + 1;
    online.send(make.start(game, opts, online.settings));
    startOnlineGame(game, opts);
  }
  /** The shooter's cue, sent about 12 times a second (and once a second when it does not move). */
  function sendAim(pull) {
    if (!online.up() || state.turn !== me || (state.phase !== 'aim' && state.phase !== 'place')) return;
    const now = performance.now();
    if (now - sync.aimOut.at < 1000 / T.aimSendPerSec) return;
    const a = { yaw, pull, offX: spinX, offY: spinY, elevDeg, ghost: state.phase === 'place' && ghost ? { x: ghost.x, z: ghost.z, ok: !!ghost.ok } : null };
    const sig = [a.yaw.toFixed(4), a.pull.toFixed(3), a.offX.toFixed(3), a.offY.toFixed(3), a.elevDeg.toFixed(1), a.ghost ? a.ghost.x.toFixed(3) + ',' + a.ghost.z.toFixed(3) + a.ghost.ok : ''].join('|');
    if (sig === sync.aimOut.sig && now - sync.aimOut.at < T.aimResendMs) return;
    sync.aimOut.at = now; sync.aimOut.sig = sig;
    online.send(make.aim(sync.game, sync.applied, a));
  }
  /** Glide the other player's cue toward the newest values. */
  function smoothRemote(dt) {
    const t = sync.aimIn, s = sync.shown;
    if (!t || state.turn === me || t.seq !== sync.applied) return;   // only the cue of the turn being played now
    const k = 1 - Math.exp(-dt * (T ? T.aimSmoothing : 12));
    let d = t.yaw - s.yaw;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    s.yaw += d * k;
    s.pull += (t.pull - s.pull) * k; s.offX += (t.offX - s.offX) * k; s.offY += (t.offY - s.offY) * k; s.elevDeg += (t.elevDeg - s.elevDeg) * k;
    if (t.ghost) {
      if (!s.ghost) s.ghost = { x: t.ghost.x, z: t.ghost.z, ok: !!t.ghost.ok };
      else { s.ghost.x += (t.ghost.x - s.ghost.x) * k; s.ghost.z += (t.ghost.z - s.ghost.z) * k; s.ghost.ok = !!t.ghost.ok; }
    } else if (state.phase === 'place' && ghost) s.ghost = s.ghost || { ...ghost };
  }
  /**
   * A message from the other PC for the table (online.js passes these on).
   * @param {Object} msg  already checked by net/protocol.js validate()
   */
  function onMessage(msg) {
    if (!running) return;
    if (msg.type === 'start') { startOnlineGame(msg.game, msg.opts); return; }
    if (msg.type === 'resume') { carryOn(msg); return; }
    if (msg.game !== sync.game) return;   // from an earlier game of the match
    if (msg.type === 'act') {
      if (msg.seq <= sync.known || (msg.by !== 0 && msg.by !== 1)) return;
      sync.known = msg.seq;
      sync.queue.push({ seq: msg.seq, by: msg.by, action: msg.action, pull: msg.pull });
    } else if (msg.type === 'aim') { sync.aimIn = msg; sync.aimInCount++; }
    else if (msg.type === 'check' && me === 1) { sync.hostHash.set(msg.seq, msg); compareChecks(); }
    else if (msg.type === 'needState' && me === 0) {
      const s = snapshot(true);
      online.send(make.state(sync.game, s.seq, s.state, s.queue));
    } else if (msg.type === 'state' && me === 1) adoptState(msg.state, msg.seq, msg.queue);
    else if (msg.type === 'rematch') { sync.rematch[1 - me] = !!msg.want; maybeRematch(); }
  }
  /** Carry on from a 'resume' message or a saved match. */
  function carryOn(r) {
    if (r.game !== sync.game) {
      sync.game = r.game; sync.mine = []; sync.known = 0;
      record = { opts: r.opts, shots: [] };
    }
    adoptState(r.state, r.seq, r.queue);
    const rm = r.rematch || {};
    sync.rematch = [!!rm.host, !!rm.guest];
  }

  if (online) {
    if (online.resume) { newGame(online.resume.opts); carryOn(online.resume); }
    else startOnlineGame(online.game, online.opts);
  } else rack();
  showButtons();

  // ---- test only (look stage): set up a moment to look at, from the address
  let testFreeze = Number(testQ.get('freeze')) || 0, testClock = 0;
  if (testQ.get('view') === 'top' && allowTop) { view.setMode('top'); showButtons(); }
  if (testQ.get('cam')) view.setDebugCamera(/^[-\d.,]+$/.test(testQ.get('cam')) ? testQ.get('cam').split(',').map(Number) : testQ.get('cam'));
  if (testQ.get('aim')) yaw = Number(testQ.get('aim')) * Math.PI / 180;
  const look = online ? null : testQ.get('look'), put = (id, x, z) => { const b = state.balls[id]; b.x = x; b.z = z; b.y = data.table.ball.radius; savePrev(); };
  if (look === 'break') queueShot(1);
  if (look === 'raised') setElev(30);
  if (look === 'rail') { put(0, geom.halfW - 0.12, 0.62); yaw = -Math.PI / 2 + 0.25; }
  if (look === 'railClose') { put(0, geom.halfW - 0.045, 0.62); yaw = -Math.PI / 2 + 0.25; }
  if (look === 'pot') {   // ball 1 just short of the near right corner pocket, the cue ball behind it on the same line
    const p = geom.pockets[5], ux = Math.SQRT1_2, uz = Math.SQRT1_2;
    put(1, p.x - ux * 0.25, p.z - uz * 0.25); put(0, p.x - ux * 0.6, p.z - uz * 0.6);
    yaw = Math.atan2(ux, -uz); queueShot(Number(testQ.get('pull')) || 0.45);
  }
  if (testQ.get('info')) {   // test only: show the view's numbers on screen
    const box = document.body.appendChild(document.createElement('pre'));
    box.style.cssText = 'position:fixed;left:10px;top:60px;margin:0;color:#fff;background:#000c;font:14px monospace;padding:6px;z-index:9';
    setInterval(() => { box.textContent = JSON.stringify({ view: view.info(), audio: window.GAME.debug.audio() }, null, 1); }, 500);
  }
  requestAnimationFrame(frame);

  // debug helpers for the practice table (build rule: only under window.GAME.debug)
  window.GAME.debug.practice = {
    state: () => state,
    view: () => view.info(),
    events: () => ({ count: eventCount, last: lastEvents }),
    record: () => record,
    /** The table's shape: pockets, the line, the half length and width. */
    geom: () => ({ size, pockets: geom.pockets.map(p => ({ x: p.x, z: p.z, r: p.r, kind: p.kind })), lineZ: geom.lineZ, halfW: geom.halfW, halfL: geom.halfL, R: data.table.ball.radius }),
    /** Aim by degrees (0 = straight down the table, positive = right). */
    setAim(deg) { yaw = deg * Math.PI / 180; },
    aim: () => yaw * 180 / Math.PI,
    /** Where the tip hits (-1 to 1) and the cue angle in degrees. */
    setSpin(x, y) { setSpin(x, y); return { x: spinX, y: spinY }; },
    setElev(deg) { setElev(deg); return elevDeg; },
    spin: () => ({ x: spinX, y: spinY, elevDeg }),
    /** Test only: show this pull (0 to 1) instead of the mouse's; -1 gives the mouse back. */
    setPull(p) { debugPull = p; },
    /** Shoot with a pull of 0 to 1, as if the mouse had done it. Online: only on your turn (returns false otherwise). */
    shoot(pull) {
      if (state.phase !== 'aim') return online ? false : state.phase;
      const ok = queueShot(Math.max(0, Math.min(1, pull)));
      return online ? ok : state.phase;
    },
    place(x, z) {
      if (state.phase === 'place' && canPlaceCue(state, data, x, z) && (!online || myTurnFree())) { act({ type: 'place', x, z }, 0); endPlacing(); return true; }
      return false;
    },
    /** Test only: move the cue ball in hand as the mouse would. */
    moveGhost(x, z) { if (ghost) { ghost.x = x; ghost.z = z; ghost.ok = canPlaceCue(state, data, x, z); } return ghost; },
    /** Match only: call a pocket for the 8 (index into the table's pockets). */
    call(pocket) { return act({ type: 'call', pocket }, 0); },
    message: () => message,
    setView(m) { if (m !== 'top' || allowTop) view.setMode(m); showButtons(); return view.getMode(); },
    setAimHelp(name) { if (!online) aimHelp = Math.max(0, AIM_HELP.indexOf(name)); showButtons(); return AIM_HELP[aimHelp]; },
    rack,
    /** The replay check: run the recorded shots again from the start and compare the hash. Only meaningful while the balls are at rest. */
    replayCheck() {
      const live = hashState(state), again = runReplay(data, JSON.parse(JSON.stringify(record)));
      while (again.state.tick < state.tick) step(again.state, data, []);   // the live table has sat still for a while longer
      const replay = hashState(again.state);
      return { same: replay === live, live, replay, shots: record.shots.length, tick: state.tick, phase: state.phase };
    },
    // ---- online only
    /** Where this PC is: game, actions known/applied, tick, fingerprint, whose turn, and the check counters. */
    sync: () => ({ online: !!online, side: me, game: sync.game, known: sync.known, applied: sync.applied, restDone: sync.restDone,
      waiting: sync.queue.length, tick: state.tick, phase: state.phase, turn: state.turn, winner: state.winner, breaker: state.breaker,
      hash: hashState(state), atRest: state.phase !== 'rolling' && sync.queue.length === 0 && sync.restDone === sync.applied,
      free: online ? myTurnFree() : true, checks: sync.checks, mismatches: sync.mismatches, adopted: sync.adopted,
      rematch: sync.rematch.slice(), view: view.getMode(), allowTop, aimHelp: AIM_HELP[aimHelp] }),
    /** The newest cue values from the other player, and what is drawn now. */
    remoteAim: () => ({ last: sync.aimIn, count: sync.aimInCount, shown: { ...sync.shown, ghost: sync.shown.ghost ? { ...sync.shown.ghost } : null } }),
    /** Test only: nudge a ball so this PC's state differs (to see the host's state heal it). */
    corrupt() { const b = state.balls.find(x => x.id > 0 && x.where === 'table'); if (b) b.x += 1e-7; return !!b; },
    /** Online: press Rematch. */
    rematch() { if (state.phase === 'over') pressRematch(); return sync.rematch.slice(); },
    /** Lines on screen now. */
    lines: () => ({ top: hud.matchMsg.textContent, bottom: hud.hint.textContent, over: hud.overPanel.hidden ? '' : hud.overText.textContent + ' / ' + hud.overWhy.textContent + ' / ' + hud.overWait.textContent }),
  };

  return { stop, onMessage, snapshot: () => (online ? snapshot(true) : null), running: () => running,
    /** The settings screen: picture quality and felt colour, at once. This player's own view only. */
    setQuality(name) { if (running) view.setQuality(name); },
    setFelt(name) { if (running) view.setFelt(name); } };
}
