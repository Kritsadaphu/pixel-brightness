import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifestName = ".pixel-brightness-release-manifest.json";

async function source(relative) {
  return readFile(new URL(relative, root), "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exactFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`reparse:${relative}`);
    if (entry.isDirectory()) result.push(...await exactFiles(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
    else throw new Error(`non-regular:${relative}`);
  }
  return result.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0);
}

async function writeReferenceManifest(directory) {
  const files = await exactFiles(directory);
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    entries.push({ path: file.relative, length: bytes.length, sha256: sha256(bytes) });
  }
  await writeFile(path.join(directory, manifestName), `${JSON.stringify({
    schemaVersion: 1,
    algorithm: "sha256",
    manifestPath: manifestName,
    fileCount: entries.length,
    files: entries,
  })}\n`);
}

async function verifyReferenceManifest(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
  const actual = (await exactFiles(directory)).filter((file) => file.relative !== manifestName);
  assert.equal(manifest.fileCount, manifest.files.length);
  assert.equal(manifest.files.length, actual.length);
  const byPath = new Map(actual.map((file) => [file.relative.toLowerCase(), file]));
  assert.equal(byPath.size, actual.length);
  for (const entry of manifest.files) {
    const file = byPath.get(entry.path.toLowerCase());
    assert.ok(file, `missing:${entry.path}`);
    assert.equal(file.relative, entry.path);
    const bytes = await readFile(file.absolute);
    assert.equal(bytes.length, entry.length);
    assert.equal(sha256(bytes), entry.sha256);
    byPath.delete(entry.path.toLowerCase());
  }
  assert.equal(byPath.size, 0);
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pixel-brightness-release-"));
  await mkdir(path.join(directory, "runtime", "server"), { recursive: true });
  await mkdir(path.join(directory, "native", "windows", "bin"), { recursive: true });
  await writeFile(path.join(directory, "runtime", "server", "index.mjs"), "export const ok = true;\n");
  await writeFile(path.join(directory, "native", "windows", "bin", "renderer.exe"), Buffer.from([0x4d, 0x5a, 1, 2, 3]));
  await writeReferenceManifest(directory);
  return directory;
}

