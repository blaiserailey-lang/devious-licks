# Devious Licks

The Devious Licks game library for Mac. It shows every Devious Licks game, plays them with a built-in emulator, and pulls new and updated games from this repo whenever someone presses **Refresh** (it also checks every time the app opens).

## Download (for friends)

Grab the latest `Devious-Licks-x.y.z.dmg` from the **Releases** page:
`https://github.com/blaiserailey-lang/devious-licks/releases/latest`

Open the DMG and drag **Devious Licks** into Applications.

> **First launch on an unsigned build:** macOS will say it can't verify the app. Click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to "Devious Licks". You only do this once. (Signed builds skip this, see "Signing" below.)

**Updating the app.** You install from the DMG once. After that, click **Update** in the app: it downloads the newest version from this repo's releases and restarts on it (the button reads **Update to x.y.z** when there is one; the app looks every time it opens). No DMG, no dragging, no trip to Privacy & Security. The version you are on is at the bottom of the window. Now and then a version needs a fresh DMG after all (the button then reads **Get x.y.z** and opens the download page); see "Releasing a new version of the app".

Controls: arrow keys for the D-pad, **Z** = A, **X** = B, **Enter** = Start, **V** = Select. Game controllers work too. Click the gamepad icon in the emulator's toolbar to remap.

If a game stops starting after you change an emulator setting, hold **Option** while clicking the game to start it with default settings.

**N64 games** run in the app's own native player (a separate Devious Licks window), because N64 is too heavy for the built-in web emulator. The player and its N64 emulator are inside the app; nothing else needs to be installed. N64 keyboard controls: arrows = stick, **X** = A, **C** = B, **Z** = Z trigger, **Q**/**E** = L/R, **Enter** = Start, **I/J/K/L** = C buttons, **W/A/S/D** = D-pad, **F5** = save state, **F9** = load state, **Cmd+F** = fullscreen, **Cmd+R** = reset, **Esc** = exit fullscreen or close. Game controllers work too: the first one is player 1 (together with the keyboard), the next ones are players 2 to 4. Option-click an N64 game to use the built-in web emulator instead.

If an N64 game misbehaves, the player's log is at `~/Library/Application Support/Devious Licks/logs/player-n64.log`. Shift-click the game to start it with the graphics recorder on: the log then also lists the emulator's OpenGL calls for the first frames and every OpenGL error, and pressing **F8** in the game window records one more frame (do that while the picture looks wrong).

## Playing a game file on just your Mac

Click **Add game** (or drag a ROM onto the library window). The file is copied into the app's own folder on that Mac and shows up with an **On this Mac** tag. It is never uploaded and nobody else sees it, which makes it handy for trying a build before you push it to everyone. Hover the card and click **×** to remove it.

## Adding or updating a game

Everything players see comes from the `catalog/` folder.

1. Put the ROM in `catalog/roms/` and a cover image (4:3 works best, e.g. 320×240 PNG) in `catalog/covers/`.
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

To update a game, replace its ROM file (keep the same `id`) and push. To remove one, delete its entry. Everyone gets the change the next time they press Refresh. Games show a **New** or **Updated** badge for a week.

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

1. Bump `"version"` in `package.json`.
2. On GitHub, open **Actions › Release Mac app › Run workflow**. It builds the DMG and publishes release `v<version>`. (Untick **publish** there for a test build: everything runs, the DMG is kept with the run, nothing is published.) Pushing a tag such as `v0.2.0`, or publishing a release on the Releases page, works too.

The **Release Mac app** GitHub Action builds a universal (Apple Silicon + Intel) DMG and attaches it to a GitHub Release, together with the files the app's **Update** button downloads (`update.json`, `app.asar`, and the built-in player's `dl-player` and `mupen64plus_next_libretro.dylib`). Everyone who has the app gets the new version by clicking Update; the DMG is for first installs.

