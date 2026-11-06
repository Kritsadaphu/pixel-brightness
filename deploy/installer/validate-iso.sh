#!/usr/bin/env bash
set -Eeuo pipefail

iso=""
base_iso=""
xorriso_bin="${XORRISO:-}"

usage() {
  printf 'Usage: %s --iso FILE --base-iso FILE [--xorriso PATH]\n' "$0"
}

die() {
  printf 'pixel-brightness-iso-validate: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iso) iso="${2:-}"; shift ;;
    --base-iso) base_iso="${2:-}"; shift ;;
    --xorriso) xorriso_bin="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[[ -f "$iso" && ! -L "$iso" ]] || die "custom ISO is not a regular file"
[[ -f "$base_iso" ]] || die "base ISO is missing"
if [[ -z "$xorriso_bin" ]]; then xorriso_bin="$(command -v xorriso || true)"; fi
[[ -x "$xorriso_bin" ]] || die "xorriso is unavailable"

work="$(mktemp -d "${TMPDIR:-/tmp}/pixel-brightness-iso-validate.XXXXXXXX")"
cleanup() {
  case "$work" in
    "${TMPDIR:-/tmp}"/pixel-brightness-iso-validate.*) rm -rf -- "$work" ;;
  esac
}
trap cleanup EXIT

"$xorriso_bin" -indev "$base_iso" -report_el_torito plain -end > "$work/base-eltorito.txt" 2>&1
"$xorriso_bin" -indev "$iso" -report_el_torito plain -end > "$work/custom-eltorito.txt" 2>&1
"$xorriso_bin" -indev "$base_iso" -report_system_area plain -end > "$work/base-system-area.txt" 2>&1
"$xorriso_bin" -indev "$iso" -report_system_area plain -end > "$work/custom-system-area.txt" 2>&1
"$xorriso_bin" -indev "$iso" -toc -end > "$work/custom-toc.txt" 2>&1
grep -Eq '^ISO session[[:space:]]*:[[:space:]]*1[[:space:]]*,[[:space:]]*0[[:space:]]*,' "$work/custom-toc.txt" \
  || die "raw image must contain exactly one ISO session beginning at LBA 0"
grep -Eq 'El Torito boot img.*BIOS.*y' "$work/custom-eltorito.txt" || die "BIOS boot entry is missing"
grep -Eq 'El Torito boot img.*UEFI.*y' "$work/custom-eltorito.txt" || die "UEFI boot entry is missing"
grep -q 'grub2-mbr' "$work/custom-eltorito.txt" || die "hybrid GRUB MBR metadata is missing"
grep -q 'GPT' "$work/custom-eltorito.txt" || die "GPT metadata is missing"
grep -q 'MBR protective-msdos-label grub2-mbr' "$work/custom-system-area.txt" \
  || die "protective MBR metadata is missing"
grep -q 'GPT partname local :.*Appended2' "$work/custom-system-area.txt" \
  || die "appended EFI partition is missing"

custom_bytes="$(wc -c < "$iso" | tr -d ' ')"
gpt_last_lba="$(sed -n 's/^GPT lba range[[:space:]]*:[[:space:]]*[0-9][0-9]*[[:space:]]*[0-9][0-9]*[[:space:]]*\([0-9][0-9]*\)$/\1/p' "$work/custom-system-area.txt" | head -n1)"
[[ "$gpt_last_lba" =~ ^[0-9]+$ ]] || die "could not read the backup GPT location"
[[ $(( (gpt_last_lba + 1) * 512 )) -eq $custom_bytes ]] \
  || die "backup GPT is not located at the physical end of the image"

base_efi_start="$(sed -n 's/^GPT start and size[[:space:]]*:[[:space:]]*2[[:space:]]*\([0-9][0-9]*\)[[:space:]]*[0-9][0-9]*$/\1/p' "$work/base-system-area.txt" | head -n1)"
base_efi_size="$(sed -n 's/^GPT start and size[[:space:]]*:[[:space:]]*2[[:space:]]*[0-9][0-9]*[[:space:]]*\([0-9][0-9]*\)$/\1/p' "$work/base-system-area.txt" | head -n1)"
custom_efi_start="$(sed -n 's/^GPT start and size[[:space:]]*:[[:space:]]*2[[:space:]]*\([0-9][0-9]*\)[[:space:]]*[0-9][0-9]*$/\1/p' "$work/custom-system-area.txt" | head -n1)"
custom_efi_size="$(sed -n 's/^GPT start and size[[:space:]]*:[[:space:]]*2[[:space:]]*[0-9][0-9]*[[:space:]]*\([0-9][0-9]*\)$/\1/p' "$work/custom-system-area.txt" | head -n1)"
[[ "$base_efi_start" =~ ^[0-9]+$ && "$base_efi_size" =~ ^[0-9]+$ \
  && "$custom_efi_start" =~ ^[0-9]+$ && "$custom_efi_size" =~ ^[0-9]+$ \
  && "$base_efi_size" -eq "$custom_efi_size" ]] \
  || die "could not locate matching EFI system partitions"