test("release publication flushes and verifies an exact all-file manifest before pointer authority", async () => {
  const [installer, transaction, launcher, readme] = await Promise.all([
    source("deploy/windows/Install-PixelBrightness.ps1"),
    source("deploy/windows/UpgradeTransaction.ps1"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("deploy/windows/README.md"),
  ]);

  const nativeBuild = installer.indexOf("if ($installNode) { $null = Assert-NativeBundle $stageRelease }");
  const manifest = installer.indexOf("Write-PixelBrightnessReleaseManifest $stageRelease", nativeBuild);
  const flush = installer.indexOf("Sync-PixelBrightnessReleaseTree $stageRelease", manifest);
  const stagedVerify = installer.indexOf("Assert-PixelBrightnessReleaseManifest $stageRelease", flush);
  const disable = installer.indexOf("Disable-PixelBrightnessManagedTasksForUpgrade", stagedVerify);
  const publish = installer.indexOf("Publish-PixelBrightnessWriteThroughDirectory $releasePublishSource $releaseRoot", disable);
  const protect = installer.indexOf("Protect-AdminReadOnlyReleaseTree $releaseRoot $ShowUser", publish);
  const publishedVerify = installer.indexOf("Assert-PixelBrightnessReleaseManifest $releaseRoot", protect);
  const pointer = installer.indexOf("Write-Utf8Text $releasePointer $releaseRoot", publishedVerify);
  const commit = installer.indexOf("Write-PixelBrightnessUpgradeCommit", pointer);
  const finalManifestVerify = installer.lastIndexOf("Assert-PixelBrightnessReleaseManifest $releaseRoot");
  const gateClear = installer.indexOf("Remove-PixelBrightnessUpgradeGate $DataRoot $transactionId", finalManifestVerify);
  assert.ok(nativeBuild >= 0 && nativeBuild < manifest && manifest < flush && flush < stagedVerify);
  assert.ok(stagedVerify < disable && disable < publish && publish < protect && protect < publishedVerify && publishedVerify < pointer);
  assert.ok(pointer < commit && commit < finalManifestVerify && finalManifestVerify < gateClear,
    "the release must be reverified after durable commit and immediately before gate clear");

  assert.match(installer, /GetPathRoot\(\[IO\.Path\]::GetFullPath\(\$stageRelease\)\)[\s\S]{0,650}Copy-PixelBrightnessReleaseToProtectedStaging/);
  assert.match(installer, /Sync-PixelBrightnessReleaseTree \$releasePublishSource[\s\S]{0,260}Assert-PixelBrightnessReleaseManifest \$releasePublishSource/);
  assert.doesNotMatch(installer, /Move-Item -LiteralPath \$stageRelease -Destination \$releaseRoot/);
  assert.match(transaction, /function Write-PixelBrightnessReleaseManifest/);
  assert.match(transaction, /function Assert-PixelBrightnessReleaseManifest/);
  assert.match(transaction, /Get-NonReparseTree \$rootItem\.FullName 'Pixel Brightness release payload'/);
  assert.match(transaction, /Get-PixelBrightnessFileSha256 \$file\.Item\.FullName/);
  assert.match(transaction, /Protected release manifest file count does not match the exact release inventory/);
  assert.match(transaction, /Protected release manifest digest or length mismatch/);
  assert.match(transaction, /FlushFileBuffers\(\$handle\)/);
  assert.match(transaction, /MoveFileExW\([\s\S]{0,220}MOVEFILE_WRITE_THROUGH/);
  assert.match(transaction, /releaseManifestSha256 = \$releaseManifest\.ManifestSha256/);
  assert.match(transaction, /commit\.releaseManifestSha256[\s\S]{0,220}releaseManifest\.ManifestSha256/);

  const gate = launcher.indexOf("Assert-PixelBrightnessUpgradeLauncherGate");
  const pointerRead = launcher.indexOf("$currentFile = Join-Path $DataRoot 'current-release.txt'");
  const protectedRelease = launcher.indexOf("Assert-AdminProtectedReleaseLocation $releaseRoot", pointerRead);
  const launchVerify = launcher.indexOf("Assert-PixelBrightnessReleaseManifest $releaseRoot", protectedRelease);
  const runtimeRead = launcher.indexOf("$runtimeConfig = Read-RequiredJson", launchVerify);
  const firstReleaseExecution = Math.min(
    ...["Invoke-UpgradeHealthLogged $node", "Invoke-Logged $node", "Start-Process -FilePath $renderer"]
      .map((needle) => launcher.indexOf(needle, launchVerify))
      .filter((index) => index >= 0),
  );
  assert.ok(gate >= 0 && gate < pointerRead && pointerRead < protectedRelease && protectedRelease < launchVerify);
  assert.ok(launchVerify < runtimeRead && runtimeRead < firstReleaseExecution);
  assert.match(readme, /\.pixel-brightness-release-manifest\.json[\s\S]{0,900}MoveFileExW\(WRITE_THROUGH\)/);
  assert.match(readme, /Windows PowerShell 5\.1[\s\S]{0,120}MoveFileExW/);
});

test("portable manifest model rejects every executable payload divergence", async () => {
  const clean = await fixture();
  try {
    await verifyReferenceManifest(clean);
  } finally {
    await rm(clean, { recursive: true, force: true });
  }

  for (const mutation of [
    async (directory) => writeFile(path.join(directory, "runtime", "server", "index.mjs"), "truncated"),
    async (directory) => rm(path.join(directory, "native", "windows", "bin", "renderer.exe")),
    async (directory) => writeFile(path.join(directory, "runtime", "unlisted.mjs"), "extra"),
    async (directory) => {
      try {
        await symlink(path.join(directory, "runtime", "server", "index.mjs"), path.join(directory, "runtime", "alias.mjs"));
      } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") return false;
        throw error;
      }
      return true;
    },
  ]) {
    const directory = await fixture();
    try {
      if (await mutation(directory) === false) continue;
      await assert.rejects(verifyReferenceManifest(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("power-boundary model never executes a non-durable or unverified pointed release", () => {
  const boundaries = [
    { name: "build complete", gate: false, pointer: "old", durable: false, exact: false, starts: true },
    { name: "manifest cached", gate: false, pointer: "old", durable: false, exact: true, starts: true },
    { name: "payload files flushed", gate: false, pointer: "old", durable: true, exact: true, starts: true },
    { name: "upgrade gate", gate: true, pointer: "old", durable: true, exact: true, starts: false },
    { name: "partial release cannot be pointed", gate: true, pointer: "new", durable: false, exact: false, starts: false, healthToken: true },
    { name: "write-through release move", gate: true, pointer: "old", durable: true, exact: true, starts: false },
    { name: "published manifest verified", gate: true, pointer: "old", durable: true, exact: true, starts: false },
    { name: "new pointer under gate", gate: true, pointer: "new", durable: true, exact: true, starts: false },
    { name: "gate cleared", gate: false, pointer: "new", durable: true, exact: true, starts: true },
    { name: "post-commit payload truncated", gate: false, pointer: "new", durable: true, exact: false, starts: false },
  ];
  for (const boundary of boundaries) {
    const selectedReleaseIsRunnable = boundary.pointer === "old" || (boundary.durable && boundary.exact);
    const launcherStarts = !boundary.gate && selectedReleaseIsRunnable;
    const healthLauncherStarts = boundary.gate && boundary.healthToken === true &&
      boundary.pointer === "new" && boundary.durable && boundary.exact;
    assert.equal(launcherStarts, boundary.starts, boundary.name);
    if (!boundary.durable || !boundary.exact) {
      assert.equal(healthLauncherStarts, false, `${boundary.name}: health bypass executed invalid payload`);
    }
    if (boundary.pointer === "new" && (!boundary.durable || !boundary.exact)) {
      assert.equal(launcherStarts, false, `${boundary.name}: invalid committed payload executed`);
    }
  }
});
