# Devious Licks

The Devious Licks game library for Mac. It shows every Devious Licks game, plays them with a built-in emulator, and pulls new and updated games from this repo every time the app opens (or when someone picks **Refresh** in Settings).

## Download (for friends)

Grab the latest `Devious-Licks-x.y.z.dmg` from the **Releases** page:
`https://github.com/blaiserailey-lang/devious-licks/releases/latest`

Open the DMG and drag **Devious Licks** into Applications.

> **First launch on an unsigned build:** macOS will say it can't verify the app. Click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to "Devious Licks". You only do this once. (Signed builds skip this, see "Signing" below.)

**Updating the app.** You install from the DMG once (version 0.3.2 or later: older versions have no Update button). After that, open **Settings** in the app and pick **Update**: it downloads the newest version from this repo's releases and restarts on it (the button reads **Update to x.y.z** when there is one; the app looks every time it opens, and the home screen says so in its bottom left corner). No DMG, no dragging, no trip to Privacy & Security. The version you are on is in that corner of the home screen and in Settings. If a new version doesn't start on your Mac, the app goes back to the one that worked and tells you so; the button then reads **Try x.y.z again**. Now and then a version needs a fresh DMG after all (the button then reads **Get x.y.z** and opens the download page); see "Releasing a new version of the app".

## Getting around

The app opens on its home screen: **Games**, **Load ROM**, **Friends** and **Settings**. It is steered like a console, with the keyboard, a game controller or the mouse:

| | Keyboard | Controller |
| --- | --- | --- |
| Move | arrow keys | D-pad or left stick |
| Select (**A**) | **Enter** or **A** | A (bottom button) |
| Back (**B**) | **Esc** or **B** | B (right button) |
| Remove a game you added (**X**) | **X**, **Delete** or **Backspace** | X (left button) |
| Give a game you added a picture (**Y**) | **Y** or **P** | Y (top button) |

- **Games** shows your games as boxes on a rail. Left and right turn the rail, **A** starts the game in front (a click on it does too; a click on a box at the side brings it to the front). The game opens in its own window. Under the box are the game's name, its console, and **new** or **updated** when it changed in the last week. With many games: **Up** and **Down** show one console at a time, **/** (or **Cmd+F**) opens a search field, and **Home**, **End**, **Page Up** and **Page Down** jump along the rail.
- **Load ROM** adds a game from a file on your Mac (see "Playing a game file on just your Mac").
- **Friends** is a placeholder: playing online is not available yet.
- **Settings** has the app's **Update** button, **Refresh** for the games (**Cmd+R** does the same from anywhere), sound on or off, the volume (left and right), and motion on or off. With motion off, screens change at once instead of travelling; the app starts that way when "Reduce motion" is on in the Mac's Accessibility settings.

The controller steers the app only while the app's own window is in front, so it does nothing here while you are playing.

In a game: arrow keys for the D-pad, **Z** = A, **X** = B, **Enter** = Start, **V** = Select. Game controllers work too. Click the gamepad icon in the emulator's toolbar to remap.

If a game stops starting after you change an emulator setting, hold **Option** while starting it (Option-click its box, or **Option+Enter**) to start it with default settings.

**N64 games** run in the app's own native player (a separate Devious Licks window), because N64 is too heavy for the built-in web emulator. The player and its N64 emulator are inside the app; nothing else needs to be installed. N64 keyboard controls: arrows = stick, **X** = A, **C** = B, **Z** = Z trigger, **Q**/**E** = L/R, **Enter** = Start, **I/J/K/L** = C buttons, **W/A/S/D** = D-pad, **Cmd+S** = save state, **Cmd+L** = load state, **Cmd+F** = fullscreen (the green button works too), **Cmd+R** = reset, **Esc** = exit fullscreen or close. (F5, F9 and F11 do the same as Cmd+S, Cmd+L and Cmd+F; on an Apple keyboard they need **fn** held.) Game controllers work too: the first one is player 1 (together with the keyboard), the next ones are players 2 to 4. On a controller the bottom button is A, the left button is B, either trigger is Z, the shoulder buttons are L and R, and the right stick does the C buttons. Option-click an N64 game to use the built-in web emulator instead; its saves are kept apart from the native player's.

The first time an N64 game is started on a freshly downloaded copy, macOS may ask once more, this time about "dl-player" or "mupen64plus_next_libretro.dylib": click **Done** (never Move to Trash), use **Open Anyway** in **System Settings › Privacy & Security** as before, and click the game again.

