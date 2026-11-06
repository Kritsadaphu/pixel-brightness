import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

function functionBody(text, name, nextName) {
  const start = text.indexOf(`function ${name}`);
  const end = nextName ? text.indexOf(`function ${nextName}`, start + 1) : text.length;
  assert.ok(start >= 0 && end > start, `missing function ${name}`);
  return text.slice(start, end);
}

function assertOrdered(text, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, cursor + 1);
    assert.ok(next > cursor, `${label}: ${JSON.stringify(token)} is missing or out of order`);
    cursor = next;
  }
}

test("weekly worker starts the exact local show stack before powering five projectors", async () => {
  const scheduler = await source("deploy/windows/ShowSchedule.ps1");
  const startup = functionBody(scheduler, "Invoke-ScheduledStart", "Invoke-ScheduledShutdown");

  assert.match(scheduler, /# PixelBrightnessShowScheduleContract:v1/);
  assert.match(scheduler, /ValidateSet\('Worker', 'Interactive'\)/);
  assert.match(scheduler, /http:\/\/127\.0\.0\.1:4100/);
  assert.match(scheduler, /state\\server\\show-schedule\.json/);
  assert.match(scheduler, /Global\\PixelBrightnessShowScheduleWorker/);
  assert.match(scheduler, /\$script:CanonicalDays = @\('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'\)/);
  assert.match(scheduler, /DateTime\]::Now/, "weekly decisions must use Windows local time");
  assert.match(scheduler, /if \(\$ids\.Count -ne 5/);
  assert.match(scheduler, /projectorIds = @\(\$Runtime\.activeRun\.projectorIds\)/);
  assert.match(scheduler, /compositionSource\.state/);
  assert.match(scheduler, /sourceState -ceq 'connected'/);
  assert.match(scheduler, /UTF8Encoding\]::new\(\$false, \$true\)/, "Windows PowerShell must decode BOM-less UTF-8 strictly");
  assert.match(scheduler, /DateTimeOffset\]::Parse[\s\S]{0,200}DateTimeStyles\]::None/,
    "JavaScript ISO timestamps must interoperate with Windows PowerShell");
  assertOrdered(startup, [
    "Assert-ScheduleControlPlane",
    "Wait-PixelServer",
    "Test-ShowUserConsoleSession",
    "Get-EnabledProjectorBinding",
    "New-ActiveRun",
    "Start-RuntimeAction $Runtime $Schedule 'start'",
    "'show-start-requested'",
    "Wait-ShowTaskRunning",
    "'arena-start-requested'",
    "Invoke-InteractiveArena 'start'",
    "Wait-NodeAndSource",
    "action = 'power-on'",
    "expectedRevision = [int]$Runtime.activeRun.projectorConfigurationRevision",
    "projectorWarmupSeconds",
    "'/v1/projectors/refresh'",
    "Complete-RuntimeAction $Runtime $Schedule $true",
  ], "safe startup sequence");
  assert.doesNotMatch(startup, /Enter-PixelBrightnessReleaseLaunchBarrier/,
    "the worker must not retain the launch barrier while PixelBrightness-Show acquires it");
});

