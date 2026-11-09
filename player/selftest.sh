#!/usr/bin/env bash
# Checks the built player on this Mac before it ships:
#   1. both halves of the player (Apple Silicon and Intel) load the N64 core;
#   2. the player shows the right picture with a tiny stand-in core;
#   3. the real N64 core boots a home-made test cartridge and shows the four
#      coloured quarters that cartridge draws.
# The cartridge comes from test/make-n64-test-rom.js; no game is involved.
#
#   player/selftest.sh                 test player/dist (what build-mac.sh made)
#   PLAYER_DIR=<folder> selftest.sh    test the copy inside a packaged app
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
WORK="$ROOT/.build"
TMP="$WORK/selftest"
DIR="${PLAYER_DIR:-$ROOT/dist}"
PLAYER="$DIR/dl-player"
N64="$DIR/mupen64plus_next_libretro.dylib"
TESTCORE="$WORK/test/test_libretro.dylib"
ICON="$ROOT/../build/icon.png"
QUARTERS="--expect tl=ff0000 --expect tr=00ff00 --expect bl=0000ff --expect br=ffffff"
NATIVE="$(uname -m)"
failures=0

echo "Testing $DIR"
[ -x "$PLAYER" ] || { echo "missing $PLAYER"; exit 1; }
[ -f "$N64" ] || { echo "missing $N64"; exit 1; }
rm -rf "$TMP"
mkdir -p "$TMP"
node "$ROOT/test/make-n64-test-rom.js" "$TMP/dl-test-cart.z64" || exit 1
printf 'not a real game' >"$TMP/dummy.bin"

# macOS has no timeout(1): give each run 90 seconds, then stop it.
guard() { perl -e 'alarm 90; exec @ARGV or die "could not run $ARGV[0]: $!\n"' "$@"; }
can_run() { arch -"$1" /usr/bin/true 2>/dev/null; }

echo "== 1. Both architectures load the N64 core"
for a in arm64 x86_64; do
  if ! can_run "$a"; then
    echo "   $a: this Mac can't run $a programs, skipped"
  elif out="$(guard arch -"$a" "$PLAYER" --check --core "$N64" 2>&1)"; then
    echo "   $a: $out"
  else
    echo "   $a: FAILED: $out"
    failures=$((failures + 1))
  fi
done

# run <label> <arch> <player arguments...>; returns the player's exit code
run() {
  local label="$1" a="$2" code
  shift 2
  echo "== $label"
  guard arch -"$a" "$PLAYER" "$@" --title "Self-test" --icon "$ICON" \
    --save-dir "$TMP/saves" --system-dir "$TMP/system" >"$TMP/run.log" 2>&1
  code=$?
  tail -80 "$TMP/run.log" | cut -c1-300 | sed 's/^/   /'
  return $code
}
check() { # check <exit code>
  case "$1" in
    0) ;;
    142) echo "   FAILED: still running after 90 seconds"; failures=$((failures + 1)) ;;
    *) echo "   FAILED (exit code $1)"; failures=$((failures + 1)) ;;
  esac
}

run "2. Stand-in core, software picture ($NATIVE)" "$NATIVE" --core "$TESTCORE" --rom "$TMP/dummy.bin" \
  --option test-mode=software --frames 120 $QUARTERS
code=$?
if [ "$code" = 4 ]; then
  # No window server or no OpenGL on this machine: nothing visual can be tested.
  echo "::warning::The player self-test could not open an OpenGL window on this Mac, so the picture checks were skipped."
  [ "$failures" = 0 ] || exit 1
  exit 0
fi
check "$code"

run "2. Stand-in core, OpenGL picture ($NATIVE)" "$NATIVE" --core "$TESTCORE" --rom "$TMP/dummy.bin" \
  --option test-mode=hw --frames 120 $QUARTERS
check $?

for a in "$NATIVE" x86_64; do
  if [ "$a" = "$NATIVE" ] && [ -n "${tested_native:-}" ]; then continue; fi
  [ "$a" = "$NATIVE" ] && tested_native=1
  if ! can_run "$a"; then
    echo "== 3. N64 core ($a): this Mac can't run $a programs, skipped"
    continue
  fi
  run "3. N64 core runs the test cartridge ($a)" "$a" --core "$N64" --rom "$TMP/dl-test-cart.z64" \
    --option mupen64plus-CountPerOp=1 --frames 240 $QUARTERS
  check $?
  if grep -q "faulted while shutting down" "$TMP/run.log"; then
    echo "::notice::The N64 core faulted while shutting down ($a). The player ignores that; saves are written first."
  fi
done

if [ "$failures" != 0 ]; then
  echo "SELF-TEST FAILED ($failures)"
  exit 1
fi
echo "SELF-TEST PASSED"
