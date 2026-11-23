// Ball movement: full 3D rigid spheres on felt, cushions, rail tops, pockets and the floor.
// Deterministic: only + - * / and Math.sqrt / abs / min / max / floor; fixed order by ball id.

/** @typedef {import('./types.js').Ball} Ball */
/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').GameEvent} GameEvent */
/** @typedef {import('./types.js').TableGeometry} TableGeometry */

/** Support height meaning "nothing under the ball". */
export const NO_SUPPORT = -1e9;
const SLIP_EPS = 1e-6;
const TOUCH_EPS = 1e-7;

/**
 * The numbers the simulation runs on, gathered from the data files.
 * @typedef {Object} PhysicsConst
 * @property {number} R @property {number} m @property {number} I @property {number} g
 * @property {number} dt
 * @property {number} muS @property {number} muR @property {number} muSp
 * @property {number} bedE @property {number} railE @property {number} bounceMin @property {number} liftMin @property {number} pressReach
 * @property {number} bbE @property {number} bbMu
 * @property {number} cE0 @property {number} cE1 @property {number} cFast @property {number} cMu
 * @property {number} hopMin @property {number} hopGain
 * @property {number} maxShotSpeed @property {number} elevSin @property {number} elevCos @property {number} maxTip
 * @property {number} strikeE @property {number} strikeSoft @property {number} squeezeLoss
 * @property {number} maxMove @property {number} maxSubsteps @property {number} maxPasses
 * @property {number} restSpeed @property {number} restSpin @property {number} potDepth
 * @property {number} rackGap @property {number} rackJitter
 */

/**
 * @param {{table:Object, physics:Object}} data
 * @returns {PhysicsConst}
 */
export function getConst(data) {
  const t = data.table, p = data.physics;
  const R = t.ball.radius, m = t.ball.mass;
  return {
    R, m, I: 0.4 * m * R * R, g: p.gravity, dt: 1 / p.tickRate,
    muS: p.cloth.slidingFriction, muR: p.cloth.rollingFriction, muSp: p.cloth.spinFriction,
    bedE: p.cloth.bounceRestitution, railE: p.rail.bounceRestitution,
    bounceMin: p.cloth.bounceMinSpeed, liftMin: p.cloth.liftMinSpeed, pressReach: p.cloth.pressReach,
    bbE: p.ballBall.restitution, bbMu: p.ballBall.friction,
    cE0: p.cushion.restitutionSlow, cE1: p.cushion.restitutionFast, cFast: p.cushion.fastSpeed, cMu: p.cushion.friction,
    hopMin: p.cushion.hopMinSpeed, hopGain: p.cushion.hopGain,
    maxShotSpeed: p.shot.maxShotSpeed, elevSin: p.shot.defaultElevSin, elevCos: p.shot.defaultElevCos, maxTip: p.shot.maxTipOffset,
    strikeE: p.shot.bedRestitution, strikeSoft: p.shot.bedSqueezeSpeed, squeezeLoss: p.shot.squeezeLoss,
    maxMove: p.sim.maxMovePerSubstep, maxSubsteps: p.sim.maxSubsteps, maxPasses: p.sim.maxSolverPasses,
    restSpeed: p.sim.restSpeed, restSpin: p.sim.restSpin, potDepth: p.sim.potDepth,
    rackGap: p.rack.gap, rackJitter: p.rack.jitter,
  };
}

// ---------------------------------------------------------------- surfaces

/**
 * Is (x, z) inside a convex four-corner shape given as [x0,z0, x1,z1, x2,z2, x3,z3]?
 * @param {number[]} q @param {number} x @param {number} z
 * @returns {boolean}
 */
function inQuad(q, x, z) {
  let pos = false, neg = false;
  for (let i = 0; i < 4; i++) {
    const ax = q[i * 2], az = q[i * 2 + 1];
    const j = (i + 1) % 4;
    const bx = q[j * 2], bz = q[j * 2 + 1];
    const cr = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cr > 0) pos = true; else if (cr < 0) neg = true;
  }
  return !(pos && neg);
}

