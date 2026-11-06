import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scripts = [
  "deploy/ubuntu/install.sh",
  "deploy/ubuntu/preflight.sh",
  "deploy/ubuntu/health-check.sh",
  "deploy/ubuntu/rollback.sh",
  "deploy/ubuntu/support-bundle.sh",
  "deploy/ubuntu/acceptance.sh",
  "deploy/ubuntu/pixel-brightness-hostctl",
];

test("Ubuntu deployment shell files have valid Bash syntax", () => {
  const result = spawnSync("bash", ["-n", ...scripts], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("installer dry-run is non-mutating and reaches service planning", () => {
  const result = spawnSync("bash", [
    "deploy/ubuntu/install.sh",
    "--dry-run",
    "--role",
    "all",
    "--node-id",
    "render-01",
    "--node-name",
    "RTX A400 test node",
    "--appliance",
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Plan: role=all/);
  assert.match(result.stdout, /Building release/);
  assert.match(result.stdout, /systemctl enable --now pixel-brightness-node\.service/);
  assert.match(result.stdout, /Applying dedicated-appliance no-sleep and no-blank policy/);
  assert.match(
    result.stdout,
    /systemctl mask --now sleep\.target suspend\.target hibernate\.target hybrid-sleep\.target suspend-then-hibernate\.target/,
  );
  assert.match(result.stdout, /dconf update/);
  assert.match(result.stdout, /systemctl enable --now pixel-brightness-nosleep\.service/);
  assert.match(result.stdout, /V2 installation completed/);
});

test("appliance mode disables system sleep, logind idle actions, and GNOME blanking", async () => {
  const source = await readFile("deploy/ubuntu/install.sh", "utf8");
  const policy = source.match(/configure_appliance\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(policy, "configure_appliance function is missing");

  assert.match(policy, /\[Sleep\]/);
  for (const setting of [
    "AllowSuspend=no",
    "AllowHibernation=no",
    "AllowSuspendThenHibernate=no",
    "AllowHybridSleep=no",
  ]) {
    assert.match(policy, new RegExp(`^${setting}$`, "m"));
  }

  assert.match(policy, /\[Login\]/);
  for (const setting of [
    "IdleAction=ignore",
    "HandleSuspendKey=ignore",
    "HandleHibernateKey=ignore",
    "HandleLidSwitch=ignore",
    "HandleLidSwitchExternalPower=ignore",
    "HandleLidSwitchDocked=ignore",
  ]) {
    assert.match(policy, new RegExp(`^${setting}$`, "m"));
  }

  for (const setting of [
    "idle-delay=uint32 0",
    "lock-enabled=false",
    "idle-dim=false",
    "sleep-inactive-ac-timeout=0",
    "sleep-inactive-ac-type='nothing'",
    "sleep-inactive-battery-timeout=0",
    "sleep-inactive-battery-type='nothing'",
  ]) {
    assert.match(policy, new RegExp(`^${setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  assert.match(policy, /\/org\/gnome\/desktop\/session\/idle-delay/);
  assert.match(policy, /\/org\/gnome\/desktop\/screensaver\/lock-enabled/);
  assert.match(policy, /\/org\/gnome\/settings-daemon\/plugins\/power\/idle-dim/);
  assert.match(policy, /touch \/etc\/pixel-brightness\/appliance-mode/);
  assert.match(policy, /run dconf update/);
  assert.match(policy, /systemctl kill --kill-whom=main --signal=SIGHUP systemd-logind\.service/);

  for (const target of [
    "sleep.target",
    "suspend.target",
    "hibernate.target",
    "hybrid-sleep.target",
    "suspend-then-hibernate.target",
  ]) {
    assert.match(policy, new RegExp(`^\\s*${target.replaceAll(".", "\\.")}\\s*\\\\?$`, "m"));
  }
  assert.match(policy, /run systemctl enable --now pixel-brightness-nosleep\.service/);
});

test("sleep inhibition remains opt-in outside appliance mode", () => {
  const result = spawnSync("bash", [
    "deploy/ubuntu/install.sh",
    "--dry-run",
    "--role",
    "all",
    "--node-id",
    "render-01",
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Applying dedicated-appliance no-sleep and no-blank policy/);
  assert.doesNotMatch(result.stdout, /dconf update/);
  assert.doesNotMatch(result.stdout, /systemctl mask --now .*sleep\.target/);
  assert.doesNotMatch(result.stdout, /systemctl enable --now pixel-brightness-nosleep\.service/);
});

test("no-sleep service holds a persistent systemd inhibitor", async () => {
  const unit = await readFile("deploy/systemd/pixel-brightness-nosleep.service", "utf8");
  assert.match(unit, /^ConditionPathExists=\/etc\/pixel-brightness\/appliance-mode$/m);
  assert.match(
    unit,
    /^ExecStart=\/usr\/bin\/systemd-inhibit --what=sleep:idle:handle-suspend-key:handle-hibernate-key:handle-lid-switch --who=Pixel-Brightness --why=Projection-playback-must-remain-awake --mode=block \/usr\/bin\/sleep infinity$/m,
  );
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});

test("health and acceptance make no-sleep an explicit readiness gate", async () => {
  const health = await readFile("deploy/ubuntu/health-check.sh", "utf8");
  const acceptance = await readFile("deploy/ubuntu/acceptance.sh", "utf8");
  assert.match(health, /"noSleep":%s/);
  assert.match(health, /pixel-brightness-nosleep\.service/);
  assert.match(health, /suspend-then-hibernate\.target/);
  assert.match(acceptance, /no_sleep_ready=/);
  assert.match(acceptance, /--argjson noSleepReady/);
  assert.match(acceptance, /noSleep:\$noSleepReady/);
});

test("privileged helper remains an allowlist, not a remote shell", async () => {
  const source = await readFile("deploy/ubuntu/pixel-brightness-hostctl", "utf8");
  assert.doesNotMatch(source, /\beval\b|\/bin\/(?:ba)?sh\s+-c/);
  for (const action of ["restart-node", "restart-server", "restart-web", "reboot", "shutdown"]) {
    assert.match(source, new RegExp(`\\b${action.replace("-", "\\-")}\\)`));
  }
  assert.match(source, /allowPowerActions == true/);
  assert.match(source, /invalid restart-node arguments/);
  assert.match(source, /display configuration path is not allowlisted/);
});

test("system services run immutable current release and keep data writable", async () => {
  const nodeUnit = await readFile("deploy/systemd/pixel-brightness-node.service", "utf8");
  const serverUnit = await readFile("deploy/systemd/pixel-brightness-server.service", "utf8");
  const webUnit = await readFile("deploy/systemd/pixel-brightness-web.service", "utf8");
  const noSleepUnit = await readFile("deploy/systemd/pixel-brightness-nosleep.service", "utf8");
  for (const unit of [nodeUnit, serverUnit, webUnit]) {
    assert.match(unit, /\/opt\/pixel-brightness\/current/);
    assert.match(unit, /ProtectSystem=strict/);
  }
  assert.match(noSleepUnit, /ProtectSystem=strict/);
  assert.match(nodeUnit, /SupplementaryGroups=video render/);
  assert.match(serverUnit, /^User=pixelserver$/m);
  assert.match(serverUnit, /^Group=pixelserver$/m);
  assert.doesNotMatch(serverUnit, /^User=pixelbrightness$/m);
  assert.match(nodeUnit, /ReadWritePaths=\/var\/lib\/pixel-brightness/);
});

test("installer rotates legacy shared auth and provisions role-separated credentials", async () => {
  const source = await readFile("deploy/ubuntu/install.sh", "utf8");
  assert.match(source, /PB_CONTROL_TOKEN_FILE=\$control_path/);
  assert.match(source, /PB_NODE_SIGNING_KEY_FILE=\$signing_path/);
  assert.match(source, /PIXEL_BRIGHTNESS_NODE_TOKEN=\$node_token/);
  assert.match(source, /create-node-credential\.mjs/);
  assert.match(source, /nodeIdFromNodeCredential/);
  assert.match(source, /credential is bound to \$credential_node_id, not configured node \$node_id/);
  assert.match(source, /--node-token-file is accepted only with --role node/);
  assert.match(source, /Legacy\/shared authentication detected: rotating/);
  assert.match(source, /chown root:pixelserver "\$control_path" "\$signing_path"/);
  assert.match(source, /chown root:pixelbrightness "\$node_token_path"/);
  assert.match(source, /rm -f -- "\$control_path" "\$signing_path" "\$power_server_path" \/etc\/pixel-brightness\/server\.env/);
  assert.match(source, /rm -f -- "\$node_token_path" "\$power_node_path" \/etc\/pixel-brightness\/node\.env/);
  assert.doesNotMatch(source, /^PIXEL_AUTH_TOKEN=\$auth_token$/m);
  assert.doesNotMatch(source, /^PIXEL_BRIGHTNESS_AUTH_TOKEN=\$auth_token$/m);
});

test("installer disables services outside the selected credential role", async () => {
  const source = await readFile("deploy/ubuntu/install.sh", "utf8");
  assert.match(source, /systemctl disable --now pixel-brightness-server\.service pixel-brightness-web\.service/);
  assert.match(source, /systemctl disable --now pixel-brightness-node\.service/);
});
