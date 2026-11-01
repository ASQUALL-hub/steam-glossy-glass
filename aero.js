/* Glossy Glass for Steam: the "Frutiger Aero" glass.

   A sunny lakeside panorama behind the window's contents, in the glossy style
   of Windows Vista / 7 era wallpapers: a deep blue sky with billowing cumulus
   and thin high wisps, misty blue mountains, a slender glass city in the haze,
   meadows with wind turbines, a forested cliff with a waterfall, and a wide lake
   that mirrors all of it in rippling reflections with the sun glittering on it,
   behind tall dewy grass and daisies. Soap bubbles float up and the sun throws a
   lens flare.

   The view pans slowly to the right forever. Each band of the scene is drawn
   once as a tile that repeats exactly every lap (its shapes are laid out on a
   loop), and nearer bands slide faster than far ones. The clouds also blow along
   with the wind, the turbines turn, the waterfall pours and the reflections
   ripple. Everything is drawn in code. The layout (lake, meadows, the waterfall's
   hill) is fixed, but each time the scene loads it picks its own clouds, trees,
   towers, grass and flowers from a random seed, and starts somewhere new on the
   loop. A resize keeps the same scene.

   Or a picture: when the Steam Glass helper sets window.__ggAeroImage (a data
   URL of a wide landscape) before this runs, that picture is the panorama
   instead. Its right end is faded over its left end so the lap has no seam
   (a narrow picture laps as itself then its mirror image instead), and the
   bubbles still float over it.

   Runs once per window; loading it again replaces the running copy. */
