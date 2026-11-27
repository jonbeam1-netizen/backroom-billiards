// The one input layer (build rule 9). It turns the mouse and keyboard into actions:
// aim, pull back, shoot, set spin, raise the cue, switch view, move and put down the cue ball in hand,
// and named buttons. No other file looks at keys or the mouse. Touch is added here later, giving the
// same actions.
//
// How the mouse works (Jon's choices, 2026-11-23):
// - There are two states. The default is the power state: the aim is fixed and moving the mouse back
//   along the cue draws the cue back (more power), forward eases it off; no button is held. One left
//   click on the table shoots at that power. A left click does nothing else (apart from page buttons
//   and the cue ball picture).
// - A right click on the table goes to aiming: the power goes back to nothing and the mouse aims.
//   A left click or another right click goes back to the power state (that left click never shoots).
// - After every shot, and when you come to the table, you are in the power state.
// - Behind the ball ('aim' mode) the mouse turns the aim. In a normal browser the game captures the
//   mouse for that. Where the browser refuses (the Claude app's preview pane), the free cursor works
//   like a stick: still in the middle of the screen, turning faster the further left or right it is.
// - From above ('point' mode) the cue points at the cursor.
// - 'watch' mode (online, while the other player shoots): the mouse does nothing on the table; named keys
//   (V for the view) and page buttons still work.
// - Page buttons and text fields outside the table (title, lobby) are bound here too: bindPageButton, bindTextField.
//   The settings screen uses bindPageButton, bindSlider and bindPageKey (Esc closes it).
// - Settings: aim sensitivity multiplies every turning rate (setAimSpeed); fine aim can be kept on without Shift
//   (setFineAim, or the F key at the table). While the settings are open over the table, setPaused(true) makes
//   the table take nothing.
// - Peek (item 34): while the spacebar is held at the table, the frame says `peek` (the view lifts the camera a
//   little). At the table the spacebar never reaches the page: it cannot click a button that has focus or scroll.
// - Look around (item 33): while setLook(true) (the balls roll and the view is behind the ball), moving the mouse
//   gives `lookDelta`, a turn of the view only; it never changes the aim, the power or the shot. In a normal browser
//   the mouse is captured for it (a click on the table captures it again if the browser asked for one); where the
//   browser refuses, the free cursor works like the aiming stick, but only after it has been moved, so the view
//   never turns by itself.
// - Nudge (item 41): W A S D set the hit point while aiming ('aim' or 'point' mode), as before. In any other mode
//   (the balls roll: 'off', or 'watch' online) a fresh press gives `nudge:up`, `nudge:down`, `nudge:left` or
//   `nudge:right` in `pressed` (the way the key points on the screen), never while typing or while a panel is open,
//   once per press (auto-repeat gives nothing). A key held across a change of mode does nothing until pressed
//   again. The table turns the screen way into a table way (view.screenWayToTable) and the rules decide.

/** True while the player is typing in a text field: the table's keys must not react then. @param {Event} e */
function typing(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  return !!t && t.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (t).type === 'text';
}

/**
 * A page button outside the table (title, lobby): calls fn on each click.
 * @param {HTMLElement} el
 * @param {() => void} fn
 */
export function bindPageButton(el, fn) {
  el.addEventListener('click', () => { el.blur(); fn(); });
}

/**
 * A slider (range input) on a page panel: onChange gets its value as a number while it moves.
 * It lets go of the keyboard focus when the change is done, so the table's keys work again.
 * @param {HTMLInputElement} el
 * @param {(value:number) => void} onChange
 */
export function bindSlider(el, onChange) {
  el.addEventListener('input', () => onChange(Number(el.value)));
  el.addEventListener('change', () => el.blur());
}

/**
 * A key on the page (outside the table's own keys), by KeyboardEvent.key: calls fn when it goes down.
 * Not while the player types in a text field. fn may return false to say the key was not used.
 * @param {string} key
 * @param {() => (boolean|void)} fn
 */
export function bindPageKey(key, fn) {
  window.addEventListener('keydown', e => {
    if (e.key !== key || e.repeat || typing(e)) return;
    if (fn() !== false) e.preventDefault();
  });
}