If an N64 game misbehaves, the player's log is at `~/Library/Application Support/Devious Licks/logs/player-n64.log` (the run before it is kept next to it as `player-n64.previous.log`; when the app reports a problem, **Show Log** in that message opens the folder). The log also says how fast the game ran ("speed: ... % of full speed"). Shift-click the game's box (or press **Shift+Enter**) to start it with the graphics recorder on: the log then also lists the emulator's OpenGL calls for the first frames and every OpenGL error, and pressing **F8** in the game window records one more frame (do that while the picture looks wrong).

## Playing a game file on just your Mac

Open **Load ROM** and pick **Choose a game file** (or drag a ROM onto the window, whatever screen it is showing). Unpack a zipped game first: the app takes the game file itself (.z64, .n64 or .v64 for N64). The file is copied into the app's own folder on that Mac, and the app goes to the Games screen with the new game in front, marked **On this Mac**. It is never uploaded and nobody else sees it, which makes it handy for trying a build before you push it to everyone. To remove it, bring it to the front and press **X** (the app asks first). A changed file counts as a new game with its own save.

To give such a game a picture, bring it to the front and press **Y** to choose one, or drop a picture (PNG, JPEG, GIF or WebP) onto the Games screen while that game is in front. Box art of any shape is shown whole. Until it has a picture, a game gets a plain Devious Licks box with its name on it. Like the game, the picture is copied into the app's own folder on that Mac and goes nowhere else. Removing the game removes its picture.

## Adding or updating a game

Everything players see comes from the `catalog/` folder.

