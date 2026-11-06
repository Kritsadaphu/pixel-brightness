import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("every installed launcher rejects the durable upgrade gate before reading a generation", async () => {
  const [launcher, transaction] = await Promise.all([
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);

  const gateDecision = launcher.indexOf("Assert-PixelBrightnessUpgradeLauncherGate");
  const controlAudit = launcher.indexOf("Assert-PixelBrightnessControlPlane");
  const pointerRead = launcher.indexOf("$currentFile = Join-Path $DataRoot 'current-release.txt'");
  assert.ok(gateDecision >= 0 && gateDecision < controlAudit && controlAudit < pointerRead);
  assert.match(transaction, /if \(-not \(Test-Path -LiteralPath \$gatePath\)\)/,
    "any gate-path object, including a corrupt directory or reparse point, must block");
  assert.match(transaction, /startup is blocked by an in-progress upgrade/);
  assert.match(transaction, /The projector Show role can never bypass an upgrade boot gate/);
  assert.match(transaction, /Publish-PixelBrightnessWriteThroughFile \$expectedPath \$consumedPath/);
  assert.match(transaction, /MOVEFILE_REPLACE_EXISTING[\s\S]*MOVEFILE_WRITE_THROUGH/);
  assert.match(transaction, /FlushFileBuffers\(\$published\)/);
  assert.match(transaction, /FileOptions\]::WriteThrough/);
  assert.match(transaction, /Flush\(\$true\)/);
  assert.match(transaction, /health bypass was already consumed/);
  assert.match(transaction, /phase -cne 'health-running'/);
  assert.match(transaction, /Upgrade health bypass arguments cannot be used without an active protected boot gate/);
  assert.match(transaction, /Assert-PixelBrightnessUpgradeHealthOwner/);
  assert.match(transaction, /Upgrade health owner PID was reused/);
  assert.match(transaction, /Upgrade health owner lease expired/);
  assert.match(launcher, /Upgrade health owner\/gate watchdog failed/);
  assert.match(launcher, /Stop-UpgradeHealthProcessTree/);
  assert.match(launcher, /Wait-UpgradeHealthPortClosed/);
  assert.match(launcher, /# PixelBrightnessUpgradeGateContract:v1/);
  assert.match(transaction, /# PixelBrightnessUpgradeGateHelperContract:v1/);
});

test("cross-session launch barrier serializes the fresh gate decision and child creation against publication drain", async () => {
  const [installer, launcher, transaction, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/README.md"),
  ]);

  const launcherEnter = launcher.indexOf("$script:PixelBrightnessLauncherBarrier = Enter-PixelBrightnessReleaseLaunchBarrier");
  const gateDecision = launcher.indexOf("$upgradeGate = Assert-PixelBrightnessUpgradeLauncherGate", launcherEnter);
  const pointerRead = launcher.indexOf("$currentFile = Join-Path $DataRoot 'current-release.txt'", gateDecision);
  const invokeStart = launcher.indexOf("function Invoke-Logged", pointerRead);
  const normalSpawn = launcher.indexOf("$child = Start-Process", invokeStart);
  const normalRelease = launcher.indexOf("Complete-PixelBrightnessLauncherBarrier", normalSpawn);
  const healthStart = launcher.indexOf("function Invoke-UpgradeHealthLogged", normalRelease);
  const healthSpawn = launcher.indexOf("$child = Start-Process", healthStart);
  const healthRelease = launcher.indexOf("Complete-PixelBrightnessLauncherBarrier", healthSpawn);
  const rendererSpawn = launcher.indexOf("$rendererProcess = Start-Process", healthRelease);
  const nodeSpawn = launcher.indexOf("$nodeProcess = Start-Process", rendererSpawn);
  const showRelease = launcher.indexOf("Complete-PixelBrightnessLauncherBarrier", nodeSpawn);
  assert.ok(launcherEnter >= 0 && launcherEnter < gateDecision && gateDecision < pointerRead);
  assert.ok(invokeStart < normalSpawn && normalSpawn < normalRelease);
  assert.ok(healthStart < healthSpawn && healthSpawn < healthRelease);
  assert.ok(rendererSpawn < nodeSpawn && nodeSpawn < showRelease);
  assert.match(launcher, /# PixelBrightnessReleaseLaunchBarrierContract:v1/);
  assert.match(launcher, /finally \{[\s\S]{0,100}Complete-PixelBrightnessLauncherBarrier[\s\S]{0,20}\}\s*$/);

  const installMutex = installer.indexOf("$installMutexHeld = $installMutex.WaitOne(0)");
  const installerBarrier = installer.indexOf("$releaseLaunchBarrier = Enter-PixelBrightnessReleaseLaunchBarrier", installMutex);
  const gatePublish = installer.indexOf("-Phase snapshot-pending", installerBarrier);
  const taskDisable = installer.indexOf("Disable-PixelBrightnessManagedTasksForUpgrade", gatePublish);
  const processDrain = installer.indexOf("Stop-PixelBrightnessRacedLaunchProcessTrees -DataRoot $DataRoot", taskDisable);
  const listenerDrain = installer.indexOf("Wait-NoPixelBrightnessServiceListeners", processDrain);
  const mutation = installer.indexOf("-Phase mutating", listenerDrain);
  const installerRelease = installer.indexOf("Exit-PixelBrightnessReleaseLaunchBarrier $releaseLaunchBarrier", mutation);
  assert.ok(installMutex >= 0 && installMutex < installerBarrier && installerBarrier < gatePublish);
  assert.ok(gatePublish < taskDisable && taskDisable < processDrain && processDrain < listenerDrain);
  assert.ok(listenerDrain < mutation && mutation < installerRelease);
  assert.match(installer, /PixelBrightnessReleaseLaunchBarrierContract:v1/);
  assert.match(installer, /PixelBrightnessReleaseLaunchBarrierHelperContract:v1/);
  assert.match(installer, /legacy_upgrade_bootstrap_required:[^\n]+launch\/publication barrier/);
  assert.match(transaction, /# PixelBrightnessReleaseLaunchBarrierHelperContract:v1/);
  assert.match(transaction, /Global\\PixelBrightnessReleaseLaunchBarrier/);
  assert.match(transaction, /S-1-5-18[\s\S]{0,180}S-1-5-32-544[\s\S]{0,180}S-1-5-4/);
  assert.match(transaction, /function Stop-PixelBrightnessRacedLaunchProcessTrees/);
  assert.match(readme, /fresh gate check[\s\S]{0,120}child-process creation/);

  class Barrier {
    #tail = Promise.resolve();
    run(action) {
      const predecessor = this.#tail;
      let release;
      this.#tail = new Promise((resolve) => { release = resolve; });
      return predecessor.then(async () => {
        try { return await action(); }
        finally { release(); }
      });
    }
  }

  const barrier = new Barrier();
  let gate = false;
  let runtimeRunning = false;
  let mutate = false;
  let resumeLauncher;
  let launcherPaused;
  const paused = new Promise((resolve) => { launcherPaused = resolve; });
  const resume = new Promise((resolve) => { resumeLauncher = resolve; });
  const staleLauncher = barrier.run(async () => {
    assert.equal(gate, false, "launcher won barrier before gate publication");
    launcherPaused();
    await resume;
    runtimeRunning = true;
  });
  await paused;
  const upgrade = barrier.run(async () => {
    gate = true;
    runtimeRunning = false;
    assert.equal(runtimeRunning, false, "pre-gate child was not drained");
    mutate = true;
  });
  await Promise.resolve();
  assert.equal(gate, false, "installer bypassed the paused launch owner");
  resumeLauncher();
  await Promise.all([staleLauncher, upgrade]);
  assert.equal(gate, true);
  assert.equal(mutate, true);
  assert.equal(runtimeRunning, false, "stale child survived into mutation");

  const barrier2 = new Barrier();
  gate = false;
  runtimeRunning = false;
  await Promise.all([
    barrier2.run(async () => { gate = true; runtimeRunning = false; }),
    barrier2.run(async () => { if (!gate) runtimeRunning = true; }),
  ]);
  assert.equal(runtimeRunning, false, "launcher queued behind publication ignored its fresh gate decision");
});

test("upgrade commit ordering keeps normal tasks disabled until candidate health is durably committed", async () => {
  const installer = await source("deploy/windows/Install-PixelBrightness.ps1");
  const gate = installer.indexOf("-Phase snapshot-pending");
  const snapshot = installer.indexOf("New-PixelBrightnessUpgradeSnapshot");
  const disable = installer.indexOf("Disable-PixelBrightnessManagedTasksForUpgrade");
  const release = installer.indexOf("Publish-PixelBrightnessWriteThroughDirectory $releasePublishSource $releaseRoot");
  const pointer = installer.indexOf("Write-Utf8Text $releasePointer $releaseRoot");
  const finalTaskAudit = installer.lastIndexOf("Assert-PixelBrightnessFinalTasksBehindGate");
  const candidateHealth = installer.indexOf("$null = Assert-PostInstallHealth @candidateHealthParameters");
  const commit = installer.indexOf("Write-PixelBrightnessUpgradeCommit");
  const enable = installer.indexOf("Enable-ScheduledTask -TaskName 'PixelBrightness-Server'", commit);
  const clear = installer.indexOf("Remove-PixelBrightnessUpgradeGate $DataRoot $transactionId", enable);
  const finalStart = installer.indexOf("Start-ScheduledTask -TaskName 'PixelBrightness-Server'", clear);

  assert.ok(gate < snapshot && snapshot < disable && disable < release && release < pointer);
  assert.ok(pointer < candidateHealth && candidateHealth < finalTaskAudit && finalTaskAudit < commit);
  assert.ok(commit < enable && enable < clear && clear < finalStart);
  assert.match(installer, /Register-ScheduledTask -TaskName \$taskName[\s\S]{0,220}Disable-ScheduledTask -TaskName \$taskName/);
  assert.match(installer, /Register-PixelBrightnessUpgradeHealthTask[\s\S]*Deliberately no trigger/);
  assert.match(installer, /Final task contains a missing, transient, or replayable launcher action/);
  assert.match(installer, /-Phase health-running -HealthBypass \$healthBypass/);
  assert.match(installer, /-Phase health-verified/);
});

test("a legacy launcher that cannot see the gate is rejected before gate publication", async () => {
  const installer = await source("deploy/windows/Install-PixelBrightness.ps1");
  const guard = installer.indexOf("Assert-GateAwareInstalledLauncherForUpgrade $DataRoot");
  const gate = installer.indexOf("Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot", guard);
  const disable = installer.indexOf("Disable-PixelBrightnessManagedTasksForUpgrade", guard);
  assert.ok(guard >= 0 && guard < gate && gate < disable);
  assert.match(installer, /\$launcherMarker -lt 0 -or \$helperMarker -lt 0/);
  assert.match(installer, /-not \$gateMatch\.Success/);
  assert.match(installer, /\$gateMatch\.Index -gt \$pointerMatch\.Index/);
  assert.match(installer, /Installed upgrade-gate helper/);
  assert.match(installer, /\$actions\.Count -ne 1/);
  assert.match(installer, /scheduled task \$taskName does not launch the audited gate-aware bootstrap/);
  assert.match(installer, /legacy_upgrade_bootstrap_required/);
});

test("power-loss simulation never boots Server, Web, or Show from a hybrid generation", () => {
  const boundaries = [
    { name: "prior stable", gate: false, controls: "old", pointer: "old", tasks: true, committed: true },
    { name: "boot gate", gate: true, controls: "old", pointer: "old", tasks: true, committed: false },
    { name: "tasks disabled", gate: true, controls: "old", pointer: "old", tasks: false, committed: false },
    { name: "first control file", gate: true, controls: "hybrid", pointer: "old", tasks: false, committed: false },
    { name: "last control file", gate: true, controls: "new", pointer: "old", tasks: false, committed: false },
    { name: "pointer", gate: true, controls: "new", pointer: "new", tasks: false, committed: false },
    { name: "task definition", gate: true, controls: "new", pointer: "new", tasks: false, committed: false },
    { name: "firewall", gate: true, controls: "new", pointer: "new", tasks: false, committed: false },
    { name: "power", gate: true, controls: "new", pointer: "new", tasks: false, committed: false },
    { name: "health token available", gate: true, controls: "new", pointer: "new", tasks: false, committed: false, healthTrigger: false },
    { name: "health token consumed", gate: true, controls: "new", pointer: "new", tasks: false, committed: false, healthTrigger: false, token: false },
    { name: "post-health commit", gate: true, controls: "new", pointer: "new", tasks: false, committed: true },
    { name: "normal tasks enabled", gate: true, controls: "new", pointer: "new", tasks: true, committed: true },
    { name: "gate cleared", gate: false, controls: "new", pointer: "new", tasks: true, committed: true },
  ];

  for (const state of boundaries) {
    const normalBootLaunch = state.tasks && !state.gate;
    const healthBootLaunch = state.healthTrigger === true && state.token !== false && state.gate;
    assert.equal(healthBootLaunch, false, `${state.name}: transient health task must have no reboot trigger`);
    if (normalBootLaunch) {
      assert.equal(state.controls, state.pointer, `${state.name}: launch selected a hybrid generation`);
      assert.equal(state.committed, true, `${state.name}: launch selected an uncommitted generation`);
    }
    if (state.gate) assert.equal(normalBootLaunch, false, `${state.name}: gate did not block a normal task`);
  }
});

test("fault hooks cover boot gate, controls, pointer, tasks, firewall, power, services, health and commit", async () => {
  const installer = await source("deploy/windows/Install-PixelBrightness.ps1");
  for (const point of [
    "after-boot-gate",
    "after-task-disable",
    "after-release-manifest",
    "after-release-payload-flush",
    "after-release-write-through-move",
    "after-release-manifest-verify",
    "after-token-control-file",
    "after-node-control-file",
    "after-runtime-control-file",
    "after-installation-control-file",
    "after-binding-control-file",
    "after-trusted-web-control-file",
    "after-release-pointer",
    "after-task-change",
    "after-firewall-change",
    "after-power-change",
    "after-service-start",
    "before-post-install-health",
    "after-post-install-health",
    "after-health-service-stop",
    "after-commit-record",
    "after-final-task-enable",
    "after-gate-clear",
  ]) assert.match(installer, new RegExp(`Invoke-InstallFaultInjection '${point}'`));
  assert.match(installer, /Invoke-InstallFaultInjection \("after-stable-control-file-\{0\}" -f \$copy\.Source\)/);
});

test("local recovery proves static snapshot restoration before clearing the gate and re-gates on activation failure", async () => {
  const [recovery, transaction] = await Promise.all([
    source("deploy/windows/Recover-PixelBrightnessUpgrade.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);
  const failClosed = recovery.indexOf("Set-PixelBrightnessUpgradeFailClosed");
  const readGate = recovery.indexOf("Read-PixelBrightnessUpgradeGate");
  const readJournal = recovery.indexOf("Read-PixelBrightnessUpgradeSnapshot");
  const restore = recovery.indexOf("Restore-PixelBrightnessUpgradeSnapshot");
  const staticProof = recovery.indexOf("-TaskDefinitionsOnly");
  const enablement = recovery.indexOf("Set-PixelBrightnessUpgradeTaskEnablement");
  const clear = recovery.indexOf("Remove-PixelBrightnessUpgradeGate");
  const taskStates = recovery.indexOf("Start-PixelBrightnessUpgradePreviouslyRunningTasks");
  assert.ok(failClosed < readGate && readGate < readJournal && readJournal < restore);
  assert.ok(restore < staticProof && staticProof < enablement && enablement < clear && clear < taskStates);
  assert.match(recovery, /Write-PixelBrightnessUpgradeGate[\s\S]{0,220}-Phase rollback/);
  assert.match(recovery, /Recovery did not prove the prior snapshot[\s\S]*every managed task is disabled/);
  assert.match(recovery, /Assert-RecoveryAdministrator/);
  assert.match(transaction, /Upgrade journal does not contain one record for every managed control file/);
  assert.match(transaction, /Upgrade gate and recovery journal transaction ids do not match/);
  assert.match(transaction, /Rollback task was not kept disabled behind the boot gate/);
});

test("the recovery and gate policy are installed as protected, snapshotted control files", async () => {
  const [installer, transaction, setup] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
  ]);
  for (const name of ["UpgradeTransaction.ps1", "Recover-PixelBrightnessUpgrade.ps1"]) {
    assert.match(transaction, new RegExp(name.replaceAll(".", "\\.")));
    assert.match(installer, new RegExp(`Source = '${name.replaceAll(".", "\\.")}'`));
    assert.match(setup, new RegExp(`deploy\\\\windows\\\\${name.replaceAll(".", "\\.")}`));
  }
  assert.match(installer, /Protect-ReadOnlyForShow \$controlFile \$ShowUser/);
  assert.match(installer, /Published upgrade helper[\s\S]*Assert-AdminProtectedItem/);
});
