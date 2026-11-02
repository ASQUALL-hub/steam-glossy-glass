/* Glossy Glass for Steam: the "Eternal Night" glass, played live.

   Runs the Geometry Dash level "Eternal Night" behind the window with the level player in
   gdscene.js (loaded just before this script), from start to end along the camera path
   recorded from the game, and then from the top again. The song (Rose At Nightfall) is
   the clock: the level starts at the song's offset (level.json "song": offset in seconds,
   fadeIn/fadeOut as the level sets them); once the camera stops, the picture fades to
   black and it all starts over.

   The scene keeps GD's 16:9 framing and covers the window like a picture. It renders at
   the window's resolution and the screen's refresh rate (up to MAX_FPS). The level, its
   camera path, GD's sprite sheets and the song are the player's own files and stay on
   their PC: the Steam Glass helper hands them in as blob URLs, window.__ggNightFiles =
   {level, camera, "sheet:<name>"...}, and window.__ggNightMusic (or null when the song is
   off; the friends list never gets it). Without music the same clock runs silently. The
   friends list shows the same moment as the main window, which sends its clock over a
   BroadcastChannel (as Nullscapes does).

   Runs once per window; loading it again replaces the running copy. */
(() => {
  for (const k of ["__ggNight", "__ggNull", "__ggAero", "__ggLiquid"]) if (window[k]) window[k].stop();
  document.querySelectorAll("#gg-night").forEach(n => n.remove());
  const files = window.__ggNightFiles;
  if (!files || !files.level || !window.GDScene) return;

  const FRIENDS = !!document.querySelector(".friendsui-container");
  const FADE_IN = 2;            // GD's song fade in (s)
  const END_HOLD = 1.5;         // after the camera stops, hold this long before fading out
  const FADE_OUT = 1;           // the picture's fade to black at the end (s)
  const VOLUME = 0.35;
  const ASPECT = 16 / 9;        // GD's framing; the window crops it
  const FOCUS = 0.5;            // which part stays in view when the window is wider than 16:9 (0 top, 1 bottom)
  const MAX_FPS = FRIENDS ? 30 : 144;   // the friends list is small and mostly text
  const RES = FRIENDS ? 0.6 : 1;        // render scale (1 = the window's own pixels)
  const WIND = 1;               // level seconds simulated per frame when the picture has to catch up

  const box = document.createElement("div");
  box.id = "gg-night";
  box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;" +
    "border-radius:var(--gg-window-radius, 8px);background:#000";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute";
  const black = document.createElement("div");   // the fade out at the end of the level
  black.style.cssText = "position:absolute;inset:0;background:#000;opacity:0";
  box.append(canvas, black);
  if (FRIENDS) {   // the friends list sits straight on the scene: a wash of dark glass keeps names readable
    const wash = document.createElement("div");
    wash.style.cssText = "position:absolute;inset:0;background:rgba(10,12,20,0.5)";
    box.append(wash);
  }
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;
  home().prepend(box);

  const music = !FRIENDS && window.__ggNightMusic ? new Audio(window.__ggNightMusic) : null;
  let scene = null, song = { offset: 0, fadeIn: false, fadeOut: false }, end = 0;

  // the clock, in level time: the song's position minus its offset while it plays (smoothed,
  // since currentTime moves in steps), otherwise wall time from where it was
  let clock = 0, clockAt = 0, paused = false;
  const levelNow = now => {
    if (paused) return clock;
    let t = clock + (now - clockAt) / 1000;
    if (music && !music.paused && music.readyState >= 2) {
      const err = (music.currentTime - song.offset) - t;
      t += Math.abs(err) > 0.3 ? err : err * 0.08;
    }
    clock = t; clockAt = now;
    return t;
  };
  const volumeAt = t => VOLUME * (song.fadeIn ? Math.min(1, Math.max(0, t / FADE_IN)) : 1) *
                        (song.fadeOut ? Math.min(1, Math.max(0, (end - t) / FADE_OUT)) : 1);
  const playFrom = t => {   // the song, lined up with level time t
    if (!music || paused) return;
    music.currentTime = song.offset + Math.max(0, t);
    music.volume = volumeAt(t);
    music.play().catch(() => {});
  };

  // the friends list follows the main window's clock; the main window answers when asked
  let chan = null;
  try { chan = new BroadcastChannel("gg-night-clock"); } catch (e) {}
  const tell = () => {
    if (!chan || FRIENDS || !scene) return;
    chan.postMessage({ level: levelNow(performance.now()), wall: Date.now(), running: !paused });
  };
  if (chan) chan.onmessage = ({ data }) => {
    if (!FRIENDS) { if (data && data.ask) tell(); return; }
    if (!data || !data.running) return;   // the main window is hidden or paused: carry on alone
    clock = data.level + Math.max(0, Date.now() - data.wall) / 1000;
    clockAt = performance.now();
  };

  let stopped = false, raf = 0, timer = 0, last = 0;
  const frames = [];   // recent frame times (ms), for stats()
  const fit = () => {   // cover the window with a 16:9 picture
    const w = box.clientWidth, h = box.clientHeight;
    let cw = w, ch = w / ASPECT;
    if (ch < h) { ch = h; cw = h * ASPECT; }
    canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
    canvas.style.left = (w - cw) / 2 + "px"; canvas.style.top = (h - ch) * FOCUS + "px";
    const pw = Math.max(1, Math.round(cw * devicePixelRatio * RES)), ph = Math.max(1, Math.round(ch * devicePixelRatio * RES));
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  };

  const render = now => {
    const t0 = performance.now();
    let t = levelNow(now);
    if (t > end + FADE_OUT) {   // the level is over: from the top
      t = 0; clock = 0; clockAt = now; scene.reset();
      playFrom(0);
    }
    if (t < scene.t - 1e-3) scene.reset();
    if (t - scene.t > WIND) scene.seek(scene.t + WIND);   // far behind (the friends list joining late): catch up a bit each frame
    // run the level up to the clock in small steps, so triggers fire in order
    for (let n = 0; n < 240 && scene.t < t - 1e-4; n++) scene.step(Math.min(1 / 120, t - scene.t));
    scene.draw();
    if (music && !music.paused) music.volume = volumeAt(t);
    black.style.opacity = Math.min(1, Math.max(0, (t - end) / FADE_OUT)).toFixed(3);
    frames.push(performance.now() - t0);
    if (frames.length > 240) frames.shift();
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !scene) return;
    if (now - last < 1000 / MAX_FPS - 1) return;
    last = now;
    render(now);
  };

  // Chromium may want a click or key press before sound plays: retry on the first input
  const onInput = () => {
    if (!music || document.hidden || !music.paused || !scene) return;
    playFrom(clock);
  };
  addEventListener("pointerdown", onInput, true);
  addEventListener("keydown", onInput, true);
  const onVisibility = () => {   // nothing to draw or hear while Steam isn't on screen; the level waits
    const now = performance.now();
    if (document.hidden) { levelNow(now); paused = true; if (music) music.pause(); return; }
    paused = false; clockAt = now;
    playFrom(clock);
  };
  document.addEventListener("visibilitychange", onVisibility);

  (async () => {
    const [data, track] = await Promise.all([files.level, files.camera].map(u => fetch(u).then(r => r.json())));
    song = Object.assign(song, data.song || {});
    // the level is over once the recorded camera stops moving
    const finalX = track[track.length - 1][2];
    let k = track.length - 1;
    while (k > 0 && Math.abs(track[k - 1][2] - finalX) < 0.5) k--;
    end = track[k][0] + END_HOLD;
    fit();
    const made = await GDScene.create(canvas, { data, track, sheetUrl: n => files["sheet:" + n] });
    if (stopped) return;
    scene = made;
    clock = 0; clockAt = performance.now();
    playFrom(0);
    if (document.hidden) onVisibility();
    if (chan && FRIENDS) chan.postMessage({ ask: 1 });   // where is the main window now?
    raf = requestAnimationFrame(frame);
  })().catch(e => console.warn("Eternal Night:", e));

  timer = setInterval(() => {   // React may rebuild the page; the window may have been resized
    if (box.parentNode !== home()) home().prepend(box);
    fit();
  }, 1000);
  const clockTimer = setInterval(tell, 500);

  window.__ggNight = {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf); clearInterval(timer); clearInterval(clockTimer);
      if (chan) chan.close();
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pointerdown", onInput, true);
      removeEventListener("keydown", onInput, true);
      const gl = canvas.getContext("webgl2");
      if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext();
      if (music) { music.pause(); music.removeAttribute("src"); music.load(); }
      box.remove();
      delete window.__ggNight;
    },
    music,
    scenes: () => scene && [scene],
    tick: now => {   // one frame by hand, for testing with Steam hidden (the clock runs regardless)
      if (!scene) return;
      const was = paused; paused = false; render(now); paused = was;
    },
    seek: t => { clock = t; clockAt = performance.now(); playFrom(t); },
    // frame cost (ms, last 240 frames), where the level is, and the music's offset from the clock (s)
    stats: () => ({ avg: frames.reduce((a, b) => a + b, 0) / (frames.length || 1), worst: Math.max(0, ...frames),
                    level: clock, end, drawn: scene && scene.t,
                    musicOff: music && !music.paused ? music.currentTime - song.offset - clock : null,
                    size: [canvas.width, canvas.height] }),
  };
})();
