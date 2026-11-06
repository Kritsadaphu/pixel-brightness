# Pixel Brightness V2 · Ubuntu appliance

This deployment target turns an Ubuntu 24.04 LTS x86_64 machine into a
recoverable Pixel Server, Render Node, or combined test appliance. It is aimed
at the RTX A400 test machine first, while keeping the runtime portable to other
NVIDIA cards.

## Safety model

- Web Control never exposes an arbitrary terminal or shell command.
- Host operations are an explicit allowlist and are audited by the Server.
- The Node service may elevate only the immutable
  `/usr/local/sbin/pixel-brightness-hostctl` helper through a dedicated sudoers
  rule; the helper validates every action and argument again as root.
- Server authentication is enabled by the installer. The pairing token stays
  in `/etc/pixel-brightness/control-token` and in the paired browser's local
  storage only. Render Nodes receive HMAC-bound per-node credentials instead;
  they never receive the control token or Server-only signing key. The Server
  runs as `pixelserver`, separate from the `pixelbrightness` Render Node user.
- A dedicated controller can use Trusted Local mode without a Pair prompt by
  setting `PB_TRUST_LOCAL_WEB=1` and its exact source IP in
  `PB_TRUSTED_WEB_CLIENTS`, plus the exact Server names in
  `PB_TRUSTED_WEB_HOSTS`; every other LAN client remains token-protected.
- Reboot and shutdown are disabled unless installation uses
  `--enable-power-actions`, and still require the confirmation phrase in Web
  Control.
- `--appliance` keeps a dedicated show machine awake with a persistent systemd
  inhibitor, masks every standard sleep target, ignores lid/idle sleep actions,
  and disables GNOME idle blanking. Manual reboot and shutdown still work.
- Each update is built and tested in a versioned release directory before the
  `/opt/pixel-brightness/current` symlink changes. The previous release remains
  available to `rollback.sh`.

## Recommended first installation

Use a separate SSD or back up the computer first. Install Ubuntu Desktop 24.04
LTS, enable third-party NVIDIA software in the installer, connect Ethernet, and
then copy this repository to the test machine.

Inspect without changing the machine:

```bash
./deploy/ubuntu/preflight.sh
sudo ./deploy/ubuntu/install.sh --dry-run --role all --appliance
```

Install one combined Server + Node for up to four RTX A400 connectors:

```bash
sudo ./deploy/ubuntu/install.sh \
  --role all \
  --node-id render-01 \
  --node-name "RTX A400 test node" \
  --appliance
```

Create a credential on the Server for a later Render Node, then copy that one
file over a secure channel:

```bash
sudo node /opt/pixel-brightness/current/runtime/server/create-node-credential.mjs \
  --node-id render-02 \
  --secret-file /etc/pixel-brightness/node-signing-key \
  | sudo tee /root/render-02.node-token >/dev/null
sudo chmod 0600 /root/render-02.node-token
```

On the Render Node:

```bash
sudo ./deploy/ubuntu/install.sh \
  --role node \
  --server-url http://192.168.50.10:4100 \
  --node-id render-02 \
  --node-token-file /root/render-02.node-token
```

The installer decodes the credential without placing it in process arguments
and requires its embedded node id to equal `--node-id`. A credential for a
different Render Node is rejected before the Node service is enabled.

The old `--auth-token` option is rejected because it exposed the browser/control
secret to every node. The first upgrade from that legacy layout rotates the
control token, so browsers must Pair again and remote Nodes must be provisioned
with new per-node credential files. This is intentionally fail-closed.
Changing an installed machine to `--role node` deletes dormant Server
credentials and `server.env`; changing it to `--role server` deletes the former
Node bearer, Node environment file, and Node power-confirmation secret.

Power actions should only be enabled on a dedicated show computer:

```bash
sudo ./deploy/ubuntu/install.sh --role all --appliance --enable-power-actions
```

After a driver install, reboot once. Check the machine with:

```bash
sudo cat /etc/pixel-brightness/control-token
sudo /opt/pixel-brightness/current/deploy/ubuntu/preflight.sh --strict
sudo /opt/pixel-brightness/current/deploy/ubuntu/health-check.sh --json
sudo pixel-brightness-acceptance --node-id render-01 --minimum-connectors 3
```

Open `http://NODE-IP:3000`, pair the browser with the token, and confirm that
all four mini DisplayPort connectors and their EDID/modes appear in the Ubuntu
panel.

Confirm the appliance sleep lock after reboot:

```bash
systemctl status pixel-brightness-nosleep.service --no-pager
systemd-inhibit --list --no-pager
sudo /opt/pixel-brightness/current/deploy/ubuntu/health-check.sh --json
```

The health result must show `"appliance":true` and `"noSleep":true`. GNOME
system settings take effect for a newly started login session, so log out once
or reboot after the first appliance installation.

The acceptance result intentionally reports two separate decisions:
`controlPlaneReady` covers Ubuntu, NVIDIA, services, connectors and software
timing; `nativeScanoutVerified` remains false until the physical DRM/KMS
renderer proves real GPU scanout. Never use the first value as a substitute for
the second.

## Updates and bug recovery

Run the same `install.sh` from a newer source tree. It creates a new immutable
release without overwriting the active one. If a regression is found:

```bash
sudo /opt/pixel-brightness/current/deploy/ubuntu/rollback.sh
```

Logs remain available across releases:

```bash
journalctl -u pixel-brightness-node -u pixel-brightness-server -u pixel-brightness-web
```

When a hardware or timing bug appears, create a redacted support bundle for the
next version:

```bash
sudo pixel-brightness-support-bundle --output /tmp/pixel-brightness-support.tar.gz
```

The bundle contains NVIDIA/DRM/EDID state, recent service logs, health results,
and non-secret configuration. Authentication and power tokens are removed.

## What V2 can and cannot verify without the projector PC

The installer, service recovery, authentication, display/GPU telemetry,
allowlisted host actions, project mapping, deterministic clock, and simulator
can be validated in CI or on a development machine. NVIDIA driver loading,
physical EDID hot-plug, DRM/KMS ownership, decoder throughput, and real scanout
timestamps must be accepted on the RTX A400 Ubuntu machine before calling the
native projector renderer show-ready. A green Web Control status is not a
substitute for that hardware acceptance test.
