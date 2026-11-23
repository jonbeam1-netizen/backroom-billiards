// The settings screen: a felt panel over the title or the table. It shows this player's choices and passes every
// change on to main.js at once (main.js applies it and saves it). Nothing here is sent to the other player.
// All mouse and keyboard handling goes through input/input.js.
import { bindPageButton, bindSlider, bindPageKey } from './input/input.js';
import { AIM_SPEED_MIN, AIM_SPEED_MAX } from './save.js';

// The aim sensitivity slider runs 0 to 100 on a curve (each step is the same share faster), so 1x sits near the
// middle and the slow end is as easy to set as the fast end.
const SPAN = AIM_SPEED_MAX / AIM_SPEED_MIN;
/** Slider position 0 to 100 -> sensitivity, rounded to 0.05. @param {number} t */
export function sliderToAimSpeed(t) {
  const v = AIM_SPEED_MIN * Math.pow(SPAN, Math.max(0, Math.min(100, t)) / 100);
  return Math.max(AIM_SPEED_MIN, Math.min(AIM_SPEED_MAX, Math.round(v * 20) / 20));
}
/** Sensitivity -> slider position 0 to 100. @param {number} v */
export function aimSpeedToSlider(v) {
  return Math.round(Math.log(Math.max(AIM_SPEED_MIN, Math.min(AIM_SPEED_MAX, v)) / AIM_SPEED_MIN) / Math.log(SPAN) * 100);
}

/**
 * @typedef {Object} ShownChoices   what the panel shows
 * @property {number} volume        0 to 1
 * @property {boolean} muted        the player's own sound switch
 * @property {boolean} forcedMute   ?mute=1: sound is off for this run whatever the switch says
 * @property {number} aimSpeed
 * @property {boolean} fineAim
 * @property {string} quality       in use now (the address may have set it for this run)
 * @property {string} felt
 * @property {boolean} lookFromAddress   quality or felt was set by the address for this run
 */

/**
 * @param {Object} o
 * @param {Object<string, HTMLElement>} o.ui            the panel's elements (see index.html)
 * @param {() => ShownChoices} o.get
 * @param {(name:string, value:any) => void} o.set     a choice was changed on the panel
 * @param {(open:boolean) => void} o.onOpenChange      the panel opened or closed
 */
export function createSettingsScreen(o) {
  const ui = o.ui;
  let open = false;

  const vol = /** @type {HTMLInputElement} */ (ui.volSlider);
  const aimS = /** @type {HTMLInputElement} */ (ui.aimSlider);
  bindSlider(vol, v => { o.set('volume', Math.max(0, Math.min(100, v)) / 100); draw(); });
  bindSlider(aimS, t => { o.set('aimSpeed', sliderToAimSpeed(t)); draw(); });
  bindPageButton(ui.soundBtn, () => { o.set('muted', !o.get().muted); draw(); });
  bindPageButton(ui.fineBtn, () => { o.set('fineAim', !o.get().fineAim); draw(); });
  for (const b of ui.qualityChoice.querySelectorAll('button')) bindPageButton(b, () => { o.set('quality', b.dataset.v); draw(); });
  for (const b of ui.feltChoice.querySelectorAll('button')) bindPageButton(b, () => { o.set('felt', b.dataset.v); draw(); });
  bindPageButton(ui.doneBtn, () => close());
  bindPageKey('Escape', () => { if (!open) return false; close(); });

  /** Shows the current choices on the panel. */
  function draw() {
    const s = o.get();
    if (document.activeElement !== vol) vol.value = String(Math.round(s.volume * 100));
    ui.volVal.textContent = Math.round(s.volume * 100) + '%';
    ui.soundBtn.textContent = s.forcedMute ? 'Off' : (s.muted ? 'Off' : 'On');
    ui.soundBtn.setAttribute('aria-pressed', String(!s.muted && !s.forcedMute));
    /** @type {HTMLButtonElement} */ (ui.soundBtn).disabled = s.forcedMute;
    ui.soundNote.hidden = !s.forcedMute;
    if (document.activeElement !== aimS) aimS.value = String(aimSpeedToSlider(s.aimSpeed));
    ui.aimVal.textContent = s.aimSpeed.toFixed(2) + 'x';
    ui.fineBtn.textContent = s.fineAim ? 'On' : 'Off';
    ui.fineBtn.setAttribute('aria-pressed', String(s.fineAim));
    for (const b of ui.qualityChoice.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === s.quality));
    for (const b of ui.feltChoice.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === s.felt));
    ui.lookNote.hidden = !s.lookFromAddress;
  }
  function show() {
    if (open) { draw(); return; }
    open = true;
    draw();
    ui.layer.hidden = false;
    document.body.classList.add('settings-open');
    o.onOpenChange(true);
  }
  function close() {
    if (!open) return;
    open = false;
    if (document.activeElement && ui.layer.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
    ui.layer.hidden = true;
    document.body.classList.remove('settings-open');
    o.onOpenChange(false);
  }

  return {
    open: show, close, draw,
    isOpen: () => open,
    /** For window.GAME.debug: what the panel shows now. */
    shown: () => ({
      open, volume: ui.volVal.textContent, volumeSlider: Number(vol.value), sound: ui.soundBtn.textContent, soundDisabled: /** @type {HTMLButtonElement} */ (ui.soundBtn).disabled,
      soundNote: !ui.soundNote.hidden, aim: ui.aimVal.textContent, aimSlider: Number(aimS.value), fineAim: ui.fineBtn.textContent,
      quality: [...ui.qualityChoice.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.v).join(','),
      felt: [...ui.feltChoice.querySelectorAll('button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.v).join(','),
      lookNote: !ui.lookNote.hidden,
    }),
  };
}