test("scheduled shutdown saves and gracefully closes Arena before standby or Windows shutdown", async () => {
  const scheduler = await source("deploy/windows/ShowSchedule.ps1");
  const shutdown = functionBody(scheduler, "Invoke-ScheduledShutdown", "Get-ExactArenaProcesses");
  const interactive = functionBody(scheduler, "Invoke-InteractiveRequest", "Invoke-ScheduleWorker");

  assertOrdered(shutdown, [
    "Start-RuntimeAction $Runtime $Schedule 'shutdown'",
    "'arena-save-requested'",
    "Invoke-InteractiveArena 'save-close'",
    "$Runtime.arenaProcessId = $null",
    "action = 'standby'",
    "expectedRevision = [int]$run.projectorConfigurationRevision",
    "Wait-ProjectorsStandby",
    "Stop-ShowTask",
    "System32\\shutdown.exe",
  ], "safe shutdown sequence");
  assert.doesNotMatch(shutdown, /\$Runtime\.activeRun = \$null/,
    "shutdown.exe acceptance is not proof of a completed power transition");
  assert.match(interactive, /AppActivate\(\[int\]\$process\.Id\)/);
  assert.match(interactive, /SendKeys\('\^s'\)/);
  assert.match(interactive, /Start-Sleep -Seconds 3/);
  assert.match(interactive, /CloseMainWindow\(\)/);
  assert.match(interactive, /WaitForExit\(30000\)/);
  assert.match(interactive, /Enter-PixelBrightnessReleaseLaunchBarrier/);
  assert.match(interactive, /arenaProcessStartTimeUtc/);
  assert.match(interactive, /process id was reused/);
  assert.match(interactive, /Get-ExactArenaProcesses \$executable\)\.Count -ne 0/,
    "shutdown must block while any exact Arena executable remains");
  assert.match(shutdown, /state = 'shutdown-blocked'/);
  assert.match(shutdown, /Arena launch was requested but its exact process identity is unknown/);
  assert.match(shutdown, /\/s \/t 0/);
  assert.doesNotMatch(scheduler, /Stop-Process/, "Arena must never be force-killed by the scheduler");
  assert.doesNotMatch(shutdown, /(?:^|\s)\/f(?:\s|$)/m, "Windows shutdown must not force-close applications");
});

test("shutdown checkpoints bind to one Windows boot and corrupt cleanup evidence is never overwritten", async () => {
  const scheduler = await source("deploy/windows/ShowSchedule.ps1");
  const shutdown = functionBody(scheduler, "Invoke-ScheduledShutdown", "Get-ExactArenaProcesses");
  const resolver = functionBody(scheduler, "Resolve-ShutdownRequestCheckpoint", "Wait-ProjectorsStandby");
  const priorBootRecovery = functionBody(scheduler, "Resolve-PriorBootActiveRun", "Invoke-InteractiveRequest");
  const worker = functionBody(scheduler, "Invoke-ScheduleWorker");

  assert.match(scheduler, /Win32_OperatingSystem -Property LastBootUpTime/,
    "shutdown recovery needs a stable OS boot-session identity");
  assertOrdered(shutdown, [
    "System32\\shutdown.exe",
    "$run.shutdownRequestBootId = Get-WorkerBootId",
    "'shutdown-requested'",
    "& $shutdown /s /t 0",
  ], "durable shutdown boot checkpoint");
  assert.match(resolver, /Test-SameWindowsBootId \(\[string\]\$Runtime\.activeRun\.shutdownRequestBootId\) \$currentBootId[\s\S]*Never reissue it in the same boot session/);
  assert.match(resolver, /\$Runtime\.activeRun = \$null[\s\S]*Complete-RuntimeAction \$Runtime \$Schedule \$true/,
    "a later boot must reconcile the prior request rather than shutting down again");
  assert.match(scheduler, /runBootId = Get-WorkerBootId/,
    "every active run must remain bound to the Windows boot that created it");
  assert.equal(
    [...scheduler.matchAll(/expectedRevision = \[int\]\$(?:Runtime\.activeRun|run)\.projectorConfigurationRevision/g)].length,
    4,
    "startup, shutdown and prior-boot commands must retain the pinned projector binding revision",
  );
  const standbyWait = functionBody(scheduler, "Wait-ProjectorsStandby", "Invoke-ScheduledShutdown");
  assert.match(standbyWait, /expectedRevision = \$ExpectedRevision/,
    "every standby status poll must retain the same projector binding revision");
  assert.match(priorBootRecovery, /action = 'standby'[\s\S]*Wait-ProjectorsStandby[\s\S]*Stop-ShowTask/,
    "an interrupted prior boot must retire projectors and Show safely");
  assert.doesNotMatch(priorBootRecovery, /shutdown\.exe|\/s \/t 0/,
    "prior-boot cleanup must never shut down the new Windows session");
  assertOrdered(worker, [
    "Resolve-ShutdownRequestCheckpoint $schedule $runtime",
    "Resolve-PriorBootActiveRun $schedule $runtime",
    "$runtime.lastAction.status -ceq 'running'",
  ], "boot reconciliation before interrupted-action handling");
  const corruptCatch = worker.slice(worker.indexOf("try { $runtime = Read-ShowScheduleRuntime"), worker.indexOf("if ($runtimeCorrupt)"));
  assert.doesNotMatch(corruptCatch, /Write-ShowScheduleRuntime|New-EmptyRuntime/,
    "invalid runtime must stay intact because it may hold the only safe Arena cleanup identity");
});