/**
 * Height of the surface under a ball centre at (x, z): the felt (0), the rail top, or nothing.
 * @param {TableGeometry} geo @param {number} x @param {number} z
 * @returns {number}
 */
export function supportHeight(geo, x, z) {
  const pockets = geo.pockets;
  for (let i = 0; i < pockets.length; i++) {
    const pk = pockets[i];
    const dx = x - pk.x, dz = z - pk.z;
    if (dx * dx + dz * dz < pk.r * pk.r) return NO_SUPPORT;
  }
  if (Math.abs(x) <= geo.halfW && Math.abs(z) <= geo.halfL) return 0;
  if (Math.abs(x) > geo.outerHalfW || Math.abs(z) > geo.outerHalfL) return NO_SUPPORT;
  for (let i = 0; i < pockets.length; i++) {
    if (inQuad(pockets[i].quad, x, z)) return 0;
  }
  return geo.railTopHeight;
}

/**
 * True when the ball sits on a surface (felt or rail top) and is not moving up.
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k
 * @returns {boolean}
 */
function onSurface(b, geo, k) {
  const s = supportHeight(geo, b.x, b.z);
  return s > NO_SUPPORT && b.y <= s + k.R + TOUCH_EPS;
}

// ---------------------------------------------------------------- impulses at the bottom contact

/**
 * A push straight up through the bottom contact of size pn, with sliding friction against the slip there.
 * @param {Ball} b @param {PhysicsConst} k @param {number} pn  normal impulse, kg m/s (>= 0)
 */
function bottomFriction(b, k, pn) {
  if (pn <= 0) return;
  const R = k.R;
  const ux = b.vx + R * b.wz, uz = b.vz - R * b.wx;
  const us = Math.sqrt(ux * ux + uz * uz);
  if (us < SLIP_EPS) return;
  const j = Math.min(k.muS * pn, us * k.m / 3.5);
  const ix = -j * ux / us, iz = -j * uz / us;
  b.vx += ix / k.m; b.vz += iz / k.m;
  b.wx += -R * iz / k.I; b.wz += R * ix / k.I;
}

/**
 * After a ball-ball or cushion hit: if the ball sits on a surface and was pushed down into it,
 * the felt takes that push (the two contacts act together), with friction.
 * Ball on ball, and cushion hits below the hop speed, give no bounce at all. A cushion hit faster
 * than hopMin into the cushion is more than the soft rubber can soak up: the rest of the push comes
 * back off the bed and the ball hops, by hopGain x the speed above hopMin.
 * A tiny upward speed is dropped so balls do not micro-hop.
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k
 * @param {number} vnIn  closing speed into the cushion (m/s), 0 for ball on ball
 */
function pressReaction(b, geo, k, vnIn) {
  const s = supportHeight(geo, b.x, b.z);
  if (s <= NO_SUPPORT) return;
  const gap = b.y - (s + k.R);
  if (gap > k.pressReach) return;
  if (b.vy < 0) {
    // A ball this close to the surface reaches it while the hit is still going on: the felt takes the push.
    const down = -b.vy;
    let up = vnIn > k.hopMin ? k.hopGain * (vnIn - k.hopMin) : 0;
    if (up > down) up = down;            // never more back than the push into the bed
    if (up < k.liftMin) up = 0;
    bottomFriction(b, k, (down + up) * k.m);
    b.vy = up;
  } else if (b.vy < k.liftMin && gap <= TOUCH_EPS) {
    b.vy = 0;
  }
}

/**
 * A falling ball meets the surface at height s.
 * @param {Ball} b @param {number} s @param {PhysicsConst} k @param {GameEvent[]} events
 */
