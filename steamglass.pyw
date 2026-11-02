"""Steam Glass helper: gives Steam's windows real see-through glass.

The Glossy Glass theme makes Steam's pages transparent; this helper loads it into
Steam and tells Windows what to show behind the pages.

The theme goes in through Steam's own local developer port (Chromium remote
debugging on 127.0.0.1:8080), which Steam opens when its folder holds an empty
.cef-enable-remote-debugging file; the helper creates that file, and Steam reads
it when it starts. Every Steam page gets the theme's CSS (plus Liquid's script in
the main and friends windows), put back when a page reloads or the glass changes.
No Millennium needed.

It watches for Steam windows (main window, friends,
settings, menus) and treats each one as it appears. The kind of glass is picked
in glass-mode.txt next to this file (changes apply live):

  frosted  a dark acrylic blur of whatever is behind the window (DWM system
           backdrop, Windows 11 22H2+). Windows only rounds this 8px: the blur
           ignores window shapes, so DiscTray's squircle cannot be cut into it.
  clear    no blur, fully see-through; the window is cut to DiscTray's squircle
           (pair with the theme's "Clear" glass option, which draws the curve).
  liquid   frosted glass for the theme's "Liquid" option (water that sloshes).
  nullscapes  the Geometry Dash level "Nullscapes Background" plays behind smoky
           glass, live, with the level player gdscene.js (nullscapes-live.js).
  eternalnight  the Geometry Dash level "Eternal Night" plays from start to end,
           over and over, behind the same smoky glass (eternal-night-live.js).
           Both levels ship as data only (skin\levels\): their pictures are
           Geometry Dash's own sprite sheets, taken from this PC's copy of the game
           (see built_level), and their songs are the ones GD downloaded. So they're
           offered when Geometry Dash is installed through Steam. A level exported
           by hand into the settings folder's <level>\live\ wins over that, and
           Nullscapes falls back on two recorded scenes (nullscapes.js).
  aero     Frutiger Aero: a sunny panorama pans by behind blue glass panels.
           aero.js draws a glass city, lakes and fields, or pans a picture:
           yours (tray > Aero picture > Choose a picture…, kept as
           my-aero-picture.jpg in the settings folder) or the theme's own
           aero-picture.jpg if it has one.
  off      Steam's own windows.

A tray icon switches between them (it writes glass-mode.txt). Its "Song toggle"
plays or mutes the GD levels' songs (nullscapes-music.mp3, eternal-night-music.mp3
in their folders). Quitting it puts
Steam back to normal. Run with pythonw (no console). `--off` puts every Steam
window back to normal without starting the helper.

Installed builds (SteamGlass.exe, put there by SteamGlassUpdater.exe) keep
glass-mode.txt in %APPDATA%\SteamGlass and add "Check for updates…" to the menu.
"Start with Windows" in the menu adds or removes the helper under the Run key."""
__version__ = "1.3.1"

import base64
import ctypes
import gzip
import hashlib
import json
import math
import os
import plistlib
import re
import shutil
import socket
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
from ctypes import wintypes as wt

user32 = ctypes.WinDLL("user32", use_last_error=True)
dwm = ctypes.WinDLL("dwmapi")
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32")
gdi32.CreatePolygonRgn.restype = wt.HRGN
gdi32.CreatePolygonRgn.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
gdi32.CreateRectRgn.restype = wt.HRGN
gdi32.DeleteObject.argtypes = [wt.HGDIOBJ]
user32.SetWindowRgn.argtypes = [wt.HWND, wt.HRGN, wt.BOOL]
user32.GetWindowRgnBox.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWA_SYSTEMBACKDROP_TYPE = 38
DWMWCP_DEFAULT, DWMWCP_DONOTROUND, DWMWCP_ROUND = 0, 1, 2
DWMWA_COLOR_DEFAULT, DWMWA_COLOR_NONE = 0xFFFFFFFF, 0xFFFFFFFE
DWMSBT_AUTO, DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW = 0, 1, 3   # transient window = acrylic
DWM_BB_ENABLE, DWM_BB_BLURREGION = 1, 2
GWL_STYLE = -16
WS_SYSMENU, WS_CAPTION = 0x00080000, 0x00C00000
SWP_REFRESH = 0x0001 | 0x0002 | 0x0004 | 0x0020   # NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SKIP_TITLES = {"Steam Big Picture Mode"}   # the theme does not style Big Picture
SQUIRCLE_N = 4.0   # DiscTray's corner superellipse exponent
CORNER = 44        # DiscTray's card corner extent; windows with a caption (main, dialogs)
MENU_CORNER = 14   # popup menus
FROZEN = getattr(sys, "frozen", False)   # the installed SteamGlass.exe
HERE = os.path.dirname(sys.executable if FROZEN else os.path.abspath(__file__))
SETTINGS_DIR = os.path.join(os.environ.get("APPDATA", HERE), "SteamGlass") if FROZEN else HERE
MODE_FILE = os.path.join(SETTINGS_DIR, "glass-mode.txt")
UPDATER = os.path.join(HERE, "SteamGlassUpdater.exe")   # only next to an installed build
PIPE = "SteamGlass-" + os.environ.get("USERNAME", "user")   # the updater asks us to quit through it
THEME_DIR = os.path.join(HERE, "skin") if FROZEN else HERE   # the installer unpacks the theme to skin/
CEF_PORT = 8080   # Steam's developer port, on 127.0.0.1 only
CEF_FLAG = ".cef-enable-remote-debugging"   # in Steam's folder: Steam opens the port when it starts
STYLE_ID = "steam-glass-theme"
SCENE_WINDOWS = {"Steam", "Friends List"}   # Liquid's water and Aero's panorama run in these
SCENE_SCRIPTS = {"liquid": "liquid.js", "aero": "aero.js", "nullscapes": "nullscapes.js"}
NULL_DIR = os.path.join(SETTINGS_DIR, "nullscapes")   # nullscapes-mountains.mp4, nullscapes-moon.mp4
NULL_VIDEOS = ("mountains", "moon")
# The GD levels, played live by gdscene.js: mode -> (folder, its own song file, the song's Newgrounds id).
# A level comes from your own export, <settings>\<folder>\live\ (level.json, camera.json and
# sheets\<GD sprite sheet>.png), or else from the theme's copy of its data (skin\levels\<folder>\
# level.json.gz, camera.json) put together with this PC's Geometry Dash in <settings>\built\<folder>\.
# Its song is <settings>\<folder>\<song file>, or the copy GD downloaded (%LOCALAPPDATA%\GeometryDash\<id>.mp3).
LEVELS = {"nullscapes": ("nullscapes", "nullscapes-music.mp3", "1132447"),
          "eternalnight": ("eternal-night", "eternal-night-music.mp3", "153668")}
