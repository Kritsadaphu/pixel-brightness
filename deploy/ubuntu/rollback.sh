#!/usr/bin/env bash
set -Eeuo pipefail

[[ ${EUID} -eq 0 ]] || { printf 'Run rollback with sudo.\n' >&2; exit 77; }
readonly CURRENT_LINK=/opt/pixel-brightness/current
readonly PREVIOUS_FILE=/var/lib/pixel-brightness/previous-release

[[ -r "$PREVIOUS_FILE" ]] || { printf 'No previous release is recorded.\n' >&2; exit 1; }
previous="$(head -n1 "$PREVIOUS_FILE")"
[[ "$previous" == /opt/pixel-brightness/releases/* && -d "$previous" ]] || {
  printf 'Recorded previous release is invalid: %s\n' "$previous" >&2
  exit 1
}
current="$(readlink -f "$CURRENT_LINK" || true)"
ln -sfn "$previous" /opt/pixel-brightness/.current-next
mv -Tf /opt/pixel-brightness/.current-next "$CURRENT_LINK"
printf '%s\n' "$current" > "$PREVIOUS_FILE"
printf '%s\n' "$previous" > /var/lib/pixel-brightness/current-release
systemctl daemon-reload
systemctl try-restart pixel-brightness-server.service pixel-brightness-node.service pixel-brightness-web.service
printf 'Rolled back to %s\n' "$previous"