function land(b, s, k, events) {
  const vin = -b.vy;
  b.y = s + k.R;
  if (vin > k.bounceMin) {
    const rail = s > 0;
    const e = rail ? k.railE : k.bedE;
    bottomFriction(b, k, k.m * (1 + e) * vin);
    b.vy = e * vin;
    if (b.vy < k.liftMin) b.vy = 0;
    events.push({ type: rail ? 'railBounce' : 'tableBounce', ball: b.id, speed: vin, x: b.x, y: s, z: b.z });
  } else {
    bottomFriction(b, k, k.m * (vin > 0 ? vin : 0));
    b.vy = 0;
  }
}

/**
 * The cue ball is driven into the felt by the strike (elevated cue). This is not a free bounce:
 * the ball is squeezed between the tip and the cloth, so the hop is damped and levels off for hard,
 * steep hits. With vin the downward speed and r = vin / strikeSoft:
 * upward speed = strikeE x vin / eighth root of (1 + r^8).
 * Gentle strikes bounce like a plain bounce (strikeE); past strikeSoft the hop levels off and can never
 * come back faster than strikeE x strikeSoft. The bed pushes up hard while it happens, so cloth friction
 * takes some of the forward speed.
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k @param {GameEvent[]} events
 */
export function strikeIntoBed(b, geo, k, events) {
  if (b.vy >= 0 || !onSurface(b, geo, k)) return;
  const s = supportHeight(geo, b.x, b.z);
  const vin = -b.vy;
  b.y = s + k.R;
  const r2 = (vin / k.strikeSoft) * (vin / k.strikeSoft), r4 = r2 * r2;
  let up = k.strikeE * vin / Math.sqrt(Math.sqrt(Math.sqrt(1 + r4 * r4)));
  if (vin <= k.bounceMin || up < k.liftMin) up = 0;
  // The squeeze that swallows the hop also swallows some of the strike: the ball leaves slower,
  // by squeezeLoss x (the upward speed a plain bounce would have given, minus what it got).
  const plain = k.strikeE * vin;
  const lost = plain > up ? k.squeezeLoss * (plain - up) : 0;
  const vh = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  if (lost > 0 && vh > 0) {
    const sc = vh > lost ? (vh - lost) / vh : 0;
    b.vx *= sc; b.vz *= sc;
    b.wx *= sc; b.wy *= sc; b.wz *= sc;
  }
  bottomFriction(b, k, k.m * (vin + up));
  b.vy = up;
  if (vin > k.bounceMin) events.push({ type: s > 0 ? 'railBounce' : 'tableBounce', ball: b.id, speed: vin, x: b.x, y: s, z: b.z });
}

// ---------------------------------------------------------------- free movement

/**
 * Rolling without slipping for time t: rolling resistance, spin matched to the speed.
 * @param {Ball} b @param {PhysicsConst} k @param {number} t
 */
function roll(b, k, t) {
  const sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
  if (sp > 0) {
    const a = k.muR * k.g;
    let newSp, dist;
    if (a * t >= sp) { newSp = 0; dist = sp * sp / (2 * a); }
    else { newSp = sp - a * t; dist = (sp + newSp) * 0.5 * t; }
    b.x += b.vx / sp * dist; b.z += b.vz / sp * dist;
    const s = newSp / sp;
    b.vx *= s; b.vz *= s;
  }
  b.wx = b.vz / k.R; b.wz = -b.vx / k.R;
}

/**
 * Movement on a surface for time h: sliding friction until it rolls, then rolling resistance;
 * spin about the upright axis dies on its own.
 * @param {Ball} b @param {PhysicsConst} k @param {number} h
 */