1. Put the ROM in `catalog/roms/` and a cover image in `catalog/covers/` (it goes on the front of the game's box, whole, whatever its shape; upright box art looks best).
2. Add an entry to `catalog/games.json`:

   ```json
   {
     "id": "night-shift",
     "title": "Night Shift",
     "core": "gba",
     "version": "0.3.1",
     "description": "A sneaky stealth game about after-hours heists.",
     "players": 1,
     "year": 2026,
     "rom": "roms/night-shift.gba",
     "cover": "covers/night-shift.png"
   }
   ```

3. Commit and push. The **Catalog** GitHub Action fills in each ROM's `sha256` hash automatically (or run `npm run catalog` yourself). That hash is how the app spots changed games.

**Emulator settings for one game.** The N64 emulator recognises commercial games by a fingerprint of the whole file and gives each the settings it needs. A reskinned game has a different fingerprint, so it would get generic settings, and some games freeze with those. The app already knows the settings for the titles in `src/n64.js` (it recognises them by the game code in the ROM's header, which survives a reskin). For anything else, add an `options` object to the game's entry, for example:

```json
"options": { "mupen64plus-CountPerOp": "1" }
```

To update a game, replace its ROM file (keep the same `id`) and push. To remove one, delete its entry. Everyone gets the change the next time they open the app (or pick Refresh in Settings). Games are marked **new** or **updated** for a week.

| `core` | Console |
| --- | --- |
| `nes` | NES / Famicom |
| `snes` | Super Nintendo |
| `gb` / `gbc` | Game Boy / Game Boy Color |
| `gba` | Game Boy Advance |
| `segaMD` | Sega Genesis / Mega Drive |
| `n64` | Nintendo 64 |

The repo must be **public** so the app can download the catalog without a login.

## Releasing a new version of the app

You only need this when the app itself changes, not for game updates.

1. Bump `"version"` in `package.json` and commit.
2. On GitHub, open **Actions › Release Mac app › Run workflow**. (Untick **publish** there for a test build: everything runs, the files are kept with the run, nothing is published.) Pushing a tag named `v` + the version does the same. A release is published from the `main` branch only, and version numbers only go up: the workflow refuses anything else.

The workflow builds a universal (Apple Silicon + Intel) DMG and the files the app's **Update** button downloads (`update.json`, `app.asar`, and the built-in player's `dl-player` and `mupen64plus_next_libretro.dylib`), tests both on a Mac, and only then publishes release `v<version>`. The release starts as a hidden draft, every file is uploaded and read back, and it becomes public in one step at the end, so a run that fails on the way publishes nothing. Everyone on 0.3.2 or later gets the new version with the Update button. The DMG is for first installs, and for 0.3.1 and older, which have no Update button.

**How the Update button works.** These builds are not signed with an Apple developer certificate, so the app can't replace itself the way signed Mac apps do, and macOS guards an installed app against changes. An update therefore never touches the installed app. It is downloaded into the app's data folder (`~/Library/Application Support/Devious Licks/updates/<version>/`), every file is checked against the size and SHA-256 checksum in `update.json`, and at its next start the installed app runs that newer copy of its code instead of its own. A new version is on probation at its first start: its window has to come up, draw its page and stay up for a quarter of a minute. One that fails on the way, never opens its window (two minutes at most), or keeps dying or quitting (three starts) is set aside, and the app comes back up on the last version that worked, with a note saying what happened.

Things to know when you release:

- **A version that is out is never replaced.** The workflow refuses to publish the same version number twice: Macs that already have it would not get the change. Bump the version instead.
- **An update can't be taken back.** The app never goes to an older version, so deleting a release does not undo it on the Macs that took it. If a bad version got out, fix it and release a higher one.
- **Don't rename or delete this repository or the GitHub account it is under.** The address the Update button reads is built into every copy of the app. If the old name became free, somebody else could register it and hand out "updates" to everyone who has the app.
- **A new major engine version means a fresh DMG for everyone.** An update carries the app's code and the built-in player, not Electron itself. It works on any installed app whose Electron has the same first number (45.x); when that number changes, the Update button on older installs reads **Get x.y.z** and sends people to the download page. If new code needs something only a newer Electron of the same major has, say so with `needsApp` (next point).
- **`src/boot.js` and `src/packs.js` are the two files an update can't replace** (they are what starts an update), so the copies inside an installed app stay as they are until a fresh DMG is installed. What they accept and promise is written at the top of each file. If a version relies on a change to them, set `deviousLicks.update.needsApp` in `package.json` to that version: older installs are then sent to the download page instead of being given an update they can't run. `test/fixtures/packs-0.3.2.js` is the copy that shipped in 0.3.2: `npm test` checks that an update put in by today's code is still one it will start, and the release build refuses to make update files it would not start (unless `needsApp` says those installs need a fresh DMG). When a version ships with changed start-up code, add its copy next to it (`cp src/packs.js test/fixtures/packs-<version>.js`).
- **Getting back to a plain install:** while an update is running, right-click the app's icon in the Dock and choose **Restart Without Updates**: the app comes back on the version it was installed with and asks whether to stop using the update. (That menu item is put there by the installed app itself, so no update can leave a Mac without it.) The other ways: delete the `updates` folder in the app's data folder, or install a DMG of the same version as the update or a newer one. (An older DMG would go on running the newer update.) Whoever is comfortable in Terminal can also start the app with `--installed-code` (`open -a "Devious Licks" --args --installed-code`): it then runs the version it was installed with and offers to stop using the update for good.

- **The installed version is the safety net for ever, so the app's data only ever grows.** When an update is set aside, older code reads what the newer one saved (the library, the list of added games, save files). Keep those files readable by older versions: add fields or new files, never change what an existing field means. A version that has to break this must set `needsApp` to itself, which makes it a fresh-DMG release nobody can fall back behind.

`deviousLicks.update.notes` in `package.json` is an optional line that shows in the Update button's tooltip.

## Signing and notarization

Without an Apple Developer account, builds are ad-hoc signed and friends must use **Open Anyway** on first launch. To remove that step, join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year), create a **Developer ID Application** certificate, and add these repository secrets (Settings › Secrets and variables › Actions):