**How the Update button works.** These builds are not signed with an Apple developer certificate, so the app can't replace itself the way signed Mac apps do, and macOS guards an installed app against changes. An update therefore never touches the installed app. It is downloaded into the app's data folder (`~/Library/Application Support/Devious Licks/updates/<version>/`), every file is checked against the size and SHA-256 checksum in `update.json`, and at its next start the installed app runs that newer copy of its code instead of its own. A version that fails to start is set aside automatically and the app comes back up on the last one that worked. Deleting the `updates` folder, or installing the newest DMG, always gets you back to a plain install.

Three things to know when you release:

- **The release has to be named `v` + the version in `package.json`** (the workflow refuses anything else), and a version that is out must never be published again with different contents: apps that already have it would not notice. Bump the version instead.
- **A new engine means a fresh DMG for everyone.** The update carries the app's code and the built-in player, not Electron itself. When the `electron` version in `package.json` changes, the Update button on older installs reads **Get x.y.z** and sends people to the download page.
- **`src/boot.js` and `src/packs.js` are the two files an update can't replace** (they are what starts an update), so they only change with a fresh DMG. If a version relies on a change to them, set `deviousLicks.update.needsApp` in `package.json` to that version: older installs are then sent to the download page instead of being given an update they can't run.

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
```

- `src/boot.js`: the first thing the app runs. It starts the newest usable update in the app's data folder, or else `src/main.js` of the installed app. `src/packs.js` has the rules for that (which update is usable, counting starts, setting a failing one aside), and `src/updater.js` is the Update button's downloader.
- `scripts/make-update.js` makes the update files out of the packaged app, and `scripts/test-update.js` runs the app against a stand-in for GitHub on the same machine and has it take three test updates: a good one, one that fails at start, and one that never comes up. The release workflow runs it on the packaged app and publishes nothing if it fails. `node scripts/test-update.js --source` does the same with the code in this folder (needs a display).
- `src/main.js`: Electron main process, windows and the `app://` protocol.
- `src/catalog.js`: syncs the catalog from GitHub into a local cache.
- `src/renderer/`: the library UI (`index.html`) and the emulator page (`player.html`).
- `src/n64.js`: per-title N64 emulator settings (see "Emulator settings for one game").
- `player/`: the native player used for N64. `dl-player.c` is a small [libretro](https://www.libretro.com/) frontend (SDL2 + OpenGL); `build-mac.sh` builds it and the N64 core on macOS, `selftest.sh` runs it against a stand-in core and two home-made N64 test cartridges (`test/`): one paints its picture pixel by pixel, the other draws the way a 3D game does (triangles, shading, a texture, the depth buffer) and plays a tone whose pitch the test measures. The release workflow runs both, before and after packaging, and publishes nothing if the picture is wrong. It also starts the packaged app itself once per chip (`--smoke-test`). `test/reference/run.js` runs a game file in the web build of the same emulator core in a headless browser, as a second opinion that needs no Mac (frames run, whether the picture keeps changing, the pitch of the sound, screenshots). When the picture is wrong, the self-test repeats the run with the player's OpenGL recorder on (`--gl-trace <frames> --gl-probe`: the OpenGL calls the core makes through the player, the errors OpenGL reports, the state a failed drawing call ran in, and the colours each framebuffer shows at the end of a frame) and prints the cartridge's notes from the console's memory (`--peek`), so the build log shows where the picture got lost.
- Emulation is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) (GPL-3.0) running RetroArch cores, bundled so games play offline.
- The native N64 core is [Mupen64Plus-Next](https://github.com/libretro/mupen64plus-libretro-nx) (GPL-2.0-or-later), built from the commit pinned in `player/build-core.sh` with the three small patches in that script: two build fixes for current macOS SDKs, and one fix for a drawing set-up that macOS rejects (it left the picture black). Its licence ships inside the app next to it. [SDL2](https://www.libsdl.org/) is under the zlib licence.
