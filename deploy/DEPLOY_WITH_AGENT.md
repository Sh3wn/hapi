# Agent prompt: deploy Sh3wn/hapi as a phone-controllable hub

Copy everything below into the agent session. It is self-contained: the agent
does not need this conversation.

---

## Task

On this Linux machine, deploy <https://github.com/Sh3wn/hapi> as a HAPI **hub in
`--relay` mode** plus a **runner**, so a phone (browser/PWA or the native HAPI
app) can drive coding-agent sessions running here. Leave it running as
systemd *user* services that survive reboot. Do not use sudo for the services;
ask before any step that needs root.

Read `deploy/README.md` in the checkout before starting — it explains the
`deploy/` directory this fork adds on top of upstream.

## Deliverable

Report at the end, with the observed output of every check:

- hub + runner service names, `enabled`/`active` state;
- the hub public origin, the browser access link, the companion pairing link;
- the path of the generated QR PNGs;
- what you could not verify, and why.

## Facts from a previous deployment of this fork (trust these, verify anyway)

- Build: Bun ≥1.4 → `bun install`, then `bun run build:single-exe`. The binary
  lands in `cli/dist-exe/*/hapi` (target name depends on the CPU; on x64 Linux
  it was `bun-linux-x64-baseline` — glob for it).
- Hub state lives in `~/.hapi/` (`settings.json` holds `cliApiToken`, plus
  `hapi.db`). The hub unpacks its tunnel client to
  `~/.hapi/runtime/<hapi-version>/tools/tunwg/tunwg` and will **not** overwrite
  an existing file there.
- The tunnel hostname is derived from the WireGuard key in
  `~/.hapi/tunwg/keys/tunwg` **and** the tunwg binary's file name, so it is
  stable across restarts only if neither changes. Never rename that binary, and
  never hand-edit files under `~/.hapi/runtime/`.
- The hub prints `[Web] Public: https://<label>.<api-domain>` only after its own
  TLS gate succeeds. Until then it repeats
  `[Tunnel] Waiting for trusted TLS certificate...`.
- Reference versions this was proven on: hapi 0.30.7, tunwg v26.08.03+122a6d0.

## Decision: run the tunnel through a proxy or not

The relay needs the whole tunnel (peer registration **and** the data channel)
to leave through one egress. On networks with filtered direct egress (corporate
zero-trust VPN, campus networks), upstream tunwg registers the peer and keeps a
healthy WireGuard handshake, but the relay can then never forward traffic into
the tunnel: `https://<label>.<api-domain>` dies after ~5 s (the relay's own dial
timeout) while the client never sees a TLS ClientHello.

1. Deploy **without** the patch first: plain `hapi hub --relay`, watch the log
   for up to 3 minutes.
2. `[Web] Public:` appears → done, no patch needed.
3. It keeps repeating `Waiting for trusted TLS certificate...` → the direct path
   is filtered. Then:
   a. ask the user for the local HTTP proxy (assume `http://127.0.0.1:7890` if
      they do not know) and confirm it works:
      `curl -x http://127.0.0.1:7890 -sS -o /dev/null -w '%{http_code}\n' https://relay.hapi.run/`
      → `404` means the TLS handshake through the proxy succeeded;
   b. get a Go toolchain without root:
      `curl -sSL -o /tmp/go.tgz https://golang.google.cn/dl/go1.26.8.linux-amd64.tar.gz && mkdir -p ~/.local/go-toolchain && tar -C ~/.local/go-toolchain --strip-components=1 -xzf /tmp/go.tgz`
   c. `git clone https://github.com/tiann/tunwg.git ~/tunwg-src`, then from the
      hapi checkout:
      `HAPI_DEPLOY_PATCHES=$PWD/deploy/patches deploy/bin/build-tunwg-proxy.sh v26.08.03+122a6d0`
      (checks out that tag, applies the patch, builds, installs over the
      embedded binary, keeps the original next to it as `tunwg.orig`);
   d. enable the proxy for the hub via the drop-ins that ship in this fork:
      `deploy/systemd/user/hapi-hub.service.d/proxy.conf` (`TUNWG_PROXY`,
      `HTTPS_PROXY`, `NO_PROXY=localhost,127.0.0.1`) and
      `deploy/systemd/user/hapi-hub.service.d/tcp.conf`
      (`HAPI_RELAY_FORCE_TCP=true`, which makes tunwg use its TCP relay mode).
      Then `systemctl --user daemon-reload && systemctl --user restart hapi-hub`.
   Re-run the build script after any hapi upgrade: the upgrade replaces the
   embedded tunwg and silently drops the patch.

