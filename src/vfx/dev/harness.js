import * as THREE from 'three/webgpu';
import { terrainHeight, raycastTerrain } from '../../world/terrain/heightfield.js';

/**
 * Dev-only VFX harness (loaded in dev builds only).
 *
 * Combat is written by another area, so this stands in for it: it creates
 * synthetic entities, moves them, and emits the same events combat will.
 *
 *   __vfxTest('salvo')                 run a scenario (see `scenarios` below)
 *   __vfxTest.list()                   scenario names
 *   __vfxTest.cam({ rel: [r, u, b], look: [r, u, b] })   camera relative to the player (right, up, back)
 *   __vfxTest.cam({ from: [x,y,z], to: [x,y,z] })         world-space camera;  cam(null) releases it
 *   __vfxTest.freeze() / .resume()     stop/start game time (rendering continues)
 *   await __vfxTest.step(seconds)      advance simulated time quickly (no rendering)
 *   __vfxTest.hold(true)               pin the player to straight and level at a safe height
 *   __vfxTest.sun(elevationDeg, azimuthDeg)
 *   await __vfxTest.bench(frames)      ms/frame with the VFX layer on vs off
 *
 * `?vfxtest=name` runs a scenario two seconds after boot.
 */
export function installHarness(vfx, game) {
  const ents = [];
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const ev = game.events;
  let camSpec = null;
  let held = null;
  let nextId = 1;

  const frame = () => {
    const f = game.flight;
    return { p: f.position, fwd: f.forward.clone(), up: f.up.clone(), right: f.right.clone(), v: f.velocity };
  };
  const rel = (r, u, b) => {
    const f = frame();
    return f.p.clone().addScaledVector(f.right, r).addScaledVector(f.up, u).addScaledVector(f.fwd, -b);
  };

  vfx.devCamera = (camera) => {
    if (held) {
      const f = game.flight;
      f.position.y = held.y; f.velocity.y = 0;
    }
    if (!camSpec) return;
    const from = camSpec.from ? V(...camSpec.from) : rel(...camSpec.rel);
    const to = camSpec.to ? V(...camSpec.to) : camSpec.look ? rel(...camSpec.look) : game.flight.position;
    if (camSpec.follow?.position) to.copy(camSpec.follow.position);
    camera.position.copy(from);
    camera.up.set(0, 1, 0);
    camera.lookAt(to);
    if (camSpec.fov) { camera.fov = camSpec.fov; camera.updateProjectionMatrix(); }
    camera.updateMatrixWorld();
  };

  // ---- synthetic entities ----
  function tick(dt) {
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      e.age += dt;
      e.update?.(e, dt);
      if (e.object3d) { e.object3d.position.copy(e.position); if (e.quaternion) e.object3d.quaternion.copy(e.quaternion); }
      if (e.age > e.maxAge || !e.alive) {
        e.alive = false;
        e.onEnd?.(e);
        ents.splice(i, 1);
      }
    }
  }
  vfx.devTick = tick;
  const lateUpdate = vfx.lateUpdate.bind(vfx);
  vfx.lateUpdate = (dt, g) => { if (dt > 0) tick(dt); lateUpdate(dt, g); };

  function missile({ from, dir, target = null, kind = 'aam', speed = 320, maxSpeed = 850, life = 9, turn = 0.5, explode = true, wander = 0.35 }) {
    const m = {
      id: `m${nextId++}`, kind, team: 'player', alive: true, age: 0, maxAge: life, owner: null, motor: true,
      position: from.clone(), velocity: dir.clone().normalize().multiplyScalar(speed), quaternion: new THREE.Quaternion(),
      seed: Math.random() * 100,
    };
    const fwd = V(), want = V(), side = V();
    m.update = (e, dt) => {
      const sp = Math.min(maxSpeed, e.velocity.length() + 260 * dt);
      fwd.copy(e.velocity).normalize();
      if (target) want.copy(target.position ?? target).sub(e.position).normalize();
      else {
        // weave: a slowly rotating lateral pull, like a missile chasing a jinking target
        side.set(Math.sin(e.age * 0.9 + e.seed), Math.cos(e.age * 0.7 + e.seed * 1.3) * 0.6, Math.cos(e.age * 0.8 + e.seed)).multiplyScalar(wander);
        want.copy(fwd).add(side).normalize();
      }
      fwd.lerp(want, Math.min(1, turn * dt * 3)).normalize();
      e.velocity.copy(fwd).multiplyScalar(sp);
      e.position.addScaledVector(e.velocity, dt);
      e.quaternion.setFromUnitVectors(V(0, 0, -1), fwd);
      const hitGround = e.position.y < terrainHeight(e.position.x, e.position.z) + 2;
      const hitTarget = target && e.position.distanceTo(target.position ?? target) < 25;
      if (hitGround || hitTarget) { e.alive = false; e.reason = hitGround ? 'ground' : 'hit'; }
    };
    m.onEnd = (e) => {
      ev.emit('missile:end', { missile: e, reason: e.reason ?? 'fuel' });
      if (explode) ev.emit('explosion', { position: e.position.clone(), size: kind === 'sam' ? 'large' : 'medium', kind: e.reason === 'ground' ? 'ground' : 'missile', velocity: e.velocity.clone().multiplyScalar(0.2) });
    };
    ents.push(m);
    ev.emit('missile:launch', { missile: m });
    return m;
  }

  function flare(from, vel) {
    const f = { id: `f${nextId++}`, kind: 'flare', alive: true, age: 0, maxAge: 4.5, position: from.clone(), velocity: vel.clone() };
    f.update = (e, dt) => {
      e.velocity.multiplyScalar(Math.exp(-1.1 * dt));
      e.velocity.y -= 9.81 * dt;
      e.position.addScaledVector(e.velocity, dt);
    };
    ents.push(f);
    ev.emit('flare:release', { flare: f });
    return f;
  }

  function aircraft({ offset = [40, 5, -30], throttle = 1, reheat = 1, turnG = 0, speed = null, life = 30, model = true }) {
    const f = frame();
    const a = {
      id: `a${nextId++}`, kind: 'fighter', team: 'hostile', alive: true, age: 0, maxAge: life,
      position: rel(...offset), velocity: f.v.clone(), quaternion: game.flight.orientation.clone(),
      engine: { throttle, reheat }, health: 1,
    };
    if (speed) a.velocity.setLength(speed);
    if (model) {
      a.object3d = game.player.model.clone(true);
      game.scene.add(a.object3d);
    }
    const q = new THREE.Quaternion(), axis = V();
    a.update = (e, dt) => {
      if (e.falling) {
        e.velocity.y -= 9.81 * dt * 0.8;
        e.velocity.multiplyScalar(Math.exp(-0.05 * dt));
        axis.set(0, 0, 1).applyQuaternion(e.quaternion);
        e.quaternion.premultiply(q.setFromAxisAngle(axis, 2.2 * dt));
      } else if (turnG) {
        // constant-g level-ish turn
        const sp = e.velocity.length();
        const rate = (turnG * 9.81) / sp;
        e.velocity.applyAxisAngle(V(0, 1, 0), rate * dt);
        const fw = e.velocity.clone().normalize();
        const bank = Math.atan(turnG) * -Math.sign(rate);
        e.quaternion.setFromUnitVectors(V(0, 0, -1), fw).multiply(q.setFromAxisAngle(V(0, 0, 1), -bank));
        e.gLoad = Math.hypot(turnG, 1);
      }
      e.position.addScaledVector(e.velocity, dt);
      if (e.position.y < terrainHeight(e.position.x, e.position.z) + 3) e.alive = false;
    };
    a.onEnd = (e) => {
      ev.emit('aircraft:despawn', { entity: e });
      e.object3d?.removeFromParent();
    };
    ents.push(a);
    ev.emit('aircraft:spawn', { entity: a });
    return a;
  }

  function groundAhead(distance, lateral = 0) {
    const f = frame();
    const flat = V(f.fwd.x, 0, f.fwd.z).normalize();
    const side = V(-flat.z, 0, flat.x);
    const p = f.p.clone().addScaledVector(flat, distance).addScaledVector(side, lateral);
    p.y = terrainHeight(p.x, p.z);
    return p;
  }

  const overridePlayer = (o) => {
    const p = vfx.aircraft.player;
    for (const k of ['engine', 'gLoad', 'aoa']) {
      if (k in o) Object.defineProperty(p, k, { configurable: true, get: () => o[k] });
    }
  };

  const scenarios = {
    /** One AAM off the rail, weaving. */
    missile: (o = {}) => missile({ from: rel(2.5, -1, -4), dir: frame().fwd, ...o }),
    /** Six missiles on diverging curved paths: the classic sky full of trails. */
    salvo: (o = {}) => {
      const f = frame();
      const out = [];
      for (let i = 0; i < (o.count ?? 6); i++) {
        const dir = f.fwd.clone().addScaledVector(f.right, (i - 2.5) * 0.09).addScaledVector(f.up, ((i % 3) - 1) * 0.07);
        out.push(missile({ from: rel((i - 2.5) * 1.6, -1, -4), dir, life: 8 + i * 0.6, wander: 0.3 + i * 0.05, ...o }));
      }
      return out;
    },
    /** A SAM rising from the valley ahead toward the player. */
    sam: (o = {}) => {
      const g = groundAhead(o.distance ?? 2500, o.lateral ?? 600);
      return missile({ from: g.add(V(0, 3, 0)), dir: V(0.15, 1, 0.1), target: { position: game.flight.position }, kind: 'sam', speed: 120, maxSpeed: 700, turn: 0.35, life: 14, ...o });
    },
    /** Air burst `dist` metres ahead. */
    explosion: (o = {}) => {
      const p = rel(o.right ?? 0, o.up ?? 0, -(o.dist ?? 300));
      ev.emit('explosion', { position: p, size: o.size ?? 'medium', kind: o.kind ?? 'air', velocity: o.velocity ?? null });
      return p;
    },
    /** Ground strike on the terrain ahead, with the fire it leaves. */
    ground: (o = {}) => {
      const p = groundAhead(o.dist ?? 900, o.lateral ?? 0);
      ev.emit('explosion', { position: p, size: o.size ?? 'large', kind: 'ground' });
      return p;
    },
    fire: (o = {}) => {
      const p = groundAhead(o.dist ?? 600, o.lateral ?? 0);
      vfx.spawnFire(p, { size: o.size ?? 4, duration: o.duration ?? Infinity });
      return p;
    },
    /** A burst of flares off both sides. */
    flares: (o = {}) => {
      const f = frame();
      const out = [];
      for (let i = 0; i < (o.count ?? 6); i++) {
        const side = i % 2 ? 1 : -1;
        const v = f.v.clone().multiplyScalar(0.85).addScaledVector(f.right, side * (18 + i * 3)).addScaledVector(f.up, -14 - i * 2);
        const fl = flare(rel(side * 1.5, -0.8, 2), v);
        fl.age = -i * 0.12; // staggered burn-out
        out.push(fl);
      }
      return out;
    },
    /** Player gun burst with terrain impacts. */
    gun: (o = {}) => {
      const dur = o.duration ?? 1.6;
      ev.emit('weapon:gun', { firing: true, entity: null });
      const e = { alive: true, age: 0, maxAge: dur, acc: 0 };
      e.update = (s, dt) => {
        s.acc += dt * 30;
        const f = frame();
        while (s.acc >= 1) {
          s.acc -= 1;
          const d = f.fwd.clone().add(V((Math.random() - 0.5) * 0.012, (Math.random() - 0.5) * 0.012 - (o.down ?? 0.25), (Math.random() - 0.5) * 0.012)).normalize();
          const t = raycastTerrain(f.p.x, f.p.y, f.p.z, d.x, d.y, d.z, 6000, 30);
          if (Number.isFinite(t)) setTimeout(() => ev.emit('weapon:gunHit', { position: f.p.clone().addScaledVector(d, t), normal: V(0, 1, 0), targetKind: 'terrain' }), (t / 880) * 1000);
        }
      };
      e.onEnd = () => ev.emit('weapon:gun', { firing: false, entity: null });
      ents.push(e);
    },
    /** Sparks: gun hits on a metal target. */
    hits: (o = {}) => {
      for (let i = 0; i < 6; i++) setTimeout(() => ev.emit('weapon:gunHit', { position: rel((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2, -(o.dist ?? 60)), normal: V(0, 0, 1), targetKind: 'aircraft' }), i * 70);
    },
    /** Full reheat, hard turn and transonic speed on the player's own effects. */
    burner: (o = {}) => overridePlayer({ engine: { throttle: o.throttle ?? 1, reheat: o.reheat ?? 1 } }),
    turn: (o = {}) => overridePlayer({ gLoad: o.g ?? 7.5, aoa: o.aoa ?? 0.3 }),
    normal: () => { const p = vfx.aircraft.player; delete p.engine; delete p.gLoad; delete p.aoa; },
    /** A hostile fighter alongside: reheat lit, optional hard turn (vapour, vortices). */
    wingman: (o = {}) => aircraft(o),
    /** A hostile is hit, burns, is destroyed and falls. */
    burning: (o = {}) => {
      const a = aircraft({ offset: o.offset ?? [60, 20, -160], throttle: 0.9, reheat: 0, life: 40, ...o });
      a.health = 0.2;
      ev.emit('target:hit', { target: a, damage: 0.8 });
      const k = { alive: true, age: 0, maxAge: o.delay ?? 3 };
      k.onEnd = () => {
        ev.emit('explosion', { position: a.position.clone(), size: 'large', kind: 'air', velocity: a.velocity.clone() });
        ev.emit('target:destroyed', { target: a, killer: null, position: a.position.clone(), score: 100 });
        a.alive = false;
      };
      ents.push(k);
      return a;
    },
    /** Transonic vapour cone on a wingman (forces the Mach number). */
    cone: (o = {}) => aircraft({ offset: [25, 2, -25], throttle: 1, reheat: 1, speed: (o.mach ?? 0.97) * 322, ...o }),
    cloud: (o = {}) => { game.env.inCloud = o.amount ?? 1; setTimeout(() => { game.env.inCloud = 0; }, (o.duration ?? 4) * 1000); },
    crash: () => ev.emit('player:crash', { position: groundAhead(400), velocity: game.flight.velocity.clone() }),
    /** The perf scenario from the brief: 10 trails, 3 explosions, 2 fires, flares, a burning aircraft. */
    combat: () => {
      scenarios.salvo({ count: 10 });
      scenarios.flares({ count: 8 });
      scenarios.fire({ dist: 700, lateral: -150 });
      scenarios.fire({ dist: 1100, lateral: 250, size: 6 });
      scenarios.burning({});
      const e = { alive: true, age: 0, maxAge: 1.2 };
      e.onEnd = () => {
        scenarios.explosion({ dist: 250, right: -60, size: 'large' });
        scenarios.explosion({ dist: 450, right: 90, up: 30, size: 'medium' });
        scenarios.ground({ dist: 800, size: 'large' });
      };
      ents.push(e);
    },
  };

  const run = (name, opts) => {
    const fn = scenarios[name];
    if (!fn) throw new Error(`vfx test "${name}" not found; try ${Object.keys(scenarios).join(', ')}`);
    return fn(opts);
  };
  run.list = () => Object.keys(scenarios);
  // While frozen the real-time loop is paused (it still renders); time only
  // advances through step(), so sequences are deterministic.
  const manual = (fn) => {
    const p = game.paused, ts = game.timeScale;
    game.paused = false;
    try { return fn(); } finally { game.paused = p; game.timeScale = ts; }
  };
  const refresh = () => manual(() => { game.timeScale = 0; game.update(0); });
  run.cam = (spec) => { camSpec = spec; if (game.paused) refresh(); };
  run.freeze = () => { game.paused = true; };
  run.resume = () => { game.paused = false; game.timeScale = 1; };
  run.hold = (on = true, y = 6800) => { held = on ? { y } : null; if (on) game.flight.position.y = y; };
  run.step = async (seconds, fps = 60) => {
    manual(() => {
      game.timeScale = 1;
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) game.update(1 / fps);
    });
    return vfx.stats();
  };
  run.sun = (elevation, azimuth) => game.env.setSun?.(elevation, azimuth);
  run.entities = () => ents;
  run.stats = () => vfx.stats();
  /** Average ms per frame rendering the current (frozen) frame, VFX on vs off. */
  run.bench = async (frames = 120) => {
    const device = game.r.renderer.backend.device;
    const done = () => (device ? device.queue.onSubmittedWorkDone() : new Promise((r) => setTimeout(r, 50)));
    const paused = game.paused;
    game.paused = true; // keep the real-time loop from advancing or double-counting
    const one = () => { manual(() => { game.timeScale = 0; game.update(0); }); newFrame(); game.post.render(); };
    const loop = async () => {
      for (let i = 0; i < 10; i++) one();
      await done();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) one();
      await done();
      return (performance.now() - t0) / frames;
    };
    const on = await loop();
    const kids = vfx.scene.children.map((c) => [c, c.visible]);
    const lu = vfx.lateUpdate;
    for (const [c] of kids) c.visible = false;
    vfx.lateUpdate = () => {};
    const off = await loop();
    for (const [c, vis] of kids) c.visible = vis;
    vfx.lateUpdate = lu;
    game.paused = paused;
    return { on: +on.toFixed(3), off: +off.toFixed(3), vfx: +(on - off).toFixed(3), frames, size: [game.r.renderer.domElement.width, game.r.renderer.domElement.height] };
  };

  // Pass nodes re-render once per node frame; a manual render outside the
  // animation loop has to advance it or it would composite a stale scene.
  const newFrame = () => game.r.renderer._nodes?.nodeFrame?.update?.();

  // Contact sheet: several moments of an effect in one screenshot.
  let sheet = null;
  run.sheet = (cols = 3, rows = 2) => {
    sheet?.canvas.remove();
    const canvas = document.createElement('canvas');
    canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio;
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:#000';
    document.body.appendChild(canvas);
    sheet = { canvas, ctx: canvas.getContext('2d'), cols, rows, i: 0 };
  };
  let snapRT = null, snapCanvas = null;
  run.snap = async (label = '') => {
    if (!sheet) run.sheet();
    const renderer = game.r.renderer;
    const src = renderer.domElement;
    if (!snapRT || snapRT.width !== src.width || snapRT.height !== src.height) {
      snapRT?.dispose();
      snapRT = new THREE.RenderTarget(src.width, src.height, { type: THREE.UnsignedByteType, depthBuffer: false });
      snapCanvas = document.createElement('canvas');
      snapCanvas.width = src.width; snapCanvas.height = src.height;
    }
    // Render the whole post chain into a target and read it back: a background
    // tab does not present canvas frames, so the canvas itself cannot be copied.
    refresh();
    newFrame();
    renderer.setRenderTarget(snapRT);
    game.post.render();
    renderer.setRenderTarget(null);
    const px = await renderer.readRenderTargetPixelsAsync(snapRT, 0, 0, src.width, src.height);
    const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, src.width * src.height * 4), src.width, src.height);
    snapCanvas.getContext('2d').putImageData(img, 0, 0);
    const { canvas, ctx, cols, rows } = sheet;
    const w = canvas.width / cols, h = canvas.height / rows;
    const x = (sheet.i % cols) * w, y = Math.floor(sheet.i / cols) * h;
    // crop the source to the tile's aspect around the centre
    const sa = src.width / src.height, ta = w / h;
    const sw = sa > ta ? src.height * ta : src.width, shh = sa > ta ? src.height : src.width / ta;
    ctx.drawImage(snapCanvas, (src.width - sw) / 2, (src.height - shh) / 2, sw, shh, x, y, w, h);
    if (label) { ctx.font = `${Math.round(h * 0.05)}px sans-serif`; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(label, x + 8, y + h - 10); ctx.fillText(label, x + 8, y + h - 10); }
    sheet.i++;
  };
  run.sheetOff = () => { sheet?.canvas.remove(); sheet = null; };

  window.__vfx = vfx;
  window.__vfxTest = run;
  const auto = new URLSearchParams(location.search).get('vfxtest');
  if (auto && scenarios[auto]) setTimeout(() => run(auto), 2000);
}