LEVEL_MODES = tuple(LEVELS)
LEVEL_DATA = os.path.join(THEME_DIR, "levels")
BUILT_DIR = os.path.join(SETTINGS_DIR, "built")
GD_APP = "322170"   # Geometry Dash's Steam app id
SONG_SETTING = os.path.join(SETTINGS_DIR, "nullscapes-music.txt")   # "on" / "off": the songs (the name is from 1.2.0)


def level_music(mode: str):
    """The level's song: your own copy, or the one Geometry Dash downloaded; None if neither."""
    folder, own, song_id = LEVELS[mode]
    for path in (os.path.join(SETTINGS_DIR, folder, own),
                 os.path.join(os.environ.get("LOCALAPPDATA", ""), "GeometryDash", song_id + ".mp3")):
        if os.path.isfile(path):
            return path
    return None


def song_on(mode: str) -> bool:
    if not level_music(mode):
        return False
    try:
        with open(SONG_SETTING, encoding="utf-8") as f:
            return f.read().strip().lower() != "off"
    except OSError:
        return True


def set_song(on: bool):
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(SONG_SETTING, "w", encoding="utf-8") as f:
        f.write("on\n" if on else "off\n")
PICTURE = "aero-picture.jpg"        # the theme's own panorama picture, in THEME_DIR
MY_PICTURE = "my-aero-picture.jpg"   # the one you chose, in SETTINGS_DIR
PICTURE_HEIGHT = 1440          # pictures are scaled down to this height to keep them quick to send
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "SteamGlass"


class MARGINS(ctypes.Structure):
    _fields_ = [("l", ctypes.c_int), ("r", ctypes.c_int), ("t", ctypes.c_int), ("b", ctypes.c_int)]


class DWM_BLURBEHIND(ctypes.Structure):
    _fields_ = [("dwFlags", wt.DWORD), ("fEnable", wt.BOOL), ("hRgnBlur", wt.HRGN), ("fTransitionOnMaximized", wt.BOOL)]


EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.restype = ctypes.c_long


MODES = {"frosted": "Frosted", "clear": "Clear", "liquid": "Liquid", "aero": "Frutiger Aero", "nullscapes": "Nullscapes",
         "eternalnight": "Eternal Night", "off": "Off (Steam's normal look)"}
FROSTED_LIKE = ("frosted", "liquid", "aero", "nullscapes", "eternalnight")   # glass kinds Windows draws as frosted


_sheets_of = {}   # level.json path -> (its mtime, its sheet names): the files are big, so each is read once


def live_files(folder):
    """[(name, path, type)] a live level in `folder` needs, or None when any is missing."""
    path = os.path.join(folder, "level.json")
    try:
        mtime = os.path.getmtime(path)
        if _sheets_of.get(path, (None,))[0] != mtime:
            with open(path, encoding="utf-8") as f:
                _sheets_of[path] = (mtime, json.load(f).get("sheets", []))
        sheets = _sheets_of[path][1]
    except (OSError, ValueError):
        return None
    files = [("level", path, "application/json"), ("camera", os.path.join(folder, "camera.json"), "application/json")]
    files += [("sheet:" + n, os.path.join(folder, "sheets", n + ".png"), "image/png")
              for n in sheets if not n.startswith("gd:")]   # gd: textures are drawn by the script
    return files if all(os.path.isfile(p) for _, p, _ in files) else None


_gd = [0.0, None]   # when Geometry Dash was last looked for, and its Resources folder


def gd_resources():
    """This PC's Geometry Dash Resources folder (its Steam copy, in any Steam library), or None.
    Looked up at most once a minute."""
    if time.time() - _gd[0] < 60:
        return _gd[1]
    found, steam = None, steam_dir()
    libraries = [steam] if steam else []
    try:
        with open(os.path.join(steam, "steamapps", "libraryfolders.vdf"), encoding="utf-8") as f:
            libraries += [p.replace("\\\\", "\\") for p in re.findall(r'"path"\s+"([^"]+)"', f.read())]
    except (OSError, TypeError):
        pass
    for library in libraries:
        try:
            with open(os.path.join(library, "steamapps", f"appmanifest_{GD_APP}.acf"), encoding="utf-8") as f:
                folder = re.search(r'"installdir"\s+"([^"]+)"', f.read())
        except OSError:
            continue
        res = os.path.join(library, "steamapps", "common", folder.group(1) if folder else "Geometry Dash", "Resources")
        if os.path.isfile(os.path.join(res, "GJ_GameSheet-uhd.png")):
            found = res
            break
    _gd[:] = [time.time(), found]
    return found


_building = threading.Lock()


