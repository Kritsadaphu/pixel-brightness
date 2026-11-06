import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("native flip-model telemetry separates submissions from monitor display statistics", async () => {
  const [surface, telemetry, tracker, renderer, cmake, contract] = await Promise.all([
    source("native/windows/src/OutputSurface.cpp"),
    source("native/windows/src/Telemetry.cpp"),
    source("native/windows/src/DisplayTiming.cpp"),
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/CMakeLists.txt"),
    source("native/windows/ipc/contract.md"),
  ]);

  assert.match(surface, /DXGI_SWAP_EFFECT_FLIP_DISCARD/);
  assert.match(surface, /GetLastPresentCount/);
  assert.match(surface, /GetFrameStatistics/);
  assert.match(surface, /DXGI_ERROR_FRAME_STATISTICS_DISJOINT/);
  assert.match(surface, /DXGI_STATUS_OCCLUDED/);
  assert.match(surface, /zero-statistics/);
  assert.match(renderer, /DwmFlush/);
  assert.match(renderer, /display-occluded/);
  assert.match(renderer, /milliseconds\(500\)/);
  assert.match(cmake, /dwmapi/);

  assert.match(telemetry, /"presentSubmissions"/);
  assert.match(telemetry, /"displayTiming"/);
  assert.match(telemetry, /"syncInterval", vsync \? 1 : 0/);
  assert.match(telemetry, /"cadenceMetricsApplicable", vsync/);
  assert.match(telemetry, /"presentCount"/);
  assert.match(telemetry, /"presentRefreshCount"/);
  assert.match(telemetry, /"syncRefreshCount"/);
  assert.match(telemetry, /"syncQpcTime"/);
  assert.match(telemetry, /"phaseProof", false/);
  assert.match(telemetry, /"multiMonitorReliability", "platform-dependent"/);
  assert.doesNotMatch(telemetry, /"renderedFrames"|"presentFailures"|"lastPresentQpc"/);

  assert.match(tracker, /presentDelta > refreshDelta/);
  assert.match(tracker, /refreshDelta > presentDelta/);
  assert.match(tracker, /latePresentEvents_/);
  assert.match(cmake, /pbwin-display-timing-contract/);
  assert.match(contract, /must not replace[\s\S]*unknown values with zero/);
});