function surfaceMotion(b, k, h) {
  const R = k.R;
  const ux = b.vx + R * b.wz, uz = b.vz - R * b.wx;
  const us = Math.sqrt(ux * ux + uz * uz);
  let left = h;
  if (us > SLIP_EPS) {
    const a = k.muS * k.g;
    const tSlip = us / (3.5 * a);
    const ts = tSlip < h ? tSlip : h;
    const vx0 = b.vx, vz0 = b.vz;
    b.vx -= a * ux / us * ts; b.vz -= a * uz / us * ts;
    const c = 2.5 * a / R * ts;
    b.wx += c * uz / us; b.wz -= c * ux / us;
    b.x += 0.5 * (vx0 + b.vx) * ts; b.z += 0.5 * (vz0 + b.vz) * ts;
    left = h - ts;
    if (tSlip <= h) { b.wx = b.vz / R; b.wz = -b.vx / R; }
  }
  if (left > 0) roll(b, k, left);
  const dwy = 2.5 * k.muSp * k.g / R * h;
  if (Math.abs(b.wy) <= dwy) b.wy = 0; else b.wy -= b.wy > 0 ? dwy : -dwy;
}

/**
 * Turns the ball's orientation by its spin over time h (first order, then normalised; no trig).
 * @param {Ball} b @param {number} h
 */
function turn(b, h) {
  const wx = b.wx, wy = b.wy, wz = b.wz;
  if (wx === 0 && wy === 0 && wz === 0) return;
  const qx = b.qx, qy = b.qy, qz = b.qz, qw = b.qw;
  const f = 0.5 * h;
  const nx = qx + f * (wx * qw + wy * qz - wz * qy);
  const ny = qy + f * (wy * qw + wz * qx - wx * qz);
  const nz = qz + f * (wz * qw + wx * qy - wy * qx);
  const nw = qw - f * (wx * qx + wy * qy + wz * qz);
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
  b.qx = nx / len; b.qy = ny / len; b.qz = nz / len; b.qw = nw / len;
}

/**
 * Moves one ball for time h: on a surface with friction, or flying under gravity.
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k @param {number} h @param {GameEvent[]} events
 */
function moveBall(b, geo, k, h, events) {
  const s = supportHeight(geo, b.x, b.z);
  if (s > NO_SUPPORT && b.y <= s + k.R + TOUCH_EPS && b.vy <= 0) {
    if (b.vy < 0) land(b, s, k, events);
    b.y = s + k.R;
    if (b.vy === 0) {
      surfaceMotion(b, k, h);
      turn(b, h);
      return;
    }
  }
  b.vy -= k.g * h;
  b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
  const s2 = supportHeight(geo, b.x, b.z);
  if (s2 > NO_SUPPORT && b.y < s2 + k.R) land(b, s2, k, events);
  turn(b, h);
}

// ---------------------------------------------------------------- ball on ball

/**
 * Time back (0..h) to the moment two spheres, now overlapping, first touched at distance dist.
 * @param {number} dx @param {number} dy @param {number} dz  relative position (overlapping)
 * @param {number} ex @param {number} ey @param {number} ez  relative velocity
 * @param {number} dist @param {number} h
 * @returns {number}
 */
function backTime(dx, dy, dz, ex, ey, ez, dist, h) {
  const a = ex * ex + ey * ey + ez * ez;
  if (a <= 0) return 0;
  const b = dx * ex + dy * ey + dz * ez;
  const c = dx * dx + dy * dy + dz * dz - dist * dist;
  const disc = b * b - a * c;
  if (disc <= 0) return 0;
  let t = (b + Math.sqrt(disc)) / a;
  if (t < 0) t = 0;
  if (t > h) t = h;
  return t;
}

/**
 * Hit between two touching, closing balls: rewind to first touch, impulse with friction in 3D, move on.
 * @param {Ball} A @param {Ball} B @param {TableGeometry} geo @param {PhysicsConst} k @param {number} h
 * @param {GameEvent[]} events
 * @returns {boolean} true when an impulse was applied
 */
