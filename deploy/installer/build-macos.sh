#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly OUTPUT_ROOT="$PROJECT_ROOT/outputs/installer"
readonly UBUNTU_VERSION="24.04.4"
readonly UBUNTU_ISO_NAME="ubuntu-${UBUNTU_VERSION}-desktop-amd64.iso"
readonly UBUNTU_ISO_SHA256="3a4c9877b483ab46d7c3fbe165a0db275e1ae3cfe56a5657e5a47c2f99a99d1e"

base_iso="$OUTPUT_ROOT/cache/$UBUNTU_ISO_NAME"
output_image="$OUTPUT_ROOT/release/Pixel-Brightness-Ubuntu-${UBUNTU_VERSION}-R3-RUFUS-DD-ONLY-amd64.img"
ssh_public_key="$OUTPUT_ROOT/private/pixel-brightness-admin.pub"
recovery_password_file="$OUTPUT_ROOT/private/local-recovery-password"
xorriso_bin="${XORRISO:-}"
force=0
stage=""
build_image=""
checksum_tmp=""

usage() {
  cat <<'EOF'
Build the Pixel Brightness Ubuntu installer raw image on macOS.

This command only creates a regular hybrid .img file for Rufus DD mode. It
never calls diskutil, dd, or writes to a block device.

Usage: ./deploy/installer/build-macos.sh [options]

  --ssh-public-key PATH        Dedicated administrator public key
  --base-iso PATH              Verified Ubuntu Desktop 24.04.4 amd64 ISO
  --output PATH                Output raw .img file
  --xorriso PATH               xorriso executable
  --force                      Replace an existing regular output image
  -h, --help                   Show this help
EOF
}

die() {
  printf 'pixel-brightness-iso: %s\n' "$*" >&2
  exit 64
}

log() {
  printf '[Pixel Brightness ISO] %s\n' "$*"
}

absolute_path() {
  local value="$1" directory basename
  directory="$(cd -- "$(dirname -- "$value")" 2>/dev/null && pwd -P)" || return 1
  basename="$(basename -- "$value")"
  printf '%s/%s\n' "$directory" "$basename"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

safe_remove_stage() {
  local candidate="$1"
  case "$candidate" in
    "$OUTPUT_ROOT"/work/iso-stage.*) rm -rf -- "$candidate" ;;
    *) printf 'Refusing to remove unsafe temporary path: %s\n' "$candidate" >&2 ;;
  esac
}

cleanup() {
  if [[ -n "$stage" ]]; then
    safe_remove_stage "$stage"
  fi
  if [[ -n "$build_image" && "$build_image" == */.pixel-brightness-build.* && -f "$build_image" && ! -L "$build_image" ]]; then
    rm -f -- "$build_image"
  fi
  if [[ -n "$checksum_tmp" && "$checksum_tmp" == */.pixel-brightness-checksum.* && -f "$checksum_tmp" && ! -L "$checksum_tmp" ]]; then
    rm -f -- "$checksum_tmp"
  fi
}

trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ssh-public-key) ssh_public_key="${2:-}"; shift ;;
    --base-iso) base_iso="${2:-}"; shift ;;
    --output) output_image="${2:-}"; shift ;;
    --xorriso) xorriso_bin="${2:-}"; shift ;;
    --force) force=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "this builder is for macOS"
