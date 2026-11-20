"""Put a mode's sheet and script into Steam's main window over its developer port for a moment,
read back how the page laid itself out, and take them out again. For checking a mode against the
real client without switching the helper to it (the window can be hidden: nothing is brought
forward). The helper must not be running in that mode at the same time.

    python try_in_steam.py MODE measure.js
"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import time

from cdp import WS, find

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def helper():
    loader = importlib.machinery.SourceFileLoader("steamglass", os.path.join(REPO, "steamglass.pyw"))
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader("steamglass", loader))
    loader.exec_module(module)
    return module


def main():
    mode, measure = sys.argv[1], open(sys.argv[2], encoding="utf-8").read()
    title = sys.argv[3] if len(sys.argv) > 3 else "Steam"
    m = helper()
    lib, friends, js, key = m.Theme.bundle(m.Theme.__new__(m.Theme), mode)
    ws = WS(find(title)["webSocketDebuggerUrl"], timeout=60)

    def run(expr):
        r = ws.call("Runtime.evaluate", expression=expr, awaitPromise=False, returnByValue=True).get("result", {})
        if "exceptionDetails" in r:
            return {"error": r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"].get("text")}
        return r.get("result", {}).get("value")

    if run("!!document.getElementById('steam-glass-theme')"):
        raise SystemExit("the helper's theme is in this page: switch the helper off first")
    css = friends if run("!!document.querySelector('.friendsui-container')") else lib
    try:
        print("in:", run(f"""(() => {{ const s = document.createElement('style'); s.id = 'gg-try'; s.textContent = {json.dumps(css)};
            document.head.appendChild(s); {js}; window.dispatchEvent(new Event('resize')); return document.visibilityState; }})()"""))
        time.sleep(1.5)
        run("window.dispatchEvent(new Event('resize'))")
        time.sleep(0.8)
        got = run(measure)
        print(got if isinstance(got, str) else json.dumps(got, indent=1))
    finally:
        print("out:", run("""(() => { const s = document.getElementById('gg-try'); if (s) s.remove(); if (window.__gg2013) window.__gg2013.stop();
            window.dispatchEvent(new Event('resize')); return 'removed'; })()"""))


if __name__ == "__main__":
    main()
