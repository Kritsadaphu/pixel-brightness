import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("native display faults recover in-process through one bounded black transaction", async () => {
  const [
    renderer,
    rendererHeader,
    policyHeader,
    policy,
    telemetry,
    surface,
    device,
    window,
    registry,
    cmake,
    contract,
    readme,
  ] = await Promise.all([
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/include/pbwin/RendererApp.hpp"),
    source("native/windows/include/pbwin/RecoveryPolicy.hpp"),
    source("native/windows/src/RecoveryPolicy.cpp"),
    source("native/windows/src/Telemetry.cpp"),
    source("native/windows/src/OutputSurface.cpp"),
    source("native/windows/src/D3DDevice.cpp"),
    source("native/windows/src/Win32Window.cpp"),
    source("native/windows/src/DisplayRegistry.cpp"),
    source("native/windows/CMakeLists.txt"),
    source("native/windows/ipc/contract.md"),
    source("native/windows/README.md"),
  ]);

  assert.match(renderer, /WM_DISPLAYCHANGE[\s\S]{0,180}BeginRecovery\(RecoveryTrigger::displayChange/,
    "display notifications must enter the recovery state machine");
  assert.doesNotMatch(rendererHeader, /displayChangePending_/,
    "a boolean latch cannot debounce multi-window WM_DISPLAYCHANGE bursts");
  assert.match(policyHeader, /kDisplayChangeDebounceMs = 750/);
  assert.match(policyHeader, /kMaximumRetryDelayMs = 4000/);
  assert.match(policyHeader, /kMaximumAttempts = 10/);
  assert.match(policy, /attempts_ >= kMaximumAttempts[\s\S]{0,160}RecoveryPhase::exhausted/,
    "retry must stop at a deterministic bound");
  assert.match(policy, /trigger_ == RecoveryTrigger::displayChange && attempts_ == 0[\s\S]{0,500}kDisplayChangeDebounceMs/,
    "a display burst must extend one quiet window instead of spawning rebuilds");

  assert.match(renderer, /frame-latency-wait-error[\s\S]{0,650}BeginRecovery\(RecoveryTrigger::frameLatencyFailure/);
  assert.doesNotMatch(renderer, /Frame-latency wait failed; renderer restart required/,
    "transient frame-latency failure must not terminate the renderer");
  assert.match(renderer, /DeviceRemovedReason\(\)[\s\S]{0,500}RecoveryTrigger::deviceRemoved/,
    "render failures must distinguish a removed D3D device");
  assert.match(device, /factory_\.Swap\(other\.factory_\)[\s\S]{0,300}device_\.Swap\(other\.device_\)/,
    "device recovery must exchange a complete independent D3D candidate");
  assert.match(renderer, /value_or\(graphics_\.AdapterLuid\(\)\)/,
    "an implicit adapter selection must stay pinned to the startup-committed GPU");
  assert.match(renderer, /PumpMessages\(\)[\s\S]{0,180}if \(recovery_\.Active\(\)\)[\s\S]{0,180}continue;[\s\S]{0,80}RenderFrame\(\)/,
    "a display message queued during the latency wait must be drained before content renders");

  const recovery = renderer.indexOf("void RendererApp::ServiceRecovery()");
  const oldBlack = renderer.indexOf("KeepOutputsBlack();", recovery);
  const newDevice = renderer.indexOf("D3DDevice rebuiltGraphics", oldBlack);
  const newOutputs = renderer.indexOf("BuildOutputs(config_, rebuiltGraphics, rebuilt)", newDevice);
  const restoredOverrides = renderer.indexOf("RestoreRuntimeOverrides(rebuilt)", newOutputs);
  const newSpout = renderer.indexOf("rebuiltInput.Initialize", restoredOverrides);
  const stagedBinding = renderer.indexOf("auto rebuiltBinding = BuildActiveCorrectionBinding", newSpout);
  const candidateBlack = renderer.indexOf("output->ValidateBlackPresent(rebuiltGraphics)", stagedBinding);
  const candidateDeviceCheck = renderer.indexOf("rebuiltGraphics.CheckRemoved()", candidateBlack);
  const outputSwap = renderer.indexOf("outputs_.swap(rebuilt)", candidateBlack);
  const deviceSwap = renderer.indexOf("graphics_.Swap(rebuiltGraphics)", outputSwap);
  const bindingCommit = renderer.indexOf("activeCorrectionBinding_ = std::move(rebuiltBinding)", deviceSwap);
  assert.ok(
    recovery >= 0 && oldBlack < newDevice && newDevice < newOutputs &&
      newOutputs < restoredOverrides && restoredOverrides < newSpout &&
      newSpout < stagedBinding && stagedBinding < candidateBlack &&
      candidateBlack < candidateDeviceCheck && candidateDeviceCheck < outputSwap &&
      outputSwap < deviceSwap && deviceSwap < bindingCommit,
    "recovery must stay black and commit its correction binding only after every candidate resource succeeds",
  );
  assert.match(renderer, /Keep the retired[\s\S]{0,180}windows alive[\s\S]{0,240}outputs_\.swap\(rebuilt\)/,
    "surviving old windows must remain black covers through candidate validation");
  assert.match(renderer, /RestoreRuntimeOverrides\(rebuilt\)/,
    "blank and calibration-pattern overrides must survive recovery");
  assert.match(renderer, /apply-config is unavailable while display recovery is active/,
    "a config request must not be acknowledged and then superseded by an active recovery generation");
  assert.match(surface, /MarkDisplayTimingRecovering[\s\S]{0,220}MarkUnavailable\("recovering"/,
    "stale scanout evidence must become unknown while recovery is active");
  assert.match(surface, /ValidateBlackPresent[\s\S]{0,700}result != S_OK/,
    "candidate black must reject failed and non-S_OK DXGI submission statuses");
  assert.doesNotMatch(window, /SetWindowPos\([\s\S]{0,260}SWP_SHOWWINDOW/,
    "candidate windows must remain hidden while GPU resources are loading");
  assert.match(window, /WM_ERASEBKGND[\s\S]{0,220}FillRect[\s\S]{0,180}BLACK_BRUSH/,
    "a not-yet-presented window must still paint a black background");

  assert.match(registry, /selector\.devicePath && !EqualInsensitive/);
  assert.match(registry, /selector\.gdiName && !EqualInsensitive/);
  assert.match(registry, /display\.adapterLuid != \*selector\.adapterLuid \|\| display\.targetId != \*selector\.targetId/);
  assert.match(registry, /if \(resolved\) return std::nullopt/,
    "ambiguous display identities must not substitute another target");

  assert.match(telemetry, /"recovery", RecoveryJson\(recovery\)/);
  assert.match(telemetry, /"retryInMilliseconds"/);
  assert.match(telemetry, /"deviceRecreated"/);
  assert.match(renderer, /display-recovery-started/);
  assert.match(renderer, /display-recovery-attempt/);
  assert.match(renderer, /display-recovery-retry-scheduled/);
  assert.match(renderer, /display-recovery-exhausted/);
  assert.match(renderer, /display-recovery-succeeded/);

  assert.match(cmake, /pbwin-recovery-policy-contract/,
    "the platform-neutral debounce/retry policy must run in native CTest");
  assert.match(contract, /display-recovery-started[\s\S]*display-recovery-succeeded/);
  assert.match(readme, /external watchdog, signal switcher\/shutter/,
    "software recovery must not claim guaranteed optical black during driver or cable loss");
});

test("live native config commits only after every candidate accepts black", async () => {
  const [renderer, rendererHeader, surface, contract, readme] = await Promise.all([
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/include/pbwin/RendererApp.hpp"),
    source("native/windows/src/OutputSurface.cpp"),
    source("native/windows/ipc/contract.md"),
    source("native/windows/README.md"),
  ]);

  const applyStart = renderer.indexOf("void RendererApp::ApplyConfig");
  const applyEnd = renderer.indexOf("void RendererApp::BuildOutputs", applyStart);
  const apply = renderer.slice(applyStart, applyEnd);
  const build = apply.indexOf("BuildOutputs(config, graphics_, candidateOutputs)");
  const binding = apply.indexOf("auto candidateBinding = BuildActiveCorrectionBinding", build);
  const validate = apply.indexOf("output->ValidateBlackPresent(graphics_)", binding);
  const oldBlack = apply.indexOf("output->PresentBlack(graphics_)", validate);
  const deviceCheck = apply.indexOf("graphics_.CheckRemoved()", oldBlack);
  const telemetry = apply.indexOf("telemetry_.Configure(config.telemetry)", deviceCheck);
  const inputCommit = apply.indexOf("compositionInput_ = std::move(candidateInput)", telemetry);
  const outputCommit = apply.indexOf("outputs_.swap(candidateOutputs)", inputCommit);
  const configCommit = apply.indexOf("std::swap(config_, config)", outputCommit);
  const bindingCommit = apply.indexOf("std::swap(activeCorrectionBinding_, candidateBinding)", configCommit);
  const healthy = apply.indexOf("outputsHealthy_ = true", bindingCommit);
  assert.ok(
    applyStart >= 0 && build >= 0 && build < binding && binding < validate &&
      validate < oldBlack && oldBlack < deviceCheck && deviceCheck < telemetry &&
      telemetry < inputCommit && inputCommit < outputCommit && outputCommit < configCommit &&
      configCommit < bindingCommit && bindingCommit < healthy,
    "candidate black/device/telemetry validation must precede one no-throw authority exchange",
  );
  assert.match(apply, /static_assert\(std::is_nothrow_move_assignable_v<SpoutInput>\)/);
  assert.match(apply, /static_assert\(std::is_nothrow_swappable_v<decltype\(outputs_\)>\)/);
  assert.match(apply, /static_assert\(std::is_nothrow_swappable_v<RendererConfig>\)/);
  assert.match(apply, /static_assert\(std::is_nothrow_swappable_v<ActiveCorrectionBinding>\)/);
  assert.match(apply, /catch \(const std::exception&\)[\s\S]{0,500}outputsHealthy_ = false[\s\S]{0,180}BeginRecovery\(RecoveryTrigger::deviceRemoved/,
    "device removal observed during apply must close the boot-release health gate");
  assert.doesNotMatch(apply.slice(0, telemetry), /config_\s*=|activeCorrectionBinding_\s*=/,
    "throwing candidate work must not change committed config or correction authority");
  assert.match(rendererHeader, /bool outputsHealthy_\{\};/,
    "startup health must remain false until checked candidate commit");

  const validateStart = surface.indexOf("void OutputSurface::ValidateBlackPresent");
  const validateEnd = surface.indexOf("void OutputSurface::PresentBlack", validateStart);
  const validateBlack = surface.slice(validateStart, validateEnd);
  assert.match(validateBlack, /result != S_OK/,
    "only an accepted S_OK submission may certify candidate black");
  assert.match(validateBlack, /DXGI_STATUS_OCCLUDED/,
    "DXGI_STATUS_OCCLUDED must be an explicit rejected candidate status");
  assert.match(contract, /DXGI_STATUS_OCCLUDED[\s\S]{0,420}previous committed/);
  assert.match(readme, /Live configuration[\s\S]{0,900}outputsHealthy/);
});