def built_level(mode):
    """The level put together from the theme's copy of its data and this PC's Geometry Dash, in
    <settings>\\built\\<folder>\\: GD's own sprite sheets, with the level's frame table rebuilt
    from GD's own plists by sprite name, so another GD version (or a texture pack that replaced GD's
    files) still lines up. Done once, and again when the theme's data or GD's sheets change.
    Returns its folder, or None."""
    name = LEVELS[mode][0]
    src, res = os.path.join(LEVEL_DATA, name), gd_resources()
    data_path, out = os.path.join(src, "level.json.gz"), os.path.join(BUILT_DIR, name)
    if not res or not os.path.isfile(data_path):
        return None
    number = re.compile(r"-?\d+(?:\.\d+)?")
    with _building:
        try:
            stamp = json.dumps([os.path.getmtime(data_path), os.path.getmtime(os.path.join(src, "camera.json")), res,
                                os.path.getmtime(os.path.join(res, "GJ_GameSheet-uhd.plist"))])
            try:
                with open(os.path.join(out, "stamp.json"), encoding="utf-8") as f:
                    if f.read() == stamp and live_files(out):
                        return out
            except OSError:
                pass
            with gzip.open(data_path, "rt", encoding="utf-8") as f:
                data = json.load(f)
            sheets, here = data["sheets"], {}
            for i, sheet in enumerate(sheets):
                plist = os.path.join(res, sheet + "-uhd.plist")
                if sheet.startswith("gd:") or not os.path.isfile(plist):
                    continue   # drawn by the script, or a picture without frames (font, background, ground)
                with open(plist, "rb") as f:
                    for frame, fr in plistlib.load(f).get("frames", {}).items():
                        x, y, w, h = (float(v) for v in number.findall(fr["textureRect"]))
                        ox, oy = (float(v) for v in number.findall(fr["spriteOffset"]))
                        here.setdefault(frame, [i, int(x), int(y), int(w), int(h), 1 if fr.get("textureRotated") else 0, ox, oy])
            for frame, f in data["frames"].items():
                if frame in here and not sheets[f[0]].startswith("gd:"):
                    data["frames"][frame] = here[frame] + f[8:]   # where this GD keeps it; the rest is the level's own
            os.makedirs(os.path.join(out, "sheets"), exist_ok=True)
            for sheet in sheets:
                if not sheet.startswith("gd:"):
                    shutil.copyfile(os.path.join(res, sheet + "-uhd.png"), os.path.join(out, "sheets", sheet + ".png"))
            shutil.copyfile(os.path.join(src, "camera.json"), os.path.join(out, "camera.json"))
            with open(os.path.join(out, "level.json"), "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            with open(os.path.join(out, "stamp.json"), "w", encoding="utf-8") as f:
                f.write(stamp)
            return out if live_files(out) else None
        except (OSError, ValueError, KeyError, IndexError):
            return None


def nullscapes_videos_ready() -> bool:
    return all(os.path.isfile(os.path.join(NULL_DIR, f"nullscapes-{n}.mp4")) for n in NULL_VIDEOS)


def level_files(mode):
    """What a GD level mode streams into Steam: your own export, or the level put together with
    this PC's Geometry Dash, or Nullscapes' recordings; None when there's none of them."""
    own = live_files(os.path.join(SETTINGS_DIR, LEVELS[mode][0], "live"))
    if own:
        return own
    built = built_level(mode)
    if built:
        return live_files(built)
    if mode == "nullscapes" and nullscapes_videos_ready():
        return [(n, os.path.join(NULL_DIR, f"nullscapes-{n}.mp4"), "video/mp4") for n in NULL_VIDEOS]
    return None


def mode_ready(mode: str) -> bool:
    """Every mode but the GD levels is always there. Those need your own export, or the theme's
    copy of the level and Geometry Dash on this PC (checked without building anything)."""
    if mode not in LEVELS:
        return True
    folder = LEVELS[mode][0]
    return bool(live_files(os.path.join(SETTINGS_DIR, folder, "live"))
                or (gd_resources() and os.path.isfile(os.path.join(LEVEL_DATA, folder, "level.json.gz")))
                or (mode == "nullscapes" and nullscapes_videos_ready()))


def read_mode() -> str:
    try:
        with open(MODE_FILE, encoding="utf-8") as f:
            word = f.read().strip().lower()
    except OSError:
        return "frosted"
    return word if word in MODES else "frosted"


def write_mode(mode: str):
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    with open(MODE_FILE, "w", encoding="utf-8") as f:
        f.write(mode + "\n")


def exe_name(hwnd) -> str:
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(520)
        n = wt.DWORD(len(buf))
        ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n))
        return buf.value.rsplit("\\", 1)[-1].lower() if ok else ""
    finally:
        kernel32.CloseHandle(h)


def title(hwnd) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def steam_windows():
    found = []

    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd) and exe_name(hwnd) == "steamwebhelper.exe" and title(hwnd) not in SKIP_TITLES:
            found.append(hwnd)
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    return found


def dword_attr(hwnd, attr, value):
    v = wt.DWORD(value)
    dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(v), 4)


def set_sysmenu(hwnd, on: bool):
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    if not style & WS_CAPTION:
        return
    # with the frame extended over the whole window, DWM paints its own caption
    # buttons behind Steam's; without the system menu style it leaves them out
    new = style | WS_SYSMENU if on else style & ~WS_SYSMENU
    if new != style:
        user32.SetWindowLongW(hwnd, GWL_STYLE, new)
        user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_REFRESH)


def has_region(hwnd) -> bool:
    return user32.GetWindowRgnBox(hwnd, ctypes.byref(wt.RECT())) > 1   # SIMPLEREGION or COMPLEXREGION


def drifted(hwnd, mode: str) -> bool:
    """Whether a window lost its glass. Steam rebuilds its window style when it
    resizes or restores a window, which brings the system menu back; on frosted
    glass DWM then paints its own caption buttons and frame into the glass along
    the edges. And a clear-glass cut must never outlive clear mode: a window
    hidden during the switch would keep it, clipped to its old size and with its
    real edges (where you resize it) cut away."""
    if mode != "clear" and has_region(hwnd):
        return True
    if mode not in FROSTED_LIKE:
        return False
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    return bool(style & WS_CAPTION) and bool(style & WS_SYSMENU)