function ballHit(A, B, geo, k, h, events) {
  const R = k.R, m = k.m;
  const t = backTime(B.x - A.x, B.y - A.y, B.z - A.z, B.vx - A.vx, B.vy - A.vy, B.vz - A.vz, 2 * R, h);
  A.x -= A.vx * t; A.y -= A.vy * t; A.z -= A.vz * t;
  B.x -= B.vx * t; B.y -= B.vy * t; B.z -= B.vz * t;
  let nx = B.x - A.x, ny = B.y - A.y, nz = B.z - A.z;
  const d = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= d; ny /= d; nz /= d;
  const vn = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny + (A.vz - B.vz) * nz;
  if (vn > 0) {
    const jn = (1 + k.bbE) * vn * m / 2;
    // Contact point velocities: A at +R n, B at -R n.
    const uAx = A.vx + R * (A.wy * nz - A.wz * ny);
    const uAy = A.vy + R * (A.wz * nx - A.wx * nz);
    const uAz = A.vz + R * (A.wx * ny - A.wy * nx);
    const uBx = B.vx - R * (B.wy * nz - B.wz * ny);
    const uBy = B.vy - R * (B.wz * nx - B.wx * nz);
    const uBz = B.vz - R * (B.wx * ny - B.wy * nx);
    let ux = uAx - uBx, uy = uAy - uBy, uz = uAz - uBz;
    const un = ux * nx + uy * ny + uz * nz;
    ux -= un * nx; uy -= un * ny; uz -= un * nz;
    const ut = Math.sqrt(ux * ux + uy * uy + uz * uz);
    let tx = 0, ty = 0, tz = 0, jt = 0;
    if (ut > SLIP_EPS) {
      tx = ux / ut; ty = uy / ut; tz = uz / ut;
      jt = Math.min(k.bbMu * jn, ut * m / 7);
    }
    // Impulse on A is P = -jn n - jt t; on B it is -P.
    const px = -jn * nx - jt * tx, py = -jn * ny - jt * ty, pz = -jn * nz - jt * tz;
    A.vx += px / m; A.vy += py / m; A.vz += pz / m;
    B.vx -= px / m; B.vy -= py / m; B.vz -= pz / m;
    // Both get the same spin change: R n x (-jt t) / I.
    const cx = -jt * R * (ny * tz - nz * ty) / k.I;
    const cy = -jt * R * (nz * tx - nx * tz) / k.I;
    const cz = -jt * R * (nx * ty - ny * tx) / k.I;
    A.wx += cx; A.wy += cy; A.wz += cz;
    B.wx += cx; B.wy += cy; B.wz += cz;
    A.moving = true; B.moving = true;
    pressReaction(A, geo, k, 0);
    pressReaction(B, geo, k, 0);
    events.push({ type: 'ballBall', ball: A.id, other: B.id, speed: vn, x: A.x + nx * R, y: A.y + ny * R, z: A.z + nz * R });
  }
  A.x += A.vx * t; A.y += A.vy * t; A.z += A.vz * t;
  B.x += B.vx * t; B.y += B.vy * t; B.z += B.vz * t;
  keepAboveSurface(A, geo, k);
  keepAboveSurface(B, geo, k);
  return vn > 0;
}

/**
 * Lifts a ball that has sunk below the surface under it back onto it (tiny numeric fixes only).
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k
 */
function keepAboveSurface(b, geo, k) {
  const s = supportHeight(geo, b.x, b.z);
  if (s > NO_SUPPORT && b.y < s + k.R) {
    b.y = s + k.R;
    if (b.vy < 0) b.vy = 0;
  }
}

/**
 * One pass over all ball pairs in id order. Closing pairs get a hit; touching, resting overlaps are pushed apart.
 * @param {Ball[]} balls @param {TableGeometry} geo @param {PhysicsConst} k @param {number} h @param {GameEvent[]} events
 * @returns {boolean} true when any hit happened
 */