/**
 * A text field. `clean` may rewrite what was typed (for example upper case, allowed letters only);
 * onChange gets the cleaned text after every change, onEnter runs when Enter is pressed in the field.
 * @param {HTMLInputElement} el
 * @param {{clean?:(text:string)=>string, onChange?:(text:string)=>void, onEnter?:(text:string)=>void}} o
 */
export function bindTextField(el, o) {
  el.addEventListener('input', () => {
    const v = o.clean ? o.clean(el.value) : el.value;
    if (v !== el.value) el.value = v;
    if (o.onChange) o.onChange(v);
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); if (o.onEnter) o.onEnter(el.value); }
  });
}

/**
 * @typedef {Object} InputFrame
 * @property {number} aimDelta     how far to turn the aim this frame, radians (positive = to the right)
 * @property {number} pull         how far the cue is drawn back, 0 to 1
 * @property {boolean} holding     always false now (kept for older callers)
 * @property {boolean} power       the power state: the mouse draws the cue back, a left click shoots
 * @property {{pull:number}|null} shoot   set on the frame the shot is let go
 * @property {boolean} aiming      aiming is on
 * @property {boolean} free        aiming with the free cursor as a stick (the browser would not capture the mouse)
 * @property {boolean} pointing    'point' mode and aiming is on: the cue should point at the cursor
 * @property {number} pointerX     the cursor over the table, pixels from its left edge, or -1 when it is elsewhere
 * @property {number} pointerY     and from its top edge
 * @property {boolean} confirm     cue ball in hand: put it down
 * @property {{x:number, y:number}|null} spinSet   the hit point was clicked on the cue ball picture (-1 to 1, 1 = edge)
 * @property {number} spinDX       move the hit point by this much (right)
 * @property {number} spinDY       and this much (up)
 * @property {number|null} elevSet the cue angle was set on the slider, degrees
 * @property {number} elevDelta    raise the butt of the cue by this many degrees (negative lowers)
 * @property {string[]} pressed    names of buttons pressed this frame (bindButton, and keys with a name)
 * @property {boolean} peek        the spacebar is held at the table (lift the camera a little)
 * @property {number} lookDelta    while looking around: turn the view by this much, radians (positive = right); never the aim
 * @property {boolean} looking     looking around is on (setLook)
 * @property {boolean} lookCaptured  and the mouse is captured for it (else the free cursor works as a stick)
 */

/**
 * @param {HTMLElement} target   the element that takes the mouse (the game canvas)
 * @param {Object} controls      data/controls.json
 */
