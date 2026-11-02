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
  const SHAKE_SCALE = 0.5;    // units of offset per unit of shake strength (matched to the recording)
  const SHAKE_SETTLE = 0.12;  // seconds a shake takes to ease back to rest
  const PORTAL_REACH = 35;    // units short of a speed portal's centre where it takes the player (matched to GD's timing)
  const TOUCH_REACH = 30;     // the same for touch-activated triggers: the player's 30-unit box meets the trigger's

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
      case 4: { const p = 0.3 * 1.5; if (t === 0 || t === 1) return t; t = t * 2 - 1;
        return t < 0 ? -0.5 * pow(2, 10 * t) * Math.sin((t - p / 4) * 2 * PI / p)
                     : pow(2, -10 * t) * Math.sin((t - p / 4) * 2 * PI / p) * 0.5 + 1; }
      case 5: return 1 - elasticOut(1 - t, 0.3);
      case 6: return elasticOut(t, 0.3);
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
  function applyHSV(c, h) {
    if (!h) return c;
    let [hh, s, v] = rgb2hsv(c[0], c[1], c[2]);
    hh = (hh + h[0] + 360) % 360;
    s = Math.min(1, Math.max(0, h[3] ? s + h[1] : s * h[1]));
    v = Math.min(1, Math.max(0, h[4] ? v + h[2] : v * h[2]));
    return hsv2rgb(hh, s, v);
  }

  // ------------------------------------------------------------------ particles
  // GD's custom particle objects are cocos2d particle systems with GD's extras (fade in/out).
  // p holds cocos2d::ParticleStruct fields by name (missing = 0).
  function makeRandom(seed) {   // mulberry32: seeking replays the same particles
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  class Emitter {
    constructor(p, rnd) { this.p = p; this.rnd = rnd; this.parts = []; this.counter = 0; }

    // one new particle; origin = the emitter's world position, for free-moving particles
    spawn(origin) {
      const p = this.p, r = () => this.rnd() * 2 - 1, v = k => (p[k] || 0) + (p[k + "Var"] || 0) * r();
      const life = Math.max(0, v("Life"));
      const q = { ttl: life, life, x: (p.PosVarX || 0) * r(), y: (p.PosVarY || 0) * r(),
                  ox: origin ? origin[0] : 0, oy: origin ? origin[1] : 0,
                  fadeIn: Math.max(0, v("FadeInTime")), fadeOut: Math.max(0, v("FadeOutTime")) };
      const col = (pre, sync) => {
        const c = [], k = r();
        for (const ch of ["R", "G", "B", "A"]) {
          const u = sync && ch !== "A" ? k : r();
          c.push(Math.min(1, Math.max(0, (p[pre + ch] || 0) + (p[pre + "Var" + ch] || 0) * u)));
        }
        return c;
      };
      q.col = col("StartColor", p.startRGBVarSync);
      const end = col("EndColor", p.endRGBVarSync);
      q.dcol = end.map((e, k) => life ? (e - q.col[k]) / life : 0);
      q.size = Math.max(0, v("StartSize"));
      const endSize = p.startSizeEqualToEndSize ? q.size : Math.max(0, v("EndSize"));
      q.dsize = life ? (endSize - q.size) / life : 0;
      q.rot = v("StartSpin");
      const endRot = p.startSpinEqualToEndSpin ? q.rot : v("EndSpin");
      q.drot = life ? (endRot - q.rot) / life : 0;
      const a = v("Angle") * Math.PI / 180;
      if ((p.EmitterMode | 0) === 1) {   // radius mode: circles out from the centre
        q.radius = v("StartRadius");
        const endRadius = p.startRadiusEqualToEndRadius ? q.radius : v("EndRadius");
        q.dradius = life ? (endRadius - q.radius) / life : 0;
        q.angle = a; q.spin = v("RotatePerSecond") * Math.PI / 180;
      } else {   // gravity mode
        const speed = v("Speed");
        q.dx = Math.cos(a) * speed; q.dy = Math.sin(a) * speed;
        q.radial = v("RadialAccel"); q.tangential = v("TangentialAccel");
        if (p.rotationIsDir) q.rot = -Math.atan2(q.dy, q.dx) * 180 / Math.PI;
      }
      this.parts.push(q);
    }

    step(dt, origin) {
      const p = this.p;
      const rate = p.EmissionRate > 0 ? 1 / p.EmissionRate : Infinity, total = p.TotalParticles | 0;
      if (this.parts.length < total) this.counter += dt;
      while (this.parts.length < total && this.counter > rate) { this.spawn(origin); this.counter -= rate; }
      const radiusMode = (p.EmitterMode | 0) === 1, gx = p.GravityX || 0, gy = p.GravityY || 0;
      this.parts = this.parts.filter(q => {
        q.ttl -= dt;
        if (q.ttl <= 0) return false;
        if (radiusMode) {
          q.angle += q.spin * dt; q.radius += q.dradius * dt;
          q.x = -Math.cos(q.angle) * q.radius; q.y = -Math.sin(q.angle) * q.radius;
        } else {
          const len = Math.hypot(q.x, q.y), rx = len ? q.x / len : 0, ry = len ? q.y / len : 0;
          q.dx += (rx * q.radial - ry * q.tangential + gx) * dt;
          q.dy += (ry * q.radial + rx * q.tangential + gy) * dt;
          q.x += q.dx * dt; q.y += q.dy * dt;
          if (p.dynamicRotationIsDir) q.rot = -Math.atan2(q.dy, q.dx) * 180 / Math.PI;
        }
        for (let k = 0; k < 4; k++) q.col[k] += q.dcol[k] * dt;
        q.size = Math.max(0, q.size + q.dsize * dt);
        q.rot += q.drot * dt;
        return true;
      });
    }

    // GD's fade in / fade out on top of the colour's own alpha
    alpha(q) {
      const age = q.life - q.ttl;
      let a = Math.min(1, Math.max(0, q.col[3]));
      if (q.fadeIn > 0 && age < q.fadeIn) a *= age / q.fadeIn;
      if (q.fadeOut > 0 && q.ttl < q.fadeOut) a *= q.ttl / q.fadeOut;
      return a;
    }
  }

  // ------------------------------------------------------------------ WebGL renderer
  const VS = `#version 300 es
    in vec2 corner;                 // -0.5..0.5 quad corner
    in vec4 posRot;                 // world x, y, rotation (rad, clockwise), solid (1: firm edges)
    in vec4 size;                   // half-extents w, h (world units, signed for flips), sprite offset x, y
    in vec4 uv;                     // u0, v0, u1, v1
    in vec4 color;                  // rgba (premultiplied in the fragment shader)
    in float rotated;               // the frame is stored rotated 90 degrees in its sheet
    in vec4 affine;                 // with posRot.w = 2: the quad's corners are posRot.xy + mat2(affine) * corner
    uniform vec4 cam;               // centre x, y, half view width, half view height
    out vec2 vUV; out vec4 vColor; out float vSolid;
    void main() {
      vec2 local = corner * 2.0 * size.xy + size.zw;
      float c = cos(posRot.z), s = sin(posRot.z);
      if (posRot.w > 1.5) local = mat2(affine.xy, affine.zw) * corner;   // a free shape (its turn comes on top)
      vec2 world = posRot.xy + vec2(local.x * c + local.y * s, -local.x * s + local.y * c);
      gl_Position = vec4((world - cam.xy) / cam.zw, 0.0, 1.0);
      vec2 t = corner + 0.5;          // 0..1 across the sprite, y up
      vec2 st = rotated > 0.5 ? t.yx : vec2(t.x, 1.0 - t.y);   // cocos2d: a rotated frame's bottom-left is its sheet rect's top-left
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
  const BLUR_FS = `#version 300 es
    precision highp float;
    in vec2 vUV;
    uniform sampler2D scene;
    uniform vec2 center;
    uniform float value, fade, gray, sepia;
    uniform bool grayLum;
    uniform vec3 grayTint, ccC, ccB;
    uniform vec4 inv;               // invert amount per channel, amount
    out vec4 frag;
    void main() {
      vec4 c = texture(scene, vUV);
      if (value != 0.0) {
        vec2 uv = vUV, stepTo = (center - vUV) * value;
        float w = 1.0 + 4.5 * fade;
        c *= w;
        for (int i = 1; i < 10; i++) { w -= fade; uv += stepTo; c += texture(scene, uv) * w; }
        c *= 0.1;
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
      if (ccC.r > 0.0) c.rgb = c.rgb * ccC + ccB;
      frag = c;
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // textures GD draws in code: "gd:radial" = a radial gradient, opaque centre to clear edge
  // (made the size of its frame, which spans the whole texture)
  function makeTexture(name, size = 256) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
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
      for (const i of this.data.highDetail || []) this.highDetail[i] = 1;
      for (let i = 0; i < n; i++) {
        if (objects[i][12]) this.emitters.set(i, objects[i][12]);
        const [frame, x, y, rot, sx, sy, , , ch, hsv, groups, op] = objects[i];
        const f = frames[frame];
        const [sh, fx, fy, fw, fh, rotated, ox, oy] = f;
        const tex = this.textures[sh];
        this.baseX[i] = x; this.baseY[i] = y; this.baseRot[i] = rot * Math.PI / 180;
        this.sheet[i] = sh; this.channel[i] = ch; this.objHSV[i] = parseHSV(hsv); this.objGroups[i] = groups; this.objAlpha[i] = op;
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
          const k = an.f.length, a = { n: k, t: an.t, size: new Float32Array(k * 4), uv: new Float32Array(k * 4), rot: new Uint8Array(k) };
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
      for (const t of trig) t.at = t.x - (t.type === "speed" ? PORTAL_REACH : t.mode === "touch" ? TOUCH_REACH : 0);
      this.xTriggers = trig.filter(t => t.mode !== "spawn" && !passive.has(t.type)).sort((a, b) => a.at - b.at);
      this.colBlocks = trig.filter(t => t.type === "colblock");
      this.groupTriggers = new Map();
      for (const t of trig) for (const g of t.groups) {
        if (!this.groupTriggers.has(g)) this.groupTriggers.set(g, []);
        this.groupTriggers.get(g).push(t);
      }
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
      // trigger targets, no spin, no particles) sit in columns of CELL units by x; the rest are
      // checked every frame
      const movers = new Set(trig.filter(t => t.type === "move" || t.type === "rotate").map(t => t.target));
      const cols = new Map(), dynamic = [];
      for (let i = 0; i < n; i++) {
        if (this.spin[i] || this.emitters.has(i) || this.objGroups[i].some(g => movers.has(g))) { dynamic.push(i); continue; }
        const c = Math.floor(this.baseX[i] / CELL);
        (cols.get(c) || cols.set(c, []).get(c)).push(i);
      }
      this.columns = new Map([...cols].map(([c, list]) => [c, Int32Array.from(list)]));
      this.dynamic = Int32Array.from(dynamic);
    }

    // the objects worth checking for a view from x0 to x1, in draw order
    nearby(x0, x1) {
      const parts = [this.dynamic];
      let total = this.dynamic.length;
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
      this.aColor = inst("color", 4); this.aRotated = inst("rotated", 1); this.aAffine = inst("affine", 4);
      // per-frame arrays, filled with the visible objects in draw order
      let cap = n;   // objects plus every emitter's particles
      for (const p of this.emitters.values()) cap += p.TotalParticles | 0;
      this.fPos = new Float32Array(cap * 4); this.fSize = new Float32Array(cap * 4); this.fUV = new Float32Array(cap * 4);
      this.fColor = new Float32Array(cap * 4); this.fRotated = new Float32Array(cap); this.fAffine = new Float32Array(cap * 4);
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
      this.uBlur = ["scene", "center", "value", "fade", "gray", "grayLum", "grayTint", "sepia", "inv", "ccC", "ccB"]
        .reduce((o, k) => (o[k] = gl.getUniformLocation(bp, k), o), {});
      this.target = null;   // {fb, tex, w, h}, made when first needed
      const fp = this.flatProg = gl.createProgram();
      gl.attachShader(fp, compile(gl, gl.VERTEX_SHADER, FLAT_VS));
      gl.attachShader(fp, compile(gl, gl.FRAGMENT_SHADER, FLAT_FS));
      gl.linkProgram(fp);
      if (!gl.getProgramParameter(fp, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(fp));
      this.uFlat = ["rect", "uvRect", "tex", "color", "add"].reduce((o, k) => (o[k] = gl.getUniformLocation(fp, k), o), {});
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
      this.playerX = this.startX || 0;   // where the player starts (GD's spawn point)
      this.speed = KA4_TO_SPEED[this.data.speed | 0] ?? 1;
      this.nextX = 0;   // index into xTriggers
      this.queue = [];   // [time, group] spawn activations waiting
      this.queued = new Set();
      this.actions = [];   // running moves/rotates/alpha/colour transitions/pulses
      this.groupDX = new Map(); this.groupDY = new Map(); this.groupAlpha = new Map(); this.groupOff = new Set();
      this.groupRot = new Map();   // group -> {angle, cx, cy, lock}
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
      // GD's shader layer state (its GJShaderState): radial blur size and fade, grayscale, sepia,
      // invert (amount, per channel rgb, clamped), edit colour (rgb * c + b)
      this.shader = { size: 0, fade: 1, gray: 0, grayLum: 0, sepia: 0, inv: 0, invR: 1, invG: 1, invB: 1, invClamp: 0,
                      cR: 1, cG: 1, cB: 1, bR: 0, bG: 0, bB: 0,
                      top: 8 };   // the highest z layer the effects cover (higher ones are drawn on top)
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
      let x = this.baseX[i], y = this.baseY[i], rot = this.baseRot[i];
      const groups = this.objGroups[i];
      for (let k = 0; k < groups.length; k++) {
        const g = groups[k];
        x += this.groupDX.get(g) || 0;
        y += this.groupDY.get(g) || 0;
      }
      // turning in place (its own spin, and rotate triggers that turn each object about itself):
      // a piece of an object swings round the object's centre with it
      let own = this.spin[i] ? this.spin[i] * Math.max(0, this.t - this.spinFrom(i)) : 0;
      let selfA = 0;
      for (let k = 0; k < groups.length; k++) { const r = this.groupRot.get(groups[k]); if (r && r.angle && r.self) selfA += r.angle; }
      own += selfA;
      const k = this.audio.size ? this.audioScale(i) : 1;   // music scaling swells the whole object about its centre
      if (own || k !== 1) {
        const a = own * Math.PI / 180, ox = this.partX[i], oy = this.partY[i];
        if (ox || oy) {
          const c = Math.cos(a), s = Math.sin(a);
          x += (ox * c + oy * s) * k - ox; y += (-ox * s + oy * c) * k - oy;
        }
        rot += a;
      }
      for (let k = 0; k < groups.length; k++) {
        const r = this.groupRot.get(groups[k]);
        if (r && r.angle) {
          if (r.self) continue;   // done above
          const [px, py] = this.pivot(r.cg);
          const a = -r.angle * Math.PI / 180, dx = x - px, dy = y - py;
          x = px + dx * Math.cos(a) - dy * Math.sin(a);
          y = py + dx * Math.sin(a) + dy * Math.cos(a);
          if (!r.lock) rot += r.angle * Math.PI / 180;
        }
      }
      return [x, y, rot];
    }

    // touch-activated triggers need the player to run into them: without a simulated player,
    // one counts as touched when it's within the camera's height (where the player is), so
    // logic parked far above or below the course stays quiet
    touchable(t) {
      const v = this.trackView(16 / 9);
      if (!v) return true;
      return Math.abs(t.y - v.y) <= VIEW_H / 2 / (v.zoom || 1) + 30;
    }

    // a rotation's pivot: where the centre group's objects are now, moves included (not rotations)
    pivot(cg) {
      const objs = this.groupObjects.get(cg);
      if (!objs || !objs.length) return [0, 0];
      let sx = 0, sy = 0;
      for (const i of objs) {
        let x = this.baseX[i], y = this.baseY[i];
        for (const g of this.objGroups[i]) { x += this.groupDX.get(g) || 0; y += this.groupDY.get(g) || 0; }
        sx += x; sy += y;
      }
      return [sx / objs.length, sy / objs.length];
    }

    // "Activate Group" on logic triggers: switch the group on and run its triggers
    activate(g, on = true) {
      if (!on) { this.groupOff.add(g); return; }
      this.groupOff.delete(g);
      this.queue.push([this.t, g, this.srcGroups || []]);
    }

    posOf(x, y, groups) {
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

    groupEnabled(groups) {
      for (let k = 0; k < groups.length; k++) if (this.groupOff.has(groups[k])) return false;
      return true;
    }

    // ---------------------------------------------------------------- triggers
    fire(t, at = this.t) {   // at: when it fires (a spawn's exact due time, inside the current step)
      if (!this.groupEnabled(t.groups)) return;
      const now = at, nActions = this.actions.length, nPulses = this.pulses.length;
      this.srcGroups = t.groups;
      this.fireKind(t, now);
      for (let k = nActions; k < this.actions.length; k++) this.actions[k].src = t.groups;
      for (let k = nPulses; k < this.pulses.length; k++) this.pulses[k].src = t.groups;
      this.srcGroups = null;
    }

    fireKind(t, now) {
      switch (t.type) {
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
          if (g) this.queue.push([now, g, t.groups]);
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
        case "spawn": {   // a group is called at most once per moment (loops would otherwise multiply)
          const due = now + (t.delay || 0), key = t.target + "@" + Math.round(due * 240);
          if (!this.queued.has(key)) { this.queued.add(key); this.queue.push([due, t.target, t.groups]); }
          break;
        }
        case "toggle": if (t.on) this.groupOff.delete(t.target); else this.groupOff.add(t.target); break;
        case "move":
          this.actions.push({ kind: "move", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate,
                              g: t.target, dx: t.dx || 0, dy: t.dy || 0, lockX: t.lockX, done: 0 }); break;
        case "rotate": {
          // with no centre group, or the target as its own centre, every object turns about itself;
          // otherwise about the centre group's live position (it may be moving)
          const cg = t.center || t.target;
          const r = this.groupRot.get(t.target) || { angle: 0, cg, lock: !!t.lockRot };
          r.cg = cg; r.self = cg === t.target;
          this.groupRot.set(t.target, r);
          this.actions.push({ kind: "rotate", t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, r,
                              total: (t.deg || 0) + 360 * (t.turns || 0), done: 0 });
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
          if (t.hsvMode) col = { copy: t.copy || 0, hsv: parseHSV(t.hsv) };
          this.pulses.push({ t0: now, fin: t.fin || 0, hold: t.hold || 0, fout: t.fout || 0, group: !!t.group,
                             target: t.target, col });
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
        case "shaderlayers": {   // GD's layer scale: 3..7 = B5..B1, 8 = the player's, 9..12 = T1..T4, 13+ = all
          const v = t.max | 0;   // (a minimum above the bottom layer isn't supported: Nullscapes doesn't use one)
          this.shader.top = v >= 13 ? 8 : v >= 9 ? v - 4 : v >= 3 ? Math.min(v, 7) - 3 : v === 0 ? 4 : -1;
          break;
        }
        case "radialblur": case "grayscale": case "sepia": case "invert": case "editcolor": {
          // shader triggers ease their effect's settings from where they are (a new one of a kind
          // replaces a running one); switches take effect at once
          const sh = this.shader, to = {};
          if (t.type === "radialblur") { to.size = t.size || 0; sh.fade = t.fade ?? 1; }
          else if (t.type === "grayscale") { to.gray = t.value || 0; sh.grayLum = t.useLum ? 1 : 0; }
          else if (t.type === "sepia") to.sepia = t.value || 0;
          else if (t.type === "invert") {
            to.inv = t.value || 0; sh.invClamp = t.clamp ? 1 : 0;
            if (t.editRGB) { to.invR = t.r || 0; to.invG = t.g || 0; to.invB = t.b || 0; }
          } else Object.assign(to, { cR: t.cr ?? 1, cG: t.cg ?? 1, cB: t.cb ?? 1, bR: t.br || 0, bG: t.bg || 0, bB: t.bb || 0 });
          this.actions = this.actions.filter(a => !(a.kind === "shader" && a.of === t.type));
          const from = {};
          for (const k in to) from[k] = sh[k];
          this.actions.push({ kind: "shader", of: t.type, t0: now, dur: t.dur || 0, ease: t.ease, rate: t.rate, from, to });
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

    step(dt) {
      const prevX = this.playerX;
      this.t += dt;
      const tracked = this.data.playerFromCamera && this.trackX(this.t);
      // with a recorded camera that follows the player (data.playerFromCamera), the player is where
      // the camera says, a fixed distance ahead of its left edge; otherwise it runs at its speed
      this.playerX = tracked !== null && tracked !== false ? Math.max(prevX, tracked) : this.playerX + SPEED_UNITS[this.speed] * dt;
      // x-activated triggers the player passed
      while (this.nextX < this.xTriggers.length && this.xTriggers[this.nextX].at <= this.playerX) {
        const t = this.xTriggers[this.nextX++];
        if (t.mode !== "touch" || this.touchable(t)) this.fire(t);
      }
      // spawn activations that are due
      // (in time order, each at its own due time, and calls those make with no delay run in this
      // same step: a spawn loop keeps GD's period instead of losing a step every lap)
      if (this.queue.length) {
        if (this.queued.size > 50000) this.queued.clear();
        const firedNow = new Set();   // each trigger fires once per step, however many calls reach it
        for (let round = 0; round < 16; round++) {
          const due = this.queue.filter(q => q[0] <= this.t).sort((a, b) => a[0] - b[0]);
          if (!due.length) break;
          this.queue = this.queue.filter(q => q[0] > this.t);
          for (const [at, g] of due) for (const t of this.groupTriggers.get(g) || []) {
            // a call only runs the group's spawn-triggered triggers: ones the player sets off by
            // passing them (often a loop's kick-off) don't fire again
            if (t.mode !== "spawn") continue;
            if (!firedNow.has(t.id)) { firedNow.add(t.id); this.fire(t, at); }
          }
        }
      }
      if (this.listeners.length) this.checkCollisions();
      for (const [i, sys] of this.systems) {   // particles keep running while their object is switched on
        if (this.objGroups[i].length && !this.groupEnabled(this.objGroups[i])) continue;
        sys.step(dt, sys.p.PositionType ? null : this.objPos(i));
      }
      const pdx = this.playerX - prevX;
      // running actions
      this.actions = this.actions.filter(a => {
        const u = a.dur > 0 ? Math.min(1, (this.t - a.t0) / a.dur) : 1;
        switch (a.kind) {
          case "move": {
            if (a.lockX) {
              this.groupDX.set(a.g, (this.groupDX.get(a.g) || 0) + pdx);   // rides along with the player
              return u < 1;
            }
            const e = ease(a.ease, a.rate, u);
            const ddone = e - a.done; a.done = e;
            this.groupDX.set(a.g, (this.groupDX.get(a.g) || 0) + a.dx * ddone);
            this.groupDY.set(a.g, (this.groupDY.get(a.g) || 0) + a.dy * ddone);
            return u < 1;
          }
          case "rotate": {
            const e = ease(a.ease, a.rate, u);
            a.r.angle += a.total * (e - a.done); a.done = e;
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

    trackX(t) {   // where the player is by the recorded camera (its x at level start sets the distance)
      const tr = this.track;
      if (!tr || !tr.length) return null;
      let lo = 0, hi = tr.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tr[mid][0] <= t) lo = mid; else hi = mid; }
      const a = tr[lo], b = tr[hi], u = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
      return a[2] + (b[2] - a[2]) * u + (this.startX || 0) - tr[0][2];
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

    pulseColor(p, base) {
      if (Array.isArray(p.col)) return p.col;
      return applyHSV(p.col.copy ? this.channelColor(p.col.copy) : base, p.col.hsv);
    }

    // ---------------------------------------------------------------- drawing
    // an emitter's particles as instances: grouped/relative ones live in the emitter's space
    // (its position, rotation and scale), free ones where they were let go
    drawParticles(i, sys, x, y, rot, alpha, m, runs) {
      const o = this.data.objects[i], sx = o[4], sy = o[5], c = Math.cos(rot), s = Math.sin(rot);
      const additive = sys.p.isBlendAdditive ? 1 : 0, sheet = this.sheet[i], free = !sys.p.PositionType;
      for (const q of sys.parts) {
        const a = sys.alpha(q) * alpha;
        if (a <= 0.003 || q.size <= 0) continue;
        const lx = q.x * sx, ly = q.y * sy;
        const bx = free ? q.ox : x, by = free ? q.oy : y;
        const last = runs[runs.length - 1];
        if (!last || last[2] !== sheet || last[3] !== additive) runs.push([m, 0, sheet, additive]);
        runs[runs.length - 1][1]++;
        this.fPos[m * 4] = bx + lx * c + ly * s; this.fPos[m * 4 + 1] = by - lx * s + ly * c;
        this.fPos[m * 4 + 2] = rot + q.rot * Math.PI / 180; this.fPos[m * 4 + 3] = 0;
        this.fSize[m * 4] = q.size / 2 * Math.abs(sx); this.fSize[m * 4 + 1] = q.size / 2 * Math.abs(sy);
        this.fSize[m * 4 + 2] = 0; this.fSize[m * 4 + 3] = 0;
        this.fUV.set(this.staticUV.subarray(i * 4, i * 4 + 4), m * 4);
        this.fColor[m * 4] = q.col[0]; this.fColor[m * 4 + 1] = q.col[1]; this.fColor[m * 4 + 2] = q.col[2];
        this.fColor[m * 4 + 3] = a;
        this.fRotated[m] = this.staticRot[i];
        m++;
      }
      return m;
    }

    draw() {
      const gl = this.gl, canvas = this.canvas;
      const W = canvas.width, H = canvas.height;
      const view = this.view || this.trackView(W / H) || { x: this.cam.x + this.cam.offX, y: this.cam.y + this.cam.offY, zoom: this.cam.zoom };
      let cx = view.x + (this.camOff ? this.camOff[0] : 0), cy = view.y + (this.camOff ? this.camOff[1] : 0);
      if (!this.view) { const [sx, sy] = this.shakeOffset(); cx += sx; cy += sy; }
      const hh = VIEW_H / 2 / (view.zoom || 1), hw = hh * W / H;
      // channel colours with channel pulses applied. A channel that copies another follows what
      // its source shows, pulse included (as GD: a pulse on the background lights every copy of it)
      const chanNow = new Map(), chanPulses = new Map();
      for (const p of this.pulses) if (!p.group) (chanPulses.get(p.target) || chanPulses.set(p.target, []).get(p.target)).push(p);
      const shown = (ch, depth = 0) => {
        if (chanNow.has(ch)) return chanNow.get(ch);
        const own = this.chan.get(ch) || (ch < 1000 ? null : this.chan.get(1004)) || [1, 1, 1, 1, 0];
        const cp = depth < 4 && this.copies.get(ch);
        let c = own;
        if (cp) { const src = applyHSV(shown(cp[0], depth + 1), cp[1]); c = [src[0], src[1], src[2], own[3], own[4]]; }
        for (const p of chanPulses.get(ch) || []) {
          const k = this.pulseIntensity(p), pc = this.pulseColor(p, c);
          c = [c[0] + (pc[0] - c[0]) * k, c[1] + (pc[1] - c[1]) * k, c[2] + (pc[2] - c[2]) * k, c[3], c[4]];
        }
        chanNow.set(ch, c);
        return c;
      };
      for (const ch of this.chan.keys()) shown(ch);
      for (const ch of chanPulses.keys()) shown(ch);
      const groupPulses = this.pulses.filter(p => p.group);
      const bg = chanNow.get(1000) || [0.16, 0.49, 1];
      // GD's shader layer: while any effect is on, the scene goes to a texture and through it
      const sh = this.shader;
      const editColor = sh.cR !== 1 || sh.cG !== 1 || sh.cB !== 1 || sh.bR !== 0 || sh.bG !== 0 || sh.bB !== 0;
      const post = !this.noShaders && (Math.abs(sh.size) > 1e-4 || sh.gray > 0 || sh.sepia > 0 || sh.inv > 0 || editColor);
      gl.bindFramebuffer(gl.FRAMEBUFFER, post ? this.sceneTarget(W, H).fb : null);
      gl.viewport(0, 0, W, H);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.winW = 320 * W / H;   // GD's screen in points: always 320 high
      this.drawBackground(cx - hw, cy - hh, bg);
      // gather visible objects in draw order
      let m = 0;
      const runs = [];   // [start, count, sheet, additive]
      let aboveFrom = false;
      const margin = 200;
      const near = this.nearby(cx - hw - margin, cx + hw + margin);
      for (let q = 0; q < near.length; q++) {
        const i = near[q];
        const groups = this.objGroups[i];
        if (groups.length && !this.groupEnabled(groups)) continue;
        if (this.only !== undefined && !groups.includes(this.only)) continue;   // debugging: one group alone
        if (this.onlyFrame && !this.data.objects[i][0].includes(this.onlyFrame)) continue;   // debugging: one sprite
        if (this.lowDetail && this.highDetail[i]) continue;   // GD's Low Detail Mode leaves these out
        const [x, y, rot] = this.objPos(i);
        const sys = this.systems.get(i);
        if (!sys && (x < cx - hw - margin || x > cx + hw + margin || y < cy - hh - margin || y > cy + hh + margin)) continue;
        let a = this.objAlpha[i];
        for (let k = 0; k < groups.length; k++) { const ga = this.groupAlpha.get(groups[k]); if (ga !== undefined) a *= ga; }
        if (a <= 0.003) continue;
        // z layers above the shader's range come after its picture (a null in runs marks where)
        if (post && !aboveFrom && this.zLayer[i] > sh.top) { aboveFrom = true; runs.push(null); }
        if (sys) { m = this.drawParticles(i, sys, x, y, rot, a, m, runs); continue; }
        const ch = this.channel[i];
        const c = chanNow.get(ch) || (ch < 1000 ? null : chanNow.get(1004)) || [1, 1, 1, 1, 0];
        let col = this.objHSV[i] ? applyHSV(c, this.objHSV[i]) : c;
        for (const p of groupPulses) {
          if (!groups.includes(p.target)) continue;
          const k = this.pulseIntensity(p), pc = this.pulseColor(p, col);
          col = [col[0] + (pc[0] - col[0]) * k, col[1] + (pc[1] - col[1]) * k, col[2] + (pc[2] - col[2]) * k];
        }
        if (this.mark !== undefined && groups.includes(this.mark)) col = [1, 0, 0];   // debugging: tint one group
        const additive = c[4] || this.addAlways[i] ? 1 : 0, sheet = this.sheet[i];
        const last = runs[runs.length - 1];
        if (!last || last[2] !== sheet || last[3] !== additive) runs.push([m, 0, sheet, additive]);
        runs[runs.length - 1][1]++;
        this.fPos[m * 4] = x; this.fPos[m * 4 + 1] = y; this.fPos[m * 4 + 2] = rot; this.fPos[m * 4 + 3] = this.staticSolid[i];
        if (this.staticSolid[i] > 1.5) this.fAffine.set(this.staticAffine.subarray(i * 4, i * 4 + 4), m * 4);
        const an = this.anims.size && this.anims.get(i);
        if (an) {
          const j = Math.floor(this.t / an.t) % an.n;
          this.fSize.set(an.size.subarray(j * 4, j * 4 + 4), m * 4); this.fUV.set(an.uv.subarray(j * 4, j * 4 + 4), m * 4);
        } else {
          this.fSize.set(this.staticSize.subarray(i * 4, i * 4 + 4), m * 4);
          this.fUV.set(this.staticUV.subarray(i * 4, i * 4 + 4), m * 4);
        }
        if (this.audio.size && this.audio.has(i)) {
          const k = this.audioScale(i);
          for (let q = 0; q < 4; q++) this.fSize[m * 4 + q] *= k;
        }
        this.fColor[m * 4] = col[0]; this.fColor[m * 4 + 1] = col[1]; this.fColor[m * 4 + 2] = col[2];
        this.fColor[m * 4 + 3] = a * (c[3] ?? 1);
        if (this.colorLog) this.colorLog.set(i, [col[0], col[1], col[2], a * (c[3] ?? 1), c[0], c[1], c[2]]);   // debugging: the colours drawn (and the channel's)
        this.fRotated[m] = an ? an.rot[Math.floor(this.t / an.t) % an.n] : this.staticRot[i];
        m++;
      }
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      const up = (attr, arr, size) => { gl.bindBuffer(gl.ARRAY_BUFFER, attr.buf); gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, m * size), gl.DYNAMIC_DRAW); };
      up(this.aPos, this.fPos, 4); up(this.aSize, this.fSize, 4); up(this.aUV, this.fUV, 4);
      up(this.aColor, this.fColor, 4); up(this.aRotated, this.fRotated, 1); up(this.aAffine, this.fAffine, 4);
      gl.activeTexture(gl.TEXTURE0);
      const drawRuns = list => {
        gl.useProgram(this.prog);
        gl.bindVertexArray(this.vao);
        gl.uniform4f(this.uCam, cx, cy, hw, hh);
        gl.uniform1i(this.uTex, 0);
        gl.enable(gl.BLEND);
        for (const [start, count, sheet, additive] of list) {
          gl.blendFunc(gl.ONE, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1f(this.uAdd, additive ? 1 : 0);
          gl.bindTexture(gl.TEXTURE_2D, this.textures[sheet].t);
          for (const attr of [this.aPos, this.aSize, this.aUV, this.aColor, this.aAffine]) {
            gl.bindBuffer(gl.ARRAY_BUFFER, attr.buf);
            gl.vertexAttribPointer(attr.l, 4, gl.FLOAT, false, 0, start * 16);
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, this.aRotated.buf);
          gl.vertexAttribPointer(this.aRotated.l, 1, gl.FLOAT, false, 0, start * 4);
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
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (cut >= 0) drawRuns(runs.slice(cut + 1));   // the layers above the effects, as they are
      }
      this.drawn = m;
    }
  }

  window.GDScene = GDScene;
})();
