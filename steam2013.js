/* Glossy Glass for Steam: the script of the Steam 2013 and Steam 2005 modes (Steam's main window).

   The 2013 details page had the game's icon and name in a box at its top, and drew its headings
   in one of three colours (blue, green or red). Today's page only names the game in a header that
   shows once the page is scrolled, so this reads the name and icon from there and hands them to
   the stylesheet as --gg-title and --gg-icon on the page, and picks the heading colour from the
   page's own artwork (--details). It also hands the bottom bar the account's picture
   (--gg-avatar) and the window the account's name (--gg-persona: the 2005 title bar reads
   "STEAM - name"). Nothing is added to, or moved in, Steam's own markup: only those custom
   properties are set, and stop() takes them off again. */
(() => {
  if (window.__gg2013) window.__gg2013.stop();

  const PAGE = "._1SvpjsckP9cPRxO6gCBHrw";                                    // a game's page (it scrolls)
  const NAME = "._2L3s2nzh7yCnNESfI5_dN1 ._3rpUkswF6xc_ste4Ros_xM";           // the name in today's sticking header
  const ICON = "._2L3s2nzh7yCnNESfI5_dN1 ._2MBVRXpsw6DUjs7937DWZW img";       // and the icon beside it
  const HERO = "._2gZXhRmKUk68pA28-5ZmGQ .QlR9EFwTdUNm_J5vx54_Z img";         // the page's artwork
  const ME = "._3cykd-VfN_xBxf3Qxriccm ._3yD46y5pd3zOGR7CzKs0mC img";         // the account's picture, top right
  const BAR = "._3vCzSrrXZzZjVJFZNg9SGu";                                     // the bottom bar
  const ACCOUNT = "._3yD46y5pd3zOGR7CzKs0mC";                                 // the account button (it carries your state)
  const FRAMES = { ingame: "rgb(160, 193, 114)", online: "rgb(128, 165, 198)", offline: "rgb(118, 116, 113)" };   // the picture frames
  const COLOURS = { blue: "rgb(89, 126, 179)", green: "rgb(126, 166, 75)", red: "rgb(173, 69, 71)" };   // GameDetailsBlue, -Green, -Red
  const FRAME = "._1ENHEsrSLcTRtPQFl1F-wL";                                   // the window
  const PROPS = ["--gg-title", "--gg-icon", "--details", "--gg-persona"];
  const touched = new Set();
  const colourOf = new Map();   // artwork address -> its colour, worked out once

  const css = text => JSON.stringify(String(text));
  const set = (el, name, value) => {
    if (value) el.style.setProperty(name, value); else el.style.removeProperty(name);
    touched.add(el);
  };

  /* blue, green or red, whichever the artwork leans to: its vivid pixels vote with their hue */
  const lean = img => {
    const c = document.createElement("canvas");
    c.width = 32;
    c.height = 12;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, 32, 12);
    const px = g.getImageData(0, 0, 32, 12).data;   // throws for a picture from elsewhere: the caller keeps blue
    const votes = { blue: 0, green: 0, red: 0 };
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255, gr = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, gr, b), min = Math.min(r, gr, b), d = max - min;
      if (d < 0.12 || max < 0.2) continue;   // grey, or too dark to tell
      let h = max === r ? ((gr - b) / d) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
      h = (h * 60 + 360) % 360;
      votes[h < 50 || h >= 300 ? "red" : h < 170 ? "green" : "blue"] += d * max;
    }
    const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    return votes[best] > 1.5 ? best : "blue";
  };

  const accent = (page, img) => {
    const src = img && (img.currentSrc || img.src);
    if (!src) return set(page, "--details", "");
    if (colourOf.has(src)) return set(page, "--details", COLOURS[colourOf.get(src)]);
    const work = () => {
      let name = "blue";
      try { name = lean(img); } catch (e) { /* not readable here */ }
      colourOf.set(src, name);
      if (colourOf.size > 300) colourOf.delete(colourOf.keys().next().value);
      if (document.contains(page) && (img.currentSrc || img.src) === src) set(page, "--details", COLOURS[name]);
    };
    if (img.complete && img.naturalWidth) work();
    else img.addEventListener("load", work, { once: true });
  };

  let queued = 0;
  const sync = () => {
    queued = 0;
    const page = document.querySelector(PAGE);
    if (page) {
      const name = document.querySelector(NAME), icon = document.querySelector(ICON), hero = document.querySelector(HERO);
      const title = name ? name.textContent.trim() : "";
      const src = icon ? icon.currentSrc || icon.src || "" : "";
      const key = title + "\n" + src + "\n" + (hero ? hero.currentSrc || hero.src : "");
      if (page.__gg2013 !== key) {
        page.__gg2013 = key;
        set(page, "--gg-title", title && css(title));
        set(page, "--gg-icon", src && "url(" + css(src) + ")");
        accent(page, hero);
      }
    }
    const frame = document.querySelector(FRAME), account = document.querySelector("._3cykd-VfN_xBxf3Qxriccm " + ACCOUNT);
    if (frame) {
      let who = "";
      if (account) for (const c of account.children) if (c.tagName === "DIV" && !c.className && c.textContent.trim()) { who = c.textContent.trim(); break; }
      if (frame.__gg2013 !== who) {
        frame.__gg2013 = who;
        set(frame, "--gg-persona", who && css(" - " + who));
      }
    }
    const bar = document.querySelector(BAR), me = document.querySelector(ME);
    if (bar) {
      const src = me ? me.currentSrc || me.src || "" : "";
      const holder = me ? me.closest(".avatarHolder") || me.closest(ACCOUNT) : null;
      const state = holder ? (holder.classList.contains("ingame") ? "ingame" : holder.classList.contains("online") ? "online" : "offline") : "";
      const key = src + "|" + state;
      if (bar.__gg2013 !== key) {
        bar.__gg2013 = key;
        set(bar, "--gg-avatar", src && "url(" + css(src) + ")");
        set(bar, "--gg-frame", FRAMES[state] || "");
      }
    }
  };
  const queue = () => { if (!queued) queued = setTimeout(sync, 60); };

  const watcher = new MutationObserver(queue);
  watcher.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["src"] });
  const tick = setInterval(sync, 3000);   // your state (online, in a game) changes without the page changing
  sync();

  window.__gg2013 = {
    stop() {
      watcher.disconnect();
      clearInterval(tick);
      clearTimeout(queued);
      for (const el of touched) {
        for (const name of PROPS) el.style.removeProperty(name);
        el.style.removeProperty("--gg-avatar");
        el.style.removeProperty("--gg-frame");
        delete el.__gg2013;
      }
      touched.clear();
      delete window.__gg2013;
    },
  };
})();
