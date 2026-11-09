#!/usr/bin/env bash
# Builds everything the app needs to play N64 games natively, as universal
# (Apple Silicon + Intel) binaries, into player/dist/:
#   dl-player                          the Devious Licks Player (dl-player.c)
#   mupen64plus_next_libretro.dylib    the N64 emulator core
# Runs on macOS (CI). player/selftest.sh then checks the result.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
WORK="$ROOT/.build"
DIST="$ROOT/dist"

echo "macOS $(sw_vers -productVersion) on $(uname -m), $(clang --version | head -1)"
./build-sdl.sh
./build-core.sh

rm -rf "$DIST" "$WORK/test"
mkdir -p "$DIST" "$WORK/test"
UNIVERSAL="-arch arm64 -arch x86_64 -mmacosx-version-min=11.0"

# The player. SDL2 is linked in, so it needs the system frameworks SDL2 uses.
clang -O2 -Wall $UNIVERSAL -I"$WORK/sdl/include/SDL2" -D_THREAD_SAFE dl-player.c -o "$DIST/dl-player" \
  "$WORK/sdl/lib/libSDL2.a" -liconv -lm -lobjc \
  -Wl,-sectcreate,__TEXT,__info_plist,Info.plist \
  -framework Cocoa -framework IOKit -framework CoreAudio -framework AudioToolbox -framework CoreVideo \
  -framework Carbon -framework ForceFeedback -framework GameController -framework Metal -framework QuartzCore \
  -framework CoreHaptics -framework CoreFoundation -Wl,-weak_framework,UniformTypeIdentifiers

# A tiny stand-in core, only used by the self-test (not shipped).
clang -O2 -Wall $UNIVERSAL -dynamiclib -I"$ROOT" test/test-core.c -o "$WORK/test/test_libretro.dylib"

cp "$WORK/core/mupen64plus_next_libretro.dylib" "$DIST/"
cp "$WORK/core/LICENSE" "$DIST/LICENSE-mupen64plus-libretro-nx.txt"
cp "$WORK/sdl/LICENSE-SDL2.txt" "$DIST/"

echo "--- player/dist"
ls -l "$DIST"
lipo -info "$DIST/dl-player" "$DIST/mupen64plus_next_libretro.dylib"
otool -L "$DIST/dl-player" | sed -n '1,30p'
