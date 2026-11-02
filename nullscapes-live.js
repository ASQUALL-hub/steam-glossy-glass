/* Glossy Glass for Steam: the "Nullscapes" glass, played live.

   Runs the Geometry Dash level "Nullscapes Background" behind the window with the
   level player in gdscene.js (loaded just before this script), instead of
   recordings: the misty mountains, then the moon over spiky grass. Each scene plays
   its stretch of the level once and cross-fades into the other one, which has been
   wound to its start in the background meanwhile. It renders at the window's own
   resolution and the screen's refresh rate (up to MAX_FPS). In the main window the
   level's song can play along.

   The level, its camera path and GD's sprite sheets are the player's own files and
   stay on their PC: the Steam Glass helper hands them in as blob URLs,
   window.__ggNullFiles = {level, camera, "sheet:<name>"...}, and window.__ggNullMusic
   (or null when the music is switched off).

   Runs once per window; loading it again replaces the running copy. */
(() => {
  for (const k of ["__ggNull", "__ggAero", "__ggLiquid"]) if (window[k]) window[k].stop();
  document.querySelectorAll("#gg-null").forEach(n => n.remove());
  const files = window.__ggNullFiles;
  if (!files || !files.level || !window.GDScene) return;

  const FRIENDS = !!document.querySelector(".friendsui-container");
  const SCENES = [[6.7, 26.7], [48.7, 66.2]];   // [from, to] in level seconds: mountains, moon
  const FADE = 1.8;                               // seconds of cross-fade between scenes
  const MAX_FPS = FRIENDS ? 30 : 144;             // the friends list is small and mostly text
  const RES = FRIENDS ? 0.6 : 1;                  // render scale (1 = the window's own pixels)
  const WIND = 1;                                 // level seconds simulated per frame while winding a hidden scene (~4 ms)
  const SONG_START = 22.77;                       // where the level starts its song, in seconds

  const box = document.createElement("div");
  box.id = "gg-null";
  box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;" +
    "border-radius:var(--gg-window-radius, 8px);background:#0b1218";
  const canvases = SCENES.map(() => {
    const c = document.createElement("canvas");
    c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity ${FADE}s ease-in-out`;
    box.append(c);
    return c;
  });
  if (FRIENDS) {   // the friends list sits straight on the scene: a wash of dark glass keeps names readable
    const wash = document.createElement("div");
    wash.style.cssText = "position:absolute;inset:0;background:rgba(10,14,20,0.5)";
    box.append(wash);
  }
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;
  home().prepend(box);

  let stopped = false, raf = 0, timer = 0, scenes = null, current = 0, fading = null, last = 0;
  const frames = [];   // recent frame times (ms), for stats()
  const fit = () => {
    for (const c of canvases) {
      const w = Math.max(1, Math.round(box.clientWidth * devicePixelRatio * RES));
      const h = Math.max(1, Math.round(box.clientHeight * devicePixelRatio * RES));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  };

  // a hidden scene is wound back to its start a few seconds of level time per frame, so
  // it's ready when its turn comes without stalling the one on screen
  const wind = s => {
    const from = SCENES[s.index][0];
    if (s.ready) return;
    if (s.t > from) s.reset();
    s.seek(Math.min(from, s.t + WIND));
    s.ready = s.t + 1 / 60 > from;
  };

  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !scenes) return;
    if (now - last < 1000 / MAX_FPS - 1) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    const t0 = performance.now();
    last = now;
    const s = scenes[current], other = scenes[1 - current];
    s.step(dt); s.draw();
    if (fading) {   // both run while they cross
      other.step(dt); other.draw();
      if (now - fading > FADE * 1000) {
        fading = null;
        current = 1 - current;
        s.ready = false;   // wind the one that left back to its start
      }
    } else {
      if (!other.ready) wind(other);
      if (s.t >= SCENES[current][1] - FADE && other.ready) {
        fading = now;
        canvases[1 - current].style.opacity = "1";
        canvases[current].style.opacity = "0";
      }
    }
    frames.push(performance.now() - t0);
    if (frames.length > 240) frames.shift();
  };

  const music = !FRIENDS && window.__ggNullMusic ? new Audio(window.__ggNullMusic) : null;
  if (music) {
    music.volume = 0.35;
    music.currentTime = SONG_START;
    music.addEventListener("ended", () => { music.currentTime = SONG_START; music.play().catch(() => {}); });
  }
  const playMusic = () => { if (music && !document.hidden) music.play().catch(() => {}); };
  // Chromium may want a click or key press before sound plays: try now, and again on the first input
  const onInput = () => { playMusic(); };
  addEventListener("pointerdown", onInput, true);
  addEventListener("keydown", onInput, true);
  const onVisibility = () => {   // nothing to draw or hear while Steam isn't on screen
    if (document.hidden) { if (music) music.pause(); } else { last = 0; playMusic(); }
  };
  document.addEventListener("visibilitychange", onVisibility);

  (async () => {
    const [data, track] = await Promise.all([files.level, files.camera].map(u => u ? fetch(u).then(r => r.json()) : null));
    fit();
    const made = [];
    for (let k = 0; k < SCENES.length; k++) {
      const s = await GDScene.create(canvases[k], { data, track, sheetUrl: n => files["sheet:" + n] });
      s.index = k;
      made.push(s);
    }
    if (stopped) return;
    scenes = made;
    scenes[0].seek(SCENES[0][0]); scenes[0].ready = true;
    canvases[0].style.opacity = "1";
    playMusic();
    raf = requestAnimationFrame(frame);
  })().catch(e => console.warn("Nullscapes:", e));

  timer = setInterval(() => {   // React may rebuild the page; the window may have been resized
    if (box.parentNode !== home()) home().prepend(box);
    fit();
  }, 1000);

  window.__ggNull = {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf); clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pointerdown", onInput, true);
      removeEventListener("keydown", onInput, true);
      for (const c of canvases) { const gl = c.getContext("webgl2"); if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext(); }
      if (music) { music.pause(); music.removeAttribute("src"); music.load(); }
      box.remove();
      delete window.__ggNull;
    },
    music,
    scenes: () => scenes,
    // how long frames take to simulate and draw (ms): average and worst of the last 240
    stats: () => ({ avg: frames.reduce((a, b) => a + b, 0) / (frames.length || 1), worst: Math.max(0, ...frames),
                    scene: current, t: scenes && scenes[current].t, size: [canvases[0].width, canvases[0].height] }),
  };
})();
