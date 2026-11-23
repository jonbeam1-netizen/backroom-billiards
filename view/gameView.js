// Draws the table, the balls, the cue and the aim help. It reads the game state and never changes it.
import * as THREE from '../lib/three.module.min.js';
import { createStage } from './stage.js';

/**
 * What the view is told each frame.
 * @typedef {Object} FrameInfo
 * @property {import('../rules/types.js').GameState} state
 * @property {Float32Array} prev     ball centres one tick ago (x, y, z per ball), for smoothing between ticks
 * @property {number} alpha          0 to 1, how far between the last tick and the next
 * @property {number} dt             seconds since the last frame
 * @property {number} dirX           the aim direction along the felt
 * @property {number} dirZ
 * @property {number} elevSin        how far the butt of the cue is raised
 * @property {number} elevCos
 * @property {number} [offX]         where the tip hits, sideways, -1 to 1
 * @property {number} [offY]         and up/down
 * @property {number} pull           0 to 1
 * @property {'short'|'full'|'none'} aimHelp
 * @property {import('../rules/types.js').Contact|null} contact
 * @property {{x:number, z:number, ok:boolean}|null} ghost   the cue ball in hand
 */

/** A flat strip on the felt between two points. */
function makeStrip(material) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  m.rotation.x = -Math.PI / 2; m.visible = false; m.renderOrder = 2;
  return m;
}
function setStrip(m, x1, z1, x2, z2, width, y) {
  const dx = x2 - x1, dz = z2 - z1, len = Math.hypot(dx, dz);
  if (len < 1e-4) { m.visible = false; return; }
  m.visible = true;
  m.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  m.scale.set(len, width, 1);
  m.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
}

