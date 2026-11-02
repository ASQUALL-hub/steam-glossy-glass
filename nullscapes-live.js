/* Glossy Glass for Steam: the "Nullscapes" glass, played live.

   Runs the Geometry Dash level "Nullscapes Background" behind the window with the
   level player in gdscene.js (loaded just before this script), instead of
   recordings: the misty mountains, then the moon over spiky grass, then back.

   Everything follows the level's song (Creo - Flow, 128 BPM). Each scene is a whole
   number of bars of the song, the stretch that plays under that part of the level
   (song time = SONG_OFFSET + SONG_RATE x level time, fitted to the level's beat
   pulses), and the scene's clock is the song's clock, so the level's pulses, flashes
   and shakes land on the beats. Scenes hand over on a bar line with a one-bar
   cross-fade, music included (two players, one per scene), and the music is nudged
   to the picture rather than the other way round, so the picture never stutters. In
   the friends list (no music) the same clock runs silently.

   It renders at the window's own resolution and the screen's refresh rate (up to
   MAX_FPS). The level, its camera path and GD's sprite sheets are the player's own
   files and stay on their PC: the Steam Glass helper hands them in as blob URLs,
   window.__ggNullFiles = {level, camera, "sheet:<name>"...}, and window.__ggNullMusic
   (or null when the music is switched off).

   Runs once per window; loading it again replaces the running copy. */