export function createInput(target, controls) {
  /** @type {'off'|'aim'|'point'|'place'|'watch'} */
  let mode = 'off';
  /** @type {'off'|'aim'|'point'|'place'|'watch'} */
  let asked = 'off';           // the mode the table asked for; `mode` is 'off' instead while a panel is open
  let paused = false;          // a panel (settings) is open over the table: the table takes no mouse or keys
  // the settings screen: aim sensitivity (a multiplier on every turning rate) and fine aim kept on without Shift
  let aimSpeed = 1, fineLock = false;
  /** @type {((on:boolean) => void)|null} */
  let onFineToggle = null;
  let wanted = false;          // aiming is on (right click toggles it)
  let free = false;            // the browser would not capture the mouse: aim with the free cursor
  let aim = 0, pullPx = 0, holding = false, confirm = false, fine = false;
  let left = false, right = false;
  let pointerX = -1, pointerY = -1;
  let axisX = 0, axisY = -1;   // the way the cue points on the screen; pulling back is moving the mouse against it
  /** @type {{pull:number}|null} */
  let shoot = null;
  /** @type {string[]} */
  let pressed = [];
  const keyNames = { v: 'switchView', V: 'switchView' };
  /** W A S D: the way each key points on the screen (up = away from the camera / up the screen). */
  const WASD = { w: 'up', W: 'up', s: 'down', S: 'down', a: 'left', A: 'left', d: 'right', D: 'right' };

  // spin and cue angle: where the tip hits the cue ball, and how far the butt of the cue is raised
  let spinDX = 0, spinDY = 0, elevDelta = 0;
  /** @type {{x:number, y:number}|null} */
  let spinSet = null;
  /** @type {number|null} */
  let elevSet = null;
  let spinUp = false, spinDown = false, spinLeft = false, spinRight = false;

  // peek and look around
  let tableOn = false;         // the table is open (setTable): the spacebar belongs to the game
  let peek = false;            // the spacebar is held
  let look = false;            // looking around while the balls roll (setLook)
  let lookPx = 0;              // captured mouse: sideways movement since the last poll, pixels
  let lookCurX = -1;           // free cursor: where it is over the table, or -1
  let lookFromX = -1, lookFromY = -1, lookArmed = false;   // free cursor: it turns only after moving armPixels
  let lookRefused = false;     // the browser would not capture the mouse for looking, this roll
  /** What the last capture request was for: a refusal while looking must not switch the aiming to the free cursor. */
  let lockFor = '';
  const lookCfg = controls.camera.look || { radPerPixel: 0.0022, stickRadPerSec: 2.4, armPixels: 6 };

  const captured = () => document.pointerLockElement === target;
  const aimOn = () => wanted && (mode === 'point' || (mode === 'aim' && (captured() || free)));

  function capture() {
    if (captured()) return;
    lockFor = 'aim';
    if (!target.requestPointerLock) { free = true; return; }
    try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(() => { if (lockFor === 'aim') free = true; }); } catch (e) { free = true; }
    setTimeout(() => { if (!captured() && wanted && mode === 'aim') free = true; }, 250);
  }
  /** Capture the mouse for looking around, where the browser allows it. A refusal leaves the free cursor for this roll. */
  function captureLook() {
    if (captured() || free || lookRefused || !target.requestPointerLock) return;
    lockFor = 'look';
    try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(() => { if (lockFor === 'look') lookRefused = true; }); } catch (e) { lookRefused = true; }
  }
  function uncapture() { if (captured() && document.exitPointerLock) document.exitPointerLock(); }
  /** @param {boolean} on */
  function setLook(on) {
    on = !!on && !paused && tableOn;
    if (on === look) return;
    look = on; lookPx = 0; lookCurX = -1; lookFromX = -1; lookFromY = -1; lookArmed = false; lookRefused = false;
    if (on) captureLook();
    else if (captured() && lockFor === 'look') uncapture();
  }
  function dropHold() { holding = false; pullPx = 0; }
  /**
   * How fast the aim turns, after the aim sensitivity and fine aim (Shift held, or kept on in the settings).
   * At sensitivity 1 with fine aim off these are exactly the numbers in data/controls.json.
   * @param {'mouse'|'key'|'stick'} way   captured mouse (radians a pixel), arrow keys or the free-cursor stick (radians a second)
   */
  function rate(way) {
    const base = way === 'mouse' ? controls.aim.radPerPixel : way === 'key' ? controls.aim.keyRadPerSec : controls.aim.centerRadPerSec;
    return base * turnFactor();
  }
  /** The share of the base turning rate in use now: fine aim times the aim sensitivity (1 at the defaults). */
  function turnFactor() { return ((fine || fineLock) ? controls.aim.fineFactor : 1) * aimSpeed; }
  /** Switches to the mode in effect: the one asked for, or 'off' while a panel is open. */
  function applyMode() {
    const m = paused ? 'off' : asked;
    if (m === mode) return;
    mode = m; dropHold(); confirm = false; shoot = null;
    // W A S D mean the hit point only while aiming and the nudge otherwise: a key held across the change does
    // nothing until it is pressed again
    spinUp = spinDown = spinLeft = spinRight = false;
    if (mode === 'aim') { if (wanted) capture(); } else uncapture();
  }

  document.addEventListener('pointerlockerror', () => { if (lockFor === 'look') lookRefused = true; else free = true; });
  document.addEventListener('pointerlockchange', () => {
    if (captured()) free = false;
    else if (mode === 'aim' && !free) wanted = false;   // the mouse was freed with Esc: aiming is off
  });
  target.addEventListener('mouseleave', () => { pointerX = -1; pointerY = -1; lookCurX = -1; });

  target.addEventListener('mousedown', e => {
    // looking around: a left click on the table captures the mouse again (the browser wants a click for that)
    if (look && e.button === 0 && !captured()) { lookRefused = false; captureLook(); }
    if (mode === 'off' || mode === 'watch') return;
    if (e.button === 0) {
      // one left click on the table shoots, and only from the power state; it does nothing else
      if (mode === 'place') confirm = true;
      else if ((mode === 'aim' || mode === 'point') && wanted) {
        // a left click while aiming goes back to the power state (Jon, 2026-11-23); it never shoots
        wanted = false; pullPx = 0;
        if (mode === 'aim') uncapture();
      } else if ((mode === 'aim' || mode === 'point') && !wanted) {
        const share = pullPx / controls.power.pullPixels;
        if (share >= controls.power.minPullToShoot) { shoot = { pull: Math.min(1, share) }; pullPx = 0; }
      }
    } else if (e.button === 2) {
      if (mode === 'aim' || mode === 'point') {
        wanted = !wanted;                         // right click: power state <-> aiming
        pullPx = 0;                               // the power starts from nothing each time
        if (mode === 'aim') { if (wanted) capture(); else uncapture(); }
      }
    }
  });
  target.addEventListener('wheel', e => {
    if (mode !== 'aim' && mode !== 'point') return;
    e.preventDefault();
    elevDelta += (e.deltaY < 0 ? 1 : -1) * controls.cue.wheelStepDeg;   // wheel up raises the butt of the cue
  }, { passive: false });
  window.addEventListener('mousemove', e => {
    if (look) {
      // looking around: the captured mouse turns the view by its movement; the free cursor works as a stick
      // once it has been moved a little (see poll)
      if (captured()) lookPx += e.movementX || 0;
      else if (e.target === target) {
        const r = target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (lookFromX < 0) { lookFromX = x; lookFromY = y; }
        else if (!lookArmed && Math.hypot(x - lookFromX, y - lookFromY) >= lookCfg.armPixels) lookArmed = true;
        lookCurX = x;
      } else lookCurX = -1;
    }
    if (mode === 'off' || mode === 'watch') return;
    const dx = e.movementX || 0, dy = e.movementY || 0;
    if (!captured() && e.target === target) {
      const r = target.getBoundingClientRect();
      pointerX = e.clientX - r.left; pointerY = e.clientY - r.top;
    } else { pointerX = -1; pointerY = -1; }
    // power state: moving the mouse back along the cue draws it back, forward eases it off (no button held)
    if ((mode === 'aim' || mode === 'point') && !wanted) {
      if (e.target === target) pullPx = Math.max(0, Math.min(controls.power.pullPixels, pullPx - (dx * axisX + dy * axisY)));
    } else if (mode === 'aim' && wanted && captured()) aim += dx * controls.aim.radPerPixel * turnFactor();
  });
  target.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (typing(e)) return;
    // the spacebar at the table is the peek, and nothing else: it must not click a page button or scroll the page
    if (e.key === ' ' && tableOn && !paused) { e.preventDefault(); peek = true; return; }
    if (e.key === 'Shift') fine = true;
    else if (e.key === 'ArrowLeft') left = true;
    else if (e.key === 'ArrowRight') right = true;
    else if (WASD[e.key]) {
      const k = WASD[e.key];
      if (mode === 'aim' || mode === 'point') {
        // aiming: W A S D move the hit point while held. Only a fresh press counts, so a key still held from the
        // roll (or from before a panel) does not start moving the dot by itself.
        if (!e.repeat) { if (k === 'up') spinUp = true; else if (k === 'down') spinDown = true; else if (k === 'left') spinLeft = true; else spinRight = true; }
      } else if (!e.repeat && tableOn && !paused) {
        // not aiming (the balls roll, or the other player's turn online): the same keys nudge (item 41), one per
        // fresh press. The table turns the screen way into a table way and the rules decide whether it counts.
        pressed.push('nudge:' + k);
      }
    }
    else if ((e.key === 'f' || e.key === 'F') && !e.repeat && mode !== 'off') {
      // F switches fine aim on and off at the table (the same switch as on the settings screen)
      fineLock = !fineLock;
      if (onFineToggle) onFineToggle(fineLock);
    }
    else if (!e.repeat && keyNames[e.key] && mode !== 'off') pressed.push(keyNames[e.key]);
  });
  window.addEventListener('keyup', e => {
    // a button that has focus is clicked when the spacebar comes up: stop that too
    if (e.key === ' ') { if (peek || (tableOn && !paused)) e.preventDefault(); peek = false; }
    else if (e.key === 'Shift') fine = false;
    else if (e.key === 'ArrowLeft') left = false;
    else if (e.key === 'ArrowRight') right = false;
    else if (e.key === 'w' || e.key === 'W') spinUp = false;
    else if (e.key === 's' || e.key === 'S') spinDown = false;
    else if (e.key === 'a' || e.key === 'A') spinLeft = false;
    else if (e.key === 'd' || e.key === 'D') spinRight = false;
  });
  window.addEventListener('blur', () => {
    dropHold(); fine = false; left = false; right = false; peek = false;
    spinUp = spinDown = spinLeft = spinRight = false;
  });

  return {
    /**
     * 'aim': the mouse turns the aim (behind the ball). 'point': the cue points at the cursor (from above).
     * 'place': the cue ball in hand follows the cursor. 'watch': only named keys and buttons. 'off': nothing.
     * @param {'off'|'aim'|'point'|'place'|'watch'} m
     */
    setMode(m) {
      asked = m;
      applyMode();
    },
    /**
     * A panel (the settings) is open over the table: the table takes no clicks, mouse moves or keys until it closes.
     * Opening one lets the mouse go and goes back to the power state, as Esc does.
     * @param {boolean} on
     */
    setPaused(on) {
      if (on === paused) return;
      paused = on;
      if (on) { wanted = false; pullPx = 0; peek = false; setLook(false); uncapture(); }
      applyMode();
    },
    /**
     * The table is open (true) or closed (false). While it is open the spacebar is the peek.
     * @param {boolean} on
     */
    setTable(on) {
      tableOn = !!on;
      if (!tableOn) { peek = false; setLook(false); }
    },
    /**
     * Looking around: on while the balls roll and the view is behind the ball. The mouse then turns the view only.
     * Turning it off lets go of a mouse captured for it.
     * @param {boolean} on
     */
    setLook(on) { setLook(on); },
    /** Aim sensitivity: a multiplier on every turning rate (captured mouse, free-cursor stick, arrow keys). @param {number} k */
    setAimSpeed(k) { aimSpeed = Number.isFinite(k) && k > 0 ? k : 1; },
    /** Fine aim kept on without holding Shift. @param {boolean} on */
    setFineAim(on) { fineLock = !!on; },
    fineAim: () => fineLock,
    /** Called when the F key switches fine aim at the table. @param {(on:boolean) => void} fn */
    onFineAim(fn) { onFineToggle = fn; },
    /** For window.GAME.debug: the turning rates in use now, and what makes them. */
    aimRates: () => ({ mouse: rate('mouse'), key: rate('key'), stick: rate('stick'), aimSpeed, fineLock, shift: fine, paused, mode }),
    /**
     * The way the cue points on the screen (x right, y down), so "pull back" follows the cue in any view.
     * Ignored while a pull is in progress.
     * @param {number} x
     * @param {number} y
     */
    setPullAxis(x, y) {
      const len = Math.hypot(x, y);
      if (len > 1e-6) { axisX = x / len; axisY = y / len; } else { axisX = 0; axisY = -1; }
    },
    /** Let the mouse go (for menus). */
    release() { uncapture(); },
    /**
     * A page button that gives a named action.
     * @param {HTMLElement} el
     * @param {string} name
     */
    bindButton(el, name) { el.addEventListener('click', () => { pressed.push(name); el.blur(); }); },
    /**
     * The picture of the cue ball: click or drag on it to choose where the tip hits.
     * Gives spinSet with x (right) and y (up) from -1 to 1, 1 being the edge of the ball.
     * @param {HTMLElement} el   a round element
     */
    bindSpinPad(el) {
      let dragging = false;
      const at = e => {
        const r = el.getBoundingClientRect(), half = r.width / 2;
        spinSet = { x: (e.clientX - r.left - half) / half, y: -(e.clientY - r.top - half) / half };
      };
      el.addEventListener('mousedown', e => { if (e.button === 0 && (mode === 'aim' || mode === 'point')) { dragging = true; at(e); e.preventDefault(); } });
      window.addEventListener('mousemove', e => { if (dragging) at(e); });
      window.addEventListener('mouseup', () => { dragging = false; });
    },
    /**
     * A slider for how far the butt of the cue is raised, in degrees.
     * @param {HTMLInputElement} el
     */
    bindElevation(el) {
      el.addEventListener('input', () => { if (mode === 'aim' || mode === 'point') elevSet = Number(el.value); });
      el.addEventListener('change', () => el.blur());
    },
    /**
     * Everything since the last call. Call once per frame.
     * @param {number} dt seconds since the last frame
     * @returns {InputFrame}
     */
    poll(dt) {
      const stick = mode === 'aim' && wanted && free && !captured();
      if ((mode === 'aim' || mode === 'point') && !holding) {
        const slow = turnFactor();   // fine aim and the aim sensitivity (exactly 1 at the defaults)
        if (wanted) aim += ((right ? 1 : 0) - (left ? 1 : 0)) * controls.aim.keyRadPerSec * dt * slow;
        const sk = controls.spin.keyPerSec * dt;
        spinDX += ((spinRight ? 1 : 0) - (spinLeft ? 1 : 0)) * sk;
        spinDY += ((spinUp ? 1 : 0) - (spinDown ? 1 : 0)) * sk;
        if (stick && pointerX >= 0) {
          // the free cursor works like a stick: in the middle of the screen the aim stands still, and the
          // further left or right of the middle it is, the faster the aim turns that way
          const half = (target.clientWidth || 2) / 2, dead = controls.aim.centerDeadShare;
          const n = Math.max(-1, Math.min(1, (pointerX - half) / half)), size = Math.abs(n);
          if (size > dead) {
            const share = (size - dead) / (1 - dead);
            aim += (n < 0 ? -1 : 1) * Math.pow(share, controls.aim.centerCurve) * controls.aim.centerRadPerSec * dt * slow;
          }
        }
      }
      // looking around: a turn of the view only (aim sensitivity applies, fine aim does not)
      let lookDelta = 0;
      if (look) {
        lookDelta += lookPx * lookCfg.radPerPixel * aimSpeed;
        if (!captured() && lookArmed && lookCurX >= 0) {
          const half = (target.clientWidth || 2) / 2, dead = controls.aim.centerDeadShare;
          const n = Math.max(-1, Math.min(1, (lookCurX - half) / half)), size = Math.abs(n);
          if (size > dead) lookDelta += (n < 0 ? -1 : 1) * Math.pow((size - dead) / (1 - dead), controls.aim.centerCurve) * lookCfg.stickRadPerSec * dt * aimSpeed;
        }
      }
      lookPx = 0;
      const f = {
        aimDelta: aim, pull: pullPx / controls.power.pullPixels, holding, shoot,
        aiming: aimOn(), free: stick, pointing: mode === 'point' && wanted,
        power: (mode === 'aim' || mode === 'point') && !wanted,
        pointerX, pointerY, confirm, pressed,
        spinSet, spinDX, spinDY, elevSet, elevDelta,
        peek: peek && tableOn && !paused, lookDelta, looking: look, lookCaptured: look && captured(),
      };
      aim = 0; shoot = null; confirm = false; pressed = [];
      spinSet = null; spinDX = 0; spinDY = 0; elevSet = null; elevDelta = 0;
      return f;
    },
  };
}