def blur_behind(hwnd, on: bool):
    """With an empty blur region this blurs nothing: it only makes DWM honour the
    page's transparency, so a clear window shows the desktop as it is."""
    rgn = gdi32.CreateRectRgn(0, 0, -1, -1)
    bb = DWM_BLURBEHIND(DWM_BB_ENABLE | DWM_BB_BLURREGION, on, rgn, False)
    dwm.DwmEnableBlurBehindWindow(hwnd, ctypes.byref(bb))
    gdi32.DeleteObject(rgn)


def apply(hwnd, mode: str):
    """mode: one of MODES ("off" is Steam's own look)."""
    if mode != "off":
        dword_attr(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    if mode in FROSTED_LIKE:   # Liquid's water and Aero's scene sit behind frosted glass
        mode = "frosted"
    frosted = mode == "frosted"
    set_sysmenu(hwnd, not frosted)
    n = -1 if frosted else 0
    dwm.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(MARGINS(n, n, n, n)))
    dword_attr(hwnd, DWMWA_SYSTEMBACKDROP_TYPE,
               {"frosted": DWMSBT_TRANSIENTWINDOW, "clear": DWMSBT_NONE}.get(mode, DWMSBT_AUTO))
    blur_behind(hwnd, mode == "clear")
    dword_attr(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
               {"frosted": DWMWCP_ROUND, "clear": DWMWCP_DONOTROUND}.get(mode, DWMWCP_DEFAULT))
    dword_attr(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE if mode == "clear" else DWMWA_COLOR_DEFAULT)
    if mode != "clear" and has_region(hwnd):   # clear glass cuts its own shape (set_shape)
        user32.SetWindowRgn(hwnd, None, True)


def squircle_points(w: int, h: int, corner: float, n: float = SQUIRCLE_N, steps: int = 24):
    """Outline of DiscTray's squircle card (quarter superellipses |x|^n + |y|^n = 1
    in each corner, flowing into the straight edges) as integer polygon points."""
    c = max(0.0, min(corner, w / 2, h / 2))
    e = 2.0 / n
    quarter = [(math.cos(k * math.pi / 2 / steps) ** e, math.sin(k * math.pi / 2 / steps) ** e)
               for k in range(steps + 1)]
    pts = []
    for co, si in quarter:                       # top-right
        pts.append((w - c + c * si, c - c * co))
    for co, si in quarter:                       # bottom-right
        pts.append((w - c + c * co, h - c + c * si))
    for co, si in quarter:                       # bottom-left
        pts.append((c - c * si, h - c + c * co))
    for co, si in quarter:                       # top-left
        pts.append((c - c * co, c - c * si))
    return [(round(x), round(y)) for x, y in pts]


def set_shape(hwnd, size):
    """Clear glass: cut the window to the squircle, so clicks in the see-through
    corners reach the desktop (the page draws the smooth curve itself). Square
    when maximized or in the other modes."""
    if size is None or user32.IsZoomed(hwnd):
        user32.SetWindowRgn(hwnd, None, True)
        return
    w, h = size
    corner = CORNER if user32.GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION else MENU_CORNER
    pts = squircle_points(w, h, corner)
    arr = (wt.POINT * len(pts))(*[wt.POINT(x, y) for x, y in pts])
    rgn = gdi32.CreatePolygonRgn(arr, len(pts), 2)   # WINDING
    if rgn and not user32.SetWindowRgn(hwnd, rgn, True):
        gdi32.DeleteObject(rgn)   # the system owns the region only when the call succeeds


def window_size(hwnd):
    r = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return (r.right - r.left, r.bottom - r.top, bool(user32.IsZoomed(hwnd)))


def restore_all():
    for hwnd in steam_windows():
        apply(hwnd, "off")
        set_shape(hwnd, None)


class Glass:
    """Keeps every Steam window in the chosen mode. tick() runs every 30ms."""

    def __init__(self):
        self.mode = None
        self.shapes = {}   # hwnd -> (w, h, zoomed) its region was cut for (clear glass)
        self.last_scan = 0.0

    def tick(self):
        now = time.monotonic()
        if now - self.last_scan > 0.5:   # look for new windows and a mode change twice a second
            self.last_scan = now
            want = read_mode()
            if want != self.mode:   # switch: treat every window again
                self.mode = want
                for hwnd in self.shapes:
                    set_shape(hwnd, None)
                self.shapes.clear()
            alive = set(steam_windows())
            for hwnd in alive - self.shapes.keys():
                apply(hwnd, self.mode)
                self.shapes[hwnd] = None
            for hwnd in alive & self.shapes.keys():
                if drifted(hwnd, self.mode):   # Steam reset its frame: put the glass back
                    apply(hwnd, self.mode)
            for hwnd in self.shapes.keys() - alive:   # closed or hidden: treat again if it comes back
                del self.shapes[hwnd]
        if self.mode == "clear":
            for hwnd, cut in list(self.shapes.items()):   # follow resizes quickly
                size = window_size(hwnd)
                if size and size != cut:
                    set_shape(hwnd, size[:2])
                    self.shapes[hwnd] = size