| Secret | What it is |
| --- | --- |
| `MAC_CERT_P12_BASE64` | The Developer ID certificate exported as .p12, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERT_PASSWORD` | The password you set when exporting the .p12 |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | Your 10-character Team ID |

The next release is then signed and notarized automatically.

## Development

```sh
npm install          # also copies EmulatorJS + cores into vendor/
npm run start:local  # run the app against the local catalog/ folder
npm start            # run against the GitHub catalog in package.json
npm test
npm run check:dashboard   # walks through the library window in a browser (needs Playwright)
```

A copy run from the source folder shares the installed app's data folder, but never runs or tidies away the updates that app has downloaded. Set `DL_USER_DATA=<folder>` to give a run a data folder of its own (it then also takes updates like the real app). Only one copy of the app runs per data folder: starting a second one brings the first to the front.

- `src/boot.js`: the first thing the app runs. It starts the newest usable update in the app's data folder, or else `src/main.js` of the installed app. `src/packs.js` has the rules for that (which update is usable, counting starts, setting a failing one aside), `src/updater.js` is the Update button's downloader, and `src/transport.js` is how it reaches GitHub (every redirect is checked before it is followed).
- `scripts/make-update.js` makes the update files out of the packaged app, and `scripts/test-update.js` runs the app against a stand-in for GitHub on the same machine. The app clicks its own Update button and takes a series of test updates: good ones (one copied from the running version where it can be, one downloaded whole), one that fails at start, one that quits at start, one that never opens a window, one that opens its window and dies, and one with a file the server sends off to another site; it also opens a second copy of the app while the first is running. The release workflow runs all of it on the packaged app and publishes nothing if it fails. `node scripts/test-update.js --source` does the same with the code in this folder (needs a display).
- `src/main.js`: Electron main process, windows and the `app://` protocol.
- `src/catalog.js`: syncs the catalog from GitHub into a local cache.
- `src/renderer/`: the library window (`index.html`, `app.js`) and the emulator page (`player.html`). `app.js` is the library's side of the window (the games, starting one, adding your own, the Update button). `dash/` is the dashboard it is shown in: `main.js` (which screen is up and what the commands mean on it), `travel.js`, `raster.js` and `cell.js` (the camera travel between screens), `carousel.js` (the Games rail), `grid.js`, `orb.js` and `chamber.js` (the moving backdrops; they rest while the window is not in front), `input.js` (keyboard and controller), `sound.js`, `prefs.js` (what Settings remembers) and `dash.css`.
- The dashboard's sounds are the four files in `src/renderer/dash/audio/`; which file is which, and how loud, is set at the top of `dash/sound.js`. To change a sound, replace its file (wav, ogg or mp3). A sound that can't be loaded is simply not played.
- `scripts/check-dashboard.js` (`npm run check:dashboard`) opens the window's page in a plain Chromium with a stand-in for the app behind it and goes through it: every screen and the travel between them, the rail with 0, 1 and 30 games, starting, removing and adding games, pictures, the Update button's states, a controller, sound, reduced motion, small and large windows. `--shots <folder>` saves pictures of it all. It needs [Playwright](https://playwright.dev/) (`npm install -g playwright`), which is not among the app's own dependencies, so it is not part of `npm test`.
- `src/n64.js`: per-title N64 emulator settings (see "Emulator settings for one game").
- `player/`: the native player used for N64. `dl-player.c` is a small [libretro](https://www.libretro.com/) frontend (SDL2 + OpenGL); `build-mac.sh` builds it and the N64 core on macOS, `selftest.sh` runs it against a stand-in core and two home-made N64 test cartridges (`test/`): one paints its picture pixel by pixel, the other draws the way a 3D game does (triangles, shading, a texture, the depth buffer) and plays a tone whose pitch the test measures. The release workflow runs both, before and after packaging, and publishes nothing if the picture is wrong. It also starts the packaged app itself once per chip (`--smoke-test`). `test/reference/run.js` runs a game file in the web build of the same emulator core in a headless browser, as a second opinion that needs no Mac (frames run, whether the picture keeps changing, the pitch of the sound, screenshots). When the picture is wrong, the self-test repeats the run with the player's OpenGL recorder on (`--gl-trace <frames> --gl-probe`: the OpenGL calls the core makes through the player, the errors OpenGL reports, the state a failed drawing call ran in, and the colours each framebuffer shows at the end of a frame) and prints the cartridge's notes from the console's memory (`--peek`), so the build log shows where the picture got lost.
- The dashboard's lettering is [Chakra Petch](https://github.com/m4rc1e/Chakra-Petch) Bold (a subset with the Latin letters), under the SIL Open Font License 1.1; the licence is next to it in `src/renderer/dash/fonts/`.
- Emulation is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) (GPL-3.0) running RetroArch cores, bundled so games play offline.
- The native N64 core is [Mupen64Plus-Next](https://github.com/libretro/mupen64plus-libretro-nx) (GPL-2.0-or-later), built from the commit pinned in `player/build-core.sh` with the three small patches in that script: two build fixes for current macOS SDKs, and one fix for a drawing set-up that macOS rejects (it left the picture black). Its licence ships inside the app next to it. [SDL2](https://www.libsdl.org/) is under the zlib licence.