dd if="$base_iso" of="$work/base-efi.img" bs=512 skip="$base_efi_start" count="$base_efi_size" 2>/dev/null
dd if="$iso" of="$work/custom-efi.img" bs=512 skip="$custom_efi_start" count="$custom_efi_size" 2>/dev/null
cmp -s "$work/base-efi.img" "$work/custom-efi.img" \
  || die "EFI system partition differs from the signed Ubuntu source"

for expected in \
  '/autoinstall.yaml' \
  '/PIXEL-BRIGHTNESS-README.txt' \
  '/pixel-brightness/MANIFEST.sha256' \
  '/pixel-brightness/pixel-brightness-firstboot.sh' \
  '/pixel-brightness/pixel-brightness-firstboot.service' \
  '/pixel-brightness/pixel-brightness-source.tar.gz' \
  '/pixel-brightness/pixel-brightness-admin.pub' \
  '/pixel-brightness/00-pixel-brightness-sshd.conf'; do
  "$xorriso_bin" -indev "$iso" -lsdl "$expected" -end 2>&1 | grep -Fq "$expected" \
    || die "required ISO file is missing: $expected"
done

"$xorriso_bin" -osirrox on -indev "$iso" -extract /autoinstall.yaml "$work/autoinstall.yaml" -end >/dev/null 2>&1
"$xorriso_bin" -osirrox on -indev "$iso" -extract /PIXEL-BRIGHTNESS-README.txt "$work/PIXEL-BRIGHTNESS-README.txt" -end >/dev/null 2>&1
"$xorriso_bin" -osirrox on -indev "$iso" -extract /pixel-brightness "$work/pixel-brightness" -end >/dev/null 2>&1
for boot_file in casper/vmlinuz casper/initrd boot/grub/grub.cfg boot/grub/loopback.cfg; do
  install -d -m 0700 "$work/base/$(dirname "$boot_file")" "$work/custom/$(dirname "$boot_file")"
  "$xorriso_bin" -osirrox on -indev "$base_iso" -extract "/$boot_file" "$work/base/$boot_file" -end >/dev/null 2>&1
  "$xorriso_bin" -osirrox on -indev "$iso" -extract "/$boot_file" "$work/custom/$boot_file" -end >/dev/null 2>&1
  cmp -s "$work/base/$boot_file" "$work/custom/$boot_file" \
    || die "boot-critical file differs from the signed Ubuntu source: /$boot_file"
done

kernel_header="$(od -An -v -j 510 -N 8 -tx1 "$work/custom/casper/vmlinuz" | tr -d '[:space:]')"
[[ "$kernel_header" == "55aaeb6a48647253" ]] \
  || die "Linux kernel header is invalid; expected 55 aa eb 6a HdrS"

ruby -ryaml -e '
  document = YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false)
  abort "autoinstall root is invalid" unless document.is_a?(Hash)
  config = document["autoinstall"]
  abort "autoinstall configuration is invalid" unless config.is_a?(Hash)
  sections = config["interactive-sections"]
  abort "manual network and storage confirmation are not enabled" unless sections == ["network", "storage"]
  abort "an automatic network policy is forbidden" if config.key?("network")
  abort "an automatic storage policy is forbidden" if config.key?("storage")
' "$work/autoinstall.yaml" || die "autoinstall YAML safety validation failed"

for forbidden in wifi-ssid.b64 wifi-password.b64; do
  [[ ! -e "$work/pixel-brightness/$forbidden" ]] \
    || die "the ISO must not contain a Wi-Fi credential file: /pixel-brightness/$forbidden"
done
(
  cd "$work"
  shasum -a 256 -c pixel-brightness/MANIFEST.sha256 >/dev/null
) || die "embedded payload manifest failed"

tar -tzf "$work/pixel-brightness/pixel-brightness-source.tar.gz" > "$work/source-files.txt"
grep -Fxq './deploy/ubuntu/install.sh' "$work/source-files.txt" \
  || die "Pixel Brightness Ubuntu installer is absent from the source payload"
grep -Fxq './runtime/server/index.mjs' "$work/source-files.txt" \
  || die "Pixel Server is absent from the source payload"
grep -Fxq './runtime/node/index.mjs' "$work/source-files.txt" \
  || die "Render Node is absent from the source payload"

printf 'Pixel Brightness ISO validation passed: BIOS, UEFI, manual network/storage, and payload hashes.\n'