def tray_icon(mode: str, sizes=(16, 20, 24, 32, 48, 64)):
    """A little glossy glass squircle: deep blue when frosted, clear with a blue
    rim when clear, Liquid's teal sky with a wave of water when liquid, a
    sunny sky over a green hill when aero, the moon over spiky grass for
    Nullscapes, a crescent moon and stars for Eternal Night, grey when off."""
    from PySide6.QtCore import QPointF, QRectF, Qt
    from PySide6.QtGui import QColor, QIcon, QLinearGradient, QPainter, QPainterPath, QPen, QPixmap, QRadialGradient

    icon = QIcon()
    for px in sizes:
        pm = QPixmap(px, px)
        pm.fill(Qt.transparent)
        p = QPainter(pm)
        p.setRenderHint(QPainter.Antialiasing)
        s = px / 64
        inset = 3 * s
        body = QPainterPath()
        pts = squircle_points_f(px - 2 * inset, px - 2 * inset, 22 * s)
        body.moveTo(pts[0][0] + inset, pts[0][1] + inset)
        for x, y in pts[1:]:
            body.lineTo(x + inset, y + inset)
        body.closeSubpath()
        fill = QLinearGradient(0, 0, 0, px)
        if mode == "liquid":   # DiscTray's Liquid sky, a bit stronger to read at icon size
            for at, rgba in ((0.0, (70, 160, 172, 235)), (0.45, (150, 170, 182, 225)), (1.0, (36, 38, 44, 235))):
                fill.setColorAt(at, QColor(*rgba))
        elif mode == "nullscapes":   # night sky
            for at, rgba in ((0.0, (24, 38, 50, 255)), (1.0, (8, 12, 18, 255))):
                fill.setColorAt(at, QColor(*rgba))
        elif mode == "eternalnight":   # a deeper, violet night
            for at, rgba in ((0.0, (46, 28, 78, 255)), (1.0, (10, 8, 24, 255))):
                fill.setColorAt(at, QColor(*rgba))
        elif mode == "aero":   # Aero's sky, deep blue overhead and pale at the horizon
            for at, rgba in ((0.0, (11, 95, 207, 255)), (0.6, (110, 190, 250, 255)), (1.0, (200, 235, 255, 255))):
                fill.setColorAt(at, QColor(*rgba))
        else:
            top, bottom = {"frosted": ((70, 160, 255, 235), (20, 60, 150, 235)),
                           "clear": ((120, 200, 255, 90), (40, 110, 200, 70)),
                           "off": ((150, 156, 166, 230), (80, 86, 96, 230))}[mode]
            fill.setColorAt(0, QColor(*top))
            fill.setColorAt(1, QColor(*bottom))
        p.fillPath(body, fill)
        if mode == "nullscapes":   # the moon over spiky grass
            p.save()
            p.setClipPath(body)
            glow = QRadialGradient(QPointF(px * 0.5, px * 0.58), px * 0.42)
            glow.setColorAt(0, QColor(250, 250, 245, 255)); glow.setColorAt(0.55, QColor(250, 250, 245, 255))
            glow.setColorAt(0.6, QColor(120, 140, 160, 120)); glow.setColorAt(1, QColor(60, 80, 100, 0))
            p.fillRect(QRectF(0, 0, px, px), glow)
            grass = QPainterPath()
            grass.moveTo(0, px)
            for k in range(9):
                grass.lineTo(px * (k + 0.5) / 8.5, px * (0.5 + 0.12 * (k % 3)))
                grass.lineTo(px * (k + 1) / 8.5, px * 0.8)
            grass.lineTo(px, px)
            grass.closeSubpath()
            p.fillPath(grass, QColor(14, 20, 28))
            p.restore()
        elif mode == "eternalnight":   # a crescent moon and a few stars
            p.save()
            p.setClipPath(body)
            p.setPen(Qt.NoPen)
            moon = QPainterPath()
            moon.addEllipse(QPointF(px * 0.56, px * 0.5), px * 0.26, px * 0.26)
            bite = QPainterPath()
            bite.addEllipse(QPointF(px * 0.68, px * 0.42), px * 0.23, px * 0.23)
            p.fillPath(moon.subtracted(bite), QColor(244, 238, 255))
            p.setBrush(QColor(255, 255, 255, 220))
            for cx, cy, r in ((0.24, 0.26, 0.035), (0.3, 0.7, 0.025), (0.82, 0.76, 0.03), (0.78, 0.2, 0.022)):
                p.drawEllipse(QPointF(px * cx, px * cy), px * r, px * r)
            p.restore()
        elif mode == "aero":
            p.save()
            p.setClipPath(body)
            sun = QRadialGradient(QPointF(px * 0.74, px * 0.24), px * 0.34)
            sun.setColorAt(0, QColor(255, 255, 245, 255))
            sun.setColorAt(0.25, QColor(255, 250, 220, 200))
            sun.setColorAt(1, QColor(255, 255, 255, 0))
            p.fillRect(QRectF(0, 0, px, px), sun)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255, 235))   # a puffy cloud
            for cx, cy, r in ((0.26, 0.42, 0.11), (0.38, 0.36, 0.14), (0.5, 0.43, 0.1)):
                p.drawEllipse(QPointF(px * cx, px * cy), px * r, px * r)
            hill = QPainterPath()
            hill.moveTo(0, px * 0.7)
            hill.cubicTo(px * 0.3, px * 0.52, px * 0.62, px * 0.6, px, px * 0.66)
            hill.lineTo(px, px)
            hill.lineTo(0, px)
            hill.closeSubpath()
            grass = QLinearGradient(0, px * 0.55, 0, px)
            grass.setColorAt(0, QColor(160, 232, 100))
            grass.setColorAt(1, QColor(50, 150, 45))
            p.fillPath(hill, grass)
            band = QPainterPath()
            band.addEllipse(QPointF(px / 2, -px * 0.22), px * 0.62, px * 0.66)
            gloss = QLinearGradient(0, 0, 0, px * 0.46)
            gloss.setColorAt(0, QColor(255, 255, 255, 150))
            gloss.setColorAt(1, QColor(255, 255, 255, 20))
            p.fillPath(band, gloss)
            p.restore()
        elif mode == "liquid":
            # a wave of clear water with Liquid's bright waterline (no gloss: Liquid has none)
            wave = QPainterPath()
            wave.moveTo(0, px * 0.56)
            wave.cubicTo(px * 0.3, px * 0.44, px * 0.6, px * 0.66, px, px * 0.52)
            water = QPainterPath(wave)
            water.lineTo(px, px)
            water.lineTo(0, px)
            water.closeSubpath()
            tint = QLinearGradient(0, px * 0.45, 0, px)
            tint.setColorAt(0, QColor(175, 228, 236, 110))
            tint.setColorAt(1, QColor(30, 45, 58, 200))
            p.fillPath(water.intersected(body), tint)
            p.save()
            p.setClipPath(body)
            p.setPen(QPen(QColor(255, 255, 255, 240), max(1.0, 2.4 * s)))
            p.drawPath(wave)
            p.restore()
        else:
            bounce = QRadialGradient(QPointF(px / 2, px * 1.05), px * 0.5)
            bounce.setColorAt(0, QColor(255, 255, 255, 80))
            bounce.setColorAt(1, QColor(255, 255, 255, 0))
            p.fillPath(body, bounce)
            band = QPainterPath()
            band.addEllipse(QPointF(px / 2, -px * 0.22), px * 0.62, px * 0.66)
            gloss = QLinearGradient(0, 0, 0, px * 0.46)
            gloss.setColorAt(0, QColor(255, 255, 255, 190))
            gloss.setColorAt(1, QColor(255, 255, 255, 40))
            p.fillPath(band.intersected(body), gloss)
        rim = QColor(150, 215, 255) if mode == "clear" else QColor(255, 255, 255, 210)
        p.setPen(QPen(rim, max(1.0, 2.2 * s)))
        p.drawPath(body)
        p.end()
        icon.addPixmap(pm)
    return icon


