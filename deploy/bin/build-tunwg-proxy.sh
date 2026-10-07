#!/usr/bin/env bash
# Rebuilds the proxy-enabled tunwg client used by `hapi hub --relay`.
# Upstream dials the relay data channel with a bare tls.Dial, which ignores
# HTTP proxies; the patch routes both /add and /relay through TUNWG_PROXY.
#
# Usage: build-tunwg-proxy.sh [git-tag]     (default: tag of the current build)
# Env:   HAPI_DEPLOY_PATCHES=<dir>          explicit patch directory
#        TUNWG_SRC=<dir>                    tunwg checkout (default ~/tunwg-src)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${TUNWG_SRC:-${HOME}/tunwg-src}"
TAG="${1:-v26.08.03+122a6d0}"
GO="${HOME}/.local/go-toolchain/bin/go"

# Patches live either in the installed copy or next to this script in a
# checkout of the deployment repo.
PATCH_DIR=""
for candidate in "${HAPI_DEPLOY_PATCHES:-}" "${HOME}/.hapi/patches" "${SCRIPT_DIR}/../patches"; do
    if [ -n "${candidate}" ] && [ -f "${candidate}/internal__proxy.go" ]; then
        PATCH_DIR="${candidate}"
        break
    fi
done
if [ -z "${PATCH_DIR}" ]; then
    echo "build-tunwg-proxy: patch directory not found (looked for internal__proxy.go in \${HAPI_DEPLOY_PATCHES}, ~/.hapi/patches, ${SCRIPT_DIR}/../patches)" >&2
    exit 1
fi

if [ ! -d "${SRC}/.git" ]; then
    echo "build-tunwg-proxy: no tunwg checkout at ${SRC}; cloning tiann/tunwg" >&2
    git clone https://github.com/tiann/tunwg.git "${SRC}"
fi

VER="$(python3 -c "import json;print(json.load(open('${HOME}/hapi/cli/package.json'))['version'])" 2>/dev/null || true)"
if [ -z "${VER}" ]; then
    VER="$(ls -1 "${HOME}/.hapi/runtime" | sort -V | tail -1)"
fi
RT="${HOME}/.hapi/runtime/${VER}/tools/tunwg"

cd "${SRC}"
git fetch --depth 1 origin tag "${TAG}" >/dev/null 2>&1 || true
git checkout -q "${TAG}"
cp "${PATCH_DIR}/internal__proxy.go" internal/proxy.go
cp "${PATCH_DIR}/listener.go.patched" listener.go

GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY="${GOPROXY:-https://goproxy.cn,direct}" GOSUMDB=off \
    "${GO}" build -o /tmp/tunwg-proxy-build ./tunwg

mkdir -p "${RT}"
if [ -f "${RT}/tunwg" ] && [ ! -f "${RT}/tunwg.orig" ]; then
    cp "${RT}/tunwg" "${RT}/tunwg.orig"
fi
install -m755 /tmp/tunwg-proxy-build "${RT}/tunwg"
echo "used patches from ${PATCH_DIR}"
echo "built $(stat -c %s /tmp/tunwg-proxy-build) bytes; installed to ${RT}/tunwg"
echo "restart the hub to pick it up: systemctl --user restart hapi-hub"