(() => {
  for (const k of ["__ggNull", "__ggAero", "__ggLiquid"]) if (window[k]) window[k].stop();
  document.querySelectorAll("#gg-null").forEach(n => n.remove());
  const files = window.__ggNullFiles;
  if (!files || !files.level || !window.GDScene) return;

  const FRIENDS = !!document.querySelector(".friendsui-container");
  const BEAT = 60 / 128;                          // the song's beat (s)
  const BAR = 4 * BEAT;
  const GRID = 0.0098;                            // the song time of a downbeat
  const SONG_OFFSET = 1.22, SONG_RATE = 1.003;    // song time = SONG_OFFSET + SONG_RATE * level time
  const bar = n => GRID + n * BAR;
  // [from, to] in song time, on bar lines: the misty mountains (12 bars), then the moon
  // section (8 bars: the blackout bar, then the drop that brings the moon up)
  const SCENES = [[bar(4), bar(16)], [bar(25), bar(33)]];
  const FADE = BAR;                               // the hand-over between scenes takes one bar
  const VOLUME = 0.35;
  const MAX_FPS = FRIENDS ? 30 : 144;             // the friends list is small and mostly text
  const RES = FRIENDS ? 0.6 : 1;                  // render scale (1 = the window's own pixels)
  const WIND = 1;                                 // level seconds simulated per frame while winding a hidden scene (~4 ms)
  const levelAt = song => (song - SONG_OFFSET) / SONG_RATE;

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

  // one player per scene, so the hand-over can blend two parts of the song
  const players = SCENES.map(() => !FRIENDS && window.__ggNullMusic ? new Audio(window.__ggNullMusic) : null);
  for (const a of players) if (a) { a.volume = 0; a.preservesPitch = true; }

  let stopped = false, raf = 0, timer = 0, scenes = null, current = 0, fading = null, last = 0, hiddenAt = 0;
  const frames = [];   // recent frame times (ms), for stats()
  const fit = () => {
    for (const c of canvases) {
      const w = Math.max(1, Math.round(box.clientWidth * devicePixelRatio * RES));
      const h = Math.max(1, Math.round(box.clientHeight * devicePixelRatio * RES));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  };

  // a scene's song clock: where in the song it is now (it started at song time s.from at wall time s.wall)
  const songNow = (s, now) => s.from + (now - s.wall) / 1000;

  // a hidden scene is wound to its start a level-second per frame, so it's ready when its
  // turn comes without stalling the one on screen
  const wind = s => {
    const to = levelAt(SCENES[s.index][0]);
    if (s.ready) return;
    if (s.t > to) s.reset();
    s.seek(Math.min(to, s.t + WIND));
    s.ready = s.t + 1 / 60 > to;
  };

  // run a scene up to where its song clock is (small steps, so triggers fire in order)
  const advance = (s, now) => {
    const target = levelAt(songNow(s, now));
    for (let k = 0; k < 40 && s.t < target - 1e-4; k++) s.step(Math.min(1 / 120, target - s.t));
  };

  const start = (k, now) => {   // scene k begins at its first bar, music and all
    const s = scenes[k];
    s.from = SCENES[k][0]; s.wall = now; s.running = true;
    const a = players[k];
    if (a) { a.currentTime = s.from; a.playbackRate = 1; a.play().catch(() => {}); }
  };
  const halt = k => {
    scenes[k].running = false; scenes[k].ready = false;   // wind it back to its start for next time
    if (players[k]) players[k].pause();
  };

  // keep each running player on its scene's clock: big slips jump, small ones are nudged
  // with the playback rate so nothing clicks
  const drift = [0, 0];
  const steer = (k, now, gain) => {
    const a = players[k], s = scenes[k];
    if (!a) return;
    a.volume = VOLUME * gain;
    if (a.paused || a.readyState < 2) return;
    const d = a.currentTime - songNow(s, now);
    drift[k] = d;
    if (Math.abs(d) > 0.12) { a.currentTime = songNow(s, now); a.playbackRate = 1; }
    else a.playbackRate = Math.min(1.03, Math.max(0.97, 1 - d * 1.5));
  };

  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !scenes) return;
    if (now - last < 1000 / MAX_FPS - 1) return;
    last = now;
    render(now);
  };
  const render = now => {
    const t0 = performance.now();
    const s = scenes[current], other = scenes[1 - current];
    advance(s, now); s.draw();
    if (fading) {   // both run while they cross; the song parts cross with them (equal power)
      advance(other, now); other.draw();
      const u = Math.min(1, (now - fading) / (FADE * 1000));
      steer(current, now, Math.cos(u * Math.PI / 2)); steer(1 - current, now, Math.sin(u * Math.PI / 2));
      if (u >= 1) { halt(current); current = 1 - current; fading = null; }
    } else {
      steer(current, now, 1);
      if (!other.ready) wind(other);
      if (songNow(s, now) >= SCENES[current][1] - FADE && other.ready) {
        fading = now;
        start(1 - current, now);
        canvases[1 - current].style.opacity = "1";
        canvases[current].style.opacity = "0";
      }
    }
    frames.push(performance.now() - t0);
    if (frames.length > 240) frames.shift();
  };

  // Chromium may want a click or key press before sound plays: retry on the first input
  const playing = () => scenes ? scenes.map((s, k) => s.running && players[k]).filter(Boolean) : [];
  const onInput = () => { if (!document.hidden) for (const a of playing()) if (a.paused) a.play().catch(() => {}); };
  addEventListener("pointerdown", onInput, true);
  addEventListener("keydown", onInput, true);
  const onVisibility = () => {   // nothing to draw or hear while Steam isn't on screen; the song clock waits too
    const now = performance.now();
    if (document.hidden) { hiddenAt = now; for (const a of players) if (a) a.pause(); return; }
    if (hiddenAt && scenes) {
      const gap = now - hiddenAt;
      for (const s of scenes) s.wall += gap;
      if (fading) fading += gap;
      onInput();
    }
    hiddenAt = 0;
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
    scenes[0].seek(levelAt(SCENES[0][0])); scenes[0].ready = true;
    canvases[0].style.opacity = "1";
    const now = performance.now();
    start(0, now);
    if (document.hidden) onVisibility();
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
      for (const a of players) if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
      box.remove();
      delete window.__ggNull;
    },
    players,
    scenes: () => scenes,
    tick: now => { if (scenes) render(now); },   // one frame by hand, for testing with Steam hidden
    // frame cost (ms, last 240 frames), where each scene is, and how far the music is from the picture (s)
    stats: () => ({ avg: frames.reduce((a, b) => a + b, 0) / (frames.length || 1), worst: Math.max(0, ...frames),
                    scene: current, t: scenes && scenes[current].t, drift: drift.slice(),
                    song: scenes && scenes[current].running ? songNow(scenes[current], performance.now()) : null,
                    size: [canvases[0].width, canvases[0].height] }),
  };
})();
