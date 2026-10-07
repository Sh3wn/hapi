#!/usr/bin/env bash
# Rebuilds the proxy-enabled tunwg client used by `hapi hub --relay`.
# Upstream connects the relay data channel with a bare tls.Dial, which ignores
# HTTP proxies; the patch routes both /add and /relay through TUNWG_PROXY.
# Usage: build-tunwg-proxy.sh [git-tag]   (default: tag of the current build)
set -euo pipefail
SRC="${HOME}/tunwg-src"
TAG="${1:-v26.08.03+122a6d0}"
GO="${HOME}/.local/go-toolchain/bin/go"
VER="$(python3 -c "import json;print(json.load(open('${HOME}/hapi/cli/package.json'))['version'])")"
RT="${HOME}/.hapi/runtime/${VER}/tools/tunwg"

cd "$SRC"
git fetch --depth 1 origin tag "$TAG" >/dev/null 2>&1 || true
git checkout -q "$TAG"
cp "${HOME}/.hapi/patches/internal__proxy.go" internal/proxy.go
cp "${HOME}/.hapi/patches/listener.go.patched" listener.go

GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
  "$GO" build -o /tmp/tunwg-proxy-build ./tunwg

[ -f "$RT/tunwg" ] && [ ! -f "$RT/tunwg.orig" ] && cp "$RT/tunwg" "$RT/tunwg.orig"
install -m755 /tmp/tunwg-proxy-build "$RT/tunwg"
echo "built $(ls -l /tmp/tunwg-proxy-build | awk '{print $5}') bytes; installed to $RT/tunwg"
