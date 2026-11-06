#!/usr/bin/env bash
set -uo pipefail

server_url="${PIXEL_BRIGHTNESS_SERVER_URL:-http://127.0.0.1:4100}"
node_id=""
minimum_connectors=3
token_file=/etc/pixel-brightness/control-token
output=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) server_url="${2:-}"; shift ;;
    --node-id) node_id="${2:-}"; shift ;;
    --minimum-connectors) minimum_connectors="${2:-}"; shift ;;
    --token-file) token_file="${2:-}"; shift ;;
    --output) output="${2:-}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: pixel-brightness-acceptance [options]

  --server-url URL          Pixel Server API (default http://127.0.0.1:4100)
  --node-id ID              Node to validate (default first registered Node)
  --minimum-connectors N    Required connected DRM outputs (default 3)
  --token-file PATH         Pairing token file
  --output PATH             Also save the JSON result
EOF
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done

[[ "$server_url" =~ ^https?://[^[:space:]]+$ ]] || { printf 'Invalid Server URL.\n' >&2; exit 64; }
[[ "$minimum_connectors" =~ ^[0-9]+$ ]] && (( minimum_connectors >= 1 && minimum_connectors <= 128 )) || {
  printf 'Minimum connectors must be 1-128.\n' >&2
  exit 64
}
command -v jq >/dev/null 2>&1 || { printf 'jq is required.\n' >&2; exit 69; }
command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; exit 69; }

script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
preflight_script="$script_root/preflight.sh"
health_script="$script_root/health-check.sh"
[[ -x "$preflight_script" ]] || preflight_script=/opt/pixel-brightness/current/deploy/ubuntu/preflight.sh
[[ -x "$health_script" ]] || health_script=/usr/local/lib/pixel-brightness-health-check
token=""
[[ -r "$token_file" ]] && token="$(head -n1 "$token_file")"
curl_args=(--silent --show-error --fail --max-time 6)
[[ -n "$token" ]] && curl_args+=(--header "Authorization: Bearer ${token}")

preflight="$("$preflight_script" --json 2>/dev/null || true)"
health="$("$health_script" --json 2>/dev/null || true)"
jq -e 'type == "object"' <<<"$preflight" >/dev/null 2>&1 || preflight='{}'
jq -e 'type == "object"' <<<"$health" >/dev/null 2>&1 \
  || health='{"server":false,"web":false,"node":false,"appliance":false,"noSleep":false}'
state="$(curl "${curl_args[@]}" "${server_url%/}/v1/state" 2>/dev/null || printf '{}')"

if [[ -z "$node_id" ]]; then
  node_id="$(jq -r '.nodes[0].nodeId // .nodes[0].id // empty' <<<"$state")"
fi

node="$(jq -c --arg nodeId "$node_id" '(.nodes // []) | map(select((.nodeId // .id) == $nodeId)) | .[0] // {}' <<<"$state")"
connected="$(jq '[.host.drm.connectors[]? | select(.status == "connected")] | length' <<<"$node")"
valid_edid="$(jq '[.host.drm.connectors[]? | select(.status == "connected" and .edid.valid == true)] | length' <<<"$node")"
gpu_ready="$(jq '(.host.gpu.available == true) and ((.host.gpu.gpus // []) | length > 0)' <<<"$node")"
node_online="$(jq '(.status // "offline") | IN("idle","ready","playing","paused","degraded")' <<<"$node")"
dropped_frames="$(jq '(.telemetry.droppedFrames // 0) | tonumber? // 0' <<<"$node")"
clock_offset_ns="$(jq '(.telemetry.clockOffsetNs // 0) | tonumber? // 0' <<<"$node")"
timing_ready="$(jq -n --argjson dropped "$dropped_frames" --argjson offset "$clock_offset_ns" '($dropped == 0) and (($offset | fabs) <= 2000000)')"

modeset=false
if [[ -r /sys/module/nvidia_drm/parameters/modeset ]]; then
  modeset_value="$(tr '[:lower:]' '[:upper:]' < /sys/module/nvidia_drm/parameters/modeset | tr -d '\n')"
  [[ "$modeset_value" == "Y" || "$modeset_value" == "1" ]] && modeset=true
fi

native_verified="$(jq '(.host.renderer.hardwareVerified == true) or (.host.hardwareVerified == true)' <<<"$node")"
preflight_ready="$(jq '.checks.ubuntu == 1 and .checks.architecture == 1 and .checks.node == 1 and .checks.nvidia == 1' <<<"$preflight")"
health_ready="$(jq '.server == true and .web == true and .node == true' <<<"$health")"
no_sleep_ready="$(jq '(.appliance != true) or (.noSleep == true)' <<<"$health")"
connector_ready=false
(( connected >= minimum_connectors )) && connector_ready=true

control_ready=false
if [[ "$preflight_ready" == true && "$health_ready" == true && "$no_sleep_ready" == true && "$node_online" == true && "$gpu_ready" == true && "$modeset" == true && "$connector_ready" == true && "$timing_ready" == true ]]; then
  control_ready=true
fi

report="$(jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg serverUrl "$server_url" \
  --arg nodeId "$node_id" \
  --argjson minimumConnectors "$minimum_connectors" \
  --argjson connectedConnectors "$connected" \
  --argjson validEdid "$valid_edid" \
  --argjson droppedFrames "$dropped_frames" \
  --argjson clockOffsetNs "$clock_offset_ns" \
  --argjson preflightReady "$preflight_ready" \
  --argjson servicesReady "$health_ready" \
  --argjson noSleepReady "$no_sleep_ready" \
  --argjson nodeOnline "$node_online" \
  --argjson gpuReady "$gpu_ready" \
  --argjson nvidiaDrmModeset "$modeset" \
  --argjson connectorReady "$connector_ready" \
  --argjson timingReady "$timing_ready" \
  --argjson controlPlaneReady "$control_ready" \
  --argjson nativeScanoutVerified "$native_verified" \
  '{schemaVersion:2,generatedAt:$generatedAt,serverUrl:$serverUrl,nodeId:$nodeId,controlPlaneReady:$controlPlaneReady,nativeScanoutVerified:$nativeScanoutVerified,checks:{preflight:$preflightReady,services:$servicesReady,noSleep:$noSleepReady,nodeOnline:$nodeOnline,gpu:$gpuReady,nvidiaDrmModeset:$nvidiaDrmModeset,connectors:{ready:$connectorReady,required:$minimumConnectors,connected:$connectedConnectors,validEdid:$validEdid},timing:{ready:$timingReady,droppedFrames:$droppedFrames,clockOffsetNs:$clockOffsetNs}},nextStep:(if $nativeScanoutVerified then "Run projector soak test" else "Native DRM/KMS renderer and physical scanout verification are still required" end)}')"

printf '%s\n' "$report"
if [[ -n "$output" ]]; then
  if [[ "$output" != /* ]]; then output="$PWD/$output"; fi
  install -d -m 0755 "$(dirname "$output")"
  printf '%s\n' "$report" > "$output"
  chmod 0600 "$output"
fi

[[ "$control_ready" == true ]]
