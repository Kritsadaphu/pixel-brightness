#!/usr/bin/env bash
set -uo pipefail

strict=0
json=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) strict=1 ;;
    --json) json=1 ;;
    -h|--help)
      printf 'Usage: %s [--strict] [--json]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 64
      ;;
  esac
  shift
done

os_id="unknown"
os_version="unknown"
os_pretty="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID:-unknown}"
  os_version="${VERSION_ID:-unknown}"
  os_pretty="${PRETTY_NAME:-unknown}"
fi

arch="$(uname -m 2>/dev/null || printf unknown)"
kernel="$(uname -r 2>/dev/null || printf unknown)"
node_version="missing"
node_ok=0
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version 2>/dev/null || printf unknown)"
  version_number="${node_version#v}"
  if [[ "$(printf '%s\n' '22.13.0' "$version_number" | sort -V | head -n1)" == "22.13.0" ]]; then
    node_ok=1
  fi
fi

nvidia_pci="not-detected"
if command -v lspci >/dev/null 2>&1; then
  nvidia_pci="$(lspci 2>/dev/null | awk 'BEGIN{IGNORECASE=1} /VGA|3D controller/ && /NVIDIA/ {sub(/^[^ ]+ /, ""); print; exit}')"
  nvidia_pci="${nvidia_pci:-not-detected}"
fi

nvidia_smi="unavailable"
nvidia_ok=0
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia_smi="$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | head -n1)"
  if [[ -n "$nvidia_smi" ]]; then
    nvidia_ok=1
  else
    nvidia_smi="driver-not-loaded"
  fi
fi

connectors=()
for status_file in /sys/class/drm/card*-*/status; do
  [[ -r "$status_file" ]] || continue
  if [[ "$(tr -d '\n' < "$status_file")" == "connected" ]]; then
    connector="$(basename "$(dirname "$status_file")")"
    connector="$(sed -E 's/^card[0-9]+-//' <<<"$connector")"
    mode="unknown"
    [[ -r "$(dirname "$status_file")/modes" ]] && mode="$(head -n1 "$(dirname "$status_file")/modes")"
    connectors+=("${connector}:${mode:-unknown}")
  fi
done

ubuntu_ok=0
if [[ "$os_id" == "ubuntu" && "$os_version" != "unknown" ]]; then
  if [[ "$(printf '%s\n' '24.04' "$os_version" | sort -V | head -n1)" == "24.04" ]]; then
    ubuntu_ok=1
  fi
fi

arch_ok=0
[[ "$arch" == "x86_64" || "$arch" == "amd64" ]] && arch_ok=1

connector_text="none"
if [[ ${#connectors[@]} -gt 0 ]]; then
  connector_text="$(IFS=,; printf '%s' "${connectors[*]}")"
fi

if [[ $json -eq 1 ]]; then
  if command -v jq >/dev/null 2>&1; then
    jq -n \
      --arg os "$os_pretty" \
      --arg osId "$os_id" \
      --arg osVersion "$os_version" \
      --arg arch "$arch" \
      --arg kernel "$kernel" \
      --arg node "$node_version" \
      --arg gpu "$nvidia_pci" \
      --arg driver "$nvidia_smi" \
      --arg connectors "$connector_text" \
      --argjson ubuntuReady "$ubuntu_ok" \
      --argjson architectureReady "$arch_ok" \
      --argjson nodeReady "$node_ok" \
      --argjson nvidiaReady "$nvidia_ok" \
      '{os:$os,osId:$osId,osVersion:$osVersion,arch:$arch,kernel:$kernel,node:$node,gpu:$gpu,nvidia:$driver,connectors:($connectors|split(",")),checks:{ubuntu:$ubuntuReady,architecture:$architectureReady,node:$nodeReady,nvidia:$nvidiaReady}}'
  else
    printf '{"error":"jq is required for --json"}\n'
    exit 69
  fi
else
  printf 'Pixel Brightness Ubuntu preflight\n'
  printf '  OS          %s\n' "$os_pretty"
  printf '  Architecture %s\n' "$arch"
  printf '  Kernel      %s\n' "$kernel"
  printf '  Node.js     %s\n' "$node_version"
  printf '  NVIDIA PCI  %s\n' "$nvidia_pci"
  printf '  NVIDIA SMI  %s\n' "$nvidia_smi"
  printf '  Displays    %s\n' "$connector_text"
  printf '  Ready flags ubuntu=%s arch=%s node=%s nvidia=%s\n' "$ubuntu_ok" "$arch_ok" "$node_ok" "$nvidia_ok"
fi

if [[ $strict -eq 1 ]] && (( ubuntu_ok == 0 || arch_ok == 0 || node_ok == 0 || nvidia_ok == 0 )); then
  exit 1
fi
