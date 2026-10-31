# Steam Glass

[DiscTray](https://github.com/ASQUALL-hub/disctray)'s Glossy Glass look for the Steam client on Windows 11: see-through glass windows with a wet gloss, bright double rims and tinted candy buttons (a green glass Play button, blue glass for Install).

It comes in two parts:

- **The Glossy Glass theme** for [Millennium](https://steambrew.app), the Steam mod loader. It makes Steam's pages transparent and draws the glass: glossy title bar, glass cards for the game list and game page, tinted-glass buttons, menus, dialogs and the friends list.
- **The Steam Glass helper**, a small tray icon that tells Windows what to show behind Steam's windows. Click it to pick the glass:
  - **Frosted:** a dark acrylic blur of whatever is behind Steam, with Windows' rounded corners.
  - **Clear:** fully see-through, cut to DiscTray's squircle corners.
  - **Liquid:** DiscTray's Liquid style. Water sloshes behind the game list when you drag the window, and droplets cling to the glass and run down.
  - **Off:** Steam's normal look.

## Install

1. Install [Millennium](https://steambrew.app) if you don't have it.
2. Download **`SteamGlassUpdater.exe`** from the [latest release](https://github.com/ASQUALL-hub/steam-glossy-glass/releases/latest) and run it. It installs for your user only (no admin rights):
   - the helper to `%LOCALAPPDATA%\Programs\SteamGlass`, starting with Windows, with a Start Menu shortcut;
   - the theme to Steam's `steamui\skins\GlossyGlass` folder.
3. Restart Steam, then pick **Glossy Glass** in *Steam → Millennium → Themes*.
4. Pick the same glass in the theme's **Glass** option and in the tray icon (Frosted, Clear or Liquid).

The exe isn't code-signed, so Windows SmartScreen may warn the first time: choose **More info → Run anyway**. The updater is a small native program (about 100 KB, source in [`updater/Updater.cs`](updater/Updater.cs)) that only downloads the release zip from this repo and unpacks it into your profile and Steam's skins folder.

**Updating:** tray icon → **Check for updates…**, or run the updater again. Restart Steam afterwards to load the new theme.
**Uninstalling:** *Settings → Apps → Steam Glass → Uninstall*, or `SteamGlassUpdater.exe --uninstall`. That removes the helper and the theme, and puts Steam's windows back to normal.

New tray icons go into the hidden **^** area on Windows 11. Pin Steam Glass under *Settings → Personalization → Taskbar → Other system tray icons* to keep it in view.

## Notes

- Needs Windows 11 (22H2 or newer) for the frosted blur.
- Big Picture mode isn't themed.
- Steam names most of its page parts with generated class names, which can change when Steam updates. If part of the theme stops applying after a Steam update, check for a theme update.
- Quitting the helper (tray icon → **Quit**) puts Steam's windows back to normal.

## Run from source

```bash
pip install PySide6
pythonw steamglass.pyw
```

From source, the glass setting is kept in `glass-mode.txt` next to the script; the installed helper keeps it in `%APPDATA%\SteamGlass`.

`install.ps1` copies the theme from a checkout into Steam (`-Startup` also starts the source helper at sign-in). Run `build.ps1` first if you changed `friends.src.css`, `liquid.src.css` or `gen_rim.py`: it regenerates the window-glass CSS.

## Build a release

```bash
pip install pyinstaller pillow PySide6
python build.py
```

`dist/` then holds `SteamGlass-<version>-win64.zip` (the helper plus the theme in `skin/`) and `SteamGlassUpdater.exe`. Bump `__version__` in `steamglass.pyw`, build, and attach both files to a GitHub release tagged `v<version>`; the updater installs the release marked latest.
