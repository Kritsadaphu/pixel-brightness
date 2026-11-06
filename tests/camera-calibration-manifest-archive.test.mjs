import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CameraCalibrationOrchestrator,
  DeterministicPatternOverrideAdapter,
  DeterministicSimulatedCalibrationSolver,
  DeterministicSimulatedCameraAdapter,
  MeasuredCalibrationSolver,
} from "../runtime/node/camera-calibration.mjs";
import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import {
  CameraCalibrationManifestArchiveStore,
} from "../runtime/node/camera-calibration-manifest-archive.mjs";
import { loadNodeConfig, nodeHelp } from "../runtime/node/config.mjs";
import { NodeStateStore } from "../runtime/node/state-store.mjs";
import {
  createCameraCalibrationPlan,
  normalizeCameraCalibrationManifest,
} from "../runtime/shared/camera-calibration.mjs";
import { createCameraLensProfile } from "../runtime/shared/camera-lens-profile.mjs";
import { derivePlanarOutputTargets } from "../runtime/shared/camera-survey.mjs";
import { createCameraOpticalVerificationPlan } from "../runtime/shared/camera-verification.mjs";
import {
  COMMAND,
  createCommand,
  defaultProject,
  normalizeProject,
} from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

let executionLeaseCounter = 0;

function executionLease(nodeId, ttlMs = 1_000) {
  const issuedAtNs = epochNowNs();
  executionLeaseCounter += 1;
  return {
    schemaVersion: 1,
    leaseId: `execution_lease_${executionLeaseCounter.toString(16).padStart(32, "0")}`,
    nodeId,
    fenceGeneration: 0,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + BigInt(ttlMs) * 1_000_000n).toString(),
  };
}

class MeasuredSonyFixtureCamera extends DeterministicSimulatedCameraAdapter {
  constructor({
    now = () => new Date().toISOString(),
  } = {}) {
    super({ width: 64, height: 64, cameraId: "sony-a7iv-archive-fixture", now });
    this.camera = {
      ...this.camera,
      vendor: "Sony",
      model: "ILCE-7M4",
      serial: "ARCHIVE-A7IV-001",
      transport: "usb",
      backend: "test-physical-raw-fixture",
    };
  }

  async capture(context) {
    const capture = await super.capture(context);
    const rasterBytes = Buffer.from(capture.data.buffer, capture.data.byteOffset, capture.data.byteLength);
    capture.lens = {
      ...capture.lens,
      id: "archive-fixture-lens",
      vendor: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serial: "ARCHIVE-GM2-001",
      mount: "E",
      focalLengthMm: 16,
      focusDistanceM: 5,
    };
    capture.rasterSha256 = createHash("sha256").update(rasterBytes).digest("hex");
    capture.provenance = {
      decoder: {
        name: "archive-fixture-decoder",
        version: "1.0.0",
        binarySha256: createHash("sha256").update("archive-fixture-decoder-v1").digest("hex"),
      },
      rawDecode: {
        rawFormat: "PBRAW",
        sensorWidth: capture.width,
        sensorHeight: capture.height,
        cfaPattern: "RGGB",
        blackLevels: [0, 0, 0, 0],
        whiteLevels: [4_294_967_295, 4_294_967_295, 4_294_967_295, 4_294_967_295],
      },
      sourceSha256: createHash("sha256")
        .update(`archive-fixture-raw:${capture.id}:`)
        .update(rasterBytes)
        .digest("hex"),
      rasterSha256: capture.rasterSha256,
    };
    return capture;
  }
}

function lensProfile() {
  return createCameraLensProfile({
    schema: "pixel-brightness.camera-lens-profile.v1",
    camera: { manufacturer: "Sony", model: "ILCE-7M4", serialNumber: "ARCHIVE-A7IV-001" },
    lens: {
      manufacturer: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serialNumber: "ARCHIVE-GM2-001",
    },
    frame: { width: 64, height: 64 },
    capture: { focalLengthMm: 16, focusDistanceM: 5, apertureFNumber: 5.6 },
    intrinsics: { fx: 48, fy: 48, cx: 32, cy: 32 },
    distortion: { model: "brown-conrady-v1", k1: -0.03, k2: 0.002, k3: 0, p1: 0, p2: 0 },
    calibration: {
      method: "opencv-charuco-brown-conrady-v1",
      calibratedAt: "2026-08-01T00:00:00.000Z",
      rmsResidualPx: 0.18,
      maxResidualPx: 0.55,
      imageCount: 32,
    },
  });
}

