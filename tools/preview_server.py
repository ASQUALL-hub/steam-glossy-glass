"""Replay snapshots of Steam's pages (snapshot.py) in a normal browser, with the theme's CSS on top:
a local server that answers the page's own root-relative requests from this PC's Steam folder.

    python preview_server.py PORT SNAPSHOT_DIR

    /                              the snapshots there are
    /snap/NAME.html?theme=a.css,b.css    a snapshot with those theme files linked last (none = stock);
                                   &js=a.js runs a mode's script in it, &css=... adds a rule
    /snap/NAME.html?mode=MODE      a snapshot as the helper would dress it in a solid mode (a skin
                                   too), its script running; &friends=1 for a friends or chat window
    /__mode/MODE/lib.css           what the helper puts into the main window in that mode
    /__mode/MODE/friends.css       ... and into the friends windows
    /__theme/FILE                  the theme's files (this repo)
    /assets/APPID/FILE             Steam's library pictures (appcache/librarycache)
    anything else                  Steam's steamui folder (css, images, fonts...)

127.0.0.1 only. Nothing is written anywhere.
"""
import html
import mimetypes
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The solid modes (the helper's SOLID_MODES): the year in a theme file's name picks the sheet the
# helper would put under it. The index links each with the preview-only sheet its list scale needs.
SOLID_YEARS = ("2013", "2017", "2005")
SOLID_LINKS = (("Steam 2013", "steam2013.css,tools/preview.css"), ("Steam 2017", "steam2017.css,tools/preview.css"),
               ("Steam 2005", "steam2005.css"))


def steam_dir():
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
        return os.path.normpath(winreg.QueryValueEx(k, "SteamPath")[0])


_helper = []


def helper():
    """The helper's own code (steamglass.pyw) as a module, for the parts the preview shares with it."""
    if not _helper:
        import importlib.machinery
        import importlib.util
        loader = importlib.machinery.SourceFileLoader("steamglass", os.path.join(REPO, "steamglass.pyw"))
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader("steamglass", loader))
        loader.exec_module(module)
        _helper.append(module)
    return _helper[0]


def inside(root, rel):
    """root/rel as a real path, or None when rel climbs out of root."""
    path = os.path.realpath(os.path.join(root, rel.lstrip("/\\")))
    return path if path.startswith(os.path.realpath(root) + os.sep) or path == os.path.realpath(root) else None


class Handler(BaseHTTPRequestHandler):
    steam = snaps = None

    def log_message(self, *_):
        pass

    def send(self, body, kind="text/html; charset=utf-8", code=200):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def file(self, path):
        if not path or not os.path.isfile(path):
            return self.send(b"not found", "text/plain", 404)
        with open(path, "rb") as f:
            self.send(f.read(), mimetypes.guess_type(path)[0] or "application/octet-stream")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path, query = urllib.parse.unquote(url.path), urllib.parse.parse_qs(url.query)
        if path == "/":
            names = sorted(n for n in os.listdir(self.snaps) if n.endswith(".html"))
            rows = "".join(f'<li><a href="/snap/{html.escape(n)}">{html.escape(n)}</a> (stock)'
                           + "".join(f' &middot; <a href="/snap/{html.escape(n)}?theme={sheets}&js=steam2013.js">{label}</a>'
                                     for label, sheets in SOLID_LINKS)
                           + "".join(f' &middot; <a href="/snap/{html.escape(n)}?mode={mode}">{html.escape(skin["name"])}</a>'
                                     for mode, skin in helper().SKINS.items()) + "</li>" for n in names)
            return self.send(f"<!doctype html><title>Steam snapshots</title><ul>{rows}</ul>".encode())
        if path.startswith("/snap/"):
            src = inside(self.snaps, path[len("/snap/"):])
            if not src or not os.path.isfile(src):
                return self.send(b"no such snapshot", "text/plain", 404)
            with open(src, encoding="utf-8") as f:
                page = f.read()
            names = [name for name in ",".join(query.get("theme", [])).split(",") if name]
            links = "".join(f'<link rel="stylesheet" href="/__theme/{html.escape(name)}">' for name in names)
            mode = (query.get("mode") or [""])[0]
            if mode in helper().SOLID_MODES:
                which = "friends" if query.get("friends") else "lib"
                links += f'<link rel="stylesheet" href="/__mode/{mode}/{which}.css">'
                if which == "lib":
                    scaled = "preview2005.css" if mode == "steam2005" or mode in helper().SKINS else "preview.css"
                    links += f'<link rel="stylesheet" href="/__theme/tools/{scaled}">'
                    query.setdefault("js", []).append("steam2013.js")
            for year in SOLID_YEARS:   # what the helper puts under a solid mode's sheet
                if any(year in os.path.basename(name) for name in names):
                    links = f'<link rel="stylesheet" href="/__under/steam{year}.css">' + links
                    break
            extra = "".join(f"<style>{css}</style>" for css in query.get("css", []))
            page = page.replace("</head>", links + extra + "</head>", 1)
            scripts = [name for name in ",".join(query.get("js", [])).split(",") if name]   # a mode's own script
            if scripts:
                tags = "".join(f'<script src="/__theme/{html.escape(name)}"></script>' for name in scripts)
                page = page.replace("</body>", tags + "</body>", 1) if "</body>" in page else page + tags
            return self.send(page.encode("utf-8"))
        if path.startswith("/__under/steam") and path[len("/__under/steam"):-4] in SOLID_YEARS and path.endswith(".css"):
            return self.send(helper().solid_under(path[9:-4]).encode("utf-8"), "text/css; charset=utf-8")
        if path.startswith("/__mode/"):
            mode, _, which = path[len("/__mode/"):].partition("/")
            if mode not in helper().SOLID_MODES or which not in ("lib.css", "friends.css"):
                return self.send(b"no such mode", "text/plain", 404)
            return self.send(helper().solid_sheets(mode)[which == "friends.css"].encode("utf-8"), "text/css; charset=utf-8")
        if path.startswith("/__theme/"):
            return self.file(inside(REPO, path[len("/__theme/"):]))
        if path.startswith("/assets/"):
            return self.file(inside(os.path.join(self.steam, "appcache", "librarycache"), path[len("/assets/"):]))
        return self.file(inside(os.path.join(self.steam, "steamui"), path))


def main():
    port, Handler.snaps = int(sys.argv[1]), os.path.abspath(sys.argv[2])
    Handler.steam = steam_dir()
    print(f"http://127.0.0.1:{port}/  snapshots {Handler.snaps}  Steam {Handler.steam}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