(() => {
  if (window.__ggAero) window.__ggAero.stop();
  if (window.__ggLiquid) window.__ggLiquid.stop();
  document.querySelectorAll("canvas[id^='gg-aero']").forEach(c => c.remove());   // strays from older copies

  const LAP = 2600;   // one lap of the panorama at a 900px tall window, in CSS px
  const PAN = 14;     // how fast the grass in front slides by, px/s at 900px tall
  const FPS = 30;     // plenty for a slow pan; Steam draws canvases on the CPU
  const RES = 0.85;   // drawn at this fraction of full resolution: a little soft, it sits behind glass
  const FRIENDS = !!document.querySelector(".friendsui-container");
  const TAU = Math.PI * 2;
  // this load's scene: its own seed and its own place on the loop (the preview page can pin both)
  const SEED = window.__ggAeroSeed ?? (Math.random() * 2 ** 31 | 0);
  const START = window.__ggAeroSkip ?? Math.random() * 4000;   // seconds into the pan

  let seed = 0;
  const rnd = () => {   // mulberry32: the same scene every time
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const rr = (a, b) => a + (b - a) * rnd();
  const canvas2d = (w, h) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
    return c;
  };
  const smooth = u => u * u * (3 - 2 * u);

  // fractal value noise in tile pixels, repeating every `period` px across (so a
  // textured tile still joins up at the lap), on cells `cell` px wide at its coarsest
  function makeNoise(period, cell, octaves = 4, stretch = 1) {
    const octs = [];
    for (let o = 0; o < octaves; o++) {
      const cs = cell / 2 ** o, gx = Math.max(2, Math.round(period / cs)), gy = 97;
      const grid = new Float32Array(gx * gy);
      for (let i = 0; i < grid.length; i++) grid[i] = rnd() * 2 - 1;
      octs.push({ gx, gy, kx: gx / period, ky: stretch / cs, grid, amp: 0.55 ** o });
    }
    const norm = octs.reduce((a, o) => a + o.amp, 0);
    return (x, y) => {
      let v = 0;
      for (const o of octs) {
        const fx = x * o.kx, fy = y * o.ky, ix = Math.floor(fx), iy = Math.floor(fy);
        const ux = smooth(fx - ix), uy = smooth(fy - iy);
        const x0 = (ix % o.gx + o.gx) % o.gx, x1 = (x0 + 1) % o.gx, y0 = (iy % o.gy + o.gy) % o.gy, y1 = (y0 + 1) % o.gy;
        const g = o.grid, a = g[y0 * o.gx + x0], b = g[y0 * o.gx + x1], c = g[y1 * o.gx + x0], d = g[y1 * o.gx + x1];
        v += o.amp * ((a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy);
      }
      return v / norm;
    };
  }
  // darken and lighten a canvas's painted pixels by noise: grain, patches, rock, foliage
  function grain(cv, amount, noise) {
    const c = cv.getContext("2d"), img = c.getImageData(0, 0, cv.width, cv.height), d = img.data, w = cv.width;
    for (let y = 0, i = 0; y < cv.height; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        if (d[i + 3] === 0) continue;
        const k = 1 + amount * noise(x, y);
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      }
    }
    c.putImageData(img, 0, 0);
  }

  // soap bubbles drifting up through the scene
  function floaters(W, H, s) {
    const bubble = (() => {
      const r = 64, cv = canvas2d(2 * r, 2 * r), c = cv.getContext("2d");
      const body = c.createRadialGradient(r, r, 0, r, r, r);
      body.addColorStop(0, "rgba(255,255,255,0.02)"); body.addColorStop(0.78, "rgba(200,240,255,0.10)");
      body.addColorStop(0.93, "rgba(255,255,255,0.45)"); body.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = body; c.beginPath(); c.arc(r, r, r, 0, TAU); c.fill();
      const rim = c.createLinearGradient(0, 0, 2 * r, 2 * r);   // a little rainbow film
      rim.addColorStop(0, "rgba(140,220,255,0.45)"); rim.addColorStop(0.5, "rgba(255,180,240,0.25)");
      rim.addColorStop(1, "rgba(180,255,190,0.4)");
      c.strokeStyle = rim; c.lineWidth = 2.5; c.beginPath(); c.arc(r, r, r - 2, 0, TAU); c.stroke();
      c.fillStyle = "rgba(255,255,255,0.85)";
      c.beginPath(); c.ellipse(r * 0.62, r * 0.55, r * 0.22, r * 0.12, -0.7, 0, TAU); c.fill();
      c.fillStyle = "rgba(255,255,255,0.35)";
      c.beginPath(); c.arc(r * 1.4, r * 1.42, r * 0.07, 0, TAU); c.fill();
      return cv;
    })();
    const bubbles = Array.from({ length: FRIENDS ? 6 : 12 }, () => ({
      x: rnd() * W, y: rnd() * H, r: rr(7, 26) * s, up: rr(9, 22) * s, sway: rr(8, 22) * s, phase: rr(0, TAU),
    }));
    return { bubbles, bubble };
  }

  // --- a picture as the panorama: scaled to cover the window with room to pan,
  // and its right end faded over its left so one lap joins up without a seam
  const BLEND = 0.18;   // share of the picture's width used for the join
  function buildPicture(W, H, img) {
    const s = H / 900, q = (window.devicePixelRatio || 1) * RES;
    if (img.width * H / img.height < 1.6 * W) {
      // a picture too narrow to pan on its own: lap it as the picture then its mirror image,
      // which meet exactly at both joins, rather than zooming it in a long way
      const w = Math.round(img.width * H / img.height), lap = 2 * w;
      const tile = canvas2d(lap * q, H * q), c = tile.getContext("2d");
      c.scale(q, q);
      c.drawImage(img, 0, 0, w, H);
      c.translate(lap, 0);
      c.scale(-1, 1);
      c.drawImage(img, 0, 0, w, H);
      seed = SEED;
      return { W, H, s, lap, layers: [{ cv: tile, y0: 0, h: H, speed: 0.8 }], ...floaters(W, H, s) };
    }
    const k = Math.max(H / img.height, 1.25 * W / (img.width * (1 - BLEND)));
    const w = Math.round(img.width * k), h = Math.round(img.height * k), y0 = Math.round((H - h) / 2);
    const blend = Math.round(w * BLEND), lap = w - blend;
    const tile = canvas2d(lap * q, h * q), c = tile.getContext("2d");
    c.scale(q, q);
    c.drawImage(img, 0, 0, w, h);
    const strip = canvas2d(blend * q, h * q), sc = strip.getContext("2d");
    sc.scale(q, q);
    sc.drawImage(img, -lap, 0, w, h);             // the picture's last `blend` px...
    sc.globalCompositeOperation = "destination-in";
    const fade = sc.createLinearGradient(0, 0, blend, 0);
    fade.addColorStop(0, "rgba(0,0,0,1)"); fade.addColorStop(1, "rgba(0,0,0,0)");
    sc.fillStyle = fade; sc.fillRect(0, 0, blend, h);
    c.drawImage(strip, 0, 0, blend, h);           // ...fading out over its first ones
    seed = SEED;
    return { W, H, s, lap, layers: [{ cv: tile, y0, h, speed: 0.8 }], ...floaters(W, H, s) };
  }

  // --- the drawn scene, built for one window size: s scales everything to the height
  function build(W, H) {
    if (picture) return buildPicture(W, H, picture);
    seed = SEED;
    const s = H / 900, lap = Math.round(LAP * s), hz = Math.round(0.47 * H);   // hz: the far shore of the lake
    const q = (window.devicePixelRatio || 1) * RES;                           // tile resolution, same as the canvas
    const sun = { x: W * 0.74, y: H * 0.12 };
    // a curve that repeats exactly every lap
    const wave = terms => x => terms.reduce((y, [a, k, p]) => y + a * Math.sin(TAU * k * x / lap + p), 0);
    // draw something at x, and again one lap over where it hangs off either end
    const wrapped = (x, half, draw) => {
      draw(x);
      if (x - half < 0) draw(x + lap);
      if (x + half > lap) draw(x - lap);
    };
    // a value that eases between keyframes [x as a share of the lap, value] around the loop
    const loopKeys = keys => x => {
      const u = ((x / lap) % 1 + 1) % 1;
      let i = keys.findIndex(k => k[0] > u);
      if (i < 0) i = keys.length;
      const a = keys[(i - 1 + keys.length) % keys.length], b = keys[i % keys.length];
      const span = ((b[0] - a[0]) % 1 + 1) % 1 || 1, t = (((u - a[0]) % 1 + 1) % 1) / span;
      return a[1] + (b[1] - a[1]) * smooth(Math.min(1, t));
    };
    const layers = [];
    const band = (y0, h, speed, paint, extra) => {   // one horizontal band of the scene, as a repeating tile
      const cv = canvas2d(lap * q, h * q), c = cv.getContext("2d");
      c.scale(q, q);
      c.translate(0, -y0);
      paint(c);
      const layer = Object.assign({ cv, y0, h, speed }, extra);
      layers.push(layer);
      return layer;
    };

    // ---------------------------------------------------------------- sky (doesn't move)
    const sky = canvas2d(W * q, hz * q + 2), sc = sky.getContext("2d");
    sc.scale(q, q);
    const g = sc.createLinearGradient(0, 0, 0, hz);
    g.addColorStop(0, "#0447c9"); g.addColorStop(0.3, "#1278ea"); g.addColorStop(0.62, "#4fb0fb");
    g.addColorStop(0.86, "#a8dcff"); g.addColorStop(1, "#e6f7ff");
    sc.fillStyle = g; sc.fillRect(0, 0, W, hz + 2);
    let glow = sc.createRadialGradient(sun.x, sun.y, 0, sun.x, sun.y, 0.7 * H);
    glow.addColorStop(0, "rgba(255,255,255,1)"); glow.addColorStop(0.04, "rgba(255,255,250,1)");
    glow.addColorStop(0.1, "rgba(255,252,235,0.75)"); glow.addColorStop(0.3, "rgba(200,235,255,0.32)");
    glow.addColorStop(1, "rgba(200,235,255,0)");
    sc.fillStyle = glow; sc.fillRect(0, 0, W, hz + 2);

    // ---------------------------------------------------------------- clouds
    // a cumulus: soft overlapping puffs, a blue-grey body lit white where the sun
    // (up and to the right) catches the tops, and a flat, shaded base
    const cumulus = (w, h) => {
      const pad = 40, cv = canvas2d(w + 2 * pad, h + 2 * pad), c = cv.getContext("2d");
      c.translate(pad, pad);
      const base = h * 0.92, puffs = [];
      for (let i = 0, n = Math.round(40 + w / 4); i < n; i++) {   // many small puffs: a billowing edge
        const u = rnd(), dome = Math.sin(Math.PI * (0.04 + 0.92 * u)) ** 0.8;
        const r = (0.06 + 0.15 * dome) * h * rr(0.55, 1.2);
        const x = w * (0.05 + 0.9 * u), y = base - r * 0.55 - rnd() ** 0.7 * dome * (h * 0.9 - r);
        puffs.push({ x, y, r });
      }
      puffs.sort((a, b) => b.y - a.y);
      for (const p of puffs) {   // body in shade
        const b = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        b.addColorStop(0, "rgba(148,170,204,1)"); b.addColorStop(0.65, "rgba(170,190,220,0.95)");
        b.addColorStop(1, "rgba(190,208,230,0)");
        c.fillStyle = b; c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill();
      }
      for (const p of puffs) {   // sunlit tops
        const lx = p.x + p.r * 0.28, ly = p.y - p.r * 0.36, lr = p.r * 0.8;
        const l = c.createRadialGradient(lx, ly, 0, lx, ly, lr);
        l.addColorStop(0, "rgba(255,255,255,1)"); l.addColorStop(0.55, "rgba(252,254,255,0.85)");
        l.addColorStop(1, "rgba(250,252,255,0)");
        c.fillStyle = l; c.beginPath(); c.arc(lx, ly, lr, 0, TAU); c.fill();
      }
      c.globalCompositeOperation = "source-atop";   // shade toward the base
      const sh = c.createLinearGradient(0, base - h * 0.45, 0, base);
      sh.addColorStop(0, "rgba(120,150,190,0)"); sh.addColorStop(1, "rgba(118,146,186,0.42)");
      c.fillStyle = sh; c.fillRect(-pad, -pad, w + 2 * pad, h + 2 * pad);
      c.globalCompositeOperation = "destination-out";   // a flat bottom that fades out
      const cut = c.createLinearGradient(0, base - h * 0.06, 0, base + h * 0.04);
      cut.addColorStop(0, "rgba(0,0,0,0)"); cut.addColorStop(1, "rgba(0,0,0,1)");
      c.fillStyle = cut; c.fillRect(-pad, base - h * 0.06, w + 2 * pad, h + pad);
      return cv;
    };
    const cloudBand = (y0, h, n, size, tall, speed, wind, alpha, mirror) => band(y0, h, speed, c => {
      c.filter = `blur(${Math.max(0.4, 0.6 * s)}px)`;
      for (let i = 0; i < n; i++) {
        const w = size * rr(0.55, 1.4) * s, ch = Math.min(h * 0.95, w * tall * rr(0.7, 1.3)), sprite = cumulus(w, ch);
        const x = (i + rr(0.15, 0.85)) * lap / n, y = y0 + (h - ch) * rr(0.15, 1);
        c.globalAlpha = alpha * rr(0.85, 1);
        wrapped(x, w / 2 + 40, xx => c.drawImage(sprite, xx - w / 2 - 40, y - 40));
      }
      c.filter = "none";
    }, { wind: wind * s, mirror });
    band(0.03 * H, 0.32 * H, 0.02, c => {   // thin wisps high up
      c.filter = `blur(${3 * s}px)`;
      for (let i = 0; i < 46; i++) {
        const x = rnd() * lap, y = rr(0.05, 0.3) * H, rx = rr(50, 170) * s, ry = rr(1.5, 5) * s;
        c.fillStyle = `rgba(255,255,255,${rr(0.12, 0.32)})`;
        wrapped(x, rx, xx => { c.beginPath(); c.ellipse(xx, y, rx, ry, rr(-0.08, 0.08), 0, TAU); c.fill(); });
      }
      c.filter = "none";
    }, { wind: 3 * s });
    const tw = Math.ceil(lap * q);   // a tile's width in pixels: the noise repeats on it
    cloudBand(hz - 0.2 * H, 0.2 * H, 8, 220, 0.4, 0.04, 5, 0.9, true);   // low clouds along the horizon
    cloudBand(0.02 * H, 0.52 * H, 5, 500, 0.6, 0.07, 10, 1, true);       // big towering ones

    // ---------------------------------------------------------------- mountains
    const range = (top, keys, speed, colTop, colBottom, haze, shade) => band(hz - top - 10 * s, top + 14 * s, speed, c => {
      const ridge = wave(keys), at = x => hz - top * 0.62 + ridge(x);
      c.beginPath(); c.moveTo(0, hz + 4 * s);
      for (let x = 0; x <= lap; x += 2) c.lineTo(x, at(x));
      c.lineTo(lap, hz + 4 * s); c.closePath();
      const fill = c.createLinearGradient(0, hz - top, 0, hz);
      fill.addColorStop(0, colTop); fill.addColorStop(1, colBottom);
      c.fillStyle = fill; c.fill();
      c.save(); c.clip();
      c.filter = `blur(${6 * s}px)`;   // slopes facing the sun lit, the others in shade, softly
      for (let x = 0; x < lap; x += 6) {
        const slope = (at(x + 6) - at(x)) / 6, fall = c.createLinearGradient(0, at(x), 0, hz);
        const col = slope < 0 ? `255,255,255,${Math.min(0.3, -slope * shade)}` : `16,48,92,${Math.min(0.22, slope * shade * 0.7)}`;
        fall.addColorStop(0, `rgba(${col})`); fall.addColorStop(1, "rgba(0,0,0,0)");
        c.fillStyle = fall; c.fillRect(x, at(x), 6.5, hz - at(x));
      }
      c.filter = "none";
      const mist = c.createLinearGradient(0, hz - top * 0.5, 0, hz + 2 * s);
      mist.addColorStop(0, "rgba(225,243,255,0)"); mist.addColorStop(1, `rgba(225,243,255,${haze})`);
      c.fillStyle = mist; c.fillRect(0, hz - top, lap, top + 6 * s);
      c.restore();
    }, { mirror: true });
    grain(range(0.2 * H, [[0.06 * H, 2, 0.9], [0.032 * H, 5, 2.6], [0.014 * H, 11, 0.3], [0.006 * H, 23, 1.7], [0.003 * H, 47, 0.6]],
          0.025, "#6f9fcf", "#c7e2f6", 0.85, 0.5).cv, 0.1, makeNoise(tw, 40 * q, 5));

    // the glass city, far off in the haze between the ranges
    band(hz - 0.24 * H, 0.24 * H + 2 * s, 0.04, c => {
      for (const [cx, spread, count, tall] of [[0.47, 0.035, 26, 0.2], [0.53, 0.012, 6, 0.11]]) {
        for (let i = 0; i < count; i++) {
          const u = rr(-1, 1), x = (cx + u * spread) * lap, w = rr(5, 13) * s;
          const h = (tall * Math.exp(-2.5 * u * u) * rr(0.35, 1) + 0.02) * H;
          wrapped(x, w, xx => {
            const left = xx - w / 2, top = hz - h;
            c.beginPath();
            if (rnd() < 0.35) { c.moveTo(left, hz); c.lineTo(left, top + w); c.lineTo(xx, top - w * 0.6); c.lineTo(left + w, top + w); c.lineTo(left + w, hz); }
            else if (rnd() < 0.4) { c.moveTo(left, hz); c.lineTo(left, top + w / 2); c.arc(xx, top + w / 2, w / 2, Math.PI, 0); c.lineTo(left + w, hz); }
            else c.rect(left, top, w, h);
            const glass = c.createLinearGradient(left, 0, left + w, 0);
            glass.addColorStop(0, "rgba(176,212,240,0.95)"); glass.addColorStop(0.6, "rgba(232,246,255,0.95)");
            glass.addColorStop(1, "rgba(255,255,255,0.95)");
            c.fillStyle = glass; c.fill();
            c.fillStyle = "rgba(255,255,255,0.7)";   // the sun on one edge
            c.fillRect(left + w * 0.72, top + w, Math.max(0.8, w * 0.12), h - w);
          });
        }
      }
      const mist = c.createLinearGradient(0, hz - 0.14 * H, 0, hz);
      mist.addColorStop(0, "rgba(220,240,255,0.15)"); mist.addColorStop(1, "rgba(225,243,255,0.8)");
      c.fillStyle = mist; c.fillRect(0, hz - 0.24 * H, lap, 0.24 * H + 2 * s);
    }, { mirror: true });

    grain(range(0.12 * H, [[0.035 * H, 3, 4.1], [0.02 * H, 7, 1.2], [0.008 * H, 15, 2.2], [0.004 * H, 31, 0.4]],
          0.05, "#4f9a86", "#a9d4c8", 0.75, 0.6).cv, 0.16, makeNoise(tw, 22 * q, 5));

    // ---------------------------------------------------------------- shores
    // meadows with turbines, open water, a forested cliff with a waterfall, wooded shore
    const top = loopKeys([[0, 0.045], [0.08, 0.08], [0.18, 0.055], [0.27, 0.02], [0.33, 0.008], [0.5, 0.01],
                          [0.56, 0.06], [0.62, 0.17], [0.74, 0.18], [0.8, 0.12], [0.86, 0.03], [0.94, 0.035]]);
    const foot = loopKeys([[0, 0.03], [0.08, 0.042], [0.2, 0.035], [0.3, 0.012], [0.5, 0.008], [0.58, 0.03],
                           [0.66, 0.05], [0.8, 0.045], [0.88, 0.024]]);
    const jag = wave([[0.004 * H, 37, 0.3], [0.002 * H, 71, 2]]);
    const landTop = x => hz - top(x) * H + jag(x), landFoot = x => hz + foot(x) * H;
    const cliffAt = x => { const u = ((x / lap) % 1 + 1) % 1; return u > 0.585 && u < 0.81; };
    // the gorge the waterfall has cut: bare rock, widening toward the foot, with a ragged edge
    const ragged = wave([[0.006, 29, 1.1], [0.004, 53, 0.2], [0.003, 97, 2.4]]);
    const gorgeHalf = y => {   // half its width at height y, as a share of the lap
      const depth = Math.max(0, Math.min(1, (y - (hz - 0.17 * H)) / (0.22 * H)));
      return 0.024 + 0.026 * depth + ragged(0.69 * lap + 7 * y);
    };
    const gorge = (x, y) => Math.abs(((x / lap) % 1 + 1) % 1 - 0.69) < gorgeHalf(y);
    const falls = { x: 0.69 * lap, w: 34 * s };
    falls.top = hz - 0.165 * H; falls.foot = landFoot(falls.x);
    const turbines = [];
    {   // streaks of white water, lit on one side, repeating every texH so it can scroll forever
      const texW = Math.ceil(falls.w * 1.5), texH = Math.ceil(0.22 * H);
      const tex = canvas2d(texW * q, texH * q), tc = tex.getContext("2d");
      tc.scale(q, q);
      for (let i = 0; i < 420; i++) {
        const x = rnd() * texW, y = rnd() * texH, len = rr(8, 46) * s, w = rr(0.6, 2.6) * s;
        const bright = rnd(), g = tc.createLinearGradient(0, y, 0, y + len);
        const col = bright < 0.7 ? "255,255,255" : "170,215,245";
        g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.3, `rgba(${col},${rr(0.35, 0.9)})`); g.addColorStop(1, `rgba(${col},0)`);
        tc.fillStyle = g;
        for (const dy of [0, -texH, texH]) tc.fillRect(x, y + dy, w, len);
      }
      falls.tex = tex; falls.texW = texW; falls.texH = texH;
    }
    const shore = band(hz - 0.22 * H, 0.3 * H, 0.16, c => {
      c.beginPath(); c.moveTo(0, landFoot(0));
      for (let x = 0; x <= lap; x += 2) c.lineTo(x, landTop(x));
      for (let x = lap; x >= 0; x -= 2) c.lineTo(x, landFoot(x));
      c.closePath();
      const field = c.createLinearGradient(0, hz - 0.12 * H, 0, hz + 0.05 * H);
      field.addColorStop(0, "#b5e45c"); field.addColorStop(0.5, "#7cc843"); field.addColorStop(1, "#3f8f32");
      c.fillStyle = field; c.fill();
      c.save(); c.clip();
      // the cliff: a rock face with seams, its top and foot hidden in trees
      {   // deep woods on the hill, so gaps between the trees read as forest, not meadow
        const floor = c.createLinearGradient(0.585 * lap, 0, 0.81 * lap, 0);
        floor.addColorStop(0, "rgba(38,92,40,0)"); floor.addColorStop(0.12, "rgba(38,92,40,0.95)");
        floor.addColorStop(0.88, "rgba(44,100,42,0.95)"); floor.addColorStop(1, "rgba(44,100,42,0)");
        c.fillStyle = floor; c.fillRect(0.585 * lap, hz - 0.2 * H, 0.225 * lap, 0.3 * H);
      }
      {   // the gorge: a ragged channel of rock, widening toward the foot
        const gx = 0.69 * lap, y0 = falls.top - 8 * s, y1 = landFoot(gx) + 2 * s, edge = [];
        for (let y = y0; y <= y1; y += 3) edge.push([y, gorgeHalf(y) * lap]);
        c.beginPath();
        edge.forEach(([y, h], i) => i ? c.lineTo(gx - h, y) : c.moveTo(gx - h, y));
        for (let i = edge.length - 1; i >= 0; i--) c.lineTo(gx + edge[i][1], edge[i][0]);
        c.closePath();
        const rock = c.createLinearGradient(gx - 0.05 * lap, 0, gx + 0.05 * lap, 0);   // shaded left, sunlit right
        rock.addColorStop(0, "#55665e"); rock.addColorStop(0.45, "#76887e"); rock.addColorStop(1, "#a3b3a6");
        c.fillStyle = rock; c.fill();
      }
      for (let i = 0; i < 520; i++) {   // rock: angular slabs, lit on top, with dark cracks
        const x = rr(0.635, 0.745) * lap, y = rr(landTop(x) + 8 * s, landFoot(x)), w = rr(4, 16) * s, h = rr(2, 8) * s;
        const tone = rr(0, 1);
        c.fillStyle = tone < 0.45 ? `rgba(58,72,66,${rr(0.15, 0.35)})` : `rgba(200,212,200,${rr(0.1, 0.28)})`;
        c.beginPath();
        c.moveTo(x, y); c.lineTo(x + w, y + rr(-2, 2) * s); c.lineTo(x + w * rr(0.7, 1), y + h); c.lineTo(x + w * rr(0, 0.3), y + h * rr(0.6, 1));
        c.fill();
      }
      for (let i = 0; i < 160; i++) {   // moss and ferns clinging to ledges
        const x = rr(0.635, 0.745) * lap, y = rr(landTop(x) + 6 * s, landFoot(x)), r = rr(1.5, 5) * s;
        c.fillStyle = `rgba(${rr(50, 90)},${rr(120, 160)},${rr(50, 70)},${rr(0.4, 0.75)})`;
        c.beginPath(); c.ellipse(x, y, r * 1.6, r * 0.7, 0, 0, TAU); c.fill();
      }
      // sun on the fields: a soft light band over each crest
      const sheen = c.createLinearGradient(0, hz - 0.1 * H, 0, hz + 0.02 * H);
      sheen.addColorStop(0, "rgba(255,255,200,0.25)"); sheen.addColorStop(1, "rgba(255,255,200,0)");
      c.fillStyle = sheen; c.fillRect(0, hz - 0.2 * H, lap, 0.22 * H);
      c.restore();
      // where land meets water: a dark wet edge, then a thin bright line of light on the water
      c.lineJoin = "round";
      for (const [col, w, dy] of [["rgba(20,55,35,0.35)", 3 * s, -1.5 * s], ["rgba(255,255,255,0.55)", 1.1 * s, 0.6 * s]]) {
        c.strokeStyle = col; c.lineWidth = w;
        c.beginPath();
        for (let x = 0; x <= lap; x += 3) x ? c.lineTo(x, landFoot(x) + dy) : c.moveTo(x, landFoot(x) + dy);
        c.stroke();
      }
      // trees: crowns of leafy lumps, in shade underneath and lit up and to the right, in
      // dense clumps along the crests, the shoreline and over the cliff
      const crowns = [];
      const tree = (x, y, r) => crowns.push({ x, y, r, hue: rr(-12, 12), lumps: Array.from({ length: 6 + Math.floor(rnd() * 5) }, () =>
        [rr(-0.75, 0.75) * r, rr(-1, 0.25) * r, rr(0.35, 0.65) * r]) });
      for (let i = 0; i < 2600; i++) {
        const x = rnd() * lap, cl = cliffAt(x), t = top(x);
        if (t < 0.015 && rnd() < 0.6) continue;
        const atCrest = rnd() < (cl ? 0.75 : 0.45);
        const y = atCrest ? landTop(x) + rr(0, 0.018) * H : landFoot(x) - rr(0, 0.014) * H;
        tree(x, y, rr(2.2, cl ? 7 : 5.5) * s * (0.6 + t * 4));
      }
      for (let i = 0; i < 1500; i++) {   // the hillside around the gorge is wooded all the way down
        const x = rr(0.585, 0.81) * lap, y = rr(landTop(x) + 4 * s, landFoot(x) - 2 * s);
        if (gorge(x, y)) continue;
        tree(x, y, rr(3, 7.5) * s);
      }
      for (const [pass, k, ox, oy] of [[0, 1, -0.1, 0.18], [1, 0.8, 0.08, -0.08], [2, 0.42, 0.3, -0.36]]) {
        for (const t of crowns) {
          c.fillStyle = pass === 0 ? `hsl(${118 + t.hue}, 48%, 20%)`
                      : pass === 1 ? `hsl(${108 + t.hue}, 52%, ${30 + (t.hue + 12) * 0.3}%)`
                      : `hsla(${88 + t.hue}, 62%, 58%, 0.85)`;
          wrapped(t.x, t.r * 3, xx => {
            c.beginPath();
            for (const [dx, dy, lr] of t.lumps) {
              if (pass === 2 && dy > -0.2 * t.r) continue;   // only the tops catch the sun
              c.moveTo(xx + dx + lr * ox + lr * k, t.y + dy + lr * oy);
              c.arc(xx + dx + lr * ox, t.y + dy + lr * oy, lr * k, 0, TAU);
            }
            c.fill();
          });
        }
      }
      for (let i = 0; i < 6; i++) {   // turbine towers on the meadow crests
        const x = (0.03 + i * 0.045 + rr(-0.01, 0.01)) * lap, base = landTop(x) + 3 * s, h = rr(42, 56) * s;
        turbines.push({ x, top: base - h, len: h * 0.55, phase: rr(0, TAU), rate: rr(0.5, 0.8) });
        c.strokeStyle = "rgba(250,252,255,0.95)"; c.lineWidth = Math.max(1, 2 * s); c.lineCap = "round";
        wrapped(x, 40 * s, xx => { c.beginPath(); c.moveTo(xx, base); c.lineTo(xx, base - h); c.stroke(); });
      }
      // wet, darker rock where the water runs, and a soft sheet of it (the moving water is drawn each frame)
      wrapped(falls.x, falls.w * 1.2, xx => {
        const wet = c.createLinearGradient(xx - falls.w * 1.1, 0, xx + falls.w * 1.1, 0);
        wet.addColorStop(0, "rgba(30,45,40,0)"); wet.addColorStop(0.5, "rgba(30,45,40,0.45)"); wet.addColorStop(1, "rgba(30,45,40,0)");
        c.fillStyle = wet; c.fillRect(xx - falls.w * 1.1, falls.top, falls.w * 2.2, falls.foot - falls.top);
      });
      c.globalAlpha = 0.55;
      wrapped(falls.x, falls.w, xx => {
        const sheet = c.createLinearGradient(xx - falls.w * 0.6, 0, xx + falls.w * 0.6, 0);
        sheet.addColorStop(0, "rgba(170,215,240,0)"); sheet.addColorStop(0.15, "rgba(200,232,250,0.75)");
        sheet.addColorStop(0.4, "rgba(255,255,255,0.97)"); sheet.addColorStop(0.75, "rgba(222,242,255,0.92)");
        sheet.addColorStop(0.9, "rgba(180,220,245,0.6)"); sheet.addColorStop(1, "rgba(170,215,240,0)");
        c.fillStyle = sheet;
        c.beginPath();   // narrow at the lip, spreading as it falls
        c.moveTo(xx - falls.w * 0.4, falls.top);
        c.bezierCurveTo(xx - falls.w * 0.3, falls.top - 3 * s, xx + falls.w * 0.3, falls.top - 3 * s, xx + falls.w * 0.4, falls.top);
        c.quadraticCurveTo(xx + falls.w * 0.48, (falls.top + falls.foot) / 2, xx + falls.w * 0.7, falls.foot);
        c.lineTo(xx - falls.w * 0.7, falls.foot);
        c.quadraticCurveTo(xx - falls.w * 0.48, (falls.top + falls.foot) / 2, xx - falls.w * 0.4, falls.top);
        c.fill();
        const lip = c.createLinearGradient(0, falls.top - 2 * s, 0, falls.top + 10 * s);   // light on the lip
        lip.addColorStop(0, "rgba(255,255,255,0.9)"); lip.addColorStop(1, "rgba(255,255,255,0)");
        c.fillStyle = lip; c.fillRect(xx - falls.w * 0.42, falls.top - 2 * s, falls.w * 0.84, 12 * s);
      });
      c.globalAlpha = 1;
    }, { mirror: true, turbines, falls });
    {   // grain: big patches of lighter and darker field, fine grass, rough rock, falling water
      const patches = makeNoise(tw, 90 * q, 3), fine = makeNoise(tw, 5 * q, 3);
      const rock = makeNoise(tw, 9 * q, 4, 0.3), ledges = makeNoise(tw, 40 * q, 3, 6), streaks = makeNoise(tw, 3 * q, 3, 0.08);
      const fx0 = (falls.x - falls.w * 0.75) / lap * tw, fx1 = (falls.x + falls.w * 0.75) / lap * tw;
      grain(shore.cv, 1, (x, y) => {
        if (x > fx0 && x < fx1 && y > (falls.top - shore.y0) * q) return 0.3 * streaks(x, y);
        const u = x / tw, onRock = u > 0.63 && u < 0.75;   // rock in vertical columns, broken by ledges
        return 0.12 * patches(x, y) + (onRock ? 0.3 * rock(x, y) + 0.12 * ledges(x, y) : 0.05 * fine(x, y));
      });
    }

    // ---------------------------------------------------------------- the lake
    // drawn each frame: the water, the scenery mirrored in it with ripples, glints
    const lakeH = H - hz;
    const water = canvas2d(W * q, lakeH * q), wc = water.getContext("2d");
    wc.scale(q, q);
    const deep = wc.createLinearGradient(0, 0, 0, lakeH);
    deep.addColorStop(0, "#d4efff"); deep.addColorStop(0.12, "#8fd2fb"); deep.addColorStop(0.45, "#3d9fe6");
    deep.addColorStop(0.8, "#1676cc"); deep.addColorStop(1, "#1a8fb8");
    wc.fillStyle = deep; wc.fillRect(0, 0, W, lakeH);
    {   // wave texture: noise stretched sideways, finer toward the far shore
      const waves = makeNoise(Math.ceil(W * q), 40 * q, 4, 7);
      grain(water, 0.07, (x, y) => waves(x / (0.3 + y / (lakeH * q)), y));
    }
    const mirror = canvas2d(W * q, lakeH * q);   // the reflection, rebuilt each frame
    const ripples = band(hz, lakeH, 0.2, c => {
      for (let i = 0; i < 900; i++) {   // light catching the wavelets, thinner far away
        const d = rnd() ** 1.7, y = hz + 2 * s + d * (lakeH - 4 * s), w = rr(6, 40) * s * (0.25 + d * 1.6);
        c.fillStyle = `rgba(255,255,255,${rr(0.08, 0.3) * (0.5 + d)})`;
        wrapped(rnd() * lap, w, xx => c.fillRect(xx - w / 2, y, w, Math.max(0.7, (0.6 + 1.4 * d) * s)));
      }
      for (let i = 0; i < 500; i++) {   // and the darker troughs between them
        const d = rnd() ** 1.4, y = hz + 4 * s + d * (lakeH - 6 * s), w = rr(10, 60) * s * (0.25 + d * 1.6);
        c.fillStyle = `rgba(8,60,130,${rr(0.06, 0.16)})`;
        wrapped(rnd() * lap, w, xx => c.fillRect(xx - w / 2, y, w, Math.max(0.7, (0.8 + 2 * d) * s)));
      }
    });
    layers.pop();   // drawn by hand with the lake, not as an ordinary band
    const glitter = Array.from({ length: 110 }, () => {   // the sun's path on the water (it doesn't move)
      const d = rnd() ** 1.25;
      return { x: sun.x + rr(-1, 1) * (8 + 110 * d) * s, y: hz + 2 * s + d * 0.38 * H, w: rr(3, 16) * s * (0.4 + d),
               phase: rr(0, TAU), rate: rr(2, 5) };
    });

    // ---------------------------------------------------------------- grass in front
    const clump = loopKeys([[0, 0.9], [0.06, 1], [0.14, 0.75], [0.24, 0.15], [0.34, 0.05], [0.42, 0.45], [0.5, 0.2],
                            [0.6, 0.05], [0.7, 0.3], [0.8, 0.9], [0.9, 0.7]]);
    band(H - 0.3 * H, 0.3 * H, 1, c => {
      const blades = [];
      for (let x = 0; x < lap; x += 1.6 * s) {
        const k = clump(x);
        if (rnd() > 0.25 + k) continue;
        const n = 1 + Math.round(k * 2);
        for (let j = 0; j < n; j++) {
          const len = rr(0.03, 0.04 + 0.22 * k) * H, lean = rr(-0.45, 0.45) * len;
          blades.push({ x: x + rr(-2, 2) * s, len, lean, w: rr(2.5, 6) * s * (0.6 + k), tone: rnd() });
        }
      }
      blades.sort((a, b) => a.tone - b.tone);   // darker blades behind, bright ones in front
      const blade = b => wrapped(b.x, Math.abs(b.lean) + b.w + 4, xx => {
          const tipX = xx + b.lean, tipY = H - b.len, midX = xx + b.lean * 0.35, midY = H - b.len * 0.55;
          const g = c.createLinearGradient(xx, H, tipX, tipY);
          const light = 0.25 + 0.75 * b.tone;
          g.addColorStop(0, `hsl(115, 60%, ${12 + 18 * light}%)`);
          g.addColorStop(0.55, `hsl(${100 - 8 * light}, 70%, ${28 + 26 * light}%)`);
          g.addColorStop(1, `hsl(${85 - 10 * light}, 75%, ${45 + 25 * light}%)`);
          c.fillStyle = g;
          c.beginPath();
          c.moveTo(xx - b.w / 2, H + 2);
          c.quadraticCurveTo(midX - b.w * 0.35, midY, tipX, tipY);
          c.quadraticCurveTo(midX + b.w * 0.35, midY, xx + b.w / 2, H + 2);
          c.closePath(); c.fill();
          if (b.tone > 0.55) {   // a glossy highlight down one side
            c.strokeStyle = `rgba(255,255,230,${0.18 + 0.3 * (b.tone - 0.55)})`;
            c.lineWidth = Math.max(0.6, b.w * 0.18);
            c.beginPath(); c.moveTo(xx - b.w * 0.15, H - b.len * 0.1);
            c.quadraticCurveTo(midX - b.w * 0.1, midY, tipX, tipY); c.stroke();
          }
        });
      blades.forEach(blade);
      for (let i = 0; i < 70; i++) {   // dew drops
        const b = blades[Math.floor(rnd() * blades.length)];
        if (!b || b.tone < 0.4) continue;
        const u = rr(0.3, 0.8), r = rr(1.5, 3.6) * s;
        wrapped(b.x, 40 * s, xx => {
          const x = xx + b.lean * u * u * 0.9, y = H - b.len * u;
          const d = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
          d.addColorStop(0, "rgba(255,255,255,0.95)"); d.addColorStop(0.35, "rgba(220,245,255,0.35)");
          d.addColorStop(0.85, "rgba(180,230,255,0.25)"); d.addColorStop(1, "rgba(255,255,255,0.7)");
          c.fillStyle = d; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
        });
      }
      for (let i = 0; i < 40; i++) {   // daisies in the thick of the grass
        let x = rnd() * lap, tries = 0;
        while (clump(x) < 0.6 && tries++ < 20) x = rnd() * lap;
        const y = H - rr(0.02, 0.12) * H, r = rr(4, 8) * s;
        wrapped(x, r * 3, xx => {
          c.fillStyle = "rgba(255,255,255,0.97)";
          for (let k = 0; k < 12; k++) {
            const a = k / 12 * TAU;
            c.beginPath(); c.ellipse(xx + Math.cos(a) * r, y + Math.sin(a) * r * 0.55, r * 0.75, r * 0.22, a, 0, TAU); c.fill();
          }
          const eye = c.createRadialGradient(xx - r * 0.15, y - r * 0.15, 0, xx, y, r * 0.45);
          eye.addColorStop(0, "#fff36a"); eye.addColorStop(1, "#e9a412");
          c.fillStyle = eye; c.beginPath(); c.arc(xx, y, r * 0.42, 0, TAU); c.fill();
        });
      }
      // a few big blades right in front of the lens, out of focus
      c.filter = `blur(${3.5 * s}px)`;
      for (let i = 0; i < 26; i++) {
        let x = rnd() * lap, tries = 0;
        while (clump(x) < 0.7 && tries++ < 20) x = rnd() * lap;
        const len = rr(0.16, 0.3) * H;
        blade({ x, len, lean: rr(-0.5, 0.5) * len, w: rr(10, 20) * s, tone: rr(0.2, 0.9) });
      }
      c.filter = "none";
    });
    grain(layers[layers.length - 1].cv, 0.06, makeNoise(tw, 4 * q, 3));

    // ---------------------------------------------------------------- the sun's lens flare (in front of it all)
    const F = Math.round(0.9 * H), flare = canvas2d(2 * F, 2 * F), fc = flare.getContext("2d");
    fc.translate(F, F);
    for (let i = 0; i < 10; i++) {   // fine needles of light
      const a = i / 10 * TAU + rr(-0.1, 0.1), len = rr(0.2, 0.55) * F, w = rr(1, 2.4) * s;
      fc.save(); fc.rotate(a);
      const n = fc.createLinearGradient(0, 0, len, 0);
      n.addColorStop(0, "rgba(255,255,255,0.45)"); n.addColorStop(1, "rgba(255,255,255,0)");
      fc.fillStyle = n; fc.beginPath(); fc.moveTo(0, -w); fc.lineTo(len, 0); fc.lineTo(0, w); fc.fill();
      fc.restore();
    }
    const streak = fc.createRadialGradient(0, 0, 0, 0, 0, F);   // a wide horizontal streak
    streak.addColorStop(0, "rgba(220,240,255,0.32)"); streak.addColorStop(1, "rgba(220,240,255,0)");
    fc.save(); fc.scale(1, 0.012); fc.fillStyle = streak; fc.beginPath(); fc.arc(0, 0, F, 0, TAU); fc.fill(); fc.restore();
    const ghosts = [[0.35, 0.035 * H, "rgba(140,255,200,0.05)"], [0.55, 0.018 * H, "rgba(160,200,255,0.08)"],
                    [0.8, 0.06 * H, "rgba(190,160,255,0.035)"], [1.25, 0.03 * H, "rgba(120,220,255,0.06)"]];

    const vignette = canvas2d(W * q, H * q), vc = vignette.getContext("2d");   // the lens darkening the corners
    vc.scale(q, q);
    const vg = vc.createRadialGradient(W * 0.55, H * 0.42, 0.35 * Math.max(W, H), W * 0.55, H * 0.42, 0.85 * Math.max(W, H));
    vg.addColorStop(0, "rgba(0,20,60,0)"); vg.addColorStop(1, "rgba(0,20,60,0.32)");
    vc.fillStyle = vg; vc.fillRect(0, 0, W, H);

    return { W, H, s, lap, hz, sky, sun, layers, shore, ripples, water, mirror, glitter, flare, F, ghosts, vignette,
             ...floaters(W, H, s) };
  }

  // --- drawing one frame
  function draw(sc, ctx, t, dt) {
    const { W, H, s, lap } = sc;
    const offset = L => ((t * (PAN * s * L.speed + (L.wind || 0))) % lap + lap) % lap;
    const tiles = (c, L) => { for (let x = -offset(L); x < W; x += lap) c.drawImage(L.cv, x, L.y0, lap, L.h); };
    if (sc.sky) ctx.drawImage(sc.sky, 0, 0, W, sc.hz + 2);
    for (const L of sc.layers) {
      if (L === sc.shore) drawLake(sc, ctx, t, tiles, offset);   // the lake lies under the near shores
      tiles(ctx, L);
      if (L.turbines) {   // blades turning on the meadows
        const off = offset(L);
        ctx.strokeStyle = "rgba(250,253,255,0.95)"; ctx.lineWidth = Math.max(1, 1.6 * s); ctx.lineCap = "round";
        for (const tb of L.turbines) {
          for (let x = tb.x - off; x < W + lap; x += lap) {
            if (x < -tb.len || x > W + tb.len) continue;
            for (let k = 0; k < 3; k++) {
              const a = tb.phase + t * tb.rate + k * TAU / 3;
              ctx.beginPath(); ctx.moveTo(x, tb.top); ctx.lineTo(x + Math.cos(a) * tb.len, tb.top + Math.sin(a) * tb.len); ctx.stroke();
            }
          }
        }
      }
      if (L.falls) {   // water pouring down the cliff and churning white at the foot
        const f = L.falls, off = offset(L);
        for (let x = f.x - off; x < W + lap; x += lap) {
          if (x < -150 * s || x > W + 150 * s) continue;
          ctx.save();
          ctx.beginPath();   // narrow at the lip, fanning out as it falls
          ctx.moveTo(x - f.w * 0.4, f.top);
          ctx.bezierCurveTo(x - f.w * 0.3, f.top - 3 * s, x + f.w * 0.3, f.top - 3 * s, x + f.w * 0.4, f.top);
          ctx.quadraticCurveTo(x + f.w * 0.48, (f.top + f.foot) / 2, x + f.w * 0.72, f.foot);
          ctx.lineTo(x - f.w * 0.72, f.foot);
          ctx.quadraticCurveTo(x - f.w * 0.48, (f.top + f.foot) / 2, x - f.w * 0.4, f.top);
          ctx.clip();
          const sheet = ctx.createLinearGradient(x - f.w * 0.72, 0, x + f.w * 0.72, 0);
          sheet.addColorStop(0, "rgba(190,225,245,0.15)"); sheet.addColorStop(0.3, "rgba(230,245,255,0.55)");
          sheet.addColorStop(0.6, "rgba(255,255,255,0.7)"); sheet.addColorStop(1, "rgba(190,225,245,0.25)");
          ctx.fillStyle = sheet; ctx.fillRect(x - f.w, f.top - 4 * s, 2 * f.w, f.foot - f.top + 4 * s);
          const scroll = (t * 85 * s) % f.texH;
          for (let y = f.top - f.texH + scroll; y < f.foot; y += f.texH) {
            ctx.drawImage(f.tex, x - f.texW / 2, y, f.texW, f.texH);
          }
          const lip = ctx.createLinearGradient(0, f.top - 3 * s, 0, f.top + 14 * s);   // water curling over the edge
          lip.addColorStop(0, "rgba(255,255,255,0.95)"); lip.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = lip; ctx.fillRect(x - f.w, f.top - 3 * s, 2 * f.w, 17 * s);
          ctx.restore();
          for (let k = 0; k < 14; k++) {   // foam billowing up from the plunge and thinning out
            const life = (t * 0.45 + k / 14) % 1, r = (8 + 26 * life) * s;
            const px = x + Math.sin(k * 2.39) * f.w * (0.35 + 0.6 * life), py = f.foot - life * 26 * s;
            const m = ctx.createRadialGradient(px, py, 0, px, py, r);
            m.addColorStop(0, `rgba(255,255,255,${0.75 * (1 - life)})`); m.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = m; ctx.fillRect(px - r, py - r, 2 * r, 2 * r);
          }
        }
      }
    }
    if (sc.vignette) ctx.drawImage(sc.vignette, 0, 0, W, H);
    for (const b of sc.bubbles) {
      b.y -= b.up * dt;
      if (b.y < -2 * b.r) { b.y = H + 2 * b.r; b.x = Math.random() * W; }
      const x = b.x + Math.sin(b.phase + t * 0.6) * b.sway;
      ctx.drawImage(sc.bubble, x - b.r, b.y - b.r, 2 * b.r, 2 * b.r);
    }
    if (sc.flare) {   // the lens flare
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.translate(sc.sun.x, sc.sun.y);
      ctx.drawImage(sc.flare, -sc.F, -sc.F);
      const dx = W / 2 - sc.sun.x, dy = H / 2 - sc.sun.y;
      for (const [k, r, col] of sc.ghosts) {
        const g = ctx.createRadialGradient(dx * k, dy * k, 0, dx * k, dy * k, r);
        g.addColorStop(0, col); g.addColorStop(0.8, col); g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(dx * k, dy * k, r, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
    if (FRIENDS) {   // the friends list sits straight on the scene: a wash of blue glass keeps names readable
      ctx.fillStyle = "rgba(14,52,104,0.46)";
      ctx.fillRect(0, 0, W, H);
    }
  }

  // the lake: water, the scenery upside down in it (rippling: each strip of the
  // reflection sways sideways a little, more toward the front), wavelets, glints
  function drawLake(sc, ctx, t, tiles, offset) {
    const { W, H, s, hz } = sc, lakeH = H - hz, q = sc.mirror.width / W;
    ctx.drawImage(sc.water, 0, hz, W, lakeH);
    const m = sc.mirror.getContext("2d");
    m.setTransform(q, 0, 0, q, 0, 0);
    m.clearRect(0, 0, W, lakeH);
    m.setTransform(q, 0, 0, -q, 0, hz * q);   // screen y -> hz - y: mirrored about the far shore
    m.drawImage(sc.sky, 0, 0, W, hz + 2);
    for (const L of sc.layers) if (L.mirror) tiles(m, L);
    const step = 3;
    for (let y = 0; y < lakeH; y += step) {
      const d = y / lakeH, amp = (0.6 + 9 * d * d) * s;
      const dx = Math.sin(y * 0.11 / s + t * 1.4) * amp + Math.sin(y * 0.37 / s - t * 2.3) * amp * 0.45;
      ctx.globalAlpha = 0.72 - 0.42 * d;
      ctx.drawImage(sc.mirror, 0, y * q, W * q, step * q, dx, hz + y, W, step + 0.5);
    }
    ctx.globalAlpha = 1;
    tiles(ctx, sc.ripples);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "#fff";
    for (const g of sc.glitter) {
      ctx.globalAlpha = 0.15 + 0.85 * Math.max(0, Math.sin(g.phase + t * g.rate)) ** 4;
      ctx.fillRect(g.x - g.w / 2, g.y, g.w, Math.max(1, 1.3 * s));
    }
    ctx.restore();
  }

  // --- the canvas lies behind the window's contents (aero.css isolates the frame,
  // so z-index -1 lands inside it), like Liquid's water
  const canvas = document.createElement("canvas");
  canvas.id = "gg-aero";
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;" +
    "z-index:-1;border-radius:var(--gg-window-radius, 8px)";
  const ctx = canvas.getContext("2d");
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;

  let scene = null, raf = 0, last = performance.now(), start = last, rebuildAt = 0;
  let picture = null;
  if (window.__ggAeroImage) {   // the helper's picture: wait for it to decode, then build around it
    const img = new Image();
    img.onload = () => { picture = img; rebuildAt = performance.now(); };
    img.src = window.__ggAeroImage;
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 1000 / FPS - 4) return;
    const where = home();
    if (canvas.parentNode !== where) where.prepend(canvas);   // React may rebuild the page
    const W = window.innerWidth, H = window.innerHeight, dpr = (window.devicePixelRatio || 1) * RES;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      rebuildAt = scene ? now + 180 : now;   // while resizing, stretch the old scene
    }
    if (rebuildAt && now >= rebuildAt) {
      scene = build(W, H);
      rebuildAt = 0;
    }
    if (!scene) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ctx.setTransform(dpr * W / scene.W, 0, 0, dpr * H / scene.H, 0, 0);
    draw(scene, ctx, (now - start) / 1000 + START, dt);
  }
  home().prepend(canvas);
  raf = requestAnimationFrame(frame);

  window.__ggAero = {
    stop() { cancelAnimationFrame(raf); canvas.remove(); delete window.__ggAero; },
  };
})();
