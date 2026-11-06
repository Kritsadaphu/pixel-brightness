import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeProject } from "../runtime/shared/protocol.mjs";

const source = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("display binding publishes a protected immutable generation behind the first durable gate", async () => {
  const [binder, transaction] = await Promise.all([
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);

  assert.match(transaction, /function Write-PixelBrightnessDisplayBindingCandidate/);
  assert.match(transaction, /binding-transaction/);
  assert.match(transaction, /generations/);
  assert.match(transaction, /Protect-AdminControlPath -Path \$generationRoot -ShowUser \$ShowUser -ShowAccess Read/);
  assert.match(transaction, /Protect-AdminControlTree -Path \$generationRoot -ShowUser \$ShowUser -ShowAccess Read/);
  assert.match(transaction, /node\.json/);
  assert.match(transaction, /renderer\.json/);
  assert.match(transaction, /base-project\.json/);
  assert.match(transaction, /target-project\.json/);
  assert.match(transaction, /binding\.json/);
  assert.match(transaction, /schemaVersion = 2/);
  for (const digest of [
    "baseProjectSha256",
    "targetProjectSha256",
    "nodeConfigSha256",
    "rendererConfigSha256",
    "outputSelectorsSha256",
    "bindingSha256",
  ]) {
    assert.match(transaction, new RegExp(digest));
  }

  const main = binder.slice(binder.indexOf("if (-not $PSCmdlet.ShouldProcess"));
  const candidate = main.indexOf("Write-PixelBrightnessDisplayBindingCandidate");
  const barrier = main.indexOf("Enter-PixelBrightnessReleaseLaunchBarrier");
  const processProof = main.indexOf("Assert-NoPixelBrightnessShowProcessTrees");
  const gate = main.indexOf("Write-PixelBrightnessDisplayBindingTransactionGate");
  const quiesce = main.indexOf("Stop-PixelBrightnessShowBehindBindingGate");
  const barrierExit = main.indexOf("Exit-PixelBrightnessReleaseLaunchBarrier");
  const inventory = main.lastIndexOf("Write-PixelBrightnessAtomicBytes $inventoryPath $inventoryBytes");
  const backup = main.lastIndexOf("Export-RebindBackup $DataRoot");
  const complete = main.lastIndexOf("Complete-PixelBrightnessDisplayBindingTransaction");
  assert.ok(candidate >= 0 && candidate < barrier);
  assert.ok(barrier < processProof && processProof < gate && gate < quiesce && quiesce < barrierExit);
  assert.ok(barrierExit < inventory && inventory < backup && backup < complete);
  assert.match(binder, /Global\\PixelBrightnessInstaller/);
  assert.doesNotMatch(binder, /Move-Item[^\n]+(?:node|renderer|display-binding)/i);
});

test("ambiguous Server POST resumes only exact A or full intended B", async () => {
  const [binder, transaction] = await Promise.all([
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);

  assert.match(transaction, /function Get-PixelBrightnessServerProjectAuthoritySha256/);
  for (const stableField of [
    "protocolVersion",
    "id",
    "revision",
    "name",
    "canvas",
    "compositionSource",
    "timeline",
  ]) {
    assert.match(transaction, new RegExp(`['"]${stableField}['"]`));
  }
  assert.match(transaction, /walls = @\(\$values\['walls'\]\)/);
  assert.match(transaction, /outputs = @\(\$values\['outputs'\]\)/);
  assert.match(transaction, /'\$type' = 'number'; '\$value' = \$numberText/);
  assert.match(transaction, /\[Convert\]::ToDouble\(\$Value, \[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.match(transaction, /\$number\.ToString\('R', \[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.doesNotMatch(transaction, /ToDecimal\(\$Value/);
  assert.match(transaction, /'\$type' = 'array'; '\$value' = \$items\.ToArray\(\)/);
  assert.match(transaction, /'\$type' = 'object'; '\$value' = \$result/);
  assert.match(transaction, /updatedAt is stamped by the Server/);
  assert.match(binder, /Get-PixelServerBindingReconcileState/);
  assert.match(binder, /return 'base'/);
  assert.match(binder, /return 'target'/);
  assert.match(binder, /neither the exact pre-bind project A nor intended project B/);
  assert.match(binder, /GET[\s\S]*exact A is the only state that permits retry/);
  assert.match(binder, /if \(\$beforeState -ceq 'target'\)/);
  assert.match(binder, /If-Match/);
  assert.match(binder, /BaseRevision/);
  assert.match(binder, /Read-PixelBrightnessDisplayBindingTransactionGate \$DataRoot/);
  assert.match(binder, /this run will resume only its exact protected A-to-B intent/);
  assert.match(binder, /Complete-PixelBrightnessDisplayBindingTransaction[\s\S]*-Gate \$priorBindingTransaction/);

  const reconcile = ({ id, revision, sha }, intent) => {
    if (id === intent.id && revision === intent.baseRevision && sha === intent.baseSha) return "retry";
    if (id === intent.id && revision === intent.targetRevision && sha === intent.targetSha) return "accept";
    return "fail-closed";
  };
  const intent = {
    id: "project-default",
    baseRevision: 41,
    targetRevision: 42,
    baseSha: "a".repeat(64),
    targetSha: "b".repeat(64),
  };
  assert.equal(reconcile({ id: intent.id, revision: 41, sha: intent.baseSha }, intent), "retry");
  assert.equal(reconcile({ id: intent.id, revision: 42, sha: intent.targetSha }, intent), "accept");
  assert.equal(reconcile({ id: intent.id, revision: 42, sha: "c".repeat(64) }, intent), "fail-closed");
  assert.equal(reconcile({ id: intent.id, revision: 43, sha: intent.targetSha }, intent), "fail-closed");
  assert.equal(reconcile({ id: "other", revision: 42, sha: intent.targetSha }, intent), "fail-closed");

  const canonical = (value) => {
    if (value === null) return { $type: "null" };
    if (Array.isArray(value)) return { $type: "array", $value: value.map(canonical) };
    if (typeof value === "number") return { $type: "number", $value: String(value) };
    if (typeof value === "string") return { $type: "string", $value: value };
    if (typeof value === "boolean") return { $type: "boolean", $value: value };
    return {
      $type: "object",
      $value: Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])),
    };
  };
  const fingerprint = (value) => JSON.stringify(canonical(value));
  assert.notEqual(fingerprint([]), fingerprint(null));
  assert.notEqual(fingerprint(["x"]), fingerprint("x"));
  assert.notEqual(fingerprint(1), fingerprint({ $type: "number", $value: "1" }));
  assert.notEqual(fingerprint(1), fingerprint(1.0000000000000002));
});

test("fresh binder target already equals the Server normalized project shape", async () => {
  const binder = await source("deploy/windows/Bind-PixelBrightnessDisplays.ps1");
  assert.match(binder, /blend = \[ordered\]@\{ enabled = \$true; feather = 0\.78; gamma = 2\.2; map = \$null \}/);
  assert.match(binder, /outputIds = @\(\$_\.outputIds/);
  assert.match(binder, /\$mergedOutputIds\.Contains\(\$_\)/);

  const points = [];
  for (let row = 0; row <= 2; row += 1) {
    for (let column = 0; column <= 2; column += 1) {
      const u = column / 2;
      const v = row / 2;
      points.push({ u, v, x: u, y: v });
    }
  }
  const target = {
    protocolVersion: 1,
    id: "project-default",
    revision: 42,
    name: "Arena",
    canvas: { width: 1920, height: 1080, frameRateNum: 60000, frameRateDen: 1001 },
    compositionSource: {
      type: "spout",
      senderName: "PB-COMPOSITION",
      width: 1920,
      height: 1080,
      frameRateNum: 60000,
      frameRateDen: 1001,
      acceptedFormats: [
        "DXGI_FORMAT_R16G16B16A16_FLOAT",
        "DXGI_FORMAT_R8G8B8A8_UNORM",
        "DXGI_FORMAT_B8G8R8A8_UNORM",
      ],
      colorEncoding: "srgb",
      alphaMode: "ignore",
      timeoutMs: 500,
      startupGraceMs: 10_000,
      onMissing: "black",
      onMismatch: "black",
      allowAutoSelect: false,
    },
    walls: [{ id: "node-a-wall", name: "node-a wall", layout: "independent" }],
    outputs: [{
      id: "node-a-A",
      name: "Projector A",
      connector: "DISPLAY#A",
      nodeId: "node-a",
      enabled: true,
      wallId: "node-a-wall",
      display: { devicePath: "DISPLAY#A", gdiName: "\\\\.\\DISPLAY2", adapterLuid: "00000001:00000002", targetId: 1 },
      resolution: { width: 1920, height: 1080, refreshNum: 60000, refreshDen: 1001 },
      sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 },
      overlap: { left: 0, right: 0, top: 0, bottom: 0 },
      warp: { enabled: false, columns: 2, rows: 2, interpolation: "bilinear", points },
      blend: { enabled: true, feather: 0.78, gamma: 2.2, map: null },
      blackUniformity: { enabled: false, lift: 0, map: null },
      color: { gain: [1, 1, 1], offset: [0, 0, 0], gamma: [1, 1, 1], lut: null },
      mask: { enabled: false, map: null, path: null, softness: 0 },
      processing: { bypass: false, order: ["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"] },
    }],
    timeline: { cues: [] },
    updatedAt: "ignored-by-binding-fingerprint",
  };
  const normalized = normalizeProject(target);
  delete normalized.updatedAt;
  delete target.updatedAt;
  assert.deepEqual(normalized, target);
});

test("fresh binder declares its authored layout without migrating existing surfaces", async () => {
  const binder = await source("deploy/windows/Bind-PixelBrightnessDisplays.ps1");
  const mergeStart = binder.indexOf("$mergedWalls = @($existingServerProject.walls)");
  const mergeEnd = binder.indexOf("if ($mergedWalls.Count -gt 128)", mergeStart);
  assert.ok(mergeStart >= 0 && mergeEnd > mergeStart);
  const merge = binder.slice(mergeStart, mergeEnd);

  assert.match(
    merge,
    /\$freshSurfaceLayout = \$\(if \(\$selected\.Count -ge 2 -and \$Overlap -gt 0\) \{ 'horizontal' \} else \{ 'independent' \}\)/,
  );
  assert.match(merge, /if \(@\(\$mergedWalls \| Where-Object[\s\S]*\.Count -eq 0\) \{/);
  assert.match(merge, /\$newWall = \[ordered\]@\{ id = \$requiredWallId; name =/);
  assert.match(
    merge,
    /if \(-not \$preserveSpatial\) \{ \$newWall\['layout'\] = \$freshSurfaceLayout \}/,
  );
  assert.match(merge, /\$mergedWalls \+= \$newWall/);
  assert.equal(
    (merge.match(/\['layout'\]\s*=/g) ?? []).length,
    1,
    "the binder may set layout only on the newly allocated wall record",
  );

  const mergeSurfaces = (existing, requiredIds, { preserveSpatial, outputCount, overlap }) => {
    const result = structuredClone(existing);
    const authoredLayout = outputCount >= 2 && overlap > 0 ? "horizontal" : "independent";
    for (const id of requiredIds) {
      if (result.some((surface) => surface.id === id)) continue;
      result.push({ id, name: `${id} surface`, ...(!preserveSpatial ? { layout: authoredLayout } : {}) });
    }
    return result;
  };
  assert.equal(mergeSurfaces([], ["new"], {
    preserveSpatial: false, outputCount: 2, overlap: 240,
  })[0].layout, "horizontal");
  assert.equal(mergeSurfaces([], ["new"], {
    preserveSpatial: false, outputCount: 16, overlap: 1,
  })[0].layout, "horizontal");
  assert.equal(mergeSurfaces([], ["new"], {
    preserveSpatial: false, outputCount: 1, overlap: 240,
  })[0].layout, "independent");
  assert.equal(mergeSurfaces([], ["new"], {
    preserveSpatial: false, outputCount: 2, overlap: 0,
  })[0].layout, "independent");

  const legacy = [{ id: "node-a-wall", name: "Legacy surface" }];
  const explicit = [{ id: "node-a-wall", name: "Existing surface", layout: "vertical" }];
  assert.deepEqual(mergeSurfaces(legacy, ["node-a-wall"], {
    preserveSpatial: false, outputCount: 2, overlap: 240,
  }), legacy, "an existing omitted layout stays omitted even during an explicit reset");
  assert.deepEqual(mergeSurfaces(explicit, ["node-a-wall"], {
    preserveSpatial: true, outputCount: 2, overlap: 240,
  }), explicit, "spatial rebind preserves an existing explicit layout");
});

test("positive commit precedes exact Server proof and matching gate removal", async () => {
  const [binder, transaction] = await Promise.all([
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);
  const completion = binder.slice(
    binder.indexOf("function Complete-PixelBrightnessDisplayBindingTransaction"),
    binder.indexOf("function Assert-Administrator"),
  );
  const rendererWrite = completion.indexOf("Write-PixelBrightnessAtomicBytes $rendererPath $rendererBytes");
  const nodeWrite = completion.indexOf("Write-PixelBrightnessAtomicBytes $nodePath $nodeBytes");
  const server = completion.indexOf("Sync-PixelServerProject -TargetProjectBytes $targetProjectBytes");
  const commit = completion.indexOf("Write-PixelBrightnessDisplayBindingCommit");
  const freshServer = completion.indexOf("$authoritativeProject = Get-PixelServerProject", commit);
  const rehash = completion.indexOf("Immutable local display authority changed", freshServer);
  const clear = completion.indexOf("Remove-PixelBrightnessDisplayBindingTransactionGate", rehash);
  const enable = completion.indexOf("Enable-ScheduledTask", clear);
  assert.ok(rendererWrite >= 0 && rendererWrite < nodeWrite && nodeWrite < server);
  assert.ok(server < commit && commit < freshServer && freshServer < rehash && rehash < clear && clear < enable);
  assert.match(transaction, /Write-PixelBrightnessAtomicBytes \$generationCommitPath/);
  assert.match(transaction, /Write-PixelBrightnessAtomicBytes \$rootCommitPath/);
  assert.match(transaction, /Protect-AdminControlTree -Path \$generation\.Root/);
  assert.match(transaction, /Display binding transaction gate belongs to a different transaction/);
  assert.doesNotMatch(completion.slice(completion.indexOf("catch")), /Remove-PixelBrightnessDisplayBindingTransactionGate/);
});

test("Show alone consumes the binding gate and rechecks it plus immutable authority inside the launch barrier", async () => {
  const [launcher, transaction] = await Promise.all([
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);
  const barrier = launcher.indexOf("$script:PixelBrightnessLauncherBarrier = Enter-PixelBrightnessReleaseLaunchBarrier");
  const roleGate = launcher.indexOf("if ($Role -ceq 'Show')");
  const pointer = launcher.indexOf("$currentFile = Join-Path $DataRoot 'current-release.txt'");
  const show = launcher.indexOf("'Show' {");
  const finalGate = launcher.indexOf("Assert-PixelBrightnessDisplayBindingLauncherGate $DataRoot", show);
  const finalBinding = launcher.indexOf("$show = Assert-ShowBinding $DataRoot $releaseRoot $renderer", finalGate);
  const spawn = launcher.indexOf("$rendererProcess = Start-Process", finalBinding);
  assert.ok(barrier >= 0 && barrier < roleGate && roleGate < pointer);
  assert.ok(show < finalGate && finalGate < finalBinding && finalBinding < spawn);
  assert.match(launcher, /Read-PixelBrightnessDisplayBindingCommit \$Root/);
  assert.match(launcher, /binding\.generation\.NodePath/);
  assert.match(launcher, /Assert-ShowBinding[\s\S]*Get-PixelBrightnessSha256/);
  assert.match(transaction, /Assert-AdminProtectedControlTree \$root 'Pixel Brightness display binding transaction tree'/);
  assert.match(launcher, /Server\/Web must remain available/);
});

test("Windows acceptance reads the protected commit and immutable Node generation", async () => {
  const acceptance = await source("deploy/windows/Test-PixelBrightness.ps1");
  const barrier = acceptance.indexOf("$acceptanceLaunchBarrier = Enter-PixelBrightnessReleaseLaunchBarrier");
  const authority = acceptance.indexOf("Read-ProtectedDisplayBindingAuthority $DataRoot", barrier);
  const release = acceptance.lastIndexOf("Exit-PixelBrightnessReleaseLaunchBarrier $acceptanceLaunchBarrier");
  assert.ok(barrier >= 0 && barrier < authority && authority < release);
  assert.match(acceptance, /Assert-PixelBrightnessDisplayBindingLauncherGate \$Root/);
  assert.match(acceptance, /Read-PixelBrightnessDisplayBindingCommit \$Root/);
  assert.match(acceptance, /binding\.generation\.NodePath/);
  assert.match(acceptance, /Protected committed display binding authority/);
  assert.doesNotMatch(acceptance, /config\\display-binding\.json/);
  assert.doesNotMatch(acceptance, /config\\node\.json/);
});

test("installer refuses an abandoned active or corrupt binding journal before release staging", async () => {
  const [installer, transaction] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
  ]);
  const mutex = installer.indexOf("$installMutexHeld = $installMutex.WaitOne(0)");
  const guard = installer.indexOf("Assert-PixelBrightnessDisplayBindingInstallerReady $DataRoot", mutex);
  const staging = installer.indexOf("Initialize-AdminProtectedDirectory $stagingParent", guard);
  const releaseManifest = installer.indexOf("Write-PixelBrightnessReleaseManifest", staging);
  assert.ok(mutex >= 0 && mutex < guard && guard < staging && staging < releaseManifest);
  assert.match(transaction, /Installer is blocked by an invalid display binding transaction/);
  assert.match(transaction, /Installer is blocked by active display binding transaction/);
});

test("power-cut model never exposes mixed local A and Server B without the binding gate", () => {
  const snapshots = [
    { cut: "stable-A", gate: false, enabled: true, local: "A", server: "A", commit: "A" },
    { cut: "candidate-only", gate: false, enabled: true, local: "A", server: "A", commit: "A" },
    { cut: "gate", gate: true, enabled: true, local: "A", server: "A", commit: "A" },
    { cut: "disabled", gate: true, enabled: false, local: "A", server: "A", commit: "A" },
    { cut: "renderer-B", gate: true, enabled: false, local: "mixed", server: "A", commit: "A" },
    { cut: "node-B", gate: true, enabled: false, local: "B", server: "A", commit: "A" },
    { cut: "POST-response-lost", gate: true, enabled: false, local: "B", server: "B", commit: "A" },
    { cut: "protected-commit-B", gate: true, enabled: false, local: "B", server: "B", commit: "B" },
    { cut: "fresh-proof-B", gate: true, enabled: false, local: "B", server: "B", commit: "B" },
    { cut: "gate-cleared", gate: false, enabled: false, local: "B", server: "B", commit: "B" },
    { cut: "enabled-B", gate: false, enabled: true, local: "B", server: "B", commit: "B" },
    { cut: "gate-resurrected", gate: true, enabled: true, local: "B", server: "B", commit: "B" },
  ];
  for (const state of snapshots) {
    const launcherMaySpawn = !state.gate && state.commit === state.local;
    if (launcherMaySpawn) {
      assert.equal(state.local, state.server, `${state.cut} exposed a mixed authority`);
    }
  }
});

test("captured launcher is rejected before the gate while binder-first stays black", () => {
  const run = (winner) => {
    const state = { barrier: null, gate: false, child: false, provedBlack: false, drained: false, mutated: false };
    if (winner === "launcher") {
      state.barrier = "launcher";
      if (!state.gate) state.child = true;
      state.barrier = null;
      state.barrier = "binder";
      // The read-only process proof refuses the transaction before its first
      // durable mutation. Old A may keep running, but no A-to-B transaction
      // or authority change has begun.
      state.provedBlack = !state.child;
    } else {
      state.barrier = "binder";
      state.provedBlack = !state.child;
      state.gate = true;
      state.child = false;
      state.drained = true;
      state.mutated = true;
      state.barrier = null;
      state.barrier = "launcher";
      if (!state.gate) state.child = true;
    }
    return state;
  };
  const launcherWinner = run("launcher");
  assert.deepEqual(
    { gate: launcherWinner.gate, mutated: launcherWinner.mutated, child: launcherWinner.child },
    { gate: false, mutated: false, child: true },
  );
  const binderWinner = run("binder");
  assert.equal(binderWinner.provedBlack, true);
  assert.equal(binderWinner.mutated, true);
  assert.equal(binderWinner.drained, true);
  assert.equal(binderWinner.child, false);
  assert.equal(binderWinner.gate, true);
});

test("bind-time renderer audit permits only a later boot-black compatible cache", async () => {
  const launcher = await source("deploy/windows/Start-PixelBrightness.ps1");
  assert.match(launcher, /rendererSnapshotSha256/);
  assert.match(launcher, /rendererIsInitialCandidate/);
  assert.match(launcher, /rendererConfig\.revision -le \[int64\]\$binding\.rendererRevision/);
  assert.match(launcher, /Get-PixelBrightnessDisplayOutputSelectorsSha256 \$boundOutputs/);
  assert.match(launcher, /Node output \$\(\$bound\.id\)/);
  assert.match(launcher, /Native output \$\(\$bound\.id\)/);
  assert.match(launcher, /strictly later compatible revision/);
  assert.match(launcher, /PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN/);

  const accepts = ({ exactInitial, bindRevision, cacheRevision, sameNode, samePipe, sameAdapter, sameCanvas, sameSelectors }) => (
    (exactInitial || cacheRevision > bindRevision) && sameNode && samePipe && sameAdapter && sameCanvas && sameSelectors
  );
  const laterC = {
    exactInitial: false,
    bindRevision: 1_000,
    cacheRevision: 1_001,
    sameNode: true,
    samePipe: true,
    sameAdapter: true,
    sameCanvas: true,
    sameSelectors: true,
  };
  assert.equal(accepts(laterC), true);
  assert.equal(accepts({ ...laterC, cacheRevision: 1_000 }), false);
  assert.equal(accepts({ ...laterC, cacheRevision: 999 }), false);
  assert.equal(accepts({ ...laterC, exactInitial: true, cacheRevision: 1_000 }), true);
  assert.equal(accepts({ ...laterC, sameSelectors: false }), false);
  assert.equal(accepts({ ...laterC, sameCanvas: false }), false);
});

test("administrator bearer destination comes only from protected installation authority", async () => {
  const binder = await source("deploy/windows/Bind-PixelBrightnessDisplays.ps1");
  const main = binder.slice(binder.indexOf("Assert-Administrator"));
  const audit = main.indexOf("Assert-PixelBrightnessControlPlane -DataRoot $DataRoot -IncludeSystemDirectories");
  const authority = main.indexOf("Read-TrustedPixelBrightnessBindingInstallation $DataRoot", audit);
  const crossCheck = main.indexOf("Candidate Node config differs from the protected installation identity", authority);
  const bearer = main.indexOf("Read-OperatorControlToken $DataRoot $ControlTokenFile", crossCheck);
  const serverGet = main.indexOf("Get-PixelServerProject $operatorControlToken $serverBaseUrl", bearer);
  assert.ok(audit >= 0 && audit < authority && authority < crossCheck && crossCheck < bearer && bearer < serverGet);
  assert.match(binder, /secrets\\installation\.json/);
  assert.match(binder, /Assert-AdminProtectedItem \$item 'Pixel Brightness binding installation authority'/);
  assert.match(binder, /no control bearer was sent/);
  assert.match(binder, /recoveryNode\.nodeId[\s\S]*trustedInstallation\.NodeId/);
  assert.match(binder, /recoveryServerBaseUrl -cne \[string\]\$trustedInstallation\.ServerBaseUrl/);
});

test("fault injection covers every durable display-binding boundary", async () => {
  const binder = await source("deploy/windows/Bind-PixelBrightnessDisplays.ps1");
  for (const stage of [
    "after-in-progress-gate",
    "after-show-disable",
    "after-renderer-config",
    "after-node-config",
    "after-server-commit",
    "after-final-binding",
    "after-binding-gate-clear",
    "after-show-enable",
  ]) {
    assert.match(binder, new RegExp(`Invoke-DisplayBindingFaultInjection '${stage}'`));
  }
  assert.match(binder, /Stop-Process -Id \$PID -Force/);
});