def squircle_points_f(w: float, h: float, corner: float, n: float = SQUIRCLE_N, steps: int = 16):
    c = max(0.0, min(corner, w / 2, h / 2))
    e = 2.0 / n
    q = [(math.cos(k * math.pi / 2 / steps) ** e, math.sin(k * math.pi / 2 / steps) ** e) for k in range(steps + 1)]
    return ([(w - c + c * si, c - c * co) for co, si in q] + [(w - c + c * co, h - c + c * si) for co, si in q]
            + [(c - c * si, h - c + c * co) for co, si in q] + [(c - c * co, c - c * si) for co, si in q])


# --------------------------------------------------------------------------- theme

def steam_dir():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            path = os.path.normpath(winreg.QueryValueEx(k, "SteamPath")[0])
        return path if os.path.isdir(path) else None
    except OSError:
        return None


def enable_theme_port() -> bool:
    """Make sure Steam opens its developer port when it starts. True if the flag is there."""
    steam = steam_dir()
    if not steam:
        return False
    flag = os.path.join(steam, CEF_FLAG)
    try:
        if not os.path.exists(flag):
            open(flag, "w").close()
        return True
    except OSError:
        return False


def ws_eval(url: str, expression: str, timeout: float = 3.0):
    """Evaluate JavaScript in one Steam page over its DevTools WebSocket (a minimal
    RFC 6455 client: one masked text frame out, frames in until our reply)."""
    u = urllib.parse.urlparse(url)
    with socket.create_connection((u.hostname, u.port or 80), timeout) as sock:
        key = base64.b64encode(os.urandom(16)).decode()
        sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\n"
                      f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
                     .encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed during handshake")
            buf += chunk
        status, buf = buf.split(b"\r\n", 1)[0], buf.split(b"\r\n\r\n", 1)[1]
        if b" 101 " not in status:
            raise ConnectionError(status.decode(errors="replace"))

        payload = json.dumps({"id": 1, "method": "Runtime.evaluate",
                              "params": {"expression": expression, "returnByValue": True}}).encode()
        n = len(payload)
        frame = bytearray([0x81])   # FIN, text
        if n < 126:
            frame.append(0x80 | n)
        elif n < 65536:
            frame += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            frame += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        keys = (mask * (n // 4 + 1))[:n]   # mask the whole payload at once (it can be megabytes)
        frame += mask + (int.from_bytes(payload, "little") ^ int.from_bytes(keys, "little")).to_bytes(n, "little")
        sock.sendall(frame)

        def take(k):
            nonlocal buf
            while len(buf) < k:
                chunk = sock.recv(65536)
                if not chunk:
                    raise ConnectionError("closed")
                buf += chunk
            out, buf = buf[:k], buf[k:]
            return out

        message = b""
        while True:
            b0, b1 = take(2)
            size = b1 & 0x7F
            if size == 126:
                size = struct.unpack(">H", take(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", take(8))[0]
            data = take(size)
            if b0 & 0x0F not in (0x0, 0x1):
                continue   # ping/pong/binary: not ours
            message += data
            if b0 & 0x80:   # last fragment of a message
                reply, message = json.loads(message), b""
                if reply.get("id") == 1:
                    return reply.get("result", {}).get("result", {}).get("value")


class Theme:
    """Puts the theme into every Steam page and keeps it there. Runs on its own
    thread (Steam can be slow to answer); set `mode` to switch the glass."""

    def __init__(self):
        self.mode = read_mode()
        self.answered = False   # Steam has answered on its developer port
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    _picture = (None, None, None)   # (path, mtime, data url)

    def picture(self):
        """Aero's picture as a data URL: yours if you chose one, else the theme's, else None."""
        for path in (os.path.join(SETTINGS_DIR, MY_PICTURE), os.path.join(THEME_DIR, PICTURE)):
            try:
                mtime = os.path.getmtime(path)
            except OSError:
                continue
            if self._picture[:2] != (path, mtime):
                with open(path, "rb") as f:
                    self._picture = (path, mtime, "data:image/jpeg;base64," + base64.b64encode(f.read()).decode())
            return self._picture[2]
        return None

    def bundle(self, mode: str):
        """(css for library pages, css for friends pages, Liquid's script, key)."""
        if mode == "off":
            return "", "", "", ""

        def read(name):
            with open(os.path.join(THEME_DIR, name), encoding="utf-8") as f:
                return f.read()

        files = level_files(mode) if mode in LEVEL_MODES else None
        if mode in LEVEL_MODES and not files:
            mode = "frosted"   # the level can't be put together here: plain glass instead
        extra = {"clear": "glass-clear.css", "liquid": "liquid.css", "aero": "aero.css", "nullscapes": "nullscapes.css",
                 "eternalnight": "nullscapes.css"}.get(mode)   # both GD levels wear the matte low-poly look
        extra = read(extra) if extra else ""
        lib, friends = read("libraryroot.custom.css") + extra, read("friends.custom.css") + extra
        live = mode == "nullscapes" and files[0][0] == "level"   # or else the recordings
        if live:   # the level player, then the scene that drives it
            js = read("gdscene.js") + "\n" + read("nullscapes-live.js")
        elif mode == "eternalnight":
            js = read("gdscene.js") + "\n" + read("eternal-night-live.js")
        else:
            js = read(SCENE_SCRIPTS[mode]) if mode in SCENE_SCRIPTS else ""
        if mode == "aero":
            picture = self.picture()
            if picture:
                js = f"window.__ggAeroImage = {json.dumps(picture)};\n" + js
        if mode in LEVEL_MODES:   # its files come in as blobs (send_media); point the script at them
            music = "window.__ggNullBlobs && window.__ggNullBlobs.music || null" if song_on(mode) else "null"
            if mode == "nullscapes":
                js = (f"window.__ggNullVideos = window.__ggNullFiles = window.__ggNullBlobs || null;\n"
                      f"window.__ggNullMusic = {music};\n" + js)
            else:
                js = f"window.__ggNightFiles = window.__ggNullBlobs || null;\nwindow.__ggNightMusic = {music};\n" + js
            js += "".join(f"/* {n} {os.path.getmtime(path)} */" for n, path, _ in files)
        key = hashlib.sha1((lib + friends + js).encode()).hexdigest()[:16]
        return lib, friends, js, key

    @staticmethod
    def send_media(ws_url, mode, with_music=False):
        """Stream a GD level's files (the live level's data and sprite sheets, or else
        Nullscapes' recordings) into a Steam page as blob URLs, once per page: Steam's pages
        can't load files from disk, so the bytes go over the same developer port in base64
        chunks and become Blobs there."""
        files, song = list(level_files(mode) or []), level_music(mode)
        if with_music and song:   # the song only goes to the main window
            files.append(("music", song, "audio/mpeg"))
        stamp = "|".join(f"{n}:{os.path.getmtime(path)}" for n, path, _ in files)
        if ws_eval(ws_url, "window.__ggNullStamp || ''") == stamp:
            return   # this page already has these recordings
        ws_eval(ws_url, """(() => { const old = window.__ggNullBlobs; if (old) for (const k in old) URL.revokeObjectURL(old[k]);
                                    delete window.__ggNullBlobs; })()""")
        ws_eval(ws_url, "window.__ggNullUp = {}")
        for name, path, _ in files:
            with open(path, "rb") as f:
                data = f.read()
            ws_eval(ws_url, f"window.__ggNullUp[{name!r}] = []")
            step = 3 << 20   # 3 MB per message
            for i in range(0, len(data), step):
                chunk = base64.b64encode(data[i:i + step]).decode()
                ws_eval(ws_url, f"window.__ggNullUp[{name!r}].push(Uint8Array.from(atob({chunk!r}), c => c.charCodeAt(0)))",
                        timeout=30)
        types = json.dumps({n: t for n, _, t in files})
        ws_eval(ws_url, f"""(() => {{
            const up = window.__ggNullUp, types = {types}, out = {{}};
            for (const k in up) out[k] = URL.createObjectURL(new Blob(up[k], {{ type: types[k] }}));
            window.__ggNullBlobs = out; delete window.__ggNullUp;
        }})()""")
        ws_eval(ws_url, f"window.__ggNullStamp = {stamp!r}")

    def apply_all(self, mode: str):
        """One pass over Steam's pages. Raises OSError if Steam's port doesn't answer."""
        with urllib.request.urlopen(f"http://127.0.0.1:{CEF_PORT}/json", timeout=2) as r:
            pages = json.load(r)
        self.answered = True
        lib, friends, js, key = self.bundle(mode)
        for t in pages:
            url = t.get("url", "")
            if t.get("type") != "page" or "webSocketDebuggerUrl" not in t or t.get("title") == "SharedJSContext":
                continue
            if url.startswith(("http:", "https:")) and "steamloopback" not in url:
                continue   # store and community pages are real websites: leave them be
            scene = js if t.get("title") in SCENE_WINDOWS else ""
            want = key + ("w" if scene else "")
            try:
                have = ws_eval(t["webSocketDebuggerUrl"],
                               f"(document.getElementById({STYLE_ID!r}) || {{dataset: {{}}}}).dataset.key || ''")
                if have == want:
                    continue
                if scene and mode in LEVEL_MODES and mode_ready(mode):
                    self.send_media(t["webSocketDebuggerUrl"], mode, with_music=t.get("title") == "Steam")
                ws_eval(t["webSocketDebuggerUrl"], f"""(() => {{
                    let s = document.getElementById({STYLE_ID!r});
                    if (window.__ggLiquid) window.__ggLiquid.stop();
                    if (window.__ggAero) window.__ggAero.stop();
                    if (window.__ggNull) window.__ggNull.stop();
                    if (window.__ggNight) window.__ggNight.stop();
                    if (!{json.dumps(want)}) {{ if (s) s.remove(); return; }}
                    if (!s) {{ s = document.createElement("style"); s.id = {STYLE_ID!r};
                              (document.head || document.documentElement).appendChild(s); }}
                    s.textContent = document.querySelector(".friendsui-container") ? {json.dumps(friends)} : {json.dumps(lib)};
                    s.dataset.key = {json.dumps(want)};
                    delete window.__ggAeroImage;   // a picture from before must not outlive its choice
                    {scene}
                }})()""", timeout=5)
            except (OSError, ValueError):
                pass   # that page went away mid-pass; the next pass catches up

    def _run(self):
        while not self._stop.wait(1.0):
            try:
                self.apply_all(self.mode)
            except (OSError, ValueError):
                pass   # Steam isn't running, or was started before its port was turned on

    def stop(self):
        """Take the theme out of Steam's pages (quitting puts Steam back to normal)."""
        self._stop.set()
        self._thread.join(timeout=3)
        try:
            self.apply_all("off")
        except (OSError, ValueError):
            pass


def startup_command() -> str:
    if FROZEN:
        return f'"{sys.executable}"'
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    return f'"{pythonw if os.path.isfile(pythonw) else sys.executable}" "{os.path.abspath(__file__)}"'


def startup_enabled() -> bool:
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, RUN_NAME)
        return True
    except OSError:
        return False


def set_startup(on: bool):
    """Start the helper when you sign in to Windows (the same Run entry the installer makes)."""
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if on:
            winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, startup_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_NAME)
            except FileNotFoundError:
                pass


def save_picture(source: str) -> bool:
    """Make a picture Aero's panorama: scaled down if it's big, saved as a JPEG in the settings folder."""
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QImage
    img = QImage(source)
    if img.isNull():
        return False
    if img.height() > PICTURE_HEIGHT:
        img = img.scaledToHeight(PICTURE_HEIGHT, Qt.SmoothTransformation)
    os.makedirs(SETTINGS_DIR, exist_ok=True)
    return img.save(os.path.join(SETTINGS_DIR, MY_PICTURE), "JPG", 90)


def theme_folder() -> str:
    """The theme files the helper loads into Steam."""
    return THEME_DIR


def main():
    if "--off" in sys.argv:
        restore_all()
        return
    kernel32.CreateMutexW(None, False, "Local\\SteamGlassHelper")
    if ctypes.get_last_error() == 183:   # ERROR_ALREADY_EXISTS: one helper is enough
        return

    from PySide6.QtCore import QTimer, QUrl
    from PySide6.QtGui import QActionGroup, QCursor, QDesktopServices
    from PySide6.QtNetwork import QLocalServer
    from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    port_on = enable_theme_port()
    theme = Theme()
    theme.start()
    glass = Glass()
    timer = QTimer()
    timer.timeout.connect(glass.tick)
    timer.start(30)

    tray = QSystemTrayIcon()
    menu = QMenu()
    title = menu.addAction("Steam Glass")
    title.setEnabled(False)
    group = QActionGroup(menu)
    actions = {}
    for key, label in MODES.items():
        if not mode_ready(key):
            continue
        a = menu.addAction(label)
        a.setCheckable(True)
        group.addAction(a)
        a.triggered.connect(lambda _=False, k=key: choose(k))
        actions[key] = a
    menu.addSeparator()
    folder = menu.addAction("Open theme folder")
    folder.triggered.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(theme_folder())))
    def choose_picture():
        from PySide6.QtWidgets import QFileDialog, QMessageBox
        path, _ = QFileDialog.getOpenFileName(None, "Choose a picture for Frutiger Aero", os.path.expanduser("~"),
                                              "Pictures (*.jpg *.jpeg *.png *.webp *.bmp)")
        if not path:
            return
        if not save_picture(path):
            QMessageBox.warning(None, "Steam Glass", "That picture couldn't be opened.")
            return
        choose("aero")

    def drawn_scene():
        try:
            os.remove(os.path.join(SETTINGS_DIR, MY_PICTURE))
        except OSError:
            pass
        choose("aero")

    if any(mode_ready(m) and level_music(m) for m in LEVEL_MODES):   # the GD levels' songs
        music = menu.addAction("Song toggle")
        music.setCheckable(True)
        music.setChecked(any(song_on(m) for m in LEVEL_MODES))
        music.toggled.connect(lambda on: set_song(on))
    pictures = menu.addMenu("Aero picture")
    pictures.addAction("Choose a picture…", choose_picture)
    pictures.addAction("Built-in Aero scene", drawn_scene)
    menu.addSeparator()
    startup = menu.addAction("Start with Windows")
    startup.setCheckable(True)
    startup.setChecked(startup_enabled())
    startup.toggled.connect(lambda on: set_startup(on))
    if os.path.isfile(UPDATER):   # only in installed builds
        menu.addAction("Check for updates…", check_updates)
    menu.addAction(f"Steam Glass {__version__}").setEnabled(False)
    menu.addSeparator()
    quit_action = menu.addAction("Quit (Steam back to normal)")

    def show(mode):
        actions[mode].setChecked(True)
        tray.setIcon(tray_icon(mode))
        tray.setToolTip(f"Steam Glass: {MODES[mode]}")

    def choose(mode):
        write_mode(mode)
        theme.mode = mode
        glass.last_scan = 0.0   # apply now, not at the next scan
        glass.tick()
        show(mode)

    def quit_helper():
        timer.stop()
        theme.stop()
        restore_all()
        tray.hide()
        app.quit()

    def on_connection():   # the updater says "quit" before it replaces our files
        sock = server.nextPendingConnection()
        if sock is not None:
            sock.readyRead.connect(lambda: quit_helper() if bytes(sock.readAll()).strip() == b"quit" else None)

    server = QLocalServer()
    QLocalServer.removeServer(PIPE)
    server.listen(PIPE)
    server.newConnection.connect(on_connection)

    def sync():   # the file can also be edited by hand
        mode = read_mode()
        theme.mode = mode
        if not actions[mode].isChecked():
            show(mode)
        if (not theme.answered and port_on and not sync.told and steam_windows()
                and time.monotonic() - sync.started > 10):
            sync.told = True   # Steam was already running when its port was turned on
            tray.showMessage("Steam Glass", "Restart Steam once to load the glass theme.",
                             tray_icon(mode), 8000)

    sync.told, sync.started = False, time.monotonic()

    quit_action.triggered.connect(quit_helper)
    tray.setContextMenu(menu)
    tray.activated.connect(lambda reason: menu.popup(QCursor.pos())
                           if reason == QSystemTrayIcon.ActivationReason.Trigger else None)
    show(read_mode())
    tray.show()
    file_timer = QTimer()
    file_timer.timeout.connect(sync)
    file_timer.start(1000)
    sys.exit(app.exec())


def check_updates():
    import subprocess
    subprocess.Popen([UPDATER, "--from-app"], close_fds=True)


if __name__ == "__main__":
    main()
