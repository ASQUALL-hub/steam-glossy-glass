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

  // The GD modes wear matte greys, so Steam's blue goes black and white there (web.css draws it). A
  // part counts as blue when its background, text, edge or glow is a saturated blue, cyan or indigo
  // (hue 160-280; the green discounts and coloured deal labels stay). A small part with no pictures
  // in it gets data-gg-mono (a greyscale filter, so its hover look stays too); anything bigger, a panel
  // holding game pictures, gets data-gg-grey with its own colours in grey (--gg-grey-*), and its
  // insides are looked at one by one. Parts added later (the store loads sections as you scroll)
  // are looked at as they come, and parts that only turn blue under the pointer when it gets there.
  const MONO = /^(nullscapes|eternalnight|deprivation)$/.test(cfg.mode);
  const PICTURES = "img, video, canvas, picture, iframe";
  const COLOR = /rgba?\(([^)]*)\)/g;
  const LOOKS = [["backgroundColor", "bg"], ["backgroundImage", "img"], ["borderColor", "border"], ["boxShadow", "shadow"]];
  const blue = text => {
    for (const m of String(text).replace(/url\([^)]*\)/g, "").matchAll(COLOR)) {
      const [r, g, b, a = 1] = m[1].split(",").map(Number);
      const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
      if (!(a >= 0.05) || mx < 24 || d / mx < 0.2) continue;
      let h = 60 * (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
      if (h < 0) h += 360;
      if (h >= 160 && h <= 280) return true;
    }
    return false;
  };
  const grey = text => String(text).replace(COLOR, (m, inner) => {
    const [r, g, b, a] = inner.split(",").map(Number), y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    return Number.isFinite(a) ? `rgba(${y}, ${y}, ${y}, ${a})` : `rgb(${y}, ${y}, ${y})`;
  });
  const bluePanel = s => LOOKS.some(([p]) => blue(s[p]));
  const small = (e, s) => {   // no pictures in it (a picture set as a background counts unless it's an icon)
    if (e.querySelector(PICTURES) || e.getElementsByTagName("*").length > 40) return false;
    if (!s.backgroundImage.includes("url(")) return true;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.width <= 96 && r.height <= 96;
  };
  const visit = e => {
    if (e.nodeType !== 1 || e.hasAttribute("data-gg-mono") || e.matches(PICTURES)) return;
    const s = getComputedStyle(e), panel = bluePanel(s);
    if ((panel || blue(s.color)) && small(e, s)) {
      e.setAttribute("data-gg-mono", "");
      return;
    }
    if (panel) {
      for (const [p, v] of LOOKS) e.style.setProperty("--gg-grey-" + v, grey(s[p]));
      e.setAttribute("data-gg-grey", "");
    }
    for (const c of e.children) visit(c);
  };
  const monoAll = () => { if (document.body) visit(document.body); };

  let added = [], addTimer = 0;
  const seeAdded = records => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) added.push(n);
    if (added.length && !addTimer) addTimer = setTimeout(() => {
      addTimer = 0;
      const nodes = added;
      added = [];
      for (const n of nodes) if (n.isConnected && !n.closest("[data-gg-mono]")) visit(n);
    }, 250);
  };
  const hovered = new Set();
  let hoverTimer = 0;
  const seeHover = () => {   // Steam's own hover colours, read with ours out of the way for a moment
    for (const t of hovered) {
      for (let n = t, k = 0; n && n !== document.body && k < 8; n = n.parentElement, k++) {
        if (n.hasAttribute("data-gg-mono")) break;
        if (n.hasAttribute("data-gg-grey-hover") || n.matches(PICTURES) || !n.matches(":hover")) continue;
        const ours = n.hasAttribute("data-gg-grey");
        if (ours) n.removeAttribute("data-gg-grey");
        const s = getComputedStyle(n), panel = bluePanel(s), text = blue(s.color);
        const looks = LOOKS.map(([p]) => grey(s[p]));
        if (ours) n.setAttribute("data-gg-grey", "");
        if ((panel || text) && small(n, s)) {
          n.setAttribute("data-gg-mono", "");
          break;
        }
        if (panel) {
          LOOKS.forEach(([, v], i) => n.style.setProperty("--gg-grey-" + v + "-hover", looks[i]));
          n.setAttribute("data-gg-grey-hover", "");
        }
      }
    }
    hovered.clear();
  };
  const onOver = ev => {
    if (!(ev.target instanceof Element)) return;
    hovered.add(ev.target);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(seeHover, 260);   // once Steam's hover fades have finished
  };
  const watch = MONO ? new MutationObserver(seeAdded) : null;
  if (watch) {
    watch.observe(document, { childList: true, subtree: true });
    addEventListener("mouseover", onOver, { passive: true, capture: true });
  }

  const again = () => { put(); clearWide(); if (MONO) monoAll(); };
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
    clearTimeout(addTimer);
    clearTimeout(hoverTimer);
    if (mo) mo.disconnect();
    if (watch) watch.disconnect();
    removeEventListener("mouseover", onOver, { capture: true });
    document.removeEventListener("DOMContentLoaded", again);
    removeEventListener("load", again);
    delete window.__ggWebStop;
  };
}
