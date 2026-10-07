#!/usr/bin/env bash
# Prints the current phone-access links for the hub and (re)generates the
# pairing QR images next to this script's data dir.
set -uo pipefail

HAPI_HOME="${HOME}/.hapi"
TOKEN=$(python3 -c "import json;print(json.load(open('${HAPI_HOME}/settings.json'))['cliApiToken'])")

# The hub prints the public origin once the relay tunnel is TLS-ready.
BASE=$(journalctl --user -u hapi-hub.service -o cat --no-pager 2>/dev/null |
    grep -oE '\[Web\] Public: https://[^ ]+' | tail -1 | sed 's/^\[Web\] Public: //')
if [ -z "${BASE}" ]; then
    BASE="http://$(hostname -I | awk '{print $1}'):3006"
    echo "note: no relay URL in the hub log; falling back to the LAN address" >&2
fi

WEB_LINK="https://app.hapi.run/?hub=${BASE}&token=${TOKEN}"
COMPANION="hapicompanion://bind?hub=${BASE}&code=${TOKEN}"

printf 'hub origin : %s\n' "$BASE"
printf 'token      : %s\n' "$TOKEN"
printf 'browser    : %s\n' "$WEB_LINK"
printf 'companion  : %s\n' "$COMPANION"
printf 'hub-hosted : %s/?hub=%s&token=%s\n' "$BASE" "$BASE" "$TOKEN"

QR_DIR="${HOME}"
WIN_DIR=""
for candidate in /mnt/c/Users/*/; do
    [ -f "${candidate}NTUSER.DAT" ] || continue
    [ -w "$candidate" ] || continue
    WIN_DIR="${candidate%/}"
    break
done

cd "${HOME}/hapi/hub" || exit 0
WEB_LINK="$WEB_LINK" COMPANION="$COMPANION" QR_DIR="$QR_DIR" WIN_DIR="$WIN_DIR" bun -e "
import QRCode from 'qrcode';
const targets = [
    { name: 'hapi-connect.png', data: process.env.WEB_LINK },
    { name: 'hapi-pair.png', data: process.env.COMPANION },
];
for (const t of targets) {
    const paths = [process.env.QR_DIR + '/' + t.name];
    if (process.env.WIN_DIR) paths.push(process.env.WIN_DIR + '/' + t.name);
    for (const p of paths) await QRCode.toFile(p, t.data, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
    console.log('qr:', paths.join(', '));
}
"