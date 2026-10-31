"""Generate the window-glass CSS: DiscTray's double rim and conic rim glints along
the window outline, the wet gloss band clipped to it, and (clear glass) a mask
that cuts the page itself to DiscTray's squircle.

Writes two sections: frosted (in libraryroot.custom.css: Windows rounds the
window 8px, so the outline is a circle arc, n = 2) and glass-clear.css (the
helper leaves the window square and clear, the page cuts its own squircle,
n = 4, 44px corners, 14px for menus)."""
import math
import sys
from urllib.parse import quote

MAIN, DIALOG, MENU = "._1ENHEsrSLcTRtPQFl1F-wL", "body.ModalDialogBody", "body.ContextMenuPopupBody"
FRIENDS = "html.friendsui-container body"   # friends list and chat windows


def quarter(n, steps=32):
    e = 2.0 / n
    return [(math.cos(k * math.pi / 2 / steps) ** e, math.sin(k * math.pi / 2 / steps) ** e) for k in range(steps + 1)]


def curve(c, n, inset):
    r = c - inset
    return [(c - r * co, c - r * si) for co, si in quarter(n)]


def svg_url(c, body):
    s = f"<svg xmlns='http://www.w3.org/2000/svg' width='{c}' height='{c}' viewBox='0 0 {c} {c}'>{body}</svg>"
    return "url(\"data:image/svg+xml," + quote(s, safe="/:=' ") + "\")"


CORNERS = (("left top", "1 0 0 1 0 0"), ("right top", "-1 0 0 1 {c} 0"),
           ("right bottom", "-1 0 0 -1 {c} {c}"), ("left bottom", "1 0 0 -1 0 {c}"))


def d(pts, close=False):
    return "M" + " L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + (" Z" if close else "")


def rim_mask(c, n, double=True):
    """The double rim: 1px stroke along the outline, a fainter one 2.5px inside
    (only the outer one when not `double`: DiscTray's plain glass edge)."""
    layers = []
    for pos, m in CORNERS:
        inner = f"<path d='{d(curve(c, n, 2.5))}' stroke-opacity='0.36'/>" if double else ""
        body = (f"<g transform='matrix({m.format(c=c)})' fill='none' stroke='black' stroke-width='1'>"
                f"<path d='{d(curve(c, n, 0.5))}'/>{inner}</g>")
        layers.append(f"{svg_url(c, body)} {pos} / {c}px {c}px no-repeat")
    solid, faint = "linear-gradient(#000, #000)", "linear-gradient(rgba(0,0,0,.36), rgba(0,0,0,.36))"
    span = f"calc(100% - {2 * c}px)"
    for edge, size in (("top", f"{span} 1px"), ("bottom", f"{span} 1px")):
        layers.append(f"{solid} left {c}px {edge} 0 / {size} no-repeat")
        if double:
            layers.append(f"{faint} left {c}px {edge} 2px / {size} no-repeat")
    for edge, size in (("left", f"1px {span}"), ("right", f"1px {span}")):
        layers.append(f"{solid} {edge} 0 top {c}px / {size} no-repeat")
        if double:
            layers.append(f"{faint} {edge} 2px top {c}px / {size} no-repeat")
    return ",\n    ".join(layers)


def fill_mask(c, n):
    """The whole outline filled: everything outside the corner curves is cut away."""
    layers = []
    for pos, m in CORNERS:
        pts = curve(c, n, 0) + [(c, c)]
        body = f"<g transform='matrix({m.format(c=c)})'><path d='{d(pts, True)}' fill='black'/></g>"
        layers.append(f"{svg_url(c, body)} {pos} / {c}px {c}px no-repeat")
    layers.append(f"linear-gradient(#000, #000) left {c}px top 0 / calc(100% - {2 * c}px) 100% no-repeat")
    layers.append(f"linear-gradient(#000, #000) left 0 top {c}px / 100% calc(100% - {2 * c}px) no-repeat")
    return ",\n    ".join(layers)


def glints(rim=2.0):
    # DiscTray paint_glass_edge stops, Qt conical (0 = east, counter-clockwise) -> CSS (0 = north, clockwise)
    qt = ((0.0, 0), (0.24, 40), (0.33, 150), (0.375, 210), (0.42, 150), (0.52, 30), (0.62, 0),
          (0.82, 0), (0.86, 70), (0.875, 110), (0.89, 70), (0.93, 0), (1.0, 0))
    stops = sorted({(90 - 360 * p) % 360: min(255, a * rim) for p, a in qt}.items())
    stops = [(0.0, stops[-1][1])] + stops + [(360.0, stops[0][1])]
    return "conic-gradient(" + ", ".join(f"rgba(255, 255, 255, {a / 255:.2f}) {ang:.1f}deg" for ang, a in stops) + ")"