test("boot checkpoint decision model never replays shutdown across equivalent or later boot identities", () => {
  const instant = (value) => new Date(value).getTime();
  const decide = ({ stage, runBootId, requestBootId, currentBootId, actionStatus }) => {
    if (stage === "shutdown-requested") {
      if (!requestBootId) return "block-ambiguous";
      if (instant(requestBootId) === instant(currentBootId)) {
        return actionStatus === "failed" ? "block-rejected" : "wait-no-replay";
      }
      return "reconcile-complete-no-shutdown";
    }
    if (!runBootId) return "block-ambiguous";
    if (instant(runBootId) !== instant(currentBootId)) return "retire-prior-run-no-shutdown";
    return "continue-current-run";
  };

  const bootZ = "2026-09-04T01:02:03.0000000Z";
  const sameInstantOffset = "2026-09-04T08:02:03+07:00";
  const nextBoot = "2026-09-05T01:02:03Z";
  assert.equal(decide({
    stage: "shutdown-requested", requestBootId: bootZ, currentBootId: sameInstantOffset, actionStatus: "running",
  }), "wait-no-replay", "equivalent ISO offsets are the same boot");
  assert.equal(decide({
    stage: "shutdown-requested", requestBootId: bootZ, currentBootId: bootZ, actionStatus: "failed",
  }), "block-rejected");
  assert.equal(decide({
    stage: "shutdown-requested", requestBootId: bootZ, currentBootId: nextBoot, actionStatus: "running",
  }), "reconcile-complete-no-shutdown");
  assert.equal(decide({ stage: "ready", runBootId: null, currentBootId: bootZ }), "block-ambiguous");
  assert.equal(decide({ stage: "ready", runBootId: bootZ, currentBootId: nextBoot }), "retire-prior-run-no-shutdown");
});

