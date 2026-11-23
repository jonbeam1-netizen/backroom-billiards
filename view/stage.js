// The lit table in its dark space: the lamps, what the shiny things reflect, the table, the balls and the cue.
// Shared by the game view and the title screen. Picture quality and felt colour are switched here.
import * as THREE from '../lib/three.module.min.js';
import { buildTableModel, buildBallModel, buildCueModel, FELT_COLOURS, QUALITY } from './models.js';
import { createOcclusion } from './occlusion.js';

/** The lamp: a long shade over the table with three bulbs, this high above the cloth. */
export const LAMP = { height: 1.0, spread: 0.32, colour: 0xffd3a0, intensity: 4.4, lightRadius: 0.09 };

/**
 * What the balls, the varnish and the brass reflect: a dark space, the long lamp shade glowing above, and the
 * lit cloth below (that is also the soft bounce light that tints the balls' undersides).
 */
function buildEnvironment(renderer, geom, feltHex) {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x050403);
  const keep = [];
  const add = (geo, colour, setup) => { const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide })); setup(m); env.add(m); keep.push(geo, m.material); };
  const L = geom.length, y = LAMP.height - 0.03;
  // the shade's open underside: a warm glow, brightest at the three bulbs
  add(new THREE.PlaneGeometry(0.3, L * 0.78), new THREE.Color(1.0, 0.78, 0.52).multiplyScalar(2.2), m => { m.rotation.x = Math.PI / 2; m.position.y = y; });
  for (const z of [-LAMP.spread, 0, LAMP.spread]) {
    add(new THREE.CircleGeometry(0.075, 24), new THREE.Color(1.0, 0.84, 0.62).multiplyScalar(22), m => { m.rotation.x = Math.PI / 2; m.position.set(0, y - 0.005, z * L); });
  }
  // the shade's dark outside, catching a little light at its rim
  add(new THREE.BoxGeometry(0.36, 0.14, L * 0.82), new THREE.Color(0.035, 0.03, 0.022), m => { m.position.y = y + 0.075; });
  // the lit cloth below, the rails round it, then dark
  const fc = new THREE.Color(feltHex);
  add(new THREE.PlaneGeometry(geom.width, geom.length), fc.clone().multiplyScalar(0.55), m => { m.rotation.x = -Math.PI / 2; m.position.y = -0.03; });
  add(new THREE.PlaneGeometry(geom.outerHalfW * 2, geom.outerHalfL * 2), new THREE.Color(0.06, 0.03, 0.015), m => { m.rotation.x = -Math.PI / 2; m.position.y = -0.032; });
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0.015, 0.01, 30);
  pm.dispose();
  for (const k of keep) k.dispose();
  return rt;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {import('../rules/types.js').TableGeometry} geom
 * @param {Object} table  data/table.json
 * @param {{cueLength:number, quality?:string, felt?:string, marks?:Object}} opts   marks: the tracks from play on the cloth (game view only)
 */
export function createStage(renderer, geom, table, opts) {
  const R = table.ball.radius;
  const scene = new THREE.Scene();
  const occ = createOcclusion();
  occ.uniforms.occLampR.value = LAMP.lightRadius;
  let q = QUALITY[opts.quality] || QUALITY.high;
  let feltName = FELT_COLOURS[opts.felt] !== undefined ? opts.felt : 'green';

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setClearColor(0x020101);
  renderer.shadowMap.enabled = false;   // shadows are worked out in the shaders (occlusion.js)

  // the three bulbs in the long shade
  const lamps = [];
  for (const z of [-LAMP.spread, 0, LAMP.spread]) {
    const l = new THREE.SpotLight(LAMP.colour, LAMP.intensity, 0, 1.05, 1.0, 2);
    l.position.set(0, LAMP.height, z * geom.length);
    l.target.position.set(0, 0, z * geom.length);
    scene.add(l, l.target); lamps.push(l);
  }

  let envRT = null;
  function setEnvironment() {
    if (envRT) envRT.dispose();
    envRT = buildEnvironment(renderer, geom, FELT_COLOURS[feltName]);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.75;
  }

  /** @type {ReturnType<typeof buildTableModel>|null} */
  let tableModel = null;
  /** @type {THREE.Mesh[]} */
  let balls = [];
  /** @type {THREE.Group|null} */
  let cue = null;
  /** @type {THREE.Mesh|null} */
  let ghost = null;
  // each ball starts turned its own way, so the numbers do not all face the same direction (decoration only)
  const base = [];
  for (let id = 0; id < 16; id++) base.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3)));

  function build() {
    const old = { tableModel, balls, cue, ghost };
    if (old.tableModel) { scene.remove(old.tableModel.group); old.tableModel.dispose(); }
    for (const b of old.balls) { scene.remove(b); b.material.dispose(); }
    if (old.cue) { scene.remove(old.cue); old.cue.userData.dispose(); }
    if (old.ghost) { scene.remove(old.ghost); old.ghost.material.dispose(); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    tableModel = buildTableModel(geom, table, FELT_COLOURS[feltName], { quality: q, occlusion: occ, marks: opts.marks });
    scene.add(tableModel.group);
    balls = [];
    for (let id = 0; id < 16; id++) {
      const m = buildBallModel(id, R, { quality: q, occlusion: occ });
      m.userData.base = base[id];
      if (old.balls[id]) { m.position.copy(old.balls[id].position); m.quaternion.copy(old.balls[id].quaternion); m.visible = old.balls[id].visible; }
      balls.push(m); scene.add(m);
    }
    cue = buildCueModel(opts.cueLength, { quality: q });
    cue.visible = false;
    scene.add(cue);
    ghost = buildBallModel(0, R, { quality: q, occlusion: occ });
    ghost.material.transparent = true; ghost.material.opacity = 0.55; ghost.material.depthWrite = false;
    ghost.visible = false;
    scene.add(ghost);
  }
  setEnvironment();
  build();

  return {
    scene, occ, lamps,
    get balls() { return balls; },
    get cue() { return cue; },
    get ghost() { return ghost; },
    get quality() { return q.name; },
    get felt() { return feltName; },
    /** @param {'low'|'medium'|'high'} name */
    setQuality(name) {
      const nq = QUALITY[name];
      if (!nq || nq === q) return;
      q = nq; build();
    },
    /** @param {'green'|'blue'|'red'} name */
    setFelt(name) {
      if (FELT_COLOURS[name] === undefined || name === feltName) return;
      feltName = name;
      tableModel.setFelt(FELT_COLOURS[name]);
      setEnvironment();
    },
    dispose() {
      if (tableModel) tableModel.dispose();
      for (const b of balls) b.material.dispose();
      if (cue) cue.userData.dispose();
      if (ghost) ghost.material.dispose();
      if (envRT) envRT.dispose();
    },
  };
}