/** Where a line from (x, z) along (dx, dz) leaves the playing area, at most maxLen away. */
function clipLength(x, z, dx, dz, hw, hl, maxLen) {
  let t = maxLen;
  if (dx > 1e-9) t = Math.min(t, (hw - x) / dx); else if (dx < -1e-9) t = Math.min(t, (-hw - x) / dx);
  if (dz > 1e-9) t = Math.min(t, (hl - z) / dz); else if (dz < -1e-9) t = Math.min(t, (-hl - z) / dz);
  return Math.max(0, t);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../rules/types.js').TableGeometry} geom
 * @param {{table:Object, physics:Object}} data
 * @param {Object} controls   data/controls.json
 * @param {{quality?:'low'|'medium'|'high', felt?:'green'|'blue'|'red'}} [opts]
 */
export function createGameView(canvas, geom, data, controls, opts = {}) {
  const R = data.table.ball.radius, cam = controls.camera, T = data.table;
  const hw = geom.halfW, hl = geom.halfL, ox = geom.outerHalfW, oz = geom.outerHalfL;
  const depth = T.cushion.depth, hN = T.cushion.noseHeight, hT = T.cushion.railTopHeight;
  const cueLen = controls.cue.length;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const stage = createStage(renderer, geom, T, { cueLength: cueLen, quality: opts.quality || 'high', felt: opts.felt || 'green' });
  const scene = stage.scene, occ = stage.occ;

  // aim help
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false });
  const hintMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.65, depthWrite: false, toneMapped: false });
  const cueLine = makeStrip(lineMat), targetLine = makeStrip(hintMat), glanceLine = makeStrip(lineMat);
  const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.9, R, 40), lineMat);
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2;
  scene.add(cueLine, targetLine, glanceLine, ring);

  const camera = new THREE.PerspectiveCamera(cam.aimFov, 1, 0.02, 30);
  occ.uniforms.occInvView.value = camera.matrixWorld;
  /** @type {'aim'|'top'} */
  let mode = 'aim';
  let snap = true;                       // jump straight to the next camera place instead of gliding
  const wantPos = new THREE.Vector3(), wantLook = new THREE.Vector3(), look = new THREE.Vector3();
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), proj = new THREE.Vector3();
  let strike = null;                     // the cue's forward stroke after a shot
  let frames = 0;
  let debugCam = null;                   // test only: a fixed camera to inspect a detail

  // what each ball was last seen doing, so a ball dropping into a pocket keeps its way
  const lastVel = []; for (let i = 0; i < 16; i++) lastVel.push({ x: 0, y: 0, z: 0 });
  /** @type {Map<number, any>} */
  const drops = new Map();
  const qTmp = new THREE.Quaternion(), vTmp = new THREE.Vector3();

  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- the cue, kept clear of the rail

  /**
   * How steep the cue must be drawn (as a tangent) to clear the cushion and the rail behind the cue ball.
   * Drawing only: the shot sent to the rules keeps its own angle.
   */
  function clearRail(tx, ty, tz, dirX, dirZ, tanE) {
    if (Math.abs(tx) > hw || Math.abs(tz) > hl) return tanE;
    const bx = -dirX, bz = -dirZ;
    const cross = (lx, lz) => {
      let t = Infinity;
      if (bx > 1e-6) t = Math.min(t, (lx - tx) / bx); else if (bx < -1e-6) t = Math.min(t, (-lx - tx) / bx);
      if (bz > 1e-6) t = Math.min(t, (lz - tz) / bz); else if (bz < -1e-6) t = Math.min(t, (-lz - tz) / bz);
      return t;
    };
    const sN = cross(hw, hl);
    if (!(sN < cueLen)) return tanE;
    const sO = cross(ox, oz);
    let t = tanE;
    const radiusAt = stage.cue.userData.radiusAt;
    for (let it = 0; it < 3; it++) {
      const c = 1 / Math.sqrt(1 + t * t);
      for (let k = 0; k < 5; k++) {
        const s = k === 0 ? sN : k === 1 ? sN + 0.012 : k === 2 ? sN + depth : k === 3 ? Math.min(sO, sN + depth + 0.1) : sO;
        const h = k === 0 ? hN + 0.002 : k === 1 ? hN + 0.006 : hT + 0.0046;
        if (s <= 0.002 || s > cueLen) continue;
        const need = (h + 0.004 + radiusAt(s / c) / c - ty) / s;
        if (need > t) t = need;
      }
    }
    return Math.min(t, Math.max(tanE, 2.14));   // never steeper than about 65 degrees
  }

  const lifted = { sin: 0, cos: 1 };
  function placeCue(bx, by, bz, f, gap) {
    const cue = stage.cue;
    let es = f.elevSin, ec = f.elevCos;
    let px = 0, py = 0, pz = 0, tx = 0, ty = 0, tz = 0;
    for (let pass = 0; pass < 2; pass++) {
      tx = f.dirX * ec; ty = -es; tz = f.dirZ * ec;   // the way the tip travels
      // the hit point: sideways along "right", up and down along "up across the cue" (the same axes the rules use)
      const rx = -f.dirZ, rz = f.dirX, ox2 = (f.offX || 0) * R, oy = (f.offY || 0) * R;
      const ux = -rz * ty, uy = rz * tx - rx * tz, uz = rx * ty;
      const hx = bx + rx * ox2 + ux * oy, hy = by + uy * oy, hz = bz + rz * ox2 + uz * oy;
      const reach = Math.sqrt(Math.max(0, R * R - ox2 * ox2 - oy * oy));
      px = hx - tx * (reach + gap); py = Math.max(hy - ty * (reach + gap), 0.007); pz = hz - tz * (reach + gap);
      if (pass === 0) {
        // The lift is worked out from where the tip rests against the ball, not from where it is while the cue is
        // drawn back. Drawing back slides the cue along the same line, so the angle must not change with the pull
        // (it used to: the nearer the drawn-back tip came to the rail, the steeper the cue was drawn, and it flew up).
        const g0 = reach + controls.cue.restGap;
        const t0 = es / Math.max(1e-6, ec), t1 = clearRail(hx - tx * g0, Math.max(hy - ty * g0, 0.007), hz - tz * g0, f.dirX, f.dirZ, t0);
        if (t1 <= t0 + 1e-6) break;
        ec = 1 / Math.sqrt(1 + t1 * t1); es = t1 * ec;
      }
    }
    lifted.sin = es; lifted.cos = ec;
    cue.position.set(px, py, pz);
    cue.lookAt(px - tx, py - ty, pz - tz);
    cue.visible = true;
    occ.setCue(px, py, pz, px - tx * cueLen, py - ty * cueLen, pz - tz * cueLen, 0.0064, 0.0148);
  }

  // ---------------------------------------------------------------- a ball dropping into a pocket

  function startDrop(e) {
    const pk = geom.pockets[e.pocket], lv = lastVel[e.ball], m = stage.balls[e.ball];
    let vx = lv.x, vz = lv.z, sp = Math.hypot(vx, vz);
    const speed = Math.min(4, Math.max(e.speed || 0, 0.3));
    if (sp < 0.05) { vx = pk.x - e.x; vz = pk.z - e.z; sp = Math.hypot(vx, vz) || 1; }
    drops.set(e.ball, { pk, x: e.x, y: Math.max(e.y, R * 0.6), z: e.z, vx: vx / sp * speed, vy: Math.min(0, lv.y), vz: vz / sp * speed,
      t: 0, q: m.quaternion.clone(), done: false });
  }
  function stepDrop(d, dt) {
    const pk = d.pk, Rc = pk.r + 0.004, h = 1 / 240;
    let n = Math.ceil(dt / h);
    while (n-- > 0 && !d.done) {
      d.t += h;
      d.vy -= 9.81 * h;
      d.x += d.vx * h; d.y += d.vy * h; d.z += d.vz * h;
      const rx = d.x - pk.x, rz = d.z - pk.z, dist = Math.hypot(rx, rz) || 1e-6, ux = rx / dist, uz = rz / dist;
      const wallSide = Math.abs(pk.x + ux * Rc) > hw + depth || Math.abs(pk.z + uz * Rc) > hl + depth;
      const vr = d.vx * ux + d.vz * uz;
      if (d.y < 0) {
        const max = pk.r - R * 1.02;   // inside the cup
        if (dist > max) { d.x = pk.x + ux * max; d.z = pk.z + uz * max; if (vr > 0) { d.vx -= 1.3 * vr * ux; d.vz -= 1.3 * vr * uz; d.vx *= 0.8; d.vz *= 0.8; } }
      } else if (wallSide && d.y < hT + R) {
        const max = Rc - 0.003 - R;    // against the liner in the rail's cut
        if (dist > max) { d.x = pk.x + ux * max; d.z = pk.z + uz * max; if (vr > 0) { d.vx -= 1.25 * vr * ux; d.vz -= 1.25 * vr * uz; d.vx *= 0.75; d.vz *= 0.75; } }
      } else if (dist >= pk.r) {
        if (d.y < R) { d.y = R; if (d.vy < 0) d.vy = 0; }   // still on the cloth
      } else {
        // tipping over the cloth's edge: the ball rolls round the hole's rim
        const er = dist - pk.r, ey = d.y, l = Math.hypot(er, ey);
        if (l < R && l > 1e-9) {
          const nr = er / l, ny = ey / l;
          const nd = pk.r + nr * R; d.x = pk.x + ux * nd; d.z = pk.z + uz * nd; d.y = ny * R;
          const vn = vr * nr + d.vy * ny;
          if (vn < 0) { d.vx -= vn * nr * ux; d.vz -= vn * nr * uz; d.vy -= vn * ny; }
        }
      }
      // it keeps turning the way it rolled
      const wx = d.vz / R, wz = -d.vx / R, w = Math.hypot(wx, wz);
      if (w > 1e-6) { qTmp.setFromAxisAngle(vTmp.set(wx / w, 0, wz / w), w * h); d.q.premultiply(qTmp); }
      if (d.y < -0.075 || d.t > 1.5) d.done = true;
    }
  }

  // ---------------------------------------------------------------- test-only cameras

  const DEBUG_CAMS = {
    pocket: () => { const p = geom.pockets[5]; return [p.x - 0.2, 0.12, p.z - 0.22, p.x, 0, p.z, 40]; },
    pocketTop: () => { const p = geom.pockets[5]; return [p.x, 0.45, p.z + 0.001, p.x, 0, p.z, 40]; },
    side: () => { const p = geom.pockets[3]; return [p.x - 0.3, 0.14, p.z + 0.05, p.x, 0.0, p.z, 40]; },
    sideTop: () => { const p = geom.pockets[3]; return [p.x, 0.45, p.z + 0.001, p.x, 0, p.z, 40]; },
    rack: () => [0.25, 0.12, geom.rackZ + 0.15, 0, 0.02, geom.rackZ - 0.1, 40],
    cushion: () => [hw - 0.12, 0.06, 0.45, hw, 0.02, 0.3, 40],
    low: () => [ox + 0.6, 0.55, oz + 0.7, 0, -0.05, 0, 42],
    under: () => [ox + 1.6, 0.0, 0.4, 0, -0.35, 0, 42],
    cueSide: () => { const b = stage.balls[0].position; return [b.x + 0.45, 0.2, b.z + 0.45, b.x, 0.05, b.z + 0.35, 45]; },
  };
  function debugCamera() {
    let s = debugCam;
    if (typeof s === 'string') {
      const mm = /^ball(\d+)$/.exec(s);
      if (mm) { const b = stage.balls[+mm[1]].position; s = [b.x + 0.09, b.y + 0.07, b.z + 0.12, b.x, b.y, b.z, 35]; }
      else s = DEBUG_CAMS[s] ? DEBUG_CAMS[s]() : null;
    }
    if (!s) return false;
    if (camera.fov !== (s[6] || 40)) { camera.fov = s[6] || 40; camera.updateProjectionMatrix(); }
    camera.up.set(0, 1, 0);
    camera.position.set(s[0], s[1], s[2]); camera.lookAt(s[3], s[4], s[5]);
    return true;
  }

  return {
    /** @param {'aim'|'top'} m */
    setMode(m) { if (m !== mode) { mode = m; snap = true; } },
    getMode() { return mode; },
    /** Start the cue's forward stroke. Call on the frame the shot is taken. */
    strike(bx, by, bz, f) { strike = { t: 0, bx, by, bz, f: { ...f }, gap: controls.cue.restGap + f.pull * controls.cue.pullDistance }; },
    /** @param {'green'|'blue'|'red'} name */
    setFelt(name) { stage.setFelt(name); },
    /** Picture quality. @param {'low'|'medium'|'high'} name */
    setQuality(name) { stage.setQuality(name); resize(); },
    snapCamera() { snap = true; },
    /** What happened in a tick of the rules (for the drop into a pocket). @param {import('../rules/types.js').GameEvent[]} events */
    onEvents(events) {
      for (const e of events) if (e.type === 'pocket' && e.ball >= 0 && e.ball < 16) startDrop(e);
    },
    /** Test only: look from a fixed place. A name (pocket, pocketTop, side, sideTop, rack, cushion, low, under, cueSide, ballN) or [x, y, z, lookX, lookY, lookZ, fov]; null for the game cameras. */
    setDebugCamera(spec) { debugCam = spec || null; snap = true; },
    /**
     * The point on the table under a place on the screen (pixels from the canvas's top left), at ball height.
     * @returns {{x:number, z:number}|null}
     */
    screenToTable(px, py) {
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      ray.setFromCamera(ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1), camera);
      const d = ray.ray.direction, o = ray.ray.origin;
      if (Math.abs(d.y) < 1e-6) return null;
      const t = (R - o.y) / d.y;
      return t > 0 ? { x: o.x + d.x * t, z: o.z + d.z * t } : null;
    },
    /** Where a point on the table (at ball height) is on the screen, in pixels from the canvas's top left. */
    tableToScreen(x, z) {
      proj.set(x, R, z).project(camera);
      return { x: (proj.x + 1) / 2 * (canvas.clientWidth || 1), y: (1 - proj.y) / 2 * (canvas.clientHeight || 1) };
    },

    /** @param {FrameInfo} f */
    render(f) {
      const st = f.state, a = f.alpha, p = f.prev, balls = stage.balls;
      for (let i = 0; i < 16; i++) {
        const b = st.balls[i], m = balls[i];
        if (b.where === 'table') {
          drops.delete(i);
          m.visible = true;
          m.position.set(p[i * 3] + (b.x - p[i * 3]) * a, p[i * 3 + 1] + (b.y - p[i * 3 + 1]) * a, p[i * 3 + 2] + (b.z - p[i * 3 + 2]) * a);
          m.quaternion.set(b.qx || 0, b.qy || 0, b.qz || 0, b.qw === undefined ? 1 : b.qw).multiply(m.userData.base);
          lastVel[i].x = b.vx; lastVel[i].y = b.vy; lastVel[i].z = b.vz;
        } else {
          const d = b.where === 'potted' ? drops.get(i) : null;
          if (d && !d.done) {
            stepDrop(d, f.dt);
            m.visible = !d.done;
            m.position.set(d.x, d.y, d.z); m.quaternion.copy(d.q);
          } else m.visible = false;
        }
        if (m.visible) occ.setBall(i, m.position.x, m.position.y, m.position.z, R); else occ.setBall(i, 0, 0, 0, 0);
      }
      const cb = st.balls[0], cbm = balls[0];
      const aiming = st.phase === 'aim' && cb.where === 'table';

      // cue
      lifted.sin = f.elevSin; lifted.cos = f.elevCos;
      if (strike) {
        strike.t += f.dt;
        const g = Math.max(0, strike.gap * (1 - strike.t / 0.05));
        placeCue(strike.bx, strike.by, strike.bz, strike.f, g - Math.min(0.02, strike.t * 0.4));
        if (strike.t > 0.45) strike = null;
      } else if (aiming) {
        placeCue(cbm.position.x, cbm.position.y, cbm.position.z, f, controls.cue.restGap + f.pull * controls.cue.pullDistance);
      } else { stage.cue.visible = false; occ.setCue(0, 0, 0, 0, 0, 0, 0, 0); }

      // aim help
      const c = aiming && f.aimHelp !== 'none' ? f.contact : null;
      cueLine.visible = targetLine.visible = glanceLine.visible = ring.visible = false;
      if (c && c.kind !== 'none') {
        const y = 0.0015, full = f.aimHelp === 'full';
        setStrip(cueLine, cb.x + f.dirX * R, cb.z + f.dirZ * R, c.x, c.z, 0.004, y);
        ring.visible = true; ring.position.set(c.x, y, c.z);
        if (c.kind === 'ball') {
          const tb = st.balls[c.ballId];
          const tl = clipLength(tb.x, tb.z, c.targetDirX, c.targetDirZ, geom.halfW, geom.halfL, full ? 1.6 : 0.13 + R);
          setStrip(targetLine, tb.x + c.targetDirX * R, tb.z + c.targetDirZ * R, tb.x + c.targetDirX * tl, tb.z + c.targetDirZ * tl, 0.004, y);
          if (full) {
            const gl = clipLength(c.x, c.z, c.cueDirX, c.cueDirZ, geom.halfW, geom.halfL, 0.8);
            setStrip(glanceLine, c.x + c.cueDirX * R, c.z + c.cueDirZ * R, c.x + c.cueDirX * gl, c.z + c.cueDirZ * gl, 0.003, y);
          }
        } else if (c.kind === 'cushion' && full) {
          const gl = clipLength(c.x, c.z, c.cueDirX, c.cueDirZ, geom.halfW - R, geom.halfL - R, 1.2);
          setStrip(glanceLine, c.x, c.z, c.x + c.cueDirX * gl, c.z + c.cueDirZ * gl, 0.003, y);
        }
      }

      // cue ball in hand
      const ghost = stage.ghost;
      ghost.visible = !!f.ghost;
      if (f.ghost) { ghost.position.set(f.ghost.x, R, f.ghost.z); ghost.material.color.setHex(f.ghost.ok ? 0xffffff : 0xff6a5a); }

      // camera
      if (debugCam && debugCamera()) {
        // test only
      } else if (mode === 'top') {
        const t = Math.tan((cam.topFov * Math.PI / 180) / 2), wide = camera.aspect >= 1;
        const along = geom.outerHalfL + cam.topMargin, across = geom.outerHalfW + cam.topMargin;
        const h = wide ? Math.max(across / t, along / (t * camera.aspect)) : Math.max(along / t, across / (t * camera.aspect));
        if (camera.fov !== cam.topFov) { camera.fov = cam.topFov; camera.updateProjectionMatrix(); }
        camera.position.set(0, h, 0);
        camera.up.set(wide ? -1 : 0, 0, wide ? 0 : -1);   // a wide window lays the table on its side
        camera.lookAt(0, 0, 0);
      } else {
        if (camera.fov !== cam.aimFov) { camera.fov = cam.aimFov; camera.updateProjectionMatrix(); }
        camera.up.set(0, 1, 0);
        // the camera only moves while there is something to aim; during the roll it stays where it was
        if (aiming || snap) {
          const bx = cb.where === 'table' ? cbm.position.x : 0, bz = cb.where === 'table' ? cbm.position.z : geom.lineZ;
          // with the butt of the cue raised (or lifted over a rail), the camera rises too, so you look down over the cue and not into it
          let cueHere = R + (cam.aimBack + 0.1) * (lifted.sin / Math.max(0.2, lifted.cos));
          // a cue lifted steeply over a rail passes far above the camera anyway: then follow the cue's real angle only
          if (cueHere > 0.9) cueHere = R + (cam.aimBack + 0.1) * (f.elevSin / Math.max(0.2, f.elevCos));
          wantPos.set(bx - f.dirX * cam.aimBack, Math.max(cam.aimHeight, cueHere + cam.aboveCue), bz - f.dirZ * cam.aimBack);
          wantLook.set(bx + f.dirX * cam.aimLookAhead, 0, bz + f.dirZ * cam.aimLookAhead);
        }
        const k = snap ? 1 : 1 - Math.exp(-f.dt * cam.follow);
        camera.position.lerp(wantPos, k);
        look.lerp(wantLook, k);
        camera.lookAt(look);
      }
      snap = false;

      renderer.render(scene, camera);
      frames++;
    },

    info() {
      return { quality: stage.quality, felt: stage.felt, frames, mode, size: [canvas.clientWidth, canvas.clientHeight], pixelRatio: renderer.getPixelRatio(),
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, programs: renderer.info.programs ? renderer.info.programs.length : 0,
        textures: renderer.info.memory.textures, geometries: renderer.info.memory.geometries };
    },
    dispose() { window.removeEventListener('resize', resize); stage.dispose(); renderer.dispose(); },
  };
}
