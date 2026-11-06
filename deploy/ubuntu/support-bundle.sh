#!/usr/bin/env bash
set -uo pipefail

output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="${2:-}"; shift ;;
    -h|--help)
      printf 'Usage: %s [--output FILE.tar.gz]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
  shift
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$output" ]]; then
  output="$PWD/pixel-brightness-support-${timestamp}.tar.gz"
fi
if [[ "$output" != /* ]]; then
  output="$PWD/$output"
fi

bundle_dir="$(mktemp -d /tmp/pixel-brightness-support.XXXXXXXX)" || exit 1
case "$bundle_dir" in
  /tmp/pixel-brightness-support.*) ;;
  *) printf 'Unsafe temporary path: %s\n' "$bundle_dir" >&2; exit 1 ;;
esac
cleanup() {
  rm -rf -- "$bundle_dir"
}
trap cleanup EXIT

capture() {
  local name="$1"
  shift
  {
    printf '$'
    printf ' %q' "$@"
    printf '\n\n'
    timeout 20s "$@"
  } > "$bundle_dir/$name.txt" 2>&1 || true
}

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
preflight_script="$script_root/preflight.sh"
health_script="$script_root/health-check.sh"
[[ -x "$preflight_script" ]] || preflight_script=/opt/pixel-brightness/current/deploy/ubuntu/preflight.sh
[[ -x "$health_script" ]] || health_script=/usr/local/lib/pixel-brightness-health-check
"$preflight_script" --json > "$bundle_dir/preflight.json" 2>&1 || true
"$health_script" --json > "$bundle_dir/health.json" 2>&1 || true

capture uname uname -a
capture nvidia-smi nvidia-smi -q
capture drm-connectors modetest -M nvidia-drm -c
capture pci lspci -nnk
capture modules lsmod
capture kernel-command-line cat /proc/cmdline
capture service-status systemctl --no-pager --full status pixel-brightness-server.service pixel-brightness-node.service pixel-brightness-web.service pixel-brightness-nosleep.service pixel-brightness-health.timer
capture journals journalctl --no-pager --since=-2h -u pixel-brightness-server.service -u pixel-brightness-node.service -u pixel-brightness-web.service -u pixel-brightness-nosleep.service -u pixel-brightness-health.service
capture sleep-inhibitors systemd-inhibit --list --no-pager
capture logind-power-policy systemd-analyze cat-config systemd/logind.conf
capture nvidia-kernel-log journalctl --no-pager --since=-2h -k -g 'NVRM|nvidia|drm|EDID|Xid'

if [[ -r /etc/pixel-brightness/node.json ]]; then
  jq 'del(.authToken,.nodeToken,.powerConfirmationToken)' /etc/pixel-brightness/node.json > "$bundle_dir/node.json" 2>/dev/null || true
fi
for env_file in /etc/pixel-brightness/server.env /etc/pixel-brightness/node.env; do
  [[ -r "$env_file" ]] || continue
  sed -E 's/^((PIXEL_CONTROL_TOKEN|PIXEL_NODE_SIGNING_KEY|PIXEL_BRIGHTNESS_NODE_TOKEN|PB_POWER_ACTION_TOKEN|PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN)=).*/\1[REDACTED]/' "$env_file" > "$bundle_dir/$(basename "$env_file")"
done

if [[ -r /var/lib/pixel-brightness/current-release ]]; then
  cp /var/lib/pixel-brightness/current-release "$bundle_dir/current-release.txt"
fi
if [[ -r /opt/pixel-brightness/current/package.json ]]; then
  jq '{name,version,engines}' /opt/pixel-brightness/current/package.json > "$bundle_dir/package.json" 2>/dev/null || true
fi

install -d -m 0755 "$(dirname "$output")"
tar -C "$bundle_dir" -czf "$output" .
chmod 0600 "$output"
printf 'Support bundle written to %s\n' "$output"
printf 'Authentication and power tokens were redacted. Review before sharing.\n'
