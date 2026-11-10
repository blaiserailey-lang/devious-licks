#!/usr/bin/env bash
# Checks the built player on this Mac before it ships:
#   1. both halves of the player (Apple Silicon and Intel) load the N64 core;
#   2. the player shows the right picture, and hears the right tone, with a
#      tiny stand-in core;
#   3. the real N64 core boots a home-made test cartridge and shows the four
#      coloured quarters that cartridge paints, pixel by pixel;
#   4. the same with a second cartridge that draws the way a 3D game does
#      (triangles, shading, a texture, the depth buffer) and plays a tone,
#      whose pitch has to come out of the core right.
#      If a picture is wrong, that run is repeated with the player's OpenGL
#      recorder on, to show where the picture got lost.
# The cartridges come from test/make-n64-test-rom.js; no game is involved.
#
#   player/selftest.sh                 test player/dist (what build-mac.sh made)
#   PLAYER_DIR=<folder> selftest.sh    test the copy inside a packaged app
set -uo pipefail
START="$PWD"
cd "$(dirname "$0")"
ROOT="$PWD"
WORK="$ROOT/.build"
TMP="$WORK/selftest"
DIR="${PLAYER_DIR:-$ROOT/dist}"
case "$DIR" in /*) ;; *) DIR="$START/$DIR" ;; esac # PLAYER_DIR may be relative to where the script was started
PLAYER="$DIR/dl-player"
N64="$DIR/mupen64plus_next_libretro.dylib"
TESTCORE="$WORK/test/test_libretro.dylib"
ICON="$ROOT/../build/icon.png"
QUARTERS="--expect tl=ff0000 --expect tr=00ff00 --expect bl=0000ff --expect br=ffffff"
# What the test cartridge leaves in the console's memory: its notes (a marker,
# the video settings read back, a running counter) and one pixel per quarter.
NOTES="--peek 400:10 --peek 1096a0 --peek 1097e0 --peek 11c2a0 --peek 11c3e0"
# The 3D cartridge: four squares with a gap between them, and a green square
# behind them that may only show in that gap (the centre of the picture). It
# also plays a 1000 Hz tone. Its notes count the drawing jobs it has handed to
# the graphics chip and show the graphics and sound chips' status.
QUARTERS_3D="--expect tl=ffff00 --expect tr=00ffff --expect bl=ff00ff --expect br=ff8400 --expect c=00c000 --expect-tone 1000"
NOTES_3D="--peek 400:12 --peek 1096a0 --peek 1097e0 --peek 11c2a0 --peek 11c3e0 --peek 112d40"
NATIVE="$(uname -m)"
# The test Macs on GitHub have no graphics chip: OpenGL is worked out by the
# processor there, and the N64 core's 1280x960 picture then takes about a third
# of a second per frame (longer for the Intel half, which is translated on top).
# The cartridges have their picture up within the first frames, so the N64 runs
# are kept short and get a generous time limit instead.
N64_FRAMES=40
N64_LIMIT=300
failures=0

echo "Testing $DIR"
[ -x "$PLAYER" ] || { echo "missing $PLAYER"; exit 1; }
[ -f "$N64" ] || { echo "missing $N64"; exit 1; }
rm -rf "$TMP"
mkdir -p "$TMP"
node "$ROOT/test/make-n64-test-rom.js" "$TMP/dl-test-cart.z64" || exit 1
node "$ROOT/test/make-n64-test-rom.js" --3d "$TMP/dl-test-cart-3d.z64" || exit 1
printf 'not a real game' >"$TMP/dummy.bin"

# macOS has no timeout(1). guard <seconds> <command...> stops a run that is
# still going after that long; the exit code is then 142.
guard() { perl -e 'alarm shift; exec @ARGV or die "could not run $ARGV[0]: $!\n"' "$@"; }
can_run() { arch -"$1" /usr/bin/true 2>/dev/null; }

echo "== 1. Both architectures load the N64 core"
for a in arm64 x86_64; do
  if ! can_run "$a"; then
    echo "   $a: this Mac can't run $a programs, skipped"
  elif out="$(guard 60 arch -"$a" "$PLAYER" --check --core "$N64" 2>&1)"; then
    echo "   $a: $out"
  else
    echo "   $a: FAILED: $out"
    failures=$((failures + 1))
  fi
done

# run <label> <arch> <player arguments...>; returns the player's exit code
# LOG_LINES=<n> shows up to that many lines of the run's log (default: the last 80)
# LIMIT=<seconds> is how long the run may take (default: 90)
run() {
  local label="$1" a="$2" code lines
  shift 2
  echo "== $label"
  limit="${LIMIT:-90}"
  guard "$limit" arch -"$a" "$PLAYER" "$@" --title "Self-test" --icon "$ICON" \
    --save-dir "$TMP/saves" --system-dir "$TMP/system" >"$TMP/run.log" 2>&1
  code=$?
  lines="$(wc -l <"$TMP/run.log" | tr -d ' ')"
  if [ -z "${LOG_LINES:-}" ]; then
    tail -80 "$TMP/run.log" | cut -c1-300 | sed 's/^/   /'
  elif [ "$lines" -le "$LOG_LINES" ]; then
    cut -c1-240 "$TMP/run.log" | sed 's/^/   /'
  else
    head -n $((LOG_LINES / 3)) "$TMP/run.log" | cut -c1-240 | sed 's/^/   /'
    echo "   ... ($((lines - LOG_LINES)) lines left out) ..."
    tail -n $((LOG_LINES - LOG_LINES / 3)) "$TMP/run.log" | cut -c1-240 | sed 's/^/   /'
  fi
  return $code
}
check() { # check <exit code>
  case "$1" in
    0) ;;
    142) echo "   FAILED: still running after $limit seconds"; failures=$((failures + 1)) ;;
    *) echo "   FAILED (exit code $1)"; failures=$((failures + 1)) ;;
  esac
}

run "2. Stand-in core, software picture ($NATIVE)" "$NATIVE" --core "$TESTCORE" --rom "$TMP/dummy.bin" \
  --option test-mode=software --frames 120 $QUARTERS --expect-tone 441
code=$?
if [ "$code" = 4 ] && [ -z "${GITHUB_ACTIONS:-}" ]; then
  # No window server or no OpenGL on this machine: nothing visual can be tested.
  # (On GitHub's Macs there is one, so there it counts as the failure it is:
  # a release must never go out with the picture untested.)
  echo "::warning::The player self-test could not open an OpenGL window on this Mac, so the picture checks were skipped."
  [ "$failures" = 0 ] || exit 1
  exit 0
fi
check "$code"

run "2. Stand-in core, OpenGL picture ($NATIVE)" "$NATIVE" --core "$TESTCORE" --rom "$TMP/dummy.bin" \
  --option test-mode=hw --frames 120 $QUARTERS --expect-tone 441
check $?

for a in "$NATIVE" x86_64; do
  if [ "$a" = "$NATIVE" ] && [ -n "${tested_native:-}" ]; then continue; fi
  [ "$a" = "$NATIVE" ] && tested_native=1
  if ! can_run "$a"; then
    echo "== 3. N64 core ($a): this Mac can't run $a programs, skipped"
    continue
  fi
  for cart in 2D 3D; do
    if [ "$cart" = 2D ]; then
      step=3 rom="$TMP/dl-test-cart.z64" want="$QUARTERS" notes="$NOTES"
    else
      step=4 rom="$TMP/dl-test-cart-3d.z64" want="$QUARTERS_3D" notes="$NOTES_3D"
    fi
    LIMIT=$N64_LIMIT run "$step. N64 core runs the $cart test cartridge ($a)" "$a" --core "$N64" --rom "$rom" \
      --option mupen64plus-CountPerOp=1 --frames $N64_FRAMES $want $notes
    code=$?
    check "$code"
    if grep -q "shutting down faulted or took too long" "$TMP/run.log"; then
      echo "::notice::The N64 core faulted or hung while shutting down ($a). The player ignores that; saves are written first."
    fi
    # the first run that fails is looked at more closely below
    if [ "$code" != 0 ] && [ -z "${diagnose:-}" ]; then
      diagnose="$a" diagnose_cart="$cart" diagnose_rom="$rom" diagnose_want="$want" diagnose_notes="$notes"
    fi
  done
done

if [ -n "${diagnose:-}" ]; then
  echo "== The failed $diagnose_cart run again, one emulator setting changed at a time ($diagnose)"
  for variant in mupen64plus-EnableOverscan=Disabled mupen64plus-EnableCopyColorToRDRAM=Off \
    mupen64plus-EnableCopyColorFromRDRAM=True mupen64plus-EnableNativeResFactor=1; do
    guard "$N64_LIMIT" arch -"$diagnose" "$PLAYER" --core "$N64" --rom "$diagnose_rom" --title "Self-test" \
      --save-dir "$TMP/saves" --system-dir "$TMP/system" --option mupen64plus-CountPerOp=1 --option "$variant" \
      --frames $N64_FRAMES $diagnose_want >"$TMP/variant.log" 2>&1
    echo "   $variant: exit code $?"
    grep -E '^\[selftest\] (frames|core|screen|sound)' "$TMP/variant.log" | cut -c1-120 | sed 's/^/      /'
  done
  LOG_LINES=600 LIMIT=$N64_LIMIT run "The failed $diagnose_cart run again with the OpenGL recorder on ($diagnose)" "$diagnose" --core "$N64" \
    --rom "$diagnose_rom" --option mupen64plus-CountPerOp=1 --frames $N64_FRAMES $diagnose_want $diagnose_notes --gl-trace 2 --gl-probe
  echo "   (recorded run: exit code $?)"
fi

if [ "$failures" != 0 ]; then
  echo "SELF-TEST FAILED ($failures)"
  exit 1
fi
echo "SELF-TEST PASSED"
