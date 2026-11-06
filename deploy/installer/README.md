# Pixel Brightness Ubuntu Installer Raw Image

This folder builds a regular, bootable Ubuntu 24.04.4 Desktop amd64 hybrid
`.img` for the dedicated i5 / 64 GB / NVIDIA RTX A400 appliance. The `.img`
extension makes Rufus use a raw/DD write and avoids ISO-mode file transposition.
The builder never runs `dd`, `diskutil eraseDisk`, or writes to a block device.

## Safety contract

- Ubuntu's official ISO is pinned to SHA-256
  `3a4c9877b483ab46d7c3fbe165a0db275e1ae3cfe56a5657e5a47c2f99a99d1e`.
- BIOS, UEFI, MBR/GPT, and hybrid-USB boot metadata are replayed by `xorriso`.
- `/autoinstall.yaml` requires interactive Network and Storage sections and has
  no automatic `network:` or `storage:` policy. The operator enters Wi-Fi and
  selects the intended SSD personally.
- No Wi-Fi password is embedded. The image remains mode `0600` because it carries
  the private application source; `outputs/` is ignored by Git.
- Only the dedicated SSH public key is embedded. Its private key never enters
  the ISO.
- A random local-console recovery password is kept only in
  `outputs/installer/private/local-recovery-password`. It works if networking
  fails before SSH is installed, then first boot locks it after health checks.
  SSH password authentication remains disabled at all times.

## Build

```bash
./deploy/installer/build-macos.sh \
  --ssh-public-key outputs/installer/private/pixel-brightness-admin.pub \
  --xorriso outputs/installer/tools/xorriso
```

The result is written to:

```text
outputs/installer/release/Pixel-Brightness-Ubuntu-24.04.4-R3-RUFUS-DD-ONLY-amd64.img
```

In current Rufus, select the `.img`, press START, and use **DD Image mode** if
Rufus asks. Never select ISO Image mode for this file. Rufus writes the complete
hybrid layout, so partition-scheme and filesystem controls can be unavailable.
Boot the target PC from the `UEFI: <USB>` entry, approve the autoinstall
configuration, connect to Wi-Fi on the Network screen, and select the intended
SSD on the Storage screen. After the first
reboot, keep Wi-Fi and power connected while first-boot provisioning downloads
OpenSSH, the recommended Ubuntu NVIDIA driver, Node.js, and application
dependencies. It retries automatically after transient network failures and may
reboot once for the NVIDIA driver.

The finished appliance is reached at:

```text
http://pixel-brightness-01.local:3000
ssh pixeladmin@pixel-brightness-01.local
```

When the dedicated private key exists beside its `.pub` file, the builder also
creates a no-password client profile outside the repository. Connect from this
Mac with:

```bash
ssh -F outputs/installer/private/ssh_config pixel-brightness
```

The recovery password is not needed during a normal installation. Use it only
at the physical Ubuntu console if the Wi-Fi connection does not survive the
first reboot; reconnect Wi-Fi there and provisioning will retry automatically.

If Wi-Fi was skipped or changed, connect it from the Ubuntu login screen; the
provisioning service retries automatically. Wi-Fi or router client isolation can block `.local` discovery and SSH even when
the installation succeeded. Secure Boot firmware policy and unsupported Wi-Fi
chipsets remain hardware checks that no custom ISO can bypass safely.

If GRUB appears but the display becomes black only after the kernel starts,
choose `Ubuntu (safe graphics)` from the GRUB menu. An `invalid magic number`
message is different: rewrite the `.img` in raw/DD mode and replace the USB if
it repeats.
