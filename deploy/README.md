# Deploying HAPI with `--relay` behind an HTTP proxy

This directory holds the deployment glue used for a HAPI hub that runs on a
machine whose direct egress breaks the official relay's data channel, so the
tunnel has to leave through an HTTP CONNECT proxy.

Nothing in `deploy/` is required for a normal install. It is a record of one
working setup plus the small tunwg patch it depends on.

## Why the patch is needed

`hapi hub --relay` spawns the `tunwg` client. Upstream opens the relay data
channel with a bare `tls.Dial` (`listener.go`, `establishRelay`), so it never
honours `HTTPS_PROXY`. Only the peer registration (`POST /add`) goes through
Go's `http.DefaultClient`, which does honour it.

Observed symptom when the direct path is filtered (enterprise VPN / campus
egress): registration succeeds, the WireGuard handshake with the relay stays
healthy, the tunnel URL is printed, but the relay never forwards traffic into
the tunnel — connections to `https://<label>.relay.hapi.run` die after ~5.1 s,
which is the relay's own `DialProxy{DialTimeout: 5 * time.Second}`. The client
never sees a TLS ClientHello (no autocert activity at debug log level).

Routing *both* connections through a proxy fixes it: `deploy/patches/` makes
the relay data channel go through the same proxy as the registration call.

## Layout

```
deploy/systemd/user/                      copy to ~/.config/systemd/user/
  hapi-hub.service                        hub, relay mode, LAN bind
  hapi-hub.service.d/proxy.conf           TUNWG_PROXY/HTTPS_PROXY for the hub
  hapi-hub.service.d/tcp.conf             HAPI_RELAY_FORCE_TCP -> TUNWG_RELAY
  hapi-runner.service                     runner for remote session spawning
deploy/bin/
  build-tunwg-proxy.sh                    rebuild + install the patched tunwg
  hapi-links.sh                           print pairing links, write QR images
deploy/patches/
  tunwg-proxy.patch                       diff against tiann/tunwg
  internal__proxy.go                      new file: proxy-aware dialer
  listener.go.patched                     patched listener.go
```

## Install

```bash
# 1. hub + runner services (edit user/paths as needed)
cp -r deploy/systemd/user/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hapi-hub hapi-runner

# 2. build the patched tunwg and install it where the hub looks for it:
#    ~/.hapi/runtime/<hapi-version>/tools/tunwg/tunwg
#    (the original is kept next to it as tunwg.orig)
#    Run this straight from a checkout of this repo: the script finds the
#    patch files in deploy/patches/ itself.
deploy/bin/build-tunwg-proxy.sh v26.08.03+122a6d0   # requires Go >= 1.26

# 3. restart the hub to pick the binary up, then check the tunnel:
systemctl --user restart hapi-hub
journalctl --user -u hapi-hub -f | grep -E 'Public:|Tunnel\]'
```

The script clones `tiann/tunwg` to `~/tunwg-src` when missing, checks out the
release tag, applies `deploy/patches/`, builds with the Go toolchain in
`~/.local/go-toolchain` (override with `TUNWG_SRC` / `HAPI_DEPLOY_PATCHES`), and
installs the result. Re-run it after a hapi upgrade, which replaces the
embedded tunwg binary.

The proxy itself is whatever serves `127.0.0.1:7890` on that machine; change it
in `hapi-hub.service.d/proxy.conf`. `TUNWG_PROXY` wins, `HTTPS_PROXY` and
`ALL_PROXY` are accepted as fallbacks.

## Maintenance

- **After upgrading hapi, re-apply the tunwg patch.** An upgrade replaces the
  embedded `tunwg` binary under `~/.hapi/runtime/<version>/tools/tunwg/`, which
  drops the proxy support:

  ```bash
  deploy/bin/build-tunwg-proxy.sh     # rebuild + install over the embedded binary
  systemctl --user restart hapi-hub
  ```

  Symptom if this is skipped (direct egress can reach the relay's API but not
  carry the tunnel): the hub prints `[Tunnel] Waiting for trusted TLS
  certificate...` forever and never reaches `[Web] Public: https://...`, and
  requests to `https://<label>.relay.hapi.run` die after ~5 s (the relay's own
  dial timeout) or hang until the client gives up. `~/.hapi/runtime/.../tools/tunwg/tunwg.orig`
  is the untouched binary, kept for comparison.

- **After editing a unit in this repo**, copy it back and reload:

  ```bash
  cp -r deploy/systemd/user/* ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user restart hapi-hub hapi-runner
  ```

- **Restart behaviour.** `hapi-runner.service` deliberately has no
  `PartOf=hapi-hub.service`: with it, restarting the hub also stopped the
  runner and terminated the sessions the runner had spawned (observed while
  bringing this up). Restarting the hub now leaves the runner, its sessions and
  terminal-owned sessions untouched; the runner reconnects its own socket.

- **No credentials live in this repo.** `CLI_API_TOKEN` and `HAPI_API_URL` must
  be provided per machine (environment or `~/.hapi/settings.json`); the proxy
  address lives in `hapi-hub.service.d/proxy.conf`.

## Operating notes

- The proxy must be up when the hub starts (or the tunnel retries until it is).
- `~/.hapi/bin/hapi-links.sh` prints the current hub origin, the browser link,
  the `hapicompanion://` pairing link, and regenerates the QR PNGs.
- The tunnel subdomain is derived from the WireGuard key in
  `~/.hapi/tunwg/keys/tunwg`, so it is stable across restarts as long as that
  key (and the file name of the `tunwg` binary, which seeds the key name) stays
  the same. Renaming the binary changes the key and therefore the hostname.
- Verified against hapi 0.30.7 and tunwg v26.08.03+122a6d0. Upstream's patch
  submission would be the better long-term home for `tunwg-proxy.patch`.