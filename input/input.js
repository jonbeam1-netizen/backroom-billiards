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
 * @property {{x:number, y:number}|null} tap   where a left click landed on the table this frame (pixels from its top left)
 * @property {{x:number, y:number}|null} spinSet   the hit point was clicked on the cue ball picture (-1 to 1, 1 = edge)
 * @property {number} spinDX       move the hit point by this much (right)
 * @property {number} spinDY       and this much (up)
 * @property {number|null} elevSet the cue angle was set on the slider, degrees
 * @property {number} elevDelta    raise the butt of the cue by this many degrees (negative lowers)
 * @property {string[]} pressed    names of buttons pressed this frame (bindButton, and keys with a name)
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
  /** @type {{x:number, y:number}|null} */
  let tap = null;              // where a left click landed on the table this frame (the game uses it to call a pocket)
  let axisX = 0, axisY = -1;   // the way the cue points on the screen; pulling back is moving the mouse against it
  /** @type {{pull:number}|null} */
  let shoot = null;
  /** @type {string[]} */
  let pressed = [];
  const keyNames = { v: 'switchView', V: 'switchView' };

  // spin and cue angle: where the tip hits the cue ball, and how far the butt of the cue is raised
  let spinDX = 0, spinDY = 0, elevDelta = 0;
  /** @type {{x:number, y:number}|null} */
  let spinSet = null;
  /** @type {number|null} */
  let elevSet = null;
  let spinUp = false, spinDown = false, spinLeft = false, spinRight = false;

  const captured = () => document.pointerLockElement === target;
  const aimOn = () => wanted && (mode === 'point' || (mode === 'aim' && (captured() || free)));

  function capture() {
    if (captured()) return;
    if (!target.requestPointerLock) { free = true; return; }
    try { const p = target.requestPointerLock(); if (p && p.catch) p.catch(() => { free = true; }); } catch (e) { free = true; }
    setTimeout(() => { if (!captured() && wanted && mode === 'aim') free = true; }, 250);
  }
  function uncapture() { if (captured() && document.exitPointerLock) document.exitPointerLock(); }
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
    if (mode === 'aim') { if (wanted) capture(); } else uncapture();
  }

  document.addEventListener('pointerlockerror', () => { free = true; });
  document.addEventListener('pointerlockchange', () => {
    if (captured()) free = false;
    else if (mode === 'aim' && !free) wanted = false;   // the mouse was freed with Esc: aiming is off
  });
  target.addEventListener('mouseleave', () => { pointerX = -1; pointerY = -1; });

  target.addEventListener('mousedown', e => {
    if (mode === 'off' || mode === 'watch') return;
    if (e.button === 0) {
      // one left click on the table shoots, and only from the power state; it does nothing else
      if (!captured()) { const r = target.getBoundingClientRect(); tap = { x: e.clientX - r.left, y: e.clientY - r.top }; }
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
    if (e.key === 'Shift') fine = true;
    else if (e.key === 'ArrowLeft') left = true;
    else if (e.key === 'ArrowRight') right = true;
    else if (e.key === 'w' || e.key === 'W') spinUp = true;
    else if (e.key === 's' || e.key === 'S') spinDown = true;
    else if (e.key === 'a' || e.key === 'A') spinLeft = true;
    else if (e.key === 'd' || e.key === 'D') spinRight = true;
    else if ((e.key === 'f' || e.key === 'F') && !e.repeat && mode !== 'off') {
      // F switches fine aim on and off at the table (the same switch as on the settings screen)
      fineLock = !fineLock;
      if (onFineToggle) onFineToggle(fineLock);
    }
    else if (!e.repeat && keyNames[e.key] && mode !== 'off') pressed.push(keyNames[e.key]);
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Shift') fine = false;
    else if (e.key === 'ArrowLeft') left = false;
    else if (e.key === 'ArrowRight') right = false;
    else if (e.key === 'w' || e.key === 'W') spinUp = false;
    else if (e.key === 's' || e.key === 'S') spinDown = false;
    else if (e.key === 'a' || e.key === 'A') spinLeft = false;
    else if (e.key === 'd' || e.key === 'D') spinRight = false;
  });
  window.addEventListener('blur', () => {
    dropHold(); fine = false; left = false; right = false;
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
      if (on) { wanted = false; pullPx = 0; uncapture(); }
      applyMode();
    },
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
      const f = {
        aimDelta: aim, pull: pullPx / controls.power.pullPixels, holding, shoot,
        aiming: aimOn(), free: stick, pointing: mode === 'point' && wanted,
        power: (mode === 'aim' || mode === 'point') && !wanted,
        pointerX, pointerY, confirm, pressed, tap,
        spinSet, spinDX, spinDY, elevSet, elevDelta,
      };
      aim = 0; shoot = null; confirm = false; pressed = []; tap = null;
      spinSet = null; spinDX = 0; spinDY = 0; elevSet = null; elevDelta = 0;
      return f;
    },
  };
}