function plan({ sessionId, outputId, wallId, cameraViewId }) {
  const profile = lensProfile();
  const outputs = [{
    id: outputId,
    resolution: { width: 64, height: 64 },
    wallId,
    sourceViewport: { x: outputId === "A" ? 0 : 64, y: 0, width: 64, height: 64 },
  }];
  const surfaceTargets = derivePlanarOutputTargets({
    surveys: [{
      id: `survey-${wallId}`,
      wallId,
      cameraViewId,
      frame: { width: 64, height: 64 },
      lensProfileSha256: profile.sha256,
      boundary: [
        { x: 0.08, y: 0.1 }, { x: 0.92, y: 0.1 },
        { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
      ],
    }],
    outputs,
    lensProfile: profile,
  });
  return createCameraCalibrationPlan({
    sessionId,
    projectId: "immersive-room",
    projectRevision: 11,
    outputs,
    surfaceTargets,
    lensProfile: profile,
    mesh: { columns: 2, rows: 2, minimumConfidence: 0.05 },
    settleFrames: 2,
    repeats: 1,
  });
}

function evidenceClock(offset = 0) {
  let tick = 0;
  const base = Date.parse("2026-08-24T00:00:00.000Z") + offset;
  return () => new Date(base + tick++ * 1_000).toISOString();
}

async function confirmOperator({ step }) {
  const confirmationId = `confirmation:${step.confirmationLeaseId || step.id}`;
  return {
    confirmed: true,
    stepId: step.id,
    confirmationId,
    conditionVerification: {
      projectorState: step.captureConditions.projectorState,
      opticalPath: step.captureConditions.opticalPath,
      otherProjectors: step.captureConditions.otherProjectors,
      method: "archive-test-operator-confirmation",
      verifiedAt: "2026-08-23T23:59:59.000Z",
      confirmationLeaseId: step.confirmationLeaseId || null,
      confirmationId,
    },
  };
}

async function measuredManifest(calibrationPlan, artifactRoot, clockOffset) {
  const runClock = evidenceClock(clockOffset);
  const result = await new CameraCalibrationOrchestrator({
    cameraAdapter: new MeasuredSonyFixtureCamera({ now: runClock }),
    patternAdapter: new DeterministicPatternOverrideAdapter(),
    solver: new MeasuredCalibrationSolver({ artifactRoot }),
    requestOperatorConfirmation: confirmOperator,
    now: runClock,
  }).run(calibrationPlan);
  assert.equal(result.session.state, "complete");
  assert.equal(result.manifest.provenance, "measured");
  assert.equal(result.manifest.applicable, true);
  return result.manifest;
}

function binding(bundleId, memberId, cameraViewId, viewCaptureId) {
  return { bundleId, memberId, cameraViewId, viewCaptureId };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(label) {
  return createHash("sha256").update(label).digest("hex");
}

function opticalPlan(calibrationPlan, manifest) {
  const radiometryProfile = calibrationPlan.exposureProfiles.find((profile) => profile.role === "radiometry");
  const rendererPayload = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256(`renderer-config:${manifest.sessionId}`),
    outputs: manifest.outputs.map((output) => ({
      id: output.outputId,
      processingBypass: false,
      artifacts: {
        warpMeshSha256: output.artifacts.warp.sha256,
        blendMapSha256: output.artifacts.blendWeight.sha256,
        blackMapSha256: output.artifacts.blackPedestal.sha256,
        maskSha256: output.artifacts.mask.sha256,
        colorLutSha256: output.artifacts.lut.sha256,
      },
    })),
  };
  const rendererCorrectionBinding = {
    ...rendererPayload,
    fingerprint: createHash("sha256").update(canonicalJson(rendererPayload)).digest("hex"),
  };
  return createCameraOpticalVerificationPlan({
    verificationId: `verify-${manifest.sessionId}`,
    leaseToken: `lease_${sha256(manifest.sessionId).slice(0, 32)}`,
    calibrationSessionId: manifest.sessionId,
    nodeId: "bundle-node",
    project: {
      id: calibrationPlan.project.id,
      baseRevision: calibrationPlan.project.revision,
      appliedRevision: calibrationPlan.project.revision + 1,
    },
    rendererAcknowledgedAt: new Date(Date.now() - 1_000).toISOString(),
    rendererCorrectionBinding,
    camera: manifest.camera,
    lensProfile: calibrationPlan.lensProfile,
    exposureProfiles: calibrationPlan.exposureProfiles,
    outputs: calibrationPlan.outputs.map((output) => ({
      id: output.id,
      resolution: { width: output.width, height: output.height },
      sourceViewport: output.sourceViewport,
      surfaceTarget: output.surfaceTarget,
    })),
    blackFloorBaselines: manifest.outputs.map((output) => {
      const bridge = output.radiometry.measuredExposureNormalization;
      return {
        outputId: output.outputId,
        calibrationSessionId: manifest.sessionId,
        sourceManifestSchemaVersion: manifest.schemaVersion,
        blackPedestalSha256: output.artifacts.blackPedestal.sha256,
        exposureProfileId: radiometryProfile.id,
        normalizationScale: radiometryProfile.normalizationScale,
        exposureBridgeId: bridge.bridgeId,
        exposureBridgeStatus: bridge.status,
        exposureBridgeGatesPassed: bridge.gates.passed,
        measuredNormalizationScale: bridge.measuredScaleLuma,
        normalizationRelativeUncertainty: bridge.uncertaintyLuma,
        measurementBasis: "sensor-dark-subtracted-exposure-normalized-camera-linear-luma",
        targetLevel: output.radiometry.black.target,
      };
    }),
    mesh: calibrationPlan.mesh,
    nearBlackLevels: calibrationPlan.nearBlackLevels,
    settleFrames: calibrationPlan.settleFrames,
  });
}

async function waitFor(predicate, { timeoutMs = 5_000, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

class ArchiveTestEngine {
  constructor(outputIds) {
    this.adapters = new Map();
    this.externalCadence = false;
    this.connected = true;
    this.ready = true;
    this.projectRevision = null;
    this.outputIds = outputIds;
  }

  async initialize() {}

  async configure(project) {
    this.projectRevision = project.revision;
    return this.diagnostics();
  }

  async prepare() { return this.diagnostics(); }

  async blank() {}

  async clearPattern() {}

  renderFrame() { return []; }

  async stop() { this.ready = false; }

  diagnostics() {
    return {
      backend: "archive-test-engine",
      ready: this.ready,
      connected: this.connected,
      projectRevision: this.projectRevision,
      nativeRevision: this.projectRevision,
      compositionSource: null,
      droppedFrames: 0,
      framesRendered: 0,
      outputs: this.outputIds.map((id) => ({
        id,
        connector: `DP-${id}`,
        metrics: { droppedFrames: 0, framesRendered: 0 },
      })),
    };
  }
}

test("durable Node archive retains two exact wall manifests after live-session overwrite and restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-manifest-archive-"));
  const archivePath = join(root, "camera-calibration-manifests.json");
  const nodeStatePath = join(root, "state.json");
  const northPlan = plan({
    sessionId: "calibration-north-session",
    outputId: "A",
    wallId: "wall-north",
    cameraViewId: "camera-view-north",
  });
  const eastPlan = plan({
    sessionId: "calibration-east-session",
    outputId: "C",
    wallId: "wall-east",
    cameraViewId: "camera-view-east",
  });
  try {
    const [northManifest, eastManifest] = await Promise.all([
      measuredManifest(northPlan, join(root, "north-artifacts"), 0),
      measuredManifest(eastPlan, join(root, "east-artifacts"), 1_000_000),
    ]);
    const northBinding = binding(
      "bundle-room-001",
      "north-member",
      "camera-view-north",
      "viewcap_north_001",
    );
    const eastBinding = binding(
      "bundle-room-001",
      "east-member",
      "camera-view-east",
      "viewcap_east_001",
    );

    const firstArchive = new CameraCalibrationManifestArchiveStore(archivePath);
    const firstState = new NodeStateStore(nodeStatePath);
    await firstArchive.initialize();
    await firstState.initialize();
    await firstArchive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: northPlan,
      manifest: northManifest,
      bundle: northBinding,
      archivedAt: "2026-08-25T00:00:00.000Z",
    });
    firstState.state.cameraCalibration = {
      sessionId: northPlan.sessionId,
      state: "complete",
      manifest: northManifest,
    };
    await firstState.save(firstState.state);

    const secondArchive = new CameraCalibrationManifestArchiveStore(archivePath);
    const secondState = new NodeStateStore(nodeStatePath);
    await secondArchive.initialize();
    await secondState.initialize();
    assert.equal(secondArchive.get(northPlan.sessionId, {
      nodeId: "bundle-node",
      project: northPlan.project,
      cameraViewId: "camera-view-north",
      bundle: northBinding,
    }).manifest.sessionId, northPlan.sessionId);
    await secondArchive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: eastPlan,
      manifest: eastManifest,
      bundle: eastBinding,
      archivedAt: "2026-08-25T00:01:00.000Z",
    });
    secondState.state.cameraCalibration = {
      sessionId: eastPlan.sessionId,
      state: "complete",
      manifest: eastManifest,
    };
    await secondState.save(secondState.state);

    const finalArchive = new CameraCalibrationManifestArchiveStore(archivePath);
    const finalState = new NodeStateStore(nodeStatePath);
    await finalArchive.initialize();
    const restoredState = await finalState.initialize();
    assert.equal(restoredState.cameraCalibration.sessionId, eastPlan.sessionId,
      "the single live calibration slot should now hold only the later wall");
    const restoredNorth = finalArchive.get(northPlan.sessionId, {
      nodeId: "bundle-node",
      project: northPlan.project,
      cameraViewId: "camera-view-north",
      bundle: northBinding,
    });
    const restoredEast = finalArchive.get(eastPlan.sessionId, {
      nodeId: "bundle-node",
      project: eastPlan.project,
      cameraViewId: "camera-view-east",
      bundle: eastBinding,
    });
    const documentBeforeReplay = await readFile(archivePath, "utf8");
    const idempotentReplay = await finalArchive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: northPlan,
      manifest: northManifest,
      bundle: northBinding,
      archivedAt: "2026-08-25T00:05:00.000Z",
    });
    assert.equal(idempotentReplay.entrySha256, restoredNorth.entrySha256);
    assert.equal(await readFile(archivePath, "utf8"), documentBeforeReplay,
      "an identical session replay must not rewrite its original durable evidence");
    assert.equal(normalizeCameraCalibrationManifest(restoredNorth.manifest, { plan: northPlan }).sessionId,
      northPlan.sessionId);
    assert.equal(normalizeCameraCalibrationManifest(restoredEast.manifest, { plan: eastPlan }).sessionId,
      eastPlan.sessionId);
    assert.deepEqual(finalArchive.summary(), {
      schemaVersion: 1,
      entries: 2,
      pinnedEntries: 2,
      totalBytes: restoredNorth.byteLength + restoredEast.byteLength,
      serializedBytes: Buffer.byteLength(documentBeforeReplay, "utf8"),
      maxEntries: 32,
      maxBytes: 128 * 1024 * 1024,
      updatedAt: "2026-08-25T00:01:00.000Z",
      releaseProtocol: "unavailable-permanent-bundle-pins",
    });

    await assert.rejects(
      async () => finalArchive.get("calibration-stale-session"),
      (error) => error.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_NOT_FOUND",
    );
    assert.throws(
      () => finalArchive.get(northPlan.sessionId, {
        bundle: { ...northBinding, viewCaptureId: "viewcap_forged" },
      }),
      (error) => error.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_BINDING_MISMATCH",
    );
    await assert.rejects(
      () => finalArchive.append({
        nodeId: "bundle-node",
        state: "complete",
        plan: northPlan,
        manifest: northManifest,
        bundle: { ...northBinding, viewCaptureId: "viewcap_replay_changed" },
        archivedAt: "2026-08-25T00:02:00.000Z",
      }),
      (error) => error.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_REPLAY_MISMATCH",
    );
    assert.equal(finalArchive.summary().entries, 2);

    const corrupted = JSON.parse(await readFile(archivePath, "utf8"));
    corrupted.entries[0].manifest.project.id = "forged-project";
    await writeFile(archivePath, `${JSON.stringify(corrupted, null, 2)}\n`, "utf8");
    const corruptedArchive = new CameraCalibrationManifestArchiveStore(archivePath);
    await assert.rejects(
      corruptedArchive.initialize(),
      (error) => new Set([
        "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_BINDING_MISMATCH",
        "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_HASH_MISMATCH",
      ]).has(error.code),
      "a corrupt archive must block startup instead of dropping a bundle baseline",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned bundle manifests exhaust capacity fail closed and are never evicted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-manifest-pins-"));
  try {
    const firstPlan = plan({
      sessionId: "pinned-session-1",
      outputId: "A",
      wallId: "wall-1",
      cameraViewId: "camera-view-1",
    });
    const secondPlan = plan({
      sessionId: "pinned-session-2",
      outputId: "C",
      wallId: "wall-2",
      cameraViewId: "camera-view-2",
    });
    const [firstManifest, secondManifest] = await Promise.all([
      measuredManifest(firstPlan, join(root, "first-artifacts"), 0),
      measuredManifest(secondPlan, join(root, "second-artifacts"), 1_000_000),
    ]);
    const archive = new CameraCalibrationManifestArchiveStore(join(root, "archive.json"), {
      maxEntries: 1,
      maxBytes: 128 * 1024 * 1024,
    });
    await archive.initialize();
    await archive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: firstPlan,
      manifest: firstManifest,
      bundle: binding("bundle-capacity", "member-1", "camera-view-1", "viewcap_1"),
      archivedAt: "2026-08-25T00:00:00.000Z",
    });
    await assert.rejects(
      () => archive.append({
        nodeId: "bundle-node",
        state: "complete",
        plan: secondPlan,
        manifest: secondManifest,
        bundle: binding("bundle-capacity", "member-2", "camera-view-2", "viewcap_2"),
        archivedAt: "2026-08-25T00:01:00.000Z",
      }),
      (error) => error.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
    );
    assert.equal(archive.get(firstPlan.sessionId).manifest.sessionId, firstPlan.sessionId);
    assert.equal(archive.summary().entries, 1);
    assert.equal(archive.summary().pinnedEntries, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optical verification resolves an earlier exact archived session after the live wall was overwritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-archive-optical-lookup-"));
  const northPlan = plan({
    sessionId: "archived-north-optical-session",
    outputId: "A",
    wallId: "wall-north",
    cameraViewId: "camera-view-north",
  });
  const eastPlan = plan({
    sessionId: "live-east-optical-session",
    outputId: "C",
    wallId: "wall-east",
    cameraViewId: "camera-view-east",
  });
  try {
    const [northManifest, eastManifest] = await Promise.all([
      measuredManifest(northPlan, join(root, "north-artifacts"), 0),
      measuredManifest(eastPlan, join(root, "east-artifacts"), 1_000_000),
    ]);
    const archive = new CameraCalibrationManifestArchiveStore(
      join(root, "camera-calibration-manifests.json"),
    );
    await archive.initialize();
    await archive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: northPlan,
      manifest: northManifest,
      bundle: binding("bundle-optical", "north", "camera-view-north", "viewcap_optical_north"),
      archivedAt: "2026-08-25T00:00:00.000Z",
    });
    await archive.append({
      nodeId: "bundle-node",
      state: "complete",
      plan: eastPlan,
      manifest: eastManifest,
      bundle: binding("bundle-optical", "east", "camera-view-east", "viewcap_optical_east"),
      archivedAt: "2026-08-25T00:01:00.000Z",
    });
    const verificationPlan = opticalPlan(northPlan, northManifest);
    const baseProject = defaultProject();
    const project = normalizeProject({
      ...baseProject,
      id: verificationPlan.project.id,
      revision: verificationPlan.project.appliedRevision,
    });
    const state = new NodeStateStore(join(root, "state.json"));
    await state.initialize();
    state.state.project = project;
    state.state.cameraCalibration = {
      sessionId: eastPlan.sessionId,
      state: "complete",
      manifest: eastManifest,
    };
    await state.save(state.state);

    const command = createCommand(COMMAND.START_CAMERA_OPTICAL_VERIFICATION, {
      plan: verificationPlan,
    }, { sequence: 1 });
    let aborted = false;
    let baselineSessionId = null;
    const client = {
      time: async () => ({ serverTimeNs: epochNowNs().toString() }),
      register: async () => ({
        protocolVersion: 1,
        node: { ackSequence: 0, commandSequence: 1 },
        commandSequence: 1,
        project,
      }),
      state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
      heartbeat: async () => ({ serverTimeNs: epochNowNs().toString(), acknowledgedActionResultIds: [] }),
      pollCommands: async (afterSequence) => {
        while (!aborted) {
          if (afterSequence < 1) return { protocolVersion: 1, commands: [command] };
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        throw new Error("aborted");
      },
      assetUrl: (digest) => `/v1/assets/${digest}`,
      download: async () => { throw new Error("unexpected asset download"); },
      abort: () => { aborted = true; },
    };
    const node = new PixelBrightnessNode({
      nodeId: "bundle-node",
      name: "Bundle Node",
      version: "0.3.0-test",
      platform: "darwin",
      serverUrl: "http://127.0.0.1:4100",
      dataDir: root,
      outputs: [{ id: "A", connector: "DP-A" }],
      heartbeatMs: 5,
      hostTelemetryMs: 1_000,
      clockSyncMs: 5_000,
      clockSyncRounds: 1,
      pollWaitMs: 5,
      requestTimeoutMs: 500,
      commandRetryBudget: 3,
      maxAssetBytes: 1_000_000,
      maxCacheBytes: 2_000_000,
      cameraBackend: "sony-sdk",
      logLevel: "error",
      nodeToken: null,
    }, {
      hostTelemetryCollector: {
        collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "bundle-node" }, renderer }),
      },
      renderEngineFactory: () => new ArchiveTestEngine(["A"]),
      cameraOpticalVerificationFactory: ({ baselineManifest }) => {
        baselineSessionId = baselineManifest.sessionId;
        const error = new Error("intentional stop after exact baseline lookup");
        error.code = "ARCHIVE_BASELINE_LOOKUP_PROVED";
        throw error;
      },
    });
    node.client = client;
    node.cache.client = client;
    try {
      await node.start();
      await waitFor(() => baselineSessionId != null, { message: "exact archived optical baseline lookup" });
      assert.equal(node.diagnostics().cameraCalibration.sessionId, eastPlan.sessionId,
        "the live slot must remain the later east-wall calibration");
      assert.equal(baselineSessionId, northPlan.sessionId,
        "optical verification must resolve the requested archived north session, not the live east session");
      assert.equal(node.diagnostics().metrics.commandFailures, 0);
    } finally {
      await node.stop().catch(() => {});
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon withholds a terminal measured report until archive and live state are both durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-manifest-before-ack-"));
  const calibrationPlan = plan({
    sessionId: "persist-before-ack-session",
    outputId: "A",
    wallId: "wall-north",
    cameraViewId: "camera-view-north",
  });
  const bundle = binding(
    "bundle-persist-before-ack",
    "north-member",
    "camera-view-north",
    "viewcap_persist_before_ack",
  );
  const baseProject = defaultProject();
  const project = normalizeProject({
    ...baseProject,
    id: calibrationPlan.project.id,
    revision: calibrationPlan.project.revision,
  });
  const command = createCommand(COMMAND.START_CAMERA_CALIBRATION, {
    mode: "measured",
    plan: calibrationPlan,
    bundle,
  }, { sequence: 1 });
  let aborted = false;
  const commands = [command];
  const confirmedPrompts = new Set();
  let nextSequence = 2;
  let archiveAppendStarted = false;
  let releaseArchive;
  const archiveGate = new Promise((resolve) => { releaseArchive = resolve; });
  let terminalStateCommitStarted = false;
  let releaseTerminalState;
  const terminalStateGate = new Promise((resolve) => { releaseTerminalState = resolve; });
  const terminalHeartbeats = [];
  let terminalDurabilityChecked = false;
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: commands.at(-1)?.sequence || 0 },
      commandSequence: commands.at(-1)?.sequence || 0,
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      const calibration = payload.telemetry?.cameraCalibration;
      const prompt = calibration?.operatorPrompt;
      if (prompt?.state === "waiting" && !confirmedPrompts.has(prompt.confirmationId)) {
        confirmedPrompts.add(prompt.confirmationId);
        commands.push(createCommand(COMMAND.CONFIRM_CAMERA_CALIBRATION, {
          sessionId: calibrationPlan.sessionId,
          stepId: prompt.stepId,
          confirmationId: prompt.confirmationId,
          confirmedAt: new Date(Math.max(Date.now(), Date.parse(prompt.requestedAt))).toISOString(),
        }, { sequence: nextSequence++ }));
      }
      if (calibration?.state === "complete") {
        terminalHeartbeats.push(structuredClone(payload));
        const archiveDocument = JSON.parse(await readFile(
          join(root, "camera-calibration-manifests.json"),
          "utf8",
        ));
        const nodeState = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
        assert.equal(archiveDocument.entries[0].sessionId, calibrationPlan.sessionId);
        assert.equal(nodeState.cameraCalibration.sessionId, calibrationPlan.sessionId);
        assert.equal(nodeState.cameraCalibration.state, "complete");
        terminalDurabilityChecked = true;
        return {
          serverTimeNs: epochNowNs().toString(),
          acknowledgedCameraCalibrationId: calibrationPlan.sessionId,
        };
      }
      return { serverTimeNs: epochNowNs().toString(), acknowledgedActionResultIds: [] };
    },
    pollCommands: async (afterSequence) => {
      while (!aborted) {
        const pending = commands.filter((candidate) => candidate.sequence > afterSequence);
        if (pending.length > 0) return { protocolVersion: 1, commands: pending };
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected asset download"); },
    abort: () => { aborted = true; },
  };
  const node = new PixelBrightnessNode({
    nodeId: "bundle-node",
    name: "Bundle Node",
    version: "0.3.0-test",
    platform: "darwin",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: root,
    outputs: [{ id: "A", connector: "DP-A" }],
    heartbeatMs: 5,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    commandRetryBudget: 3,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    cameraBackend: "sony-sdk",
    logLevel: "error",
    nodeToken: null,
  }, {
    hostTelemetryCollector: {
      collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "bundle-node" }, renderer }),
    },
    renderEngineFactory: () => new ArchiveTestEngine(["A"]),
    cameraCalibrationFactory: () => ({
      cameraAdapter: new MeasuredSonyFixtureCamera(),
      patternAdapter: new DeterministicPatternOverrideAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot: join(root, "measured-artifacts") }),
      buildProjectPatch: async () => ({
        schemaVersion: 2,
        sessionId: calibrationPlan.sessionId,
        projectId: project.id,
        baseRevision: project.revision,
        outputs: [],
      }),
    }),
  });
  node.client = client;
  node.cache.client = client;
  const durableAppend = node.cameraCalibrationManifestArchive.append
    .bind(node.cameraCalibrationManifestArchive);
  node.cameraCalibrationManifestArchive.append = async (input) => {
    archiveAppendStarted = true;
    await archiveGate;
    return durableAppend(input);
  };
  const durableStateRename = node.store.file.rename;
  node.store.file.rename = async (source, destination) => {
    const candidate = JSON.parse(await readFile(source, "utf8"));
    if (candidate.cameraCalibration?.state === "complete" && !terminalStateCommitStarted) {
      terminalStateCommitStarted = true;
      await terminalStateGate;
    }
    return durableStateRename(source, destination);
  };
  try {
    await node.start();
    try {
      await waitFor(() => archiveAppendStarted, { message: "measured archive append boundary" });
    } catch (error) {
      error.message += `; diagnostics=${JSON.stringify(node.diagnostics())}`;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(terminalHeartbeats.length, 0,
      "terminal measured evidence must not be publishable while its archive commit is blocked");
    releaseArchive();
    await waitFor(() => terminalStateCommitStarted, { message: "terminal Node-state commit boundary" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(terminalHeartbeats.length, 0,
      "terminal measured evidence must not be publishable while its live-state commit is blocked");
    releaseTerminalState();
    await waitFor(() => terminalDurabilityChecked && node.diagnostics().cameraCalibration?.state === "complete", {
      message: "durable terminal measured heartbeat",
    });
    assert.equal(terminalHeartbeats.length >= 1, true);
    assert.equal(node.diagnostics().metrics.commandFailures, 0);
  } finally {
    releaseArchive();
    releaseTerminalState();
    await node.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("an unabortable calibration completion after lease loss cannot publish a manifest or project patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-calibration-lease-loss-"));
  const calibrationPlan = plan({
    sessionId: "lease-loss-calibration-session",
    outputId: "A",
    wallId: "wall-north",
    cameraViewId: "camera-view-north",
  });
  const project = normalizeProject({
    ...defaultProject(),
    id: calibrationPlan.project.id,
    revision: calibrationPlan.project.revision,
  });
  const command = createCommand(COMMAND.START_CAMERA_CALIBRATION, {
    mode: "simulation",
    plan: calibrationPlan,
    bundle: null,
  }, { sequence: 1 });
  const engine = new ArchiveTestEngine(["A"]);
  let rendererBlack = false;
  engine.blank = async (enabled) => { rendererBlack = enabled === true; };
  let completionStarted = false;
  let aborted = false;
  class UnabortableCompletionPattern extends DeterministicPatternOverrideAdapter {
    async completeCalibration(input) {
      completionStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 200));
      return super.completeCalibration(input);
    }
  }
  let pattern;
  const client = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: 1,
      node: { ackSequence: 0, commandSequence: 1, failClosedFence: null },
      commandSequence: 1,
      executionLease: executionLease("bundle-node"),
      project,
    }),
    state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async () => {
      if (completionStarted) throw new Error("simulated calibration lease partition");
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease("bundle-node"),
        acknowledgedActionResultIds: [],
      };
    },
    pollCommands: async (afterSequence) => {
      if (afterSequence < 1) {
        return {
          protocolVersion: 1,
          commandSequence: 1,
          failClosedFence: null,
          executionLease: executionLease("bundle-node"),
          commands: [command],
        };
      }
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected asset download"); },
    abort: () => { aborted = true; },
  };
  const node = new PixelBrightnessNode({
    nodeId: "bundle-node",
    name: "Bundle Node",
    version: "0.3.0-test",
    platform: "darwin",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: root,
    outputs: [{ id: "A", connector: "DP-A" }],
    heartbeatMs: 10,
    hostTelemetryMs: 1_000,
    clockSyncMs: 5_000,
    clockSyncRounds: 1,
    pollWaitMs: 5,
    requestTimeoutMs: 500,
    commandRetryBudget: 3,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    cameraBackend: "sony-sdk",
    logLevel: "error",
    nodeToken: null,
  }, {
    hostTelemetryCollector: {
      collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "bundle-node" }, renderer }),
    },
    renderEngineFactory: () => engine,
    cameraCalibrationFactory: () => {
      pattern = new UnabortableCompletionPattern();
      return {
        cameraAdapter: new DeterministicSimulatedCameraAdapter({ width: 64, height: 64 }),
        patternAdapter: pattern,
        solver: new DeterministicSimulatedCalibrationSolver(),
        buildProjectPatch: async () => { throw new Error("simulation must never build an applicable patch"); },
      };
    },
  });
  node.client = client;
  node.cache.client = client;
  try {
    await node.start();
    await waitFor(() => completionStarted, { message: "unabortable calibration completion boundary" });
    await waitFor(() => node.diagnostics().cameraCalibration?.state === "failed", {
      timeoutMs: 5_000,
      message: "lease-lost calibration fail-closed terminal state",
    });
    const calibration = node.diagnostics().cameraCalibration;
    assert.equal(calibration.failure.code, "EXECUTION_LEASE_EXPIRED");
    assert.equal(calibration.manifest, null);
    assert.equal(calibration.projectPatch, null);
    assert.equal(node.diagnostics().cameraCalibrationManifestArchive.entries, 0);
    assert.equal(rendererBlack, true);
    assert.equal(pattern.mode, "content",
      "the unabortable adapter may return content, but daemon-level black must remain authoritative");
  } finally {
    await node.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("measured manifest archive bounds are configurable by environment and CLI", async () => {
  const environmentConfig = await loadNodeConfig({
    argv: [],
    env: {
      PIXEL_BRIGHTNESS_CAMERA_MANIFEST_ARCHIVE_MAX_ENTRIES: "12",
      PIXEL_BRIGHTNESS_CAMERA_MANIFEST_ARCHIVE_MAX_BYTES: "67108864",
    },
    cwd: "/tmp/pb-camera-archive-config",
    platform: "darwin",
  });
  assert.equal(environmentConfig.cameraManifestArchiveMaxEntries, 12);
  assert.equal(environmentConfig.cameraManifestArchiveMaxBytes, 64 * 1024 * 1024);

  const cliConfig = await loadNodeConfig({
    argv: [
      "--camera-manifest-archive-max-entries", "18",
      "--camera-manifest-archive-max-bytes", "100663296",
    ],
    env: {},
    cwd: "/tmp/pb-camera-archive-config",
    platform: "darwin",
  });
  assert.equal(cliConfig.cameraManifestArchiveMaxEntries, 18);
  assert.equal(cliConfig.cameraManifestArchiveMaxBytes, 96 * 1024 * 1024);
  assert.match(nodeHelp(), /--camera-manifest-archive-max-entries <n>/u);
  assert.match(nodeHelp(), /--camera-manifest-archive-max-bytes <bytes>/u);
});

test("archive startup rejects an oversized on-disk document before JSON hydration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pb-camera-archive-oversized-"));
  const pathname = join(root, "archive.json");
  try {
    await writeFile(pathname, " ".repeat(257), "utf8");
    const archive = new CameraCalibrationManifestArchiveStore(pathname, {
      maxEntries: 1,
      maxBytes: 256,
    });
    await assert.rejects(
      archive.initialize(),
      (error) => error.code === "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_CAPACITY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
