#!/usr/bin/env bash
# Builds the N64 emulator core (Mupen64Plus-Next, GPL-2.0-or-later) as a
# universal (Apple Silicon + Intel) libretro core into player/.build/core.
# Runs on macOS (CI). Does nothing when it is already built.
#
# The source is the upstream repository at a pinned commit, plus the two small
# patches below. Nothing else is changed.
set -uo pipefail
cd "$(dirname "$0")"
WORK="$PWD/.build"
OUT="$WORK/core"
SRC="$WORK/m64"
M64_REPO=https://github.com/libretro/mupen64plus-libretro-nx.git
M64_COMMIT=15bada85906593376e8fd697f1b0b3af3a20f512
NAME=mupen64plus_next_libretro.dylib
TARGETS="arm64-apple-macos11 x86_64-apple-macos11"

if [ -f "$OUT/$NAME" ] && [ -f "$OUT/LICENSE" ]; then
  echo "N64 core: already built"
  lipo -info "$OUT/$NAME"
  exit 0
fi

fail() { echo "build-core: $*" >&2; exit 1; }
SDK="$(xcrun --show-sdk-path)" || fail "no macOS SDK"
JOBS="$(sysctl -n hw.ncpu)"
mkdir -p "$WORK" "$OUT"

# --- source, at exactly the pinned commit
if [ ! -d "$SRC/.git" ]; then
  rm -rf "$SRC"
  git init -q "$SRC" || fail "git init"
  git -C "$SRC" remote add origin "$M64_REPO" || fail "git remote"
fi
git -C "$SRC" fetch -q --depth 1 origin "$M64_COMMIT" || fail "could not download the core's source"
git -C "$SRC" checkout -q -f FETCH_HEAD || fail "git checkout"
git -C "$SRC" clean -q -fdx
[ "$(git -C "$SRC" rev-parse HEAD)" = "$M64_COMMIT" ] || fail "checked out the wrong commit"

# --- patches. The core carries old copies of libpng and zlib that still have
# code for the classic (pre-2001) Mac OS. Current macOS SDKs define the macro
# those copies test for (TARGET_OS_MAC), so they wrongly take that path.
PNGPRIV="$SRC/custom/dependencies/libpng/pngpriv.h"
ZUTIL="$SRC/custom/dependencies/libzlib/zutil.h"
# libpng: <fp.h> only existed on classic Mac OS; <math.h> is its replacement.
sed -i '' -e 's|#      include <fp.h>|#      include <math.h>|' "$PNGPRIV" || fail "could not patch libpng"
if grep -q 'include <fp.h>' "$PNGPRIV"; then fail "the libpng patch did not apply"; fi
# zlib: don't replace fdopen() with NULL, which also breaks <stdio.h>.
sed -i '' -e 's/#if defined(MACOS) || defined(TARGET_OS_MAC)/#if defined(MACOS)/' "$ZUTIL" || fail "could not patch zlib"
if grep -q 'defined(TARGET_OS_MAC)' "$ZUTIL"; then fail "the zlib patch did not apply"; fi

# --- build, one architecture at a time
# The core's C code predates today's compilers, which turned several old habits
# from warnings into errors. Keep them as warnings, exactly as the core expects.
RELAX="-Wno-error=implicit-function-declaration -Wno-error=incompatible-function-pointer-types"
RELAX="$RELAX -Wno-error=incompatible-pointer-types -Wno-error=int-conversion -Wno-error=implicit-int"
FAILED=""
for target in $TARGETS; do
  LOG="$WORK/core-$target.log"
  rm -f "$WORK/core-$target.dylib"
  make -C "$SRC" platform=osx clean >/dev/null 2>&1
  echo "::group::N64 core for $target"
  started=$SECONDS
  # -k: keep going after an error, so one run shows everything that is wrong.
  # LLE / angrylion / paraLLEl are the slow "low level" renderers; the app uses
  # GLideN64 with high-level emulation, so they are left out.
  if CPPFLAGS="$RELAX" make -C "$SRC" -k -j"$JOBS" platform=osx CROSS_COMPILE=1 \
      LIBRETRO_APPLE_PLATFORM="$target" LIBRETRO_APPLE_ISYSROOT="$SDK" \
      HAVE_PARALLEL_RDP=0 HAVE_PARALLEL_RSP=0 HAVE_THR_AL=0 LLE=0 >"$LOG" 2>&1 && [ -f "$SRC/$NAME" ]; then
    cp "$SRC/$NAME" "$WORK/core-$target.dylib"
    echo "built in $((SECONDS - started))s, $(grep -c 'warning:' "$LOG") warnings"
  else
    FAILED="$FAILED $target"
    echo "FAILED after $((SECONDS - started))s. Errors:"
    grep -n -A10 -E '(^|[^a-z-])error[: ]|Undefined symbols|ld: |No rule to make|No such file' "$LOG" | cut -c1-400 | head -400
    echo "--- last lines of the log"
    tail -25 "$LOG" | cut -c1-400
  fi
  echo "::endgroup::"
done
[ -z "$FAILED" ] || fail "the N64 core did not build for:$FAILED"

set -- $TARGETS
lipo -create "$WORK/core-$1.dylib" "$WORK/core-$2.dylib" -output "$OUT/$NAME" || fail "lipo"
cp "$SRC/LICENSE" "$OUT/LICENSE" || fail "the core's licence file is missing"
echo "N64 core: built"
lipo -info "$OUT/$NAME"
otool -L "$OUT/$NAME" | sed -n '1,40p'
