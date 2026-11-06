#!/usr/bin/env bash
set -Eeuo pipefail

readonly BOOTSTRAP_DIR=/opt/pixel-brightness-bootstrap
readonly STATE_DIR=/var/lib/pixel-brightness/bootstrap
readonly LOG_FILE=/var/log/pixel-brightness-bootstrap.log
readonly HOSTNAME_VALUE=pixel-brightness-01

install -d -o root -g root -m 0700 "$STATE_DIR"
touch "$LOG_FILE"
chmod 0600 "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

[[ ! -e "$STATE_DIR/complete" ]] || exit 0
log "Pixel Brightness first-boot provisioning started"

hostnamectl set-hostname "$HOSTNAME_VALUE"
printf '%s\n' "$HOSTNAME_VALUE" > /etc/hostname
if ! grep -Eq '^127\.0\.1\.1[[:space:]]+pixel-brightness-01([[:space:]]|$)' /etc/hosts; then
  printf '127.0.1.1 pixel-brightness-01\n' >> /etc/hosts
fi

install -d -o root -g root -m 0755 /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/90-pixel-brightness-wifi.conf <<'EOF'
[connection]
wifi.powersave=2
EOF
chmod 0644 /etc/NetworkManager/conf.d/90-pixel-brightness-wifi.conf
nmcli general reload >/dev/null 2>&1 || true

export DEBIAN_FRONTEND=noninteractive
log "Waiting for the Wi-Fi connection configured by the operator"
nm-online --quiet --timeout=60 || { log "Network is not ready; provisioning will retry automatically"; exit 1; }
apt-get update
apt-get install -y openssh-server avahi-daemon libnss-mdns ufw curl jq rsync sudo

install -d -o pixeladmin -g pixeladmin -m 0700 /home/pixeladmin/.ssh
install -o pixeladmin -g pixeladmin -m 0600 \
  "$BOOTSTRAP_DIR/pixel-brightness-admin.pub" \
  /home/pixeladmin/.ssh/authorized_keys
cat > /etc/sudoers.d/pixel-brightness-admin <<'EOF'
pixeladmin ALL=(ALL:ALL) NOPASSWD:ALL
EOF
chmod 0440 /etc/sudoers.d/pixel-brightness-admin
visudo -cf /etc/sudoers.d/pixel-brightness-admin >/dev/null

if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf([[:space:]]|$)' /etc/ssh/sshd_config; then
  sed -i '1iInclude /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
fi
if ! grep -Ehsq '^[[:space:]]*Subsystem[[:space:]]+sftp([[:space:]]|$)' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null; then
  printf '\nSubsystem sftp internal-sftp\n' >> /etc/ssh/sshd_config
fi
install -o root -g root -m 0644 \
  "$BOOTSTRAP_DIR/00-pixel-brightness-sshd.conf" \
  /etc/ssh/sshd_config.d/00-pixel-brightness.conf
/usr/sbin/sshd -t
systemctl enable --now ssh.service avahi-daemon.service
systemctl reload ssh.service

install -d -o root -g root -m 0755 /etc/avahi/services
cat > /etc/avahi/services/pixel-brightness.service <<'EOF'
<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">Pixel Brightness on %h</name>
  <service><type>_ssh._tcp</type><port>22</port></service>
  <service><type>_http._tcp</type><port>3000</port></service>
  <service><type>_pixelbrightness._tcp</type><port>3000</port></service>
</service-group>
EOF
systemctl restart avahi-daemon.service

lan_cidr="$(ip -o -4 route show scope link | awk '$1 != "default" && $1 ~ /\// {print $1; exit}')"
ufw default deny incoming
ufw default allow outgoing
if [[ -n "$lan_cidr" ]]; then
  ufw allow from "$lan_cidr" to any port 22 proto tcp
  ufw allow from "$lan_cidr" to any port 3000 proto tcp
  ufw allow from "$lan_cidr" to any port 4100 proto tcp
else
  ufw allow 22/tcp
  ufw allow 3000/tcp
  ufw allow 4100/tcp
fi
ufw allow 5353/udp
ufw --force enable

if [[ ! -e "$STATE_DIR/application-installed" ]]; then
  log "Verifying and extracting the Pixel Brightness application"
  expected="$(awk '$2 == "pixel-brightness/pixel-brightness-source.tar.gz" {print $1}' "$BOOTSTRAP_DIR/MANIFEST.sha256")"
  actual="$(sha256sum "$BOOTSTRAP_DIR/pixel-brightness-source.tar.gz" | awk '{print $1}')"
  [[ -n "$expected" && "$actual" == "$expected" ]]
  install -d -o root -g root -m 0755 /opt/pixel-brightness-source
  tar -xzf "$BOOTSTRAP_DIR/pixel-brightness-source.tar.gz" -C /opt/pixel-brightness-source
  chmod 0755 /opt/pixel-brightness-source/deploy/ubuntu/*.sh
  /opt/pixel-brightness-source/deploy/ubuntu/install.sh \
    --role all \
    --node-id render-01 \
    --node-name "RTX A400 Render Node" \
    --appliance \
    --enable-power-actions
  touch "$STATE_DIR/application-installed"
fi

if [[ -e /var/run/reboot-required && ! -e "$STATE_DIR/reboot-requested" ]]; then
  log "NVIDIA or system packages require one reboot; provisioning will resume automatically"
  touch "$STATE_DIR/reboot-requested"
  systemctl reboot
  exit 0
fi

log "Running final appliance checks"
/opt/pixel-brightness/current/deploy/ubuntu/preflight.sh --strict
/opt/pixel-brightness/current/deploy/ubuntu/health-check.sh --json

python3 <<'PY'
from pathlib import Path

profiles = Path('/etc/NetworkManager/system-connections')
passwords = set()
if profiles.exists():
    for profile in profiles.glob('*.nmconnection'):
        for line in profile.read_text(errors='ignore').splitlines():
            if line.startswith('psk=') and line[4:]:
                passwords.add(line[4:].encode())
if passwords:
    for root in (Path('/var/lib/cloud/instances'), Path('/var/log/installer')):
        if not root.exists():
            continue
        for pathname in root.rglob('*'):
            if not pathname.is_file():
                continue
            try:
                content = pathname.read_bytes()
                redacted = content
                for password in passwords:
                    redacted = redacted.replace(password, b'[REDACTED]')
                if redacted != content:
                    pathname.write_bytes(redacted)
            except OSError:
                pass
PY

touch /etc/cloud/cloud-init.disabled
touch "$STATE_DIR/complete"
chmod 0600 "$STATE_DIR/complete"
systemctl disable pixel-brightness-firstboot.service >/dev/null 2>&1 || true
log "Provisioning complete: http://pixel-brightness-01.local:3000"
