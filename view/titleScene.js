// The picture behind the title screen: the real table under its lamp, the balls racked, the camera drifting slowly
// round the rack. Uses the same table, balls and light as the game (stage.js).
import * as THREE from '../lib/three.module.min.js';
import { createStage } from './stage.js';
import { buildTable, createGame } from '../rules/index.js';

/**
 * Starts drawing on the given canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {{quality?:'low'|'medium'|'high', felt?:'green'|'blue'|'red'}} [opts]
 * @returns {{info: () => object, stop: () => void, setQuality: (name:string) => void, setFelt: (name:string) => void}}
 */
export function startTitleScene(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x020101);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.02, 30);
  let stage = null, running = true, frames = 0, geom = null, t0 = -1;

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // the same numbers the game uses
  const get = name => fetch(new URL('../data/' + name + '.json', import.meta.url)).then(r => r.json());
  Promise.all([get('table'), get('physics'), get('controls')]).then(([table, physics, controls]) => {
    if (!running) return;
    const data = { table, physics };
    geom = buildTable(data, table.defaultSize);
    const state = createGame(data, { size: table.defaultSize, seed: 20261123, mode: 'practice' });
    stage = createStage(renderer, geom, table, { cueLength: controls.cue.length, quality: opts.quality || 'high', felt: opts.felt || 'green' });
    stage.occ.uniforms.occInvView.value = camera.matrixWorld;
    resize();
    const R = table.ball.radius;
    for (let i = 0; i < 16; i++) {
      const b = state.balls[i], m = stage.balls[i];
      m.position.set(b.x, b.y, b.z);
      m.quaternion.set(b.qx || 0, b.qy || 0, b.qz || 0, b.qw === undefined ? 1 : b.qw).multiply(m.userData.base);
      m.visible = true;
      stage.occ.setBall(i, b.x, b.y, b.z, R);
    }
  }).catch(e => console.error('title picture:', e));

  function frame(ms) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (document.hidden || !stage) return;
    if (t0 < 0) t0 = ms;
    // a slow sway round the rack, seen low from beside the foot of the table
    const a = 0.75 + Math.sin((ms - t0) * 0.00005) * 0.35;
    const tx = 0, tz = geom.rackZ - 0.08, wide = camera.aspect >= 1;
    const dist = wide ? 1.5 : 2.2;
    camera.position.set(tx + Math.sin(a) * dist, wide ? 0.62 : 0.85, tz - Math.cos(a) * dist);
    camera.lookAt(tx * 0.5, wide ? 0.3 : 0.42, tz + 0.25);   // look above the rack, so it sits low under the title panel
    renderer.render(stage.scene, camera);
    frames++;
  }
  requestAnimationFrame(frame);

  return {
    info: () => ({ three: THREE.REVISION, frames, size: [canvas.clientWidth, canvas.clientHeight], calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      quality: stage ? stage.quality : opts.quality || 'high', felt: stage ? stage.felt : opts.felt || 'green', pixelRatio: renderer.getPixelRatio() }),
    /** Picture quality, at once (or as soon as the picture is built). @param {'low'|'medium'|'high'} name */
    setQuality(name) { opts = { ...opts, quality: name }; if (stage) { stage.setQuality(name); resize(); } },
    /** Felt colour, at once (or as soon as the picture is built). @param {'green'|'blue'|'red'} name */
    setFelt(name) { opts = { ...opts, felt: name }; if (stage) stage.setFelt(name); },
    /** Stop drawing and free the picture (the game screen takes over). */
    stop() { running = false; window.removeEventListener('resize', resize); if (stage) stage.dispose(); renderer.dispose(); },
  };
}