function ballPass(balls, geo, k, h, events) {
  const R2 = 2 * k.R;
  const lim = R2 * R2;
  let hit = false;
  for (let i = 0; i < balls.length; i++) {
    const A = balls[i];
    if (A.where !== 'table') continue;
    for (let j = i + 1; j < balls.length; j++) {
      const B = balls[j];
      if (B.where !== 'table') continue;
      if (!A.moving && !B.moving) continue;
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= lim) continue;
      const closing = (A.vx - B.vx) * dx + (A.vy - B.vy) * dy + (A.vz - B.vz) * dz;
      if (closing > 1e-12) {
        if (ballHit(A, B, geo, k, h, events)) hit = true;
      } else {
        const d = Math.sqrt(d2);
        if (d > 0) {
          const push = (R2 - d) / 2 / d;
          A.x -= dx * push; A.y -= dy * push; A.z -= dz * push;
          B.x += dx * push; B.y += dy * push; B.z += dz * push;
          keepAboveSurface(A, geo, k);
          keepAboveSurface(B, geo, k);
        }
      }
    }
  }
  return hit;
}

// ---------------------------------------------------------------- cushions

/**
 * Restitution of the cushion for a closing speed v.
 * @param {PhysicsConst} k @param {number} v
 * @returns {number}
 */
function cushionE(k, v) {
  const f = v >= k.cFast ? 1 : v / k.cFast;
  return k.cE0 + (k.cE1 - k.cE0) * f;
}

/**
 * Closest point parameter (0..len) on a cushion piece to (x, z).
 * @param {import('./table.js').CushionPiece} c @param {number} x @param {number} z
 * @returns {number}
 */
function along(c, x, z) {
  let s = (x - c.ax) * c.ux + (z - c.az) * c.uz;
  if (s < 0) s = 0;
  if (s > c.len) s = c.len;
  return s;
}

/**
 * Checks one ball against one cushion edge (a horizontal line at height ey). Resolves a hit or pushes out.
 * @param {Ball} b @param {import('./table.js').CushionPiece} c @param {number} ey
 * @param {TableGeometry} geo @param {PhysicsConst} k @param {number} h @param {GameEvent[]} events
 * @returns {boolean} true when a hit happened
 */
function edgeCheck(b, c, ey, geo, k, h, events) {
  const R = k.R;
  let s = along(c, b.x, b.z);
  let qx = c.ax + c.ux * s, qz = c.az + c.uz * s;
  let dx = b.x - qx, dy = b.y - ey, dz = b.z - qz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 >= R * R) return false;
  const closing = b.vx * dx + b.vy * dy + b.vz * dz;
  if (closing < -1e-12) {
    // Rewind to first touch. Inside the piece only the velocity across the line matters.
    let ex = b.vx, ey2 = b.vy, ez = b.vz;
    if (s > 0 && s < c.len) {
      const va = b.vx * c.ux + b.vz * c.uz;
      ex -= va * c.ux; ez -= va * c.uz;
    }
    const t = backTime(dx, dy, dz, ex, ey2, ez, R, h);
    b.x -= b.vx * t; b.y -= b.vy * t; b.z -= b.vz * t;
    s = along(c, b.x, b.z);
    qx = c.ax + c.ux * s; qz = c.az + c.uz * s;
    dx = b.x - qx; dy = b.y - ey; dz = b.z - qz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const vn = b.vx * nx + b.vy * ny + b.vz * nz;
    if (vn < 0) {
      const m = k.m;
      const jn = -(1 + cushionE(k, -vn)) * vn * m;
      // Contact point at r = -R n; its velocity u = v + w x r.
      let ux = b.vx - R * (b.wy * nz - b.wz * ny);
      let uy = b.vy - R * (b.wz * nx - b.wx * nz);
      let uz = b.vz - R * (b.wx * ny - b.wy * nx);
      const un = ux * nx + uy * ny + uz * nz;
      ux -= un * nx; uy -= un * ny; uz -= un * nz;
      const ut = Math.sqrt(ux * ux + uy * uy + uz * uz);
      let jt = 0, tx = 0, ty = 0, tz = 0;
      if (ut > SLIP_EPS) {
        tx = ux / ut; ty = uy / ut; tz = uz / ut;
        jt = Math.min(k.cMu * jn, ut * m / 3.5);
      }
      const px = jn * nx - jt * tx, py = jn * ny - jt * ty, pz = jn * nz - jt * tz;
      b.vx += px / m; b.vy += py / m; b.vz += pz / m;
      // r x P with r = -R n
      b.wx += -R * (ny * pz - nz * py) / k.I;
      b.wy += -R * (nz * px - nx * pz) / k.I;
      b.wz += -R * (nx * py - ny * px) / k.I;
      b.moving = true;
      pressReaction(b, geo, k, -vn);
      events.push({ type: 'cushion', ball: b.id, speed: -vn, x: qx, y: ey, z: qz });
    }
    b.x += b.vx * t; b.y += b.vy * t; b.z += b.vz * t;
    keepAboveSurface(b, geo, k);
    return vn < 0;
  }
  // Touching but not closing: push out sideways so the ball rests exactly on the edge.
  if (Math.abs(dy) < R) {
    const hd = Math.sqrt(dx * dx + dz * dz);
    if (hd > 1e-12) {
      const want = Math.sqrt(R * R - dy * dy);
      b.x = qx + dx / hd * want; b.z = qz + dz / hd * want;
    }
  }
  return false;
}

