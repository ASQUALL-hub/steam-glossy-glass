/* Glossy Glass for Steam: the "Nullscapes" glass.

   Plays two looping scenes recorded from the Geometry Dash level "Nullscapes
   Background" behind the window's contents: low-poly misty mountains, then a moon
   behind dark spiky grass. Each plays a few loops, then they cross-fade to the other.
   Every scene has two players that take turns, so a loop never hitches where the
   video starts over (the recordings' ends already fade into their starts). In the
   main window the level's song (Creo - Flow) can play along, from the point the
   level starts it.

   The recordings are the player's own captures and stay on their PC: the Steam
   Glass helper hands them in as blob URLs, window.__ggNullVideos = {mountains, moon}
   and window.__ggNullMusic (or null when the music is switched off).

   Runs once per window; loading it again replaces the running copy. */
(() => {
  for (const k of ["__ggNull", "__ggNight", "__ggAero", "__ggLiquid"]) if (window[k]) window[k].stop();
  document.querySelectorAll("#gg-null").forEach(n => n.remove());
  const urls = window.__ggNullVideos;
  if (!urls || !urls.mountains || !urls.moon) return;

  const SCENES = [["mountains", 3], ["moon", 3]];   // [video, loops before switching]
  const FADE = 1.8;                                 // seconds of cross-fade between scenes
  const SWAP = 0.12;                                // hand over to the other player this close to the end
  const SONG_START = 22.77;                         // where the level starts its song, in seconds
  const FRIENDS = !!document.querySelector(".friendsui-container");

  const box = document.createElement("div");
  box.id = "gg-null";
  box.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:-1;overflow:hidden;" +
    "border-radius:var(--gg-window-radius, 8px);background:#0b1218";
  const makePlayer = src => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true; v.playsInline = true; v.preload = "auto";
    v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0";
    box.append(v);
    return v;
  };
  // per scene: a layer (for the cross-fade between scenes) holding two players
  const scenes = SCENES.map(([name, loops]) => {
    const layer = document.createElement("div");
    layer.style.cssText = `position:absolute;inset:0;opacity:0;transition:opacity ${FADE}s ease-in-out`;
    box.append(layer);
    const players = [makePlayer(urls[name]), makePlayer(urls[name])];
    players.forEach(p => layer.append(p));
    return { layer, players, active: 0, loops, played: 0 };
  });
  if (FRIENDS) {   // the friends list sits straight on the scene: a wash of dark glass keeps names readable
    const wash = document.createElement("div");
    wash.style.cssText = "position:absolute;inset:0;background:rgba(10,14,20,0.5)";
    box.append(wash);
  }
  const home = () => document.querySelector("._1ENHEsrSLcTRtPQFl1F-wL") || document.body;
  home().prepend(box);

  let current = 0, timer = 0, raf = 0;
  const startScene = i => {
    const sc = scenes[i];
    sc.played = 0; sc.active = 0;
    sc.players.forEach((p, k) => { p.style.opacity = k === 0 ? "1" : "0"; p.currentTime = 0; });
    sc.players[0].play().catch(() => {});
    scenes.forEach((s, k) => { s.layer.style.opacity = k === i ? "1" : "0"; });
  };
  // gapless: when the active player nears its end, the other one starts from the top and takes over
  const watch = () => {
    raf = requestAnimationFrame(watch);
    const sc = scenes[current], p = sc.players[sc.active];
    if (!p.duration || p.paused) return;
    if (p.currentTime >= p.duration - SWAP) {
      const next = sc.players[1 - sc.active];
      next.currentTime = 0;
      next.play().catch(() => {});
      next.style.opacity = "1";
      p.style.opacity = "0";
      p.pause();
      sc.active = 1 - sc.active;
      sc.played++;
      if (sc.played >= sc.loops) {   // on to the other scene, cross-fading
        const old = sc;
        current = (current + 1) % scenes.length;
        startScene(current);
        setTimeout(() => { if (scenes[current] !== old) old.players.forEach(q => q.pause()); }, FADE * 1000 + 200);
      }
    }
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
  const onVisibility = () => {   // nothing to decode or hear while Steam isn't on screen
    const sc = scenes[current];
    if (document.hidden) { scenes.forEach(s => s.players.forEach(p => p.pause())); if (music) music.pause(); }
    else { sc.players[sc.active].play().catch(() => {}); playMusic(); }
  };
  document.addEventListener("visibilitychange", onVisibility);
  startScene(0);
  playMusic();
  raf = requestAnimationFrame(watch);
  timer = setInterval(() => { if (box.parentNode !== home()) home().prepend(box); }, 1000);   // React may rebuild the page

  window.__ggNull = {
    stop() {
      cancelAnimationFrame(raf); clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pointerdown", onInput, true);
      removeEventListener("keydown", onInput, true);
      scenes.forEach(s => s.players.forEach(p => { p.pause(); p.removeAttribute("src"); p.load(); }));
      if (music) { music.pause(); music.removeAttribute("src"); music.load(); }
      box.remove();
      delete window.__ggNull;
    },
    music,
    quality: () => scenes.map(s => s.players.map(p => { const q = p.getVideoPlaybackQuality(); return [q.totalVideoFrames, q.droppedVideoFrames]; })),
  };
})();
