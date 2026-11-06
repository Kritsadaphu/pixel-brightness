import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const rootPath = dirname(fileURLToPath(new URL("package.json", root)));

async function source(pathname) {
  return readFile(new URL(pathname, root), "utf8");
}

test("native renderer has an authenticated boot-black barrier before every content frame", async () => {
  const [surface, renderer, rendererHeader, main, contract, launcher, daemon, telemetry, engine] = await Promise.all([
    source("native/windows/src/OutputSurface.cpp"),
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/include/pbwin/RendererApp.hpp"),
    source("native/windows/src/main.cpp"),
    source("runtime/node/windows-renderer-contract.mjs"),
    source("deploy/windows/Start-PixelBrightness.ps1"),
    source("runtime/node/daemon.mjs"),
    source("native/windows/src/Telemetry.cpp"),
    source("runtime/node/windows-native-engine.mjs"),
  ]);

  const initialize = surface.slice(
    surface.indexOf("void OutputSurface::Initialize"),
    surface.indexOf("void OutputSurface::CreateSwapChain"),
  );
  assert.match(initialize, /PresentBlack\(graphics\)/);
  assert.doesNotMatch(initialize, /blank_\s*=\s*false/,
    "surface initialization must not clear its black default");

  const renderFrame = renderer.slice(
    renderer.indexOf("void RendererApp::RenderFrame"),
    renderer.indexOf("void RendererApp::UpdateTelemetry"),
  );
  assert.ok(renderFrame.indexOf("BootBlackLocked()") >= 0);
  assert.ok(renderFrame.indexOf("KeepOutputsBlack()") < renderFrame.indexOf("compositionInput_.Poll"),
    "boot latch must force black before native code can sample or render content");
  assert.match(rendererHeader, /BootBlackLock bootBlackLock_/);

  const releaseHandler = renderer.slice(
    renderer.indexOf('request.type == "release-boot-black"'),
    renderer.indexOf('request.type == "apply-config"'),
  );
  assert.match(releaseHandler, /authorizationToken/);
  assert.match(releaseHandler, /bootBlackLock_\.Release\(authorizationDigest\)/);
  const applyHandler = renderer.slice(
    renderer.indexOf('request.type == "apply-config"'),
    renderer.indexOf('request.type == "set-pattern"'),
  );
  assert.match(applyHandler, /AuthenticatedMutationPayload/,
    "pre-release config must require the same local per-process credential without clearing the latch");
  assert.match(applyHandler, /Sha256Hex\(configPayload\.dump\(\)\)/,
    "native apply receipt must hash the exact canonical normalized config received from Node");
  assert.match(renderer, /AuthenticatedMutationPayload[\s\S]*authorization\.Authorize\(authorizationDigest\)/);
  assert.match(renderer, /BuildActiveCorrectionBinding\([\s\S]*activeCorrectionBinding_\.configSha256/,
    "display recovery must retain the committed config receipt instead of synthesizing a new digest");
  const patternHandler = renderer.slice(
    renderer.indexOf('request.type == "set-pattern"'),
    renderer.indexOf('request.type == "blank"'),
  );
  assert.match(patternHandler, /AuthenticatedMutationPayload[\s\S]*BootBlackLocked\(\)[\s\S]*unavailable while boot black is locked/);
  const blankHandler = renderer.slice(
    renderer.indexOf('request.type == "blank"'),
    renderer.indexOf('request.type == "shutdown"'),
  );
  assert.match(blankHandler, /AuthenticatedMutationPayload[\s\S]*BootBlackLocked\(\)[\s\S]*blank\(false\) is unavailable/);
  const shutdownHandler = renderer.slice(
    renderer.indexOf('request.type == "shutdown"'),
    renderer.indexOf("} else {", renderer.indexOf('request.type == "shutdown"')),
  );
  assert.match(shutdownHandler, /RequireMutationAuthorization/);
  const engineRelease = engine.slice(
    engine.indexOf("async releaseBootBlack()"),
    engine.indexOf("discardBootBlackAuthorization()"),
  );
  assert.doesNotMatch(engineRelease, /rendererBootToken\s*=\s*null/,
    "Node must retain the per-process token for lifetime mutation authentication");
  assert.match(engine, /#authenticatedMutation[\s\S]*lifetimeMutationAuthentication/);
  assert.match(engine, /candidateBinding\.configSha256 !== expectedConfigSha256/,
    "Node must reject a self-consistent native binding for any config other than the exact sent DTO");
  assert.match(main, /PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN is required/);
  assert.match(main, /Sha256Hex\(raw\)/);
  assert.match(contract, /"release-boot-black"/);
  assert.match(telemetry, /"bootBlackLocked", bootBlackLocked/);

  const tokenCreation = launcher.indexOf("PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN = New-RendererBootToken");
  const rendererLaunch = launcher.indexOf("Start-Process -FilePath $renderer");
  const nodeLaunch = launcher.indexOf("Start-Process -FilePath $node", rendererLaunch);
  assert.ok(tokenCreation >= 0 && tokenCreation < rendererLaunch && rendererLaunch < nodeLaunch,
    "one ephemeral authorization must be inherited by Renderer and Node in that order");
  assert.match(launcher, /RandomNumberGenerator\]::Create\(\)/);
  assert.match(launcher, /Remove-Item Env:PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN/);

  const startMethod = daemon.slice(
    daemon.indexOf("async start()"),
    daemon.indexOf("async stop()", daemon.indexOf("async start()")),
  );
  const storeInit = startMethod.indexOf("saved = await this.store.initialize()");
  const lockHydration = startMethod.indexOf("this.stateRecoverySafetyLock = saved.stateRecoverySafetyLock");
  const reconcileCall = startMethod.indexOf("await this.#reconcilePersistedPreparedState(saved, project)");
  const releasePending = startMethod.indexOf("this.bootBlackReleasePending = true");
  const taskStart = startMethod.indexOf("this.tasks = [");
  assert.ok(storeInit >= 0
    && storeInit < lockHydration
    && lockHydration < reconcileCall
    && reconcileCall < releasePending
    && releasePending < taskStart,
  "Node must arm, but not clear, boot black only after local lock/cache hydration");
  assert.match(startMethod.slice(lockHydration, taskStart),
    /retainedStartupSafetyLock = this\.cameraOpticalVerificationFailClosed[\s\S]*commandFailureSafetyLock\?\.status === "active"[\s\S]*stateRecoverySafetyLock\?\.status === "active"/);
  assert.match(startMethod.slice(lockHydration, taskStart),
    /if \(retainedStartupSafetyLock\)[\s\S]*discardBootBlackAuthorization[\s\S]*else \{[\s\S]*cacheReady[\s\S]*bootBlackReleasePending = true/,
  "retained locks must destroy authorization rather than merely skip release once");
  assert.doesNotMatch(startMethod, /releaseBootBlack\(/,
    "local startup must never release before authoritative Server reconciliation");

  const connectionLoop = daemon.slice(
    daemon.indexOf("async #connectionLoop()"),
    daemon.indexOf("async #pollUntilFailure()", daemon.indexOf("async #connectionLoop()")),
  );
  const register = connectionLoop.indexOf("await this.client.register");
  const validateCursor = connectionLoop.indexOf("await this.#validateRegistrationCursor(registration)");
  const syncProject = connectionLoop.indexOf("await this.#syncProject(registration.project)");
  const serverReconcile = connectionLoop.indexOf("await this.#reconcileServerState()");
  const completeRelease = connectionLoop.indexOf("await this.#completeAuthoritativeBootRelease()");
  const connected = connectionLoop.indexOf("this.connected = true");
  assert.ok(register >= 0
    && register < validateCursor
    && validateCursor < syncProject
    && syncProject < serverReconcile
    && serverReconcile < completeRelease
    && completeRelease < connected,
  "boot release must follow authoritative registration, cursor proof and scoped cache reconciliation");
  const cursorValidation = daemon.slice(
    daemon.indexOf("async #validateRegistrationCursor"),
    daemon.indexOf("async #completeAuthoritativeBootRelease"),
  );
  assert.match(cursorValidation, /registration\?\.node\?\.ackSequence/);
  assert.match(cursorValidation, /registration\?\.node\?\.commandSequence/);
  assert.match(cursorValidation,
    /localSequence < serverAckSequence[\s\S]*NODE_COMMAND_CURSOR_ROLLBACK/);
  assert.match(cursorValidation,
    /localSequence > serverAckSequence[\s\S]*NODE_COMMAND_CURSOR_UNACKNOWLEDGED/);
  assert.match(cursorValidation,
    /serverCommandSequence < localSequence[\s\S]*SERVER_COMMAND_CURSOR_ROLLBACK/);
  const pollMethod = daemon.slice(
    daemon.indexOf("async #pollUntilFailure()"),
    daemon.indexOf("async #heartbeatLoop()", daemon.indexOf("async #pollUntilFailure()")),
  );
  const resetBlock = pollMethod.slice(
    pollMethod.indexOf("if (response?.resetRequired)"),
    pollMethod.indexOf("const commands =", pollMethod.indexOf("if (response?.resetRequired)")),
  );
  assert.match(resetBlock, /SERVER_COMMAND_HISTORY_GAP/);
  assert.doesNotMatch(resetBlock, /lastSequence\s*=/,
    "a truncated Server history must lock black instead of skipping the durable cursor");
  const releaseMethod = daemon.slice(
    daemon.indexOf("async #completeAuthoritativeBootRelease()"),
    daemon.indexOf("async #connectionLoop()"),
  );
  assert.match(releaseMethod,
    /cameraOpticalVerificationFailClosed[\s\S]*commandFailureSafetyLock[\s\S]*stateRecoverySafetyLock[\s\S]*discardBootBlackAuthorization/);
  assert.match(releaseMethod, /if \(!this\.cacheReady\)[\s\S]*await this\.engine\.releaseBootBlack\(\)/,
    "authoritative release must require explicit verified cache readiness");
  const reconcileMethod = daemon.slice(
    daemon.indexOf("async #reconcilePersistedPreparedState"),
    daemon.indexOf("async #prepare", daemon.indexOf("async #reconcilePersistedPreparedState")),
  );
  const ensure = reconcileMethod.indexOf("await this.cache.ensureAll(assets)");
  const prepare = reconcileMethod.indexOf("await this.engine.prepare({ assets: cached })");
  const persist = reconcileMethod.indexOf("await this.#persist()");
  const cacheReady = reconcileMethod.indexOf("this.cacheReady = true");
  assert.ok(ensure >= 0 && ensure < prepare && prepare < persist && persist < cacheReady,
    "cache readiness must follow verified assets, engine prepare, and durable Node state");
  assert.match(daemon, /cacheReady: this\.cacheReady === true/,
    "heartbeat must never infer cache proof from transport status");
  assert.doesNotMatch(daemon.slice(
    daemon.indexOf("catch (error)", storeInit),
    daemon.indexOf("await this.cameraCalibrationManifestArchive.initialize()", storeInit),
  ), /releaseBootBlack/,
  "unrecoverable state initialization may only reinforce black, never authorize release");
});

test("boot-black latch policy executes as strict portable C++", async (context) => {
  if (process.platform === "win32") {
    context.skip("the same source is compiled by the Windows CMake/CTest target");
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "pbwin-boot-black-"));
  const binary = join(temporary, "boot-black-lock-test");
  const compiler = process.env.CXX || "c++";
  try {
    await execFileAsync(compiler, [
      "-std=c++20",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-Werror",
      "-I",
      join(rootPath, "native/windows/include"),
      join(rootPath, "native/windows/tests/BootBlackLockTests.cpp"),
      join(rootPath, "native/windows/src/BootBlackLock.cpp"),
      "-o",
      binary,
    ], { timeout: 30_000 });
    await execFileAsync(binary, [], { timeout: 10_000 });
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip(`portable C++ compiler unavailable: ${compiler}`);
      return;
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
