// Trailer combat-reel helpers, evaluated in the dev game page (chrome
// devtools evaluate_script, format "script"). Installs window.__strike,
// window.__aimAp and window.__gunRun on top of window.__trailer / __capture.
//
//   __strike({ units: [['aaa', dist, lateral], ...], view, alt, settle })
//       straight run down the valley at x=-20000 z=9000 heading 285 (clear
//       for 6 km), hostiles switched on, kill/missile cams off
//   __gunRun({ clip, view, types })
//       an aim autopilot dives the nose onto a ground group, guns at fireAt,
//       pull-up at pullAt, recorded with __capture
(() => {
  const g = window.__game, T = window.__trailer;
  const H = () => import('/src/world/terrain/heightfield.js');
  const RUN = { x: -20000, z: 9000, heading: 285 };

  window.__strike = async ({ time = 7.0, alt, agl, heading = RUN.heading, x = RUN.x, z = RUN.z, speed = 220,
    units = [], sim = 1.2, view = 'cockpit', settle = 0 } = {}) => {
    window.__camTest.reset();
    await T.sortie('free');
    // let the smoke of an earlier take die away before flying back through it
    if (settle) { g.spawnAt({ x, z, alt: 9000, heading: 0, speed: 220 }); await T.sim(settle); }
    g.env.setTimeOfDay(time);
    T.killCam(false); T.missileCam(false); g.autopilot = null;
    g.spawnAt(alt != null ? { x, z, alt, heading, speed } : { x, z, agl, heading, speed });
    const f = g.flight, ai = g.systems.ai;
    const us = units.map(([t, d, lat]) => ai.spawnGround(t,
      f.position.x + f.forward.x * d + f.right.x * lat, f.position.z + f.forward.z * d + f.right.z * lat, {}));
    ai.hostile = true; // the free sortie spawns its hostiles passive
    T.view(view);
    await T.sim(sim);
    return us;
  };

  /** Autopilot that holds the nose (not the flight path) on a world point. */
  window.__aimAp = (tp, { gain = 15, damp = 3, maxDive = 1, throttle = 0.8 } = {}) => ({
    intent: { turn: 0, climb: 0, yaw: 0, speed: 0, boost: false, brake: 0, throttle },
    last: null,
    update(dt, f) {
      const p = f.position;
      const dx = tp.x - p.x, dy = tp.y - p.y, dz = tp.z - p.z;
      const bearing = Math.atan2(dx, -dz), heading = Math.atan2(f.forward.x, -f.forward.z);
      let d = bearing - heading;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      this.intent.turn = Math.max(-1, Math.min(1, d * 2));
      const want = Math.atan2(dy, Math.hypot(dx, dz));
      const pitch = Math.asin(Math.max(-1, Math.min(1, f.forward.y)));
      const err = want - pitch;
      const derr = this.last == null ? 0 : (err - this.last) / Math.max(dt, 1e-3);
      this.last = err;
      this.intent.climb = Math.max(-maxDive, Math.min(0.9, err * gain + derr * damp));
      return this.intent;
    },
  });

  window.__gunRun = async ({ clip, view = 'cockpit', secs = 5, fireAt = 8, fireEnd = 105, pullAt = 110, lead = 2.1, pre = 1.0,
    dist = 2400, above = 420, gun = true, each = null, aimLong = 175,
    types = [['truck', 0, 0], ['truck', 25, 14], ['tent', -20, 10], ['sangar', 10, -30]] } = {}) => {
    const { terrainHeight } = await H();
    const { x, z } = RUN, hd = (RUN.heading * Math.PI) / 180;
    const fx = Math.sin(hd), fz = -Math.cos(hd), rx = Math.cos(hd), rz = Math.sin(hd);
    const tx = x + fx * dist, tz = z + fz * dist, ty = terrainHeight(tx, tz);
    window.__camTest.reset();
    await T.sortie('free');
    g.spawnAt({ x, z, alt: 9000, heading: 0, speed: 220 });
    await T.sim(20);
    g.env.setTimeOfDay(7.0);
    T.killCam(false); T.missileCam(false);
    g.spawnAt({ x, z, alt: ty + above, heading: RUN.heading, speed: 220 });
    const us = types.map(([t, a, b]) => g.systems.ai.spawnGround(t, tx + fx * a + rx * b, tz + fz * a + rz * b, {}));
    // the rounds fall short of the nose line (gravity, gun boresight): aim long
    const tp = g.flight.position.clone().set(tx + fx * aimLong, ty + 3, tz + fz * aimLong);
    g.autopilot = window.__aimAp(tp);
    T.view(view);
    await T.sim(lead);
    const ap = g.autopilot;
    const r = await T.rec(clip, secs, {
      pre,
      each: (s, i) => {
        if (gun && i === fireAt) g.input.setAction('fireGun', true);
        if (gun && i === fireEnd) g.input.setAction('fireGun', false);
        if (i === pullAt) g.autopilot = { intent: { ...ap.intent, turn: 0, climb: 0.9 }, update() { return this.intent; } };
        each?.(s, i, { tp, us });
      },
    });
    g.input.setAction('fireGun', false);
    return { r, alive: us.map((u) => u.entity.alive) };
  };
  return 'strike helpers installed';
})();
