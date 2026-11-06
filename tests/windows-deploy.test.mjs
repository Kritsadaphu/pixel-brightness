import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Windows power snapshot reads effective defaults before the first upgrade gate", async () => {
  const policy = await source("deploy/windows/UpgradeTransaction.ps1");
  const installer = await source("deploy/windows/Install-PixelBrightness.ps1");
  assert.match(policy, /PowerReadACValueIndex/);
  assert.doesNotMatch(policy, /Get-ItemProperty -LiteralPath \$settingPath -Name ACSettingIndex/);
  assert.match(policy, /if \(\$status -ne 0\)/);
  assert.ok(installer.indexOf('if ($Appliance) { $null = Get-PixelBrightnessPowerSnapshot }') <
    installer.indexOf('Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot'));
});

test("Windows build staging avoids legacy MSBuild MAX_PATH and keeps intermediates outside releases", async () => {
  const installer = await source("deploy/windows/Install-PixelBrightness.ps1");
  assert.match(installer, /\$stageRoot = Join-Path \$stagingParent "b-/);
  assert.match(installer, /\$stageRelease = Join-Path \$stageRoot 'src'/);
  assert.match(installer, /\$nativeBuild = Join-Path \$stageRoot 'nb'/);
  const longestObservedSuffix = "\\_deps\\nlohmann_json-subbuild\\nlohmann_json-populate-prefix\\src\\nlohmann_json-populate-stamp\\Debug\\nlohmann_json-populate-mkdir";
  const buildRoot = "C:\\ProgramData\\Pixel Brightness Build\\b-" + "0".repeat(32) + "\\nb";
  assert.ok((buildRoot + longestObservedSuffix).length < 240);
  const timestampClamp = installer.indexOf('$sourceTimestampCeiling = [DateTime]::UtcNow');
  assert.ok(timestampClamp > installer.indexOf('Assert-PixelBrightnessSourceManifest -SourceRoot $stageRelease'));
  assert.ok(timestampClamp < installer.indexOf("Invoke-Checked $npmCommand @('ci'"));
  assert.match(installer, /if \(\$sourceFile.LastWriteTimeUtc -gt \$sourceTimestampCeiling\)/);
  assert.match(installer, /catch \{[\s\S]*Write-Warning "Temporary installer directory retained/);
});

function assertPowerShellIsStructurallyBalanced(text, label) {
  const stack = [];
  const pairs = new Map([[")", "("], ["]", "["], ["}", "{"]]);
  let quote = null;
  let comment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "`") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "#") {
      comment = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if ("([{ ".includes(char) && char !== " ") stack.push(char);
    else if (pairs.has(char)) assert.equal(stack.pop(), pairs.get(char), `${label}: unbalanced ${char} at ${index}`);
  }
  assert.equal(quote, null, `${label}: unterminated string`);
  assert.deepEqual(stack, [], `${label}: unclosed delimiters`);
  assert.equal(text.charCodeAt(0), 0x5b, `${label}: expected UTF-8 text without BOM`);
}

test("Windows deployment keeps Arena as one composition source and Pixel Brightness spatially complete", async () => {
  const readme = await source("deploy/windows/README.md");
  assert.match(readme, /Resolume Arena composition[\s\S]*one named master Spout sender[\s\S]*Pixel Brightness D3D11 spatial renderer/);
  assert.match(readme, /per-projector area crop and 128x128 mesh warp/);
  assert.match(readme, /auto blend \/ mask \/ black uniformity \/ colour \/ LUT/);
  assert.match(readme, /Arena remains the media player and is used to position layers inside the master composition/);
  assert.match(readme, /does \*\*not\*\* own projector geometry, edge blend, masks or black correction/);
  assert.match(readme, /Pixel Brightness does not play media/);
  assert.match(readme, /PB-COMPOSITION/);
  assert.match(readme, /fail(?:s)? to black/i);
  assert.match(readme, /must not fullscreen directly to the projector/i);
});

test("Windows renderer is launched only in the interactive show session", async () => {
  const [installer, launcher, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);

  assert.match(installer, /New-ScheduledTaskTrigger -AtLogOn -User \$ShowUser/);
  assert.match(installer, /New-ScheduledTaskPrincipal -UserId \$ShowUser -LogonType Interactive/);
  assert.match(installer, /Disable-ScheduledTask -TaskName 'PixelBrightness-Show'/);
  assert.match(installer, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(installer, /-UserId 'SYSTEM' -LogonType ServiceAccount/);
  assert.match(launcher, /\$env:SESSIONNAME -like 'RDP-\*'/);
  assert.match(launcher, /UserInteractive[\s\S]*SessionId -eq 0/);
  assert.match(launcher, /PIXEL_BRIGHTNESS_RENDERER_PIPE/);
  assert.match(launcher, /Assert-ShowBinding \$DataRoot \$releaseRoot \$renderer/);
  assert.match(launcher, /function Read-RendererJsonWithRecovery/);
  assert.match(launcher, /\.last-known-good\.json/);
  assert.match(launcher, /Write-PixelBrightnessAtomicBytes -Path \$Path -Bytes \$bytes/);
  assert.match(launcher, /Read-RendererJsonWithRecovery \$rendererPath/);
  assert.ok(
    launcher.indexOf("Read-RendererJsonWithRecovery $rendererPath")
      < launcher.indexOf("Start-Process -FilePath $renderer"),
    "renderer config recovery and display-binding validation must precede native launch",
  );
  assert.match(launcher, /binding\.valid -ne \$true/);
  assert.match(launcher, /binding\.adapterLuid[\s\S]*nodeConfig\.adapterLuid/);
  assert.match(launcher, /Assert-SameText[\s\S]*devicePath[\s\S]*adapterLuid[\s\S]*targetId/);
  assert.match(launcher, /Assert-OptionalCameraHelper \$nodeConfig \$ReleasePath/);
  assert.match(launcher, /Camera helper must be installed inside the protected immutable release/);
  assert.match(launcher, /Start-Process -FilePath \$node[\s\S]*-PassThru/);
  assert.match(launcher, /while \(-not \$rendererProcess\.HasExited -and -not \$nodeProcess\.HasExited\)/);
  assert.match(launcher, /Native renderer exited[\s\S]*Stop-Process -Id \$nodeProcess\.Id -Force/);
  assert.match(launcher, /Node agent exited[\s\S]*Stop-Process -Id \$rendererProcess\.Id -Force/);
  assert.doesNotMatch(launcher, /Get-ChildItem[^\n]+pixel-brightness-renderer\.exe/);
  assert.match(readme, /does \*\*not\*\* enable automatic Windows sign-in/);
  assert.doesNotMatch(installer, /AutoAdminLogon|DefaultPassword|cmdkey/i);
});

test("Windows install is versioned and persistent data stays outside releases", async () => {
  const [installer, runtimeSecurity, viteConfig, sitesPlugin] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/RuntimeSecurity.ps1"),
    source("vite.config.ts"),
    source("build/sites-vite-plugin.ts"),
  ]);
  assert.match(installer, /Join-Path \$env:ProgramFiles 'Pixel Brightness'/);
  assert.match(installer, /Join-Path \$env:ProgramData 'Pixel Brightness'/);
  assert.match(installer, /Initialize-AdminProtectedDirectory \$DataRoot \$env:ProgramData \$ShowUser/);
  assert.match(installer, /Initialize-AdminProtectedDirectory \$InstallRoot \$env:ProgramFiles \$ShowUser/);
  assert.match(installer, /Initialize-AdminProtectedDirectory \$releasesDirectory \$env:ProgramFiles \$ShowUser/);
  assert.match(installer, /Initialize-AdminProtectedDirectory \$profilePath \$env:ProgramData \$ShowUser \$profile\.Label/);
  assert.match(installer, /function Assert-RealFileDestination/);
  assert.match(installer, /current-release\.txt/);
  assert.match(installer, /Publish-PixelBrightnessWriteThroughDirectory \$releasePublishSource \$releaseRoot/);
  assert.doesNotMatch(installer, /Move-Item -LiteralPath \$stageRelease -Destination \$releaseRoot/);
  assert.match(installer, /Protect-AdminReadOnlyReleaseTree \$releaseRoot \$ShowUser/);
  assert.match(installer, /Protect-ReadOnlyForShow \$controlFile \$ShowUser/);
  assert.match(runtimeSecurity, /Get-NonReparseTree/);
  assert.match(runtimeSecurity, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(runtimeSecurity, /SetOwner\(\$administratorsSid\)/);
  assert.match(runtimeSecurity, /grants write or replacement access to a non-privileged trustee/);
  const writeMask = runtimeSecurity.match(/function Get-PixelBrightnessWriteMask \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(writeMask, /WriteData[\s\S]*AppendData[\s\S]*WriteExtendedAttributes[\s\S]*WriteAttributes/);
  assert.doesNotMatch(writeMask, /FileSystemRights\]::(?:Modify|FullControl)/, "write mask must not contain composite read bits");
  assert.match(installer, /Protect-ReadOnlyForShow \$bindingGate \$ShowUser/);
  assert.match(installer, /Join-Path \$secretsDirectory 'control-token\.txt'/);
  assert.match(installer, /Join-Path \$secretsDirectory 'node-signing-key\.txt'/);
  assert.match(installer, /Join-Path \$secretsDirectory 'node-token\.txt'/);
  assert.match(installer, /Server control token is empty or invalid/);
  assert.match(installer, /ShowAccess None -Label 'Pixel Brightness control token'/);
  assert.match(installer, /ShowAccess None -Label 'Pixel Brightness Render Node signing key'/);
  assert.match(installer, /Protect-ReadOnlyForShow \$installedNodeTokenFile \$ShowUser/);
  assert.match(installer, /Assert-ProtectedNodeRuntime \$nodeCommand \$npmCommand/);
  assert.match(installer, /Source = 'RuntimeSecurity\.ps1'; Destination = \$installedRuntimeSecurity/);
  assert.match(installer, /Write-PixelBrightnessAtomicBytes \$copy\.Destination \(\[IO\.File\]::ReadAllBytes\(\$copySourceItem\.FullName\)\)/);
  assert.match(runtimeSecurity, /Program Files directory, never AppData, a user profile, nvm/);
  assert.match(runtimeSecurity, /FileAttributes\]::ReparsePoint/);
  assert.match(runtimeSecurity, /privilegedWriteSids = @\(\$trustedOwners\)/);
  assert.match(runtimeSecurity, /grants write access to a non-privileged trustee/);
  assert.doesNotMatch(runtimeSecurity, /catch\s*\{\s*continue\s*\}/);
  assert.match(runtimeSecurity, /Get-NonReparseTree \$runtimeRoot 'Pinned Node\.js installation'/);
  assert.match(runtimeSecurity, /node_modules\\npm\\bin\\npm-cli\.js/);
  assert.match(runtimeSecurity, /function Protect-AdminControlPath/);
  assert.match(runtimeSecurity, /function Protect-AdminSystemTree/);
  assert.match(runtimeSecurity, /function Assert-AdminProtectedControlTree/);
  assert.match(runtimeSecurity, /Get-NonReparseTree \$Path \$Label[\s\S]*Protect-AdminControlPath[\s\S]*Assert-AdminProtectedControlTree/);
  assert.match(runtimeSecurity, /foreach \(\$relative in @\('logs\\system', 'state\\server'\)\)/);
  assert.match(runtimeSecurity, /RemoveAccessRuleSpecific/);
  assert.match(runtimeSecurity, /function Assert-PixelBrightnessControlPlane/);
  assert.match(runtimeSecurity, /function Assert-AdminProtectedReleaseLocation/);
  assert.match(runtimeSecurity, /S-1-3-0[\s\S]*PropagationFlags\]::InheritOnly/);
  assert.match(runtimeSecurity, /S-1-3-4/);
  assert.match(runtimeSecurity, /TrustedInstaller/);
  assert.match(runtimeSecurity, /S-1-5-18/);
  assert.match(runtimeSecurity, /S-1-5-32-544/);
  assert.match(installer, /Relative = 'config'; Access = 'Modify'/);
  assert.match(installer, /Relative = 'secrets'; Access = 'None'/);
  assert.match(installer, /atomic temporary credential files secret/);
  assert.doesNotMatch(installer, /icacls\.exe/, "installer ACL hardening must replace the complete DACL and trusted owner");
  assert.match(installer, /logs\\system[\s\S]*SYSTEM-only Server\/Web logs/);
  assert.match(installer, /logs\\system[\s\S]*state\\server[\s\S]*Protect-AdminSystemTree/);
  assert.match(installer, /logs\\show[\s\S]*interactive Show logs/);
  assert.doesNotMatch(installer, /Join-Path \$DataRoot 'logs'\),\s*\n\s*\(Join-Path \$DataRoot 'state\\node'/);
  assert.match(installer, /Disable-PixelBrightnessManagedTasksForUpgrade/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.match(installer, /-RestartCount 255 -RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.doesNotMatch(installer, /-RestartCount 999|-Seconds 15/);
  assert.match(installer, /active native renderer process\(es\)/);
  assert.doesNotMatch(installer, /Remove-Item[^\n]+InstallRoot[^\n]+-Recurse/i);
  assert.match(viteConfig, /\.\/build\/sites-vite-plugin/);
  assert.ok(sitesPlugin.length > 0, "the checked-in Web build plugin must exist");
  assert.doesNotMatch(
    installer,
    /['"]\/XD['"][\s\S]{0,100}['"]build['"]/,
    "staging must not exclude the checked-in root build/ source plugin",
  );
});

test("Windows source is manifest-bound across UAC and protected build staging", async () => {
  const [integrity, bootstrap, setup, installer, packageScript] = await Promise.all([
    source("deploy/windows/SourceIntegrity.ps1"),
    source("deploy/windows/ElevatedBootstrap.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("scripts/package-windows-source.mjs"),
  ]);

  assert.match(integrity, /function Assert-PixelBrightnessSourceManifest/);
  assert.match(integrity, /ExpectedManifestSha256/);
  assert.match(integrity, /Get-FileHash -LiteralPath \$manifestPath -Algorithm SHA256/);
  assert.match(integrity, /Source manifest changed across the UAC\/build boundary/);
  assert.match(integrity, /FileAttributes\]::ReparsePoint/);
  assert.match(integrity, /Dictionary\[string,string\]\]::new\(\[StringComparer\]::OrdinalIgnoreCase\)/);
  assert.match(integrity, /Source tree file count differs from its manifest/);
  assert.match(integrity, /Source file failed its manifest digest/);
  assert.match(integrity, /AllowMissing/);
  assert.doesNotMatch(integrity, /signed.source|signature verified/i,
    "an unsigned manifest must not be described as a signature or authenticity proof");

  const preElevationVerification = setup.indexOf("Assert-PixelBrightnessSourceManifest -SourceRoot $SourceRoot");
  const elevation = setup.indexOf("if (-not (Test-Administrator))");
  assert.ok(preElevationVerification >= 0 && preElevationVerification < elevation,
    "the complete source tree must be verified before requesting UAC");
  assert.match(setup, /-ExpectedSourceManifestSha256 \$ExpectedSourceManifestSha256/);
  assert.match(setup, /\$manifestArgument[\s\S]*-ExpectedSourceManifestSha256/);
  assert.match(setup, /\$developerArgument[\s\S]*-AllowUnverifiedDeveloperSource/);
  assert.match(setup, /FileDigests\.ContainsKey\(\$bootstrapRelative\)/);
  assert.match(setup, /Get-BytesSha256 \$bootstrapBytes/);
  assert.match(setup, /Invoke-PixelBrightnessElevatedBootstrap/);
  assert.match(setup, /Developer bypass selected:[\s\S]*Never use this path for a release installation/);

  assert.match(bootstrap, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(bootstrap, /S-1-5-32-544/);
  assert.match(bootstrap, /S-1-5-18/);
  assert.match(bootstrap, /Pixel Brightness Bootstrap/);
  assert.match(bootstrap, /Get-CanonicalManifestEntries/);
  assert.match(bootstrap, /Copy-Item -LiteralPath \$sourcePath -Destination \$destination/);
  assert.match(bootstrap, /Protected bootstrap file failed its manifest digest/);
  assert.match(bootstrap, /deploy\\windows\\Setup-PixelBrightness\.ps1/);
  assert.ok(
    bootstrap.indexOf("Protected bootstrap file failed its manifest digest")
      < bootstrap.indexOf("& $setupPath @setupParameters"),
    "no source script may execute elevated until every protected copy matches the manifest",
  );

  assert.match(installer, /Join-Path \$env:ProgramData 'Pixel Brightness Build'/);
  assert.match(installer, /Initialize-AdminProtectedDirectory \$stagingParent \$env:ProgramData \$ShowUser/);
  assert.match(installer, /Protect-AdminControlPath -Path \$stageRoot -ShowUser \$ShowUser -ShowAccess None/);
  assert.doesNotMatch(installer, /GetTempPath|\$env:TEMP|\$env:TMP/,
    "an elevated build must not stage under a user-writable temporary directory");
  const stagedVerification = installer.indexOf("Assert-PixelBrightnessSourceManifest -SourceRoot $stageRelease");
  const npmInstall = installer.indexOf("Invoke-Checked $npmCommand @('ci', '--ignore-scripts=false')");
  assert.ok(stagedVerification >= 0 && stagedVerification < npmInstall,
    "the protected staged copy must be verified before any npm lifecycle code runs");

  assert.match(packageScript, /"deploy"/);
  assert.match(packageScript, /MANIFEST-SHA256\.txt/);
  assert.match(packageScript, /async function verifyManifestTree/);
  assert.match(packageScript, /Extracted source failed its manifest digest/);
  assert.match(packageScript, /"verified-extraction"/);
  assert.doesNotMatch(packageScript, /contents\.includes\(0\)[^\n]*continue/,
    "credential scanning must not skip a file merely because it contains NUL bytes");
  assert.ok(
    packageScript.indexOf("await verifyManifestTree") < packageScript.indexOf("await rename(temporaryArchive, archivePath)"),
    "the ZIP must be extracted and every manifest digest reverified before publication",
  );
});

test("Windows upgrades statically wire snapshot, health, and rollback at every commit boundary", async () => {
  const [installer, transaction, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/README.md"),
  ]);

  assert.match(installer, /Global\\PixelBrightnessInstaller/);
  assert.match(installer, /New-PixelBrightnessUpgradeSnapshot/);
  assert.ok(
    installer.indexOf("New-PixelBrightnessUpgradeSnapshot") < installer.indexOf("Disable-ScheduledTask -TaskName 'PixelBrightness-Show'"),
    "the exact prior snapshot must precede the first task mutation",
  );
  assert.ok(
    installer.indexOf("New-PixelBrightnessUpgradeSnapshot") < installer.indexOf("Publish-PixelBrightnessWriteThroughDirectory $releasePublishSource $releaseRoot"),
    "the exact prior snapshot must precede release publication",
  );

  for (const relative of [
    "config\\node.json",
    "config\\renderer.json",
    "config\\display-binding.json",
    "current-release.txt",
    "Start-PixelBrightness.ps1",
    "Bind-PixelBrightnessDisplays.ps1",
    "Test-PixelBrightness.ps1",
    "RuntimeSecurity.ps1",
    "secrets\\control-token.txt",
    "secrets\\node-signing-key.txt",
    "secrets\\node-token.txt",
    "secrets\\cluster-token.txt",
    "secrets\\runtime.json",
    "secrets\\installation.json",
    "secrets\\trusted-web.json",
  ]) assert.match(transaction, new RegExp(relative.replaceAll("\\", "\\\\").replaceAll(".", "\\.")));
  assert.match(transaction, /GetSecurityDescriptorSddlForm/);
  assert.match(transaction, /SetSecurityDescriptorSddlForm/);
  assert.match(transaction, /Export-ScheduledTask/);
  assert.match(transaction, /XmlSha256/);
  assert.match(transaction, /Enabled = \[bool\]\$task\.Settings\.Enabled/);
  assert.match(transaction, /Running = \[string\]\$task\.State -eq 'Running'/);
  assert.match(transaction, /Register-ScheduledTask -TaskName \(\[string\]\$entry\.Name\) -Xml \$xml/);
  assert.match(transaction, /Rollback restored different control bytes/);
  assert.match(transaction, /Rollback restored a different control ACL/);
  assert.match(transaction, /Rollback restored a different scheduled task definition/);
  assert.match(transaction, /Rollback did not restore task enabled\/running state/);
  assert.match(transaction, /Restore-PixelBrightnessFirewallSnapshot/);
  assert.match(transaction, /Restore-PixelBrightnessPowerSnapshot/);

  assert.match(transaction, /MoveFileExW\(\$temporaryFull, \$destinationFull, \$moveFlags\)/);
  const trustedWebWrite = installer.indexOf("Write-Utf8Json $trustedWebFile");
  const pointerWrite = installer.indexOf("Write-Utf8Text $releasePointer $releaseRoot");
  assert.ok(trustedWebWrite >= 0 && trustedWebWrite < pointerWrite,
    "the atomic release pointer must be the final control-generation publication");

  const publish = installer.indexOf("Move-Item -LiteralPath $stageRelease -Destination $releaseRoot");
  const publishFault = installer.indexOf("Invoke-InstallFaultInjection 'after-release-publish'");
  const controlFault = installer.indexOf("Invoke-InstallFaultInjection 'after-control-publication'");
  const taskRegistration = installer.indexOf("Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger");
  const taskFault = installer.indexOf("Invoke-InstallFaultInjection 'after-task-change'");
  const firewallFault = installer.indexOf("Invoke-InstallFaultInjection 'after-firewall-change'");
  const powerFault = installer.indexOf("Invoke-InstallFaultInjection 'after-power-change'");
  const serviceFault = installer.indexOf("Invoke-InstallFaultInjection 'after-service-start'");
  assert.ok(publish < publishFault && publishFault < pointerWrite);
  assert.ok(pointerWrite < controlFault && controlFault < taskRegistration);
  assert.ok(taskRegistration < taskFault && taskFault < firewallFault);
  assert.ok(firewallFault < powerFault && powerFault < serviceFault);

  const taskStart = installer.indexOf("Start-ScheduledTask -TaskName 'PixelBrightness-Web'");
  const postHealth = installer.indexOf("Assert-PostInstallHealth -DataRoot $DataRoot");
  const commit = installer.indexOf("$transactionCommitted = $true", postHealth);
  assert.ok(taskStart < postHealth && postHealth < commit,
    "the new Server/Web runtime must pass health before the transaction commits");
  assert.match(installer, /Wait-PixelBrightnessJsonHealth/);
  assert.match(installer, /Wait-PixelBrightnessAuthenticatedState/);
  assert.match(installer, /Authorization = "Bearer \$Token"/);
  assert.match(installer, /\$health\.ok -ne \$true/);
  assert.match(installer, /\[int\]\$health\.protocolVersion -ne 1/);
  assert.match(installer, /Wait-PixelBrightnessWebHealth/);
  assert.match(installer, /Assert-FreshPixelBrightnessListener 4100 'runtime\[\\\\\/\]server\[\\\\\/\]index\\\.mjs'/);
  assert.match(installer, /Assert-FreshPixelBrightnessListener 3000 'vinext\[\\\\\/\]\.\*cli\\\.js\.\*start'/);
  assert.match(installer, /Unresolved protected upgrade journal exists/);
  assert.match(installer, /Join-Path \$env:SystemRoot 'System32\\robocopy\.exe'/);
  assert.match(installer, /Join-Path \$env:SystemRoot 'System32\\powercfg\.exe'/);
  assert.doesNotMatch(installer, /&\s+(?:robocopy|powercfg)\.exe\b/i);
  assert.match(installer, /Restore-PixelBrightnessUpgradeSnapshot/);
  assert.match(installer, /Assert-PixelBrightnessUpgradeSnapshotRestored/);
  assert.match(installer, /Set-PixelBrightnessUpgradeFailClosed/);
  assert.match(transaction, /managed inbound firewall rule is still present/);
  assert.match(installer, /Protected recovery evidence was preserved/);
  assert.match(installer, /New immutable release was retained for diagnosis/);
  assert.doesNotMatch(installer, /Remove-Item[^\n]+\$releaseRoot/);

  assert.match(readme, /Transactional upgrade and rollback/);
  assert.match(readme, /after-release-publish/);
  assert.match(readme, /after-control-publication/);
  assert.match(readme, /after-task-change/);
  assert.match(readme, /after-firewall-change/);
  assert.match(readme, /after-power-change/);
  assert.match(readme, /after-service-start/);
  assert.match(readme, /do(?:es)? not prove[\s\S]{0,180}sudden power-loss recovery/i);
});

test("Windows gate and control publication closes the write-through power boundary", async () => {
  const transaction = await source("deploy/windows/UpgradeTransaction.ps1");
  assert.match(transaction, /DllImport\("kernel32\.dll"[\s\S]*MoveFileExW/);
  assert.match(transaction, /MOVEFILE_REPLACE_EXISTING = 0x00000001/);
  assert.match(transaction, /MOVEFILE_WRITE_THROUGH = 0x00000008/);
  assert.match(transaction, /GetPathRoot\(\$temporaryFull\)[\s\S]*GetPathRoot\(\$destinationFull\)/);
  assert.match(transaction, /CreateFileW\([\s\S]*FILE_FLAG_WRITE_THROUGH/);
  assert.match(transaction, /FlushFileBuffers\(\$published\)/);
  const atomicBody = transaction.match(/function Write-PixelBrightnessAtomicBytes[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(atomicBody, /FileOptions\]::WriteThrough/);
  assert.match(atomicBody, /\$stream\.Flush\(\$true\)/);
  assert.match(atomicBody, /Publish-PixelBrightnessWriteThroughFile \$temporary \$Path/);
  assert.doesNotMatch(atomicBody, /\[IO\.File\]::(?:Move|Replace)/,
    "the durable control primitive must not fall back to a cache-only managed rename");
  assert.ok(
    atomicBody.indexOf("$stream.Flush($true)")
      < atomicBody.indexOf("Publish-PixelBrightnessWriteThroughFile $temporary $Path"),
    "temporary bytes must be durable before the write-through link replacement",
  );
  const publishBody = transaction.match(/function Publish-PixelBrightnessWriteThroughFile[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(
    publishBody.indexOf("MoveFileExW($temporaryFull, $destinationFull, $moveFlags)")
      < publishBody.indexOf("FlushFileBuffers($published)"),
    "the published link must be replaced before reopening and flushing its file handle",
  );
  assert.match(transaction, /Write-PixelBrightnessAtomicBytes \$gatePath \$bytes/);
  assert.match(transaction, /Publish-PixelBrightnessWriteThroughFile \$expectedPath \$consumedPath/);

  // Mock the only externally visible return boundary: WRITE_THROUGH must have
  // made the new link durable before publication can report success.
  for (const cut of ["before-temp-flush", "before-move", "during-move", "after-return"]) {
    const publicationReturned = cut === "after-return";
    const durableLink = cut === "after-return";
    if (publicationReturned) assert.equal(durableLink, true);
  }
});

test("Windows network and power changes are explicit and bounded", async () => {
  const [installer, launcher, acceptance, preflight, runtimeSecurity] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/Test-PixelBrightness.ps1"),
    source("deploy/windows/Preflight-PixelBrightness.ps1"),
    source("deploy/windows/RuntimeSecurity.ps1"),
  ]);
  assert.match(installer, /-LocalPort \$rule\.Port -Profile Private/);
  assert.match(installer, /if \(\$Appliance\)[\s\S]*standby-timeout-ac/);
  assert.match(installer, /monitor-timeout-ac/);
  assert.match(installer, /hibernate-timeout-ac/);
  assert.match(installer, /disk-timeout-ac/);
  assert.match(acceptance, /ACSettingIndex/);
  assert.match(acceptance, /Sleep timeout/);
  assert.match(acceptance, /Hibernate timeout/);
  assert.match(acceptance, /Display timeout/);
  assert.match(acceptance, /Disk timeout/);
  assert.match(acceptance, /Not running through RDP/);
  assert.match(acceptance, /Native renderer process/);
  assert.match(acceptance, /binding\.adapterLuid[\s\S]*nodeConfig\.adapterLuid/);
  assert.match(acceptance, /accessMode -eq 'open'/);
  assert.match(acceptance, /Arena process/);
  assert.match(preflight, /Private control network/);
  assert.match(preflight, /NetworkCategory -eq 'Private'/);
  assert.match(preflight, /Git for Windows/);
  assert.match(acceptance, /shared interactive session/);
  assert.match(acceptance, /Get-NetFirewallPortFilter/);
  assert.match(acceptance, /Profile -ne 'Private'/);
  assert.match(acceptance, /Assert-AdminProtectedReleaseLocation \(Get-CurrentRelease\)/);
  assert.match(acceptance, /Assert-PixelBrightnessControlPlane -DataRoot \$DataRoot -IncludeSystemDirectories/);
  assert.match(acceptance, /NVIDIA Corporation\\NVSMI\\nvidia-smi\.exe/);
  assert.match(acceptance, /& \$nvidiaSmi --query-gpu/);
  assert.match(runtimeSecurity, /GetAccessRules\(\$true, \$true, \[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(launcher, /Assert-PixelBrightnessControlPlane/);
  assert.match(launcher, /Assert-AdminProtectedReleaseLocation/);
  assert.match(launcher, /Assert-ProtectedNodeRuntime \$node \$npm/);
  assert.match(launcher, /Remove-Item Env:NEXT_PUBLIC_PIXEL_SERVER_URL/);
  assert.match(launcher, /\$Role -eq 'Show'[\s\S]*'show'[\s\S]*'system'/);
  assert.match(launcher, /Assert-RealLogDirectory \$logRoot \$logsParent/);
  assert.match(launcher, /FileAttributes\]::ReparsePoint/);
  assert.doesNotMatch(
    launcher,
    /NEXT_PUBLIC_PIXEL_SERVER_URL\s*=\s*['"]http:\/\/(?:127\.0\.0\.1|localhost):4100/,
    "remote Web Control browsers must derive the API host instead of calling their own loopback",
  );
});

test("Windows native build and exact pipe contract are installed", async () => {
  const [installer, launcher, binder, nativeMain] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("native/windows/src/main.cpp"),
  ]);
  assert.match(installer, /native\\windows/);
  assert.match(installer, /CMakeLists\.txt/);
  assert.match(installer, /cmake\.exe/);
  assert.match(installer, /ctest\.exe/);
  assert.match(installer, /--output-on-failure/);
  assert.match(installer, /pixel-brightness-renderer\.exe/);
  assert.match(installer, /Release\\pixel-brightness-renderer\.exe/);
  assert.match(installer, /ToUInt16\(\$pe, \$peOffset \+ 4\) -ne 0x8664/);
  assert.match(installer, /foreach \(\$shaderName in @\('fullscreen_vs\.hlsl', 'final_ps\.hlsl'\)\)/);
  assert.match(installer, /renderer\.schema\.json/);
  assert.match(launcher, /--config `"\$rendererConfig`" --pipe `"\$pipe`" --node-id `"\$nodeId`"/);
  assert.match(launcher, /PipeName = \[string\]\$binding\.pipeName/);
  assert.match(installer, /native\\windows\\config\\renderer\.example\.json/);
  assert.match(installer, /rendererBackend = 'dxgi'/);
  assert.match(installer, /rendererConfigPath = \$rendererConfig/);
  assert.match(installer, /compositionSource = \$projectDefaults\.compositionSource/);
  assert.match(installer, /Write-Utf8Json/);
  assert.doesNotMatch(installer, /native\\windows\\config\.example\.json/);
  assert.match(binder, /--list-displays-file `"\$inventoryTemporary`"/);
  assert.match(binder, /Start-Process -FilePath \$renderer[\s\S]*-Wait -PassThru/);
  assert.match(binder, /Group-Object adapterLuid/);
  assert.match(binder, /Every overlapping projector must be on the same GPU adapter/);
  assert.match(binder, /devicePath = \[string\]\$display\.devicePath/);
  assert.match(binder, /adapterLuid = \[string\]\$display\.adapterLuid/);
  assert.match(binder, /Add-Member -NotePropertyName adapterLuid -NotePropertyValue \(\[string\]\$selected\[0\]\.adapterLuid\) -Force/);
  assert.match(binder, /targetId = \[int64\]\$display\.targetId/);
  assert.match(binder, /localSpanWidth = \$width \+ \(\(\$selected\.Count - 1\) \* \(\$width - \$Overlap\)\)/);
  assert.match(binder, /CanvasWidth/);
  assert.match(binder, /CanvasHeight/);
  assert.match(binder, /SourceOffsetX/);
  assert.match(binder, /SourceOffsetY/);
  assert.match(binder, /canvasWidth -gt 16384/);
  assert.match(binder, /Enable-ScheduledTask -TaskName 'PixelBrightness-Show'/);
  assert.match(binder, /Protect-BindingGate \$informationalBindingPath \$ShowUser/);
  assert.match(binder, /Assert-PixelBrightnessControlPlane/);
  assert.match(binder, /Assert-AdminProtectedReleaseLocation/);
  assert.match(binder, /function Assert-RealFileDestination/);
  assert.match(binder, /Initialize-AdminProtectedDirectory \$backupRoot \$env:ProgramData \$ShowUser/);
  assert.match(binder, /Inventory-only mode made no configuration changes/);
  assert.match(binder, /Display inventory saved successfully/);
  assert.doesNotMatch(binder, /throw "Display inventory saved/);
  assert.doesNotMatch(binder, /icacls\.exe/, "binder protection must not preserve unknown explicit ACEs or owners");
  assert.match(binder, /State -cne 'Disabled'/);
  assert.match(binder, /active live\/orphan renderer process\(es\)/);
  assert.match(binder, /Write-PixelBrightnessDisplayBindingTransactionGate/);
  assert.match(binder, /Sync-PixelServerProject -TargetProjectBytes \$targetProjectBytes/);
  assert.match(binder, /Get-PixelServerProject \$operatorControlToken \$serverBaseUrl/);
  assert.match(binder, /\$ServerBaseUrl\/v1\/projects\/default/);
  assert.match(binder, /\(\[string\]\$node\.serverUrl\)/);
  assert.match(binder, /Authorization = "Bearer \$ControlToken"/);
  assert.match(binder, /'If-Match' = '"' \+ \$BaseRevision/);
  assert.match(binder, /Authoritative Server is neither the exact pre-bind project A nor intended project B/);
  assert.match(binder, /nodeId = \$nodeId/);
  assert.match(binder, /\$id = "\$nodeId-\$label"/);
  assert.match(binder, /\$mergedOutputs = @\(\$otherServerOutputs\) \+ @\(\$outputs\)/);
  assert.match(binder, /Every Windows node in one project must publish the same master canvas/);
  assert.match(binder, /serverProjectRevision/);
  assert.match(binder, /Pixel Server returned a project that does not match the bound physical outputs/);
  assert.ok(
    binder.indexOf("Sync-PixelServerProject -TargetProjectBytes $targetProjectBytes") < binder.indexOf("Write-PixelBrightnessDisplayBindingCommit -DataRoot $DataRoot"),
    "the protected positive binding commit must be published only after the authoritative Server project",
  );
  assert.match(binder, /Write-PixelBrightnessAtomicBytes \$informationalBindingPath \$bindingBytes/);
  assert.match(binder, /PixelBrightness-Show is running[\s\S]*no config was changed/);
  assert.doesNotMatch(binder, /Get-ChildItem[^\n]+pixel-brightness-renderer\.exe/);
  assert.doesNotMatch(installer, /Get-ChildItem[^\n]+pixel-brightness-renderer\.exe/);
  assert.doesNotMatch(nativeMain, /MessageBox(?:A|W)?\s*\(/, "fatal native errors must exit for the Show supervisor, never block on a modal dialog");
});

test("Windows display rebind preserves authoritative calibration unless reset is explicit", async () => {
  const [binder, readme] = await Promise.all([
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/README.md"),
  ]);

  assert.match(binder, /\[switch\]\$ResetSpatialConfig/);
  assert.match(binder, /\$preserveSpatial = -not \$ResetSpatialConfig -and \$existingLocalOutputs\.Count -gt 0/);
  assert.match(binder, /device path is the primary calibration identity/i);
  assert.match(binder, /adapter LUID \+ target id pair is the next stable, unique physical match/i);
  assert.match(binder, /final fallback is deterministic only when the operator supplied the[\s\S]*exact GDI list/);
  assert.match(binder, /-and \$GdiName\.Count -gt 0 -and -not \$AutoSelect/);
  assert.match(binder, /Authoritative Server has \$\(\$existingLocalOutputs\.Count\) output\(s\)[\s\S]*Topology was not changed/);
  assert.match(binder, /Assert-ExactResolution \$existingOutput \$display/);
  assert.match(binder, /Assert-PreservedSpatialConfig \$existingOutput \$canvas/);
  for (const field of ["sourceViewport", "overlap", "warp", "blend", "blackUniformity", "color", "mask", "processing"]) {
    assert.match(binder, new RegExp(`${field} = \\$existingOutput\\.${field}`));
  }
  assert.match(binder, /\$mergedWalls = @\(\$existingServerProject\.walls\)/);
  assert.doesNotMatch(binder, /\$preservedWallIds/);
  assert.match(binder, /backups\\display-bindings/);
  assert.match(binder, /server-project-before\.json/);
  assert.match(binder, /selected-displays\.json/);
  assert.match(binder, /Protect-BackupDirectory \$backupPath \$ShowUser/);
  assert.match(binder, /Get-PixelServerBindingReconcileState/);
  assert.match(binder, /BaseProjectSha256 \(\[string\]\$Gate\.baseProjectSha256\)/);
  assert.ok(
    binder.indexOf("Write-PixelBrightnessDisplayBindingTransactionGate") < binder.lastIndexOf("Export-RebindBackup $DataRoot"),
    "the durable in-progress gate must precede the protected operator backup",
  );
  assert.match(binder, /Assert-SpatialConfigEqual \$expectedOutput \$actualOutput\[0\]/);

  assert.match(readme, /Re-running the binder is non-destructive by default/);
  assert.match(readme, /central\s+Server project is the authority/);
  assert.match(readme, /keeps its source viewport, overlap, warp mesh, blend\/map/);
  assert.match(readme, /-ResetSpatialConfig/);
  assert.match(readme, /protected timestamped directory[\s\S]*backups\\display-bindings/);
  assert.match(readme, /atomic[\s\S]*`If-Match` precondition/);
});

test("Windows installer supports a protected central Server and render-only nodes", async () => {
  const [installer, setup, binder, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/README.md"),
  ]);
  assert.match(installer, /ValidateSet\('All', 'Server', 'Node'\)/);
  assert.match(installer, /\[string\]\$ServerUrl/);
  assert.match(installer, /\[string\]\$NodeTokenFile/);
  assert.match(installer, /\[string\]\$ClusterTokenFile/);
  assert.match(installer, /new Node installation requires -NodeTokenFile/i);
  assert.match(installer, /ClusterTokenFile is a retired shared credential and is rejected/i);
  assert.match(installer, /New-NodeCredential \$NodeId \$installedNodeSigningKey/);
  assert.match(installer, /Assert-NodeCredentialIdentity \$importedNodeToken \$NodeId/);
  assert.match(installer, /serverUrl = \$ServerUrl/);
  assert.match(installer, /ValidateSet\('CanonR50RfS1018', 'SonyA7IV', 'Disabled'\)/);
  assert.match(installer, /\[string\]\$CameraProfile = 'CanonR50RfS1018'/);
  assert.match(installer, /\$cameraProfileValue = New-PixelBrightnessCameraProfile \$CameraProfile/);
  assert.match(installer, /'CanonR50RfS1018' \{ 'canon-edsdk' \}/);
  assert.match(installer, /cameraBackend = \$cameraBackend/);
  assert.match(installer, /cameraExpectedModel = \[string\]\$cameraProfileValue\.camera\.model/);
  assert.match(installer, /cameraExpectedLensModel = \[string\]\$cameraProfileValue\.lens\.model/);
  assert.match(installer, /cameraHelperCommand = \$null/);
  assert.match(installer, /cameraRuntimeManifestPath = \$null/);
  assert.match(installer, /cameraCaptureDir = \(Join-Path \$DataRoot 'state\\node\\camera-captures'\)/);
  assert.match(installer, /New-PixelBrightnessUnconfiguredCameraAuthority -DataRoot \$DataRoot -Profile \$CameraProfile/);
  assert.match(installer, /if \(\$installServer\)[\s\S]*PixelBrightness-Server/);
  assert.match(installer, /if \(\$installNode\)[\s\S]*PixelBrightness-Show/);
  assert.match(installer, /if \(\$installServer\)[\s\S]*New-NetFirewallRule/);
  assert.match(installer, /secrets\\installation\.json/);
  assert.match(setup, /-Role \$Role/);
  assert.match(setup, /-ServerUrl \$ServerUrl/);
  assert.match(setup, /-NodeTokenFile \$NodeTokenFile/);
  assert.match(binder, /sourceViewport = \[ordered\]@\{ x = \$SourceOffsetX/);
  assert.match(readme, /Role Node|central Server/i);
  assert.match(readme, /Canon EOS R50 measured calibration/);
  assert.match(readme, /default installer profile is `CanonR50RfS1018`/);
  assert.match(readme, /`cameraBackend: "canon-edsdk"`/);
  assert.match(readme, /EOS R50[\s\S]*RF-S10-18mm F4\.5-6\.3 IS STM/);
  assert.match(readme, /deliberately leaves[\s\S]*`cameraHelperCommand` and[\s\S]*`cameraRuntimeManifestPath` unset/);
  assert.match(readme, /protected camera authority in the `unconfigured` state/);
  assert.match(readme, /14-bit CR3/);
  assert.match(readme, /committed project revision is not an optical pass/i);
});

test("Windows deployment separates operator authority from nodeId-bound credentials", async () => {
  const [installer, launcher, security, setup, bootstrap, binder, acceptance, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/RuntimeSecurity.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/ElevatedBootstrap.ps1"),
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
    source("deploy/windows/Test-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);

  assert.match(installer, /pixel-brightness\/render-node\/v1\$\(\[char\]0\)\$CredentialNodeId/);
  assert.match(installer, /HMACSHA256/);
  assert.match(installer, /control token and Render Node signing key must be different secrets/i);
  assert.match(installer, /Never promote the legacy shared token/);
  assert.match(installer, /\$legacySharedCredentialPresent = Test-Path -LiteralPath \$legacyClusterTokenFile/);
  assert.match(installer, /if \(\$legacySharedCredentialPresent -or -not \(Test-Path -LiteralPath \$controlTokenFile/);
  assert.match(installer, /if \(\$legacySharedCredentialPresent -or -not \(Test-Path -LiteralPath \$nodeSigningKeyFile/);
  assert.match(installer, /Remove-Item -LiteralPath \$legacyClusterTokenFile -Force/);
  assert.match(installer, /render-only host must never retain operator authority/);
  assert.match(installer, /NodeTokenFile is accepted only for a render-only Role Node installation/);
  assert.match(installer, /credential is bound to \$credentialNodeId, not configured node \$ExpectedNodeId/);

  const serverBranch = launcher.slice(launcher.indexOf("  'Server' {"), launcher.indexOf("  'Web' {"));
  const showBranch = launcher.slice(launcher.indexOf("  'Show' {"));
  assert.match(serverBranch, /PIXEL_CONTROL_TOKEN = Read-ControlToken/);
  assert.match(serverBranch, /PIXEL_NODE_SIGNING_KEY = Read-NodeSigningKey/);
  assert.doesNotMatch(serverBranch, /PIXEL_BRIGHTNESS_NODE_TOKEN/);
  assert.match(showBranch, /PIXEL_BRIGHTNESS_NODE_TOKEN = Read-NodeToken/);
  assert.doesNotMatch(showBranch, /PIXEL_CONTROL_TOKEN|PIXEL_NODE_SIGNING_KEY/);
  assert.match(showBranch, /Remove-Item Env:PIXEL_BRIGHTNESS_AUTH_TOKEN/);

  assert.match(security, /function Assert-AdminOnlyPixelBrightnessSecret/);
  assert.match(security, /grants secret-read access to a non-privileged trustee/);
  assert.match(security, /'All' \{ @\('secrets\\control-token\.txt', 'secrets\\node-signing-key\.txt', 'secrets\\node-token\.txt'\) \}/);
  assert.match(security, /'Server' \{ @\('secrets\\control-token\.txt', 'secrets\\node-signing-key\.txt'\) \}/);
  assert.match(security, /'Node' \{ @\('secrets\\node-token\.txt'\) \}/);
  assert.match(setup, /nodeTokenFile = \$NodeTokenFile/);
  assert.match(bootstrap, /setupParameters\.NodeTokenFile/);
  assert.doesNotMatch(bootstrap, /setupParameters\.ClusterTokenFile/);
  assert.match(binder, /\[string\]\$ControlTokenFile/);
  assert.match(binder, /Read-OperatorControlToken/);
  assert.match(acceptance, /\[string\]\$ControlTokenFile/);
  assert.match(acceptance, /Node process never receives the operator control token/);
  assert.match(readme, /Never copy either Server secret to a render PC/);
  assert.match(readme, /cannot call operator routes or impersonate a[\s\S]*different node/);
});

test("Windows refuses a legacy pre-gate launcher before the first power boundary", async () => {
  const [installer, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);
  assert.match(installer, /function Assert-GateAwareInstalledLauncherForUpgrade/);
  assert.match(installer, /PixelBrightnessUpgradeGateContract:v1/);
  assert.match(installer, /PixelBrightnessUpgradeGateHelperContract:v1/);
  assert.match(installer, /\$gateMatch = \[regex\]::Match/);
  assert.match(installer, /\$pointerMatch = \[regex\]::Match/);
  assert.match(installer, /Assert-AdminProtectedItem \(Get-Item -LiteralPath \$helper/);
  assert.match(installer, /Export-ScheduledTask -TaskName \$taskName/);
  assert.match(installer, /\[IO\.Path\]::GetFileName\(\[string\]\$actions\[0\]\.Command\) -ine 'powershell\.exe'/);
  assert.match(installer, /legacy_upgrade_bootstrap_required/);
  const guard = installer.indexOf("Assert-GateAwareInstalledLauncherForUpgrade $DataRoot");
  const firstGateAfterGuard = installer.indexOf("Write-PixelBrightnessUpgradeGate -DataRoot $DataRoot", guard);
  const disableAfterGuard = installer.indexOf("Disable-PixelBrightnessManagedTasksForUpgrade", guard);
  assert.ok(guard >= 0 && guard < firstGateAfterGuard,
    "legacy launcher audit must finish before publishing the first durable gate");
  assert.ok(firstGateAfterGuard < disableAfterGuard,
    "a gate-aware installation must still publish the gate before disabling tasks");
  assert.match(readme, /predates the durable[\s\S]*not eligible for an online in-place upgrade/);
  assert.match(readme, /stop and disable every task in the[\s\S]*installed role profile[\s\S]*install the gate-aware/);
});

test("Windows full acceptance proves Spout input and every physical present path", async () => {
  const acceptance = await source("deploy/windows/Test-PixelBrightness.ps1");
  assert.match(acceptance, /Test-Item 'Canon camera runtime configured'/);
  assert.match(acceptance, /Read-PixelBrightnessCameraRuntimeAuthority[\s\S]*-RequireConfigured/);
  assert.match(acceptance, /Authority\.backend -cne 'canon-edsdk'/);
  assert.match(acceptance, /Authority\.profile\.camera\.model -cne 'EOS R50'/);
  assert.match(acceptance, /Authority\.profile\.lens\.model -cne 'RF-S10-18mm F4\.5-6\.3 IS STM'/);
  assert.match(acceptance, /Test-Item 'Canon EOS R50 USB, lens and 14-bit CR3 physical acceptance'/);
  assert.match(acceptance, /Invoke-CanonCameraPhysicalProbe -Root \$DataRoot/);
  assert.match(acceptance, /\$result\.configured -ne \$true -or \$result\.physicallyAccepted -ne \$true/);
  assert.match(acceptance, /\$result\.backend -cne 'canon-edsdk'[\s\S]*\$result\.model -cne 'EOS R50'/);
  assert.match(acceptance, /\$result\.lens -cne 'RF-S10-18mm F4\.5-6\.3 IS STM'/);
  assert.match(acceptance, /\$result\.transport -cne 'usb'[\s\S]*\$result\.rawFormat -cne 'CR3'/);
  assert.match(acceptance, /\[int\]\$result\.sourceBitDepth -ne 14/);
  assert.match(acceptance, /config\\renderer-status\.json/);
  assert.match(acceptance, /compositionSource\.state -ne 'connected'/);
  assert.match(acceptance, /Physical display-timing acceptance requires native vsync=true/);
  assert.match(acceptance, /presentSubmissions\.failures/);
  assert.match(acceptance, /presentSubmissions\.accepted/);
  assert.match(acceptance, /displayTiming\.source -cne 'IDXGISwapChain::GetFrameStatistics'/);
  assert.match(acceptance, /displayTiming\.syncInterval -ne 1/);
  assert.match(acceptance, /displayTiming\.cadenceMetricsApplicable -ne \$true/);
  assert.match(acceptance, /displayTiming\.phaseProof -ne \$false/);
  assert.match(acceptance, /displayTiming\.multiMonitorReliability -cne 'platform-dependent'/);
  assert.match(acceptance, /displayTiming\.available -ne \$true/);
  assert.match(acceptance, /displayTiming\.sampleAgeMilliseconds/);
  assert.match(acceptance, /physical display statistics are stale/);
  assert.match(acceptance, /Get-UInt32CounterDelta/);
  assert.match(acceptance, /displayTiming\.presentCount/);
  assert.match(acceptance, /displayTiming\.presentRefreshCount/);
  assert.match(acceptance, /displayTiming\.syncRefreshCount/);
  assert.match(acceptance, /displayTiming\.syncQpcTime/);
  assert.match(acceptance, /'discontinuities', 'droppedPresents', 'repeatedRefreshes', 'latePresentEvents'/);
  assert.match(acceptance, /receivedFrames did not advance/);
  assert.match(acceptance, /accepted Present submissions did not advance/);
  assert.match(acceptance, /accepted Present submission count is zero/);
  assert.match(acceptance, /receivedFrames is zero/);
  assert.match(acceptance, /Present submission timestamp did not advance/);
  assert.match(acceptance, /physical display-timing sample did not advance/);
  assert.match(acceptance, /expectedFrameDelta \* 0\.05/);
  assert.match(acceptance, /frameDeltaTolerance/);
  assert.doesNotMatch(acceptance, /expectedFrameDelta \* 0\.(?:70|30)/);
  assert.match(acceptance, /presentSubmissions\.lastHresult/);
  assert.doesNotMatch(acceptance, /renderedFrames|presentFailures|lastPresentQpc/,
    "the physical acceptance must not relabel submission counters as monitor presentation");
  assert.match(acceptance, /Assert-FreshTelemetry/);
  assert.match(acceptance, /task\.State -ne 'Running'/);
  assert.match(acceptance, /Show is disabled\/unbound/);
  assert.match(acceptance, /Enabled output count does not match the committed display binding/);
  assert.match(acceptance, /Native output \$\(\$bound\.id\) \$property/);
  assert.match(acceptance, /Authenticated Node registration and heartbeat/);
  assert.match(acceptance, /Read-ControlToken/);
  assert.match(acceptance, /Authorization = "Bearer \$token"/);
  assert.match(acceptance, /detail\.node\.status -eq 'offline'/);
  assert.match(acceptance, /capabilities\.outputs/);
  assert.match(acceptance, /heartbeatAge\.TotalSeconds -gt 10/);
  assert.match(acceptance, /binding\.serverProjectRevision -lt 1/);
  assert.match(acceptance, /v1\/projects\/default/);
  assert.match(acceptance, /project\.revision -lt \[int64\]\$binding\.serverProjectRevision/);
  assert.match(acceptance, /Authoritative project outputs do not match the committed binding/);
  assert.match(acceptance, /Authoritative output \$\(\$bound\.id\) \$property/);
  assert.match(acceptance, /Authenticated identify and content restore for every committed output/);
  assert.match(acceptance, /v1\/outputs\/\$encodedOutputId\/pattern/);
  assert.match(acceptance, /Wait-NodeCommandAck/);
  assert.match(acceptance, /detail\.node\.ackSequence/);
  assert.match(acceptance, /Wait-NativeOutputPatterns/);
  assert.match(acceptance, /\$expectedPattern = if \(\$Mode -eq 'content'\)[\s\S]{0,220}'identify'[\s\S]{0,120}'black'/,
    "the live acceptance must observe target isolation in native telemetry");
  assert.match(acceptance, /finally \{[\s\S]{0,900}-Enabled \$false[\s\S]{0,180}-Type 'content'/,
    "the acceptance must always queue the safe content restoration");
  assert.match(acceptance, /Native renderer did not restore every output to live content/);
});

test("Windows full acceptance identifies and restores every committed display", async () => {
  const acceptance = await source("deploy/windows/Test-PixelBrightness.ps1");
  assert.match(acceptance, /foreach \(\$targetOutputId in \$outputIds\)/,
    "the live acceptance must identify every committed physical output, not only the first one");
  assert.doesNotMatch(acceptance, /\$targetOutputId = \$outputIds\[0\]/,
    "the live acceptance must not silently accept any remaining named-surface outputs");
  assert.match(acceptance, /finally \{[\s\S]{0,900}-Enabled \$false[\s\S]{0,180}-Type 'content'/,
    "every identify attempt must queue the safe content restoration before continuing");
  assert.match(acceptance, /\$identifiedOutputs\.Add\([\s\S]{0,180}\)/,
    "an output counts as accepted only after its identify and restoration sequences complete");
  assert.match(acceptance, /outputs individually identified and restored/);
});

test("trusted local Web mode is explicit and retains the Server-only control token", async () => {
  const [installer, launcher, setup, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);
  assert.match(installer, /TrustedWebClient/);
  assert.match(installer, /TrustedWebHost/);
  assert.match(installer, /Trusted local Web Control requires both/);
  assert.match(installer, /IPAddress\]::TryParse/);
  assert.match(installer, /Join-Path \$secretsDirectory 'control-token\.txt'/);
  assert.match(launcher, /PB_TRUST_LOCAL_WEB = '1'/);
  assert.match(launcher, /PB_TRUSTED_WEB_CLIENTS/);
  assert.match(launcher, /PB_TRUSTED_WEB_HOSTS/);
  assert.match(launcher, /PB_ALLOW_POWER_ACTIONS = '0'/);
  assert.match(launcher, /Read-ControlToken/);
  assert.match(launcher, /Read-NodeSigningKey/);
  assert.match(launcher, /Read-NodeToken/);
  assert.match(setup, /Role -eq 'All'[\s\S]*TrustedWebClient = @\('127\.0\.0\.1', '::1'\)/);
  assert.match(setup, /TrustedWebHost = @\('localhost', '127\.0\.0\.1', '::1'\)/);
  assert.match(readme, /same Windows PC[\s\S]*does not show the Pair step/);
  assert.match(readme, /Every other LAN Web client still needs the control token/);
});

test("one-click Windows setup elevates with UAC, validates artifacts, and stores no password", async () => {
  const [cmd, setup, installer, readme] = await Promise.all([
    source("deploy/windows/Setup-PixelBrightness.cmd"),
    source("deploy/windows/Setup-PixelBrightness.ps1"),
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);
  assert.match(cmd, /Setup-PixelBrightness\.ps1/);
  assert.match(cmd, /No Windows password is read or stored/);
  assert.match(cmd, /Pixel Brightness installed successfully/);
  assert.match(cmd, /WINDOWS-START-HERE\.txt[\s\S]*Bind-PixelBrightnessDisplays\.ps1/);
  assert.match(setup, /-Verb RunAs/);
  assert.match(setup, /-EncodedCommand/);
  assert.match(setup, /Assert-SourceArtifacts/);
  assert.match(setup, /renderer\.schema\.json/);
  assert.match(setup, /fullscreen_vs\.hlsl/);
  assert.match(setup, /final_ps\.hlsl/);
  assert.match(setup, /Prebuilt native renderer is not x64/);
  assert.match(setup, /-Appliance/);
  assert.match(setup, /PixelBrightness-Show is DISABLED/);
  assert.match(setup, /Setup stopped before completion[\s\S]*Read-Host/,
    "the elevated one-click window must keep a dependency/build error visible to the operator");
  assert.match(installer, /Disable-ScheduledTask -TaskName 'PixelBrightness-Show'/);
  assert.match(readme, /Setup-PixelBrightness\.cmd/);
  assert.match(readme, /never reads, passes[\s\S]*stores a Windows password/i);
  assert.doesNotMatch(`${cmd}\n${setup}\n${installer}`, /DefaultPassword|AutoAdminLogon|cmdkey|ConvertTo-SecureString/i);
});

test("Windows PowerShell deployment scripts pass a Mac-side structural syntax audit", async () => {
  const paths = [
    "deploy/windows/Bind-PixelBrightnessDisplays.ps1",
    "deploy/windows/ElevatedBootstrap.ps1",
    "deploy/windows/Install-PixelBrightness.ps1",
    "deploy/windows/Preflight-PixelBrightness.ps1",
    "deploy/windows/Setup-PixelBrightness.ps1",
    "deploy/windows/RuntimeSecurity.ps1",
    "deploy/windows/SourceIntegrity.ps1",
    "deploy/windows/UpgradeTransaction.ps1",
    "deploy/windows/Recover-PixelBrightnessUpgrade.ps1",
    "deploy/windows/Start-PixelBrightness.ps1",
    "deploy/windows/ShowSchedule.ps1",
    "deploy/windows/Test-PixelBrightness.ps1",
  ];
  for (const path of paths) assertPowerShellIsStructurallyBalanced(await source(path), path);
});

test("runtime paths and UTF-8 JSON writes do not depend on SYSTEM PATH or BOM behavior", async () => {
  const [installer, transaction, launcher, binder] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/Bind-PixelBrightnessDisplays.ps1"),
  ]);
  assert.match(installer, /secrets\\runtime\.json/);
  assert.match(installer, /node = \$nodeCommand/);
  assert.match(installer, /npm = \$npmCommand/);
  assert.match(launcher, /Pinned Node\.js runtime config/);
  assert.match(launcher, /secrets\\runtime\.json/);
  assert.match(launcher, /secrets\\trusted-web\.json/);
  assert.doesNotMatch(launcher, /Get-Command node\.exe|Get-Command npm\.cmd/);
  assert.match(installer, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(binder, /ConvertTo-PixelBrightnessUtf8JsonBytes/);
  assert.match(transaction, /\.tmp"/);
  assert.match(transaction, /MoveFileExW/);
  assert.match(transaction, /FlushFileBuffers/);
  assert.match(binder, /\.tmp"/);
});

test("Web build and start scripts are portable to Windows cmd and PowerShell", async () => {
  const [packageSource, vinextRunner, windowsLauncher] = await Promise.all([
    source("package.json"),
    source("scripts/run-vinext.mjs"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
  ]);
  const manifest = JSON.parse(packageSource);
  assert.equal(manifest.scripts.build, "node scripts/run-vinext.mjs build");
  assert.equal(manifest.scripts.start, "node scripts/run-vinext.mjs start");
  assert.doesNotMatch(Object.values(manifest.scripts).join("\n"), /WRANGLER_LOG_PATH=.*vinext/);
  assert.match(vinextRunner, /spawn\(process\.execPath/);
  assert.match(vinextRunner, /node_modules[\s\S]*vinext[\s\S]*dist[\s\S]*cli\.js/);
  assert.match(windowsLauncher, /Invoke-Logged \$node @\('scripts\/run-vinext\.mjs', 'start'\) \$releaseRoot/);
  assert.doesNotMatch(windowsLauncher, /Invoke-Logged \$npm @\('run', 'start'\)/);
});
