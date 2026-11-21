# Steam Glass

[DiscTray](https://github.com/ASQUALL-hub/disctray)'s Glossy Glass look for the Steam client on Windows 11: see-through glass windows with a wet gloss, bright double rims and tinted candy buttons (a green glass Play button, blue glass for Install).

It's one small tray app, the **Steam Glass helper**. It loads the **Glossy Glass theme** into Steam (glossy title bar, glass cards for the game list and game page, tinted-glass buttons, menus, dialogs and the friends list) and tells Windows what to show behind Steam's windows. No Millennium or other mod loader needed. Click the tray icon to pick the glass:
- **Frosted:** a dark acrylic blur of whatever is behind Steam, with Windows' rounded corners.
- **Clear:** fully see-through, cut to DiscTray's squircle corners.
- **Liquid:** DiscTray's Liquid style. Water sloshes behind the game list when you drag the window, and droplets cling to the glass and run down.
- **Frutiger Aero:** a sunny lakeside panorama drifts by behind blue glass panels and clear, glossy bubble buttons: billowing clouds and high wisps blowing across a deep blue sky, misty mountains, a hazy glass city, meadows with wind turbines, a forested cliff with a waterfall, and a wide lake that mirrors it all in rippling reflections, behind tall dewy grass and daisies, with soap bubbles and a lens flare off the sun. The view pans slowly to the right and loops seamlessly, and every time Steam opens it, the clouds, trees, city and flowers come out a little different. It's all drawn in code (`aero.js`). Tray icon → **Aero picture** can pan a wallpaper of your own instead.
- **Steam 2013:** not glass at all: Steam as it looked at the end of 2013, on today's client. The charcoal window with its textured top and piston watermark, the big STORE / LIBRARY / COMMUNITY labels, the search and VIEW bar, the plain 18px game list, a game's page with its title box, play box, coloured headings and LINKS column, the old menus, buttons, scrollbars, friends list and bottom bar, and charcoal store and community pages.
- **Steam 2005:** the olive-green Steam of 2003 to 2005. The single window of late 2005 (green title bar, rounded tabs with the open one in yellow, the page on a grey panel, the games list on a darker box with the picked game on black, a black bar of big icon buttons), with friends, chat and menus as the classic olive windows with bevelled edges, and the store and community in olive too.
- **Steam 2017:** the grey skin once more, as it stood on the client of January 2017: the 2013 look taken further after a collage of that client's windows. The green inbox flag and the boxed VR button beside the account, games under banded collection headings, the dim status line and the friends corner at the bottom, the Downloads page with its usage figures and banded groups, the inbox menu, the old friends window with its tab and darker list, chat, Settings and dialogs. The store and community stay blue, as they already were then.
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
- The store and community pages (profiles, the market, hubs, the workshop...) are glass too: their solid backgrounds and page-wide art go, so the glass or the mode's scene shows through them as it does through the library (`web.css`, `web-glass.js`). In the Geometry Dash modes, Steam's blue goes black and white everywhere, in the library, Downloads, menus and these pages alike (game pictures keep their colours; the helper restates Steam's own blue rules in grey), and the pages' buttons become the same matte panes as the library's. Only inside Steam's own window: the in-game overlay, Big Picture and other websites stay as they are.
- Frutiger Aero animates, so it costs Steam some CPU (about a third of one core here) while its window is on screen. It pauses when Steam is minimized or covered.
- **Nullscapes** and **Eternal Night** play a Geometry Dash level live behind Steam, with matte, low-poly glass buttons (`nullscapes-live.js`, `eternal-night-live.js`, `gdscene.js`, `nullscapes.css`; the levels' data is in `levels/`). In Eternal Night the buttons also take the level's colours as it plays (red when the level is red, violet when it's violet) and light up with the song's beat. They need Geometry Dash installed through Steam: the pictures are GD's own sprite sheets, taken from your copy of the game, so no GD art is in this download. The songs come from GD's song folder too, so play the levels' songs once in GD (Newgrounds IDs 1132447 and 153668) to hear them. **Song toggle** in the tray menu turns the songs on or off. Without Geometry Dash, these two modes don't appear in the tray.
- **Deprivation (unfinished)** plays AudieoVisual's DEPRIVATION the same way, with a newer level player (`gdscene-next.js`). It isn't finished and the theme carries no data for it, so it appears in the tray only when the level was exported by hand into `%APPDATA%\SteamGlass\deprivation\live\`.
- **Steam 2013** takes its numbers from the December 2013 client itself: the colours, font sizes and box metrics in its `resource/styles/steam.styles` and `resource/layout/*.layout` (as kept by [SteamDatabase/SteamTracking](https://github.com/SteamDatabase/SteamTracking)), checked against screenshots of the time. Its pictures (the top texture, the watermark, BIG PICTURE, the view buttons, checkboxes, window buttons...) are the files Steam still ships in its own `graphics` folder, read from your PC when the mode starts, so none of Valve's files are in this download. What today's client has and 2013's didn't (the sort and filter buttons, a game's manage/info/favourite buttons) stays, drawn small and plain. The game list is drawn at 18/26 scale to get the old row pitch. Steam, its look and its graphics belong to Valve; this is a fan-made skin (`steam2013.css`, `friends2013.css`, `web2013.css`, `steam2013.js`).
- **Steam 2005** is drawn entirely in CSS, with no pictures (`steam2005.css`, `friends2005.css`, `web2005.css`). Its colours are the old scheme's olive family (76 88 68 for a window, 62 70 55 for a list, 196 181 80 for the yellow), measured from screenshots of the client and of steampowered.com at the time. What the mode doesn't name still fits: the helper turns Steam's blue into the olive of the same brightness. It shares its small script with Steam 2013.
- **Steam 2017** follows one picture: a collage of the January 2017 client's windows wearing the grey skin of 2010 to 2014 (Valve's own skin had turned blue in August 2014). So its colours and sizes are that skin's own, from the last grey `steam.styles` and layout files (July 2014, SteamDatabase/SteamTracking), checked against the collage and a screenshot of April 2014, and what only the later client had (the VR button, the Downloads page, the two-line status) is measured from the collage. Like Steam 2013 it reads its pictures from your own Steam folder and shares that mode's small script. Today's inbox button is given no count to show, so the flag wears the envelope alone; the VR button appears when Steam itself shows one (`steam2017.css`, `friends2017.css`, `web2017.css`).
- Credits: Geometry Dash and its art belong to RobTop Games. Nullscapes is Kiba's extreme demon (the scene is its background), and Eternal Night is xEl3cTr0's extreme demon. The songs are Creo's "Flow" and NemesisTheory's "Rose At Nightfall". Steam Glass is free and non-commercial: nothing here is sold or earns money.
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
