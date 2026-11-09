#!/usr/bin/env bash
# Builds SDL2 (window, sound and controller library, zlib licence) as a static,
# universal (Apple Silicon + Intel) library into player/.build/sdl.
# Runs on macOS (CI). Does nothing when it is already built.
set -euo pipefail
cd "$(dirname "$0")"
WORK="$PWD/.build"
SDL_VERSION=2.30.9
SDL_SHA256=24b574f71c87a763f50704bbb630cbe38298d544a1f890f099a4696b1d6beba4
JOBS="$(sysctl -n hw.ncpu)"

if [ -f "$WORK/sdl/lib/libSDL2.a" ] && [ -f "$WORK/sdl/LICENSE-SDL2.txt" ]; then
  echo "SDL2 $SDL_VERSION: already built"
  exit 0
fi

mkdir -p "$WORK"
TARBALL="$WORK/SDL2-$SDL_VERSION.tar.gz"
curl -fsSL --retry 3 -o "$TARBALL" "https://github.com/libsdl-org/SDL/releases/download/release-$SDL_VERSION/SDL2-$SDL_VERSION.tar.gz"
echo "$SDL_SHA256  $TARBALL" | shasum -a 256 -c -
rm -rf "$WORK/SDL2-$SDL_VERSION" "$WORK/sdl-build" "$WORK/sdl"
tar xzf "$TARBALL" -C "$WORK"

LOG="$WORK/sdl-build.log"
if ! {
  cmake -S "$WORK/SDL2-$SDL_VERSION" -B "$WORK/sdl-build" -DCMAKE_BUILD_TYPE=Release \
    -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST=OFF \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
    -DCMAKE_INSTALL_PREFIX="$WORK/sdl" &&
  cmake --build "$WORK/sdl-build" -j"$JOBS" &&
  cmake --install "$WORK/sdl-build"
} >"$LOG" 2>&1; then
  echo "SDL2 build failed. Last lines of the log:"
  grep -n -B2 -A8 -E 'error[: ]|Error ' "$LOG" | head -150
  tail -40 "$LOG"
  exit 1
fi
cp "$WORK/SDL2-$SDL_VERSION/LICENSE.txt" "$WORK/sdl/LICENSE-SDL2.txt"
echo "SDL2 $SDL_VERSION: built"
lipo -info "$WORK/sdl/lib/libSDL2.a"
