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

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("native named-pipe listener retries setup faults and renderer exits fail-closed", async () => {
  const [
    policyHeader,
    policy,
    pipeHeader,
    pipe,
    renderer,
    telemetry,
    persistence,
    harness,
    cmake,
    contract,
    readme,
  ] = await Promise.all([
    source("native/windows/include/pbwin/PipeListenerRecoveryPolicy.hpp"),
    source("native/windows/src/PipeListenerRecoveryPolicy.cpp"),
    source("native/windows/include/pbwin/NamedPipeServer.hpp"),
    source("native/windows/src/NamedPipeServer.cpp"),
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/src/Telemetry.cpp"),
    source("native/windows/src/TelemetryPersistence.cpp"),
    source("native/windows/tests/NamedPipeTests.cpp"),
    source("native/windows/CMakeLists.txt"),
    source("native/windows/ipc/contract.md"),
    source("native/windows/README.md"),
  ]);

  assert.match(policyHeader, /kInitialRetryDelayMs\s*=\s*50/);
  assert.match(policyHeader, /kMaximumRetryDelayMs\s*=\s*1000/);
  assert.match(policyHeader, /kMaximumFailures\s*=\s*8/);
  assert.match(policy, /consecutiveFailures_ >= kMaximumFailures[\s\S]{0,180}PipeListenerPhase::fatal/);
  assert.match(policy, /kInitialRetryDelayMs << exponent[\s\S]{0,160}kMaximumRetryDelayMs/);
  assert.match(policy, /MarkConnected[\s\S]{0,220}consecutiveFailures_ = 0/,
    "only a proven controller connection may reset consecutive setup failures");

  assert.match(pipeHeader, /std::condition_variable_any listenerRetryReady_/);
  assert.match(pipe, /listenerRetryReady_\.wait_for\([\s\S]{0,180}stopToken/,
    "retry wait must be interruptible by renderer shutdown");
  const failureHandler = pipe.slice(
    pipe.indexOf("bool NamedPipeServer::HandleListenerFailure"),
    pipe.indexOf("void NamedPipeServer::MarkListenerListening"),
  );
  assert.doesNotMatch(failureHandler, /\bSleep\s*\(/,
    "listener failures must not use an uninterruptible or tight Sleep loop");
  assert.match(pipe, /HandleListenerFailure\([\s\S]{0,120}PipeListenerFailureStage::createPipe/);
  assert.match(pipe, /HandleListenerFailure\([\s\S]{0,120}PipeListenerFailureStage::connectionState/);
  assert.match(pipe, /PipeListenerFailureStage::connectEvent/);
  assert.match(pipe, /PipeListenerFailureStage::connectStart/);
  assert.match(pipe, /PipeListenerFailureStage::connectWait/);
  assert.match(pipe, /PipeListenerFailureStage::connectComplete/);
  assert.match(pipe, /listenerFatal_\.store\(true, std::memory_order_release\)/);

  const loop = renderer.slice(
    renderer.indexOf("while (running_)"),
    renderer.indexOf("} catch (...)"),
  );
  const firstFatalCheck = loop.indexOf("HandleFatalPipeListener()");
  const handleRequests = loop.indexOf("HandleRequests()");
  const lastFatalCheck = loop.lastIndexOf("HandleFatalPipeListener()");
  const renderFrame = loop.indexOf("RenderFrame()");
  assert.ok(firstFatalCheck >= 0 && firstFatalCheck < handleRequests,
    "fatal IPC health must be checked before accepting another command");
  assert.ok(lastFatalCheck > handleRequests && lastFatalCheck < renderFrame,
    "fatal IPC health must be rechecked before another content submission");

  const fatalHandler = renderer.slice(
    renderer.indexOf("bool RendererApp::HandleFatalPipeListener"),
    renderer.indexOf("void RendererApp::BeginRecovery"),
  );
  const black = fatalHandler.indexOf("KeepOutputsBlack(true, true)");
  const flush = fatalHandler.indexOf("graphics_.Context()->Flush()");
  const terminalUpdate = fatalHandler.indexOf("UpdateTelemetry(false)");
  const finalPublish = fatalHandler.indexOf("telemetry_.PublishFinal");
  assert.ok(black >= 0 && black < flush && flush < terminalUpdate && terminalUpdate < finalPublish,
    "fatal IPC handling must black and flush before terminal telemetry persistence");
  assert.match(renderer, /kIpcListenerFatalExitCode\s*=\s*70/);
  assert.match(loop, /exitCode = kIpcListenerFatalExitCode/);
  assert.match(telemetry, /"ipcListener", PipeListenerJson\(ipcListener\)/);
  assert.match(persistence, /TryPublishAndWait[\s\S]{0,900}wait_for\(lock, timeout/,
    "terminal telemetry persistence must remain bounded and use the async worker");

  assert.match(pipeHeader, /PB_NAMED_PIPE_FAULT_INJECTION/);
  assert.match(harness, /SetListenerFaultPlanForTesting\(\{1, 1, 1\}\)/,
    "Windows test must inject every listener setup stage and recover");
  assert.match(harness, /TestListenerExhaustion/);
  assert.match(harness, /elapsed >= std::chrono::seconds\(3\)/,
    "Windows exhaustion test must reject a tight retry loop");
  assert.match(cmake, /PB_NAMED_PIPE_FAULT_INJECTION=1/);
  assert.match(cmake, /pbwin-pipe-listener-recovery-policy-contract/);
  assert.match(contract, /exits with code 70/);
  assert.match(readme, /production Windows build[\s\S]{0,500}real projectors/);
});

test("pipe listener retry policy executes as portable C++", async (context) => {
  if (process.platform === "win32") {
    context.skip("the same policy is compiled by the Windows CMake/CTest target");
    return;
  }

  const temporary = await mkdtemp(join(tmpdir(), "pbwin-pipe-policy-"));
  const binary = join(temporary, "pipe-listener-policy-test");
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
      join(rootPath, "native/windows/tests/PipeListenerRecoveryPolicyTests.cpp"),
      join(rootPath, "native/windows/src/PipeListenerRecoveryPolicy.cpp"),
      "-o",
      binary,
    ], { timeout: 30_000 });
    const result = await execFileAsync(binary, [], { timeout: 10_000 });
    assert.match(result.stdout, /pipe listener recovery policy tests passed/);
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
