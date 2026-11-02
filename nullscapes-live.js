/* Glossy Glass for Steam: the "Nullscapes" glass, played live.

   Runs the Geometry Dash level "Nullscapes Background" behind the window with the
   level player in gdscene.js (loaded just before this script), instead of recordings.

   The song (Creo - Flow, 128 BPM) plays straight through and repeats; it is never cut
   or nudged. It is the clock: the picture follows it. For the first 40 bars the level
   plays exactly as GD plays it to that song (intro, misty mountains, blackout, the moon
   coming up on the drop). After that the song's later sections pick the scene: the
   calm stretches show the mountains, the drops show the moon from its reveal (a long
   drop starts the moon over on a bar line). Every change of scene lands on a bar line
   with a one-beat cross-fade between two players, one winding up its stretch of the
   level while the other is on screen. As the song ends the picture fades to white;
   song and level then start over, and the white clears as the level's opening zoom
   plays.

   (song time = SONG_OFFSET + SONG_RATE x level time, fitted to the level's beat
   pulses; the song's beat grid starts at GRID.)

   The scene keeps GD's 16:9 framing and covers the window like a picture, so very wide
   or tall windows crop it rather than showing only grass. It renders at the window's
   resolution and the screen's refresh rate (up to MAX_FPS). The level, its camera path
   and GD's sprite sheets are the player's own files and stay on their PC: the Steam
   Glass helper hands them in as blob URLs, window.__ggNullFiles = {level, camera,
   "sheet:<name>"...}, and window.__ggNullMusic (or null when the music is off; the
   friends list never gets it). Without music the same clock runs silently. The friends
   list shows the same moment as the main window: the main window sends its song clock
   over a BroadcastChannel (Steam's windows share one origin) and the friends list
   follows it, running on its own only while the main window is away.

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
  const SONG_LENGTH = 206.2;                      // Creo - Flow, near enough: the 'ended' event has the last word
  const bar = n => GRID + n * BAR;
  const levelAt = song => (song - SONG_OFFSET) / SONG_RATE;
  // the two stretches of the level that later sections reuse: where each starts, and how many bars it can run
  const MOUNTAINS = { from: levelAt(bar(4)), bars: 18 };    // the calm misty mountains
  const MOON = { from: levelAt(bar(26)), bars: 13 };        // the moon, from its reveal on the drop
  // the song's sections, in bars: [first bar, end bar, what to show]
  const SECTIONS = [[0, 40, "level"], [40, 50, MOUNTAINS], [50, 67, MOON], [67, 76, MOUNTAINS],
                    [76, 95, MOON], [95, 111, MOUNTAINS]];
  const FADE = BEAT;                              // a change of scene cross-fades over one beat
  const WHITE_OUT = 3, WHITE_IN = 0.5;            // seconds of fade to white at the song's end, and of clearing once the level starts (as GD)
  const VOLUME = 0.35;
  const ASPECT = 16 / 9;                          // GD's framing; the window crops it
  const FOCUS = 0.45;                             // which part stays in view when the window is wider than 16:9 (0 top, 1 bottom)
  const MAX_FPS = FRIENDS ? 30 : 144;             // the friends list is small and mostly text
  const RES = FRIENDS ? 0.6 : 1;                  // render scale (1 = the window's own pixels)
  const WIND = 1;                                 // level seconds simulated per frame while winding a hidden player (~4 ms)

  // the schedule: song time -> which stretch of the level, as [songFrom, songTo, levelFrom]
  const schedule = [];
  for (const [b0, b1, what] of SECTIONS) {
    if (what === "level") { schedule.push([0, bar(b1), 0]); continue; }
    for (let b = b0; b < b1; b += what.bars) schedule.push([bar(b), bar(Math.min(b1, b + what.bars)), what.from]);
  }
  const segAt = song => { for (let k = 0; k < schedule.length; k++) if (song < schedule[k][1]) return k; return schedule.length - 1; };
  const levelIn = (k, song) => { const [s0, , l0] = schedule[k]; return k === 0 ? levelAt(song) : l0 + (song - s0) / SONG_RATE; };

  const box = document.createElement("div");
  box.id = "gg-null";
  box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;" +
    "border-radius:var(--gg-window-radius, 8px);background:#0b1218";
  const canvases = [0, 1].map(() => {
    const c = document.createElement("canvas");
    c.style.cssText = `position:absolute;opacity:0;transition:opacity ${FADE}s ease-in-out`;
    box.append(c);
    return c;
  });
  const white = document.createElement("div");   // the fade to white between one play of the song and the next
  white.style.cssText = "position:absolute;inset:0;background:#fff;opacity:0";
  box.append(white);
  const smooth = u => (u = Math.min(1, Math.max(0, u)), u * u * (3 - 2 * u));
  // like GD: white until the level starts (song time SONG_OFFSET), then clear over WHITE_IN
  const whiteness = song => song > SONG_LENGTH - WHITE_OUT ? smooth((song - (SONG_LENGTH - WHITE_OUT)) / WHITE_OUT)
                          : song < SONG_OFFSET + WHITE_IN ? 1 - smooth((song - SONG_OFFSET) / WHITE_IN) : 0;
  if (FRIENDS) {   // the friends list sits straight on the scene: a wash of dark glass keeps names readable
    const wash = document.createElement("div");
    wash.style.cssText = "position:absolute;inset:0;background:rgba(10,14,20,0.5)";
    box.append(wash);
  }
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;
  home().prepend(box);

  const music = !FRIENDS && window.__ggNullMusic ? new Audio(window.__ggNullMusic) : null;
  if (music) music.volume = VOLUME;

  // the song clock: the music's position when it plays (smoothed, since currentTime moves in
  // steps), otherwise wall time from where it was
  let clock = 0, clockAt = 0, paused = false;
  const songNow = now => {
    if (paused) return clock;
    let t = clock + (now - clockAt) / 1000;
    if (music && !music.paused && music.readyState >= 2) {
      const err = music.currentTime - t;
      t += Math.abs(err) > 0.3 ? err : err * 0.08;
    }
    clock = t; clockAt = now;
    return t;
  };
  // the friends list follows the main window's clock; the main window answers when asked
  let chan = null;
  try { chan = new BroadcastChannel("gg-null-clock"); } catch (e) {}
  const tell = () => {
    if (!chan || FRIENDS || !players) return;
    chan.postMessage({ song: songNow(performance.now()), wall: Date.now(), running: !paused });
  };
  if (chan) chan.onmessage = ({ data }) => {
    if (!FRIENDS) { if (data && data.ask) tell(); return; }
    if (!data || !data.running) return;   // the main window is hidden or paused: carry on alone
    clock = data.song + Math.max(0, Date.now() - data.wall) / 1000;
    clockAt = performance.now();
  };
  const restartSong = now => {
    clock = 0; clockAt = now;
    if (music) { music.currentTime = 0; if (!paused) music.play().catch(() => {}); }
  };

  let stopped = false, raf = 0, timer = 0, players = null, cur = 0, seg = 0, fading = null, last = 0;
  const frames = [];   // recent frame times (ms), for stats()
  const fit = () => {   // cover the window with a 16:9 picture
    const w = box.clientWidth, h = box.clientHeight;
    let cw = w, ch = w / ASPECT;
    if (ch < h) { ch = h; cw = h * ASPECT; }
    for (const c of canvases) {
      c.style.width = cw + "px"; c.style.height = ch + "px";
      c.style.left = (w - cw) / 2 + "px"; c.style.top = (h - ch) * FOCUS + "px";
      const pw = Math.max(1, Math.round(cw * devicePixelRatio * RES)), ph = Math.max(1, Math.round(ch * devicePixelRatio * RES));
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    }
  };

  // a player waiting for segment k is wound to its first level time, a level-second per frame
  const wind = (p, k) => {
    const to = Math.max(0, k === 0 ? 0 : schedule[k][2]);
    if (p.readyFor === k) return true;
    if (p.t > to + 1e-3) p.reset();
    p.seek(Math.min(to, p.t + WIND));
    if (p.t + 1 / 60 > to) { p.readyFor = k; return true; }
    return false;
  };
  // run a player up to where the song says it is (small steps, so triggers fire in order)
  const advance = (p, k, song) => {
    const target = levelIn(k, song);
    for (let n = 0; n < 40 && p.t < target - 1e-4; n++) p.step(Math.min(1 / 120, target - p.t));
  };

  const render = now => {
    const t0 = performance.now();
    let song = songNow(now);
    if (song >= SONG_LENGTH && (!music || music.paused || music.ended)) { restartSong(now); song = 0; }
    const q = players[1 - cur], segNow = segAt(song);
    if (segNow !== seg && !fading && q.readyFor === segNow) {   // a bar line: hand over
      fading = { at: now, from: cur };
      cur = 1 - cur; seg = segNow;
      canvases[cur].style.opacity = "1"; canvases[1 - cur].style.opacity = "0";
    }
    const a = players[cur];
    advance(a, seg, song); a.draw();
    if (fading) {   // the one leaving keeps running until it has faded
      const b = players[fading.from];
      advance(b, b.segOn ?? seg, song); b.draw();
      if (now - fading.at > FADE * 1000) { fading = null; players[1 - cur].readyFor = -1; }
    } else {
      // get the waiting player ready for the next segment, or for the one due now if the song jumped
      wind(players[1 - cur], segNow !== seg ? segNow : (seg + 1) % schedule.length);
    }
    a.segOn = seg;
    white.style.opacity = whiteness(song).toFixed(3);
    frames.push(performance.now() - t0);
    if (frames.length > 240) frames.shift();
  };
  const frame = now => {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !players) return;
    if (now - last < 1000 / MAX_FPS - 1) return;
    last = now;
    render(now);
  };

  // Chromium may want a click or key press before sound plays: retry on the first input,
  // starting the song where the picture is
  const onInput = () => {
    if (!music || document.hidden || !music.paused) return;
    music.currentTime = Math.min(clock, SONG_LENGTH - 0.1);
    music.play().catch(() => {});
  };
  addEventListener("pointerdown", onInput, true);
  addEventListener("keydown", onInput, true);
  if (music) music.addEventListener("ended", () => restartSong(performance.now()));
  const onVisibility = () => {   // nothing to draw or hear while Steam isn't on screen; the song waits
    const now = performance.now();
    if (document.hidden) { songNow(now); paused = true; if (music) music.pause(); return; }
    paused = false; clockAt = now;
    if (music) { music.currentTime = Math.min(clock, SONG_LENGTH - 0.1); music.play().catch(() => {}); }
  };
  document.addEventListener("visibilitychange", onVisibility);

  (async () => {
    const [data, track] = await Promise.all([files.level, files.camera].map(u => u ? fetch(u).then(r => r.json()) : null));
    fit();
    const made = [];
    for (const c of canvases) made.push(await GDScene.create(c, { data, track, sheetUrl: n => files["sheet:" + n] }));
    if (stopped) return;
    players = made;
    players[0].readyFor = 0; players[1].readyFor = -1;
    canvases[0].style.opacity = "1";
    clock = 0; clockAt = performance.now();
    if (music) music.play().catch(() => {});
    if (document.hidden) onVisibility();
    if (chan && FRIENDS) chan.postMessage({ ask: 1 });   // where is the main window now?
    raf = requestAnimationFrame(frame);
  })().catch(e => console.warn("Nullscapes:", e));

  timer = setInterval(() => {   // React may rebuild the page; the window may have been resized
    if (box.parentNode !== home()) home().prepend(box);
    fit();
  }, 1000);
  const clockTimer = setInterval(tell, 500);

  window.__ggNull = {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf); clearInterval(timer); clearInterval(clockTimer);
      if (chan) chan.close();
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pointerdown", onInput, true);
      removeEventListener("keydown", onInput, true);
      for (const c of canvases) { const gl = c.getContext("webgl2"); if (gl) gl.getExtension("WEBGL_lose_context")?.loseContext(); }
      if (music) { music.pause(); music.removeAttribute("src"); music.load(); }
      box.remove();
      delete window.__ggNull;
    },
    music, schedule,
    scenes: () => players,
    tick: now => {   // one frame by hand, for testing with Steam hidden (the song clock runs regardless)
      if (!players) return;
      const was = paused; paused = false; render(now); paused = was;
    },
    seekSong: s => { clock = s; clockAt = performance.now(); if (music) music.currentTime = s; },
    // frame cost (ms, last 240 frames), where the song and picture are, and the music's offset from the clock (s)
    stats: () => ({ avg: frames.reduce((a, b) => a + b, 0) / (frames.length || 1), worst: Math.max(0, ...frames),
                    song: clock, segment: seg, level: players && players[cur].t,
                    musicOff: music && !music.paused ? music.currentTime - clock : null,
                    size: [canvases[0].width, canvases[0].height] }),
  };
})();
