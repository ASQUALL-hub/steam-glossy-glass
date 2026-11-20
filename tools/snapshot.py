"""Save one of Steam's own pages (the main window, a menu, the friends list...) as static HTML, for
working on the theme in a normal browser with preview_server.py: the page's markup as it is right
now, scripts taken out. The file holds whatever the page shows (your library, friends' names), so
keep snapshots out of the repo.

    python snapshot.py TITLE OUT.html
"""
import json
import re
import sys

from cdp import evaluate

GRAB = """(() => {
  const doc = document.documentElement.cloneNode(true);
  for (const s of doc.querySelectorAll("script, #steam-glass-theme, #gg-null, #gg-night, #gg-aero, #gg-liquid")) s.remove();
  return JSON.stringify({ html: "<!doctype html>\\n" + doc.outerHTML, size: [innerWidth, innerHeight], dpr: devicePixelRatio,
                          body: document.body.className, title: document.title });
})()"""


def main():
    title, out = sys.argv[1], sys.argv[2]
    got = json.loads(evaluate(title, GRAB))
    html = got["html"]
    html = re.sub(r"<head([^>]*)>", lambda m: f"<head{m.group(1)}><meta charset=\"utf-8\">"
                  f"<!-- snapshot of {got['title']!r}: {got['size'][0]}x{got['size'][1]} @ {got['dpr']} -->", html, count=1)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"{out}: {len(html) >> 10} KB, window {got['size'][0]}x{got['size'][1]} @ {got['dpr']}, body class {got['body']!r}")


if __name__ == "__main__":
    main()
