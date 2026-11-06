#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEFAULT_SOURCE="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

role="all"
source_dir="$DEFAULT_SOURCE"
server_url="http://127.0.0.1:4100"
server_url_provided=0
node_id="$(hostname -s 2>/dev/null || printf pixel-node)"
node_id_provided=0
node_name="$(hostname 2>/dev/null || printf 'Pixel Brightness Node')"
node_token_file=""
power_token_file=""
control_token=""
node_signing_key=""
node_token=""
power_token=""
enable_power_actions=0
install_nvidia=1
appliance_mode=0
dry_run=0

usage() {
  cat <<'EOF'
Pixel Brightness V2 installer for Ubuntu 24.04 LTS

Usage: sudo ./deploy/ubuntu/install.sh [options]

  --role all|server|node       Services installed on this machine (default all)
  --source PATH                Pixel Brightness source tree
  --server-url URL             Server used by a Node
  --node-id ID                 Stable Render Node ID
  --node-name NAME             Name displayed in Web Control
  --node-token-file PATH       Per-node credential exported by the central Server
  --power-token-file PATH      Separate power-confirmation token (only with power actions)
  --enable-power-actions       Permit confirmed reboot/shutdown from Web Control
  --appliance                  Disable suspend/hibernate for a dedicated show PC
  --skip-nvidia                Do not install an NVIDIA driver automatically
  --dry-run                    Validate and print planned work without changing Ubuntu
  -h, --help                   Show this help
EOF
}

die() {
  printf 'pixel-brightness-install: %s\n' "$*" >&2
  exit 64
}

log() {
  printf '[Pixel Brightness] %s\n' "$*"
}

run() {
  if [[ $dry_run -eq 1 ]]; then
    printf '  +'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="${2:-}"; shift ;;
    --source) source_dir="${2:-}"; shift ;;
    --server-url) server_url="${2:-}"; server_url_provided=1; shift ;;
    --node-id) node_id="${2:-}"; node_id_provided=1; shift ;;
    --node-name) node_name="${2:-}"; shift ;;
    --node-token-file) node_token_file="${2:-}"; shift ;;
    --power-token-file) power_token_file="${2:-}"; shift ;;
    --auth-token) die "--auth-token was a shared control secret and is no longer accepted; use --node-token-file" ;;
    --enable-power-actions) enable_power_actions=1 ;;
    --appliance) appliance_mode=1 ;;
    --skip-nvidia) install_nvidia=0 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ "$role" == "all" || "$role" == "server" || "$role" == "node" ]] || die "--role must be all, server, or node"
if [[ -n "$node_token_file" && "$role" != "node" ]]; then
  die "--node-token-file is accepted only with --role node; an all-in-one host derives its own credential"
