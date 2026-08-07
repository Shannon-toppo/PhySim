#!/usr/bin/env bash
# Builds macOS universal (arm64 + x86_64) luasocket C cores against the Lua 5.3
# ABI, matching the pure-Lua LuaSocket 3.0-rc1 that LifeBoatAPI bundles.
#
# Outputs:
#   luasocket/darwin/socket/core.so
#   luasocket/darwin/mime/core.so
#   luasocket/darwin/LICENSE
#
# See CLAUDE.md "LifeBoatAPI integration" for why the sandbox needs a C core
# at all (require("socket") fails inside SimulatorSandbox without one).

set -euo pipefail

LUASOCKET_TAG="v3.0-rc1"
LUASOCKET_URL="https://github.com/diegonehab/luasocket/archive/refs/tags/${LUASOCKET_TAG}.tar.gz"
LUA_VERSION="5.3.6"
LUA_URL="https://www.lua.org/ftp/lua-${LUA_VERSION}.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${REPO_ROOT}/luasocket/darwin"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "${BUILD_DIR}"' EXIT

echo "==> Build dir: ${BUILD_DIR}"

echo "==> Downloading luasocket ${LUASOCKET_TAG}"
curl -L --fail -o "${BUILD_DIR}/luasocket.tar.gz" "${LUASOCKET_URL}"
echo "==> Downloading Lua ${LUA_VERSION} (headers only)"
curl -L --fail -o "${BUILD_DIR}/lua.tar.gz" "${LUA_URL}"

tar xzf "${BUILD_DIR}/luasocket.tar.gz" -C "${BUILD_DIR}"
tar xzf "${BUILD_DIR}/lua.tar.gz" -C "${BUILD_DIR}"

LUASOCKET_SRC="$(find "${BUILD_DIR}" -maxdepth 1 -type d -name 'luasocket-*')"
LUA_SRC="${BUILD_DIR}/lua-${LUA_VERSION}/src"

if [ ! -d "${LUASOCKET_SRC}" ]; then
  echo "error: could not locate extracted luasocket source dir" >&2
  exit 1
fi
if [ ! -d "${LUA_SRC}" ]; then
  echo "error: could not locate extracted lua source dir" >&2
  exit 1
fi

SRC="${LUASOCKET_SRC}/src"

# Flags mirror src/makefile's macosx target (DEF_macosx / CFLAGS_macosx),
# confirmed against the v3.0-rc1 makefile's SOCKET_OBJS / MIME_OBJS lists.
# There is no compat.c in this tag, so nothing extra is added for COMPAT.
COMMON_FLAGS=(
  -O2 -fPIC -fno-common
  -arch arm64 -arch x86_64
  -bundle -undefined dynamic_lookup
  -DLUASOCKET_NODEBUG
  -DUNIX_HAS_SUN_LEN
  # Lua 5.3's lauxlib.h only defines luaL_checkint/luaL_optint (used by
  # luasocket.c and mime.c) when this compat macro is set.
  -DLUA_COMPAT_APIINTCASTS
  -DLUASOCKET_API='__attribute__((visibility("default")))'
  -DUNIX_API='__attribute__((visibility("default")))'
  -DMIME_API='__attribute__((visibility("default")))'
  -I"${LUA_SRC}"
)

SOCKET_SOURCES=(
  luasocket.c
  timeout.c
  buffer.c
  io.c
  auxiliar.c
  options.c
  inet.c
  usocket.c
  except.c
  select.c
  tcp.c
  udp.c
)

MIME_SOURCES=(
  mime.c
)

mkdir -p "${OUT_DIR}/socket" "${OUT_DIR}/mime"

echo "==> Compiling socket/core.so"
( cd "${SRC}" && cc "${COMMON_FLAGS[@]}" "${SOCKET_SOURCES[@]}" -o "${OUT_DIR}/socket/core.so" )

echo "==> Compiling mime/core.so"
( cd "${SRC}" && cc "${COMMON_FLAGS[@]}" "${MIME_SOURCES[@]}" -o "${OUT_DIR}/mime/core.so" )

echo "==> Copying LICENSE"
cp "${LUASOCKET_SRC}/LICENSE" "${OUT_DIR}/LICENSE"

echo
echo "==> lipo -info (must list x86_64 and arm64)"
lipo -info "${OUT_DIR}/socket/core.so"
lipo -info "${OUT_DIR}/mime/core.so"

echo
echo "==> Functional check"
LUA_DEBUG_DIR="$(find "${HOME}/.vscode/extensions" -maxdepth 1 -iname 'actboy168.lua-debug-*-darwin-arm64' | sort | tail -n1)"
LIFEBOAT_DIR="$(find "${HOME}/.vscode/extensions" -maxdepth 1 -iname 'nameouschangey.lifeboatapi-*' | sort | tail -n1)"

if [ -z "${LUA_DEBUG_DIR}" ] || [ ! -x "${LUA_DEBUG_DIR}/runtime/darwin-arm64/lua53/lua" ]; then
  echo "warning: lua-debug runtime binary not found, skipping functional check"
elif [ -z "${LIFEBOAT_DIR}" ] || [ ! -d "${LIFEBOAT_DIR}/assets/luasocket" ]; then
  echo "warning: LifeBoatAPI pure-Lua luasocket dir not found, skipping functional check"
else
  LUA_BIN="${LUA_DEBUG_DIR}/runtime/darwin-arm64/lua53/lua"
  "${LUA_BIN}" -e "
    package.path = '${LIFEBOAT_DIR}/assets/luasocket/?.lua;' .. package.path
    package.cpath = '${OUT_DIR}/?.so'
    local s = require('socket')
    assert(s.tcp())
    assert(s.gettime())
    print('OK ' .. s._VERSION)
  "
fi

echo
echo "==> Done. Output in ${OUT_DIR}"
