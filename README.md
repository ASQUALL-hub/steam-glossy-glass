# Steam Glass

[DiscTray](https://github.com/ASQUALL-hub/disctray)'s Glossy Glass look for the Steam client on Windows 11: see-through glass windows with a wet gloss, bright double rims and tinted candy buttons (a green glass Play button, blue glass for Install).

It's one small tray app, the **Steam Glass helper**. It loads the **Glossy Glass theme** into Steam (glossy title bar, glass cards for the game list and game page, tinted-glass buttons, menus, dialogs and the friends list) and tells Windows what to show behind Steam's windows. No Millennium or other mod loader needed. Click the tray icon to pick the glass:
- **Frosted:** a dark acrylic blur of whatever is behind Steam, with Windows' rounded corners.
- **Clear:** fully see-through, cut to DiscTray's squircle corners.
- **Liquid:** DiscTray's Liquid style. Water sloshes behind the game list when you drag the window, and droplets cling to the glass and run down.
- **Frutiger Aero:** a sunny lakeside panorama drifts by behind blue glass panels and clear, glossy bubble buttons: billowing clouds and high wisps blowing across a deep blue sky, misty mountains, a hazy glass city, meadows with wind turbines, a forested cliff with a waterfall, and a wide lake that mirrors it all in rippling reflections, behind tall dewy grass and daisies, with soap bubbles and a lens flare off the sun. The view pans slowly to the right and loops seamlessly, and every time Steam opens it, the clouds, trees, city and flowers come out a little different. It's all drawn in code (`aero.js`). Tray icon → **Aero picture** can pan a wallpaper of your own instead.
- **Off:** Steam's normal look.

The tray menu also has **Start with Windows**, to start the helper when you sign in.

## Install

1. Download **`SteamGlassUpdater.exe`** from the [latest release](https://github.com/ASQUALL-hub/steam-glossy-glass/releases/latest) and run it. It installs the helper for your user only (no admin rights) to `%LOCALAPPDATA%\Programs\SteamGlass`, starting with Windows, with a Start Menu shortcut.
2. Click **Restart Steam** when it asks (only the first time).
3. Pick Frosted, Clear or Liquid in the tray icon.

**How the theme gets in:** Steam's pages are Chromium pages, and Steam has a developer port for them on `127.0.0.1:8080` (your PC only). It opens when Steam's folder holds an empty `.cef-enable-remote-debugging` file, so the installer adds that file and Steam needs one restart to read it. The helper then adds the theme's styles to each Steam page. Other programs on your PC can use that port too while it's on; uninstalling removes the file, and Steam closes the port from its next start.

The exe isn't code-signed, so Windows SmartScreen may warn the first time: choose **More info → Run anyway**. The updater is a small native program (about 100 KB, source in [`updater/Updater.cs`](updater/Updater.cs)) that only downloads the release zip from this repo and unpacks it into your profile.

**Updating:** tray icon → **Check for updates…**, or run the updater again. The new theme applies right away.
**Uninstalling:** *Settings → Apps → Steam Glass → Uninstall*, or `SteamGlassUpdater.exe --uninstall`. That removes the helper and the theme, and puts Steam's windows back to normal.

New tray icons go into the hidden **^** area on Windows 11. Pin Steam Glass under *Settings → Personalization → Taskbar → Other system tray icons* to keep it in view.

## Notes

- Needs Windows 11 (22H2 or newer) for the frosted blur.
- Big Picture mode isn't themed.
- Frutiger Aero animates, so it costs Steam some CPU (about a third of one core here) while its window is on screen. It pauses when Steam is minimized or covered.
- **Nullscapes** and **Eternal Night** play a Geometry Dash level live behind Steam, with matte, low-poly glass buttons (`nullscapes-live.js`, `eternal-night-live.js`, `gdscene.js`, `nullscapes.css`; the levels' data is in `levels/`). They need Geometry Dash installed through Steam: the pictures are GD's own sprite sheets, taken from your copy of the game, so no GD art is in this download. The songs come from GD's song folder too, so play the levels' songs once in GD (Newgrounds IDs 1132447 and 153668) to hear them. **Song toggle** in the tray menu turns the songs on or off. Without Geometry Dash, these two modes don't appear in the tray.
- Credits: Geometry Dash and its art belong to RobTop Games. The Nullscapes scene is the background of Zoink's level (GD level 109780385); Eternal Night is a copy of GD level 73011766. The songs are Creo's "Flow" and NemesisTheory's "Rose At Nightfall". Steam Glass is free and non-commercial: nothing here is sold or earns money.
- Steam names most of its page parts with generated class names, which can change when Steam updates. If part of the theme stops applying after a Steam update, check for a theme update.
- Quitting the helper (tray icon → **Quit**) puts Steam's windows back to normal.

## Run from source

```bash
pip install PySide6
pythonw steamglass.pyw
```

To work on the Aero scene in a browser, serve this folder (`python -m http.server 8765`) and open `http://localhost:8765/preview/aero.html`.

From source, the glass setting is kept in `glass-mode.txt` next to the script; the installed helper keeps it in `%APPDATA%\SteamGlass`.

From source the helper loads the theme files next to the script. `install.ps1` copies the theme into Steam's Millennium skins folder instead, for using it as a Millennium theme (`-Startup` also starts the source helper at sign-in). Run `build.ps1` first if you changed `friends.src.css`, `liquid.src.css` or `gen_rim.py`: it regenerates the window-glass CSS.

## Build a release

```bash
pip install pyinstaller pillow PySide6
python build.py
```

`dist/` then holds `SteamGlass-<version>-win64.zip` (the helper plus the theme it loads, in `skin/`) and `SteamGlassUpdater.exe`. Bump `__version__` in `steamglass.pyw`, build, and attach both files to a GitHub release tagged `v<version>`; the updater installs the release marked latest.