fi
source_dir="$(cd -- "$source_dir" 2>/dev/null && pwd -P)" || die "source directory does not exist"
[[ -f "$source_dir/package.json" && -f "$source_dir/runtime/server/index.mjs" ]] || die "--source is not a Pixel Brightness tree"
[[ "$node_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || die "--node-id contains unsupported characters"
[[ "$server_url" =~ ^https?://[^[:space:]]+$ ]] || die "--server-url must be an http(s) URL"
if [[ -n "$node_token_file" ]]; then
  [[ -r "$node_token_file" ]] || die "--node-token-file is not readable"
  node_token="$(tr -d '\r\n' < "$node_token_file")"
  [[ "$node_token" =~ ^pbnode\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$ ]] \
    || die "--node-token-file does not contain one canonical Render Node credential"
fi
if [[ -n "$power_token_file" ]]; then
  [[ -r "$power_token_file" ]] || die "--power-token-file is not readable"
  power_token="$(tr -d '\r\n' < "$power_token_file")"
  [[ "$power_token" =~ ^[A-Za-z0-9._~-]{32,256}$ ]] \
    || die "--power-token-file does not contain one valid power-confirmation token"
fi

if [[ $dry_run -eq 0 && ${EUID} -ne 0 ]]; then
  die "run with sudo, or use --dry-run"
fi

os_id="unknown"
os_version="unknown"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  os_id="${ID:-unknown}"
  os_version="${VERSION_ID:-unknown}"
fi
if [[ $dry_run -eq 0 ]]; then
  [[ "$os_id" == "ubuntu" ]] || die "this installer supports Ubuntu only"
  [[ "$(printf '%s\n' '24.04' "$os_version" | sort -V | head -n1)" == "24.04" ]] || die "Ubuntu 24.04 or newer is required"
  [[ "$(uname -m)" == "x86_64" ]] || die "the V2 appliance installer currently supports x86_64"
fi

log "Plan: role=$role node=$node_id server=$server_url appliance=$appliance_mode"

install_base_packages() {
  log "Installing Ubuntu prerequisites"
  run apt-get update
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl dconf-cli gnupg jq openssl pciutils rsync sudo \
    ubuntu-drivers-common libdrm-tests x11-xserver-utils
}

install_nodejs() {
  local current="0.0.0"
  if command -v node >/dev/null 2>&1; then
    current="$(node --version | sed 's/^v//')"
  fi
  if [[ "$(printf '%s\n' '22.13.0' "$current" | sort -V | head -n1)" == "22.13.0" ]]; then
    log "Node.js $current is compatible"
    return
  fi
  log "Installing Node.js 22 from the signed NodeSource APT repository"
  if [[ $dry_run -eq 1 ]]; then
    run install -d -m 0755 /etc/apt/keyrings
    run curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/pixel-brightness-nodesource.key
    run gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg /tmp/pixel-brightness-nodesource.key
    run apt-get install -y nodejs
    return
  fi
  install -d -m 0755 /etc/apt/keyrings
  local key_file
  key_file="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$key_file"
  gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg "$key_file"
  rm -f -- "$key_file"
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  local installed
  installed="$(node --version | sed 's/^v//')"
  [[ "$(printf '%s\n' '22.13.0' "$installed" | sort -V | head -n1)" == "22.13.0" ]] || die "Node.js 22.13+ installation failed"
}

install_nvidia_driver() {
  [[ $install_nvidia -eq 1 ]] || return 0
  command -v lspci >/dev/null 2>&1 || return 0
  lspci | grep -Eiq 'VGA|3D controller' || return 0
  lspci | grep -Eiq 'NVIDIA' || return 0
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    log "NVIDIA driver is already active"
    return
  fi
  log "Installing Ubuntu's recommended signed NVIDIA driver"
  run ubuntu-drivers install
  if [[ $dry_run -eq 0 ]]; then
    install -d -m 0755 /etc/modprobe.d
    printf '%s\n' 'options nvidia-drm modeset=1 fbdev=1' > /etc/modprobe.d/pixel-brightness-nvidia.conf
    touch /var/run/reboot-required
  fi
}

create_account_and_paths() {
  log "Creating isolated Server and Render Node service accounts and data paths"
  if ! getent group pixelbrightness >/dev/null 2>&1; then
    run groupadd --system pixelbrightness
  fi
  if ! getent group pixelserver >/dev/null 2>&1; then
    run groupadd --system pixelserver
  fi
  if ! getent group video >/dev/null 2>&1; then
    run groupadd --system video
  fi
  if ! getent group render >/dev/null 2>&1; then
    run groupadd --system render
  fi
  if ! id pixelbrightness >/dev/null 2>&1; then
    run useradd --system --gid pixelbrightness --home-dir /var/lib/pixel-brightness --shell /usr/sbin/nologin pixelbrightness
  fi
  if ! id pixelserver >/dev/null 2>&1; then
    run useradd --system --gid pixelserver --home-dir /var/lib/pixel-brightness/server --shell /usr/sbin/nologin pixelserver
  fi
  run usermod -a -G video,render pixelbrightness
  run install -d -o root -g root -m 0755 /opt/pixel-brightness /opt/pixel-brightness/releases
  run install -d -o root -g root -m 0755 /etc/pixel-brightness /var/lib/pixel-brightness
  run install -d -o pixelserver -g pixelserver -m 0750 /var/lib/pixel-brightness/server
  run install -d -o pixelbrightness -g pixelbrightness -m 0750 /var/lib/pixel-brightness/node /var/log/pixel-brightness
  if [[ $dry_run -eq 0 ]]; then
    chown -R pixelserver:pixelserver /var/lib/pixel-brightness/server
    chown -R pixelbrightness:pixelbrightness /var/lib/pixel-brightness/node
  fi
}

deploy_release() {
  local version release_id release_dir previous
  version="$(node -p "require('$source_dir/package.json').version" 2>/dev/null || printf 0.0.0)"
  release_id="${version}-$(date -u +%Y%m%dT%H%M%SZ)"
  release_dir="/opt/pixel-brightness/releases/$release_id"
  previous=""
  if [[ -L /opt/pixel-brightness/current ]]; then
    previous="$(readlink -f /opt/pixel-brightness/current)"
  fi
  log "Building release $release_id before switching the live services"
  run install -d -o root -g root -m 0755 "$release_dir"
  run rsync -a \
    --exclude .git \
    --exclude node_modules \
    --exclude .pnpm-store \
    --exclude .vinext \
    --exclude .wrangler \
    --exclude .pixel-brightness \
    --exclude runtime/data \
    "$source_dir/" "$release_dir/"
  if [[ $dry_run -eq 0 ]]; then
    (cd "$release_dir" && npm ci --no-audit --no-fund)
    (cd "$release_dir" && npm run build)
    (cd "$release_dir" && node --test tests/calibration.test.mjs tests/mapping.test.mjs tests/protocol.test.mjs tests/timecore.test.mjs)
    chown -R root:root "$release_dir"
    chmod -R a-w "$release_dir"
    ln -sfn "$release_dir" /opt/pixel-brightness/.current-next
    mv -Tf /opt/pixel-brightness/.current-next /opt/pixel-brightness/current
    printf '%s\n' "$previous" > /var/lib/pixel-brightness/previous-release
    printf '%s\n' "$release_dir" > /var/lib/pixel-brightness/current-release
  else
    run npm ci --no-audit --no-fund
    run npm run build
    run ln -sfn "$release_dir" /opt/pixel-brightness/current
  fi
}

discover_outputs_json() {
  local outputs='[]' index=0 status_file connector mode width height x=0
  for status_file in /sys/class/drm/card*-*/status; do
    [[ -r "$status_file" ]] || continue
    [[ "$(tr -d '\n' < "$status_file")" == "connected" ]] || continue
    connector="$(basename "$(dirname "$status_file")")"
    connector="$(sed -E 's/^card[0-9]+-//' <<<"$connector")"
    mode="$(head -n1 "$(dirname "$status_file")/modes" 2>/dev/null || true)"
    width="${mode%x*}"
    height="${mode#*x}"
    [[ "$width" =~ ^[0-9]+$ ]] || width=1920
    [[ "$height" =~ ^[0-9]+$ ]] || height=1080
    index=$((index + 1))
    outputs="$(jq -c \
      --arg id "$(printf '%b' "\\$(printf '%03o' $((64 + index)))")" \
      --arg name "Projector $index" \
      --arg connector "$connector" \
      --argjson width "$width" \
      --argjson height "$height" \
      --argjson x "$x" \
      '. + [{id:$id,name:$name,connector:$connector,enabled:true,position:{x:$x,y:0},resolution:{width:$width,height:$height,refreshNum:60,refreshDen:1}}]' <<<"$outputs")"
    x=$((x + width))
    [[ $index -ge 8 ]] && break
  done
  if [[ $index -eq 0 ]]; then
    outputs='[
      {"id":"A","name":"Projector A","connector":"DP-1","enabled":true,"position":{"x":0,"y":0},"resolution":{"width":1920,"height":1080,"refreshNum":60,"refreshDen":1}},
      {"id":"B","name":"Projector B","connector":"DP-2","enabled":true,"position":{"x":1920,"y":0},"resolution":{"width":1920,"height":1080,"refreshNum":60,"refreshDen":1}},
      {"id":"C","name":"Projector C","connector":"DP-3","enabled":true,"position":{"x":3840,"y":0},"resolution":{"width":1920,"height":1080,"refreshNum":60,"refreshDen":1}},
      {"id":"D","name":"Projector D","connector":"DP-4","enabled":false,"position":{"x":5760,"y":0},"resolution":{"width":1920,"height":1080,"refreshNum":60,"refreshDen":1}}
    ]'
  fi
  printf '%s\n' "$outputs"
}

write_configuration() {
  local existing_server_url=""
  local existing_node_id=""
  local control_path=/etc/pixel-brightness/control-token
  local signing_path=/etc/pixel-brightness/node-signing-key
  local node_token_path=/etc/pixel-brightness/node-token
  local power_server_path=/etc/pixel-brightness/power-action-token
  local power_node_path=/etc/pixel-brightness/power-confirmation-token
  log "Writing role-separated control and Render Node credentials"
  if [[ $server_url_provided -eq 0 && -r /etc/pixel-brightness/node.json ]] && command -v jq >/dev/null 2>&1; then
    existing_server_url="$(jq -r '.serverUrl // empty' /etc/pixel-brightness/node.json 2>/dev/null || true)"
    if [[ "$existing_server_url" =~ ^https?://[^[:space:]]+$ ]]; then
      server_url="$existing_server_url"
    fi
  fi
  if [[ $node_id_provided -eq 0 && -r /etc/pixel-brightness/node.json ]] && command -v jq >/dev/null 2>&1; then
    existing_node_id="$(jq -r '.nodeId // empty' /etc/pixel-brightness/node.json 2>/dev/null || true)"
    if [[ "$existing_node_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]]; then
      node_id="$existing_node_id"
    fi
  fi
  if [[ $dry_run -eq 1 ]]; then
    control_token="DRY-RUN-CONTROL-TOKEN-ROTATED-000000000"
    node_signing_key="DRY-RUN-NODE-SIGNING-KEY-0000000000000"
    node_token="pbnode.v1.cmVuZGVyLTAx.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    power_token="DRY-RUN-POWER-TOKEN-0000000000000000"
    run install role-separated-configuration /etc/pixel-brightness
    return
  fi

  umask 027
  if [[ "$role" == "all" || "$role" == "server" ]]; then
    # A legacy control token was readable by Render Nodes. It can never be
    # promoted into the new control role. Only a previously completed split is
    # reusable; every legacy/partial migration rotates both Server secrets.
    if [[ -r "$control_path" && -r "$signing_path" \
        && -r /etc/pixel-brightness/server.env \
        && $(grep -c '^PB_CONTROL_TOKEN_FILE=' /etc/pixel-brightness/server.env || true) -eq 1 \
        && $(grep -c '^PB_NODE_SIGNING_KEY_FILE=' /etc/pixel-brightness/server.env || true) -eq 1 \
        && $(grep -c '^PIXEL_AUTH_TOKEN=' /etc/pixel-brightness/server.env || true) -eq 0 ]]; then
      control_token="$(tr -d '\r\n' < "$control_path")"
      node_signing_key="$(tr -d '\r\n' < "$signing_path")"
    else
      control_token="$(openssl rand -hex 32)"
      node_signing_key="$(openssl rand -hex 32)"
      log "Legacy/shared authentication detected: rotating the browser control token; existing browsers must Pair again"
    fi
    [[ ${#control_token} -ge 32 && ${#node_signing_key} -ge 32 && "$control_token" != "$node_signing_key" ]] \
      || die "role-separated Server secrets are missing, short, or identical"
    if [[ -z "$power_token" ]]; then
      if [[ -r "$power_server_path" ]]; then
        power_token="$(tr -d '\r\n' < "$power_server_path")"
      else
        power_token="$(openssl rand -hex 32)"
      fi
    fi
    [[ "$power_token" != "$control_token" ]] || die "power token must be distinct from the control token"
    printf '%s\n' "$control_token" > "$control_path"
    printf '%s\n' "$node_signing_key" > "$signing_path"
    printf '%s\n' "$power_token" > "$power_server_path"
    cat > /etc/pixel-brightness/server.env <<EOF
PB_SERVER_HOST=0.0.0.0
PB_SERVER_PORT=4100
PB_SERVER_DATA_DIR=/var/lib/pixel-brightness/server
PB_MAX_UPLOAD_BYTES=21474836480
PB_CONTROL_TOKEN_FILE=$control_path
PB_NODE_SIGNING_KEY_FILE=$signing_path
PB_ALLOW_POWER_ACTIONS=$enable_power_actions
PB_POWER_ACTION_TOKEN=$power_token
EOF
    chown root:pixelserver "$control_path" "$signing_path" "$power_server_path" /etc/pixel-brightness/server.env
    chmod 0640 "$control_path" "$signing_path" "$power_server_path" /etc/pixel-brightness/server.env
  else
    # A role transition to render-only must not leave dormant operator
    # authority or a credential-minting key on the render host.
    rm -f -- "$control_path" "$signing_path" "$power_server_path" /etc/pixel-brightness/server.env
  fi

  if [[ "$role" == "all" || "$role" == "node" ]]; then
    if [[ "$role" == "all" ]]; then
      node_token="$(node /opt/pixel-brightness/current/runtime/server/create-node-credential.mjs \
        --node-id "$node_id" --secret-file "$signing_path")"
    elif [[ -z "$node_token" && -r "$node_token_path" ]]; then
      node_token="$(tr -d '\r\n' < "$node_token_path")"
    fi
    [[ "$node_token" =~ ^pbnode\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$ ]] \
      || die "a Node-only install requires --node-token-file exported by its central Server"
    local credential_node_id
    credential_node_id="$(printf '%s' "$node_token" | node -e '
      const fs = require("node:fs");
      const { pathToFileURL } = require("node:url");
      import(pathToFileURL(process.argv[1]).href).then(({ nodeIdFromNodeCredential }) => {
        const nodeId = nodeIdFromNodeCredential(fs.readFileSync(0, "utf8").trim());
        if (!nodeId) process.exit(2);
        process.stdout.write(nodeId);
      }).catch(() => process.exit(2));
    ' /opt/pixel-brightness/current/runtime/shared/node-auth.mjs)" \
      || die "Render Node credential is not canonical"
    [[ "$credential_node_id" == "$node_id" ]] \
      || die "Render Node credential is bound to $credential_node_id, not configured node $node_id"
    if [[ -z "$power_token" && -r "$power_node_path" ]]; then
      power_token="$(tr -d '\r\n' < "$power_node_path")"
    fi
    if [[ $enable_power_actions -eq 1 && -z "$power_token" ]]; then
      die "--enable-power-actions on a Node-only install requires --power-token-file"
    fi
    printf '%s\n' "$node_token" > "$node_token_path"
    printf '%s\n' "$power_token" > "$power_node_path"
    if [[ ! -e /etc/pixel-brightness/node.json ]]; then
      local outputs
      outputs="$(discover_outputs_json)"
      jq -n \
        --arg nodeId "$node_id" \
        --arg name "$node_name" \
        --arg serverUrl "$server_url" \
        --argjson outputs "$outputs" \
        --argjson allowPowerActions "$enable_power_actions" \
        '{nodeId:$nodeId,name:$name,serverUrl:$serverUrl,dataDir:"/var/lib/pixel-brightness/node",heartbeatMs:1000,clockSyncMs:30000,clockSyncRounds:12,pollWaitMs:20000,allowPowerActions:$allowPowerActions,hostControlCommand:"/usr/local/sbin/pixel-brightness-hostctl",outputs:$outputs}' \
        > /etc/pixel-brightness/node.json
    else
      local node_tmp
      node_tmp="$(mktemp /etc/pixel-brightness/node.json.XXXXXX)"
      jq \
        --arg nodeId "$node_id" \
        --arg serverUrl "$server_url" \
        --argjson setServerUrl "$server_url_provided" \
        --argjson enablePower "$enable_power_actions" \
        '.nodeId=$nodeId | .hostControlCommand="/usr/local/sbin/pixel-brightness-hostctl"
          | if $setServerUrl == 1 then .serverUrl=$serverUrl else . end
          | if $enablePower == 1 then .allowPowerActions=true else . end' \
        /etc/pixel-brightness/node.json > "$node_tmp"
      mv -f "$node_tmp" /etc/pixel-brightness/node.json
    fi
    cat > /etc/pixel-brightness/node.env <<EOF
PIXEL_BRIGHTNESS_CONFIG=/etc/pixel-brightness/node.json
PIXEL_BRIGHTNESS_NODE_TOKEN=$node_token
PIXEL_BRIGHTNESS_SERVER_URL=$server_url
PIXEL_BRIGHTNESS_ALLOW_POWER_ACTIONS=$enable_power_actions
PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN=$power_token
PIXEL_BRIGHTNESS_HOST_CONTROL_COMMAND=/usr/local/sbin/pixel-brightness-hostctl
EOF
    chown root:pixelbrightness "$node_token_path" "$power_node_path" \
      /etc/pixel-brightness/node.env /etc/pixel-brightness/node.json
    chmod 0640 "$node_token_path" "$power_node_path" \
      /etc/pixel-brightness/node.env /etc/pixel-brightness/node.json
  else
    # A Server-only host does not retain a former Node bearer or its power
    # confirmation secret after an all-in-one to Server role transition.
    rm -f -- "$node_token_path" "$power_node_path" /etc/pixel-brightness/node.env
  fi
}

install_services() {
  log "Installing services, recovery timer, and the restricted host helper"
  local current=/opt/pixel-brightness/current
  run install -o root -g root -m 0755 "$current/deploy/ubuntu/pixel-brightness-hostctl" /usr/local/sbin/pixel-brightness-hostctl
  run install -o root -g root -m 0755 "$current/deploy/ubuntu/health-check.sh" /usr/local/lib/pixel-brightness-health-check
  run install -o root -g root -m 0755 "$current/deploy/ubuntu/support-bundle.sh" /usr/local/bin/pixel-brightness-support-bundle
  run install -o root -g root -m 0755 "$current/deploy/ubuntu/acceptance.sh" /usr/local/bin/pixel-brightness-acceptance
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-server.service" /etc/systemd/system/pixel-brightness-server.service
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-node.service" /etc/systemd/system/pixel-brightness-node.service
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-web.service" /etc/systemd/system/pixel-brightness-web.service
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-health.service" /etc/systemd/system/pixel-brightness-health.service
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-health.timer" /etc/systemd/system/pixel-brightness-health.timer
  run install -o root -g root -m 0644 "$current/deploy/systemd/pixel-brightness-nosleep.service" /etc/systemd/system/pixel-brightness-nosleep.service
  if [[ $dry_run -eq 0 ]]; then
    cat > /etc/sudoers.d/pixel-brightness-hostctl <<'EOF'
pixelbrightness ALL=(root) NOPASSWD: /usr/local/sbin/pixel-brightness-hostctl
EOF
    chmod 0440 /etc/sudoers.d/pixel-brightness-hostctl
    visudo -cf /etc/sudoers.d/pixel-brightness-hostctl >/dev/null
  fi
  run systemctl daemon-reload
  if [[ "$role" == "all" || "$role" == "server" ]]; then
    run systemctl enable --now pixel-brightness-server.service pixel-brightness-web.service
  else
    run systemctl disable --now pixel-brightness-server.service pixel-brightness-web.service
  fi
  if [[ "$role" == "all" || "$role" == "node" ]]; then
    run systemctl enable --now pixel-brightness-node.service
  else
    run systemctl disable --now pixel-brightness-node.service
  fi
  run systemctl enable --now pixel-brightness-health.timer
}

configure_appliance() {
  [[ $appliance_mode -eq 1 ]] || return 0
  log "Applying dedicated-appliance no-sleep and no-blank policy"
  if [[ $dry_run -eq 0 ]]; then
    install -d -m 0755 \
      /etc/systemd/sleep.conf.d \
      /etc/systemd/logind.conf.d \
      /etc/dconf/profile \
      /etc/dconf/db/local.d/locks
    cat > /etc/systemd/sleep.conf.d/pixel-brightness.conf <<'EOF'
[Sleep]
AllowSuspend=no
AllowHibernation=no
AllowSuspendThenHibernate=no
AllowHybridSleep=no
EOF
    cat > /etc/systemd/logind.conf.d/pixel-brightness.conf <<'EOF'
[Login]
IdleAction=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
    if [[ ! -e /etc/dconf/profile/user ]]; then
      cat > /etc/dconf/profile/user <<'EOF'
user-db:user
system-db:local
EOF
    elif ! grep -qxF 'system-db:local' /etc/dconf/profile/user; then
      printf '%s\n' 'system-db:local' >> /etc/dconf/profile/user
    fi
    cat > /etc/dconf/db/local.d/00-pixel-brightness <<'EOF'
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false

[org/gnome/settings-daemon/plugins/power]
idle-dim=false
sleep-inactive-ac-timeout=0
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-timeout=0
sleep-inactive-battery-type='nothing'
EOF
    cat > /etc/dconf/db/local.d/locks/pixel-brightness <<'EOF'
/org/gnome/desktop/session/idle-delay
/org/gnome/desktop/screensaver/lock-enabled
/org/gnome/settings-daemon/plugins/power/idle-dim
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-timeout
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-timeout
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type
EOF
    touch /etc/pixel-brightness/appliance-mode
  fi
  run dconf update
  run systemctl kill --kill-whom=main --signal=SIGHUP systemd-logind.service
  run systemctl mask --now \
    sleep.target \
    suspend.target \
    hibernate.target \
    hybrid-sleep.target \
    suspend-then-hibernate.target
  run systemctl enable --now pixel-brightness-nosleep.service
}

post_install_check() {
  [[ $dry_run -eq 0 ]] || return 0
  sleep 2
  local failed=0
  if [[ "$role" == "all" || "$role" == "server" ]]; then
    /opt/pixel-brightness/current/deploy/ubuntu/health-check.sh --json || failed=1
  else
    systemctl is-active --quiet pixel-brightness-node.service || failed=1
  fi
  if [[ $failed -eq 1 ]]; then
    log "A service did not become healthy. Attempting an automatic release rollback."
    journalctl -u pixel-brightness-server.service -u pixel-brightness-node.service -u pixel-brightness-web.service -n 40 --no-pager || true
    local previous
    previous="$(head -n1 /var/lib/pixel-brightness/previous-release 2>/dev/null || true)"
    if [[ "$previous" == /opt/pixel-brightness/releases/* && -d "$previous" ]]; then
      ln -sfn "$previous" /opt/pixel-brightness/.current-next
      mv -Tf /opt/pixel-brightness/.current-next /opt/pixel-brightness/current
      printf '%s\n' "$previous" > /var/lib/pixel-brightness/current-release
      systemctl daemon-reload
      if [[ "$role" == "all" || "$role" == "server" ]]; then
        systemctl try-restart pixel-brightness-server.service pixel-brightness-web.service
      fi
      if [[ "$role" == "all" || "$role" == "node" ]]; then
        systemctl try-restart pixel-brightness-node.service
      fi
      log "Rolled back automatically to $previous"
    else
      log "No previous release exists; inspect the journal before retrying installation."
    fi
    exit 1
  fi
}

install_base_packages
install_nodejs
install_nvidia_driver
create_account_and_paths
deploy_release
write_configuration
install_services
configure_appliance
post_install_check

log "V2 installation completed"
log "Web Control: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT:-3000}"
if [[ $dry_run -eq 0 ]]; then
  log "Pairing token is stored at /etc/pixel-brightness/control-token (Server-only; use sudo to read)"
  if [[ "$role" == "all" || "$role" == "server" ]]; then
    log "Create a remote Node credential with: sudo node /opt/pixel-brightness/current/runtime/server/create-node-credential.mjs --node-id NODE_ID --secret-file /etc/pixel-brightness/node-signing-key"
  fi
  if [[ -e /var/run/reboot-required ]]; then
    log "A reboot is required before NVIDIA output validation"
  fi
  if [[ $appliance_mode -eq 1 ]]; then
    log "No-sleep is active; reboot or start a new GNOME login once to apply the no-blank desktop policy"
  fi
fi
