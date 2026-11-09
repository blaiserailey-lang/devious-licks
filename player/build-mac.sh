#!/usr/bin/env bash
# Builds the native Devious Licks Player and its N64 core as universal
# (Apple Silicon + Intel) binaries into player/dist/. Runs on macOS (CI).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
WORK="$ROOT/.build"
DIST="$ROOT/dist"
SDL_VERSION=2.30.9
# Pinned mupen64plus-libretro-nx commit (the N64 emulator core).
M64_COMMIT=15bada85906593376e8fd697f1b0b3af3a20f512
SDK="$(xcrun --show-sdk-path)"
JOBS="$(sysctl -n hw.ncpu)"
mkdir -p "$WORK" "$DIST"

# 1. SDL2, static, universal
if [ ! -f "$WORK/sdl/lib/libSDL2.a" ]; then
  curl -fsSL "https://github.com/libsdl-org/SDL/releases/download/release-$SDL_VERSION/SDL2-$SDL_VERSION.tar.gz" | tar xz -C "$WORK"
  cmake -S "$WORK/SDL2-$SDL_VERSION" -B "$WORK/sdl-build" -DCMAKE_BUILD_TYPE=Release \
    -DSDL_SHARED=OFF -DSDL_STATIC=ON -DSDL_TEST=OFF \
    -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
    -DCMAKE_INSTALL_PREFIX="$WORK/sdl"
  cmake --build "$WORK/sdl-build" -j"$JOBS"
  cmake --install "$WORK/sdl-build"
fi

# 2. The player
clang -O2 -Wall -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -I"$WORK/sdl/include/SDL2" -D_THREAD_SAFE dl-player.c -o "$DIST/dl-player" \
  "$WORK/sdl/lib/libSDL2.a" -liconv -lm \
  -framework Cocoa -framework IOKit -framework CoreAudio -framework AudioToolbox -framework CoreVideo \
  -framework Carbon -framework ForceFeedback -framework GameController -framework Metal -framework QuartzCore \
  -framework CoreHaptics -framework CoreFoundation -Wl,-weak_framework,UniformTypeIdentifiers

# 3. The N64 core (one build per architecture, then merged)
if [ ! -f "$WORK/mupen64plus_next_libretro.dylib" ]; then
  if [ ! -d "$WORK/m64" ]; then
    git clone --filter=blob:none https://github.com/libretro/mupen64plus-libretro-nx.git "$WORK/m64"
  fi
  git -C "$WORK/m64" checkout -q "$M64_COMMIT"
  for target in arm64-apple-macos11 x86_64-apple-macos10.15; do
    make -C "$WORK/m64" clean >/dev/null
    make -C "$WORK/m64" -j"$JOBS" platform=osx CROSS_COMPILE=1 \
      LIBRETRO_APPLE_PLATFORM="$target" LIBRETRO_APPLE_ISYSROOT="$SDK" \
      HAVE_PARALLEL_RDP=0 HAVE_PARALLEL_RSP=0 HAVE_THR_AL=0 LLE=0
    cp "$WORK/m64/mupen64plus_next_libretro.dylib" "$WORK/core-$target.dylib"
  done
  lipo -create "$WORK"/core-*.dylib -output "$WORK/mupen64plus_next_libretro.dylib"
fi
cp "$WORK/mupen64plus_next_libretro.dylib" "$DIST/"
cp "$WORK/m64/LICENSE" "$DIST/LICENSE-mupen64plus-libretro-nx.txt"
lipo -info "$DIST/dl-player" "$DIST/mupen64plus_next_libretro.dylib"
