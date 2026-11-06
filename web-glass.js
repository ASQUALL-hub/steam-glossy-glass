// Glossy Glass for Steam: web.css in a Steam web page (the store, the community...).
//
// The helper registers this with each such page so it runs at the start of every page load there,
// before the page's own scripts (so a page never flashes its solid background), and runs it once in
// the page that is already open. It's called with {css, mode, key}; css "" takes the glass out again.
// Steam's own window only: the in-game overlay and Big Picture browse with other user agents, and
// other sites opened in Steam (a game's homepage, a video) are left as they are.
(cfg) => {
  if (window.top !== window) return;   // pages, not the frames inside them
  if (!/(^|\.)(steampowered|steamcommunity)\.com$/.test(location.hostname)) return;
  if (!/Valve Steam Client/.test(navigator.userAgent)) return;
  const ID = "steam-glass-web";
  if (window.__ggWebStop) window.__ggWebStop();
  if (!cfg.css) {
    const s = document.getElementById(ID);
    if (s) s.remove();
    if (document.documentElement) delete document.documentElement.dataset.ggGlass;
    return;
  }

  const put = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.ggGlass = cfg.mode;
    let s = document.getElementById(ID);
    if (!s) { s = document.createElement("style"); s.id = ID; }
    if (s.dataset.key !== cfg.key) { s.textContent = cfg.css; s.dataset.key = cfg.key; }
    const home = document.head || root;
    if (home.lastElementChild !== s) home.append(s);   // last in the page, so it wins ties
    return true;
  };

  // page-wide art and solid fills that Steam paints under everything on pages web.css doesn't name
  // (sale pages and the like): elements as wide as the page and at least half a screen tall, looked at
  // top-down (a narrower element can't be one, so its insides are skipped). Pop-ups' dimming
  // (position: fixed) stays.
  const clearWide = () => {
    if (!document.body) return;
    const wide = innerWidth * 0.95, tall = innerHeight * 0.5;
    const walk = (e, depth) => {
      for (const c of e.children) {
        const r = c.getBoundingClientRect();
        if (r.width < wide) continue;
        const s = getComputedStyle(c);
        if (s.position !== "fixed" && r.height >= tall) {
          const a = s.backgroundColor.match(/rgba?\(([^)]*)\)/), alpha = a ? a[1].split(",")[3] : undefined;
          const solid = a && (alpha === undefined || +alpha >= 0.8);
          if (solid || s.backgroundImage.includes("url(")) c.classList.add("gg-clear-bg");
        }
        if (depth < 8) walk(c, depth + 1);
      }
    };
    walk(document.body, 0);
  };

  const again = () => { put(); clearWide(); };
  const timers = [setTimeout(again, 1500), setTimeout(again, 4000)];   // late pictures and sections
  let mo = null;
  if (!put()) {   // a page that is just starting: no <html> yet
    mo = new MutationObserver(() => { if (put()) { mo.disconnect(); mo = null; } });
    mo.observe(document, { childList: true });
  }
  document.addEventListener("DOMContentLoaded", again);
  addEventListener("load", again);
  if (document.readyState !== "loading") again();
  window.__ggWebStop = () => {
    timers.forEach(clearTimeout);
    if (mo) mo.disconnect();
    document.removeEventListener("DOMContentLoaded", again);
    removeEventListener("load", again);
    delete window.__ggWebStop;
  };
}
