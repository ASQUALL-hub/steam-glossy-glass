"""Build the Windows release:

    python build.py

produces, in dist/:
    SteamGlass/                         the helper (folder build, starts fast)
    SteamGlass-<version>-win64.zip      the helper plus the theme (skin/): what the updater downloads
    SteamGlassUpdater.exe               the per-user installer / updater (C#, compiled with Windows' own csc.exe)

Run build.ps1 first if you changed the generated CSS parts.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST, BUILD = ROOT / "dist", ROOT / "build"
ICON = ROOT / "assets" / "steamglass.ico"
PUBLISHER = "ASQUALL-hub"
THEME = ["skin.json", "libraryroot.custom.css", "friends.custom.css", "glass-frosted.css", "glass-clear.css",
         "liquid.css", "liquid.js", "aero.css", "aero.js", "nullscapes.css", "nullscapes.js",
         "gdscene.js", "nullscapes-live.js", "eternal-night-live.js"]   # what Millennium loads from steamui\skins\GlossyGlass


def version() -> str:
    return re.search(r'__version__ = "([^"]+)"', (ROOT / "steamglass.pyw").read_text(encoding="utf-8")).group(1)


def make_icon() -> None:
    """The tray's frosted glass squircle as a multi-size .ico."""
    import importlib.util
    from io import BytesIO

    from PIL import Image
    from PySide6.QtCore import QBuffer, QIODevice, QSize
    from PySide6.QtWidgets import QApplication

    spec = importlib.util.spec_from_loader("steamglass", loader=None)
    helper = importlib.util.module_from_spec(spec)
    helper.__file__ = str(ROOT / "steamglass.pyw")
    exec(compile((ROOT / "steamglass.pyw").read_text(encoding="utf-8"), "steamglass.pyw", "exec"), helper.__dict__)

    app = QApplication.instance() or QApplication([])
    icon = helper.tray_icon("frosted", (256,))
    buf = QBuffer()
    buf.open(QIODevice.WriteOnly)
    icon.pixmap(QSize(256, 256)).toImage().save(buf, "PNG")
    big = Image.open(BytesIO(bytes(buf.data())))
    ICON.parent.mkdir(exist_ok=True)
    big.save(ICON, sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    del app


def pyinstaller(*args: str) -> None:
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
                    "--distpath", str(DIST), *args], cwd=ROOT, check=True)


def version_resource(ver: str, name: str, description: str) -> Path:
    """A PyInstaller version file, so the exe says what it is under Properties > Details."""
    nums = (tuple(int(n) for n in re.findall(r"\d+", ver)) + (0, 0, 0, 0))[:4]
    path = BUILD / f"{name}-version.txt"
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = {"CompanyName": PUBLISHER, "FileDescription": description, "FileVersion": ver,
              "InternalName": name, "LegalCopyright": PUBLISHER, "OriginalFilename": f"{name}.exe",
              "ProductName": "Steam Glass", "ProductVersion": ver}
    strings = ", ".join(f"StringStruct({k!r}, {v!r})" for k, v in fields.items())
    path.write_text(
        f"VSVersionInfo(ffi=FixedFileInfo(filevers={nums}, prodvers={nums}, mask=0x3f, flags=0x0, OS=0x40004,"
        f" fileType=0x1, subtype=0x0, date=(0, 0)), kids=[StringFileInfo([StringTable('040904B0', [{strings}])]),"
        f" VarFileInfo([VarStruct('Translation', [1033, 1200])])])\n", encoding="utf-8")
    return path


def build_updater(ver: str) -> Path:
    """Compile updater/Updater.cs with the C# compiler that comes with Windows (.NET Framework 4)."""
    csc = Path(os.environ["WINDIR"]) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
    gac = Path(os.environ["WINDIR"]) / "Microsoft.NET" / "assembly" / "GAC_MSIL"
    refs = ["System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
            "System.Web.Extensions.dll", "Microsoft.CSharp.dll"]
    for lib in ("System.IO.Compression", "System.IO.Compression.FileSystem"):   # not next to csc.exe, only in the GAC
        refs.append(str(next((gac / lib).glob(f"v4.0_*/{lib}.dll"))))
    nums = ".".join(((re.findall(r"\d+", ver)) + ["0"] * 4)[:4])
    info = BUILD / "updater" / "AssemblyInfo.cs"
    info.parent.mkdir(parents=True, exist_ok=True)
    info.write_text("using System.Reflection;\n" + "".join(f'[assembly: {k}("{v}")]\n' for k, v in (
        ("AssemblyTitle", "Steam Glass Updater"),
        ("AssemblyDescription", "Installs and updates Steam Glass and its Steam theme for this user"),
        ("AssemblyCompany", PUBLISHER), ("AssemblyProduct", "Steam Glass"), ("AssemblyCopyright", PUBLISHER),
        ("AssemblyVersion", nums), ("AssemblyFileVersion", nums), ("AssemblyInformationalVersion", ver))),
        encoding="utf-8")
    out = DIST / "SteamGlassUpdater.exe"
    subprocess.run([str(csc), "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", f"/out:{out}",
                    f"/win32icon:{ICON}", f"/win32manifest:{ROOT / 'updater' / 'app.manifest'}",
                    *(f"/r:{r}" for r in refs), str(ROOT / "updater" / "Updater.cs"), str(info)],
                   cwd=ROOT, check=True)
    return out


def prune(qt: Path) -> None:
    """Drop the Qt parts PyInstaller's hooks pull in that a tray icon never loads (QML, PDF,
    software OpenGL, the on-screen keyboard, translations): about 60 MB."""
    for pattern in ("opengl32sw.dll", "Qt6Quick*.dll", "Qt6Qml*.dll", "Qt6Pdf*.dll", "Qt6OpenGL*.dll",
                    "Qt6Svg*.dll", "Qt6VirtualKeyboard*.dll", "translations", "plugins/platforminputcontexts",
                    "plugins/networkinformation", "plugins/tls", "plugins/imageformats", "plugins/iconengines"):
        for f in qt.glob(pattern):
            shutil.rmtree(f) if f.is_dir() else f.unlink()


def main() -> None:
    ver = version()
    if not ICON.is_file():
        make_icon()
    shutil.rmtree(DIST, ignore_errors=True)

    unused = ["tkinter", "PySide6.QtQml", "PySide6.QtQuick", "PySide6.QtPdf", "PySide6.QtWebEngineCore",
              "PySide6.QtMultimedia", "PySide6.QtOpenGL", "PySide6.QtSvg", "numpy"]
    pyinstaller("--windowed", "--name", "SteamGlass", "--icon", str(ICON),
                "--workpath", str(BUILD / "app"), "--specpath", str(BUILD),
                "--version-file", str(version_resource(ver, "SteamGlass", "Steam Glass helper")),
                *(a for m in unused for a in ("--exclude-module", m)),
                str(ROOT / "steamglass.pyw"))
    prune(DIST / "SteamGlass" / "_internal" / "PySide6")
    archive = DIST / f"SteamGlass-{ver}-win64.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted((DIST / "SteamGlass").rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(DIST / "SteamGlass"))
        for name in THEME:
            z.write(ROOT / name, f"skin/{name}")
        for f in sorted((ROOT / "levels").rglob("*")):   # the GD levels' data only (see steamglass.pyw)
            if f.is_file():
                z.write(f, f"skin/{f.relative_to(ROOT).as_posix()}")

    build_updater(ver)

    print(f"\nSteam Glass {ver}:")
    for f in (archive, DIST / "SteamGlassUpdater.exe"):
        print(f"  {f.relative_to(ROOT)}  {f.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