[[ "$(uname -m)" == "arm64" || "$(uname -m)" == "x86_64" ]] || die "unsupported Mac architecture"
[[ -r "$ssh_public_key" ]] || die "SSH public key is not readable"
[[ -f "$base_iso" ]] || die "base ISO does not exist"
[[ "$output_image" == *.img ]] || die "output must end in .img so Rufus cannot transpose ISO files"
case "$output_image" in
  /dev/*|/Volumes/*) die "output must be a regular project file, never a disk or mounted volume" ;;
esac

install -d -m 0700 "$OUTPUT_ROOT/private" "$OUTPUT_ROOT/work" "$OUTPUT_ROOT/release"
if [[ ! -e "$recovery_password_file" ]]; then
  recovery_password="$(openssl rand -base64 24)"
  printf '%s\n' "$recovery_password" > "$recovery_password_file"
  unset recovery_password
fi
[[ -f "$recovery_password_file" && ! -L "$recovery_password_file" && -s "$recovery_password_file" ]] \
  || die "local recovery password file must be a non-empty regular file"
chmod 0600 "$recovery_password_file"
base_iso="$(absolute_path "$base_iso")" || die "cannot resolve base ISO"
ssh_public_key="$(absolute_path "$ssh_public_key")" || die "cannot resolve SSH public key"
recovery_password_file="$(absolute_path "$recovery_password_file")" || die "cannot resolve local recovery password file"
output_image="$(absolute_path "$output_image")" || die "cannot resolve output path"
case "$output_image" in
  /dev/*|/Volumes/*) die "resolved output must never be a device or mounted volume" ;;
esac
[[ "$base_iso" != "$output_image" ]] || die "base ISO and output image must differ"

if [[ -e "$output_image" ]]; then
  [[ $force -eq 1 && -f "$output_image" && ! -L "$output_image" ]] || die "output exists; pass --force to replace that regular image"
fi

if [[ -z "$xorriso_bin" ]]; then
  if command -v xorriso >/dev/null 2>&1; then
    xorriso_bin="$(command -v xorriso)"
  elif [[ -x "$OUTPUT_ROOT/tools/xorriso" ]]; then
    xorriso_bin="$OUTPUT_ROOT/tools/xorriso"
  else
    die "xorriso is required; provide --xorriso PATH"
  fi
fi
[[ -x "$xorriso_bin" ]] || die "xorriso is not executable"

log "Verifying the official Ubuntu ISO"
actual_base_sha="$(sha256_file "$base_iso")"
[[ "$actual_base_sha" == "$UBUNTU_ISO_SHA256" ]] || die "Ubuntu ISO SHA-256 mismatch"

public_key="$(< "$ssh_public_key")"
[[ "$public_key" != *$'\r'* && "$public_key" != *$'\n'* ]] || die "SSH public key must be one line"
[[ "$public_key" == ssh-ed25519\ * || "$public_key" == ssh-rsa\ * || "$public_key" == ecdsa-sha2-*\ * ]] \
  || die "SSH public key has an unsupported format"
ssh-keygen -l -f "$ssh_public_key" >/dev/null 2>&1 || die "SSH public key is malformed"

stage="$(mktemp -d "$OUTPUT_ROOT/work/iso-stage.XXXXXXXX")"
build_image="$(mktemp "$(dirname -- "$output_image")/.pixel-brightness-build.XXXXXXXX")"
install -d -m 0700 "$stage/pixel-brightness"

recovery_password="$(< "$recovery_password_file")"
[[ "$recovery_password" != *$'\r'* && "$recovery_password" != *$'\n'* ]] \
  || die "local recovery password must be one line"
(( ${#recovery_password} >= 16 && ${#recovery_password} <= 128 )) \
  || die "local recovery password must contain 16-128 characters"
# macOS ships a legacy crypt(3) without SHA-512 crypt. The recovery secret is
# 192 random bits, exists only until SSH passes health checks, and is hashed
# rather than stored in the ISO. Ubuntu's libcrypt accepts this $1$ format.
password_hash="$(printf '%s' "$recovery_password" | openssl passwd -1 -stdin)"
unset recovery_password
[[ "$password_hash" == \$1\$* ]] || die "could not create the local recovery password hash"

cat > "$stage/autoinstall.yaml" <<EOF
autoinstall:
  version: 1
  interactive-sections:
    - network
    - storage
  locale: en_US.UTF-8
  keyboard:
    layout: us
  timezone: Asia/Bangkok
  refresh-installer:
    update: false
  identity:
    hostname: pixel-brightness-01
    username: pixeladmin
    password: '$password_hash'
  user-data:
    preserve_hostname: false
    manage_etc_hosts: true
    disable_root: true
    ssh_pwauth: false
    package_update: false
    package_upgrade: false
  drivers:
    install: false
  shutdown: reboot
  late-commands:
    - [cp, -a, /cdrom/pixel-brightness, /target/opt/pixel-brightness-bootstrap]
    - [chmod, -R, go-rwx, /target/opt/pixel-brightness-bootstrap]
    - [install, -m, '0644', /cdrom/pixel-brightness/pixel-brightness-firstboot.service, /target/etc/systemd/system/pixel-brightness-firstboot.service]
    - [curtin, in-target, --, systemctl, enable, pixel-brightness-firstboot.service]
EOF

install -m 0600 "$ssh_public_key" "$stage/pixel-brightness/pixel-brightness-admin.pub"
install -m 0700 "$SCRIPT_DIR/templates/pixel-brightness-firstboot.sh" "$stage/pixel-brightness/pixel-brightness-firstboot.sh"
install -m 0644 "$SCRIPT_DIR/templates/pixel-brightness-firstboot.service" "$stage/pixel-brightness/pixel-brightness-firstboot.service"
install -m 0644 "$SCRIPT_DIR/templates/00-pixel-brightness-sshd.conf" "$stage/pixel-brightness/00-pixel-brightness-sshd.conf"

log "Packaging the Pixel Brightness source without local caches or secrets"
COPYFILE_DISABLE=1 tar -czf "$stage/pixel-brightness/pixel-brightness-source.tar.gz" \
  --exclude .git \
  --exclude node_modules \
  --exclude outputs \
  --exclude work \
  --exclude .next \
  --exclude .vinext \
  --exclude .wrangler \
  --exclude .pixel-brightness \
  --exclude runtime/data \
  --exclude '*.iso' \
  -C "$PROJECT_ROOT" .
chmod 0600 "$stage/pixel-brightness/pixel-brightness-source.tar.gz"

cat > "$stage/PIXEL-BRIGHTNESS-README.txt" <<'EOF'
PIXEL BRIGHTNESS UBUNTU APPLIANCE

This installer contains no Wi-Fi password and never chooses a target disk.
Use Ubuntu's network screen to select Wi-Fi and enter its password yourself,
then select and confirm the intended SSD on the storage screen.

After the first reboot, keep the computer powered on and connected to Wi-Fi.
It installs SSH, NVIDIA support, Pixel Server, Render Node, Web Control, and the
appliance no-sleep policy. The process may reboot once.

Control addresses after provisioning:
  SSH: ssh pixeladmin@pixel-brightness-01.local
  Web: http://pixel-brightness-01.local:3000
EOF

(
  cd "$stage"
  {
    shasum -a 256 autoinstall.yaml
    shasum -a 256 PIXEL-BRIGHTNESS-README.txt
    find pixel-brightness -type f ! -name MANIFEST.sha256 -print | LC_ALL=C sort | while IFS= read -r pathname; do
      shasum -a 256 "$pathname"
    done
  } > pixel-brightness/MANIFEST.sha256
)
chmod 0600 "$stage/pixel-brightness/MANIFEST.sha256"

log "Building a hybrid BIOS + UEFI raw image for Rufus DD mode"
"$xorriso_bin" \
  -return_with SORRY 32 \
  -grow_blindly off \
  -indev "$base_iso" \
  -assess_indev_features replay \
  -compliance no_emul_toc \
  -outdev "$build_image" \
  -overwrite nondir \
  -map "$stage/autoinstall.yaml" /autoinstall.yaml \
  -map "$stage/PIXEL-BRIGHTNESS-README.txt" /PIXEL-BRIGHTNESS-README.txt \
  -map "$stage/pixel-brightness" /pixel-brightness \
  -padding 0 \
  -boot_image any replay \
  -commit \
  -end
chmod 0600 "$build_image"

"$SCRIPT_DIR/validate-iso.sh" \
  --iso "$build_image" \
  --base-iso "$base_iso" \
  --xorriso "$xorriso_bin"

if [[ -e "$output_image" && $force -ne 1 ]]; then
  die "output appeared while building; refusing to replace it"
fi
mv -f -- "$build_image" "$output_image"
build_image=""

output_sha="$(sha256_file "$output_image")"
checksum_tmp="$(mktemp "$(dirname -- "$output_image")/.pixel-brightness-checksum.XXXXXXXX")"
printf '%s  %s\n' "$output_sha" "$(basename "$output_image")" > "$checksum_tmp"
chmod 0600 "$checksum_tmp"
mv -f -- "$checksum_tmp" "${output_image}.sha256"
checksum_tmp=""

private_key_candidate="${ssh_public_key%.pub}"
if [[ "$ssh_public_key" == *.pub && -f "$private_key_candidate" && ! -L "$private_key_candidate" ]]; then
  known_hosts_file="$OUTPUT_ROOT/private/known_hosts"
  ssh_config_file="$OUTPUT_ROOT/private/ssh_config"
  touch "$known_hosts_file"
  chmod 0600 "$known_hosts_file"
  cat > "$ssh_config_file" <<EOF
Host pixel-brightness
  HostName pixel-brightness-01.local
  User pixeladmin
  IdentityFile "$private_key_candidate"
  IdentitiesOnly yes
  BatchMode yes
  PreferredAuthentications publickey
  PasswordAuthentication no
  StrictHostKeyChecking accept-new
  UserKnownHostsFile "$known_hosts_file"
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 4
EOF
  chmod 0600 "$ssh_config_file"
  log "Passwordless SSH profile: ssh -F '$ssh_config_file' pixel-brightness"
fi

log "Rufus DD-only installer ready: $output_image"
log "SHA-256: $output_sha"
log "Offline recovery password (locked after SSH is healthy): $recovery_password_file"
