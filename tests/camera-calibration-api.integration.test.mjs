import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";

function markerlessLensProfile() {
  return createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "A7IV-UNIT-001" },
    lens: { manufacturer: "Sony", model: "FE 16-35mm F2.8 GM II", serialNumber: "GM2-UNIT-001" },
    frame: { width: 64, height: 36 },
    capture: { focalLengthMm: 16, focusDistanceM: 4, apertureFNumber: 5.6 },
    intrinsics: { fx: 40, fy: 40, cx: 32, cy: 18 },
    distortion: { model: "brown-conrady-v1", k1: -0.04, k2: 0.005, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.2,
      maxResidualPx: 0.6,
      imageCount: 30,
    },
  });
}

async function waitFor(predicate, { timeoutMs = 8_000, intervalMs = 20, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}; last=${JSON.stringify(last)}`);
}

function nodeConfig(serverUrl, dataDir) {
  return {
    protocolVersion: 1,
    nodeId: "camera-node-01",
    name: "Camera node",
    version: "0.3.0-test",
    serverUrl,
    dataDir,
    platform: "linux",
    rendererBackend: "simulator",
    outputs: [{
      id: "A",
      name: "Projector A",
      connector: "DP-1",
      enabled: true,
      resolution: { width: 64, height: 36, refreshNum: 60, refreshDen: 1 },
    }],
    heartbeatMs: 50,
    clockSyncMs: 60_000,
    clockSyncRounds: 3,
    pollWaitMs: 100,
    requestTimeoutMs: 2_000,
    hostTelemetryMs: 60_000,
    maxAssetBytes: 8 * 1024 * 1024,
    logLevel: "error",
    nodeToken: null,
    allowPowerActions: false,
    hostActionsDryRun: true,
  };
}

async function json(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  assert.ok(response.ok, `${response.status} ${JSON.stringify(body)}`);
  return body;
}

test("Web API drives a node simulation end-to-end and measured Canon mode fails honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-api-"));
  const server = await createPixelBrightnessServer({ dataDir: join(root, "server"), offlineAfterMs: 2_000 });
  let node;
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    node = new PixelBrightnessNode(nodeConfig(baseUrl, join(root, "node")));
    await node.start();
    await waitFor(() => server.control.stateSnapshot().nodes.length === 1, { message: "camera node registration" });

    const project = server.control.getProject();
    await server.control.saveProject({
      ...project,
      outputs: [{
        ...project.outputs[0],
        id: "A",
        nodeId: "camera-node-01",
        connector: "DP-1",
        resolution: { width: 64, height: 36, refreshNum: 60, refreshDen: 1 },
        sourceViewport: { x: 0, y: 0, width: 64, height: 36 },
        warp: { columns: 2, rows: 2 },
      }],
      canvas: { width: 64, height: 36, frameRateNum: 60, frameRateDen: 1 },
      compositionSource: {
        ...project.compositionSource,
        width: 64,
        height: 36,
        frameRateNum: 60,
        frameRateDen: 1,
      },
    });
    await waitFor(() => node.diagnostics().projectRevision === server.control.getProject().revision, {
      message: "small camera test project sync",
    });

    const revisionBefore = server.control.getProject().revision;
    const lensProfile = markerlessLensProfile();
    const simulation = await json(baseUrl, "/v1/calibrations/camera", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "simulation",
        nodeId: "camera-node-01",
        outputIds: ["A"],
        mesh: { columns: 2, rows: 2, minimumConfidence: 0.05 },
        settleFrames: 1,
        lensProfile,
        surfaceSurveys: [{
          id: "north-wall-survey",
          wallId: "wall-north",
          cameraViewId: "camera-view-north",
          frame: { width: 64, height: 36 },
          lensProfileSha256: lensProfile.sha256,
          boundary: [{ x: 0.05, y: 0.1 }, { x: 0.95, y: 0.1 }, { x: 0.95, y: 0.9 }, { x: 0.05, y: 0.9 }],
        }],
      }),
    });
    assert.equal(simulation.calibration.state, "queued");
    assert.equal(simulation.calibration.plan.outputs[0].surfaceTarget.surveyId, "north-wall-survey");
    assert.equal(simulation.calibration.plan.outputs[0].surfaceTarget.wallId, "wall-north");
    const simulatedResult = await waitFor(() => {
      const latest = server.control.getCameraCalibration(simulation.calibration.sessionId).calibration;
      return new Set(["complete", "failed", "cancelled"]).has(latest.state) ? latest : null;
    }, { message: "simulated camera calibration completion" });
    assert.equal(simulatedResult.state, "complete", JSON.stringify(simulatedResult.error));
    assert.equal(simulatedResult.manifest.provenance, "simulated");
    assert.equal(simulatedResult.manifest.applicable, false);
    assert.equal(simulatedResult.manifest.outputs[0].geometry.status, "simulated");
    assert.equal(simulatedResult.manifest.outputs[0].geometry.lensProfileSha256, lensProfile.sha256);
    assert.equal(simulatedResult.manifest.outputs[0].geometry.gates.passed, true);
    assert.equal(simulatedResult.projectApplied, false);
    assert.equal(server.control.getProject().revision, revisionBefore, "simulation must never mutate the projector project");

    const measured = await json(baseUrl, "/v1/calibrations/camera", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "measured",
        nodeId: "camera-node-01",
        outputIds: ["A"],
        mesh: { columns: 2, rows: 2 },
        settleFrames: 1,
      }),
    });
    const failed = await waitFor(() => {
      const latest = server.control.getCameraCalibration(measured.calibration.sessionId).calibration;
      return latest.state === "failed" ? latest : null;
    }, { message: "honest Canon adapter failure" });
    assert.equal(failed.failure.code, "CANON_EDSDK_ADAPTER_UNAVAILABLE");
    assert.equal(failed.progress.completedSteps, 0);
    assert.equal(failed.projectApplied, false);
    assert.equal(server.control.getProject().revision, revisionBefore);

    const latest = await json(baseUrl, "/v1/calibrations/camera/latest");
    assert.equal(latest.calibration.sessionId, measured.calibration.sessionId);
    assert.equal(latest.calibration.state, "failed");

    await server.store.flush();
    const strictProbeRoot = join(root, "strict-hydration-probe");
    await mkdir(strictProbeRoot, { recursive: true });
    await writeFile(
      join(strictProbeRoot, "state.json"),
      await readFile(join(root, "server", "state.json"), "utf8"),
      "utf8",
    );
    const strictProbe = await createPixelBrightnessServer({ dataDir: strictProbeRoot, offlineAfterMs: 2_000 });
    assert.equal(
      strictProbe.store.state.cameraCalibrations[simulation.calibration.sessionId].manifest.provenance,
      "simulated",
    );
    assert.equal(strictProbe.store.state.cameraCalibrations[measured.calibration.sessionId].state, "failed");
    await strictProbe.close();
  } finally {
    await node?.stop().catch(() => {});
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
