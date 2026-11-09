# Devious Licks

The Devious Licks game library for Mac. It shows every Devious Licks game, plays them with a built-in emulator, and pulls new and updated games from this repo whenever someone presses **Refresh** (it also checks every time the app opens).

## Download (for friends)

Grab the latest `Devious-Licks-x.y.z.dmg` from the **Releases** page:
`https://github.com/blaiserailey-lang/devious-licks/releases/latest`

Open the DMG and drag **Devious Licks** into Applications.

> **First launch on an unsigned build:** macOS will say it can't verify the app. Click **Done**, then open **System Settings › Privacy & Security**, scroll down and click **Open Anyway** next to "Devious Licks". You only do this once. (Signed builds skip this, see "Signing" below.)

Controls: arrow keys for the D-pad, **Z** = A, **X** = B, **Enter** = Start, **V** = Select. Game controllers work too. Click the gamepad icon in the emulator's toolbar to remap.

If a game stops starting after you change an emulator setting, hold **Option** while clicking the game to start it with default settings.

**N64 games** run in the app's native player (a separate Devious Licks window), because N64 is too heavy for the built-in web emulator. N64 keyboard controls: arrows = stick, **X** = A, **C** = B, **Z** = Z trigger, **Q**/**E** = L/R, **Enter** = Start, **I/J/K/L** = C buttons, **F5** = save state, **F9** = load state, **Cmd+F** = fullscreen, **Esc** = exit fullscreen or close. Game controllers work too. Option-click an N64 game to use the built-in web emulator instead.

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
2. On GitHub, open **Actions › Release Mac app › Run workflow**. It builds the DMG and publishes release `v<version>`. Pushing a tag such as `v0.2.0`, or publishing a release on the Releases page, works too.

The **Release Mac app** GitHub Action builds a universal (Apple Silicon + Intel) DMG and attaches it to a GitHub Release.

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

- `src/main.js`: Electron main process, windows and the `app://` protocol.
- `src/catalog.js`: syncs the catalog from GitHub into a local cache.
- `src/renderer/`: the library UI (`index.html`) and the emulator page (`player.html`).
- Emulation is [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) (GPL-3.0) running RetroArch cores, bundled so games play offline.
