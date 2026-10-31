"""Steam Glass helper: gives Steam's windows real see-through glass.

The Glossy Glass theme makes Steam's pages transparent; this helper tells Windows
what to show behind them. It watches for Steam windows (main window, friends,
settings, menus) and treats each one as it appears. The kind of glass is picked
in glass-mode.txt next to this file (changes apply live):

  frosted  a dark acrylic blur of whatever is behind the window (DWM system
           backdrop, Windows 11 22H2+). Windows only rounds this 8px: the blur
           ignores window shapes, so DiscTray's squircle cannot be cut into it.
  clear    no blur, fully see-through; the window is cut to DiscTray's squircle
           (pair with the theme's "Clear" glass option, which draws the curve).
  liquid   frosted glass for the theme's "Liquid" option (water that sloshes).
  off      Steam's own windows.

A tray icon switches between them (it writes glass-mode.txt). Quitting it puts
Steam back to normal. Run with pythonw (no console). `--off` puts every Steam
window back to normal without starting the helper.

Installed builds (SteamGlass.exe, put there by SteamGlassUpdater.exe) keep
glass-mode.txt in %APPDATA%\SteamGlass and add "Check for updates…" to the menu."""
__version__ = "1.0.0"

import ctypes
import math
import os
import sys
import time
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


class MARGINS(ctypes.Structure):
    _fields_ = [("l", ctypes.c_int), ("r", ctypes.c_int), ("t", ctypes.c_int), ("b", ctypes.c_int)]


class DWM_BLURBEHIND(ctypes.Structure):
    _fields_ = [("dwFlags", wt.DWORD), ("fEnable", wt.BOOL), ("hRgnBlur", wt.HRGN), ("fTransitionOnMaximized", wt.BOOL)]


EnumProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.GetWindowLongW.restype = ctypes.c_long
user32.SetWindowLongW.restype = ctypes.c_long


MODES = {"frosted": "Frosted", "clear": "Clear", "liquid": "Liquid", "off": "Off (Steam's normal look)"}


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
    if mode not in ("frosted", "liquid"):
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
    """mode: "frosted", "clear", "liquid" or "off" (Steam's own look)."""
    if mode != "off":
        dword_attr(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
    if mode == "liquid":   # Liquid's water sits behind frosted glass, like DiscTray's
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
    rim when clear, Liquid's teal sky with a wave of water when liquid, grey
    when off."""
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
        else:
            top, bottom = {"frosted": ((70, 160, 255, 235), (20, 60, 150, 235)),
                           "clear": ((120, 200, 255, 90), (40, 110, 200, 70)),
                           "off": ((150, 156, 166, 230), (80, 86, 96, 230))}[mode]
            fill.setColorAt(0, QColor(*top))
            fill.setColorAt(1, QColor(*bottom))
        p.fillPath(body, fill)
        if mode == "liquid":
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


def theme_folder() -> str:
    """Where Steam keeps the theme (Millennium's skins folder), else this folder."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            steam = winreg.QueryValueEx(k, "SteamPath")[0].replace("/", "\\")
        skin = os.path.join(steam, "steamui", "skins", "GlossyGlass")
        if os.path.isdir(skin):
            return skin
    except OSError:
        pass
    return HERE


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
        a = menu.addAction(label)
        a.setCheckable(True)
        group.addAction(a)
        a.triggered.connect(lambda _=False, k=key: choose(k))
        actions[key] = a
    menu.addSeparator()
    folder = menu.addAction("Open theme folder")
    folder.triggered.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(theme_folder())))
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
        glass.last_scan = 0.0   # apply now, not at the next scan
        glass.tick()
        show(mode)

    def quit_helper():
        timer.stop()
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
        if not actions[read_mode()].isChecked():
            show(read_mode())

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