test("weekly tasks are installed with split SYSTEM and local interactive authority", async () => {
  const [installer, setup, transaction, security] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/RuntimeSecurity.ps1"),
  ]);

  assert.match(setup, /deploy\\windows\\ShowSchedule\.ps1/);
  assert.match(installer, /Source = 'ShowSchedule\.ps1'; Destination = \$installedShowSchedule/);
  assert.match(installer, /state\\schedule'; Access = 'Modify'/);
  assert.match(installer, /\$installSchedule = \$Role -eq 'All'/);
  assert.match(installer, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(installer, /PixelBrightness-Schedule' -Action \$scheduleAction[\s\S]{0,200}-Principal \$schedulePrincipal/);
  assert.match(installer, /schedulePrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest/);
  assert.match(installer, /PixelBrightness-Schedule-Interactive' -Action \$interactiveAction -Settings \$interactiveSettings -Principal \$interactivePrincipal/);
  assert.match(installer, /interactivePrincipal = New-ScheduledTaskPrincipal -UserId \$ShowUser -LogonType Interactive -RunLevel Limited/);
  assert.match(installer, /interactiveSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit \(New-TimeSpan -Minutes 5\)/);
  assert.doesNotMatch(installer, /PixelBrightness-Schedule-Interactive[^\n]+-Trigger/);
  assert.match(installer, /Enable-ScheduledTask -TaskName 'PixelBrightness-Schedule'/);
  assert.match(installer, /Enable-ScheduledTask -TaskName 'PixelBrightness-Schedule-Interactive'/);
  const commit = installer.indexOf("Write-PixelBrightnessUpgradeCommit");
  const enable = installer.indexOf("Enable-ScheduledTask -TaskName 'PixelBrightness-Schedule'", commit);
  const clear = installer.indexOf("Remove-PixelBrightnessUpgradeGate", enable);
  const finalHealth = installer.indexOf("$null = Assert-PostInstallHealth", clear);
  const start = installer.indexOf("Start-ScheduledTask -TaskName 'PixelBrightness-Schedule'", finalHealth);
  assert.ok(commit < enable && enable < clear && clear < finalHealth && finalHealth < start);

  for (const task of ["PixelBrightness-Schedule", "PixelBrightness-Schedule-Interactive"]) {
    assert.match(transaction, new RegExp(task));
  }
  assert.match(transaction, /'ShowSchedule\.ps1'/);
  assert.match(transaction, /ValidateSet\('Server', 'Web', 'Show', 'Schedule'\)/);
  assert.match(transaction, /weekly Show scheduler can never bypass an upgrade boot gate/);
  assert.match(transaction, /\$isSchedule[\s\S]{0,220}\$owned\.Add/);
  assert.match(security, /\$baseControlFiles \+= 'ShowSchedule\.ps1'/);
  assert.doesNotMatch(`${installer}\n${setup}`, /DefaultPassword|AutoAdminLogon|cmdkey|ConvertTo-SecureString/i);
  assert.match(installer, /if \(-not \$installSchedule\)[\s\S]{0,300}New-ScheduledTaskTrigger -AtLogOn -User \$ShowUser/);
  assert.match(installer, /Role All omits the trigger so the weekly worker is the sole automatic owner/);
  assert.match(installer, /PixelBrightness-Schedule did not remain running after installation/);
});

test("weekly decision model defers mid-window edits and preserves active-run cleanup", () => {
  const decide = ({ enabled, dayEnabled, minute, start, shutdown, revisionSavedMinute, ledger, activeRun }) => {
    if (activeRun) return minute >= activeRun.shutdown ? "shutdown-active-run" : "keep-active-run";
    if (!enabled) return "disabled";
    if (!dayEnabled) return "off-day";
    if (minute < start) return "before-start";
    if (ledger?.shutdownStatus !== "not-attempted") return "none";
    if (minute < shutdown) {
      if (ledger?.startStatus !== "not-attempted") return "none";
      return revisionSavedMinute <= start ? "start" : "deferred";
    }
    return "none";
  };

  const emptyLedger = { startStatus: "not-attempted", shutdownStatus: "not-attempted" };
  assert.equal(decide({ enabled: true, dayEnabled: false, minute: 600, start: 540, shutdown: 1200, ledger: emptyLedger }), "off-day");
  assert.equal(decide({
    enabled: true, dayEnabled: true, minute: 550, start: 540, shutdown: 1200,
    revisionSavedMinute: 500, ledger: emptyLedger,
  }), "start", "an armed revision catches up after a late boot");
  assert.equal(decide({
    enabled: true, dayEnabled: true, minute: 550, start: 540, shutdown: 1200,
    revisionSavedMinute: 545, ledger: emptyLedger,
  }), "deferred", "a mid-window save cannot launch equipment immediately");
  assert.equal(decide({
    enabled: false, dayEnabled: false, minute: 1200, start: 540, shutdown: 1100,
    revisionSavedMinute: 500, ledger: { startStatus: "failed", shutdownStatus: "not-attempted" },
    activeRun: { shutdown: 1200 },
  }), "shutdown-active-run", "a failed partial startup still receives pinned cleanup despite later disable");
  assert.equal(decide({
    enabled: true, dayEnabled: true, minute: 600, start: 540, shutdown: 1200,
    revisionSavedMinute: 500, ledger: { startStatus: "succeeded", shutdownStatus: "succeeded" },
  }), "none", "successful shutdown prevents a same-day restart");
});