def frosted(friends=False):
    if friends:
        return frosted_friends()
    return f"""/* ------------------------------------------------------------- the window as one glass card */

/* Like DiscTray's card surface, layered over everything in each window: the
   bright double rim with its glints, a wet gloss band over the top with a
   sparkle in the corner (the bounce light from the bottom edge is part of
   --gg-backdrop). Frosted glass: Windows rounds the window 8px, so the rim
   follows that. glass-clear.css swaps in DiscTray's squircle.
   The corner pieces are generated SVG (gen_rim.py). */
{MAIN} {{ position: relative; border-color: transparent !important; }}

{MAIN}::after,
{DIALOG}::after,
{MENU}::after {{
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background: {glints()}, linear-gradient(rgba(255, 255, 255, 0.50), rgba(255, 255, 255, 0.50));
  -webkit-mask:
    {rim_mask(8, 2)};
}}

/* wet gloss: an ellipse hanging from above the window, crisp along its lower
   edge; its top corners follow the window's */
{MAIN}::before,
{DIALOG}::before {{
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 96px;
  z-index: 2147482999;
  pointer-events: none;
  border-radius: 8px 8px 0 0;
  background:
    radial-gradient(16px 16px at 22px 18px, rgba(255, 255, 255, 0.60), transparent 100%) no-repeat,
    linear-gradient(rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.10) 62%, rgba(255, 255, 255, 0.04));
  -webkit-mask: radial-gradient(98% 136px at 50% -40px, #000 99.2%, transparent 100%);
}}
"""


def clear():
    return f"""/* Glossy Glass: clear glass option.
   The Steam Glass helper (mode "clear") leaves the windows square and fully
   see-through without blur; the page cuts itself to DiscTray's squircle
   (n = 4, 44px corners, 14px for menus) with smooth edges, the rim follows the
   same curve, and the tint is stronger so text stays readable over the desktop.
   Generated by gen_rim.py. */

:root {{
  --gg-tint: rgba(8, 10, 22, 0.46);
  --gg-backdrop:
    radial-gradient(70% 90px at 50% calc(100% + 24px), rgba(255, 255, 255, 0.16), transparent 100%),
    radial-gradient(38% 30% at 12% 8%, rgba(110, 200, 255, 0.30), transparent 70%),
    radial-gradient(34% 32% at 88% 14%, rgba(160, 110, 255, 0.24), transparent 70%),
    radial-gradient(46% 40% at 72% 96%, rgba(0, 210, 190, 0.20), transparent 70%),
    linear-gradient(160deg, rgba(11, 27, 60, 0.74) 0%, rgba(18, 48, 94, 0.62) 42%, rgba(14, 23, 54, 0.74) 100%);
}}

/* cut the page to the squircle: everything outside the curve is see-through */
{MAIN},
{DIALOG},
{FRIENDS} {{
  -webkit-mask:
    {fill_mask(44, 4)};
}}
{MENU} {{
  -webkit-mask:
    {fill_mask(14, 4)};
}}

{MAIN}::after,
{DIALOG}::after,
{FRIENDS}::after {{
  -webkit-mask:
    {rim_mask(44, 4)};
}}
{MENU}::after {{
  -webkit-mask:
    {rim_mask(14, 4)};
}}
{MAIN}::before,
{DIALOG}::before,
{FRIENDS}::before {{ border-radius: 0; }}   /* the page mask cuts the gloss to the squircle */
"""


def frosted_friends():
    """The same window glass for friends.custom.css (Millennium loads only that file there)."""
    return f"""/* ------------------------------------------------------------- the window as one glass card */

/* Generated by gen_rim.py: see libraryroot.custom.css for what these layers are. */
{FRIENDS}::after {{
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background: {glints()}, linear-gradient(rgba(255, 255, 255, 0.50), rgba(255, 255, 255, 0.50));
  -webkit-mask:
    {rim_mask(8, 2)};
}}
{FRIENDS}::before {{
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 96px;
  z-index: 2147482999;
  pointer-events: none;
  border-radius: 8px 8px 0 0;
  background:
    radial-gradient(16px 16px at 22px 18px, rgba(255, 255, 255, 0.60), transparent 100%) no-repeat,
    linear-gradient(rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.10) 62%, rgba(255, 255, 255, 0.04));
  -webkit-mask: radial-gradient(98% 136px at 50% -40px, #000 99.2%, transparent 100%);
}}
"""


def liquid():
    """Window edge for the Liquid option: DiscTray's plain glass edge (rim 1.0,
    no inner rim) and no gloss band; the water itself is liquid.js."""
    return f"""/* ------------------------------------------------------------- liquid window edge (generated by gen_rim.py) */
{MAIN}::after,
{DIALOG}::after,
{MENU}::after,
{FRIENDS}::after {{
  background: {glints(1.0)}, linear-gradient(rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.25)) !important;
  -webkit-mask:
    {rim_mask(8, 2, double=False)} !important;
}}
{MAIN}::before,
{DIALOG}::before,
{FRIENDS}::before {{ display: none !important; }}
"""


if __name__ == "__main__":
    which = sys.argv[1]
    sys.stdout.write({"frosted": frosted, "friends": lambda: frosted(friends=True),
                      "clear": clear, "liquid": liquid}[which]())