## Steps

1. Check prerequisites: `git`, `bun` (≥1.4), `curl`, `python3`. Prefer
   user-local installs (`~/.local`, `~/.bun`, `~/.local/go-toolchain`); ask
   before installing anything with sudo.
2. `git clone https://github.com/Sh3wn/hapi.git ~/hapi && cd ~/hapi`
   (use `git@github.com:Sh3wn/hapi.git` when the machine has SSH keys). Read
   `deploy/README.md`.
3. `bun install && bun run build:single-exe`
   (this also downloads tunwg release binaries; it needs outbound HTTPS to
   github.com — if that is slow or blocked, say so).
4. `install -m755 "$(ls cli/dist-exe/*/hapi | head -1)" ~/.local/bin/hapi`, then
   make sure `~/.local/bin` is on PATH for the shell the user actually uses
   (bash: `~/.bashrc` or `~/.profile`; zsh: `~/.zshrc`):
   `export PATH="$HOME/.local/bin:$PATH"`.
5. Install the services:
   ```bash
   cp -r deploy/systemd/user/* ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hapi-hub hapi-runner
   ```
   If this machine has no working user systemd bus, stop and ask before falling
   back to `nohup`/`setsid`, and say so in the report.
6. Apply the proxy decision above.
7. Verify — all of these must pass before you claim success:
   ```bash
   systemctl --user is-enabled hapi-hub hapi-runner     # both: enabled
   systemctl --user is-active  hapi-hub hapi-runner     # both: active
   journalctl --user -u hapi-hub -n 60 --no-pager | grep 'Web] Public:'   # -> https://... origin

   HUB=https://<that origin>
   TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.hapi/settings.json'))['cliApiToken'])")
   curl -sS -o /dev/null -w '%{http_code}\n' "$HUB/"                     # 200
   JWT=$(curl -sS -X POST "$HUB/api/auth" -H 'Content-Type: application/json' \
         -d "{\"accessToken\":\"$TOKEN\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
   curl -sS "$HUB/api/machines" -H "Authorization: Bearer $JWT"          # this host, active: true
   deploy/bin/hapi-links.sh                                              # origin + links + QR PNGs
   ```
8. Hand the browser link and the companion pairing link to the user. State
   plainly that the final phone-side check is theirs — you cannot reach their
   phone.

## Guardrails

- Never commit, push, log or paste the `CLI_API_TOKEN`; do not put it into a unit
  file (the hub generates and persists it itself). The units under `deploy/` are
  intentionally credential-free.
- Do not push to any remote unless explicitly asked; work in the checkout.
- Do not change Windows/WSL host firewall or networking settings without
  explicit approval. Relay mode needs no inbound port: the tunnel is
  outbound-only.
- Do not delete sessions or database content, and do not `git reset --hard`.
- If the tunnel still fails after installing the patched binary and setting the
  proxy, stop and report: the exact log lines, `ss -tnp | grep tunwg`, and
  whether the direct egress and the proxy exit differ
  (`curl -sS https://ipinfo.io/json` vs `curl -x <proxy> -sS https://ipinfo.io/json`).

## Optional: additional machines

To control a second server from the same phone, run a runner there with the same
hub credentials:

```bash
HAPI_API_URL=$HUB CLI_API_TOKEN=$TOKEN \
  hapi runner start-sync --workspace-root /path/to/projects
```

It then shows up in the same Machines list; `--workspace-root` also scopes which
directories the phone may browse and create sessions in. Each machine keeps its
own `~/.hapi/settings.json`, and a machine id must not be reused across
namespaces.

## Pitfalls that cost time before

- `hapi hub --help` is not help — it starts the hub. Use `hapi --help`.
- `hapi-runner.service` must **not** carry `PartOf=hapi-hub.service`: with it,
  restarting the hub stops the runner and kills runner-spawned sessions
  (observed).
- In relay mode the hub does **not** serve the web UI: `/` returns a stub page
  pointing at `HAPI_OFFICIAL_WEB_URL` (default `https://app.hapi.run`). Set that
  variable plus `CORS_ORIGINS` if you want to self-host a modified frontend
  built from `web/` with `bun run build:web`.
- If the phone is meant to drive Codex: `codex` allows only one writer per
  thread. A HAPI session can only own a thread that no other live codex
  app-server holds, and `hapi codex resume ...` fails with
  `already has an active writer` while the other process is alive.