/**
 * One pass of every moving ball near the edge against every cushion piece (nose line and top line).
 * @param {Ball[]} balls @param {TableGeometry} geo @param {PhysicsConst} k @param {number} h @param {GameEvent[]} events
 * @returns {boolean}
 */
function cushionPass(balls, geo, k, h, events) {
  const R = k.R;
  const nearW = geo.halfW - R - 1e-6, nearL = geo.halfL - R - 1e-6;
  let hit = false;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.where !== 'table' || !b.moving) continue;
    if (b.y - R > geo.railTopHeight + TOUCH_EPS) continue;          // flying over everything
    if (Math.abs(b.x) < nearW && Math.abs(b.z) < nearL) continue;   // nowhere near a cushion
    const cs = geo.cushions;
    for (let j = 0; j < cs.length; j++) {
      if (edgeCheck(b, cs[j], geo.noseHeight, geo, k, h, events)) hit = true;
      if (edgeCheck(b, cs[j], geo.railTopHeight, geo, k, h, events)) hit = true;
    }
  }
  return hit;
}

// ---------------------------------------------------------------- the tick

/**
 * Pockets, the floor and coming to rest, after the hits of a substep.
 * @param {Ball} b @param {TableGeometry} geo @param {PhysicsConst} k @param {GameEvent[]} events
 */
function afterSubstep(b, geo, k, events) {
  if (b.y < k.R * k.potDepth) {
    for (let i = 0; i < geo.pockets.length; i++) {
      const pk = geo.pockets[i];
      const dx = b.x - pk.x, dz = b.z - pk.z;
      if (dx * dx + dz * dz < pk.r * pk.r) {
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
        events.push({ type: 'pocket', ball: b.id, pocket: i, speed: sp, x: b.x, y: b.y, z: b.z });
        b.where = 'potted'; b.pocket = i;
        stopBall(b);
        return;
      }
    }
  }
  if (b.y < geo.floorY) {
    const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    events.push({ type: 'offTable', ball: b.id, speed: sp, x: b.x, y: b.y, z: b.z });
    b.where = 'off';
    stopBall(b);
    return;
  }
  // Rest: on a surface, slow, not slipping, hardly spinning.
  if (b.vy !== 0) return;
  if (!onSurface(b, geo, k)) return;
  const v2 = b.vx * b.vx + b.vz * b.vz;
  const rs = k.restSpeed;
  if (v2 > rs * rs) return;
  const ux = b.vx + k.R * b.wz, uz = b.vz - k.R * b.wx;
  if (ux * ux + uz * uz > rs * rs) return;
  if (Math.abs(b.wy) > k.restSpin) return;
  stopBall(b);
}

/**
 * Sets every speed and spin to exactly zero.
 * @param {Ball} b
 */
function stopBall(b) {
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.wx = 0; b.wy = 0; b.wz = 0;
  b.moving = false;
}

