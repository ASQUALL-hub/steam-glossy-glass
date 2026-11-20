"""Exact-pixel screenshots of the preview (preview_server.py), from a headless browser of this PC's own
(Edge or Chrome) that stays up between calls. It shows no window and takes no focus.

    python headless.py shot URL OUT.png [--size 1280x890] [--clip X,Y,W,H] [--eval "js"] [--hover "css selector"]
                                        [--ua "user agent"] [--wait SECONDS]
    python headless.py eval URL "js expression" [--size 1280x890]      (the page is loaded first unless it's already on URL)
    python headless.py stop

The browser runs with its own empty profile in the temp folder and listens on 127.0.0.1 only.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

from cdp import WS

PORT = 9333
BROWSERS = (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=3))


def start():
    try:
        return targets()
    except OSError:
        pass
    exe = next((p for p in BROWSERS if os.path.isfile(p)), None)
    if not exe:
        raise SystemExit("no Edge or Chrome found")
    profile = os.path.join(tempfile.gettempdir(), "steam-glass-preview-browser")
    subprocess.Popen([exe, "--headless=new", f"--remote-debugging-port={PORT}", "--remote-debugging-address=127.0.0.1",
                      f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                      "--mute-audio", "--force-device-scale-factor=1", "about:blank"],
                     creationflags=0x00000008 | 0x00000200, close_fds=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        time.sleep(0.1)
        try:
            return targets()
        except OSError:
            continue
    raise SystemExit("the headless browser didn't come up")


def page():
    pages = [t for t in start() if t.get("type") == "page"]
    return WS(pages[0]["webSocketDebuggerUrl"], timeout=60)


def value(ws, expr):
    r = ws.call("Runtime.evaluate", expression=expr, awaitPromise=True, returnByValue=True).get("result", {})
    if "exceptionDetails" in r:
        d = r["exceptionDetails"]
        return {"error": d.get("exception", {}).get("description") or d.get("text")}
    return r.get("result", {}).get("value")


def load(ws, url, size, force=False, ua=None):
    w, h = size
    ws.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
    if ua is not None:   # "" puts the browser's own back
        ws.call("Emulation.setUserAgentOverride", userAgent=ua)
    if force or value(ws, "location.href") != url:
        ws.call("Page.enable")
        ws.call("Page.navigate", url=url)
        for _ in range(300):
            time.sleep(0.05)
            if value(ws, "document.readyState") == "complete" and value(ws, "location.href") == url:
                break
    value(ws, "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))")


def main():
    args = sys.argv[1:]
    if not args or args[0] == "stop":
        try:
            ws = WS(json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/version", timeout=3))["webSocketDebuggerUrl"])
            ws.call("Browser.close")
        except OSError:
            pass
        return print("stopped")
    opt = {}
    rest = []
    it = iter(args[1:])
    for a in it:
        if a.startswith("--"):
            opt[a[2:]] = True if a == "--reload" else next(it)
        else:
            rest.append(a)
    size = tuple(int(n) for n in opt.get("size", "1280x890").split("x"))
    ws = page()
    load(ws, rest[0], size, force="reload" in opt, ua=opt.get("ua"))
    if "wait" in opt:
        time.sleep(float(opt["wait"]))
    if args[0] == "eval":
        expr = rest[1]
        expr = open(expr[1:], encoding="utf-8").read() if expr.startswith("@") else expr
        got = value(ws, expr)
        return print(got if isinstance(got, str) else json.dumps(got, indent=1)[:60000])
    if "eval" in opt:
        expr = opt["eval"]
        print(value(ws, open(expr[1:], encoding="utf-8").read() if expr.startswith("@") else expr))
    if "hover" in opt:
        box = value(ws, "(() => { const r = document.querySelector(%s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()" % json.dumps(opt["hover"]))
        ws.call("Input.dispatchMouseEvent", type="mouseMoved", x=box[0], y=box[1])
        time.sleep(0.25)
    else:
        ws.call("Input.dispatchMouseEvent", type="mouseMoved", x=0, y=0)
    params = {"format": "png"}
    if "clip" in opt:
        x, y, w, h = (float(n) for n in opt["clip"].split(","))
        params["clip"] = {"x": x, "y": y, "width": w, "height": h, "scale": 1}
    r = ws.call("Page.captureScreenshot", **params)
    with open(rest[1], "wb") as f:
        f.write(base64.b64decode(r["result"]["data"]))
    print(rest[1])


if __name__ == "__main__":
    main()
