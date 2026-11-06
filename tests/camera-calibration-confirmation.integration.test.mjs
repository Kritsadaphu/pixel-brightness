import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";

async function json(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function correctionReceipt(outputId, artifacts) {
  const payload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: digest("camera-ack-renderer-config"),
    outputs: [{
      id: outputId,
      processingBypass: false,
      artifacts: {
        warpMeshSha256: digest("camera-ack-warp"),
        blendMapSha256: artifacts.blendWeight.sha256,
        blackMapSha256: artifacts.blackPedestal.sha256,
        maskSha256: artifacts.mask.sha256,
        colorLutSha256: artifacts.lut.sha256,
      },
    }],
  };
  return { ...payload, fingerprint: digest(canonicalJson(payload)) };
}

test("camera reference confirmation is bound to the exact live step and cannot be replayed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-confirm-"));
  let server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await server.control.register({
      protocolVersion: 1,
      nodeId: "camera-confirm-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const project = server.control.getProject();
    await server.control.saveProject({
      ...project,
      outputs: project.outputs.map((output) => output.id === "A"
        ? { ...output, nodeId: "camera-confirm-node" }
        : output),
    });
    const started = await server.control.startCameraCalibration({
      mode: "measured",
      nodeId: "camera-confirm-node",
      outputIds: ["A"],
      mesh: { columns: 2, rows: 2 },
      settleFrames: 1,
    });
    const waitingStep = started.calibration.plan.steps.find((step) => step.requiresOperatorConfirmation === true
      || step.captureConditions?.requiresOperatorConfirmation === true);
    assert.ok(waitingStep, "V2 plan must contain a physical reference confirmation gate");
    const confirmationId = "confirmation-fixture-01";
    await server.control.heartbeat("camera-confirm-node", {
      protocolVersion: 1,
      status: "ready",
      ackSequence: started.command.sequence,
      cameraCalibration: {
        sessionId: started.calibration.sessionId,
        state: "capturing",
        stepIndex: waitingStep.sequence,
        completedSteps: 0,
        operatorPrompt: {
          state: "waiting",
          stepId: waitingStep.id,
          confirmationId,
          title: "Physical reference",
          instructions: waitingStep.operatorPrompt || waitingStep.captureConditions.operatorPrompt,
          conditions: ["opticalPath:blocked"],
          requestedAt: new Date().toISOString(),
        },
      },
    });

    const wrong = await json(baseUrl, `/v1/calibrations/camera/${encodeURIComponent(started.calibration.sessionId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, stepId: waitingStep.id, confirmationId: "stale" }),
    });
    assert.equal(wrong.response.status, 409);
    assert.equal(wrong.body.error.code, "camera_calibration_confirmation_mismatch");

    const confirmed = await json(baseUrl, `/v1/calibrations/camera/${encodeURIComponent(started.calibration.sessionId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, stepId: waitingStep.id, confirmationId }),
    });
    assert.equal(confirmed.response.status, 202);
    assert.equal(confirmed.body.command.type, "confirm-camera-calibration");
    assert.equal(confirmed.body.calibration.operatorPrompt.state, "confirmation-queued");
    assert.deepEqual(confirmed.body.calibration.confirmationCommands, [{
      id: confirmed.body.command.id,
      sequence: confirmed.body.command.sequence,
      type: "confirm-camera-calibration",
      stepId: waitingStep.id,
      confirmationId,
      confirmationLeaseId: waitingStep.confirmationLeaseId,
      confirmedAt: confirmed.body.command.payload.confirmedAt,
    }]);

    const replay = await json(baseUrl, `/v1/calibrations/camera/${encodeURIComponent(started.calibration.sessionId)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, stepId: waitingStep.id, confirmationId }),
    });
    assert.equal(replay.response.status, 409);

    const firstFailedAt = new Date(Date.now() - 1_000).toISOString();
    const deadLetteredAt = new Date().toISOString();
    const deadLetterId = "command_dead_letter_44444444444444444444444444444444";
    const deadLetter = {
      schemaVersion: 1,
      deadLetterId,
      nodeId: "camera-confirm-node",
      command: {
        id: confirmed.body.command.id,
        sequence: confirmed.body.command.sequence,
        type: confirmed.body.command.type,
      },
      attempts: 2,
      retryBudget: 2,
      safetyCritical: true,
      firstFailedAt,
      lastFailedAt: deadLetteredAt,
      deadLetteredAt,
      errors: [
        { attempt: 1, failedAt: firstFailedAt, name: "Error", code: "CAMERA_CONFIRM_FAILED", message: "confirm failed" },
        { attempt: 2, failedAt: deadLetteredAt, name: "Error", code: "CAMERA_CONFIRM_FAILED", message: "confirm failed" },
      ],
      failClosed: { active: true, blackApplied: true, enforcementError: null },
    };
    await server.control.heartbeat("camera-confirm-node", { commandDeadLetters: [deadLetter] });
    const failed = server.store.state.cameraCalibrations[started.calibration.sessionId];
    assert.equal(failed.state, "failed");
    assert.equal(failed.failure.code, "COMMAND_DEAD_LETTERED");
    assert.equal(failed.failure.details.deadLetterId, deadLetterId);

    const stale = await server.control.heartbeat("camera-confirm-node", {
      cameraCalibration: {
        sessionId: started.calibration.sessionId,
        state: "capturing",
        stepIndex: waitingStep.sequence,
        completedSteps: 0,
        operatorPrompt: null,
      },
    });
    assert.equal(stale.acknowledgedCameraCalibrationId, started.calibration.sessionId);
    assert.equal(server.store.state.cameraCalibrations[started.calibration.sessionId].state, "failed");

    await server.close();
    server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
    const restored = server.store.state.cameraCalibrations[started.calibration.sessionId];
    assert.equal(restored.state, "failed");
    assert.equal(restored.failure.details.deadLetterId, deadLetterId);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("camera calibration refuses a plan queued behind a newer project revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-start-race-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await server.control.register({
      protocolVersion: 1,
      nodeId: "camera-start-race-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredGate = new Promise((resolve) => { entered = resolve; });
    const advanceProject = server.store.transaction(async (state) => {
      entered();
      await gate;
      state.project = {
        ...state.project,
        revision: Number(state.project.revision) + 1,
        updatedAt: new Date().toISOString(),
      };
    });
    await enteredGate;

    const start = server.control.startCameraCalibration({
      mode: "simulation",
      nodeId: "camera-start-race-node",
      outputIds: ["A"],
      mesh: { columns: 2, rows: 2 },
      settleFrames: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await advanceProject;
    await assert.rejects(start, (error) => (
      error?.status === 409 && error?.code === "camera_calibration_project_stale"
    ));
    assert.equal(Object.keys(server.store.state.cameraCalibrations).length, 0);
    assert.equal((server.store.state.commandQueues["camera-start-race-node"] || []).filter(
      (command) => command.type === "start-camera-calibration",
    ).length, 0);
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("camera apply is not acknowledged until both Node and renderer report the committed revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-apply-ack-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await server.control.register({
      protocolVersion: 1,
      nodeId: "camera-ack-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const revision = server.control.getProject().revision;
    const artifacts = {
      blendWeight: { sha256: digest("camera-ack-blend") },
      blackPedestal: { sha256: digest("camera-ack-black") },
      mask: { sha256: digest("camera-ack-mask") },
      lut: { sha256: digest("camera-ack-lut") },
    };
    const binding = correctionReceipt("A", artifacts);
    await server.store.transaction((state) => {
      state.cameraCalibrations["camera-ack-fixture"] = {
        sessionId: "camera-ack-fixture",
        nodeId: "camera-ack-node",
        state: "complete",
        projectApplied: true,
        projectCommitted: true,
        appliedRevision: revision,
        rendererAcknowledged: false,
        rendererAcknowledgedAt: null,
        rendererCorrectionBinding: null,
        plan: { outputs: [{ id: "A" }] },
        manifest: { outputs: [{ outputId: "A", artifacts }] },
        opticalVerification: { state: "pending-renderer-ack", required: true, verifiedAt: null, reason: null },
      };
      return true;
    });
    await server.control.heartbeat("camera-ack-node", {
      status: "ready",
      telemetry: {
        projectRevision: revision,
        renderer: { ready: true, connected: true, projectRevision: revision - 1 },
      },
    });
    assert.equal(server.store.state.cameraCalibrations["camera-ack-fixture"].rendererAcknowledged, false);

    await server.control.heartbeat("camera-ack-node", {
      status: "ready",
      telemetry: {
        projectRevision: revision,
        renderer: {
          ready: true,
          connected: true,
          projectRevision: revision,
          correctionBindingMatches: true,
          activeCorrectionBinding: binding,
          activeCorrectionFingerprint: binding.fingerprint,
        },
      },
    });
    const acknowledged = server.store.state.cameraCalibrations["camera-ack-fixture"];
    assert.equal(acknowledged.rendererAcknowledged, true);
    assert.ok(Number.isFinite(Date.parse(acknowledged.rendererAcknowledgedAt)));
    assert.equal(acknowledged.opticalVerification.state, "pending-optical-capture");
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("renderer acknowledgement discovered behind a queued transaction is persisted atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pixel-brightness-camera-ack-race-"));
  const server = await createPixelBrightnessServer({ dataDir: root, offlineAfterMs: 60_000 });
  try {
    await server.control.register({
      protocolVersion: 1,
      nodeId: "camera-ack-race-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const revision = server.control.getProject().revision;
    const artifacts = {
      blendWeight: { sha256: digest("camera-race-blend") },
      blackPedestal: { sha256: digest("camera-race-black") },
      mask: { sha256: digest("camera-race-mask") },
      lut: { sha256: digest("camera-race-lut") },
    };
    const binding = correctionReceipt("A", artifacts);
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const enteredGate = new Promise((resolve) => { entered = resolve; });
    const installPendingCalibration = server.store.transaction(async (state) => {
      entered();
      await gate;
      state.cameraCalibrations["camera-ack-race-fixture"] = {
        sessionId: "camera-ack-race-fixture",
        nodeId: "camera-ack-race-node",
        state: "complete",
        projectApplied: true,
        projectCommitted: true,
        appliedRevision: revision,
        rendererAcknowledged: false,
        rendererAcknowledgedAt: null,
        rendererCorrectionBinding: null,
        plan: { outputs: [{ id: "A" }] },
        manifest: { outputs: [{ outputId: "A", artifacts }] },
        opticalVerification: { state: "pending-renderer-ack", required: true, verifiedAt: null, reason: null },
      };
    });
    await enteredGate;

    // The heartbeat computes its cheap persistence hints while the preceding
    // transaction has not yet published the pending calibration. Its final
    // durability decision must therefore be made inside the serialized draft.
    const heartbeat = server.control.heartbeat("camera-ack-race-node", {
      status: "ready",
      telemetry: {
        projectRevision: revision,
        renderer: {
          ready: true,
          connected: true,
          projectRevision: revision,
          correctionBindingMatches: true,
          activeCorrectionBinding: binding,
          activeCorrectionFingerprint: binding.fingerprint,
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await installPendingCalibration;
    await heartbeat;

    const durable = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(durable.cameraCalibrations["camera-ack-race-fixture"].rendererAcknowledged, true);
    assert.ok(Number.isFinite(Date.parse(
      durable.cameraCalibrations["camera-ack-race-fixture"].rendererAcknowledgedAt,
    )));
  } finally {
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
