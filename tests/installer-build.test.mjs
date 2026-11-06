import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const builderPath = "deploy/installer/build-macos.sh";
const validatorPath = "deploy/installer/validate-iso.sh";
const firstbootPath = "deploy/installer/templates/pixel-brightness-firstboot.sh";
const firstbootServicePath = "deploy/installer/templates/pixel-brightness-firstboot.service";
const sshdTemplatePath = "deploy/installer/templates/00-pixel-brightness-sshd.conf";
const rufusInstructionsPath = "outputs/installer/release/RUFUS-BOOT-INSTRUCTIONS.txt";
const ubuntuIsoSha256 = "3a4c9877b483ab46d7c3fbe165a0db275e1ae3cfe56a5657e5a47c2f99a99d1e";

test("installer shell scripts have valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", builderPath, validatorPath, firstbootPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("macOS builder publishes a raw image file and never invokes disk tools", async () => {
  const builder = await readFile(builderPath, "utf8");
  const diskToolInvocation = /(?:^|[;&|]\s*)(?:sudo\s+)?(?:command\s+)?(?:dd|diskutil)(?=\s|$)/m;
  assert.doesNotMatch(builder, diskToolInvocation);
  assert.doesNotMatch(builder, /\bof=\/dev\//);
  assert.doesNotMatch(builder, /(?:>|\btee\s+)\s*\/dev\/(?!null\b)/);
  assert.match(builder, /-outdev "\$build_image"/);
  assert.doesNotMatch(builder, /-outdev "\$output_image"/);
  assert.match(
    builder,
    /^output_image="\$OUTPUT_ROOT\/release\/Pixel-Brightness-Ubuntu-\$\{UBUNTU_VERSION\}-R3-RUFUS-DD-ONLY-amd64\.img"$/m,
  );
  assert.match(builder, /\[\[ "\$output_image" == \*\.img \]\]/);
});

test("macOS builder writes one Rufus-compatible hybrid session from LBA 0", async () => {
  const builder = await readFile(builderPath, "utf8");
  const command = builder.match(
    /"\$xorriso_bin" \\\n([\s\S]*?)\n {2}-end\nchmod 0600 "\$build_image"/,
  )?.[1];
  assert.ok(command, "xorriso build command is missing");

  const expectedOrder = [
    "-return_with SORRY 32",
    "-grow_blindly off",
    '-indev "$base_iso"',
    "-assess_indev_features replay",
    "-compliance no_emul_toc",
    '-outdev "$build_image"',
    "-overwrite nondir",
    '-map "$stage/autoinstall.yaml" /autoinstall.yaml',
    "-padding 0",
    "-boot_image any replay",
    "-commit",
  ];

  let previous = -1;
  for (const option of expectedOrder) {
    const position = command.indexOf(option);
    assert.ok(position >= 0, `required xorriso option is missing: ${option}`);
    assert.ok(position > previous, `xorriso option is out of order: ${option}`);
    previous = position;
  }

  assert.doesNotMatch(command, /-overwrite off/);
});

test("builder pins the approved Ubuntu 24.04.4 image and exact SHA-256", async () => {
  const builder = await readFile(builderPath, "utf8");
  assert.match(builder, /^readonly UBUNTU_VERSION="24\.04\.4"$/m);
  assert.match(
    builder,
    new RegExp(`^readonly UBUNTU_ISO_SHA256="${ubuntuIsoSha256}"$`, "m"),
  );
  assert.match(builder, /\[\[ "\$actual_base_sha" == "\$UBUNTU_ISO_SHA256" \]\]/);
});

async function assertUnsafeOutputRejected(outputPath) {
  const fixture = await mkdtemp(join(tmpdir(), "pixel-brightness-installer-test."));
  try {
    const binDir = join(fixture, "bin");
    const fakeUname = join(binDir, "uname");
    const publicKeyFile = join(fixture, "admin.pub");
    const baseIso = join(fixture, "base.iso");
    await mkdir(binDir);
    await writeFile(
      fakeUname,
      "#!/bin/sh\ncase \"${1:-}\" in -s) printf 'Darwin\\n' ;; -m) printf 'arm64\\n' ;; *) printf 'Darwin\\n' ;; esac\n",
      { mode: 0o700 },
    );
    await chmod(fakeUname, 0o700);
    await writeFile(publicKeyFile, "ssh-ed25519 fixture-only-key\n", { mode: 0o600 });
    await writeFile(baseIso, "not-an-iso");

    const result = spawnSync("bash", [
      builderPath,
      "--ssh-public-key",
      publicKeyFile,
      "--base-iso",
      baseIso,
      "--output",
      outputPath,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /output must be a regular project file, never a disk or mounted volume/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("builder rejects block-device and mounted-volume output paths before building", async () => {
  await assertUnsafeOutputRejected("/dev/pixel-brightness-test.img");
  await assertUnsafeOutputRejected("/Volumes/pixel-brightness-test.img");
});

test("builder rejects an ISO filename so Rufus cannot use file-transposition mode", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pixel-brightness-installer-extension."));
  try {
    const binDir = join(fixture, "bin");
    const fakeUname = join(binDir, "uname");
    const publicKeyFile = join(fixture, "admin.pub");
    const baseIso = join(fixture, "base.iso");
    await mkdir(binDir);
    await writeFile(
      fakeUname,
      "#!/bin/sh\ncase \"${1:-}\" in -s) printf 'Darwin\\n' ;; -m) printf 'arm64\\n' ;; *) printf 'Darwin\\n' ;; esac\n",
      { mode: 0o700 },
    );
    await chmod(fakeUname, 0o700);
    await writeFile(publicKeyFile, "ssh-ed25519 fixture-only-key\n", { mode: 0o600 });
    await writeFile(baseIso, "not-an-iso");

    const result = spawnSync("bash", [
      builderPath,
      "--ssh-public-key",
      publicKeyFile,
      "--base-iso",
      baseIso,
      "--output",
      join(fixture, "pixel-brightness-test.iso"),
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /output must end in \.img/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("builder rejects an output whose parent resolves into /Volumes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pixel-brightness-installer-resolved-path."));
  try {
    const binDir = join(fixture, "bin");
    const fakeUname = join(binDir, "uname");
    const publicKeyFile = join(fixture, "admin.pub");
    const baseIso = join(fixture, "base.iso");
    const mountedVolumeAlias = join(fixture, "mounted-volume-alias");
    await mkdir(binDir);
    await writeFile(
      fakeUname,
      "#!/bin/sh\ncase \"${1:-}\" in -s) printf 'Darwin\\n' ;; -m) printf 'arm64\\n' ;; *) printf 'Darwin\\n' ;; esac\n",
      { mode: 0o700 },
    );
    await chmod(fakeUname, 0o700);
    await writeFile(publicKeyFile, "ssh-ed25519 fixture-only-key\n", { mode: 0o600 });
    await writeFile(baseIso, "not-an-iso");
    await symlink("/Volumes", mountedVolumeAlias, "dir");

    const result = spawnSync("bash", [
      builderPath,
      "--ssh-public-key",
      publicKeyFile,
      "--base-iso",
      baseIso,
      "--output",
      join(mountedVolumeAlias, "pixel-brightness-test.img"),
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /resolved output must never be a device or mounted volume/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function runSshKeyGuardFixture(publicKey) {
  const fixture = await mkdtemp(join(tmpdir(), "pixel-brightness-installer-ssh-key."));
  try {
    const binDir = join(fixture, "bin");
    const fakeUname = join(binDir, "uname");
    const fakeShasum = join(binDir, "shasum");
    const fakeXorriso = join(binDir, "xorriso");
    const publicKeyFile = join(fixture, "admin.pub");
    const baseIso = join(fixture, "base.iso");
    const outputImage = join(fixture, "output.img");
    await mkdir(binDir);
    await writeFile(
      fakeUname,
      "#!/bin/sh\ncase \"${1:-}\" in -s) printf 'Darwin\\n' ;; -m) printf 'arm64\\n' ;; *) printf 'Darwin\\n' ;; esac\n",
      { mode: 0o700 },
    );
    await writeFile(
      fakeShasum,
      `#!/bin/sh\nlast=''\nfor argument do last="$argument"; done\nprintf '${ubuntuIsoSha256}  %s\\n' "$last"\n`,
      { mode: 0o700 },
    );
    await writeFile(fakeXorriso, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(fakeUname, 0o700);
    await chmod(fakeShasum, 0o700);
    await chmod(fakeXorriso, 0o700);
    await writeFile(publicKeyFile, publicKey, { mode: 0o600 });
    await writeFile(baseIso, "fixture-base-iso");

    return spawnSync("bash", [
      builderPath,
      "--ssh-public-key",
      publicKeyFile,
      "--base-iso",
      baseIso,
      "--output",
      outputImage,
      "--xorriso",
      fakeXorriso,
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test("builder requires no Wi-Fi credential inputs and stages none", async () => {
  const builder = await readFile(builderPath, "utf8");
  assert.doesNotMatch(builder, /--ssid/);
  assert.doesNotMatch(builder, /--wifi-password-file/);
  assert.doesNotMatch(builder, /\bwifi_ssid\b/);
  assert.doesNotMatch(builder, /\bwifi_password(?:_file)?\b/);
  assert.doesNotMatch(builder, /wifi-ssid\.b64/);
  assert.doesNotMatch(builder, /wifi-password\.b64/);
  assert.match(builder, /--exclude outputs/);
});

test("builder validates the SSH public key with ssh-keygen", async () => {
  const result = await runSshKeyGuardFixture("ssh-ed25519 fixture-only-key\n");
  assert.equal(result.status, 64);
  assert.match(result.stderr, /SSH public key is malformed/);
});

test("generated autoinstall requires manual network and storage with no automatic policies", async () => {
  const builder = await readFile(builderPath, "utf8");
  const document = builder.match(/cat > "\$stage\/autoinstall\.yaml" <<EOF\n([\s\S]*?)\nEOF/)?.[1];
  assert.ok(document, "autoinstall document is missing");
  assert.match(document, /^autoinstall:$/m);
  assert.match(document, /^ {2}interactive-sections:\n {4}- network\n {4}- storage$/m);
  assert.doesNotMatch(document, /^ {2}network:/m);
  assert.doesNotMatch(document, /^ {2}storage:/m);

  const parsed = spawnSync("ruby", ["-ryaml", "-e", [
    "document = YAML.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false)",
    "abort 'invalid root' unless document.is_a?(Hash)",
    "config = document['autoinstall']",
    "abort 'invalid config' unless config.is_a?(Hash)",
    "abort 'missing manual network or storage' unless config['interactive-sections'] == ['network', 'storage']",
    "abort 'automatic network forbidden' if config.key?('network')",
    "abort 'automatic storage forbidden' if config.key?('storage')",
  ].join("; ")], { input: document, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test("first boot looks up the same source archive path written into the manifest", async () => {
  const [builder, firstboot] = await Promise.all([
    readFile(builderPath, "utf8"),
    readFile(firstbootPath, "utf8"),
  ]);
  const manifestArchivePath = "pixel-brightness/pixel-brightness-source.tar.gz";
  assert.match(builder, /find pixel-brightness -type f/);
  assert.match(builder, /"\$stage\/pixel-brightness\/pixel-brightness-source\.tar\.gz"/);
  assert.match(firstboot, new RegExp(`\\$2 == "${manifestArchivePath.replaceAll(".", "\\.")}"`));
  assert.doesNotMatch(firstboot, /\$2 == "pixel-brightness-source\.tar\.gz"/);
});

test("first boot enforces appliance identity, secure access, and Wi-Fi power policy", async () => {
  const [firstboot, sshd] = await Promise.all([
    readFile(firstbootPath, "utf8"),
    readFile(sshdTemplatePath, "utf8"),
  ]);

  assert.match(firstboot, /^readonly HOSTNAME_VALUE=pixel-brightness-01$/m);
  assert.match(firstboot, /hostnamectl set-hostname "\$HOSTNAME_VALUE"/);
  assert.match(firstboot, /^wifi\.powersave=2$/m);
  assert.match(firstboot, /nm-online --quiet --timeout=60/);
  assert.doesNotMatch(firstboot, /WIFI_CONNECTION/);
  assert.doesNotMatch(firstboot, /wifi-ssid\.b64/);
  assert.doesNotMatch(firstboot, /wifi-password\.b64/);
  assert.doesNotMatch(firstboot, /wifi-sec\.(?:psk|key-mgmt)/);
  assert.doesNotMatch(firstboot, /base64 -d/);
  assert.match(firstboot, /install -o pixeladmin -g pixeladmin -m 0600[\s\S]*\/home\/pixeladmin\/\.ssh\/authorized_keys/);
  assert.doesNotMatch(firstboot, /^passwd -l pixeladmin/m);
  assert.match(firstboot, /^pixeladmin ALL=\(ALL:ALL\) NOPASSWD:ALL$/m);
  assert.match(firstboot, /\/deploy\/ubuntu\/install\.sh[\s\S]*?--role all[\s\S]*?--appliance/);
  assert.match(firstboot, /\/deploy\/ubuntu\/health-check\.sh --json/);
  assert.doesNotMatch(firstboot, /PIXEL_AUTH_TOKEN|PIXEL_BRIGHTNESS_AUTH_TOKEN|cluster_token/);

  for (const line of [
    "PubkeyAuthentication yes",
    "AuthenticationMethods publickey",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "PermitRootLogin no",
    "PermitEmptyPasswords no",
    "AllowUsers pixeladmin",
  ]) {
    assert.match(sshd, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.doesNotMatch(sshd, /^(?:PasswordAuthentication|KbdInteractiveAuthentication) yes$/m);
});

test("first boot keeps physical console recovery while SSH remains public-key-only", async () => {
  const [firstboot, sshd] = await Promise.all([
    readFile(firstbootPath, "utf8"),
    readFile(sshdTemplatePath, "utf8"),
  ]);
  assert.doesNotMatch(firstboot, /\bpasswd\s+(?:--lock|-l)\s+pixeladmin\b/);
  assert.match(sshd, /^AuthenticationMethods publickey$/m);
  assert.match(sshd, /^PasswordAuthentication no$/m);
});

test("first boot restores sshd drop-in loading before validating and reloading SSH", async () => {
  const firstboot = await readFile(firstbootPath, "utf8");
  const includeGuard = firstboot.indexOf("grep -Eq '^[[:space:]]*Include");
  const includePrepend = firstboot.indexOf("sed -i '1iInclude /etc/ssh/sshd_config.d/*.conf'");
  const sftpRepair = firstboot.indexOf("Subsystem sftp internal-sftp");
  const dropInInstall = firstboot.indexOf("/etc/ssh/sshd_config.d/00-pixel-brightness.conf");
  const validation = firstboot.indexOf("/usr/sbin/sshd -t");
  const activation = firstboot.indexOf("systemctl enable --now ssh.service");
  const reload = firstboot.indexOf("systemctl reload ssh.service");

  assert.ok(includeGuard >= 0, "sshd Include guard is missing");
  assert.ok(includePrepend > includeGuard, "missing Include must be prepended safely");
  assert.ok(sftpRepair > includePrepend, "missing SFTP subsystem must be restored after Include");
  assert.ok(dropInInstall > sftpRepair, "drop-in must be installed after SSH defaults are restored");
  assert.ok(validation > dropInInstall, "sshd configuration must be validated after drop-in install");
  assert.ok(activation > validation, "SSH must only start after sshd -t succeeds");
  assert.ok(reload > validation, "SSH must only reload after sshd -t succeeds");
});

test("first boot repairs archived Ubuntu script modes before executing install.sh", async () => {
  const firstboot = await readFile(firstbootPath, "utf8");
  const extraction = firstboot.indexOf('tar -xzf "$BOOTSTRAP_DIR/pixel-brightness-source.tar.gz"');
  const modeRepair = firstboot.indexOf("chmod 0755 /opt/pixel-brightness-source/deploy/ubuntu/*.sh");
  const installerExecution = firstboot.indexOf("/opt/pixel-brightness-source/deploy/ubuntu/install.sh \\");

  assert.ok(extraction >= 0, "source extraction is missing");
  assert.ok(modeRepair > extraction, "script modes must be repaired after extraction");
  assert.ok(installerExecution > modeRepair, "install.sh must only execute after mode repair");
});

test("desktop first-boot ordering cannot cycle through cloud-final and multi-user", async () => {
  const service = await readFile(firstbootServicePath, "utf8");
  assert.match(service, /^After=.*\bcloud-final\.service\b/m);
  assert.match(service, /^WantedBy=graphical\.target$/m);
  assert.doesNotMatch(service, /^WantedBy=multi-user\.target$/m);
  assert.doesNotMatch(service, /^After=.*\bgraphical\.target\b/m);
});

test("first-boot service retries transient provisioning failures", async () => {
  const service = await readFile(firstbootServicePath, "utf8");
  assert.match(service, /^StartLimitIntervalSec=0$/m);
  assert.match(service, /^Restart=on-failure$/m);
  assert.match(service, /^RestartSec=30$/m);
  assert.match(service, /^TimeoutStartSec=infinity$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/systemd-inhibit --what=sleep:idle:handle-suspend-key:handle-hibernate-key:handle-lid-switch .*\/pixel-brightness-firstboot\.sh$/m);
  assert.match(
    service,
    /^ConditionPathExists=!\/var\/lib\/pixel-brightness\/bootstrap\/complete$/m,
  );
});

test("raw-image validator requires unchanged Ubuntu boot payloads plus hybrid boot metadata", async () => {
  const validator = await readFile(validatorPath, "utf8");
  assert.match(validator, /GPT lba range/);
  assert.match(validator, /custom_bytes="\$\(wc -c < "\$iso"/);
  assert.match(validator, /\(gpt_last_lba \+ 1\) \* 512/);
  assert.match(validator, /backup GPT is not located at the physical end of the image/);
  assert.match(validator, /cmp -s "\$work\/base-efi\.img" "\$work\/custom-efi\.img"/);
  assert.match(validator, /El Torito boot img\.\*BIOS\.\*y/);
  assert.match(validator, /El Torito boot img\.\*UEFI\.\*y/);
  assert.match(validator, /grep -q 'grub2-mbr'/);
  assert.match(validator, /grep -q 'GPT'/);
  assert.match(
    validator,
    /for boot_file in casper\/vmlinuz casper\/initrd boot\/grub\/grub\.cfg boot\/grub\/loopback\.cfg; do/,
  );
  assert.match(validator, /-indev "\$base_iso"[\s\S]*?-extract "\/\$boot_file"/);
  assert.match(validator, /-indev "\$iso"[\s\S]*?-extract "\/\$boot_file"/);
  assert.match(validator, /cmp -s "\$work\/base\/\$boot_file" "\$work\/custom\/\$boot_file"/);
  assert.match(validator, /od [^\n]*-j 510 [^\n]*-N 8 [^\n]*-tx1/);
  assert.match(validator, /55aaeb6a48647253/);
  assert.match(validator, /'\/pixel-brightness\/MANIFEST\.sha256'/);
  assert.match(validator, /'\/pixel-brightness\/pixel-brightness-admin\.pub'/);
  assert.match(validator, /'\/pixel-brightness\/00-pixel-brightness-sshd\.conf'/);
  assert.match(validator, /YAML\.safe_load/);
  assert.match(validator, /sections == \["network", "storage"\]/);
  assert.match(validator, /config\.key\?\("network"\)/);
  assert.match(validator, /config\.key\?\("storage"\)/);
  assert.match(validator, /for forbidden in wifi-ssid\.b64 wifi-password\.b64; do/);
  assert.match(validator, /\[\[ ! -e "\$work\/pixel-brightness\/\$forbidden" \]\]/);
  assert.match(validator, /the ISO must not contain a Wi-Fi credential file/);
  assert.match(validator, /shasum -a 256 -c pixel-brightness\/MANIFEST\.sha256/);
  assert.match(validator, /embedded payload manifest failed/);
});

test("Rufus instructions require R3 DD mode and never direct users to ISO mode", async () => {
  const instructions = await readFile(rufusInstructionsPath, "utf8");
  assert.match(instructions, /Pixel-Brightness-Ubuntu-24\.04\.4-R3-RUFUS-DD-ONLY-amd64\.img/);
  assert.match(instructions, /DD Image mode/i);
  assert.match(instructions, /(?:DD\/raw|raw\/DD)/i);
  assert.match(instructions, /Never choose ISO Image mode/i);
  assert.doesNotMatch(instructions, /ISO Image mode.*recommended/i);
});

test("builder validates a temporary raw image before atomically publishing it", async () => {
  const builder = await readFile(builderPath, "utf8");
  const temporaryImage = builder.indexOf('build_image="$(mktemp "$(dirname -- "$output_image")/.pixel-brightness-build.XXXXXXXX")"');
  const xorrisoOutput = builder.indexOf('-outdev "$build_image"');
  const validation = builder.indexOf('--iso "$build_image"');
  const publish = builder.indexOf('mv -f -- "$build_image" "$output_image"');

  assert.ok(temporaryImage >= 0, "temporary raw image creation is missing");
  assert.ok(xorrisoOutput > temporaryImage, "xorriso must write to the temporary raw image");
  assert.ok(validation > xorrisoOutput, "temporary raw image must be validated after it is built");
  assert.ok(publish > validation, "final raw image must be published only after validation");
  assert.doesNotMatch(builder, /rm -f -- "\$output_image"/);
});
