#!/usr/bin/env bash
set -uo pipefail

repair=0
json=0
for argument in "$@"; do
  case "$argument" in
    --repair) repair=1 ;;
    --json) json=1 ;;
    -h|--help)
      printf 'Usage: %s [--repair] [--json]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$argument" >&2
      exit 64
      ;;
  esac
done

server_url="${PIXEL_BRIGHTNESS_SERVER_URL:-http://127.0.0.1:4100}"
curl_args=(--silent --show-error --fail --max-time 4)

server_ok=0
web_ok=0
node_ok=0
appliance=0
no_sleep_ok=1
server_body=""

unit_expected() {
  systemctl is-enabled --quiet "$1" 2>/dev/null
}

if server_body="$(curl "${curl_args[@]}" "${server_url%/}/v1/health" 2>/dev/null)"; then
  server_ok=1
fi
if ! unit_expected pixel-brightness-web.service; then
  web_ok=1
elif curl --silent --fail --max-time 4 http://127.0.0.1:3000/ >/dev/null 2>&1; then
  web_ok=1
fi
if ! unit_expected pixel-brightness-node.service; then
  node_ok=1
elif systemctl is-active --quiet pixel-brightness-node.service 2>/dev/null; then
  node_ok=1
fi

target_is_masked() {
  [[ "$(systemctl is-enabled "$1" 2>/dev/null || true)" == "masked" ]]
}

if [[ -e /etc/pixel-brightness/appliance-mode ]]; then
  appliance=1
  no_sleep_ok=0
  if systemctl is-active --quiet pixel-brightness-nosleep.service 2>/dev/null \
    && target_is_masked sleep.target \
    && target_is_masked suspend.target \
    && target_is_masked hibernate.target \
    && target_is_masked hybrid-sleep.target \
    && target_is_masked suspend-then-hibernate.target \
    && grep -q '^AllowSuspend=no$' /etc/systemd/sleep.conf.d/pixel-brightness.conf 2>/dev/null \
    && grep -q '^IdleAction=ignore$' /etc/systemd/logind.conf.d/pixel-brightness.conf 2>/dev/null \
    && grep -q '^idle-delay=uint32 0$' /etc/dconf/db/local.d/00-pixel-brightness 2>/dev/null; then
    no_sleep_ok=1
  fi
fi

if [[ $repair -eq 1 && ${EUID} -eq 0 ]]; then
  if (( server_ok == 0 )) && unit_expected pixel-brightness-server.service; then
    systemctl try-restart pixel-brightness-server.service
  fi
  if (( web_ok == 0 )) && unit_expected pixel-brightness-web.service; then
    systemctl try-restart pixel-brightness-web.service
  fi
  if (( node_ok == 0 )) && unit_expected pixel-brightness-node.service; then
    systemctl try-restart pixel-brightness-node.service
  fi
  if (( appliance == 1 && no_sleep_ok == 0 )); then
    systemctl try-restart pixel-brightness-nosleep.service
  fi
fi

if [[ $json -eq 1 ]]; then
  printf '{"server":%s,"web":%s,"node":%s,"appliance":%s,"noSleep":%s}\n' \
    "$([[ $server_ok -eq 1 ]] && printf true || printf false)" \
    "$([[ $web_ok -eq 1 ]] && printf true || printf false)" \
    "$([[ $node_ok -eq 1 ]] && printf true || printf false)" \
    "$([[ $appliance -eq 1 ]] && printf true || printf false)" \
    "$([[ $no_sleep_ok -eq 1 ]] && printf true || printf false)"
else
  printf 'Pixel Brightness health: server=%s web=%s node=%s appliance=%s no-sleep=%s\n' \
    "$server_ok" "$web_ok" "$node_ok" "$appliance" "$no_sleep_ok"
fi

(( server_ok == 1 && web_ok == 1 && node_ok == 1 && no_sleep_ok == 1 ))
