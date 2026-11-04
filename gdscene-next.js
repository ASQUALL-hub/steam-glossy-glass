/* gdscene.js: a small Geometry Dash level player for the browser.

   Plays a level exported by tools/export_level.py: an invisible player runs right at
   the level's speed (speed portals change it), triggers fire as the player passes
   them (or when a spawn trigger calls their group), and the scene is drawn with
   WebGL from GD's sprite sheets, every object tinted by its colour channel.

   Supported triggers: colour, pulse (colour and HSV, on channels or groups), alpha,
   toggle, spawn (with delay), move (offset, easing, lock to player X), rotate
   (around a centre group), zoom, static camera, camera offset, shake, speed, radial blur
   (GD's shader trigger, on the whole picture). Custom particle objects run as cocos2d
   particle systems (gravity and radius modes).

   const scene = await GDScene.create(canvas, { base: "web/" });
   scene.play(fromSeconds) / scene.seek(seconds) / scene.view = {x, y, zoom} */
(() => {
  "use strict";
  const SPEED_UNITS = [251.16, 311.58, 387.42, 468.0, 576.0];   // units/s for 0.5x, 1x, 2x, 3x, 4x
  const SPEED_OF = { 0.5: 0, 1: 1, 2: 2, 3: 3, 4: 4 };
  const KA4_TO_SPEED = [1, 0, 2, 3, 4];   // kA4: 0 = 1x, 1 = 0.5x, 2 = 2x, 3 = 3x, 4 = 4x
  const VIEW_H = 320;   // GD shows 320 units of height at zoom 1
  const GROUND_Y = 90;  // GD's node space puts y = 0 of the level file this far up
  const SPIN_WAKE = 60;   // how far past the right edge of the screen a rotating object starts turning
  const CELL = 400;   // width of the culling index's columns (level units)
  const TILE = 200;   // side of the culling tiles of moving objects (level units)
  const SHAKE_SCALE = 0.5;    // units of offset per unit of shake strength (matched to the recording)
  const SHAKE_SETTLE = 0.12;  // seconds a shake takes to ease back to rest
  const PORTAL_REACH = 35;    // units short of a speed portal's centre where it takes the player (matched to GD's timing)
  const TOUCH_REACH = 30;     // the same for touch-activated triggers: the player's 30-unit box meets the trigger's
  const TELEPORT = 60;        // a jump in the recorded player path longer than this in one step is a teleport
  const SCREEN_K = 1.0139;    // GD's shader size factor (a global / CCDirector's screenScaleFactorW, read live for a 16:9 window)

  // ------------------------------------------------------------------ easing (GD / cocos2d)
  function ease(type, rate, t) {
    rate = rate || 2;
    const pow = Math.pow, PI = Math.PI;
    const bounceOut = u => {
      if (u < 1 / 2.75) return 7.5625 * u * u;
      if (u < 2 / 2.75) { u -= 1.5 / 2.75; return 7.5625 * u * u + 0.75; }
      if (u < 2.5 / 2.75) { u -= 2.25 / 2.75; return 7.5625 * u * u + 0.9375; }
      u -= 2.625 / 2.75; return 7.5625 * u * u + 0.984375;
    };
    const elasticOut = (u, p) => u === 0 || u === 1 ? u : pow(2, -10 * u) * Math.sin((u - p / 4) * 2 * PI / p) + 1;
    switch (type | 0) {
      case 1: t *= 2; return t < 1 ? 0.5 * pow(t, rate) : 1 - 0.5 * pow(2 - t, rate);
      case 2: return pow(t, rate);
      case 3: return pow(t, 1 / rate);
      // elastic: GD hands its easing rate to cocos2d as the period (fitted on Deprivation's ring
      // scales in GD's paused snapshots: rate 5 matches to within 0.01, cocos' own 0.3 doesn't)
      case 4: { const p = rate; if (t === 0 || t === 1) return t; t = t * 2 - 1;
        return t < 0 ? -0.5 * pow(2, 10 * t) * Math.sin((t - p / 4) * 2 * PI / p)
                     : pow(2, -10 * t) * Math.sin((t - p / 4) * 2 * PI / p) * 0.5 + 1; }
      case 5: return 1 - elasticOut(1 - t, rate);
      case 6: return elasticOut(t, rate);
      case 7: return t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (bounceOut(2 * t - 1) + 1) / 2;
      case 8: return 1 - bounceOut(1 - t);
      case 9: return bounceOut(t);
      case 10: if (t === 0 || t === 1) return t; return t < 0.5 ? pow(2, 20 * t - 10) / 2 : (2 - pow(2, -20 * t + 10)) / 2;
      case 11: return t === 0 ? 0 : pow(2, 10 * (t - 1));
      case 12: return t === 1 ? 1 : 1 - pow(2, -10 * t);
      case 13: return -0.5 * (Math.cos(PI * t) - 1);
      case 14: return 1 - Math.cos(t * PI / 2);
      case 15: return Math.sin(t * PI / 2);
      case 16: { const s = 1.70158 * 1.525; t *= 2;
        return t < 1 ? t * t * ((s + 1) * t - s) / 2 : ((t - 2) * (t - 2) * ((s + 1) * (t - 2) + s) + 2) / 2; }
      case 17: { const s = 1.70158; return t * t * ((s + 1) * t - s); }
      case 18: { const s = 1.70158; t -= 1; return t * t * ((s + 1) * t + s) + 1; }
      default: return t;
    }
  }

  // ------------------------------------------------------------------ colour helpers
  function rgb2hsv(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function hsv2rgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m];
  }
  // GD HSV string "h a s a v a sAdd a vAdd"; colours here are 0..1
  function parseHSV(spec) {
    if (!spec) return null;
    const p = String(spec).split("a");
    return [parseFloat(p[0]) || 0, p[1] === undefined ? 1 : parseFloat(p[1]), p[2] === undefined ? 1 : parseFloat(p[2]),
            p[3] === "1", p[4] === "1"];
  }
  // GD keeps colours as whole 0-255 values (ccColor3B) and its HSV step (GameToolbox::transformColor)
  // returns one, cut down to the whole value below: a dark copy loses its slight tint as GD's does
  // (Deprivation's opening rings: the background's (8, 7, 7) at 30% becomes (2, 2, 2), so their shades
  // are neutral greys, (4, 4, 4) and (7, 7, 7) in GD's dump, not pinkish)
  const byte = v => Math.floor(v * 255 + 1e-4) / 255;
  function applyHSV(c, h) {
    if (!h) return c;
    let [hh, s, v] = rgb2hsv(byte(c[0]), byte(c[1]), byte(c[2]));
    // GD's hue (GameToolbox::transformColor, 0x6f4e0): past 360 it wraps in whole degrees, below 0 it gains 360
    // once; cocos2d's RGBfromHSV reads 360 and above as 0
    if (h[0]) { hh += h[0]; if (hh > 360) hh = Math.trunc(hh) % 360; else if (hh < 0) hh += 360; }
    if (hh >= 360) hh = 0;
    s = Math.min(1, Math.max(0, h[3] ? s + h[1] : s * h[1]));
    v = Math.min(1, Math.max(0, h[4] ? v + h[2] : v * h[2]));
    const o = hsv2rgb(hh, s, v);
    return [byte(o[0]), byte(o[1]), byte(o[2])];
  }

  // ------------------------------------------------------------------ particles
  // GD's custom particle objects (2065) are cocos2d particle systems as GD's own libcocos2d runs them
  // (CCParticleSystem::update and initParticle, CCParticleSystemQuad::updateQuadWithParticle), set up
  // by its particle object (docs/gd-triggers.md, "Particles"). p holds cocos2d::ParticleStruct fields
  // by name (missing = 0)
  function makeRandom(seed) {   // mulberry32: seeking replays the same particles
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // GD's string parser reads these as whole numbers (atoi: 12.7 is 12)
  const PARTICLE_INTS = ["TotalParticles", "EmissionRate", "Angle", "AngleVar", "Speed", "SpeedVar", "PosVarX", "PosVarY",
    "GravityX", "GravityY", "RadialAccel", "RadialAccelVar", "TangentialAccel", "TangentialAccelVar", "StartSize",
    "StartSizeVar", "StartSpin", "StartSpinVar", "EndSize", "EndSizeVar", "EndSpin", "EndSpinVar", "StartRadius",
    "StartRadiusVar", "EndRadius", "EndRadiusVar", "RotatePerSecond", "RotatePerSecondVar", "EmitterMode", "PositionType"];
  const DEG = Math.PI / 180;
  const GD_FPS = 180;   // GD's frame rate where none was recorded (it moves particles once a frame)
  const unit = v => Math.min(1, Math.max(0, v));
  const wrap180 = d => d > 180 ? d - 360 : d < -180 ? d + 360 : d;

  class Emitter {
    constructor(p, rnd) {
      this.p = p = Object.assign({}, p);
      for (const k of PARTICLE_INTS) if (p[k]) p[k] = Math.trunc(p[k]);
      this.rnd = rnd;
      this.release();
    }

    // GD gives a particle object a system when it wakes the object and takes it back when it sleeps
    release() { this.claimed = false; this.parts = []; this.counter = 0; this.elapsed = 0; this.clock = 0; this.upd = null; }

    // a fresh system for a woken object: one with a duration waits to be started (respawn); quick start
    // (key 211) runs ten frames of up to 0.2 s at once
    claim(st, now) {
      const p = this.p;
      this.claimed = true; this.upd = st;
      this.finite = (p.Duration || 0) !== -1;
      this.active = !this.finite; this.first = true; this.next = -1;
      if (p.quickStart) { const dt = Math.min((p.Life || 0) / 10, 0.2); for (let k = 0; k < 10; k++) this.update(dt, st, now); }
    }

    // a system with a duration starts again once it has run out and its particles have died, after its
    // respawn delay (the first time: the delay after waking)
    respawn(now) {
      const p = this.p;
      if (this.next < 0) {
        const delay = Math.max(0, (p.respawn || 0) + (p.respawnVar || 0) * (this.rnd() * 2 - 1));
        this.next = (this.first ? now : now + (p.Duration || 0) + (p.Life || 0) + (p.LifeVar || 0)) + delay;
        this.first = false;
      }
      if (this.next < now) { this.parts = []; this.active = true; this.elapsed = 0; this.next = -1; }
    }

    // one engine step: GD's frames within it (fps of them a second), the emitter moving evenly from where
    // it was to where it is (st): each frame lets its new particles go from the emitter's place then
    run(dt, st, now, fps) {
      const h = 1 / fps, from = this.upd || st, c0 = this.clock;
      this.clock += dt;
      const n = Math.min(64, Math.floor(this.clock / h + 1e-9));
      for (let k = 1; k <= n; k++) {
        const u = dt > 0 ? Math.min(1, Math.max(0, (k * h - c0) / dt)) : 1;
        const at = u >= 1 ? st : { ex: from.ex + (st.ex - from.ex) * u, ey: from.ey + (st.ey - from.ey) * u,
                                    wx: from.wx + (st.wx - from.wx) * u, wy: from.wy + (st.wy - from.wy) * u,
                                    angle: from.angle + (st.angle - from.angle) * u, k: st.k, col: st.col, op: st.op };
        this.update(h, at, now - dt * (1 - u));
      }
      this.clock = n === 64 ? 0 : this.clock - n * h;
    }

    // one of GD's frames: new particles first, all from where the emitter is now, then every particle moves
    update(dt, st, now) {
      const p = this.p, total = p.TotalParticles | 0, er = p.EmissionRate | 0;
      this.upd = st;
      if (this.finite) this.respawn(now);
      if (this.active && er !== 0) {
        // (a rate of -1 is a gap of -1 s between particles: the system refills to its total at once)
        const rate = 1 / er;
        if (this.parts.length < total) {
          this.counter += dt;
          while (this.counter > rate) {
            if (this.parts.length !== total) this.spawn(st);
            this.counter -= rate;
            if (this.parts.length >= total) break;
          }
        }
        this.elapsed += dt;
        const dur = p.Duration || 0;
        if (dur !== -1 && dur < this.elapsed) { this.elapsed = dur; this.active = false; this.counter = 0; }
      }
      const parts = this.parts, radiusMode = (p.EmitterMode | 0) === 1, gx = p.GravityX || 0, gy = p.GravityY || 0;
      const uniform = !!p.uniformColorMode, ordered = !!p.orderSensitive;
      let i = 0;
      while (i < parts.length) {
        const q = parts[i];
        q.ttl -= dt;
        if (q.ttl <= 0) {   // (the last particle takes its place, unless the order matters)
          if (ordered) parts.splice(i, 1);
          else { parts[i] = parts[parts.length - 1]; parts.pop(); }
          continue;
        }
        q.rot += q.drot * dt;
        if (!radiusMode) {
          let ax = gx, ay = gy;
          if ((q.radial || q.tangential) && (q.x || q.y)) {
            const l = Math.hypot(q.x, q.y), nx = q.x / l, ny = q.y / l;
            ax += nx * q.radial - ny * q.tangential; ay += ny * q.radial + nx * q.tangential;
          }
          q.dx += ax * dt; q.dy += ay * dt;
          const mx = q.dx * dt, my = q.dy * dt;
          if (q.dir) q.rot += wrap180(q.dir - Math.atan2(my, mx) / DEG - q.rot) * dt * 10;   // (turning to face its way)
          q.x += mx; q.y += my;
        } else {
          q.radius += q.dradius * dt;
          if (q.dir) {
            q.angle += q.dps * dt;
            const nx = -Math.cos(q.angle) * q.radius, ny = -Math.sin(q.angle) * q.radius;
            let d = wrap180(q.dir - Math.atan2(ny - q.y, nx - q.x) / DEG - q.rot);
            if (q.age >= 0.1) d *= dt * 10;
            q.rot += d; q.x = nx; q.y = ny;
          } else if (!q.dps) { q.x = -q.ca * q.radius; q.y = -q.sa * q.radius; }
          else {
            q.angle += q.dps * dt;
            if (q.angle > 2 * Math.PI) q.angle -= 2 * Math.PI; else if (q.angle < 0) q.angle += 2 * Math.PI;
            const d = Math.trunc(q.angle / DEG) * DEG;   // (GD's sine table: whole degrees)
            q.x = -Math.cos(d) * q.radius; q.y = -Math.sin(d) * q.radius;
          }
        }
        q.age += dt;
        if (!uniform) { q.col[0] += q.dcol[0] * dt; q.col[1] += q.dcol[1] * dt; q.col[2] += q.dcol[2] * dt; }
        q.col[3] += q.dcol[3] * dt;
        q.size = Math.max(0, q.size + q.dsize * dt);
        if (q.rot > 360) q.rot -= 360; else if (q.rot < 0) q.rot += 360;
        if (q.fric) {   // friction as stored (GD's parser keeps the sign: a negative one speeds up)
          if (q.fp) { const k = 1 - q.fp * dt; q.dx *= k; q.dy *= k; }
          if (q.fs) q.dsize *= 1 - q.fs * dt;
          if (q.fr) q.drot *= 1 - q.fr * dt;
        }
        i++;
      }
    }

    // one new particle (initParticle) from the emitter as it is now (st: where it is in the level and on
    // the screen, the angle new particles head at, the scale sizes, spreads and speeds take, and with use
    // object colour, the object's colour and opacity)
    spawn(st) {
      const p = this.p, r = () => this.rnd() * 2 - 1, k = st.k;
      const life = Math.max(0.0001, (p.Life || 0) + (p.LifeVar || 0) * r());
      const q = { ttl: life, inv: 1 / life, age: 0, x: (p.PosVarX || 0) * k * r(), y: (p.PosVarY || 0) * k * r(), dir: 0 };
      // colours: each channel with its own spread, or with RGB sync red's spread on all three
      const col = (pre, base, sync) => {
        const kr = r() * (p[pre + "VarR"] || 0);
        return [unit(base[0] + kr), unit(base[1] + (sync ? kr : r() * (p[pre + "VarG"] || 0))),
                unit(base[2] + (sync ? kr : r() * (p[pre + "VarB"] || 0))), unit(base[3] + r() * (p[pre + "VarA"] || 0))];
      };
      const sb = [p.StartColorR || 0, p.StartColorG || 0, p.StartColorB || 0, p.StartColorA || 0];
      const eb = [p.EndColorR || 0, p.EndColorG || 0, p.EndColorB || 0, p.EndColorA || 0];
      if (st.col) {   // use object colour: the object's colour now at both ends, its opacity at the start
        for (let c = 0; c < 3; c++) sb[c] = eb[c] = st.col[c];
        sb[3] = st.op;
      }
      const s = col("StartColor", sb, p.startRGBVarSync), e = col("EndColor", eb, p.endRGBVarSync);
      q.col = s; q.dcol = [(e[0] - s[0]) / life, (e[1] - s[1]) / life, (e[2] - s[2]) / life, (e[3] - s[3]) / life];
      q.fadeIn = Math.max(0, Math.min(life, (p.FadeInTime || 0) + (p.FadeInTimeVar || 0) * r()));
      q.fadeOut = Math.max(0, Math.min(life - q.fadeIn, (p.FadeOutTime || 0) + (p.FadeOutTimeVar || 0) * r()));
      q.fp = (p.frictionPos || 0) + (p.frictionPosVar || 0) * r();
      q.fs = (p.frictionSize || 0) + (p.frictionSizeVar || 0) * r();
      q.fr = (p.frictionRot || 0) + (p.frictionRotVar || 0) * r();
      q.fric = !!(q.fp || q.fs || q.fr);
      // size ("start = end" makes the end value a change; GD doesn't scale the end's spread)
      q.size = Math.max(0, ((p.StartSize || 0) + (p.StartSizeVar || 0) * r()) * k);
      let ds = (p.EndSize || 0) * k + (p.EndSizeVar || 0) * r();
      if (!p.startSizeEqualToEndSize) ds = Math.max(0, ds) - q.size;
      else if (ds + q.size < 0) ds = -q.size;
      q.dsize = ds / life;
      // spin, in whole degrees (likewise "start = end"); with dynamic rotation it turns to face its way instead
      const s0 = Math.trunc((p.StartSpin || 0) + (p.StartSpinVar || 0) * r());
      q.rot = s0 < -360 || s0 > 360 ? s0 % 360 : s0;
      if (q.rot < 0) q.rot += 360;
      if (!p.dynamicRotationIsDir) {
        let e1 = Math.trunc((p.EndSpin || 0) + (p.EndSpinVar || 0) * r());
        if (!p.startSpinEqualToEndSpin) e1 -= s0;
        q.drot = e1 / life;
      } else { q.drot = 0; q.dir = q.rot <= 270 ? q.rot + 90 : q.rot - 270; }
      // where it left from: on the screen (free) or in the level (relative)
      const type = p.PositionType | 0;
      if (type === 0) { q.ox = st.wx; q.oy = st.wy; } else if (type === 1) { q.ox = st.ex; q.oy = st.ey; }
      const a = Math.trunc(st.angle + (p.AngleVar || 0) * r());   // (whole degrees)
      if ((p.EmitterMode | 0) !== 1) {   // gravity mode
        const sp = ((p.Speed || 0) + (p.SpeedVar || 0) * r()) * k;
        q.dx = Math.cos(a * DEG) * sp; q.dy = Math.sin(a * DEG) * sp;
        q.radial = (p.RadialAccel || 0) + (p.RadialAccelVar || 0) * r();
        q.tangential = (p.TangentialAccel || 0) + (p.TangentialAccelVar || 0) * r();
        if (p.rotationIsDir || p.dynamicRotationIsDir) q.rot += 90 - Math.atan2(q.dy, q.dx) / DEG;
      } else {   // radius mode: circles out from the centre
        q.radius = (p.StartRadius || 0) + (p.StartRadiusVar || 0) * r();
        let er = (p.EndRadius || 0) + (p.EndRadiusVar || 0) * r();
        if (!p.startRadiusEqualToEndRadius) er -= q.radius;
        q.dradius = er / life;
        q.angle = a * DEG; q.ca = Math.cos(q.angle); q.sa = Math.sin(q.angle);
        q.dps = ((p.RotatePerSecond || 0) + (p.RotatePerSecondVar || 0) * r()) * DEG;
        if (p.rotationIsDir || p.dynamicRotationIsDir) {
          q.rot += 90 - Math.atan2(q.sa, q.ca) / DEG;
          if (p.dynamicRotationIsDir && !q.dps) q.dir = 0;
        }
        q.dx = q.dy = 0;
      }
      this.parts.push(q);
    }
  }

  // ------------------------------------------------------------------ WebGL renderer
  const VS = `#version 300 es
    in vec2 corner;                 // -0.5..0.5 quad corner
    in vec4 posRot;                 // world x, y, rotation (rad, clockwise), solid (1: firm edges)
    in vec4 size;                   // half-extents w, h (world units, signed for flips), sprite offset x, y
    in vec4 uv;                     // u0, v0, u1, v1
    in vec4 color;                  // rgba (premultiplied in the fragment shader)
    in vec2 rotated;                // x: the frame is stored rotated 90 degrees in its sheet; y: skew (rad),
                                    // how much further its x axis turns than its y axis (GD 2.2's X/Y rotation)
    in vec4 affine;                 // with posRot.w = 2: the quad's corners are posRot.xy + mat2(affine) * corner
    uniform vec4 cam;               // centre x, y, half view width, half view height
    out vec2 vUV; out vec4 vColor; out float vSolid;
    void main() {
      vec2 local = corner * 2.0 * size.xy + size.zw;
      // cocos2d's node matrix: the x axis turns by rotationY (posRot.z + skew), the y axis by rotationX
      float c = cos(posRot.z), s = sin(posRot.z), cy = cos(posRot.z + rotated.y), sy = sin(posRot.z + rotated.y);
      if (posRot.w > 1.5) local = mat2(affine.xy, affine.zw) * corner;   // a free shape (its turn comes on top)
      vec2 world = posRot.xy + vec2(local.x * cy + local.y * s, -local.x * sy + local.y * c);
      gl_Position = vec4((world - cam.xy) / cam.zw, 0.0, 1.0);
      vec2 t = corner + 0.5;          // 0..1 across the sprite, y up
      vec2 st = rotated.x > 0.5 ? t.yx : vec2(t.x, 1.0 - t.y);   // cocos2d: a rotated frame's bottom-left is its sheet rect's top-left
      vUV = mix(uv.xy, uv.zw, st);
      vColor = color;
      vSolid = posRot.w;
    }`;
  const FS = `#version 300 es
    precision mediump float;
    in vec2 vUV; in vec4 vColor; in float vSolid;
    uniform sampler2D tex;
    uniform float add;              // 1 while drawing additive (blending) sprites
    out vec4 frag;
    void main() {
      vec4 t = texture(tex, vUV);
      if (vSolid > 0.5) {   // flat shapes that tile against each other: firm up the soft edge so seams don't let light through
        float a = smoothstep(0.08, 0.55, t.a);
        frag = vec4(vColor.rgb * a, a) * vColor.a;
      } else {
        frag = vec4(t.rgb * vColor.rgb, t.a) * vColor.a;   // premultiplied
      }
      // GD adds light with (SRC_ALPHA, ONE) on sheets that are already premultiplied, so a
      // soft glow's colour is scaled by its alpha twice: blended (ONE, ONE), do the same here
      if (add > 0.5) frag.rgb *= frag.a;
    }`;
  // GD's shader layer, run over the finished picture while any of its effects is on, in GD's
  // order: radial blur (trigger 2914: each pixel averages ten samples stepped toward the centre,
  // the nearer ones weighted more as fade grows; GD feeds value = size * 0.2 / 9 and
  // fade = min(fade * 0.2, 0.2)), then grayscale (2919), sepia (2920), invert (2921: per channel,
  // amount * rgb) and edit colour (2923: rgb * c + b). Formulas and scalings read from the game
  const BLUR_VS = `#version 300 es
    out vec2 vUV;
    void main() {
      vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1);   // a strip over the screen
      vUV = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  // GD's screen-space layers (the background picture, the ground and ceiling): a textured
  // rectangle given in clip space, tinted by a colour (premultiplied), adding light if asked
  const FLAT_VS = `#version 300 es
    uniform vec4 rect, uvRect;      // x0, y0, x1, y1 in clip space; u0, v0, u1, v1
    out vec2 vUV;
    void main() {
      vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1);
      vUV = mix(uvRect.xy, uvRect.zw, p);
      gl_Position = vec4(mix(rect.xy, rect.zw, p), 0.0, 1.0);
    }`;
  const FLAT_FS = `#version 300 es
    precision mediump float;
    in vec2 vUV;
    uniform sampler2D tex;
    uniform vec4 color;
    uniform float add;
    out vec4 frag;
    void main() {
      frag = texture(tex, vUV) * color;
      if (add > 0.5) frag.rgb *= frag.a;
    }`;
  // GD 2.2's gradients: a four-cornered shape with a colour at each corner (non-premultiplied, as GD's)
  const GRAD_VS = `#version 300 es
    in vec2 pos; in vec4 color;
    uniform vec4 cam;
    out vec4 vColor;
    void main() { gl_Position = vec4((pos - cam.xy) / cam.zw, 0.0, 1.0); vColor = color; }`;
  const GRAD_FS = `#version 300 es
    precision mediump float;
    in vec4 vColor;
    uniform float premul;           // 1: alpha and additive blending (drawn premultiplied); 0: GD's other blend modes
    out vec4 frag;
    void main() { frag = premul > 0.5 ? vec4(vColor.rgb * vColor.a, vColor.a) : vColor; }`;
  const BLUR_FS = `#version 300 es
    precision highp float;
    in vec2 vUV;
    uniform sampler2D scene;
    uniform vec2 center;
    uniform float value, fade, gray, sepia;
    uniform bool grayLum;
    uniform vec3 grayTint, ccC, ccB;
    uniform vec4 inv;               // invert amount per channel, amount
    uniform vec2 hue;               // hue shift: cos, sin of its angle (GD skips it when cos is 0)
    uniform vec4 glitch;            // slice bottom, top, its x shift, which channel to offset (0..1); top 0 = off
    uniform vec2 glitchCol;         // that channel's offset
    uniform vec4 cg;                // chromatic glitch: rgb offset (0 = off), strength, height, y offset
    uniform vec3 cgLine;            // and its lines' threshold (0 = none), strength; its clock
    uniform vec4 sw;                // shockwave: phase (0 = off), strength, waves, inverted
    uniform vec4 swT;               // its ring's edges (GD's time1..4)
    uniform vec4 swC;               // its centre; min and max size (inverted rings)
    uniform vec2 swMisc;            // 1 / its reach (0 = everywhere); the screen's aspect
    uniform float aspect;           // GD's _screenAspect: height / width
    uniform vec4 bulge;             // GD's _bulgeValue, _bulgeValue2, _bulgeRadius (0 = off); unused
    uniform vec2 bulgeC;            // its origin (uv)
    uniform vec4 pinch;             // GD's _pinchValue (x, y), _pinchRadius (0 = off); unused
    uniform vec4 pinchC;            // its centre (uv), _pinchCalc1
    uniform vec2 chrom;             // chromatic aberration: red's offset (uv; blue's is the opposite)
    uniform vec4 px;                // pixelate: block size in pixels x, y (0 = off), the grid's origin in pixels
    uniform float pxHard;           // hard edges (GD's nearest filtering) or soft (its linear filtering)
    uniform vec4 mb;                // motion blur: GD's _motionBlurValue (0 = off), _blurFade, _motionBlurMult
    uniform float mbDual;           // both directions
    out vec4 frag;
    // the scene as GD's shader sees it: drawn into a texture scaled down by the pixelate size, then
    // read back with nearest or linear filtering (here: the full picture read at the blocks' centres)
    vec4 samp(vec2 uv) {
      if (px.x <= 0.0) return texture(scene, uv);
      vec2 size = vec2(textureSize(scene, 0)), b = (uv * size - px.zw) / px.xy;
      if (pxHard > 0.5) return texture(scene, ((floor(b) + 0.5) * px.xy + px.zw) / size);
      vec2 bf = b - 0.5, i = floor(bf), f = bf - i, c = ((i + 0.5) * px.xy + px.zw) / size, d = px.xy / size;
      return mix(mix(texture(scene, c), texture(scene, c + vec2(d.x, 0.0)), f.x),
                 mix(texture(scene, c + vec2(0.0, d.y)), texture(scene, c + d), f.x), f.y);
    }
    // GD's own noise for the chromatic glitch (smoothed value noise; its rand's multiplier is 437.5854)
    float rnd(vec2 n) { return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 437.5854); }
    float noise(vec2 n) {
      const vec2 d = vec2(0.0, 1.0);
      vec2 b = floor(n), f = smoothstep(vec2(0.0), vec2(1.0), fract(n));
      return mix(mix(rnd(b), rnd(b + d.yx), f.x), mix(rnd(b + d.xy), rnd(b + d.yy), f.x), f.y);
    }
    void main() {
      vec2 at = vUV;
      if (sw.x > 0.0) {   // GD's shockwave: a ring of ripples pushing the picture out from its centre
        vec2 p = (at - swC.xy) * vec2(1.0, swMisc.y);
        float dis = max(length(p), 0.0001);
        float k = swMisc.x != 0.0 ? clamp(1.0 - dis * swMisc.x, 0.0, 1.0) : 1.0;
        if (sw.w > 0.5) dis = swC.w - max(dis, swC.z);
        k *= clamp(smoothstep(swT.x, swT.y, dis) - smoothstep(swT.z, swT.w, dis), 0.0, 1.0);
        at += k * ((p / dis) * sin(dis * sw.z - sw.x) * sw.y) * vec2(1.0, 1.0 / swMisc.y);
      }
      if (bulge.z > 0.0) {   // GD's bulge: tan-shaped swell about its origin, faded out by (distance / radius)^3
        vec2 d = (at - bulgeC) * vec2(1.0, aspect);
        float di = length(d);
        if (di < bulge.z && di > 0.0) {
          float f = pow(di / bulge.z, 3.0);
          at = at * f + (bulgeC * vec2(1.0, aspect) + d / di * tan(di * bulge.x) * bulge.y) * vec2(1.0, 1.0 / aspect) * (1.0 - f);
        }
      }
      if (pinch.z > 0.0) {   // GD's pinch: atan-shaped pull to its centre per axis, faded out by (distance / radius)^2
        vec2 d = (at - pinchC.xy) * vec2(1.0, aspect);
        float di = length(d);
        if (di < pinch.z && di > 0.0) {
          float f = pow(di / pinch.z, 2.0);
          at = at * f + (pinchC.xy * vec2(1.0, aspect) + d / di * atan(di * -pinch.xy * 20.0) * pinchC.zw) * vec2(1.0, 1.0 / aspect) * (1.0 - f);
        }
      }
      if (glitch.y > 0.0) at.x += glitch.z * (step(glitch.x, at.y) - step(glitch.y, at.y));   // the slice slides
      vec4 c = samp(at);
      if (cg.x != 0.0) {   // rows slide sideways by noise, and red and blue come from either side
        float row = (vUV.y + cg.w) * 50.0 * cg.z;
        at.x += (noise(vec2(cgLine.z, row)) - noise(vec2(0.0, row))) * cg.y;
        vec4 r = samp(vec2(at.x - cg.x, at.y)), g = samp(at), b = samp(vec2(at.x + cg.x, at.y));
        c = vec4(r.r, g.g, b.b, (r.a + g.a + b.a) * 0.3333);
        if (cgLine.x > 0.0) c.rgb -= smoothstep(cgLine.x - 0.01, cgLine.x + 0.01, sin((vUV.y + cg.w) * 300.0 * cg.z)) * cgLine.y;
      }
      if (glitch.y > 0.0) {   // and one colour channel comes from a little way off
        vec4 o = samp(at + glitchCol);
        if (glitch.w < 0.33) c.r = o.r; else if (glitch.w < 0.66) c.g = o.g; else c.b = o.b;
        c.a = max(c.a, o.a);
      }
      if (chrom.x != 0.0 || chrom.y != 0.0) {   // GD's chromatic aberration: red from one side, blue from the other
        vec4 r = samp(at + chrom), b = samp(at - chrom);
        c = vec4(r.r, c.g, b.b, max(r.a, max(c.a, b.a)));
      }
      if (value != 0.0) {
        vec2 uv = at, stepTo = (center - at) * value;
        float w = 1.0 + 4.5 * fade;
        c *= w;
        for (int i = 1; i < 10; i++) { w -= fade; uv += stepTo; c += samp(uv) * w; }
        c *= 0.1;
      } else if (mb.x != 0.0 || mb.y != 0.0) {   // GD's motion blur: 8 samples along its value (4 each way, dual)
        if (mbDual > 0.5) for (float i = 1.0; i < 5.0; i++) {
          vec2 o = mb.xy * (i / 9.0);
          c += (samp(at + o) + samp(at - o)) * (1.0 - i * mb.z);
        } else for (float i = 1.0; i < 9.0; i++) c += samp(at + mb.xy * (i / 9.0)) * (1.0 - i * mb.z);
        c *= mb.w;
      }
      if (gray > 0.0) {
        float g = grayLum ? dot(c.rgb, vec3(0.299, 0.587, 0.114)) : (c.r + c.g + c.b) * 0.333;
        c.rgb = c.rgb * (1.0 - gray) + vec3(g) * gray * grayTint;
      }
      if (sepia > 0.0) {
        vec3 s = vec3(dot(c.rgb, vec3(0.393, 0.769, 0.189)), dot(c.rgb, vec3(0.349, 0.686, 0.168)), dot(c.rgb, vec3(0.272, 0.534, 0.131)));
        c.rgb = c.rgb * (1.0 - sepia) + s * sepia;
      }
      if (inv.a > 0.0) c.rgb = c.rgb * (1.0 - inv.rgb) + (1.0 - c.rgb) * inv.rgb;
      if (hue.x != 0.0) {   // GD's hue shift: a turn about the grey axis
        const vec3 k = vec3(0.57735, 0.57735, 0.57735);
        c.rgb = c.rgb * hue.x + cross(k, c.rgb) * hue.y + k * dot(k, c.rgb) * (1.0 - hue.x);
      }
      if (ccC.r > 0.0) c.rgb = c.rgb * ccC + ccB;
      frag = c;
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // textures GD draws in code: "gd:radial" = a radial gradient, opaque centre to clear edge;
  // "gd:white" plain white (the wave's trail)
  // (made the size of its frame, which spans the whole texture)
  function makeTexture(name, size = 256) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    if (name === "gd:white") { const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, size, size); return c; }
    const h = size / 2, g = c.getContext("2d"), grad = g.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
    return c;
  }

  function loadImage(src) {   // onload rather than decode(): decode() can stall in a throttled page
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("couldn't load " + src));
      img.src = src;
    });
  }

  // ------------------------------------------------------------------ the scene
  class GDScene {
    static async create(canvas, opts = {}) {
      const base = opts.base || "";
      const data = opts.data || await (await fetch(base + "level.json", { cache: "no-store" })).json();
      const frameSize = n => { const f = Object.values(data.frames).find(f => data.sheets[f[0]] === n); return f ? f[3] : 256; };
      const sheets = await Promise.all(data.sheets.map(n => n.startsWith("gd:") ? makeTexture(n, frameSize(n))
        : loadImage(opts.sheetUrl ? opts.sheetUrl(n) : base + "sheets/" + n + ".png")));
      const scene = new GDScene(canvas, data, sheets);
      // the camera path recorded from the game (tools/gd_camera.py): [levelTime, zoom, camX, camY]
      scene.track = opts.track || await fetch(base + "camera.json", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);
      return scene;
    }

    constructor(canvas, data, sheets) {
      this.canvas = canvas;
      this.data = data;
      this.view = null;   // {x, y, zoom}: a fixed camera; null follows the level's camera
      const gl = this.gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false, alpha: false });
      if (!gl) throw new Error("WebGL2 not available");
      const prog = this.prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      const repeat = new Set([data.background, data.ground && data.ground.tile]);   // pictures that tile
      // one texture per sheet
      this.textures = sheets.map((img, k) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);   // the shader blends premultiplied; see-through texels carry colour
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const wrap = repeat.has(data.sheets[k]) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return { t, w: img.width, h: img.height };
      });
      this.prepareObjects();
      this.preparePlayer();
      this.prepareGL();
      this.reset();
    }

    // static per-object data, packed for the GPU
    prepareObjects() {
      const { objects, frames } = this.data;
      const n = this.n = objects.length;
      const upp = this.data.unitsPerPx || 0.5;
      this.baseX = new Float32Array(n); this.baseY = new Float32Array(n); this.baseRot = new Float32Array(n);
      this.sheet = new Uint8Array(n); this.channel = new Int32Array(n); this.blend = new Uint8Array(n);
      this.objHSV = new Array(n); this.objGroups = new Array(n); this.objAlpha = new Float32Array(n);
      this.hsvId = new Int32Array(n); const hsvIds = new Map();   // (one number per different HSV adjustment)
      this.staticSize = new Float32Array(n * 4); this.staticUV = new Float32Array(n * 4); this.staticRot = new Float32Array(n);
      this.staticSolid = new Float32Array(n);   // 1 for flat shapes that tile (the frame's 9th entry), 2 for free shapes
      this.staticAffine = new Float32Array(n * 4);
      this.groupObjects = new Map();
      this.anims = new Map();   // object index -> its animation frames (GD's animated objects: fire, drops, smoke...)
      this.emitters = new Map();   // object index -> particle settings, for custom particle objects
      this.highDetail = new Uint8Array(n);   // objects marked high detail (left out when lowDetail is set)
      this.addAlways = new Uint8Array(n);   // sprites that always add light (GD's glow), whatever their channel
      this.zLayer = new Uint8Array(n);   // GD's z layer: 0..8 = B5..B1, T1..T4 (objects come sorted by it)
      // a sprite that is one piece of a bigger object: its offset from the object's centre, and
      // how fast the object spins by itself (GD's rotating objects, degrees per second, clockwise)
      this.partX = new Float32Array(n); this.partY = new Float32Array(n); this.spin = new Float32Array(n);
      this.audio = new Map();   // object index -> [min, max]: GD's music-pulsing objects (data.pulse drives them)
      this.link = new Int32Array(n);   // link group (key 108), 0 for none
      this.skew = new Float32Array(n);   // GD 2.2's skew: rotation Y minus rotation X (rad)
      this.detail = new Uint8Array(n);   // 1: the sprite is its object's detail part (group pulses: Main / Detail Only)
      // GD's Hide box: these stay in their groups (a hidden object is often the centre a move or
      // rotate aims at) but are never drawn, nor their pieces
      this.hidden = new Uint8Array(n);
      for (const i of this.data.highDetail || []) this.highDetail[i] = 1;
      for (const i of this.data.hidden || []) this.hidden[i] = 1;
      if (!this.data.rolled) {   // pictures GD picks at random each time a level loads (its shares): once per load
        this.data.rolled = true;
        const rnd = this.lookSeed !== undefined ? makeRandom(this.lookSeed) : Math.random;
        for (const o of objects) {
          if (!o[19]) continue;
          let r = rnd() * o[19].reduce((a, lk) => a + lk[1], 0);
          o[0] = (o[19].find(lk => (r -= lk[1]) < 0) || o[19][0])[0];
        }
      }
      for (let i = 0; i < n; i++) {
        if (objects[i][12]) this.emitters.set(i, objects[i][12]);
        const [frame, x, y, rot, sx, sy, , , ch, hsv, groups, op] = objects[i];
        const f = frames[frame];
        const [sh, fx, fy, fw, fh, rotated, ox, oy] = f;
        const tex = this.textures[sh];
        this.baseX[i] = x; this.baseY[i] = y; this.baseRot[i] = rot * Math.PI / 180;
        this.sheet[i] = sh; this.channel[i] = ch; this.objHSV[i] = parseHSV(hsv); this.objGroups[i] = groups;
        if (hsv) { let h = hsvIds.get(hsv); if (h === undefined) hsvIds.set(hsv, h = hsvIds.size + 1); this.hsvId[i] = h; } this.objAlpha[i] = op;
        const geom = (f, size, uv, at) => {   // a frame's size on screen and its place in the sheet
          const [, fx, fy, fw, fh, rotated, ox, oy] = f;
          const w = fw * upp, h = fh * upp;   // (a rotated frame is fh x fw in its sheet)
          size.set([w / 2 * sx, h / 2 * sy, ox * upp * sx, oy * upp * sy], at * 4);
          const tw = rotated ? fh : fw, th = rotated ? fw : fh;
          uv.set([fx / tex.w, fy / tex.h, (fx + tw) / tex.w, (fy + th) / tex.h], at * 4);
        };
        geom(f, this.staticSize, this.staticUV, i);
        this.staticRot[i] = rotated;
        const an = objects[i][16];
        if (an) {   // an animated object: its frames in turn, each shown for frameTime seconds
          const k = an.f.length, a = { n: k, t: an.t, p: an.p || 0, size: new Float32Array(k * 4), uv: new Float32Array(k * 4), rot: new Uint8Array(k) };
          an.f.forEach((name, j) => { geom(frames[name], a.size, a.uv, j); a.rot[j] = frames[name][5]; });
          this.anims.set(i, a);
        }
        this.staticSolid[i] = f[8] ? 1 : 0;
        if (objects[i][13]) { this.staticSolid[i] = 2; this.staticAffine.set(objects[i][13], i * 4); }   // a free-shaped backing
        if (objects[i][14]) this.addAlways[i] = 1;
        this.zLayer[i] = Math.floor((objects[i][6] || 0) / 100);
        if (objects[i][15]) [this.partX[i], this.partY[i], this.spin[i]] = objects[i][15];
        if (objects[i][17]) this.audio.set(i, objects[i][17]);   // [min, max] scale with the music
        if (objects[i][18]) this.link[i] = objects[i][18];   // its link group (GD's linked objects act as one)
        if (objects[i][20]) this.skew[i] = objects[i][20] * Math.PI / 180;
        if (objects[i][21]) this.detail[i] = 1;   // its object's detail part (second colour)
        for (const g of groups) {
          if (!this.groupObjects.has(g)) this.groupObjects.set(g, []);
          this.groupObjects.get(g).push(i);
        }
      }
      // triggers: x-activated ones sorted by x; spawn targets by group
      const trig = this.data.triggers.map((t, i) => Object.assign({ id: i }, t));
      // groups that a supported spawn trigger can call; triggers waiting on any other group are
      // only reachable through logic GD triggers this engine doesn't run (counters, collisions,
      // events), so they fire when the player passes them instead
      const passive = new Set(["colblock", "teleport", "persist", "touch", "ondeath", "event"]);   // never fired by passing
      // (a speed portal or touch trigger works as soon as the player's hitbox reaches it, short of its centre)
      for (const t of trig) t.at = t.x - (t.type === "speed" ? PORTAL_REACH : t.mode === "touch" ? TOUCH_REACH / 2 * (1 + (t.boxX || 1)) : 0);
      this.xTriggers = trig.filter(t => t.mode !== "spawn" && !passive.has(t.type)).sort((a, b) => a.at - b.at);
      this.colBlocks = trig.filter(t => t.type === "colblock");
      this.groupTriggers = new Map();
      for (const t of trig) for (const g of t.groups) {
        if (!this.groupTriggers.has(g)) this.groupTriggers.set(g, []);
        this.groupTriggers.get(g).push(t);
      }
      // GD moves, turns and scales objects a step at a time: each trigger's change goes to every object
      // that carries its group, in turn, so changes from several triggers on one group, or from several
      // groups on one object, add up in the order they happen (a move after a turn isn't turned). Objects
      // with the same groups always move as one: the engine keeps one running transform per set of
      // groups (a signature), and the places triggers aim at without a sprite get theirs too
      this.sigIndex = new Map(); this.sigGroups = [];
      this.objSig = new Int32Array(n);
      for (let i = 0; i < n; i++) this.objSig[i] = this.sigOf(this.objGroups[i]);
      for (const t of this.data.triggers)
        for (const ref of [t.centerRef, t.refPos, ...(t.corners || [])]) if (Array.isArray(ref) && Array.isArray(ref[2])) this.sigOf(ref[2]);
      this.groupSigs = new Map();   // group -> the signatures that carry it
      this.sigGroups.forEach((gs, k) => { for (const g of gs) (this.groupSigs.get(g) || this.groupSigs.set(g, []).get(g)).push(k); });
      for (const [g, list] of this.groupSigs) this.groupSigs.set(g, Int32Array.from(list));
      // the centre of each link group: what its objects turn about together
      const sums = new Map();
      for (let i = 0; i < n; i++) {
        if (!this.link[i]) continue;
        const s = sums.get(this.link[i]) || sums.set(this.link[i], [0, 0, 0]).get(this.link[i]);
        s[0] += this.baseX[i] - this.partX[i]; s[1] += this.baseY[i] - this.partY[i]; s[2]++;
      }
      this.linkX = new Float32Array(n); this.linkY = new Float32Array(n);   // each sprite's offset from its link's centre
      for (let i = 0; i < n; i++) {
        const s = this.link[i] && sums.get(this.link[i]);
        if (s) { this.linkX[i] = this.baseX[i] - s[0] / s[2]; this.linkY[i] = this.baseY[i] - s[1] / s[2]; }
      }
      // a coarse spatial index for culling: objects that never move (no group a move or rotate
      // trigger targets, no spin, no particles) sit in columns of CELL units by x. Moving ones sit in
      // tiles: a signature's objects within one TILE x TILE square, whose box (the objects' centres, and
      // how far their pieces reach) goes through the signature's transform each frame (nearby).
      // Particle emitters are checked every frame
      const movers = new Set(trig.filter(t => t.type === "move" || t.type === "rotate" || t.type === "scale" || t.type === "follow" ||
                                             t.type === "advfollow" || t.type === "keyframes" || t.type === "ui")
                                 .map(t => t.target));
      const cols = new Map(), tiles = new Map(), always = [];
      for (let i = 0; i < n; i++) {
        if (this.emitters.has(i)) { always.push(i); continue; }
        if (this.spin[i] || this.objGroups[i].some(g => movers.has(g))) {
          const x = this.baseX[i] - this.partX[i], y = this.baseY[i] - this.partY[i], k = this.objSig[i];
          const key = k + ":" + Math.floor(x / TILE) + ":" + Math.floor(y / TILE), q = this.audio.get(i);
          let t = tiles.get(key);
          if (!t) tiles.set(key, t = { k, x0: x, x1: x, y0: y, y1: y, reach: 0, list: [] });
          t.x0 = Math.min(t.x0, x); t.x1 = Math.max(t.x1, x); t.y0 = Math.min(t.y0, y); t.y1 = Math.max(t.y1, y);
          // (a piece's offset turns and grows with the object, and with the music for pulsing ones)
          t.reach = Math.max(t.reach, Math.hypot(this.partX[i], this.partY[i]) * (q ? Math.max(1, Math.abs(q[0]), Math.abs(q[1])) : 1));
          t.list.push(i);
          continue;
        }
        const c = Math.floor(this.baseX[i] / CELL);
        (cols.get(c) || cols.set(c, []).get(c)).push(i);
      }
      this.columns = new Map([...cols].map(([c, list]) => [c, Int32Array.from(list)]));
      this.tiles = [...tiles.values()].map(t => Object.assign(t, { list: Int32Array.from(t.list) }));
      this.always = Int32Array.from(always);
    }

    // the players (data.player, from export --player): GD's icon for each game mode in the player's
    // own colours, at the recorded path, turned as it turns, while the level shows it. Player 2 (dual
    // mode, data.player.p2: its own recorded path and states) wears the two colours the other way round
    preparePlayer() {
      const pd = this.data.player, upp = this.data.unitsPerPx || 0.5;
      this.player = null;
      if (!pd || !this.data.playerTrack) return;
      const geom = name => {
        const f = this.data.frames[name];
        if (!f) return null;
        const [sh, fx, fy, fw, fh, rotated, ox, oy] = f, tex = this.textures[sh];
        const tw = rotated ? fh : fw, th = rotated ? fw : fh;
        return { sheet: sh, rotated, w: fw * upp / 2, h: fh * upp / 2, ox: ox * upp, oy: oy * upp,
                 uv: [fx / tex.w, fy / tex.h, (fx + tw) / tex.w, (fy + th) / tex.h] };
      };
      const build = layers => layers.map(([name, role, dx, dy, sx, sy, turn]) =>
        ({ g: geom(name), role, dx, dy, sx, sy, turn: turn * Math.PI / 180 })).filter(l => l.g);
      const looks = {};
      for (const [mode, v] of Object.entries(pd.looks || {})) {   // robots and spiders: [frame time, poses]
        looks[mode] = typeof v[0] === "number" ? { dt: v[0], poses: v[1].map(build) } : { dt: 0, poses: [build(v)] };
      }
      const c = pd.colors || {}, c1 = c.c1 || [1, 1, 1], c2 = c.c2 || [1, 1, 1];
      const col = (a, b) => ({ c1: a, c2: b, d1: a.map(v => v * 0.6), d2: b.map(v => v * 0.6), g: c.g || b, w: [1, 1, 1] });
      const list = [{ one: true, states: pd.states || [], turn: pd.turn || [], track: this.data.playerTrack, col: col(c1, c2) }];
      if (pd.p2) list.push({ one: false, states: pd.p2.states || [], turn: pd.p2.turn || [], track: pd.p2.track || [], col: col(c2, c1) });
      this.player = { looks, white: geom("gd:white"), list };
    }

    // a player's state at level time t: [since, mode, size, upside down, shown]
    playerState(t, who = this.player.list[0]) {
      const st = who.states;
      let lo = 0, hi = st.length - 1;
      if (hi < 0) return null;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (st[mid][0] <= t) lo = mid; else hi = mid - 1; }
      return st[lo];
    }

    playerTurn(t, who = this.player.list[0]) {   // degrees, clockwise
      const tr = who.turn;
      if (!tr.length) return 0;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi];
      if (t <= a[0]) return a[1];
      if (t >= b[0]) return b[1];
      return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }

    // where player n (1 or 2) is now, and how far it has turned (degrees clockwise): the drawn players
    // (player 2 is dual mode's second icon, from its recording; without one, player 1)
    playerPos(n) {
      const who = n === 2 && this.player && this.player.list[1];
      return who ? this.playerAt(this.t, who) || [this.playerX, this.playerY] : [this.playerX, this.playerY];
    }

    playerRot(n) {
      if (!this.player) return 0;
      return this.playerTurn(this.t, (n === 2 && this.player.list[1]) || this.player.list[0]);
    }

    playerAt(t, who) {   // where a player is: player 1 is the scene's own; another, its recorded path
      if (who.one) return [this.playerX, this.playerY];
      const pt = who.track;
      if (!pt.length) return null;
      let lo = 0, hi = pt.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pt[mid][0] <= t) lo = mid; else hi = mid; }
      const a = pt[lo], b = pt[hi];
      if (t <= a[0] || this.trackJump(a, b)) return t < b[0] ? [a[1], a[2]] : [b[1], b[2]];
      if (t >= b[0]) return [b[1], b[2]];
      const u = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }

    // one instance of a player sprite (or a trail piece: the white frame, half sizes hw x hh)
    playerSprite(m, runs, g, x, y, rot, sx, sy, col, a = 1, hw = 0, hh = 0) {
      const last = runs[runs.length - 1];
      if (!last || last[2] !== g.sheet || last[3] !== 0) runs.push([m, 0, g.sheet, 0]);
      runs[runs.length - 1][1]++;
      this.fPos[m * 4] = x; this.fPos[m * 4 + 1] = y; this.fPos[m * 4 + 2] = rot; this.fPos[m * 4 + 3] = 0;
      if (hw) { this.fSize[m * 4] = hw; this.fSize[m * 4 + 1] = hh; this.fSize[m * 4 + 2] = 0; this.fSize[m * 4 + 3] = 0; }
      else {
        this.fSize[m * 4] = g.w * sx; this.fSize[m * 4 + 1] = g.h * sy;
        this.fSize[m * 4 + 2] = g.ox * sx; this.fSize[m * 4 + 3] = g.oy * sy;
      }
      this.fUV[m * 4] = g.uv[0]; this.fUV[m * 4 + 1] = g.uv[1]; this.fUV[m * 4 + 2] = g.uv[2]; this.fUV[m * 4 + 3] = g.uv[3];
      this.fColor[m * 4] = col[0]; this.fColor[m * 4 + 1] = col[1]; this.fColor[m * 4 + 2] = col[2]; this.fColor[m * 4 + 3] = a;
      this.fRotated[m * 2] = g.rotated; this.fRotated[m * 2 + 1] = 0;
      return m + 1;
    }

    // the players on GD's player layer (between B1 and T1): player 1, then player 2 on top (Deprivation
    // 91 s: where they meet GD shows player 2), each its wave's trail, then its icon
    drawPlayer(m, runs) {
      const P = this.player;
      if (!P) return m;
      for (const who of P.list) {
        if (who.one ? this.p1Hidden : this.p2Hidden) continue;
        const t = this.t, st = this.playerState(t, who);
        if (!st || st[4] === 0) continue;   // (shown: 0 while the recording has it switched off)
        const [, mode, size, flip] = st;
        const look = P.looks[mode], at = this.playerAt(t, who);
        if (!look || !look.poses.length || !at) continue;
        const [x, y] = at;
        if (mode === "wave" && P.white) m = this.drawWaveTrail(m, runs, t, size, who, x, y);
        const pose = look.dt ? look.poses[Math.floor(t / look.dt) % look.poses.length] : look.poses[0];
        const rot = this.playerTurn(t, who) * Math.PI / 180, c = Math.cos(rot), s = Math.sin(rot), fy = flip ? -1 : 1;
        for (const l of pose) {
          const dx = l.dx * size, dy = l.dy * size * fy;
          m = this.playerSprite(m, runs, l.g, x + dx * c + dy * s, y - dx * s + dy * c, rot + l.turn * fy,
                                l.sx * size, l.sy * size * fy, who.col[l.role] || who.col.w);
        }
      }
      return m;
    }

    // GD's wave trail: a band in the player's colour with a white core, along the path since the wave
    // began or last teleported (GD starts it over at a teleport), at most the last 3 seconds
    drawWaveTrail(m, runs, t, size, who, x, y) {
      const P = this.player, pt = who.track, st = who.states;
      let t0 = 0;
      for (let k = st.length - 1; k >= 0; k--) if (st[k][0] <= t && st[k][1] !== "wave") { t0 = st[k + 1] ? st[k + 1][0] : t; break; }
      // no trail for a wave that began hidden, or was hidden since (Deprivation 43-58 s: GD shows none
      // after the player was shown again)
      let seen = true;
      if (who.one) for (const [at, hid] of this.p1Seen) { if (at <= t0) seen = !hid; else if (hid && at <= t) seen = false; }
      if (!seen) return m;
      t0 = Math.max(t0, t - 3);
      let lo = 0, hi = pt.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pt[mid][0] < t0) lo = mid + 1; else hi = mid; }
      const pts = [];
      for (let k = lo; k < pt.length && pt[k][0] < t; k++) {
        if (pts.length && this.trackJump(pt[k - 1], pt[k])) pts.length = 0;   // a teleport: the trail starts over
        pts.push([pt[k][1], pt[k][2]]);
      }
      if (pts.length && Math.hypot(x - pts[pts.length - 1][0], y - pts[pts.length - 1][1]) > 60) pts.length = 0;
      pts.push([x, y]);
      const w = 5 * size;   // (half widths: a big wave's band is 10 points across, a mini one's 6)
      for (const [hwid, col] of [[w, who.col.c1], [w * 0.35, who.col.w]]) {
        for (let k = 1; k < pts.length; k++) {
          const [ax, ay] = pts[k - 1], [bx, by] = pts[k], len = Math.hypot(bx - ax, by - ay);
          if (len < 1e-3) continue;
          m = this.playerSprite(m, runs, P.white, (ax + bx) / 2, (ay + by) / 2, -Math.atan2(by - ay, bx - ax), 1, 1, col, 1,
                                len / 2 + hwid * 0.5, hwid);
        }
      }
      return m;
    }

    // a set of groups' signature (made while preparing; -1 for one never seen)
    sigOf(groups) {
      const key = groups.length ? Array.from(groups).sort((a, b) => a - b).join(".") : "";
      let k = this.sigIndex.get(key);
      if (k === undefined) {
        if (this.sa) return -1;
        k = this.sigGroups.length; this.sigIndex.set(key, k); this.sigGroups.push(groups.slice());
      }
      return k;
    }

    // the running transforms, from the level's places: x = a x0 + c y0 + tx, y = b x0 + d y0 + ty; how far
    // their objects have turned (degrees clockwise, rotate triggers that don't lock the turn) and grown
    resetTransforms() {
      const m = this.sigGroups.length, f = () => new Float64Array(m);
      this.sa = f(); this.sb = f(); this.sc = f(); this.sd = f(); this.stx = f(); this.sty = f();
      this.srot = f(); this.skx = f(); this.sky = f();
      this.sa.fill(1); this.sd.fill(1); this.skx.fill(1); this.sky.fill(1);
      // what else moves a signature's objects: 1 area triggers, 2 UI layout, 4 scale spreads (set as
      // groups join those, which they never leave until the next reset)
      this.sigFx = new Uint8Array(m);
    }

    markSigs(g, bit) {
      const ks = this.groupSigs.get(g);
      if (ks) for (const k of ks) this.sigFx[k] |= bit;
    }

    // a move: every object of the group by (dx, dy)
    moveGroup(g, dx, dy) {
      if (!dx && !dy) return;
      this.groupDX.set(g, (this.groupDX.get(g) || 0) + dx); this.groupDY.set(g, (this.groupDY.get(g) || 0) + dy);   // (places without a signature)
      const list = this.groupSigs.get(g);
      if (list) for (const k of list) { this.stx[k] += dx; this.sty[k] += dy; }
    }

    // a turn by deg (clockwise) about the point at, or each object about itself (at null); a locked turn
    // moves the objects round the point but leaves them facing the same way
    turnGroup(g, deg, at, lock) {
      const list = this.groupSigs.get(g);
      if (!list || !deg) return;
      if (at) {
        const r = deg * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r), [cx, cy] = at;
        for (const k of list) {
          const a = this.sa[k], b = this.sb[k], cc = this.sc[k], d = this.sd[k], tx = this.stx[k] - cx, ty = this.sty[k] - cy;
          this.sa[k] = a * c + b * sn; this.sb[k] = -a * sn + b * c;
          this.sc[k] = cc * c + d * sn; this.sd[k] = -cc * sn + d * c;
          this.stx[k] = cx + tx * c + ty * sn; this.sty[k] = cy - tx * sn + ty * c;
        }
      }
      if (!lock || !at) for (const k of list) this.srot[k] += deg;
    }

    // a scale step: each object's sprite by (rx, ry); with a centre point, their places spread from it too
    // a scale step: each object's sprite by (rx, ry); with a centre group, the places spread from the
    // centre too. An even scale spreads them a step at a time about the centre's point now, like a turn
    // (Deprivation's balls shrinking onto a group they follow and turn about); a stretch doesn't pile up
    // that way in GD (its tunnel rings, stretched 5x across and back while they spin, come back round),
    // so per group and centre the engine keeps a stretch's whole factor so far and applies it about the
    // centre's point now (spread)
    scaleGroupBy(g, rx, ry, cg, even) {
      const list = this.groupSigs.get(g);
      if (!list) return;
      for (const k of list) { this.skx[k] *= rx; this.sky[k] *= ry; }
      if (!cg) return;
      if (even) {
        const [cx, cy] = this.pivot(cg);
        for (const k of list) {
          this.sa[k] *= rx; this.sc[k] *= rx; this.stx[k] = cx + (this.stx[k] - cx) * rx;
          this.sb[k] *= ry; this.sd[k] *= ry; this.sty[k] = cy + (this.sty[k] - cy) * ry;
        }
        return;
      }
      let sps = this.groupSpread.get(g);
      if (!sps) { this.groupSpread.set(g, sps = []); this.markSigs(g, 4); }
      let sp = sps.find(q => q.cg === cg);
      if (!sp) sps.push(sp = { cg, px: 1, py: 1 });
      sp.px *= rx; sp.py *= ry;
    }

    // a point carried by these groups through their spreads (each about its centre's point now)
    spread(x, y, groups, depth = 0) {
      for (let g = 0; g < groups.length; g++) {
        const sps = this.groupSpread.get(groups[g]);
        if (!sps) continue;
        for (const sp of sps) {
          if (sp.px === 1 && sp.py === 1) continue;
          const [cx, cy] = this.scaleCentre(sp.cg, depth + 1);
          x = cx + (x - cx) * sp.px; y = cy + (y - cy) * sp.py;
        }
      }
      return [x, y];
    }

    // where sprite i is through its groups' moves, turns and spreads (no turn about itself, area or UI effects)
    sigPos(i, depth = 0) {
      const k = this.objSig[i], x = this.baseX[i], y = this.baseY[i];
      const p = [this.sa[k] * x + this.sc[k] * y + this.stx[k], this.sb[k] * x + this.sd[k] * y + this.sty[k]];
      return (this.sigFx[k] & 4) && depth < 3 ? this.spread(p[0], p[1], this.objGroups[i], depth) : p;
    }

    // the objects worth checking for a view from (x0, y0) to (x1, y1), in draw order
    nearby(x0, x1, y0, y1) {
      // (signatures that also move by more than their transform, sigFx: all their tiles)
      const parts = [this.always], fx = this.sigFx;
      let total = this.always.length;
      for (const t of this.tiles) {
        const k = t.k;
        if (!fx[k]) {
          const a = this.sa[k], b = this.sb[k], c = this.sc[k], d = this.sd[k];
          const mx = (t.x0 + t.x1) / 2, my = (t.y0 + t.y1) / 2, hx = (t.x1 - t.x0) / 2, hy = (t.y1 - t.y0) / 2;
          const X = a * mx + c * my + this.stx[k], Y = b * mx + d * my + this.sty[k];
          const r = t.reach * Math.max(Math.abs(this.skx[k]), Math.abs(this.sky[k]));
          const ex = Math.abs(a) * hx + Math.abs(c) * hy + r, ey = Math.abs(b) * hx + Math.abs(d) * hy + r;
          if (X + ex < x0 || X - ex > x1 || Y + ey < y0 || Y - ey > y1) continue;
        }
        parts.push(t.list); total += t.list.length;
      }
      for (let c = Math.floor(x0 / CELL); c <= Math.floor(x1 / CELL); c++) {
        const list = this.columns.get(c);
        if (list) { parts.push(list); total += list.length; }
      }
      const out = new Int32Array(total);
      let k = 0;
      for (const p of parts) { out.set(p, k); k += p.length; }
      return out.sort();
    }

    prepareGL() {
      const gl = this.gl, n = this.n, prog = this.prog;
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
      const loc = name => gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc("corner"));
      gl.vertexAttribPointer(loc("corner"), 2, gl.FLOAT, false, 0, 0);
      const inst = (name, size) => {
        const buf = gl.createBuffer(), l = loc(name);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(l, 1);
        return { buf, l, size };
      };
      this.aPos = inst("posRot", 4); this.aSize = inst("size", 4); this.aUV = inst("uv", 4);
      this.aColor = inst("color", 4); this.aRotated = inst("rotated", 2); this.aAffine = inst("affine", 4);
      // per-frame arrays, filled with the visible objects in draw order
      let cap = n + (this.player ? 1024 : 0);   // objects plus every emitter's particles (and the player, its trail)
      for (const p of this.emitters.values()) cap += p.TotalParticles | 0;
      this.fPos = new Float32Array(cap * 4); this.fSize = new Float32Array(cap * 4); this.fUV = new Float32Array(cap * 4);
      this.fColor = new Float32Array(cap * 4); this.fRotated = new Float32Array(cap * 2); this.fAffine = new Float32Array(cap * 4);
      this.uCam = gl.getUniformLocation(prog, "cam");
      this.uTex = gl.getUniformLocation(prog, "tex");
      this.uAdd = gl.getUniformLocation(prog, "add");
      // the radial blur pass: the scene goes to a texture first while a blur runs
      const bp = this.blurProg = gl.createProgram();
      gl.attachShader(bp, compile(gl, gl.VERTEX_SHADER, BLUR_VS));
      gl.attachShader(bp, compile(gl, gl.FRAGMENT_SHADER, BLUR_FS));
      gl.linkProgram(bp);
      if (!gl.getProgramParameter(bp, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(bp));
      this.blurVao = gl.createVertexArray();
      this.uBlur = ["scene", "center", "value", "fade", "gray", "grayLum", "grayTint", "sepia", "inv", "ccC", "ccB", "glitch", "glitchCol", "cg", "cgLine", "sw", "swT", "swC", "swMisc", "hue",
                     "aspect", "bulge", "bulgeC", "pinch", "pinchC", "chrom", "px", "pxHard", "mb", "mbDual"]
        .reduce((o, k) => (o[k] = gl.getUniformLocation(bp, k), o), {});
      this.target = null;   // {fb, tex, w, h}, made when first needed
      const fp = this.flatProg = gl.createProgram();
      gl.attachShader(fp, compile(gl, gl.VERTEX_SHADER, FLAT_VS));
      gl.attachShader(fp, compile(gl, gl.FRAGMENT_SHADER, FLAT_FS));
      gl.linkProgram(fp);
      if (!gl.getProgramParameter(fp, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(fp));
      this.uFlat = ["rect", "uvRect", "tex", "color", "add"].reduce((o, k) => (o[k] = gl.getUniformLocation(fp, k), o), {});
      const gp = this.gradProg = gl.createProgram();
      gl.attachShader(gp, compile(gl, gl.VERTEX_SHADER, GRAD_VS));
      gl.attachShader(gp, compile(gl, gl.FRAGMENT_SHADER, GRAD_FS));
      gl.linkProgram(gp);
      if (!gl.getProgramParameter(gp, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(gp));
      this.gradVao = gl.createVertexArray();
      gl.bindVertexArray(this.gradVao);
      this.gradBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gradBuf);
      const gPos = gl.getAttribLocation(gp, "pos"), gCol = gl.getAttribLocation(gp, "color");
      gl.enableVertexAttribArray(gPos); gl.vertexAttribPointer(gPos, 2, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(gCol); gl.vertexAttribPointer(gCol, 4, gl.FLOAT, false, 24, 8);
      gl.bindVertexArray(null);
      this.uGrad = ["cam", "premul"].reduce((o, k) => (o[k] = gl.getUniformLocation(gp, k), o), {});
    }

    // one screen-space rectangle in GD's screen points (320 high, winW wide, y up), sampling
    // texture `sheet` over uv, tinted by colour c (rgb 0..1, alpha)
    flatRect(sheet, x0, y0, x1, y1, uv, c, a = 1, additive = false) {
      const gl = this.gl, u = this.uFlat, W = this.winW;
      gl.uniform4f(u.rect, x0 / W * 2 - 1, y0 / 160 - 1, x1 / W * 2 - 1, y1 / 160 - 1);
      gl.uniform4f(u.uvRect, uv[0], uv[1], uv[2], uv[3]);
      gl.uniform4f(u.color, c[0] * a, c[1] * a, c[2] * a, a);
      gl.uniform1f(u.add, additive ? 1 : 0);
      gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[sheet].t);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    flatBegin() {
      const gl = this.gl;
      gl.useProgram(this.flatProg);
      gl.bindVertexArray(this.blurVao);
      gl.enable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.uFlat.tex, 0);
    }

    // GD's background picture behind everything: one tile (512 points * screen width / 512 * 16/15)
    // repeated across, a tenth of the camera's movement behind it (read from the game), tinted by
    // the background colour
    drawBackground(camX, camY, bg) {
      const k = this.data.sheets.indexOf(this.data.background);
      if (k < 0) return;
      const S = this.winW * 16 / 15, y0 = -(camY + 10) * 0.1;
      let x0 = -(((camX - 15) * 0.1) % S);
      if (x0 > 0) x0 -= S;
      this.flatBegin();
      for (let x = x0; x < this.winW; x += S) this.flatRect(k, x, y0, x + S, y0 + S, [0, 1, 1, 0], bg);
    }

    // the ground and ceiling as recorded from the game (data.ground.track: their heights in screen
    // points and whether they show), over the objects: 128-point tiles in the ground colour (1001)
    // sliding with the camera, and the floor line (1002) adding light along the edge
    drawGround(t, camX, chanNow) {
      const g = this.data.ground;
      if (!g) return;
      const tr = g.track;
      let lo = 0, hi = tr.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr[m][0] <= t) lo = m; else hi = m - 1; }
      const a = tr[lo], b = tr[Math.min(lo + 1, tr.length - 1)];
      const u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
      const floor = a[2] ? a[1] + (b[2] ? (b[1] - a[1]) * u : 0) : null;
      const ceil = a[4] ? a[3] + (b[4] ? (b[3] - a[3]) * u : 0) : null;
      if (floor === null && ceil === null) return;
      const tile = this.data.sheets.indexOf(g.tile), W = this.winW;
      const gc = chanNow.get(1001) || [0, 0, 0], lc = chanNow.get(1002) || [1, 1, 1];
      const u0 = (((camX - 15) % 128) + 128) % 128 / 128, u1 = u0 + W / 128;
      const lf = this.data.frames[g.line], lt = lf && this.textures[lf[0]];
      const luv = lf && [lf[1] / lt.w, lf[2] / lt.h, (lf[1] + lf[3]) / lt.w, (lf[2] + lf[4]) / lt.h];
      const lw = lf ? lf[3] * (this.data.unitsPerPx || 0.25) : 0, lh = lf ? lf[4] * (this.data.unitsPerPx || 0.25) : 0;
      this.flatBegin();
      if (floor !== null) {
        if (tile >= 0) this.flatRect(tile, 0, floor - 128, W, floor, [u0, 1, u1, 0], gc);
        if (lf) this.flatRect(lf[0], W / 2 - lw / 2, floor - lh, W / 2 + lw / 2, floor, [luv[0], luv[3], luv[2], luv[1]], lc, 1, true);
      }
      if (ceil !== null) {   // the same, mirrored
        if (tile >= 0) this.flatRect(tile, 0, ceil, W, ceil + 128, [u0, 0, u1, 1], gc);
        if (lf) this.flatRect(lf[0], W / 2 - lw / 2, ceil, W / 2 + lw / 2, ceil + lh, [luv[0], luv[1], luv[2], luv[3]], lc, 1, true);
      }
    }

    // the offscreen picture the blur reads, the canvas's size
    sceneTarget(W, H) {
      const gl = this.gl;
      if (this.target && this.target.w === W && this.target.h === H) return this.target;
      if (this.target) { gl.deleteFramebuffer(this.target.fb); gl.deleteTexture(this.target.tex); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return (this.target = { fb, tex, w: W, h: H });
    }

    // ---------------------------------------------------------------- simulation state
    reset() {
      const { colors } = this.data;
      this.t = 0;
      // GD's game clock: the level's clock slowed by time warps. Spawn delays run on it (GD counts a
      // pending delay down by the warped step, so a warp that starts or ends mid-delay bends it)
      this.gt = 0; this.stepT0 = 0; this.stepG0 = 0;
      this.playerX = this.startX || 0;   // where the player starts (GD's spawn point)
      this.speed = KA4_TO_SPEED[this.data.speed | 0] ?? 1;
      this.nextX = 0;   // index into xTriggers
      this.xFired = new Set();   // x triggers that went off (with a recorded player path: once each, unless multi)
      this.xStarted = false;
      this.playerY = 0;
      this.p1Hidden = this.p2Hidden = false;   // GD's hide player trigger and options (drawn with data.player)
      this.p1Seen = [];   // [time, hidden] each time player 1 was hidden or shown
      this.queue = [];   // [game-clock time, group] spawn activations waiting
      this.queued = new Set();
      this.actions = [];   // running moves/rotates/alpha/colour transitions/pulses
      this.groupDX = new Map(); this.groupDY = new Map(); this.groupAlpha = new Map();
      // toggled-off groups: an object is off while any of its groups is (checked on GD's paused
      // snapshots: one group switched back on doesn't bring back objects another group switched off)
      this.groupOff = new Set();
      this.resetTransforms();
      this.groupSpread = new Map();   // group -> [{cg, px, py}]: its places' spread about each centre group
      this.chan = new Map();   // channel -> [r, g, b, a] (0..1), blending flag
      this.copies = new Map();   // channel -> [source channel, HSV]: a live copy of another channel
      for (const [ch, c] of Object.entries(colors)) {
        this.chan.set(+ch, [c[0] / 255, c[1] / 255, c[2] / 255, c[3], c[4]]);
        if (c[5]) this.copies.set(+ch, [c[5], parseHSV(c[6])]);
      }
      if (!this.chan.has(1004)) this.chan.set(1004, [1, 1, 1, 1, 0]);
      this.chan.set(1010, [0, 0, 0, 1, 0]);   // GD's fixed channels: black
      this.chan.set(1011, [1, 1, 1, 1, 0]);   // and white
      this.pulses = [];
      this.cam = { x: 0, y: 105, zoom: 1, static: null, offX: 0, offY: 0 };
      this.shake = null;   // the running shake: see shakeOffset()
      this.gradients = new Map();   // GD 2.2's gradients showing, by their id
      this.warp = 1;   // GD's time warp: the game's speed against the level's clock
      // GD 2.2's area triggers (move, rotate, scale, fade), by target group: [{kind, t, at}] (at: the
      // centre: a group, "p1"/"p2", or a point on the screen -3 .. -11)
      this.areaFx = new Map();
      this.uiGroups = new Map();   // GD 2.2's UI groups: drawn on the screen, laid out against a camera guide
      this.shock = null;   // the shockwave: its trigger and when it started
      // GD's shader layer state (its GJShaderState): radial blur size and fade, grayscale, sepia,
      // invert (amount, per channel rgb, clamped), edit colour (rgb * c + b)
      this.shader = { size: 0, fade: 1, gray: 0, grayLum: 0, sepia: 0, inv: 0, invR: 1, invG: 1, invB: 1, invClamp: 0,
                      cR: 1, cG: 1, cB: 1, bR: 0, bG: 0, bB: 0, hue: 0,
                      top: 8,   // the highest z layer the effects cover (higher ones are drawn on top)
                      playerIn: true,   // whether they cover the player's layer (between B1 and T1)
                      glitch: 0, glitchSpeed: 1, glitchSlice: 1, glitchX: 1, glitchColX: 1, glitchColY: 1,
                      // chromatic glitch: on, its clock, and the settings its triggers ease (height as GD keeps it, 1 / height)
                      cg: 0, cgTime: 0, cgSpeed: 0, cgStrength: 0, cgLineStrength: 0, cgLineThick: 0, cgRgb: 0, cgHeight: 10, cgRel: 0,
                      // pixelate (block size in GD points per axis; 1 = off), chromatic aberration (points),
                      // pinch (strength per axis, its screen offset in half screens, radius, modifier per axis,
                      // centre), bulge (strength, offset, radius, centre); "Rel": they scale with the zoom
                      px: 1, py: 1, pxSnap: 0, pxHard: 0, pxRel: 0, chromX: 0, chromY: 0, chromRel: 0,
                      pinchX: 0, pinchY: 0, pinchOffX: 0, pinchOffY: 0, pinchR: 0, pinchModX: 1, pinchModY: 1, pinchAt: null, pinchRel: 0,
                      bulge: 0, bulgeOffX: 0, bulgeOffY: 0, bulgeR: 0, bulgeAt: null, bulgeRel: 0,
                      mbX: 0, mbY: 0, mbFade: 0, mbIntensity: 0, mbDual: 0, mbRel: 0 };
      this.shakeRnd = makeRandom(7);
      this.fired = new Set();
      this.items = new Map();   // item id -> value
      // a returning player: levels often play a first-attempt intro (Nullscapes does) that the
      // recordings, like any replay, skip
      this.attempts = this.startAttempts || 2;
      this.listeners = [];   // collision triggers waiting for their blocks to touch
      const rnd = makeRandom(1);
      this.systems = new Map();   // object index -> running Emitter
      for (const [i, p] of this.emitters) this.systems.set(i, new Emitter(p, rnd));
    }

    channelColor(ch, depth = 0) {
      const c = this.chan.get(ch) || (ch < 1000 ? null : this.chan.get(1004)) || [1, 1, 1, 1, 0];   // GD's unset channels are white
      const cp = depth < 4 && this.copies && this.copies.get(ch);
      if (!cp) return c;
      const src = applyHSV(this.channelColor(cp[0], depth + 1), cp[1]);
      return [src[0], src[1], src[2], c[3], c[4]];
    }

    groupCenter(g) {
      const objs = this.groupObjects.get(g);
      if (!objs || !objs.length) return null;
      let sx = 0, sy = 0;
      for (const i of objs) { const p = this.objPos(i); sx += p[0]; sy += p[1]; }
      return [sx / objs.length, sy / objs.length];
    }

    objPos(i) {
      const k = this.objSig[i], ox = this.partX[i], oy = this.partY[i];
      // the object's centre: its place in the level through everything its groups did so far
      const bx = this.baseX[i] - ox, by = this.baseY[i] - oy;
      let x = this.sa[k] * bx + this.sc[k] * by + this.stx[k], y = this.sb[k] * bx + this.sd[k] * by + this.sty[k];
      // how far the object has turned (rotate triggers that don't lock it, its own spin) and grown
      let turn = this.srot[k] + (this.spin[i] ? this.spin[i] * Math.max(0, this.t - this.spinFrom(i)) : 0);
      let kx = this.skx[k], ky = this.sky[k];
      const fx = this.sigFx[k];
      if (fx & 4) [x, y] = this.spread(x, y, this.objGroups[i]);
      const ar = fx & 1 ? this.areaAt(i, x + ox, y + oy) : null;
      if (ar) { x += ar.dx; y += ar.dy; turn += ar.rot; kx *= ar.kx; ky *= ar.ky; }
      // a piece of a bigger object sits off its centre: the offset turns and grows with the object (and
      // the music's swelling, about the object's centre)
      if (ox || oy) {
        const q = this.audio.size ? this.audioScale(i) : 1, a = turn * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
        const px = ox * kx * q, py = oy * ky * q;
        x += px * c + py * sn; y += -px * sn + py * c;
      }
      const rot = this.baseRot[i] + turn * Math.PI / 180;
      if (fx & 2) for (let g = 0; g < this.objGroups[i].length; g++) {
        const ui = this.uiGroups.get(this.objGroups[i][g]);
        if (ui) return [...this.uiPlace(ui, x, y), rot];
      }
      return [x, y, rot];
    }

    // a UI object at level place (x, y) on the screen (read from GD's own layout): its offset from the
    // camera guide, the guide's 480 x 320 frame put on the screen by its centre, its left side (+240),
    // its right side (screen width - 240) or, by default, the side the object is on; then into the level
    // where the camera is now
    uiPlace(ui, x, y) {
      const [gx, gy] = this.posOf(ui.ref[0], ui.ref[1], ui.ref[2]);
      const v = this.trackView(this.viewAspect || 16 / 9) || { x: this.cam.x, y: this.cam.y, zoom: 1 };
      const z = v.zoom || 1, sw = VIEW_H * (this.viewAspect || 16 / 9), rx = x - gx, ry = y - gy;
      const ax = ui.xRef === 2 ? sw / 2 : ui.xRef === 3 ? 240 : ui.xRef === 4 ? sw - 240 : rx > 0 ? sw - 240 : 240;
      return [v.x + (rx + ax - sw / 2) / z, v.y + ry / z];
    }

    // GD 2.2's area triggers on sprite i, whose object sits at (x, y): its move, turn, scale and
    // opacity this frame (null: no area reaches it). From GD's code (GJBaseGameLayer 0x331030 and
    // the per-kind routines it calls): each object gets a value v, its distance from the centre over the
    // area's length (0 in the middle, 1 at the edge and beyond), after the deadzone and, when inbound,
    // turned around; move/turn/scale act by 1 - ease(v) where v < 1, fade sets the opacity to
    // from + v (to - from) (the area nearest an object wins when several fade it)
    areaAt(i, x, y) {
      const groups = this.objGroups[i];
      if (this.areaCacheT !== this.t) { this.areaCache = new Map(); this.areaCacheT = this.t; }
      const had = this.areaCache.get(i);
      if (had !== undefined) return had;
      let r = null, fadeV = Infinity;
      const ox = x - this.partX[i], oy = y - this.partY[i];
      for (let k = 0; k < groups.length; k++) {
        const list = this.areaFx.get(groups[k]);
        if (!list) continue;
        for (const f of list) {
          const c = this.areaCenter(f.at);
          if (!c) continue;
          const t = f.t, v = this.areaValue(t, i, ox, oy, c);
          if (!r) r = { dx: 0, dy: 0, rot: 0, kx: 1, ky: 1, op: 1 };
          if (f.kind === "areafade") {
            if (v < fadeV) { fadeV = v; r.op = (t.fromOpacity || 0) + v * ((t.toOpacity || 0) - (t.fromOpacity || 0)); }
            continue;
          }
          if (v >= 1) continue;
          const w = 1 - (t.easeIn ? ease(t.easeIn, t.easeInRate, v) : v);   // (easing type 0: none)
          if (f.kind === "areamove") {
            if (t.xyMode) {
              r.dx += w * ((t.moveX || 0) + (t.moveXVar || 0) * this.areaRnd(i, 8));
              r.dy += w * ((t.moveY || 0) + (t.moveYVar || 0) * this.areaRnd(i, 9));
              continue;
            }
            let dist = (t.moveDist || 0) + (t.moveDistVar || 0) * this.areaRnd(i, 10), ux, uy;
            if (!dist) continue;
            if (t.relative) {   // away from the centre, less within the relative fade distance
              const ddx = ox - c[0], ddy = oy - c[1], l = Math.hypot(ddx, ddy), rf = Math.max(0, t.relFade || 0);
              if (l < rf) dist *= l / rf;
              if (!(l > 0)) continue;
              ux = ddx / l; uy = ddy / l;
            } else {   // GD: ccpForAngle((angle - 90) degrees)
              const a = ((t.moveAngle || 0) + (t.moveAngleVar || 0) * this.areaRnd(i, 11) - 90) * Math.PI / 180;
              ux = Math.cos(a); uy = Math.sin(a);
            }
            r.dx += w * dist * ux; r.dy += w * dist * uy;
          } else if (f.kind === "areascale") {
            const sx = (t.scaleX || 0) + (t.scaleXVar || 0) * this.areaRnd(i, 12);
            const sy = (t.scaleY || 0) + (t.scaleYVar || 0) * this.areaRnd(i, 13);
            if (sx || sy) { r.kx *= (sx - 1) * w + 1; r.ky *= (sy - 1) * w + 1; }
          } else r.rot += w * ((t.deg || 0) + (t.degVar || 0) * this.areaRnd(i, 14));
        }
      }
      this.areaCache.set(i, r);
      return r;
    }

    // GD's getAreaObjectValue (0x330cc0): direction 1/2 measure the signed distance along x/y from the
    // centre plus its offset, times the front modifier behind it and the back one ahead (283 makes the
    // front one count backwards, so both sides fall off); otherwise the straight distance. Then
    // (d / length - deadzone) / (1 - deadzone), clamped to 0..1 (0x3307e0); inbound turns it around
    areaValue(t, i, ox, oy, c) {
      const dir = t.dir | 0, off = t.offset || 0;
      let d;
      if (dir === 1 || dir === 2) {
        d = (dir === 1 ? ox - (c[0] + off) : oy - (c[1] + off)) + (t.offsetVar || 0) * this.areaRnd(i, 1);
        const mf = t.f283 ? -Math.abs(t.modFront ?? 1) : (t.modFront ?? 1);
        d *= d < 0 ? mf : (t.modBack ?? 1);
      } else {
        d = Math.hypot(ox - (c[0] + off + (t.offsetVar || 0) * this.areaRnd(i, 1)),
                       oy - (c[1] + (t.offsetY || 0) + (t.offsetYVar || 0) * this.areaRnd(i, 2)));
      }
      const len = Math.trunc((t.length || 0) + (t.lengthVar || 0) * this.areaRnd(i, 0)), dz = t.deadzone || 0;
      let v = d / len;
      if (dz) v = (v - dz) / (1 - dz);
      v = !(v > 0) ? 0 : v > 1 ? 1 : v;   // (also: deadzone 1 makes a hard edge, a zero length all or nothing)
      return t.inbound ? 1 - v : v;
    }

    // an area's centre now: a group's centre object, player 1/2, or a point on the screen (GD's ids
    // -3 middle, -4 bottom left, -5 left, -6 top left, -7 bottom, -8 top, -9 bottom right, -10 right,
    // -11 top right)
    areaCenter(at) {
      if (at === "p1" || at === "p2") return this.playerPos(at === "p2" ? 2 : 1);
      if (typeof at === "number" && at < 0) {
        const v = this.trackView(this.viewAspect || 16 / 9) || { x: this.cam.x, y: this.cam.y, zoom: 1 };
        const hh = VIEW_H / 2 / (v.zoom || 1), hw = hh * (this.viewAspect || 16 / 9);
        const px = { "-4": -1, "-5": -1, "-6": -1, "-7": 0, "-8": 0, "-9": 1, "-10": 1, "-11": 1 }[at] ?? 0;
        const py = { "-4": -1, "-5": 0, "-6": 1, "-7": -1, "-8": 1, "-9": -1, "-10": 0, "-11": 1 }[at] ?? 0;
        return [v.x + px * hw, v.y + py * hh];
      }
      if (!at) return null;   // a group: its drawn objects, else its centre object's place in the level
      const objs = this.groupObjects.get(at.g);
      return objs && objs.length ? this.pivot(at.g) : at.ref ? this.posOf(at.ref[0], at.ref[1], at.ref[2]) : null;
    }

    // GD's per-object random numbers for an area's variances (a table read from each object's variance
    // index): here a fixed hash of the object, -1 .. 1
    areaRnd(i, k) {
      const src = this.data.src ? this.data.src[i] : i;
      const h = Math.sin((src + 1) * 12.9898 + (k + 1) * 78.233) * 43758.5453;
      return (h - Math.floor(h)) * 2 - 1;
    }

    // scale a group by (rx, ry): its sprites, and with a centre group, its places about that group's point
    scaleCentre(cg, depth = 0) {   // a scale's centre group's point now (everything done to it), once per moment
      if (this.scaleCentreAt !== this.t) { this.scaleCentreAt = this.t; this.scaleCentres = new Map(); }
      let c = this.scaleCentres.get(cg);
      if (!c) this.scaleCentres.set(cg, c = this.pivot(cg, depth));
      return c;
    }

    // touch-activated triggers need the player to run into them. With GD's own record of the
    // player, its box has to meet the trigger's (Deprivation's optional "dim mode", a touch trigger
    // just above the start, stays off as in GD's run); without one, a trigger counts as touched
    // within the camera's height (where the player is), so logic parked far off the course stays quiet
    touchable(t) {
      if (this.data.playerTrack) {
        // the boxes meet: the trigger's 30 units times its scale, the player's 30 times its size
        const reach = n => 15 * (t.boxY || 1) + 15 * (this.player ? (this.playerState(this.t, this.player.list[n - 1]) || [0, 0, 1])[2] : 1);
        if (Math.abs(t.y - this.playerY) < reach(1)) return true;
        const p2 = this.player && this.player.list[1], st = p2 && this.playerState(this.t, p2);
        return !!(st && st[4] && Math.abs(t.y - this.playerPos(2)[1]) < reach(2));
      }
      const v = this.trackView(16 / 9);
      if (!v) return true;
      return Math.abs(t.y - v.y) <= VIEW_H / 2 / (v.zoom || 1) + 30;
    }

    // a rotation's pivot: where the centre group's objects are now, through everything done to them
    pivot(cg, depth = 0) {
      const objs = this.groupObjects.get(cg);
      if (!objs || !objs.length) return [0, 0];
      let sx = 0, sy = 0;
      for (const i of objs) { const p = this.sigPos(i, depth); sx += p[0]; sy += p[1]; }
      return [sx / objs.length, sy / objs.length];
    }

    // "Activate Group" on logic triggers: switch the group on and run its triggers
    activate(g, on = true) {
      this.setGroupOn(g, on);
      if (!on) return;
      this.queue.push([this.gameAt(this.t), g, this.srcGroups || []]);
    }

    posOf(x, y, groups) {   // a place in the level carried by these groups, now
      const k = this.sigOf(groups);
      if (k >= 0) return this.spread(this.sa[k] * x + this.sc[k] * y + this.stx[k], this.sb[k] * x + this.sd[k] * y + this.sty[k], groups);
      for (const g of groups) { x += this.groupDX.get(g) || 0; y += this.groupDY.get(g) || 0; }
      return [x, y];
    }

    itemValue(kind, id) {
      switch (kind | 0) {
        case 4: return this.t;              // level time
        case 5: return this.attempts;
        default: return id ? this.items.get(id) || 0 : 0;
      }
    }

    setGroupOn(g, on) { if (on) this.groupOff.delete(g); else this.groupOff.add(g); }

    groupEnabled(groups) {
      for (let k = 0; k < groups.length; k++) if (this.groupOff.has(groups[k])) return false;
      return true;
    }

    // ---------------------------------------------------------------- triggers
    fire(t, at = this.t) {   // at: when it fires (a spawn's exact due time, inside the current step)
      if (!this.groupEnabled(t.groups)) return;
      const now = at, nActions = this.actions.length, nPulses = this.pulses.length;
      this.srcGroups = t.groups;
      this.fireKind(this.warp !== 1 ? this.warped(t) : t, now);
      for (let k = nActions; k < this.actions.length; k++) this.actions[k].src = t.groups;
      for (let k = nPulses; k < this.pulses.length; k++) this.pulses[k].src = t.groups;
      this.srcGroups = null;
    }

    // GD 2.2's time warp (trigger 1935) slows the game but not the level's clock (the recorded
    // player covers 0.2x the ground per second under a 0.2 warp): what triggers start lasts longer
    warped(t) {
      const w = this.warp, o = Object.assign({}, t);
      for (const k of ["dur", "fin", "hold", "fout", "interval"]) if (o[k]) o[k] /= w;   // (delays: the game clock)
      return o;
    }

    fireKind(t, now) {
      switch (t.type) {
        case "timewarp": {   // (the game clock so far ran at the old warp)
          const g = this.gameAt(now);
          this.stepT0 = now; this.stepG0 = g; this.warp = t.value > 0 ? t.value : 1;
          break;
        }
        case "instcount": {
          const v = this.items.get(t.item | 0) || 0, c = t.count | 0;
          const ok = (t.cmp | 0) === 1 ? v > c : (t.cmp | 0) === 2 ? v < c : v === c;
          if (ok) this.activate(t.target, !!t.activate);
          break;
        }
        case "pickup": {
          const id = t.item | 0, c = t.count || 0;
          this.items.set(id, t.override ? c : (this.items.get(id) || 0) + c);
          break;
        }
        case "compare": {
          const side = (kind, id, mod, op) => {
            if (!id && (kind | 0) <= 1) return mod ?? 1;   // no item: the modifier is the value
            const v = this.itemValue(kind || 1, id | 0), m = mod ?? 1;
            switch (op | 0) { case 1: return v + m; case 2: return v - m; case 4: return m ? v / m : 0; default: return v * m; }
          };
          const a = side(t.kind1, t.id1, t.mod1, t.op1), b = side(t.kind2, t.id2, t.mod2, t.op2);
          const ok = [a === b, a > b, a >= b, a < b, a <= b, a !== b][t.cmp | 0];
          const g = ok ? t.target : t.falseTarget;
          if (g) this.queue.push([this.gameAt(now), g, t.groups]);
          break;
        }
        case "stop": {   // halt everything the target group's triggers started
          const g = t.target;
          this.actions = this.actions.filter(a => !(a.src && a.src.includes(g)));
          this.queue = this.queue.filter(q => !(q[2] && q[2].includes(g)));
          break;
        }
        case "collision": this.listeners.push({ t, touching: false }); break;
        case "speed": this.speed = SPEED_OF[t.speed] ?? 1; break;
        case "hideplayer": this.p1Hidden = this.p2Hidden = true; this.p1Seen.push([now, true]); break;   // GD's hide / show player
        case "showplayer": this.p1Hidden = this.p2Hidden = false; this.p1Seen.push([now, false]); break;
        case "options":   // its hide P1 / P2 boxes: 1 hides, -1 shows, 0 leaves it
          if (t.hideP1) { this.p1Hidden = t.hideP1 > 0; this.p1Seen.push([now, this.p1Hidden]); }
          if (t.hideP2) this.p2Hidden = t.hideP2 > 0;
          break;
        case "spawn": {   // a group is called at most once per moment (loops would otherwise multiply)
          const due = this.gameAt(now) + (t.delay || 0), key = t.target + "@" + Math.round(due * 240);
          if (this.queued.has(key)) break;
          this.queued.add(key);
          if (!t.ordered) { this.queue.push([due, t.target, t.groups]); break; }
          // "spawn ordered": the group's triggers go off left to right, as if the player ran through
          // them at the current speed from the first one
          const ts = (this.groupTriggers.get(t.target) || []).filter(o => o.mode === "spawn");
          const x0 = Math.min(...ts.map(o => o.x));
          for (const o of ts) this.queue.push([due + (o.x - x0) / SPEED_UNITS[this.speed], t.target, t.groups, o]);
          break;
        }
        case "toggle": this.setGroupOn(t.target, t.on); break;
        case "move":
          this.actions.push({ kind: "move", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate,
                              g: t.target, dx: t.dx || 0, dy: t.dy || 0, done: 0,
                              lockX: t.lockX, lockY: t.lockY, lockCamX: t.lockCamX, lockCamY: t.lockCamY,
                              modX: t.modX ?? 1, modY: t.modY ?? 1,
                              toTarget: t.toTarget, targetPos: t.targetPos, targetCenter: t.targetCenter, axis: t.targetAxis || 0 }); break;
        case "scale": {   // GD's scale trigger: 0 counts as 1; "divide" scales by 1 / the value
          let sx = t.sx || 1, sy = t.sy || 1;
          if (t.divX) sx = 1 / sx;
          if (t.divY) sy = 1 / sy;
          // with a centre group of its own the places spread from it; otherwise each object grows where it is
          this.actions.push({ kind: "scale", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, g: t.target,
                              cg: t.center && t.center !== t.target ? t.center : 0, sx, sy, mx: 1, my: 1 });
          break;
        }
        case "areamove": case "arearotate": case "areascale": case "areafade": {
          // an area trigger keeps acting on its group's objects from now on (firing again restarts it)
          const g = t.target | 0, sp = t.special | 0;
          const list = (this.areaFx.get(g) || []).filter(f => f.t.id !== t.id);
          list.push({ kind: t.type, t, at: sp === -1 ? "p1" : sp === -2 ? "p2" : sp < 0 ? sp : t.center ? { g: t.center | 0, ref: t.centerRef } : null });
          this.areaFx.set(g, list); this.markSigs(g, 1);
          break;
        }
        case "ui":
          if (t.refPos) { this.uiGroups.set(t.target | 0, { ref: t.refPos, xRef: t.xRef | 0 }); this.markSigs(t.target | 0, 2); }
          break;
        case "keyframes": {   // GD 2.2's keyframe animation: the group steps along the keyframes' path
          const path = this.data.keyframes && this.data.keyframes[t.anim | 0];
          if (path && path.length > 1)
            this.actions.push({ kind: "keyframes", t0: now, dur: Infinity, g: t.target, path, seg: 0, segT0: now, done: 0,
                                tm: (t.timeMod ?? 1) / this.warp, xm: t.xMod ?? 1, ym: t.yMod ?? 1 });
          break;
        }
        case "advfollow":
          if (t.p1 || t.p2) this.actions.push({ kind: "advfollow", t0: now, dur: Infinity, g: t.target, who: t.p2 && !t.p1 ? 2 : 1 });
          break;
        case "follow":
          this.actions.push({ kind: "follow", t0: now, dur: t.dur || 0, g: t.target, of: t.follow,
                              xm: t.xmod ?? 1, ym: t.ymod ?? 1 }); break;
        case "rotate": {
          // with no centre group, or the target as its own centre, every object turns about itself;
          // otherwise about the centre group's live position (it may be moving). Each trigger keeps its
          // own centre and lock: several on one group add up, each about its own point
          if (t.follow && (t.p1 || t.p2)) {
            // follow mode: the group turns as one piece about its centre group so that its first object
            // faces the way its player faces (Deprivation's fake player arrow points where the hidden wave
            // faces in GD's shots; GD's start dump has its pieces turned together, not each about itself)
            const who = t.p2 && !t.p1 ? 2 : 1, objs = this.groupObjects.get(t.target | 0);
            const first = objs && objs.length ? objs.reduce((a, b) => (this.data.src ? this.data.src[a] <= this.data.src[b] : a <= b) ? a : b) : -1;
            this.actions.push({ kind: "rotfollow", t0: now, dur: Infinity, g: t.target | 0, cg: (t.center || t.target) | 0,
                                who, ref: first >= 0 ? this.baseRot[first] * 180 / Math.PI : 0, done: 0 });
            break;
          }
          const cg = t.center && t.center !== t.target ? t.center : 0;
          this.actions.push({ kind: "rotate", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, g: t.target | 0, cg,
                              lock: !!t.lockRot, total: (t.deg || 0) + 360 * (t.turns || 0), done: 0 });
          break;
        }
        case "alpha": {   // replaces a fade still running on the same group (as GD), from wherever it got to
          this.actions = this.actions.filter(a => !(a.kind === "alpha" && a.g === t.target));
          const from = this.groupAlpha.has(t.target) ? this.groupAlpha.get(t.target) : 1;
          if (!(t.dur > 0)) { this.groupAlpha.set(t.target, t.opacity ?? 1); break; }   // instant: at once, as GD
          this.actions.push({ kind: "alpha", t0: now, dur: t.dur, g: t.target, from, to: t.opacity ?? 1 });
          break;
        }
        case "color": {   // likewise replaces a colour change still running on the channel
          const ch = t.channel || 1;
          this.actions = this.actions.filter(a => !(a.kind === "color" && a.ch === ch));
          const from = this.channelColor(ch).slice();
          let to = [(t.r ?? 255) / 255, (t.g ?? 255) / 255, (t.b ?? 255) / 255];
          if (t.copy) to = applyHSV(this.channelColor(t.copy), parseHSV(t.hsv));
          this.copies.delete(ch);   // a colour trigger replaces any copy; a copying one sets a new one when done
          const copy = t.copy ? [t.copy, parseHSV(t.hsv)] : null;
          if (!(t.dur > 0)) {   // instant: set at once, so a fade fired in the same moment starts from it (as GD)
            this.chan.set(ch, [to[0], to[1], to[2], t.opacity ?? 1, t.blend ? 1 : 0]);
            if (copy) this.copies.set(ch, copy);
            break;
          }
          this.actions.push({ kind: "color", t0: now, dur: t.dur, ch, from, to, op: t.opacity ?? 1, blend: t.blend ? 1 : 0, copy });
          break;
        }
        case "pulse": {
          let col = [(t.r ?? 255) / 255, (t.g ?? 255) / 255, (t.b ?? 255) / 255];
          if (t.hsvMode) col = { copy: t.copy || 0, hsv: parseHSV(t.hsv), scale: !!t.scaleHSV };
          this.pulses.push({ t0: now, fin: t.fin || 0, hold: t.hold || 0, fout: t.fout || 0, group: !!t.group,
                             target: t.target, col, mainOnly: !!t.mainOnly, detailOnly: !!t.detailOnly });
          break;
        }
        case "zoom": this.actions.push({ kind: "zoom", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate,
                                         from: this.cam.zoom, to: t.zoom || 1 }); break;
        case "static":
          if (t.exit) this.cam.static = null;
          else this.cam.static = { g: t.target, t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, from: [this.cam.x, this.cam.y] };
          break;
        case "offset": this.actions.push({ kind: "offset", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate,
                                           fx: this.cam.offX, fy: this.cam.offY, dx: t.dx || 0, dy: t.dy || 0 }); break;
        case "gradient": {   // a gradient takes the place of any with its id; "disable" removes it
          this.gradients.delete(t.gid | 0);
          if (!t.disable) this.gradients.set(t.gid | 0, t);
          break;
        }
        case "shaderlayers": {   // GD's layer scale: 3..7 = B5..B1, 8 = the player's, 9..12 = T1..T4, 13+ = all
          const v = t.max | 0;   // (a minimum above the bottom layer isn't supported: Nullscapes doesn't use one)
          this.shader.top = v >= 13 ? 8 : v >= 9 ? v - 4 : v >= 3 ? Math.min(v, 7) - 3 : v === 0 ? 4 : -1;
          this.shader.playerIn = v >= 8 || v === 0;   // (8: up to the player's own layer; none set covers it too:
          // Deprivation's player is tinted at 76 s)
          break;
        }
        case "glitch":   // GD's glitch shader (trigger 2909): its settings take effect at once
          Object.assign(this.shader, { glitch: t.strength || 0, glitchSpeed: t.speed || 0, glitchSlice: t.slice || 0,
                                       glitchX: t.sliceX || 0, glitchColX: t.colX || 0, glitchColY: t.colY || 0 });
          break;
        case "chromaglitch": case "radialblur": case "grayscale": case "sepia": case "invert": case "editcolor": case "hue": {
          // shader triggers ease their effect's settings from where they are (a new one of a kind
          // replaces a running one); switches take effect at once
          const sh = this.shader, to = {};
          if (t.type === "radialblur") { to.size = t.size || 0; sh.fade = t.fade ?? 1; }
          else if (t.type === "grayscale") { to.gray = t.value || 0; sh.grayLum = t.useLum ? 1 : 0; }
          else if (t.type === "sepia") to.sepia = t.value || 0;
          else if (t.type === "hue") to.hue = t.value || 0;   // degrees
          else if (t.type === "chromaglitch") {   // switching it on restarts its clock; disabling cuts it at once
            if (!sh.cg) sh.cgTime = now % 1000;
            sh.cg = t.disable ? 0 : 1; sh.cgRel = t.relative ? 1 : 0;
            Object.assign(to, { cgSpeed: t.speed || 0, cgStrength: t.strength || 0, cgLineStrength: t.lineStrength || 0,
                                cgLineThick: t.lineThick || 0, cgRgb: t.rgb || 0, cgHeight: 1 / Math.max(t.height || 0, 0.1) });
          }
          else if (t.type === "invert") {   // (GD's setter: the colour and its clamp change only with Edit RGB,
            // at once unless Tween RGB)
            to.inv = t.value || 0;
            if (t.editRGB) {
              sh.invClamp = t.clamp ? 1 : 0;
              if (t.tweenRGB) { to.invR = t.r || 0; to.invG = t.g || 0; to.invB = t.b || 0; }
              else { sh.invR = t.r || 0; sh.invG = t.g || 0; sh.invB = t.b || 0; }
            }
          } else Object.assign(to, { cR: t.cr ?? 1, cG: t.cg ?? 1, cB: t.cb ?? 1, bR: t.br || 0, bG: t.bg || 0, bB: t.bb || 0 });
          this.actions = this.actions.filter(a => !(a.kind === "shader" && a.of === t.type));
          const from = {};
          for (const k in to) from[k] = sh[k];
          this.actions.push({ kind: "shader", of: t.type, t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, from, to });
          break;
        }
        case "pixelate": case "chromatic": case "pinch": case "bulge": case "motionblur": {
          // GD's shader layer tweens each setting on its own, from where it is (a new trigger restarts that
          // setting's tween); switches take effect at once. Which axes and keys: GJBaseGameLayer's shader switch
          const sh = this.shader, to = {};
          // the centre: player 1 or 2, else group 51 (followed as it moves)
          const at = t.p1 ? "p1" : t.p2 ? "p2" : t.center ? { g: t.center | 0, ref: t.centerRef } : null;
          if (t.type === "pixelate") {
            if (t.useX || t.useY) { sh.pxSnap = t.snap ? 1 : 0; sh.pxRel = t.relative ? 1 : 0; sh.pxHard = t.hard ? 1 : 0; }
            if (t.useX) { sh.px = Math.max(sh.px, 1); to.px = t.vx || 0; }   // (GD starts a tween from at least 1)
            if (t.useY) { sh.py = Math.max(sh.py, 1); to.py = t.vy || 0; }
          } else if (t.type === "chromatic") {
            if (t.useX || t.useY) sh.chromRel = t.relative ? 1 : 0;
            if (t.useX) to.chromX = t.vx || 0;
            if (t.useY) to.chromY = t.vy || 0;
          } else if (t.type === "pinch") {
            if (t.useX) Object.assign(to, { pinchX: t.vx || 0, pinchOffX: t.offX || 0, pinchR: t.radius || 0, pinchModX: t.mod || 0 });
            if (t.useY) Object.assign(to, { pinchY: t.vy || 0, pinchOffY: t.offY || 0, pinchR: t.radius || 0, pinchModY: t.mod || 0 });
            if (t.useX || t.useY) { sh.pinchAt = t.target ? at : null; sh.pinchRel = t.relative ? 1 : 0; }
          } else if (t.type === "motionblur") {   // (fade and intensity ease linearly, as GD's tweens do)
            if (t.useX || t.useY) { sh.mbDual = t.dual ? 1 : 0; sh.mbRel = t.relative ? 1 : 0; }
            if (t.useX) to.mbX = t.vx || 0;
            if (t.useY) to.mbY = t.vy || 0;
          } else {
            Object.assign(to, { bulge: t.strength || 0, bulgeOffX: t.offX || 0, bulgeOffY: t.offY || 0, bulgeR: t.radius || 0 });
            sh.bulgeAt = t.target ? at : null; sh.bulgeRel = t.relative ? 1 : 0;
          }
          if (t.type === "motionblur" && (t.useX || t.useY)) for (const [k, v] of [["mbFade", t.fade || 0], ["mbIntensity", t.intensity || 0]]) {
            this.actions = this.actions.filter(a => !(a.kind === "shader" && a.of === k));
            if (t.dur > 0) this.actions.push({ kind: "shader", of: k, t0: now, dur: t.dur, ease: 0, rate: 0, from: { [k]: sh[k] }, to: { [k]: v } });
            else sh[k] = v;
          }
          for (const k in to) {
            this.actions = this.actions.filter(a => !(a.kind === "shader" && a.of === k));
            if (!(t.dur > 0)) { sh[k] = to[k]; continue; }
            this.actions.push({ kind: "shader", of: k, t0: now, dur: t.dur, ease: t.ease, rate: t.rate, from: { [k]: sh[k] }, to: { [k]: to[k] } });
          }
          break;
        }
        case "shockwave": {   // GD's shockwave (2905): starts over from the centre group, settings at once
          // (companion triggers that ease a running one aren't supported; Nullscapes has none)
          this.shock = { t: t, t0: now, at: this.groupCenter(t.center) };
          break;
        }
        case "shake": {   // a new shake replaces the running one, starting from where the camera is now
          const from = this.shakeOffset();
          const every = Math.max(t.interval || 0, 1 / 60);
          this.shake = { t0: now, end: now + (t.dur || 0), size: (t.strength || 0) * SHAKE_SCALE, every,
                         from, to: from, at: now, next: now + every };
          break;
        }
      }
    }

    // collision triggers: fire when a block with id A starts overlapping one with id B
    checkCollisions() {
      for (const l of this.listeners) {
        const { t } = l;
        const as = this.colBlocks.filter(b => (b.block | 0) === (t.blockA | 0) && this.groupEnabled(b.groups));
        const bs = this.colBlocks.filter(b => (b.block | 0) === (t.blockB | 0) && this.groupEnabled(b.groups));
        let touching = false;
        for (const a of as) {
          const [ax, ay] = this.posOf(a.x, a.y, a.groups), ah = 15 * Math.abs(a.sy || a.scale || 1), aw = 15 * Math.abs(a.sx || a.scale || 1);
          for (const b of bs) {
            const [bx, by] = this.posOf(b.x, b.y, b.groups), bh = 15 * Math.abs(b.sy || b.scale || 1), bw = 15 * Math.abs(b.sx || b.scale || 1);
            if (Math.abs(ax - bx) < aw + bw && Math.abs(ay - by) < ah + bh) { touching = true; break; }
          }
          if (touching) break;
        }
        if (touching !== l.touching && touching !== !!t.onExit) this.activate(t.target, !!t.activate);
        l.touching = touching;
      }
    }

    // the game clock at level time t within this step (the warp as it is now)
    gameAt(t) { return this.stepG0 + (t - this.stepT0) * this.warp; }

    step(dt) {
      const prevX = this.playerX;
      this.stepT0 = this.t; this.stepG0 = this.gt;
      this.t += dt;
      if (this.shader.cg) this.shader.cgTime = (this.shader.cgTime + dt * this.shader.cgSpeed) % 1000;
      const tracked = this.data.playerFromCamera && this.trackX(this.t);
      const prevY = this.playerY;
      const pt = this.data.playerTrack;
      if (pt) {
        // GD's own record of the player: it may teleport, back or ahead. Triggers go off when it
        // crosses them moving forward (a teleport crosses nothing), each once unless multi-activated
        this.playerX = tracked; this.playerY = this.trackY(this.t);
        // (on the first step everything left of the player goes off, as when GD starts a level)
        const first = !this.xStarted, x0 = first ? -Infinity : prevX, x1 = this.playerX, xt = this.xTriggers;
        this.xStarted = true;
        if (first || (x1 > x0 && x1 - x0 < TELEPORT)) {
          let lo = 0, hi = xt.length;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (xt[mid].at <= x0) lo = mid + 1; else hi = mid; }
          for (let i = lo; i < xt.length && xt[i].at <= x1; i++) {
            const t = xt[i];
            if (!t.multi && this.xFired.has(t.id)) continue;
            this.xFired.add(t.id);
            // at the moment the player crossed it, within this step: loops it starts (GD's strobes,
            // its delays exact, not whole steps: fitted on paused snapshots) keep GD's phase
            // (GD notices it on its next 1/240 s step)
            let at = first ? this.trackTimeOf(t.at) : this.t - dt + (t.at - x0) / (x1 - x0) * dt;
            at = Math.ceil(at * 240 - 1e-6) / 240;
            if (t.mode !== "touch" || this.touchable(t)) this.fire(t, Math.min(this.t, Math.max(this.t - dt, at)));
          }
        }
      } else {
        // with a recorded camera that follows the player (data.playerFromCamera), the player is where
        // the camera says, a fixed distance ahead of its left edge; otherwise it runs at its speed
        this.playerX = tracked !== null && tracked !== false ? Math.max(prevX, tracked) : this.playerX + SPEED_UNITS[this.speed] * dt;
        // x-activated triggers the player passed
        while (this.nextX < this.xTriggers.length && this.xTriggers[this.nextX].at <= this.playerX) {
          const t = this.xTriggers[this.nextX++];
          if (t.mode !== "touch" || this.touchable(t)) this.fire(t);
        }
      }
      // spawn activations that are due
      // (in time order, each at its own due time, and calls those make with no delay run in this
      // same step: a spawn loop keeps GD's period instead of losing a step every lap)
      this.gt = this.gameAt(this.t);
      if (this.queue.length) {
        if (this.queued.size > 50000) this.queued.clear();
        const firedNow = new Set();   // each trigger fires once per step, however many calls reach it
        for (let round = 0; round < 16; round++) {
          const due = this.queue.filter(q => q[0] <= this.gt).sort((a, b) => a[0] - b[0]);
          if (!due.length) break;
          this.queue = this.queue.filter(q => q[0] > this.gt);
          for (const [gat, g, , only] of due) {
            // (back on the level's clock: when within this step the game clock reached it)
            const at = Math.min(this.t, Math.max(this.stepT0, this.stepT0 + (gat - this.stepG0) / this.warp));
            for (const t of only ? [only] : this.groupTriggers.get(g) || []) {
              // a call only runs the group's spawn-triggered triggers: ones the player sets off by
              // passing them (often a loop's kick-off) don't fire again
              if (t.mode !== "spawn") continue;
              if (!firedNow.has(t.id)) { firedNow.add(t.id); this.fire(t, at); }
            }
          }
        }
      }
      if (this.listeners.length) this.checkCollisions();
      const sv = this.systems.size && this.trackView(16 / 9);
      for (const [i, sys] of this.systems) {
        // GD runs a particle object's system only while the object is awake (switched on, near the
        // screen); asleep, the system goes back, and the object wakes with a fresh one
        const on = !this.objGroups[i].length || this.groupEnabled(this.objGroups[i]);
        const at = on && this.objPos(i);
        if (!at || (sv && (Math.abs(at[0] - sv.x) > VIEW_H * 2 / (sv.zoom || 1) + 300 || Math.abs(at[1] - sv.y) > VIEW_H / (sv.zoom || 1) + 300))) {
          if (sys.claimed) sys.release();
          continue;
        }
        const st = this.emitterState(i, sys, at, sv);
        if (!sys.claimed) sys.claim(st, this.gt);
        sys.run(dt * this.warp, st, this.gt, this.gdFps());
      }
      // how far the player and the camera moved this step (locked groups ride along, teleports included, as in GD)
      const pdx = this.playerX - prevX, pdy = this.data.playerTrack ? this.playerY - prevY : 0;
      let cdx = 0, cdy = 0;
      if (this.track) {
        const c0 = this.camAt(this.t - dt), c1 = this.camAt(this.t);
        if (c0 && c1) { cdx = c1[0] - c0[0]; cdy = c1[1] - c0[1]; }
      }
      // running actions
      this.scaleCentreAt = -1;   // (centres as the step began moving them)
      this.actions = this.actions.filter(a => {
        const u = a.dur > 0 ? Math.min(1, (this.t - a.t0) / a.dur) : 1;
        switch (a.kind) {
          case "move": {
            if (a.toTarget && !a.aimed) {   // "move to target": its centre group onto the target group, as it is when it starts
              a.aimed = true;
              const to = this.groupCenter(a.targetPos), from = this.groupCenter(a.targetCenter || a.g);
              if (to && from) { a.dx = a.axis === 2 ? 0 : to[0] - from[0]; a.dy = a.axis === 1 ? 0 : to[1] - from[1]; }
            }
            const e = ease(a.ease, a.rate, u);
            const ddone = e - a.done; a.done = e;
            // a locked axis rides along with the player or the camera (times GD's mod); the others move by the offset.
            // A lock that started during this step takes only the movement after it, and no jump: a
            // teleport set off with it (Deprivation's at x 29745) leaves the group where it was, as in GD
            let f = 1;
            if (a.t0 > this.t - dt + 1e-9) f = Math.abs(pdx) > TELEPORT || Math.abs(pdy) > TELEPORT ? 0 : (this.t - a.t0) / dt;
            const mx = a.lockX ? pdx * a.modX * f : a.lockCamX ? cdx * a.modX * f : a.dx * ddone;
            const my = a.lockY ? pdy * a.modY * f : a.lockCamY ? cdy * a.modY * f : a.dy * ddone;
            this.moveGroup(a.g, mx, my);
            return u < 1;
          }
          case "scale": {   // the factor eases from 1 to its value; each step adds what it gained
            const e = ease(a.ease, a.rate, u);
            const mx = 1 + (a.sx - 1) * e, my = 1 + (a.sy - 1) * e;
            const rx = mx / a.mx, ry = my / a.my;
            a.mx = mx; a.my = my;
            if (rx !== 1 || ry !== 1) this.scaleGroupBy(a.g, rx, ry, a.cg, a.sx === a.sy);
            return u < 1;
          }
          case "keyframes": {
            while (a.seg < a.path.length - 1) {
              const k0 = a.path[a.seg], k1 = a.path[a.seg + 1], d = k0[2] * a.tm;
              const v = d > 0 ? Math.min(1, (this.t - a.segT0) / d) : 1;
              const e = ease(k0[3], k0[4], v), de = e - a.done;
              if (de) this.moveGroup(a.g, (k1[0] - k0[0]) * de * a.xm, (k1[1] - k0[1]) * de * a.ym);
              a.done = e;
              if (v < 1) return true;
              a.seg++; a.segT0 += d; a.done = 0;
            }
            return false;
          }
          case "advfollow": {   // the group's centre onto its player
            const [gx, gy] = this.pivot(a.g), [px, py] = this.playerPos(a.who);
            this.moveGroup(a.g, px - gx, py - gy);
            return true;
          }
          case "follow": {   // follows how the other group's objects actually move (whatever moves them), times its mods
            const c = this.groupCenter(a.of);
            if (!c) return u < 1;
            if (a.px !== undefined) {
              this.moveGroup(a.g, (c[0] - a.px) * a.xm, (c[1] - a.py) * a.ym);
            }
            a.px = c[0]; a.py = c[1];
            return u < 1;
          }
          case "rotfollow": {
            const want = this.playerRot(a.who) - a.ref, d = want - a.done;
            a.done = want;
            if (d) this.turnGroup(a.g, d, this.pivot(a.cg), false);
            return true;
          }
          case "rotate": {
            const e = ease(a.ease, a.rate, u), d = a.total * (e - a.done);
            a.done = e;
            if (d) this.turnGroup(a.g, d, a.cg ? this.pivot(a.cg) : null, a.lock);
            return u < 1;
          }
          case "alpha": this.groupAlpha.set(a.g, a.from + (a.to - a.from) * u); return u < 1;
          case "color": {
            const c = a.from.map((v, k) => k < 3 ? v + (a.to[k] - v) * u : v);
            c[3] = a.from[3] + (a.op - a.from[3]) * u; c[4] = a.blend;
            this.chan.set(a.ch, c);
            if (u >= 1 && a.copy) this.copies.set(a.ch, a.copy);   // from now on it follows its source
            return u < 1;
          }
          case "zoom": this.cam.zoom = a.from + (a.to - a.from) * ease(a.ease, a.rate, u); return u < 1;
          case "offset": { const e = ease(a.ease, a.rate, u); this.cam.offX = a.fx + a.dx * e; this.cam.offY = a.fy + a.dy * e; return u < 1; }
          case "shader": {
            const e = ease(a.ease, a.rate, u);
            for (const k in a.to) this.shader[k] = a.from[k] + (a.to[k] - a.from[k]) * e;
            return u < 1;
          }
        }
        return false;
      });
      this.pulses = this.pulses.filter(p => this.t - p.t0 < p.fin + p.hold + p.fout);
      this.scaleCentreAt = -1;   // (the actions moved the centres)
      // the camera: locked to a group (static), or following the player
      if (this.cam.static) {
        const s = this.cam.static, c = this.groupCenter(s.g);
        if (c) {
          const u = s.dur > 0 ? ease(s.ease, s.rate, Math.min(1, (this.t - s.t0) / s.dur)) : 1;
          this.cam.x = s.from[0] + (c[0] - s.from[0]) * u;
          this.cam.y = s.from[1] + (c[1] - s.from[1]) * u;
        }
      } else {
        this.cam.x = this.playerX + 75;
      }
    }

    // seek: run the simulation from the start up to `seconds` (fast, nothing is drawn)
    seek(seconds, dt = 1 / 60) {
      if (seconds < this.t) this.reset();
      while (this.t + dt <= seconds) this.step(dt);
      if (seconds - this.t > 1e-9) this.step(seconds - this.t);   // the rest, to land on the moment asked for
    }

    // the camera from the recorded track at the current time. GD's camera position is the
    // bottom-left of the zoomed view (320/zoom units tall; wider screens see more), in GD's
    // node space, where y sits 90 units above the level file's y (the ground's height).
    // the music pulse now (0..1), and how much an object that scales with it is scaled
    pulseNow() {
      const p = this.data.pulse;
      if (!p || !p.values.length) return 0.5;
      const f = this.t * p.rate, k = Math.floor(f), u = f - k, v = p.values;
      if (k >= v.length - 1) return v[v.length - 1];
      return v[Math.max(0, k)] * (1 - u) + v[Math.max(0, k + 1)] * u;
    }
    audioScale(i) {
      const r = this.audio.get(i);
      if (!r || !this.data.pulse) return 1;   // no recorded pulse: leave it its own size
      if (this.pulseAt !== this.t) { this.pulseAt = this.t; this.pulseVal = this.pulseNow(); }
      return r[0] + (r[1] - r[0]) * this.pulseVal;
    }

    // GD only turns a rotating object while it is near the screen, so its angle counts from when
    // the camera first reached it (its right edge plus a little), not from the level's start
    spinFrom(i) {
      if (!this.spinStart) this.spinStart = new Map();
      let t0 = this.spinStart.get(i);
      if (t0 === undefined) {
        const tr = this.track, x = this.baseX[i] - this.partX[i];
        t0 = 0;
        if (tr && tr.length) {
          let lo = 0, hi = tr.length - 1;
          const reach = k => tr[k][2] + VIEW_H * 16 / 9 / (tr[k][1] || 1) + SPIN_WAKE;
          if (reach(0) < x) {
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (reach(mid) < x) lo = mid; else hi = mid; }
            t0 = tr[hi][0];
          }
        }
        this.spinStart.set(i, t0);
      }
      return t0;
    }

    trackJump(a, b) {   // two neighbouring rows of the player's record a teleport apart (not a stretch of running)
      return b[0] - a[0] < 0.05 && (Math.abs(b[1] - a[1]) > TELEPORT || Math.abs(b[2] - a[2]) > TELEPORT);
    }

    trackTimeOf(x) {   // when the recorded player first reached x (0 if it started past it)
      const pt = this.data.playerTrack;
      for (let k = 1; k < pt.length; k++) {
        if (pt[k][1] >= x) {
          const a = pt[k - 1], b = pt[k];
          return b[1] > a[1] && a[1] <= x ? a[0] + (x - a[1]) / (b[1] - a[1]) * (b[0] - a[0]) : (a[1] >= x ? a[0] : b[0]);
        }
      }
      return 0;
    }

    trackY(t) {   // the recorded player's y (data.playerTrack's third column), else 0
      const pt = this.data.playerTrack;
      if (!pt || !pt.length || pt[0].length < 3) return 0;
      let lo = 0, hi = pt.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pt[mid][0] <= t) lo = mid; else hi = mid; }
      const a = pt[lo], b = pt[hi];
      if (this.trackJump(a, b)) return t < b[0] ? a[2] : b[2];   // a teleport: at once
      const u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
      return a[2] + (b[2] - a[2]) * u;
    }

    camAt(t) {   // the recorded camera's own position (its bottom-left, node space) at level time t
      const tr = this.track;
      if (!tr || !tr.length) return null;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi], u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
      return [a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
    }

    trackX(t) {   // where the player is: GD's own record of it (data.playerTrack, [t, x] rows) when there is
      // one, else by the recorded camera (its x at level start sets the distance)
      const pt = this.data.playerTrack;
      if (pt && pt.length) {
        let lo = 0, hi = pt.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pt[mid][0] <= t) lo = mid; else hi = mid; }
        const a = pt[lo], b = pt[hi];
        if (this.trackJump(a, b)) return t < b[0] ? a[1] : b[1];   // a teleport: at once
        const u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
        return a[1] + (b[1] - a[1]) * u;
      }
      const tr = this.track;
      if (!tr || !tr.length) return null;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi], u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
      return a[2] + (b[2] - a[2]) * u + (this.startX || 0) - tr[0][2];
    }

    // where a pinch or bulge is centred, as a fraction of the screen: on its player or group, else on the
    // screen's middle moved by its offset (in half screens)
    lensCenter(at, offX, offY, cx, cy, hw, hh) {
      let p = null;
      if (at === "p1" || at === "p2") p = this.playerPos(at === "p2" ? 2 : 1);
      else if (at) p = this.groupCenter(at.g) || (at.ref && this.posOf(at.ref[0], at.ref[1], at.ref[2]));
      return p ? [((p[0] - cx) / hw + 1) / 2, ((p[1] - cy) / hh + 1) / 2] : [0.5 + 0.5 * offX, 0.5 + 0.5 * offY];
    }

    // pixelate, chromatic aberration, pinch and bulge as GD's shader layer hands them to its shader
    // (decompiled: ShaderLayer's update). Sizes in GD's shader units: screen widths times SCREEN_K
    // (and the zoom when relative); G = the 960 x 640 design screen's diagonal / its width
    lensUniforms(cx, cy, hw, hh, zoom, W, H) {
      const sh = this.shader, G = Math.sqrt(13) / 3, ppp = H / 320, out = { on: false };
      // pixelate: GD draws the scene into a texture px times smaller and stretches it back
      const bx = Math.max(1, sh.px), by = Math.max(1, sh.py);
      if (bx > 1 || by > 1) {
        const zr = sh.pxRel ? zoom : 1, kx = bx * ppp * zr, ky = by * ppp * zr;
        const mod = (v, m) => ((v % m) + m) % m;
        // snapped, its blocks keep to the level as the camera moves; else to the screen's corner
        out.px = sh.pxSnap ? [kx, ky, mod(-(cx - hw) * zoom * ppp, kx), mod(-(cy - hh) * zoom * ppp, ky)] : [kx, ky, 0, 0];
        out.on = true;
      } else out.px = [0, 0, 0, 0];
      // chromatic: offsets in points / G, as a fraction of the screen
      const zc = sh.chromRel ? zoom : 1;
      out.chrom = [sh.chromX / G / (320 * W / H) * zc, sh.chromY / G / 320 * zc];
      if (out.chrom[0] || out.chrom[1]) out.on = true;
      // pinch: _pinchValue = -0.1 x strength (an axis at 0 gets 0.001 while the other is on), _pinchCalc1 =
      // modifier / atan(2 x strength x modifier): the modifier is the distance it maps onto itself
      out.pinch = [0, 0, 0, 0]; out.pinchC = [0.5, 0.5, 1, 1];
      if (sh.pinchX || sh.pinchY) {
        const x = sh.pinchX || 0.001, y = sh.pinchY || 0.001, s = SCREEN_K * (sh.pinchRel ? zoom : 1);
        const mx = Math.max(0.001, sh.pinchModX), my = Math.max(0.001, sh.pinchModY);
        const c = this.lensCenter(sh.pinchAt, sh.pinchOffX, sh.pinchOffY, cx, cy, hw, hh);
        out.pinch = [-0.1 * x, -0.1 * y, s * sh.pinchR, 0];
        out.pinchC = [c[0], c[1], mx / Math.atan(2 * x * mx), my / Math.atan(2 * y * my)];
        if (out.pinch[2] > 0) out.on = true;
      }
      // motion blur: value = strength x 0.1 x K per axis (y also x width / height); fade clamped to
      // +-0.1 (+-0.2 dual); mult = 1 / (9 - (36, dual 20) x fade). A running radial blur takes precedence
      out.mb = [0, 0, 0, 1]; out.mbDual = sh.mbDual;
      if ((sh.mbX || sh.mbY) && !(Math.abs(sh.size) > 1e-4)) {
        const k = SCREEN_K * (sh.mbRel ? zoom : 1) * 0.1, f = sh.mbDual ? 0.2 : 0.1;
        const fade = Math.max(-f, Math.min(f, f * sh.mbFade));
        out.mb = [sh.mbX * k, sh.mbY * k * W / H, fade, 1 / (9 - (sh.mbDual ? 20 : 36) * fade)];
        out.on = true;
      }
      // bulge: _bulgeValue = 0.45 pi x strength / L, _bulgeValue2 = L / tan(_bulgeValue x L), L = s x G^2 / sqrt 2
      out.bulge = [0, 0, 0, 0]; out.bulgeC = [0.5, 0.5];
      if (sh.bulge > 0) {
        const s = SCREEN_K * (sh.bulgeRel ? zoom : 1), L = 0.5 * s * G * G * Math.SQRT2;
        const v = Math.max(0.001, 0.45 * Math.PI * sh.bulge / L);
        out.bulge = [v, L / Math.tan(v * L), s * sh.bulgeR, 0];
        out.bulgeC = this.lensCenter(sh.bulgeAt, sh.bulgeOffX, sh.bulgeOffY, cx, cy, hw, hh);
        if (out.bulge[2] > 0) out.on = true;
      }
      return out;
    }

    // the shockwave's shader uniforms with the camera at (cx, cy), half sizes hw x hh; null once
    // its ring has left the screen. GD's values (read from the game): the ring's front at radius P²
    // (P when inverted), P = offset / 10 + time x speed, in screen widths; its thickness is
    // thick / 5, with fades either side; 22 / width waves
    shockwave(cx, cy, hw, hh, zoom) {
      const sk = this.shock && this.shock.t;
      const at = sk && (sk.follow ? this.groupCenter(sk.center) : this.shock.at);
      if (!at) return null;
      const k = SCREEN_K * (sk.relative ? (zoom || 1) : 1), A = hw / hh;
      const P = (sk.offset || 0) * 0.1 + (this.t - this.shock.t0) * (sk.speed || 0);
      const T = Math.max(0.001, sk.thick || 0) * 0.2, fi = T * (sk.fadeIn || 0), fo = T * (sk.fadeOut || 0);
      const R = (sk.invert ? P : P * P) - fi, waves = 22 / Math.max(0.001, sk.waveWidth || 0);
      const c = [((at[0] - cx) / hw + 1) / 2, ((at[1] - cy) / hh + 1) / 2];
      const far = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Math.hypot(x - c[0], (y - c[1]) * A)));
      if (!sk.invert && (R - T - fo) * k > far) return null;
      return { sw: [(waves * P) % (2 * Math.PI) || 1e-6, (sk.strength || 0) * 0.1 * k, waves / k, sk.invert ? 1 : 0],
               swT: [(R + fi + 0.001) * k, R * k, (R - T + 0.001) * k, (R - T - fo) * k],
               swC: [c[0], c[1], k * (sk.minSize || 0) * 0.5, k * (sk.maxSize || 0)],
               misc: [sk.maxDist ? 1 / (sk.maxDist * 0.5 * k) : 0, A] };
    }

    trackView(aspect) {
      const tr = this.track;
      if (!tr || !tr.length) return null;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= this.t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi], u = b[0] > a[0] ? Math.min(1, Math.max(0, (this.t - a[0]) / (b[0] - a[0]))) : 0;
      const zoom = a[1] + (b[1] - a[1]) * u;
      const x = a[2] + (b[2] - a[2]) * u, y = a[3] + (b[3] - a[3]) * u;
      const hh = VIEW_H / 2 / (zoom || 1);
      return { x: x + hh * aspect, y: y - GROUND_Y + hh, zoom };
    }

    // GD moves a shaking camera to a new random offset once per interval (never more than 60
    // times a second); here it glides between those offsets and settles back when the shake ends
    shakeOffset() {
      const k = this.shake;
      if (!k) return [0, 0];
      while (this.t >= k.next && k.next < k.end) {   // time for a new offset
        const cur = this.shakeAt(k, k.next);
        k.from = cur; k.at = k.next; k.next += k.every;
        k.to = [(this.shakeRnd() * 2 - 1) * k.size, (this.shakeRnd() * 2 - 1) * k.size];
      }
      if (this.t >= k.end) {   // ease home over a moment
        if (!k.home) { k.home = this.shakeAt(k, k.end); k.homeAt = k.end; }
        const u = Math.min(1, (this.t - k.homeAt) / SHAKE_SETTLE);
        if (u >= 1) { this.shake = null; return [0, 0]; }
        const e = 1 - ease(13, 2, u);
        return [k.home[0] * e, k.home[1] * e];
      }
      return this.shakeAt(k, this.t);
    }

    shakeAt(k, t) {
      const u = ease(13, 2, Math.min(1, (t - k.at) / k.every));   // smooth step between offsets
      return [k.from[0] + (k.to[0] - k.from[0]) * u, k.from[1] + (k.to[1] - k.from[1]) * u];
    }

    pulseIntensity(p) {
      const a = this.t - p.t0;
      if (a < p.fin) return p.fin ? a / p.fin : 1;
      if (a < p.fin + p.hold) return 1;
      return p.fout ? Math.max(0, 1 - (a - p.fin - p.hold) / p.fout) : 0;
    }

    // a pulse's colour at strength k: its own, or a channel's (or the object's) through its HSV. With key 210
    // GD scales the HSV itself by the strength (hue x k, saturation and value eased towards x1) before the
    // colour fades in (GD's pulse colour, 0x36bfb0): a hue shift sweeps through the hues between as it fades
    pulseColor(p, base, k = 1) {
      if (Array.isArray(p.col)) return p.col;
      let h = p.col.hsv;
      if (h && p.col.scale && k < 1) h = [h[0] * k, h[3] ? h[1] * k : h[1] * k + 1 - k, h[4] ? h[2] * k : h[2] * k + 1 - k, h[3], h[4]];
      return applyHSV(p.col.copy ? this.channelColor(p.col.copy) : base, h);
    }

    // ---------------------------------------------------------------- drawing
    // an emitter's particles as instances: grouped ones live in the emitter's space (its position,
    // rotation and scale), free and relative ones where they were let go (cocos2d's relative mode keeps
    // them in the emitter's parent, the level: Deprivation's opening fake player, a relative emitter
    // following the player, leaves its zigzag trail behind in GD)
    // GD's frame rate now (data.gdFps, its own counter over the reference run): it moves particles once a frame
    gdFps() {
      const f = this.data.gdFps;
      if (!f || !f.length) return GD_FPS;
      if (this.t <= f[0][0]) return f[0][1];
      for (let k = 1; k < f.length; k++)
        if (this.t <= f[k][0]) return f[k - 1][1] + (f[k][1] - f[k - 1][1]) * (this.t - f[k - 1][0]) / (f[k][0] - f[k - 1][0]);
      return f[f.length - 1][1];
    }

    // a particle object's emitter now, as GD sets up its system: where it is in the level and on the
    // screen (free particles reckon from the screen), and for one not grouped, the angle new particles
    // head at (its own less the object's turn; through the object's flips) and the scale their sizes,
    // spreads and speeds take (loadScaledDefaults). A grouped one turns and scales as a whole instead
    emitterState(i, sys, at, sv) {
      const p = sys.p, z = sv ? sv.zoom || 1 : 1;
      const st = { ex: at[0], ey: at[1], wx: sv ? (at[0] - sv.x) * z : at[0], wy: sv ? (at[1] - sv.y) * z : at[1],
                   angle: p.Angle || 0, k: 1, col: null, op: 1 };
      if ((p.PositionType | 0) !== 2) {
        st.k = Math.abs(this.data.objects[i][4] * this.skx[this.objSig[i]]);
        if (p.flipX || p.flipY) {
          const a = (p.Angle || 0) * DEG, vx = Math.cos(a) * (p.flipX ? -1 : 1), vy = Math.sin(a) * (p.flipY ? -1 : 1);
          const c = Math.cos(at[2]), s = Math.sin(at[2]);
          st.angle = Math.atan2(-vx * s + vy * c, vx * c + vy * s) / DEG;
        } else st.angle = (p.Angle || 0) - at[2] / DEG;
      }
      if (p.useObjColor) {   // (the object's colour and opacity, for new particles)
        st.col = this.spriteColor(i, this.channelColor(this.channel[i]), this.pulses.filter(q => q.group));
        let a = this.objAlpha[i];
        for (const g of this.objGroups[i]) { const ga = this.groupAlpha.get(g); if (ga !== undefined) a *= ga; }
        st.op = a;
      }
      return st;
    }

    // a particle object's particles (CCParticleSystemQuad): each a square its size across, turned by its
    // spin in whole degrees, where it is less how far the emitter has moved since it left (free ones:
    // on the screen; relative ones: in the level), about the emitter's place now; grouped ones turn and
    // scale with the object. Fades and the object's opacity scale the colour; adding light, GD leaves the
    // particle's own alpha out of the rgb (fades count twice, its alpha once)
    drawParticles(i, sys, x, y, rot, alpha, m, runs, own, add) {
      const p = sys.p, type = p.PositionType | 0, st = sys.upd;
      if (!st) return m;
      const uni = p.uniformColorMode ? own : null;   // uniform colour mode: the object's own colour, live
      const additive = (p.useObjColor || p.uniformObjColor ? add : p.isBlendAdditive) ? 1 : 0, sheet = this.sheet[i];
      let kx = 1, ky = 1, c = 1, s = 0, turn = 0;
      if (type === 2) {
        const o = this.data.objects[i], g = this.objSig[i];
        kx = o[4] * this.skx[g] * (p.flipX ? -1 : 1); ky = o[5] * this.sky[g] * (p.flipY ? -1 : 1);
        c = Math.cos(rot); s = Math.sin(rot); turn = rot;
      }
      for (const q of sys.parts) {
        const f = q.age < q.fadeIn ? q.age / q.fadeIn : q.ttl < q.fadeOut ? q.ttl / q.fadeOut : 1;
        const qa = unit(q.col[3]), a = alpha * f * (additive ? Math.sqrt(qa) : qa);
        if (a <= 0.003 || q.size <= 0) continue;
        let lx = q.x, ly = q.y;
        if (type === 0) { lx += q.ox - st.wx; ly += q.oy - st.wy; } else if (type === 1) { lx += q.ox - st.ex; ly += q.oy - st.ey; }
        lx *= kx; ly *= ky;
        const last = runs[runs.length - 1];
        if (!last || last[2] !== sheet || last[3] !== additive) runs.push([m, 0, sheet, additive]);
        runs[runs.length - 1][1]++;
        this.fPos[m * 4] = x + lx * c + ly * s; this.fPos[m * 4 + 1] = y - lx * s + ly * c;
        this.fPos[m * 4 + 2] = turn + (q.rot ? 360 - Math.trunc(360 - q.rot) : 0) * DEG; this.fPos[m * 4 + 3] = 0;
        this.fSize[m * 4] = q.size / 2 * Math.abs(kx); this.fSize[m * 4 + 1] = q.size / 2 * Math.abs(ky);
        this.fSize[m * 4 + 2] = 0; this.fSize[m * 4 + 3] = 0;
        this.fUV.set(this.staticUV.subarray(i * 4, i * 4 + 4), m * 4);
        const qc = uni || q.col;
        this.fColor[m * 4] = qc[0]; this.fColor[m * 4 + 1] = qc[1]; this.fColor[m * 4 + 2] = qc[2];
        this.fColor[m * 4 + 3] = a;
        this.fRotated[m * 2] = this.staticRot[i]; this.fRotated[m * 2 + 1] = 0;
        m++;
      }
      return m;
    }

    // channel colours now, with channel pulses applied. A channel that copies another follows what
    // its source shows, pulse included (as GD: a pulse on the background lights every copy of it)
    channelsNow() {
      const chanNow = new Map(), chanPulses = new Map();
      for (const p of this.pulses) if (!p.group) (chanPulses.get(p.target) || chanPulses.set(p.target, []).get(p.target)).push(p);
      const shown = (ch, depth = 0) => {
        if (chanNow.has(ch)) return chanNow.get(ch);
        const own = this.chan.get(ch) || (ch < 1000 ? null : this.chan.get(1004)) || [1, 1, 1, 1, 0];
        const cp = depth < 4 && this.copies.get(ch);
        let c = own;
        if (cp) { const src = applyHSV(shown(cp[0], depth + 1), cp[1]); c = [src[0], src[1], src[2], own[3], own[4]]; }
        for (const p of chanPulses.get(ch) || []) {
          const k = this.pulseIntensity(p), pc = this.pulseColor(p, c, k);
          c = [c[0] + (pc[0] - c[0]) * k, c[1] + (pc[1] - c[1]) * k, c[2] + (pc[2] - c[2]) * k, c[3], c[4]];
        }
        chanNow.set(ch, c);
        return c;
      };
      for (const ch of this.chan.keys()) shown(ch);
      for (const ch of chanPulses.keys()) shown(ch);
      return chanNow;
    }

    // GD 2.2's gradients (trigger 2903), as GD's own code builds them: each is a four-cornered shape at
    // the top of its layer. Its corners are the one object in each of four groups (or the group's
    // parent object): in vertex mode groups u, d, l, r are the bottom-left, bottom-right, top-left
    // and top-right corners, otherwise the top, bottom, left and right edges. A corner without an
    // object sits at the screen's. The colour runs from c1 to c2 along the trigger's rotation
    // (cocos2d's gradient, compressed), each with its channel's opacity times the trigger's groups'
    gradientShapes(cx, cy, hw, hh, chanNow) {
      const out = [], m = 10;   // missing corners sit a little past the screen's edges
      const x0 = cx - hw - m, x1 = cx + hw + m, y0 = cy - hh - m, y1 = cy + hh + m;
      const at = c => c === null || c === undefined ? null : Array.isArray(c) ? this.posOf(c[0], c[1], c[2]) : this.objPos(c);
      let seq = 0;
      for (const t of this.gradients.values()) {
        seq++;
        const p = (t.corners || []).map(at);
        const v = t.vertex ? [p[0] || [x0, y0], p[1] || [x1, y0], p[2] || [x0, y1], p[3] || [x1, y1]]
          : [[p[2] ? p[2][0] : x0, p[1] ? p[1][1] : y0], [p[3] ? p[3][0] : x1, p[1] ? p[1][1] : y0],
             [p[2] ? p[2][0] : x0, p[0] ? p[0][1] : y1], [p[3] ? p[3][0] : x1, p[0] ? p[0][1] : y1]];
        const xs = v.map(q => q[0]), ys = v.map(q => q[1]);
        if (Math.max(...xs) < cx - hw || Math.min(...xs) > cx + hw || Math.max(...ys) < cy - hh || Math.min(...ys) > cy + hh) continue;
        let ga = 1;
        for (const g of t.groups) { const a = this.groupAlpha.get(g); if (a !== undefined) ga *= a; }
        if (ga <= 0) continue;
        const col = (ch, hsv) => {
          const c = ch === 1010 ? [0, 0, 0, 1] : !ch || ch === 1011 ? [1, 1, 1, 1]
            : chanNow.get(ch) || (ch < 1000 ? null : chanNow.get(1004)) || [1, 1, 1, 1];
          const h = hsv ? applyHSV(c, hsv) : c;
          return [h[0], h[1], h[2], (c[3] ?? 1) * ga];
        };
        if (t.h1 === undefined) { t.h1 = t.hsvOn1 && t.hsv1 ? parseHSV(t.hsv1) : null; t.h2 = t.hsvOn2 && t.hsv2 ? parseHSV(t.hsv2) : null; }
        const S = col(t.c1 | 0, t.h1), E = col(t.c2 | 0, t.h2);
        if (S[3] <= 0 && E[3] <= 0) continue;
        if (t.blend === 1 && S[0] + S[1] + S[2] + E[0] + E[1] + E[2] === 0) continue;   // adding black shows nothing
        // the start colour's share at each corner: cocos2d's CCLayerGradient, vector (cos a, sin a)
        const a = -(t.rot || 0) * Math.PI / 180, ux0 = Math.cos(a), uy0 = Math.sin(a);
        const r2 = Math.SQRT2, k = r2 / (Math.abs(ux0) + Math.abs(uy0)), ux = ux0 * k, uy = uy0 * k;
        const share = [(r2 + ux + uy) / (2 * r2), (r2 - ux + uy) / (2 * r2), (r2 + ux - uy) / (2 * r2), (r2 - ux - uy) / (2 * r2)];
        const verts = new Float32Array(36);
        [0, 1, 2, 2, 1, 3].forEach((q, j) => {
          const w = share[q], o = j * 6;
          verts[o] = v[q][0]; verts[o + 1] = v[q][1];
          for (let c = 0; c < 4; c++) verts[o + 2 + c] = E[c] + (S[c] - E[c]) * w;
        });
        // GD's layer numbers: 1 BG, 2 middle ground, 3..7 B5..B1, 8 the player's, 9..12 T1..T4, 13+ above all
        const L = t.layer | 0;
        out.push({ gradient: true, layer: L >= 13 ? 99 : L >= 9 ? L - 4 : L === 8 ? 4.5 : L >= 3 ? L - 3 : -1,
                   seq, blend: t.blend | 0, verts });
      }
      return out.sort((a, b) => a.layer - b.layer || a.seq - b.seq);
    }

    drawGradient(g, cx, cy, hw, hh) {   // GD's blend modes: 0 alpha, 1 additive, 2 and 3 its own
      const gl = this.gl;
      gl.useProgram(this.gradProg);
      gl.bindVertexArray(this.gradVao);
      gl.uniform4f(this.uGrad.cam, cx, cy, hw, hh);
      gl.uniform1f(this.uGrad.premul, g.blend >= 2 ? 0 : 1);
      if (g.blend === 1) gl.blendFunc(gl.ONE, gl.ONE);
      else if (g.blend === 2) gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
      else if (g.blend === 3) gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_COLOR);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.gradBuf);
      gl.bufferData(gl.ARRAY_BUFFER, g.verts, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // sprite i's colour now, from its channel's (c): its own HSV, then the pulses on its groups
    // (draw passes per-frame helpers: pulsed, the signatures a group pulse reaches, and cache, each
    // channel's colour through each HSV adjustment)
    spriteColor(i, c, groupPulses, pulsed, cache) {
      let col = c;
      if (this.objHSV[i]) {
        if (!cache) col = applyHSV(c, this.objHSV[i]);
        else {
          const key = this.channel[i] * 65536 + this.hsvId[i];
          col = cache.get(key);
          if (!col) cache.set(key, col = applyHSV(c, this.objHSV[i]));
        }
      }
      if (pulsed && !pulsed[this.objSig[i]]) return col;
      const groups = this.objGroups[i];
      for (const p of groupPulses) {
        if (!groups.includes(p.target)) continue;
        if (this.detail[i] ? p.mainOnly : p.detailOnly) continue;   // (Main Only / Detail Only)
        const k = this.pulseIntensity(p), pc = this.pulseColor(p, col, k);
        col = [col[0] + (pc[0] - col[0]) * k, col[1] + (pc[1] - col[1]) * k, col[2] + (pc[2] - col[2]) * k];
      }
      return col;
    }

    // the colour the level shows most right now (Steam Glass tints its buttons with it): set wantTint
    // and the next draw tallies the sprites it draws by hue, in twelve 30-degree bins, each weighted by
    // its size, opacity and how vivid it is (saturation x brightness). tint is then the strongest hue's
    // average colour (with the bins beside it) and how much of the screen that lights, or null when
    // nothing on screen has a colour
    tallyTint(tally, col, m) {
      const r = col[0], g = col[1], b = col[2], mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
      if (mx < 0.12 || d < 0.12) return;
      let h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d;
      if (h < 0) h += 6;
      const w = Math.abs(this.fSize[m * 4] * this.fSize[m * 4 + 1]) * this.fColor[m * 4 + 3] * d * mx;
      const k = Math.min(11, Math.floor(h * 2)) * 4;
      tally[k] += w * r; tally[k + 1] += w * g; tally[k + 2] += w * b; tally[k + 3] += w;
    }

    finishTint(tally, hw, hh) {
      this.wantTint = false;
      let best = -1, score = 0;
      for (let k = 0; k < 12; k++) {
        const s = tally[k * 4 + 3] + 0.5 * (tally[((k + 11) % 12) * 4 + 3] + tally[((k + 1) % 12) * 4 + 3]);
        if (s > score) { score = s; best = k; }
      }
      if (best < 0) { this.tint = null; return; }
      let r = 0, g = 0, b = 0, w = 0;
      for (const k of [(best + 11) % 12, best, (best + 1) % 12]) {
        r += tally[k * 4]; g += tally[k * 4 + 1]; b += tally[k * 4 + 2]; w += tally[k * 4 + 3];
      }
      this.tint = { rgb: [r / w, g / w, b / w], cover: Math.min(1, w / (hw * hh)) };
    }

    draw() {
      const gl = this.gl, canvas = this.canvas;
      const W = canvas.width, H = canvas.height;
      const view = this.view || this.trackView(W / H) || { x: this.cam.x + this.cam.offX, y: this.cam.y + this.cam.offY, zoom: this.cam.zoom };
      let cx = view.x + (this.camOff ? this.camOff[0] : 0), cy = view.y + (this.camOff ? this.camOff[1] : 0);
      if (!this.view) { const [sx, sy] = this.shakeOffset(); cx += sx; cy += sy; }
      const hh = VIEW_H / 2 / (view.zoom || 1), hw = hh * W / H;
      this.viewAspect = W / H;   // (UI objects are laid out on this screen)
      const chanNow = this.channelsNow();
      const groupPulses = this.pulses.filter(p => p.group);
      // once a frame: the signatures switched on, those a group pulse reaches, colours through HSV
      const sigOn = new Uint8Array(this.sigGroups.length).fill(1), pulsed = new Uint8Array(this.sigGroups.length);
      for (const g of this.groupOff) { const ks = this.groupSigs.get(g); if (ks) for (const k of ks) sigOn[k] = 0; }
      for (const p of groupPulses) { const ks = this.groupSigs.get(p.target); if (ks) for (const k of ks) pulsed[k] = 1; }
      const hsvCache = new Map();
      const bg = chanNow.get(1000) || [0.16, 0.49, 1];
      // GD's shader layer: while any effect is on, the scene goes to a texture and through it
      const sh = this.shader;
      const sw = this.shockwave(cx, cy, hw, hh, view.zoom);
      const cgOn = !!sh.cg && (sh.cgRgb !== 0 || sh.cgStrength !== 0 || sh.cgLineStrength !== 0);
      const editColor = sh.cR !== 1 || sh.cG !== 1 || sh.cB !== 1 || sh.bR !== 0 || sh.bG !== 0 || sh.bB !== 0;
      const lens = this.lensUniforms(cx, cy, hw, hh, view.zoom || 1, W, H);
      const post = !this.noShaders && (Math.abs(sh.size) > 1e-4 || sh.gray > 0 || sh.sepia > 0 || sh.inv > 0 || editColor || sh.glitch > 0 || cgOn || !!sw || sh.hue % 360 !== 0 || lens.on);
      gl.bindFramebuffer(gl.FRAMEBUFFER, post ? this.sceneTarget(W, H).fb : null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.winW = 320 * W / H;   // GD's screen in points: always 320 high
      this.drawBackground(cx - hw, cy - hh, bg);
      // gather visible objects in draw order
      let m = 0;
      const runs = [];   // [start, count, sheet, additive]
      const tally = this.wantTint ? new Float64Array(48) : null;   // (tallyTint)
      let aboveFrom = false;
      const margin = 200;
      const near = this.nearby(cx - hw - margin, cx + hw + margin, cy - hh - margin, cy + hh + margin);
      // gradients go in among the objects at the top of their layers (the shader's cut where it falls)
      const grads = this.gradients.size ? this.gradientShapes(cx, cy, hw, hh, chanNow) : [];
      let gq = 0;
      const flushGradients = upTo => {
        while (gq < grads.length && grads[gq].layer < upTo) {
          const g = grads[gq++];
          if (post && !aboveFrom && g.layer > sh.top) { aboveFrom = true; runs.push(null); }
          runs.push(g);
        }
      };
      let playerDone = !this.player;
      const playerHere = () => {   // GD's player layer: after B1, before T1
        playerDone = true;
        flushGradients(5);
        if (post && !aboveFrom && !sh.playerIn) { aboveFrom = true; runs.push(null); }
        m = this.drawPlayer(m, runs);
      };
      for (let q = 0; q < near.length; q++) {
        const i = near[q];
        if (!playerDone && this.zLayer[i] >= 5) playerHere();
        const groups = this.objGroups[i];
        if (!sigOn[this.objSig[i]]) continue;
        if (this.only !== undefined && !groups.includes(this.only)) continue;   // debugging: one group alone
        if (this.onlyFrame && !this.data.objects[i][0].includes(this.onlyFrame)) continue;   // debugging: one sprite
        if (this.lowDetail && this.highDetail[i]) continue;   // GD's Low Detail Mode leaves these out
        if (this.hidden[i]) continue;
        const [x, y, rot] = this.objPos(i);
        const sys = this.systems.get(i);
        if (!sys && (x < cx - hw - margin || x > cx + hw + margin || y < cy - hh - margin || y > cy + hh + margin)) continue;
        let a = this.objAlpha[i];
        for (let k = 0; k < groups.length; k++) { const ga = this.groupAlpha.get(groups[k]); if (ga !== undefined) a *= ga; }
        if (this.sigFx[this.objSig[i]] & 1) { const ar = this.areaCache && this.areaCache.get(i); if (ar) a *= Math.max(0, ar.op); }   // area fade
        if (a <= 0.003) continue;
        // z layers above the shader's range come after its picture (a null in runs marks where)
        if (gq < grads.length) flushGradients(this.zLayer[i]);
        if (post && !aboveFrom && this.zLayer[i] > sh.top) { aboveFrom = true; runs.push(null); }
        if (sys) {
          const ch = this.channel[i], cc = chanNow.get(ch) || (ch < 1000 ? null : chanNow.get(1004)) || [1, 1, 1, 1, 0];
          const own = sys.p.uniformColorMode ? this.spriteColor(i, cc, groupPulses, pulsed, hsvCache) : null;
          m = this.drawParticles(i, sys, x, y, rot, a * (cc[3] ?? 1), m, runs, own, cc[4] || this.addAlways[i] ? 1 : 0);
          continue;
        }
        const ch = this.channel[i];
        const c = chanNow.get(ch) || (ch < 1000 ? null : chanNow.get(1004)) || [1, 1, 1, 1, 0];
        let col = this.spriteColor(i, c, groupPulses, pulsed, hsvCache);
        if (this.mark !== undefined && groups.includes(this.mark)) col = [1, 0, 0];   // debugging: tint one group
        const additive = c[4] || this.addAlways[i] ? 1 : 0, sheet = this.sheet[i];
        const last = runs[runs.length - 1];
        if (!last || last[2] !== sheet || last[3] !== additive) runs.push([m, 0, sheet, additive]);
        runs[runs.length - 1][1]++;
        this.fPos[m * 4] = x; this.fPos[m * 4 + 1] = y; this.fPos[m * 4 + 2] = rot; this.fPos[m * 4 + 3] = this.staticSolid[i];
        if (this.staticSolid[i] > 1.5) this.fAffine.set(this.staticAffine.subarray(i * 4, i * 4 + 4), m * 4);
        const an = this.anims.size && this.anims.get(i);
        if (an) {
          const j = Math.floor(this.t / an.t + an.p) % an.n;   // (p: its starting frame, from GD's own run)
          this.fSize.set(an.size.subarray(j * 4, j * 4 + 4), m * 4); this.fUV.set(an.uv.subarray(j * 4, j * 4 + 4), m * 4);
        } else {
          this.fSize.set(this.staticSize.subarray(i * 4, i * 4 + 4), m * 4);
          this.fUV.set(this.staticUV.subarray(i * 4, i * 4 + 4), m * 4);
        }
        if (this.audio.size && this.audio.has(i)) {
          const k = this.audioScale(i);
          for (let q = 0; q < 4; q++) this.fSize[m * 4 + q] *= k;
        }
        if (this.sigFx[this.objSig[i]] & 1) {   // area scale (GD multiplies the object's scale)
          const ar = this.areaCache && this.areaCache.get(i);   // (worked out by objPos above)
          if (ar && (ar.kx !== 1 || ar.ky !== 1)) {
            this.fSize[m * 4] *= ar.kx; this.fSize[m * 4 + 2] *= ar.kx; this.fSize[m * 4 + 1] *= ar.ky; this.fSize[m * 4 + 3] *= ar.ky;
          }
        }
        {   // scale triggers
          const kx = this.skx[this.objSig[i]], ky = this.sky[this.objSig[i]];
          if (kx !== 1 || ky !== 1) { this.fSize[m * 4] *= kx; this.fSize[m * 4 + 2] *= kx; this.fSize[m * 4 + 1] *= ky; this.fSize[m * 4 + 3] *= ky; }
        }
        this.fColor[m * 4] = col[0]; this.fColor[m * 4 + 1] = col[1]; this.fColor[m * 4 + 2] = col[2];
        this.fColor[m * 4 + 3] = a * (c[3] ?? 1);
        if (this.colorLog) this.colorLog.set(i, [col[0], col[1], col[2], a * (c[3] ?? 1), c[0], c[1], c[2]]);   // debugging: the colours drawn (and the channel's)
        if (tally) this.tallyTint(tally, col, m);
        this.fRotated[m * 2] = an ? an.rot[Math.floor(this.t / an.t + an.p) % an.n] : this.staticRot[i];
        this.fRotated[m * 2 + 1] = this.skew[i];
        m++;
      }
      if (!playerDone) playerHere();
      flushGradients(Infinity);
      if (tally) this.finishTint(tally, hw, hh);
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      const up = (attr, arr, size) => { gl.bindBuffer(gl.ARRAY_BUFFER, attr.buf); gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, m * size), gl.DYNAMIC_DRAW); };
      up(this.aPos, this.fPos, 4); up(this.aSize, this.fSize, 4); up(this.aUV, this.fUV, 4);
      up(this.aColor, this.fColor, 4); up(this.aRotated, this.fRotated, 2); up(this.aAffine, this.fAffine, 4);
      gl.activeTexture(gl.TEXTURE0);
      const drawRuns = list => {
        gl.useProgram(this.prog);
        gl.bindVertexArray(this.vao);
        gl.uniform4f(this.uCam, cx, cy, hw, hh);
        gl.uniform1i(this.uTex, 0);
        gl.enable(gl.BLEND);
        for (const run of list) {
          if (run.gradient) { this.drawGradient(run, cx, cy, hw, hh); gl.useProgram(this.prog); gl.bindVertexArray(this.vao); continue; }
          const [start, count, sheet, additive] = run;
          gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1f(this.uAdd, additive ? 1 : 0);
          gl.bindTexture(gl.TEXTURE_2D, this.textures[sheet].t);
          for (const attr of [this.aPos, this.aSize, this.aUV, this.aColor, this.aAffine]) {
            gl.bindBuffer(gl.ARRAY_BUFFER, attr.buf);
            gl.vertexAttribPointer(attr.l, 4, gl.FLOAT, false, 0, start * 16);
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, this.aRotated.buf);
          gl.vertexAttribPointer(this.aRotated.l, 2, gl.FLOAT, false, 0, start * 8);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        }
      };
      const cut = runs.indexOf(null);
      drawRuns(cut < 0 ? runs : runs.slice(0, cut));
      this.drawGround(this.t, cx - hw, chanNow);
      if (post) {   // the finished picture through GD's shader effects, onto the canvas
        const u = this.uBlur, clamp = v => sh.invClamp ? Math.min(v, 1) : v;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.disable(gl.BLEND);
        gl.useProgram(this.blurProg);
        gl.bindVertexArray(this.blurVao);
        gl.bindTexture(gl.TEXTURE_2D, this.target.tex);
        gl.uniform1i(u.scene, 0);
        gl.uniform2f(u.center, 0.5, 0.5);   // the screen's middle (no target group or offset here)
        gl.uniform1f(u.value, Math.abs(sh.size) > 1e-4 ? sh.size * 0.2 / 9 : 0);
        gl.uniform1f(u.fade, Math.min(Math.max(sh.fade * 0.2, 0), 0.2));
        gl.uniform1f(u.gray, sh.gray);
        gl.uniform1i(u.grayLum, sh.grayLum);
        gl.uniform3f(u.grayTint, 1, 1, 1);
        gl.uniform1f(u.sepia, sh.sepia);
        gl.uniform4f(u.inv, clamp(sh.inv * sh.invR), clamp(sh.inv * sh.invG), clamp(sh.inv * sh.invB), sh.inv);
        if (editColor) { gl.uniform3f(u.ccC, Math.max(sh.cR, 1e-4), sh.cG, sh.cB); gl.uniform3f(u.ccB, sh.bR, sh.bG, sh.bB); }
        else gl.uniform3f(u.ccC, 0, 0, 0);
        if (sh.glitch > 0) {   // GD's glitch: a new random slice and offsets speed x 20 times a second (its own noise
          // and seeds, read from the game); sizes from strength, the slice's height in screen heights
          const tq = Math.floor(sh.glitchSpeed * this.t * 20), A = W / H;
          const n = seed => { const v = Math.sin(Math.fround(tq * 12.9898 + seed * 4.1414)) * 43758.5453; return v - Math.floor(v); };
          const bot = n(2345), top = bot + n(9035) * sh.glitchSlice * sh.glitch, k = sh.glitch * 0.02 * SCREEN_K;
          gl.uniform4f(u.glitch, bot * A, (Math.floor(top) + top) * A, (n(9625) * 2 - 1) * sh.glitchX * k, n(9545));
          gl.uniform2f(u.glitchCol, (n(9545) * 2 - 1) * sh.glitchColX * k, (n(7205) * 2 - 1) * sh.glitchColY * k * A);
        } else gl.uniform4f(u.glitch, 0, 0, 0, 0);
        if (cgOn) {   // GD's uniforms, in screen widths: rgb offset rgb / 100 (or a hair when 0), strength / 50,
          // rows from 1 / height over the aspect; relative ones scale with the zoom
          const k = SCREEN_K * (sh.cgRel ? (view.zoom || 1) : 1), A = W / H;
          gl.uniform4f(u.cg, (sh.cgRgb ? sh.cgRgb * 0.1 : 0.001) * 0.1 * k, sh.cgStrength * 0.02 * k, sh.cgHeight / (k * A),
                       (cy - hh) / (2 * hh));   // its rows stay put in the level as the camera rises
          gl.uniform3f(u.cgLine, sh.cgLineStrength ? Math.max(0.001, 1 - k * sh.cgLineThick * 0.02) : 0, sh.cgLineStrength * 0.05, sh.cgTime);
        } else gl.uniform4f(u.cg, 0, 0, 0, 0);
        const ha = sh.hue * Math.PI / 180;
        if (sh.hue % 360 !== 0) gl.uniform2f(u.hue, Math.cos(ha), Math.sin(ha)); else gl.uniform2f(u.hue, 0, 0);
        if (sw) { gl.uniform4fv(u.sw, sw.sw); gl.uniform4fv(u.swT, sw.swT); gl.uniform4fv(u.swC, sw.swC); gl.uniform2fv(u.swMisc, sw.misc); }
        else gl.uniform4f(u.sw, 0, 0, 0, 0);
        gl.uniform1f(u.aspect, H / W);
        gl.uniform4fv(u.bulge, lens.bulge); gl.uniform2fv(u.bulgeC, lens.bulgeC);
        gl.uniform4fv(u.pinch, lens.pinch); gl.uniform4fv(u.pinchC, lens.pinchC);
        gl.uniform2fv(u.chrom, lens.chrom); gl.uniform4fv(u.px, lens.px); gl.uniform1f(u.pxHard, sh.pxHard);
        gl.uniform4fv(u.mb, lens.mb); gl.uniform1f(u.mbDual, lens.mbDual);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (cut >= 0) drawRuns(runs.slice(cut + 1));   // the layers above the effects, as they are
      }
      this.drawn = m;
    }
  }

  window.GDScene = GDScene;
})();