/**
 * Advances the balls by one tick, in as many substeps as needed so no ball moves more than
 * maxMove radii per substep.
 * @param {GameState} state @param {TableGeometry} geo @param {PhysicsConst} k @param {GameEvent[]} events
 */
export function simulateTick(state, geo, k, events) {
  const balls = state.balls;
  let maxV = 0;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.where !== 'table' || !b.moving) continue;
    const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    const w = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz) * k.R;
    if (v > maxV) maxV = v;
    if (w > maxV) maxV = w;
  }
  // A falling ball speeds up during the tick; allow for it.
  maxV += k.g * k.dt;
  let n = Math.floor(maxV * k.dt / (k.maxMove * k.R)) + 1;
  if (n > k.maxSubsteps) n = k.maxSubsteps;
  const h = k.dt / n;
  for (let s = 0; s < n; s++) {
    let any = false;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.where !== 'table' || !b.moving) continue;
      moveBall(b, geo, k, h, events);
      any = true;
    }
    if (!any) break;
    for (let p = 0; p < k.maxPasses; p++) {
      const a = ballPass(balls, geo, k, h, events);
      const c = cushionPass(balls, geo, k, h, events);
      if (!a && !c) break;
    }
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.where !== 'table' || !b.moving) continue;
      afterSubstep(b, geo, k, events);
    }
  }
}

/**
 * True when no ball on the table is moving.
 * @param {GameState} state
 * @returns {boolean}
 */
export function allAtRest(state) {
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (b.where === 'table' && b.moving) return false;
  }
  return true;
}

/**
 * The cue strike: an instant impulse from the cue along its direction (with elevation) through the tip point.
 * Sets the cue ball's speed and spin, then lets the felt answer if the strike drives the ball down into it.
 * @param {Ball} b  the cue ball
 * @param {import('./types.js').ShootAction} a
 * @param {TableGeometry} geo @param {PhysicsConst} k @param {GameEvent[]} events
 */
export function strike(b, a, geo, k, events) {
  let dx = num(a.dirX, 0), dz = num(a.dirZ, -1);
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl < 1e-9) { dx = 0; dz = -1; } else { dx /= dl; dz /= dl; }
  let speed = num(a.speed, 0);
  if (speed < 0) speed = 0;
  if (speed > k.maxShotSpeed) speed = k.maxShotSpeed;
  let es = num(a.elevSin, k.elevSin), ec = num(a.elevCos, k.elevCos);
  if (es < 0) es = 0;
  const el = Math.sqrt(es * es + ec * ec);
  if (el < 1e-9) { es = k.elevSin; ec = k.elevCos; } else { es /= el; ec /= el; }
  let ox = num(a.offX, 0), oy = num(a.offY, 0);
  const ol = Math.sqrt(ox * ox + oy * oy);
  if (ol > k.maxTip) { ox = ox / ol * k.maxTip; oy = oy / ol * k.maxTip; }
  // Cue direction d (down into the ball when the butt is raised), right r, and "up" u across the cue.
  const fx = dx * ec, fy = -es, fz = dz * ec;
  const rx = -dz, rz = dx;
  const upx = -rz * fy, upy = rz * fx - rx * fz, upz = rx * fy;
  const R = k.R;
  const cx = R * (ox * rx + oy * upx), cy = R * (oy * upy), cz = R * (ox * rz + oy * upz);
  b.vx = speed * fx; b.vy = speed * fy; b.vz = speed * fz;
  // w = (c x m v) / I
  const s = speed * k.m / k.I;
  b.wx = s * (cy * fz - cz * fy);
  b.wy = s * (cz * fx - cx * fz);
  b.wz = s * (cx * fy - cy * fx);
  b.moving = true;
  events.push({ type: 'cueStrike', ball: b.id, speed, x: b.x, y: b.y, z: b.z });
  strikeIntoBed(b, geo, k, events);
}

/**
 * A finite number, or the fallback.
 * @param {*} v @param {number} fallback
 * @returns {number}
 */
function num(v, fallback) {
  return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity ? v : fallback;
}
