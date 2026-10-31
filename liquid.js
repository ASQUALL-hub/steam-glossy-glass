/* Glossy Glass for Steam: the "Liquid" glass, ported from DiscTray.

   Water in the window as 1-D shallow-water (Saint-Venant) equations on a
   staggered grid: column heights `h` and the flow `u` between columns, walls at
   both ends. The window's own acceleration (from dragging it around) is a body
   force on the flow, so a shove sends the water up the far wall and it rocks
   back; fast-rising crests throw droplets; droplets that hit the glass stick,
   merge and later run down leaving a trail; hard shakes stir in air bubbles.
   Same equations and constants as DiscTray's WaterSim, scaled from its 252x318
   card to the window so the water moves with the same feel.

   Runs once per window; loading it again replaces the running copy. */
(() => {
  if (window.__ggLiquid) window.__ggLiquid.stop();
  document.querySelectorAll("canvas[id^='gg-liquid']").forEach(c => c.remove());   // strays from older copies

  const CARD_W = 252, CARD_H = 318;   // DiscTray's card, which the constants were tuned on
  const LEVEL = 0.56;                 // rest height of the water surface, from the top
  const MAX_DROP_R = 4.2;             // biggest drop on the glass (DiscTray's biggest condensation drop)
  const rand = () => Math.random();
  const uniform = (a, b) => a + (b - a) * rand();
  const normal = (mu, sd) => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const gamma2 = (scale) => scale * (-Math.log(rand() || 1e-9) - Math.log(rand() || 1e-9));   // shape 2
  const poisson = (lam) => {
    let k = 0, p = 1;
    const L = Math.exp(-lam);
    do { k++; p *= rand(); } while (p > L);
    return k - 1;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  class WaterSim {
    constructor(W, H) {
      this.W = W; this.H = H;
      // A bigger tank behaves like the card scaled up by L: gravity and the shove
      // grow with L, so it sloshes at the card's pace and a drag throws the water
      // the same share of the window around; speeds grow with L too.
      const k = W / CARD_W, kh = H / CARD_H;
      const L = Math.sqrt(k * kh);
      this.V = L;
      const A = L;                               // and so does how much fits on the glass
      this.N = 72;
      this.G = 2200 * L;
      this.G_DROP = 1700 * L;
      this.FRICTION = 0.9;
      this.VISCOSITY = 380 * k * k;              // per column width, like the card
      this.TENSION = 220 * k * k;
      this.SHOVE = 0.35 * L;
      this.MAX_FLYING = Math.round(120 * A);
      this.MAX_CLING = Math.round(90 * A);
      this.MAX_BUBBLES = Math.round(70 * A);
      const levelY = H * LEVEL;
      this.depth = H - levelY;
      this.dx = W / this.N;
      this.x = Float64Array.from({ length: this.N }, (_, i) => (i + 0.5) * this.dx);
      this.h = new Float64Array(this.N).fill(this.depth);
      this.u = new Float64Array(this.N + 1);
      this.volume = this.depth * this.N;
      this.prevH = Float64Array.from(this.h);
      this.w = new Float64Array(this.N);         // how fast the surface rises (px/s)
      this.flying = [];                          // {x, y, vx, vy, r}
      this.bub = [];                             // {x, y, r, ph}
      this.cling = [];                           // {x, y, r, s}  s = sliding speed
      const n = Math.round(26 * A);              // condensation above the water
      for (let i = 0; i < n; i++) {
        this.cling.push({ x: uniform(8, W - 8), y: uniform(10, levelY - 26), r: clamp(0.9 + gamma2(0.55), 0.9, 4.2), s: 0 });
      }
    }

    resized(W, H) {
      /* The window was resized: the same water, stretched to the new size (a
         fresh tank every frame of a resize drag would flicker and reset). */
      const s = new WaterSim(W, H);
      const fx = W / this.W, fy = H / this.H, fd = s.depth / this.depth;
      for (let i = 0; i < s.N; i++) s.h[i] = this.h[i] * fd;   // same column count
      for (let i = 0; i <= s.N; i++) s.u[i] = this.u[i] * fx;
      s.prevH = Float64Array.from(s.h);
      const move = list => list.map(d => Object.assign({}, d, { x: d.x * fx, y: d.y * fy }));
      s.cling = move(this.cling);
      s.flying = move(this.flying);
      s.bub = move(this.bub);
      return s;
    }

    surfaceY(i) { return this.H - this.h[i]; }

    surfaceAt(x) {   // np.interp over the column centres
      const f = x / this.dx - 0.5;
      if (f <= 0) return this.surfaceY(0);
      if (f >= this.N - 1) return this.surfaceY(this.N - 1);
      const i = Math.floor(f), t = f - i;
      return this.surfaceY(i) * (1 - t) + this.surfaceY(i + 1) * t;
    }

    dip(x, amount) {   // something fell in or popped out: a soft dent that spreads as a ripple
      const wts = new Float64Array(this.N);
      let sum = 0;
      for (let i = 0; i < this.N; i++) {
        wts[i] = Math.exp(-0.5 * ((this.x[i] - x) / (2.2 * this.dx)) ** 2);
        sum += wts[i];
      }
      for (let i = 0; i < this.N; i++) this.h[i] -= amount * 0.6 * wts[i] / sum * 5;
    }

    step(dt, ax0, ay0) {
      const { N, dx, h, u, V } = this;
      // the water feels only part of the window's acceleration
      const ax = ax0 * this.SHOVE, ay = ay0 * this.SHOVE;
      const g = Math.max(400 * this.G / 2200, this.G + ay);   // accelerating upward presses the water down
      const uMax = 650 * V;
      const flux = new Float64Array(N + 1);
      const hl = new Float64Array(N);
      let left = dt;
      while (left > 1e-6) {
        let umax = 0, hmax = 0;
        for (let i = 0; i <= N; i++) umax = Math.max(umax, Math.abs(u[i]));
        for (let i = 0; i < N; i++) hmax = Math.max(hmax, h[i]);
        const speed = umax + Math.sqrt(g * hmax);
        const sdt = Math.min(left, 0.004, 0.45 * dx / Math.max(speed, 1));
        left -= sdt;
        for (let i = 1; i < N; i++) {
          const ui = u[i];
          const dhdx = (h[i] - h[i - 1]) / dx;
          const adv = ui * (ui > 0 ? (ui - u[i - 1]) / dx : (u[i + 1] - ui) / dx);
          const lap = (u[i + 1] - 2 * ui + u[i - 1]) / (dx * dx);
          flux[i] = clamp(ui + sdt * (-g * dhdx - ax - adv - this.FRICTION * ui + this.VISCOSITY * lap), -uMax, uMax);
        }
        for (let i = 1; i < N; i++) u[i] = flux[i];
        for (let i = 1; i < N; i++) flux[i] = (u[i] > 0 ? h[i - 1] : h[i]) * u[i];   // upwind: carry the water that flows
        flux[0] = flux[N] = 0;
        for (let i = 0; i < N; i++) h[i] -= sdt * (flux[i + 1] - flux[i]) / dx;
        for (let i = 1; i < N - 1; i++) hl[i] = h[i - 1] - 2 * h[i] + h[i + 1];   // surface tension rounds off kinks
        hl[0] = h[1] - h[0]; hl[N - 1] = h[N - 2] - h[N - 1];
        for (let i = 0; i < N; i++) h[i] = clamp(h[i] + sdt * this.TENSION * hl[i] / (dx * dx), 1, this.H - 3);
      }
      let sum = 0;
      for (let i = 0; i < N; i++) sum += h[i];
      const fix = (this.volume - sum) / N;   // keep the amount of water exact
      let finite = true;
      for (let i = 0; i < N; i++) { h[i] += fix; if (!Number.isFinite(h[i])) finite = false; }
      for (let i = 0; i <= N; i++) if (!Number.isFinite(u[i])) finite = false;
      if (!finite) {   // never let a bad step stick
        h.fill(this.depth); u.fill(0); this.prevH = Float64Array.from(h);
      }
      let wmax = 0;
      for (let i = 0; i < N; i++) {
        this.w[i] = (h[i] - this.prevH[i]) / dt;
        wmax = Math.max(wmax, Math.abs(this.w[i]));
      }
      this.prevH = Float64Array.from(h);

      // crests that shoot up throw droplets
      for (let i = 0; i < N && this.flying.length < this.MAX_FLYING; i++) {
        if (this.w[i] > 300 * V && h[i] > this.depth + 8 * V &&
            rand() < clamp((this.w[i] - 300 * V) / (300 * V), 0, 1) * dt * 30) {
          const uc = 0.5 * (u[i] + u[i + 1]);
          this.flying.push({ x: this.x[i] + normal(0, 2), y: this.surfaceY(i) - 1, vx: uc * 0.8 + normal(0, 55 * V),
                             vy: -(this.w[i] * uniform(0.6, 1.2) + 40 * V), r: uniform(1.0, 3.0) });
        }
      }

      // intense movement drags air under the surface
      const intensity = Math.max(0, (Math.hypot(ax, ay) - 1100 * V) / (500 * V)) + Math.max(0, (wmax - 420 * V) / (160 * V));
      if (intensity > 0 && this.bub.length < this.MAX_BUBBLES) {
        const k = Math.min(this.MAX_BUBBLES - this.bub.length, poisson(Math.min(intensity, 6) * dt * 40 * V));
        for (let j = 0; j < k; j++) {
          const bx = uniform(6, this.W - 6);
          this.bub.push({ x: bx, y: this.surfaceAt(bx) + uniform(3, 42 * V), r: clamp(gamma2(0.9), 0.8, 4.8), ph: uniform(0, 6.3) });
        }
      }

      this.stepFlying(dt, ax, ay);
      this.stepCling(dt);
      this.stepBubbles(dt);
      let umax = 0;
      for (let i = 0; i <= N; i++) umax = Math.max(umax, Math.abs(u[i]));
      return umax > 2 || wmax > 2 || this.flying.length > 0 || this.bub.length > 0 || this.cling.some(c => c.s > 0);
    }

    stepFlying(dt, ax, ay) {
      const stick = [];
      this.flying = this.flying.filter(f => {
        f.vx += (-ax - 0.6 * f.vx) * dt;
        f.vy += (this.G_DROP - ay - 0.6 * f.vy) * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (f.y >= this.surfaceAt(f.x) && f.vy > 0) {   // back into the water
          this.dip(f.x, 0.08 * f.r);
          return false;
        }
        if (f.x < f.r + 2 || f.x > this.W - f.r - 2 || f.y < f.r + 2) {   // hit the glass: it clings
          stick.push({ x: clamp(f.x, f.r + 2, this.W - f.r - 2), y: Math.max(f.y, f.r + 2), r: f.r, s: 0 });
          return false;
        }
        return true;
      });
      for (const s of stick) if (this.cling.length < this.MAX_CLING) this.cling.push(s);
    }

    stepCling(dt) {
      let c = this.cling;
      if (!c.length) return;
      // touching drops merge into one bigger drop
      for (let pass = 0; pass < 3 && c.length >= 2; pass++) {
        let best = Infinity, bi = -1, bj = -1;
        for (let i = 0; i < c.length; i++) {
          for (let j = i + 1; j < c.length; j++) {
            const dd = Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y) - (c[i].r + c[j].r) * 0.85;
            if (dd < best) { best = dd; bi = i; bj = j; }
          }
        }
        if (best >= 0) break;
        const a = c[bi], b = c[bj], va = a.r ** 3, vb = b.r ** 3;
        a.x = (a.x * va + b.x * vb) / (va + vb);
        a.y = (a.y * va + b.y * vb) / (va + vb);
        // a window holds far more drops than the card, so merging could grow
        // blobs; past the biggest condensation drop they run off instead
        a.r = Math.min(Math.cbrt(va + vb), MAX_DROP_R);
        c.splice(bj, 1);
      }
      // heavy drops run down in fits and starts, leaving tiny droplets behind
      const V = this.V, bits = [];
      for (const d of c) {
        if (d.r > 2.4 && d.s === 0 && rand() < 0.8 * dt * (d.r - 2.4)) d.s = ((d.r - 2.4) * 22 + 6) * V;
        if (d.s > 0 && rand() < dt * 1.2) d.s = 0;
        d.y += d.s * dt;
        if (d.s > 0 && d.r > 1.6 && rand() < dt * 2.5 && c.length + bits.length < this.MAX_CLING) {
          bits.push({ x: d.x + normal(0, 0.6), y: d.y - d.r, r: 0.8, s: 0 });
          d.r = Math.max(1.0, d.r * 0.97);
        }
      }
      c.push(...bits);
      // reaching the water (or a wave reaching them) absorbs them
      this.cling = c.filter(d => {
        if (d.y + d.r >= this.surfaceAt(d.x)) { this.dip(d.x, 0.05 * d.r); return false; }
        return true;
      });
    }

    stepBubbles(dt) {
      const V = this.V;
      this.bub = this.bub.filter(b => {
        const fi = clamp(b.x / this.dx, 0, this.N);
        const i = Math.min(this.N - 1, Math.floor(fi)), t = fi - i;
        const flow = this.u[i] * (1 - t) + this.u[i + 1] * t;
        b.ph += dt * 9;
        b.x = clamp(b.x + (flow * 0.5 + Math.sin(b.ph) * 14) * dt, 3, this.W - 3);
        b.y -= (35 + 20 * b.r) * V * dt;
        if (b.y - b.r <= this.surfaceAt(b.x)) { this.dip(b.x, -0.05 * b.r); return false; }
        return true;
      });
    }
  }

  // --- sprites: a water drop on glass, or an air bubble in water (DiscTray drop_sprite)
  const sprites = new Map();
  const deg = (a) => a * Math.PI / 180;
  function sprite(kind, r) {
    r = Math.round(r * 2) / 2;
    const key = kind + r;
    if (sprites.has(key)) return sprites.get(key);
    const d = Math.ceil(r * 2 + 4), S = 2;
    const cv = document.createElement("canvas");
    cv.width = cv.height = d * S;
    const p = cv.getContext("2d");
    p.scale(S, S);
    const cx = d / 2, cy = d / 2;
    const ell = (x, y, rx, ry) => { p.beginPath(); p.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI); };
    if (kind === "drop") {
      const body = p.createLinearGradient(cx, cy - r, cx, cy + r);
      body.addColorStop(0, "rgba(15,25,30,0.47)");
      body.addColorStop(0.55, "rgba(120,135,140,0.137)");
      body.addColorStop(1, "rgba(255,255,255,0.647)");
      ell(cx, cy, r, r); p.fillStyle = body; p.fill();
      const rim = p.createLinearGradient(cx, cy - r, cx, cy + r);
      rim.addColorStop(0, "rgba(0,0,0,0.588)");
      rim.addColorStop(1, "rgba(0,0,0,0.157)");
      const rr = r - Math.max(0.3, r * 0.1);
      ell(cx, cy, rr, rr); p.strokeStyle = rim; p.lineWidth = Math.max(0.6, r * 0.2); p.stroke();
      p.beginPath(); p.arc(cx, cy, r * 0.7, deg(-205), deg(-335), true);   // light focused at the bottom
      p.strokeStyle = "rgba(255,255,255,0.706)"; p.lineWidth = Math.max(0.5, r * 0.2); p.stroke();
      ell(cx - r * 0.35, cy - r * 0.42, r * 0.26, r * 0.18); p.fillStyle = "rgba(255,255,255,0.94)"; p.fill();
    } else {
      const body = p.createRadialGradient(cx, cy, 0, cx, cy, r);
      body.addColorStop(0, "rgba(255,255,255,0.04)");
      body.addColorStop(0.8, "rgba(230,245,255,0.157)");
      body.addColorStop(1, "rgba(255,255,255,0.47)");
      ell(cx, cy, r, r); p.fillStyle = body; p.fill();
      p.strokeStyle = "rgba(255,255,255,0.686)"; p.lineWidth = Math.max(0.5, r * 0.16); p.stroke();
      p.beginPath(); p.arc(cx, cy, r * 0.72, deg(-210), deg(-330), true);
      p.strokeStyle = "rgba(0,30,50,0.235)"; p.lineWidth = Math.max(0.5, r * 0.14); p.stroke();
      ell(cx - r * 0.38, cy - r * 0.38, r * 0.24, r * 0.2); p.fillStyle = "rgba(255,255,255,0.92)"; p.fill();
    }
    const out = { cv, d };
    sprites.set(key, out);
    return out;
  }
  const blit = (ctx, kind, x, y, r) => {
    const s = sprite(kind, r);
    ctx.drawImage(s.cv, x - s.d / 2, y - s.d / 2, s.d, s.d);
  };

  // --- two canvases. The water lies behind the window's contents (the game list,
  // play bar and the other panels sit in it), in front of the window's own tint:
  // liquid.css makes the window frame its own layer (isolation) so z-index -1
  // lands there. The drops are on the glass, in front of everything but the rim.
  const layer = (id, z) => {
    const c = document.createElement("canvas");
    c.id = id;
    c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;" +
      `z-index:${z};border-radius:var(--gg-window-radius, 8px)`;
    return c;
  };
  const canvas = layer("gg-liquid", -1), front = layer("gg-liquid-drops", 2147482998);
  const ctx = canvas.getContext("2d"), fctx = front.getContext("2d");
  // the main window's frame, or the friends window's page
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;

  function draw(sim) {
    const W = sim.W, H = sim.H, dpr = window.devicePixelRatio || 1;
    for (const c of [ctx, fctx]) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
    }
    const N = sim.N, xs = sim.x;
    const ys = Array.from({ length: N }, (_, i) => sim.surfaceY(i));
    const surface = new Path2D();   // smooth curve through the column tops
    surface.moveTo(-2, ys[0]);
    surface.lineTo(xs[0], ys[0]);
    for (let i = 1; i < N; i++) surface.quadraticCurveTo(xs[i - 1], ys[i - 1], (xs[i - 1] + xs[i]) / 2, (ys[i - 1] + ys[i]) / 2);
    surface.lineTo(W + 2, ys[N - 1]);
    const body = new Path2D(surface);
    body.lineTo(W + 2, H + 2);
    body.lineTo(-2, H + 2);
    body.closePath();

    // the water: clear, a little darker toward the bottom, with its bubbles
    const top = Math.min(...ys);
    ctx.save();
    ctx.clip(body);
    const tint = ctx.createLinearGradient(0, top, 0, H);
    tint.addColorStop(0, "rgba(175,228,236,0.133)");
    tint.addColorStop(0.5, "rgba(120,160,175,0.18)");
    tint.addColorStop(1, "rgba(30,45,58,0.43)");
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, W, H);
    for (const b of sim.bub) blit(ctx, "bubble", b.x, b.y, b.r);
    ctx.restore();

    // the waterline: light just under it, a thin dark meniscus, a bright edge
    ctx.save();
    ctx.lineJoin = "round";
    ctx.translate(0, 6);
    ctx.strokeStyle = "rgba(220,245,255,0.133)"; ctx.lineWidth = 9; ctx.stroke(surface);
    ctx.translate(0, -6 + 1.6);
    ctx.strokeStyle = "rgba(0,20,30,0.275)"; ctx.lineWidth = 1; ctx.stroke(surface);
    ctx.translate(0, -1.6);
    ctx.strokeStyle = "rgba(255,255,255,0.92)"; ctx.lineWidth = 1.4; ctx.stroke(surface);
    ctx.restore();
    for (const c of sim.cling) blit(fctx, "drop", c.x, c.y, c.r);
    for (const f of sim.flying) blit(fctx, "drop", f.x, f.y, f.r);
  }

  // --- the loop: the water feels the window being dragged around
  let sim = null, raf = 0, last = performance.now(), awake = true, dirty = true;
  let prevX = window.screenX, prevY = window.screenY, vx = 0, vy = 0, ax = 0, ay = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const where = home();
    if (canvas.parentNode !== where) where.prepend(canvas);   // React may rebuild the page
    if (front.parentNode !== where) where.append(front);
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const W = window.innerWidth, H = window.innerHeight;
    if (!sim || sim.W !== W || sim.H !== H) {
      sim = sim ? sim.resized(W, H) : new WaterSim(W, H);
      const dpr = window.devicePixelRatio || 1;
      for (const c of [canvas, front]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      awake = dirty = true;
    }
    const x = window.screenX, y = window.screenY;
    const nvx = (x - prevX) / dt, nvy = (y - prevY) / dt;
    // moves arrive unevenly, so smooth the acceleration a little
    ax = clamp(0.5 * ax + 0.5 * (nvx - vx) / dt, -8000, 8000);
    ay = clamp(0.5 * ay + 0.5 * (nvy - vy) / dt, -8000, 8000);
    prevX = x; prevY = y; vx = nvx; vy = nvy;
    const moving = Math.abs(nvx) + Math.abs(nvy) >= 1 || Math.abs(ax) + Math.abs(ay) >= 1;
    if (awake || moving) {
      awake = sim.step(dt, ax, ay) || moving;
      dirty = true;
    }
    if (dirty) { draw(sim); dirty = false; }   // at rest the last frame just stays up
  }
  home().prepend(canvas);
  home().append(front);
  raf = requestAnimationFrame(frame);

  window.__ggLiquid = {
    stop() { cancelAnimationFrame(raf); canvas.remove(); front.remove(); delete window.__ggLiquid; },
    sim: () => sim,
  };
})();
