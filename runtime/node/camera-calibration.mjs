import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildAutomaticBlendMaps,
  buildBlackUniformityMap,
  buildWarpMeshFromCameraMap,
  createCameraTargetMesh,
  decodeGrayCodeFrames,
  requiredGrayBits,
} from "../shared/calibration.mjs";
import {
  CAMERA_CALIBRATION_EVENT,
  CAMERA_CALIBRATION_SCHEMA_VERSION,
  CAMERA_CALIBRATION_STATE,
  CAMERA_LOCK_FIELDS,
  CameraCalibrationError,
  buildCameraCalibrationProjectPatch,
  createCameraCalibrationSession,
  normalizeCameraCalibrationManifest,
  normalizeCameraDescriptor,
  normalizeManualCameraSettings,
  normalizeRawDecodeMetadata,
  normalizeRawDecoderProvenance,
  transitionCameraCalibration,
  verifyManualCameraLock,
} from "../shared/camera-calibration.mjs";
import {
  createDistortionAwarePlanarGrid,
  normalizeCameraLensProfile,
} from "../shared/camera-lens-profile.mjs";
import { normalizeRendererCorrectionBinding } from "../shared/renderer-correction-binding.mjs";

function isInside(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/**
 * Resolves and verifies artifacts written by a measured solver. A manifest is
 * never trusted merely because it contains a local pathname: size and SHA-256
 * are checked before the path can enter a renderer configuration.
 */
export class FileCalibrationArtifactResolver {
  constructor({ root = null } = {}) {
    this.root = root ? resolve(String(root)) : null;
    this.verified = new Map();
  }

  pathFor(artifact) {
    let pathname;
    if (artifact?.path) pathname = String(artifact.path);
    else if (String(artifact?.uri || "").startsWith("file:")) pathname = fileURLToPath(artifact.uri);
    else {
      throw new CameraCalibrationError(
        "CALIBRATION_ARTIFACT_NOT_LOCAL",
        `Measured artifact is not a local file: ${artifact?.uri || "(missing URI)"}`,
      );
    }
    const absolute = resolve(pathname);
    if (this.root && !isInside(this.root, absolute)) {
      throw new CameraCalibrationError("CALIBRATION_ARTIFACT_OUTSIDE_ROOT", "Calibration artifact is outside its session directory");
    }
    return absolute;
  }

  async verify(artifact) {
    const pathname = this.pathFor(artifact);
    const cached = this.verified.get(pathname);
    if (cached === artifact.sha256) return pathname;
    const information = await stat(pathname);
    if (!information.isFile() || information.size !== Number(artifact.byteLength)) {
      throw new CameraCalibrationError("CALIBRATION_ARTIFACT_SIZE_MISMATCH", `Artifact size mismatch: ${artifact.uri}`);
    }
    const bytes = await readFile(pathname);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== artifact.sha256) {
      throw new CameraCalibrationError("CALIBRATION_ARTIFACT_HASH_MISMATCH", `Artifact digest mismatch: ${artifact.uri}`);
    }
    this.verified.set(pathname, sha256);
    return pathname;
  }

  async read(artifact) {
    return readFile(await this.verify(artifact));
  }
}

export async function materializeMeasuredCalibrationProjectPatch({ manifest, project, artifactRoot = null }) {
  const artifacts = new FileCalibrationArtifactResolver({ root: artifactRoot });
  return buildCameraCalibrationProjectPatch(manifest, project, {
    loadWarp: (artifact) => artifacts.read(artifact),
    resolveArtifactPath: (artifact) => artifacts.verify(artifact),
  });
}

export class CameraAdapter {
  async detect() {
    throw new CameraCalibrationError("CAMERA_ADAPTER_NOT_IMPLEMENTED", "CameraAdapter.detect is not implemented");
  }

  async open() {
    throw new CameraCalibrationError("CAMERA_ADAPTER_NOT_IMPLEMENTED", "CameraAdapter.open is not implemented");
  }

  async lockManualSettings() {
    throw new CameraCalibrationError("CAMERA_ADAPTER_NOT_IMPLEMENTED", "CameraAdapter.lockManualSettings is not implemented");
  }

  async capture() {
    throw new CameraCalibrationError("CAMERA_ADAPTER_NOT_IMPLEMENTED", "CameraAdapter.capture is not implemented");
  }

  async close() {}
}

/**
 * Honest fallback when the process-isolated Canon helper is not configured.
 * Proprietary EDSDK binaries never load in this process and their presence is
 * never inferred from the operating system alone.
 */
export class CanonR50WindowsCameraAdapter extends CameraAdapter {
  constructor() {
    super();
    this.backend = "canon-edsdk";
    this.implemented = false;
  }

  async detect() {
    return {
      adapter: {
        backend: this.backend,
        platform: "win32",
        implemented: false,
        available: false,
      },
      cameras: [],
      error: {
        code: "CANON_EDSDK_ADAPTER_UNAVAILABLE",
        message: "Canon EOS R50 capture requires an explicitly configured process-isolated EDSDK helper",
      },
    };
  }

  async open() {
    throw new CameraCalibrationError(
      "CANON_EDSDK_ADAPTER_UNAVAILABLE",
      "Canon EOS R50 capture requires an explicitly configured process-isolated EDSDK helper",
    );
  }
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function grayBit(coordinate, dimension, bit) {
  const bits = requiredGrayBits(dimension);
  const shift = bits - bit - 1;
  const gray = coordinate ^ (coordinate >> 1);
  return (gray >> shift) & 1;
}

export class DeterministicSimulatedCameraAdapter extends CameraAdapter {
  constructor({
    width = 64,
    height = 36,
    cameraId = "sim-camera-01",
    responseGamma = 2.2,
    blackFloor = 0.0005,
    ambientFloor = 0.0002,
    sensorOffset = 0.001,
    signalGain = 0.9,
    now = (index) => new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 100).toISOString(),
  } = {}) {
    super();
    this.width = Math.max(2, Math.min(16_384, Math.round(width)));
    this.height = Math.max(2, Math.min(16_384, Math.round(height)));
    this.responseGamma = Math.max(0.1, Math.min(8, Number(responseGamma) || 2.2));
    this.blackFloor = clamp(blackFloor, 0, 0.25);
    this.ambientFloor = clamp(ambientFloor, 0, 0.25);
    this.sensorOffset = clamp(sensorOffset, 0, 0.25);
    this.signalGain = Math.max(0.1, Math.min(0.98, Number(signalGain) || 0.9));
    this.now = now;
    this.camera = normalizeCameraDescriptor({
      id: cameraId,
      vendor: "Pixel Brightness",
      model: "Deterministic simulated camera",
      serial: "SIM-0001",
      transport: "simulation",
      backend: "deterministic-camera-v1",
      capabilities: {
        manualExposure: true,
        manualWhiteBalance: true,
        manualFocus: true,
        linearCapture: true,
      },
    });
    this.opened = false;
    this.locked = false;
    this.captureIndex = 0;
    this.captureLog = [];
  }

  async detect() {
    return {
      adapter: { backend: this.camera.backend, platform: "simulation", implemented: true, available: true },
      cameras: [this.camera],
      error: null,
    };
  }

  async open(cameraId) {
    if (cameraId !== this.camera.id) throw new CameraCalibrationError("CAMERA_NOT_FOUND", `Unknown simulated camera: ${cameraId}`);
    this.opened = true;
    return this.camera;
  }

  async lockManualSettings(input) {
    if (!this.opened) throw new CameraCalibrationError("CAMERA_NOT_OPEN", "Camera must be open before locking settings");
    const applied = normalizeManualCameraSettings(input);
    this.locked = true;
    this.settings = applied;
    return { confirmed: true, applied, lockedFields: [...CAMERA_LOCK_FIELDS] };
  }

  #patternRgb(pattern, x, y) {
    if (pattern.kind === "solid") return pattern.rgb.map((channel) => clamp(channel));
    if (pattern.kind !== "gray-code") return [0, 0, 0];
    const dimension = pattern.axis === "y" ? pattern.height : pattern.width;
    const coordinate = pattern.axis === "y"
      ? Math.min(pattern.height - 1, Math.floor(y / Math.max(1, this.height - 1) * pattern.height))
      : Math.min(pattern.width - 1, Math.floor(x / Math.max(1, this.width - 1) * pattern.width));
    const bit = grayBit(coordinate, dimension, pattern.bit);
    const value = Boolean(bit) !== Boolean(pattern.inverse) ? 1 : 0;
    return [value, value, value];
  }

  async capture({ step, repeat = 0 }) {
    if (!this.opened || !this.locked) {
      throw new CameraCalibrationError("CAMERA_NOT_LOCKED", "Camera must be open with verified manual settings before capture");
    }
    const data = new Float32Array(this.width * this.height * 3);
    const exposureScale = Math.max(1e-9, Number(step.exposure?.normalizationScale) || 1);
    const referenceKind = String(step.referenceKind || "");
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const rgb = this.#patternRgb(step.pattern, x, y);
        const u = x / Math.max(1, this.width - 1);
        const v = y / Math.max(1, this.height - 1);
        const spatialFloor = this.blackFloor * (0.82 + 0.18 * u) * (0.9 + 0.1 * v);
        const offset = (y * this.width + x) * 3;
        for (let channel = 0; channel < 3; channel += 1) {
          let optical = this.ambientFloor + spatialFloor
            + this.signalGain * (1 - spatialFloor) * Math.pow(rgb[channel], this.responseGamma);
          if (referenceKind === "sensor-dark") optical = 0;
          else if (referenceKind === "projectors-off-ambient") optical = this.ambientFloor;
          data[offset + channel] = clamp(this.sensorOffset + exposureScale * optical);
        }
      }
    }
    const capture = {
      id: `${step.id}#${repeat}`,
      stepId: step.id,
      outputId: step.outputId,
      repeat,
      capturedAt: this.now(this.captureIndex),
      width: this.width,
      height: this.height,
      pixelFormat: "linear-rgb-f32",
      bitDepth: 32,
      linearized: true,
      lens: {
        id: "sim-lens-01",
        vendor: "Pixel Brightness",
        model: "Deterministic simulated prime",
        serial: "SIM-LENS-0001",
        mount: "simulation",
        focalLengthMm: 35,
        apertureF: this.settings.apertureF,
        focusDistanceM: 3,
        focusLocked: true,
        zoomLocked: true,
        stabilization: "off",
      },
      pipeline: {
        captureMode: "single-shot",
        shutterMode: "mechanical",
        rawEncoding: "uncompressed",
        sourcePixelFormat: "linear-rgb-f32",
        retainedPixelFormat: "linear-rgb-f32",
        bitDepth: 32,
        linearized: true,
        blackLevelSubtracted: false,
        whiteBalanceApplied: false,
        toneCurveApplied: false,
        noiseReductionApplied: false,
        lensCorrectionsApplied: false,
      },
      data,
    };
    this.captureIndex += 1;
    this.captureLog.push(capture.id);
    return capture;
  }

  async close() {
    this.opened = false;
    this.locked = false;
  }
}

export class PatternOverrideAdapter {
  async beginCalibration() {
    throw new CameraCalibrationError("PATTERN_ADAPTER_NOT_IMPLEMENTED", "PatternOverrideAdapter.beginCalibration is not implemented");
  }

  async showStep() {
    throw new CameraCalibrationError("PATTERN_ADAPTER_NOT_IMPLEMENTED", "PatternOverrideAdapter.showStep is not implemented");
  }

  async completeCalibration() {
    throw new CameraCalibrationError("PATTERN_ADAPTER_NOT_IMPLEMENTED", "PatternOverrideAdapter.completeCalibration is not implemented");
  }

  async failClosed() {
    throw new CameraCalibrationError("PATTERN_ADAPTER_NOT_IMPLEMENTED", "PatternOverrideAdapter.failClosed is not implemented");
  }
}

export class DeterministicPatternOverrideAdapter extends PatternOverrideAdapter {
  constructor() {
    super();
    this.active = false;
    this.expectedSequence = 0;
    this.mode = "content";
    this.verificationPlan = null;
    this.verificationCorrectionBinding = null;
    this.log = [];
  }

  async beginCalibration({ plan }) {
    if (this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_BUSY", "A calibration already owns the outputs");
    if (plan.sourcePolicy.arena !== "blanked") throw new CameraCalibrationError("ARENA_NOT_BLANKED", "Arena must be blanked for calibration");
    this.active = true;
    this.expectedSequence = 0;
    this.mode = "black";
    this.log.push("begin:black");
    return { exclusive: true, arenaBlanked: true, mode: "black" };
  }

  async showStep(step) {
    if (!this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_NOT_ACTIVE", "Calibration does not own the outputs");
    if (step.sequence !== this.expectedSequence) {
      throw new CameraCalibrationError("PATTERN_STEP_OUT_OF_ORDER", "Pattern steps must be rendered in sequence");
    }
    this.expectedSequence += 1;
    this.mode = step.pattern.kind;
    this.log.push(`step:${step.id}`);
    return { presented: true, exclusive: true, arenaBlanked: true, stepId: step.id };
  }

  async completeCalibration() {
    if (!this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_NOT_ACTIVE", "Calibration does not own the outputs");
    this.active = false;
    this.mode = "content";
    this.log.push("complete:content");
    return { restored: true, mode: "content" };
  }

  async failClosed({ reason }) {
    this.active = false;
    this.mode = "black";
    this.log.push(`failed:black:${reason?.code || "CALIBRATION_FAILED"}`);
    return { mode: "black", failClosed: true };
  }
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/** Production pattern owner backed by the interactive Windows D3D renderer. */
export class NativeRendererPatternOverrideAdapter extends PatternOverrideAdapter {
  constructor({ engine, settleTimeoutMs = 8_000, pollMs = 8 } = {}) {
    super();
    if (!engine || typeof engine.setPattern !== "function" || typeof engine.blank !== "function"
      || typeof engine.refreshStatus !== "function") {
      throw new CameraCalibrationError(
        "CALIBRATION_PATTERN_ADAPTER_UNAVAILABLE",
        "The active renderer does not expose native calibration pattern control",
      );
    }
    this.engine = engine;
    this.settleTimeoutMs = Math.max(500, Math.min(60_000, Number(settleTimeoutMs) || 8_000));
    this.pollMs = Math.max(1, Math.min(100, Number(pollMs) || 8));
    this.active = false;
    this.expectedSequence = 0;
    this.mode = "content";
  }

  #capabilities({ correctedSolid = false } = {}) {
    const capabilities = typeof this.engine.calibrationPatternCapabilities === "function"
      ? this.engine.calibrationPatternCapabilities()
      : this.engine.hello?.patterns;
    const modes = new Set(Array.isArray(capabilities?.modes) ? capabilities.modes.map(String) : []);
    const applyCorrectionsModes = new Set(
      Array.isArray(capabilities?.applyCorrectionsModes)
        ? capabilities.applyCorrectionsModes.map(String)
        : [],
    );
    if (!modes.has("solid") || !modes.has("gray-code")
      || capabilities?.rawCorrectionBypass !== true
      || capabilities?.targetIsolation !== true
      || capabilities?.preservesWarp !== true
      || capabilities?.solidEncoding !== "linear"
      || capabilities?.grayCodeCoordinate !== "physical-output-pixel"
      || (correctedSolid && !applyCorrectionsModes.has("solid"))) {
      throw new CameraCalibrationError(
        "CALIBRATION_PATTERN_ADAPTER_UNAVAILABLE",
        correctedSolid
          ? "Native renderer lacks the required raw Gray-code and corrected-solid verification contract"
          : "Native renderer lacks the required raw solid/Gray-code target-isolation contract",
        { patterns: capabilities ?? null },
      );
    }
    return capabilities;
  }

  #verificationBinding(plan, field) {
    const diagnostics = this.engine.diagnostics?.() || {};
    let expected;
    let active;
    try {
      expected = normalizeRendererCorrectionBinding(
        plan.rendererCorrectionBinding,
        "verification plan.rendererCorrectionBinding",
      );
      active = normalizeRendererCorrectionBinding(
        diagnostics.activeCorrectionBinding,
        `${field}.activeCorrectionBinding`,
      );
    } catch (error) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
        error?.message || "Native renderer correction binding is invalid",
        error?.details,
      );
    }
    if (diagnostics.connected !== true
      || diagnostics.ready !== true
      || Number(diagnostics.projectRevision) !== plan.project.appliedRevision
      || diagnostics.correctionBindingMatches !== true
      || diagnostics.activeCorrectionFingerprint !== expected.fingerprint
      || JSON.stringify(active) !== JSON.stringify(expected)
      || (this.verificationCorrectionBinding != null
        && JSON.stringify(active) !== JSON.stringify(this.verificationCorrectionBinding))) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
        "Native renderer does not retain the exact fresh applied correction receipt",
        {
          expectedRevision: plan.project.appliedRevision,
          rendererRevision: diagnostics.projectRevision ?? null,
          expectedFingerprint: expected.fingerprint,
          activeFingerprint: diagnostics.activeCorrectionFingerprint ?? null,
          correctionBindingMatches: diagnostics.correctionBindingMatches === true,
          connected: diagnostics.connected === true,
          ready: diagnostics.ready === true,
        },
      );
    }
    if (this.verificationCorrectionBinding == null) {
      this.verificationCorrectionBinding = structuredClone(active);
    }
    return { diagnostics, binding: active };
  }

  async #snapshot({ verificationPlan = null, field = "renderer status" } = {}) {
    const status = await this.engine.refreshStatus(
      verificationPlan == null
        ? undefined
        : { expectedCorrectionBinding: verificationPlan.rendererCorrectionBinding },
    );
    if (verificationPlan != null) this.#verificationBinding(verificationPlan, field);
    const outputs = Array.isArray(status?.outputs) ? status.outputs : [];
    return { status, outputs };
  }

  async #present(pattern, { outputId = null, settleFrames = 1, verification = false } = {}) {
    const verificationPlan = verification ? this.verificationPlan : null;
    const before = await this.#snapshot({ verificationPlan, field: "pre-pattern renderer status" });
    const targetedRawPattern = Boolean(outputId) && pattern.type !== "content";
    const expectedIds = outputId && !targetedRawPattern
      ? [String(outputId)]
      : before.outputs.map((output) => String(output.id));
    if (expectedIds.length === 0 || expectedIds.some((id) => !before.outputs.some((output) => String(output.id) === id))) {
      throw new CameraCalibrationError("CALIBRATION_OUTPUT_NOT_FOUND", "Native calibration output is not active");
    }
    const baseline = new Map(before.outputs.map((output) => [String(output.id), Number(output.renderedFrames) || 0]));
    await this.engine.setPattern({ ...pattern, ...(outputId ? { outputId: String(outputId) } : {}) });
    const requiredFrames = Math.max(1, Math.min(120, Math.round(Number(settleFrames) || 1)));
    const deadline = Date.now() + this.settleTimeoutMs;
    while (Date.now() <= deadline) {
      const current = await this.#snapshot({ verificationPlan, field: "settled-pattern renderer status" });
      const ready = expectedIds.every((id) => {
        const output = current.outputs.find((candidate) => String(candidate.id) === id);
        const target = !targetedRawPattern || id === String(outputId);
        const expectedMode = target ? pattern.type : "black";
        const parameters = output?.patternParameters && typeof output.patternParameters === "object"
          ? output.patternParameters
          : {};
        const solidMatches = expectedMode !== "solid" || (Array.isArray(parameters.rgb)
          && parameters.rgb.length === 3
          && parameters.rgb.every((channel, index) => Math.abs(Number(channel) - Number(pattern.rgb[index])) <= 1e-6)
          && (!verification || parameters.applyCorrections === (pattern.applyCorrections === true)));
        const grayMatches = expectedMode !== "gray-code" || (
          parameters.axis === pattern.axis
          && Number(parameters.bit) === Number(pattern.bit)
          && parameters.inverse === Boolean(pattern.inverse)
        );
        const expectedBypass = !target || pattern.applyCorrections !== true;
        const exactVerificationPath = !verification || expectedMode === "content" || (
          output.processingBypass === false
          && output.correctionsBypassed === expectedBypass
          && (target || Object.keys(parameters).length === 0)
        );
        return output && output.blank !== true
          && String(output.pattern) === expectedMode
          && (expectedMode === "content" || verification || output.correctionsBypassed === true)
          && exactVerificationPath
          && solidMatches
          && grayMatches
          && (Number(output.renderedFrames) || 0) >= (baseline.get(id) || 0) + requiredFrames;
      });
      if (ready) {
        return {
          status: current.status,
          outputs: current.outputs,
          renderedFramesBefore: baseline,
        };
      }
      await waitMilliseconds(this.pollMs);
    }
    throw new CameraCalibrationError(
      "CALIBRATION_PATTERN_PRESENT_TIMEOUT",
      `Native renderer did not present ${requiredFrames} settled calibration frame(s) in time`,
      { outputId },
    );
  }

  async beginCalibration({ plan }) {
    if (this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_BUSY", "A calibration already owns the outputs");
    if (plan.sourcePolicy.arena !== "blanked") throw new CameraCalibrationError("ARENA_NOT_BLANKED", "Arena must be overridden for calibration");
    this.#capabilities();
    const status = await this.#snapshot();
    const activeIds = new Set(status.outputs.filter((output) => output.active !== false).map((output) => String(output.id)));
    const missing = plan.outputs.map((output) => output.id).filter((id) => !activeIds.has(id));
    if (missing.length > 0) {
      throw new CameraCalibrationError("CALIBRATION_OUTPUT_NOT_FOUND", "One or more calibration outputs are not active", { missing });
    }
    // Blank is a stronger sticky override than patterns. Clear it first, then
    // establish raw digital black across every output before any capture.
    await this.engine.blank(false);
    await this.#present({ type: "solid", rgb: [0, 0, 0] }, { settleFrames: 1 });
    this.active = true;
    this.expectedSequence = 0;
    this.mode = "black";
    return {
      exclusive: true,
      arenaBlanked: true,
      mode: "black",
      postWarpCoordinates: true,
      identityRaster: false,
    };
  }

  async beginVerification({ plan, nodeProjectRevision }) {
    if (this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_BUSY", "A calibration or verification already owns the outputs");
    this.#capabilities({ correctedSolid: true });
    if (Number(nodeProjectRevision) !== plan.project.appliedRevision) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_REVISION_MISMATCH",
        "Node project revision does not match the immutable verification lease",
        {
          expectedRevision: plan.project.appliedRevision,
          nodeProjectRevision,
        },
      );
    }
    this.verificationPlan = plan;
    this.verificationCorrectionBinding = null;
    let snapshot;
    try {
      snapshot = await this.#snapshot({ verificationPlan: plan, field: "verification preflight renderer status" });
    } catch (error) {
      this.verificationPlan = null;
      this.verificationCorrectionBinding = null;
      throw error;
    }
    const activeIds = snapshot.outputs
      .filter((output) => output.active !== false)
      .map((output) => String(output.id));
    const expectedIds = plan.outputs.map((output) => String(output.id));
    const expectedSet = new Set(expectedIds);
    const selectedActiveIds = activeIds.filter((id) => expectedSet.has(id));
    if (selectedActiveIds.length !== expectedIds.length
      || expectedIds.some((id, index) => selectedActiveIds[index] !== id)) {
      throw new CameraCalibrationError(
        "CALIBRATION_OUTPUT_NOT_FOUND",
        "Native verification outputs do not contain the authoritative plan outputs in exact relative order",
        { activeIds, expectedIds },
      );
    }
    // Sticky blank is established before any physical-condition prompt. A
    // projected step is the only path allowed to clear it temporarily.
    await this.engine.blank(true);
    this.active = true;
    this.expectedSequence = 0;
    this.mode = "black";
    this.verificationOutputIds = expectedIds;
    const renderer = await this.verificationRendererEvidence({ plan, nodeProjectRevision });
    return {
      exclusive: true,
      arenaBlanked: true,
      mode: "black",
      renderer,
    };
  }

  async verificationRendererEvidence({ plan, nodeProjectRevision }) {
    const capabilities = this.#capabilities({ correctedSolid: true });
    if (Number(nodeProjectRevision) !== plan.project.appliedRevision) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_REVISION_MISMATCH",
        "Node revision changed during optical verification",
      );
    }
    const snapshot = await this.#snapshot({
      verificationPlan: plan,
      field: "verification evidence renderer status",
    });
    const { binding: activeCorrectionBinding } = this.#verificationBinding(
      plan,
      "verification evidence renderer status",
    );
    const planOutputIds = new Set(plan.outputs.map((output) => output.id));
    const boundOutputIds = activeCorrectionBinding.outputs
      .map((output) => output.id)
      .filter((id) => planOutputIds.has(id));
    const activeOutputIds = new Set(
      snapshot.outputs.filter((output) => output.active !== false).map((output) => String(output.id)),
    );
    if (boundOutputIds.length !== plan.outputs.length
      || boundOutputIds.some((id, index) => id !== plan.outputs[index].id || !activeOutputIds.has(id))) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
        "Fresh renderer correction receipt does not bind every active verification output in plan order",
      );
    }
    return {
      nodeProjectRevision: plan.project.appliedRevision,
      rendererProjectRevision: plan.project.appliedRevision,
      connected: true,
      ready: true,
      acknowledgedAt: plan.rendererAcknowledgedAt,
      capabilities: {
        correctedSolid: capabilities.applyCorrectionsModes.includes("solid"),
        rawGrayCode: capabilities.modes.includes("gray-code") && capabilities.rawCorrectionBypass === true,
        preservesWarp: capabilities.preservesWarp === true,
        targetIsolation: capabilities.targetIsolation === true,
      },
      outputBindings: boundOutputIds.map((outputId) => ({
        outputId,
        calibrationSessionId: plan.calibrationSessionId,
      })),
      activeCorrectionBinding,
      activeCorrectionFingerprint: activeCorrectionBinding.fingerprint,
    };
  }

  async showStep(step) {
    if (!this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_NOT_ACTIVE", "Calibration does not own the outputs");
    if (step.sequence !== this.expectedSequence) {
      throw new CameraCalibrationError("PATTERN_STEP_OUT_OF_ORDER", "Pattern steps must be rendered in sequence");
    }
    if (step.captureConditions?.projectorState === "emission-off") {
      // Do not present a raster after the operator/controller has disabled the
      // emitters. Keep the renderer fail-closed until a later, explicitly
      // verified step restores projector emission.
      await this.engine.blank(true);
      this.expectedSequence += 1;
      this.mode = "emission-off";
      return {
        presented: true,
        exclusive: true,
        arenaBlanked: true,
        stepId: step.id,
        conditionVerification: {
          method: "renderer-blank-plus-operator-emission-verification",
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    await this.engine.blank(false);
    let pattern;
    if (step.pattern?.kind === "solid") {
      pattern = { type: "solid", rgb: step.pattern.rgb };
    } else if (step.pattern?.kind === "gray-code") {
      pattern = {
        type: "gray-code",
        axis: step.pattern.axis,
        bit: step.pattern.bit,
        inverse: step.pattern.inverse,
      };
    } else {
      throw new CameraCalibrationError("UNSUPPORTED_CALIBRATION_PATTERN", `Unsupported calibration pattern: ${step.pattern?.kind}`);
    }
    await this.#present(pattern, { outputId: step.outputId, settleFrames: step.settleFrames });
    this.expectedSequence += 1;
    this.mode = step.pattern.kind;
    return { presented: true, exclusive: true, arenaBlanked: true, stepId: step.id };
  }

  async showVerificationStep(step) {
    if (!this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_NOT_ACTIVE", "Verification does not own the outputs");
    if (step.sequence !== this.expectedSequence) {
      throw new CameraCalibrationError("PATTERN_STEP_OUT_OF_ORDER", "Verification patterns must be rendered in sequence");
    }
    if (step.captureConditions?.projectorState === "emission-off") {
      await this.engine.blank(true);
      await this.#snapshot({
        verificationPlan: this.verificationPlan,
        field: "emission-off renderer status",
      });
      this.expectedSequence += 1;
      this.mode = "emission-off";
      return {
        presented: true,
        exclusive: true,
        arenaBlanked: true,
        stepId: step.id,
        presentation: null,
      };
    }
    if (!step.pattern || !["solid", "gray-code"].includes(step.pattern.type)) {
      throw new CameraCalibrationError(
        "UNSUPPORTED_CALIBRATION_PATTERN",
        `Unsupported optical verification pattern: ${step.pattern?.type || "none"}`,
      );
    }
    await this.engine.blank(false);
    const presented = await this.#present(step.pattern, {
      outputId: step.outputId,
      settleFrames: step.settleFrames,
      verification: true,
    });
    const byId = new Map(presented.outputs.map((output) => [String(output.id), output]));
    const outputs = this.verificationOutputIds.map((id) => {
      const output = byId.get(id);
      const targeted = step.outputId == null || String(step.outputId) === id;
      const expectedPattern = targeted ? step.pattern.type : "black";
      const patternParameters = targeted
        ? step.pattern.type === "solid"
          ? { rgb: [...step.pattern.rgb], applyCorrections: step.pattern.applyCorrections === true }
          : { axis: step.pattern.axis, bit: step.pattern.bit, inverse: step.pattern.inverse === true }
        : {};
      return {
        id,
        pattern: expectedPattern,
        patternParameters,
        correctionsBypassed: !targeted || step.pattern.applyCorrections !== true,
        processingBypass: false,
        blank: false,
        renderedFramesBefore: presented.renderedFramesBefore.get(id) || 0,
        renderedFramesAfter: Number(output.renderedFrames) || 0,
      };
    });
    this.expectedSequence += 1;
    this.mode = step.pattern.type;
    return {
      presented: true,
      exclusive: true,
      arenaBlanked: true,
      stepId: step.id,
      presentation: { outputs },
    };
  }

  async completeCalibration() {
    if (!this.active) throw new CameraCalibrationError("PATTERN_OVERRIDE_NOT_ACTIVE", "Calibration does not own the outputs");
    await this.#present({ type: "content" }, { settleFrames: 2 });
    const current = await this.#snapshot();
    const restored = current.outputs.every((output) => output.blank !== true && String(output.pattern) === "content");
    if (!restored) throw new CameraCalibrationError("CONTENT_RESTORE_FAILED", "Native renderer did not confirm content mode");
    this.active = false;
    this.mode = "content";
    return { restored: true, mode: "content" };
  }

  async completeVerification() {
    const result = await this.completeCalibration();
    await this.#snapshot({
      verificationPlan: this.verificationPlan,
      field: "restored-content renderer status",
    });
    this.verificationPlan = null;
    this.verificationCorrectionBinding = null;
    return result;
  }

  async restoreAfterRollback({ projectRevision }) {
    const expectedRevision = Number(projectRevision);
    const before = this.engine.diagnostics?.() || {};
    if (!Number.isSafeInteger(expectedRevision)
      || Number(before.projectRevision) !== expectedRevision
      || before.connected !== true
      || before.ready !== true) {
      throw new CameraCalibrationError(
        "OPTICAL_VERIFICATION_REVISION_MISMATCH",
        "Cannot restore content until the native renderer confirms the rollback target revision",
      );
    }
    await this.engine.blank(false);
    await this.#present({ type: "content" }, { settleFrames: 2 });
    const current = await this.#snapshot();
    const diagnostics = this.engine.diagnostics?.() || {};
    const restored = Number(diagnostics.projectRevision) === expectedRevision
      && diagnostics.connected === true
      && diagnostics.ready === true
      && current.outputs.every((output) => output.blank !== true && String(output.pattern) === "content");
    if (!restored) {
      await this.engine.blank(true).catch(() => {});
      throw new CameraCalibrationError("CONTENT_RESTORE_FAILED", "Native renderer did not confirm rollback content mode");
    }
    this.active = false;
    this.mode = "content";
    this.verificationPlan = null;
    this.verificationCorrectionBinding = null;
    return { restored: true, mode: "content", projectRevision: expectedRevision };
  }

  async failClosed({ reason } = {}) {
    await this.engine.blank(true);
    this.active = false;
    this.mode = "black";
    this.verificationPlan = null;
    this.verificationCorrectionBinding = null;
    return { mode: "black", failClosed: true, reason: reason?.code || "CALIBRATION_FAILED" };
  }
}

function captureLuma(capture) {
  const pixels = Number(capture?.width) * Number(capture?.height);
  if (!(capture?.data instanceof Float32Array) || !Number.isSafeInteger(pixels) || pixels < 1) {
    throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Solver requires a finite Float32 camera raster");
  }
  if (capture.pixelFormat === "linear-luma-f32" && capture.data.length === pixels) {
    return capture.data;
  }
  if (capture.pixelFormat !== "linear-rgb-f32" || capture.data.length !== pixels * 3) {
    throw new CameraCalibrationError(
      "INVALID_CAMERA_FRAME",
      "Solver requires linear-rgb-f32 or bounded linear-luma-f32 camera frames",
    );
  }
  const luma = new Float32Array(pixels);
  for (let index = 0; index < luma.length; index += 1) {
    const offset = index * 3;
    luma[index] = clamp(capture.data[offset] * 0.2126 + capture.data[offset + 1] * 0.7152 + capture.data[offset + 2] * 0.0722);
  }
  return luma;
}

function captureRgb(capture) {
  const radiometric = capture?.radiometricRgb;
  if (radiometric) {
    const pixels = Number(radiometric.width) * Number(radiometric.height);
    if (radiometric.pixelFormat !== "linear-rgb-f32" || !(radiometric.data instanceof Float32Array)
      || !Number.isSafeInteger(pixels) || pixels < 1 || radiometric.data.length !== pixels * 3) {
      throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Radiometric RGB raster is invalid or truncated");
    }
    return radiometric;
  }
  const pixels = Number(capture?.width) * Number(capture?.height);
  if (capture?.pixelFormat !== "linear-rgb-f32" || !(capture.data instanceof Float32Array)
    || !Number.isSafeInteger(pixels) || pixels < 1 || capture.data.length !== pixels * 3) {
    throw new CameraCalibrationError(
      "MISSING_RADIOMETRIC_RGB_CAPTURE",
      "Measured color calibration requires a retained linear RGB raster",
    );
  }
  return { width: capture.width, height: capture.height, pixelFormat: capture.pixelFormat, data: capture.data };
}

function boundedDimensions(width, height, pixelLimit, widthLimit, heightLimit) {
  const scale = Math.min(1, Math.sqrt(pixelLimit / (width * height)), widthLimit / width, heightLimit / height);
  let targetWidth = Math.max(2, Math.floor(width * scale));
  let targetHeight = Math.max(2, Math.floor(height * scale));
  while (targetWidth * targetHeight > pixelLimit) {
    if (targetWidth >= targetHeight && targetWidth > 2) targetWidth -= 1;
    else if (targetHeight > 2) targetHeight -= 1;
    else break;
  }
  return { width: targetWidth, height: targetHeight };
}

function areaBinCapture(capture, { targetWidth, targetHeight, outputChannels }) {
  const width = Number(capture.width);
  const height = Number(capture.height);
  const sourceChannels = capture.pixelFormat === "linear-rgb-f32" ? 3 : 1;
  const targetPixels = targetWidth * targetHeight;
  const sums = new Float64Array(targetPixels * outputChannels);
  const counts = new Uint32Array(targetPixels);
  for (let y = 0; y < height; y += 1) {
    const targetY = Math.min(targetHeight - 1, Math.floor(y * targetHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = y * width + x;
      const targetIndex = targetY * targetWidth
        + Math.min(targetWidth - 1, Math.floor(x * targetWidth / width));
      if (outputChannels === 1) {
        const value = sourceChannels === 1
          ? Number(capture.data[sourceIndex])
          : Number(capture.data[sourceIndex * 3]) * 0.2126
            + Number(capture.data[sourceIndex * 3 + 1]) * 0.7152
            + Number(capture.data[sourceIndex * 3 + 2]) * 0.0722;
        if (!Number.isFinite(value)) throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Camera frame contains a non-finite sample");
        sums[targetIndex] += clamp(value);
      } else {
        if (sourceChannels !== 3) {
          throw new CameraCalibrationError(
            "MISSING_RADIOMETRIC_RGB_CAPTURE",
            "The camera returned luma for a step that requires linear RGB radiometry",
          );
        }
        for (let channel = 0; channel < 3; channel += 1) {
          const value = Number(capture.data[sourceIndex * 3 + channel]);
          if (!Number.isFinite(value)) throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Camera frame contains a non-finite sample");
          sums[targetIndex * 3 + channel] += clamp(value);
        }
      }
      counts[targetIndex] += 1;
    }
  }
  const data = new Float32Array(targetPixels * outputChannels);
  for (let index = 0; index < targetPixels; index += 1) {
    if (counts[index] < 1) throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Camera downsample produced an empty bin");
    for (let channel = 0; channel < outputChannels; channel += 1) {
      data[index * outputChannels + channel] = sums[index * outputChannels + channel] / counts[index];
    }
  }
  return data;
}

/**
 * Convert one adapter frame immediately to a bounded linear-luma raster. The
 * adapter receives the same limits before capture, but this function enforces
 * them even when a third-party adapter ignores the hint. Area binning avoids
 * inventing high-frequency Gray-code contrast while reducing retained memory
 * from 12 bytes/pixel RGB to 4 bytes/pixel luma.
 */
export function boundCalibrationCapture(capture, {
  maxPixels,
  maxWidth = 4_096,
  maxHeight = 4_096,
  maxRawBytes = 384 * 1024 * 1024,
  preserveRadiometricRgb = false,
  maxRadiometricPixels = 262_144,
} = {}) {
  const width = Math.round(Number(capture?.width));
  const height = Math.round(Number(capture?.height));
  const pixelLimit = Math.round(Number(maxPixels));
  const widthLimit = Math.round(Number(maxWidth));
  const heightLimit = Math.round(Number(maxHeight));
  const rawByteLimit = Math.round(Number(maxRawBytes));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2
    || !Number.isSafeInteger(pixelLimit) || pixelLimit < 4
    || !Number.isSafeInteger(widthLimit) || widthLimit < 2
    || !Number.isSafeInteger(heightLimit) || heightLimit < 2
    || !Number.isSafeInteger(rawByteLimit) || rawByteLimit < 1) {
    throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Camera capture dimensions or memory limit are invalid");
  }
  if (!(capture?.data instanceof Float32Array) || capture.data.byteLength > rawByteLimit) {
    throw new CameraCalibrationError(
      "CALIBRATION_CAPTURE_TOO_LARGE",
      `Camera adapter returned more than the ${rawByteLimit}-byte raw-frame safety limit`,
      { byteLength: capture?.data?.byteLength ?? null, maxRawBytes: rawByteLimit },
    );
  }
  const sourcePixels = width * height;
  const channels = capture.pixelFormat === "linear-rgb-f32" ? 3
    : capture.pixelFormat === "linear-luma-f32" ? 1 : 0;
  if (channels === 0 || capture.data.length !== sourcePixels * channels) {
    throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Camera adapter returned an unsupported or truncated linear frame");
  }
  const lumaDimensions = boundedDimensions(width, height, pixelLimit, widthLimit, heightLimit);
  const data = areaBinCapture(capture, {
    targetWidth: lumaDimensions.width,
    targetHeight: lumaDimensions.height,
    outputChannels: 1,
  });
  let radiometricRgb;
  if (preserveRadiometricRgb) {
    const rgbPixelLimit = Math.round(Number(maxRadiometricPixels));
    if (!Number.isSafeInteger(rgbPixelLimit) || rgbPixelLimit < 4) {
      throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Radiometric RGB pixel limit is invalid");
    }
    const rgbDimensions = boundedDimensions(width, height, rgbPixelLimit, widthLimit, heightLimit);
    radiometricRgb = {
      width: rgbDimensions.width,
      height: rgbDimensions.height,
      pixelFormat: "linear-rgb-f32",
      data: areaBinCapture(capture, {
        targetWidth: rgbDimensions.width,
        targetHeight: rgbDimensions.height,
        outputChannels: 3,
      }),
    };
  }
  const retainedByteLength = data.byteLength + (radiometricRgb?.data.byteLength || 0);
  // Do not spread adapter-owned objects into retained session state. Besides
  // making provenance ambiguous, an extra Buffer/TypedArray property could
  // otherwise bypass maxRawBytes and remain live in every stack. Retain only
  // the scalar/contract metadata the solver actually consumes.
  return {
    id: capture.id,
    adapterCaptureId: capture.adapterCaptureId ?? null,
    stepId: capture.stepId,
    outputId: capture.outputId ?? null,
    repeat: capture.repeat ?? null,
    passId: capture.passId ?? null,
    exposureProfileId: capture.exposureProfileId ?? null,
    exposureSettings: capture.exposureSettings ?? null,
    exposure: capture.exposure ?? null,
    referenceKind: capture.referenceKind ?? null,
    capturedAt: capture.capturedAt,
    bitDepth: capture.bitDepth,
    linearized: capture.linearized,
    width: lumaDimensions.width,
    height: lumaDimensions.height,
    pixelFormat: "linear-luma-f32",
    data,
    ...(radiometricRgb ? { radiometricRgb } : {}),
    boundedCapture: {
      sourceWidth: width,
      sourceHeight: height,
      sourcePixelFormat: capture.pixelFormat,
      sourceByteLength: capture.data.byteLength,
      retainedByteLength,
      downsampled: lumaDimensions.width !== width || lumaDimensions.height !== height,
      radiometricRgb: radiometricRgb ? {
        width: radiometricRgb.width,
        height: radiometricRgb.height,
        retainedByteLength: radiometricRgb.data.byteLength,
      } : null,
    },
  };
}

function medianOfThree(first, second, third) {
  return Math.max(Math.min(first, second), Math.min(Math.max(first, second), third));
}

/**
 * Bounded, outlier-resistant stack. Only three group sums are live regardless
 * of repeat count; the final sample is the per-component median of the three
 * group means. This prevents 16-32 long-exposure frames from accumulating in
 * session memory while retaining a conservative group-spread uncertainty.
 */
export class RobustCaptureAccumulator {
  constructor({ retainLumaUncertainty = false, retainRgbUncertainty = false } = {}) {
    this.retainLumaUncertainty = retainLumaUncertainty;
    this.retainRgbUncertainty = retainRgbUncertainty;
    this.count = 0;
    this.first = null;
    this.lumaSums = null;
    this.rgbSums = null;
    this.rgbDescriptor = null;
    this.groupCounts = [0, 0, 0];
    this.sourceCaptureIds = [];
  }

  add(capture) {
    const luma = captureLuma(capture);
    const rgb = capture.radiometricRgb || capture.pixelFormat === "linear-rgb-f32" ? captureRgb(capture) : null;
    if (!this.first) {
      this.first = capture;
      this.lumaSums = Array.from({ length: 3 }, () => new Float64Array(luma.length));
      this.rgbSums = rgb ? Array.from({ length: 3 }, () => new Float64Array(rgb.data.length)) : null;
      this.rgbDescriptor = rgb ? { width: rgb.width, height: rgb.height, pixelFormat: "linear-rgb-f32" } : null;
    } else if (capture.width !== this.first.width || capture.height !== this.first.height
      || luma.length !== this.lumaSums[0].length
      || Boolean(rgb) !== Boolean(this.rgbSums)
      || (rgb && (rgb.width !== this.rgbDescriptor.width || rgb.height !== this.rgbDescriptor.height))) {
      throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Camera frame size or format changed inside a repeat stack");
    }
    const group = this.count % 3;
    for (let index = 0; index < luma.length; index += 1) this.lumaSums[group][index] += luma[index];
    if (rgb) {
      for (let index = 0; index < rgb.data.length; index += 1) this.rgbSums[group][index] += rgb.data[index];
    }
    this.groupCounts[group] += 1;
    this.sourceCaptureIds.push(String(capture.id));
    this.count += 1;
  }

  #finishRaster(groupSums, retainUncertainty) {
    const populated = this.groupCounts.map((count, index) => ({ count, sums: groupSums[index] }))
      .filter((group) => group.count > 0);
    const output = new Float32Array(groupSums[0].length);
    const uncertainty = retainUncertainty && populated.length >= 2 ? new Float32Array(output.length) : null;
    const spreadSamples = [];
    const spreadStride = Math.max(1, Math.floor(output.length / 8_192));
    for (let index = 0; index < output.length; index += 1) {
      const values = populated.map((group) => group.sums[index] / group.count);
      if (values.length === 1) output[index] = values[0];
      else if (values.length === 2) output[index] = (values[0] + values[1]) / 2;
      else output[index] = medianOfThree(values[0], values[1], values[2]);
      if (uncertainty) {
        let minimum = values[0];
        let maximum = values[0];
        for (const value of values) {
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
        uncertainty[index] = (maximum - minimum) / 2;
      }
      if (populated.length >= 2 && index % spreadStride === 0) {
        spreadSamples.push((Math.max(...values) - Math.min(...values)) / 2);
      }
    }
    return {
      data: output,
      uncertainty,
      groupSpreadP95: spreadSamples.length ? percentile(spreadSamples, 0.95) : 0,
    };
  }

  finish({ step = null } = {}) {
    if (!this.first || this.count < 1) {
      throw new CameraCalibrationError("MISSING_CALIBRATION_CAPTURE", "Cannot finish an empty camera repeat stack");
    }
    const luma = this.#finishRaster(this.lumaSums, this.retainLumaUncertainty);
    const rgb = this.rgbSums ? this.#finishRaster(this.rgbSums, this.retainRgbUncertainty) : null;
    const retainedByteLength = luma.data.byteLength + (luma.uncertainty?.byteLength || 0)
      + (rgb?.data.byteLength || 0) + (rgb?.uncertainty?.byteLength || 0);
    return {
      ...this.first,
      id: `${step?.id || this.first.stepId || "capture"}#stack`,
      repeat: null,
      data: luma.data,
      ...(luma.uncertainty ? { uncertainty: luma.uncertainty } : {}),
      ...(rgb ? {
        radiometricRgb: {
          ...this.rgbDescriptor,
          data: rgb.data,
          ...(rgb.uncertainty ? { uncertainty: rgb.uncertainty } : {}),
        },
      } : {}),
      sourceCaptureIds: [...this.sourceCaptureIds],
      robustStack: {
        method: step?.retention?.aggregationMethod
          || (this.count >= 3 ? "median-of-means-3" : "mean-insufficient-repeats"),
        repeats: this.count,
        groups: this.groupCounts.filter((count) => count > 0).length,
        groupCounts: this.groupCounts.filter((count) => count > 0),
        groupSpreadP95: this.count >= 3
          ? Math.max(luma.groupSpreadP95, rgb?.groupSpreadP95 || 0)
          : null,
        uncertaintyKnown: this.count >= 3,
      },
      boundedCapture: {
        ...this.first.boundedCapture,
        retainedByteLength,
      },
    };
  }
}

function averageFrames(frames) {
  if (!frames.length) throw new CameraCalibrationError("MISSING_CALIBRATION_CAPTURE", "A required capture is missing");
  const first = captureLuma(frames[0]);
  const average = new Float32Array(first.length);
  for (const frame of frames) {
    const luma = captureLuma(frame);
    if (luma.length !== average.length) throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Camera frame size changed during calibration");
    for (let index = 0; index < average.length; index += 1) average[index] += luma[index] / frames.length;
  }
  return average;
}

function mean(values) {
  let total = 0;
  for (const value of values) total += Number(value) || 0;
  return total / Math.max(1, values.length);
}

function asGray8(values) {
  return Uint8Array.from(values, (value) => Math.round(clamp(value) * 255));
}

function digestBuffer(value) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof Float32Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return { sha256: createHash("sha256").update(buffer).digest("hex"), byteLength: buffer.byteLength };
}

function assetRef({ uri, format, value, width = null, height = null, size = null }) {
  const digest = digestBuffer(value);
  return {
    uri,
    sha256: digest.sha256,
    byteLength: digest.byteLength,
    format,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(size == null ? {} : { size }),
  };
}

function capturesForStep(captures, stepId) {
  return captures.filter((capture) => capture.stepId === stepId);
}

function captureIdsForSteps(captures, predicate = () => true) {
  const ids = [];
  for (const capture of captures) {
    if (!predicate(capture)) continue;
    const sourceIds = Array.isArray(capture.sourceCaptureIds) && capture.sourceCaptureIds.length
      ? capture.sourceCaptureIds
      : [capture.id];
    ids.push(...sourceIds.map(String));
  }
  return ids;
}

function robustCaptureForStep(captures, step, { requireRgb = false } = {}) {
  const frames = capturesForStep(captures, step?.id);
  if (!frames.length) {
    throw new CameraCalibrationError("MISSING_CALIBRATION_CAPTURE", `A required capture is missing: ${step?.id || "unknown step"}`);
  }
  let capture = frames[0];
  if (frames.length > 1) {
    const accumulator = new RobustCaptureAccumulator({
      retainLumaUncertainty: true,
      retainRgbUncertainty: requireRgb,
    });
    for (const frame of frames) accumulator.add(frame);
    capture = accumulator.finish({ step });
  }
  if (requireRgb) captureRgb(capture);
  return capture;
}

function identityLut(size = 2) {
  const values = new Float32Array(size * size * size * 4);
  let offset = 0;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        values[offset++] = red / (size - 1);
        values[offset++] = green / (size - 1);
        values[offset++] = blue / (size - 1);
        values[offset++] = 1;
      }
    }
  }
  return values;
}

function resampleScalarMap(values, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (values.length !== sourceWidth * sourceHeight) {
    throw new CameraCalibrationError("INVALID_SOLVER_MAP", "Scalar map dimensions do not match its payload");
  }
  const output = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = targetHeight === 1 ? 0 : y / (targetHeight - 1) * (sourceHeight - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(sourceHeight - 1, y0 + 1);
    const ty = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = targetWidth === 1 ? 0 : x / (targetWidth - 1) * (sourceWidth - 1);
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const tx = sourceX - x0;
      const top = values[y0 * sourceWidth + x0] * (1 - tx) + values[y0 * sourceWidth + x1] * tx;
      const bottom = values[y1 * sourceWidth + x0] * (1 - tx) + values[y1 * sourceWidth + x1] * tx;
      output[y * targetWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return output;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new CameraCalibrationError("CALIBRATION_CANCELLED", "Camera calibration was cancelled");
}

/**
 * Invert a decoded camera→projector correspondence by splatting camera-space
 * measurements into physical projector pixels. This deliberately does not
 * resize the camera image: every contribution lands at the Gray-code address
 * measured for that camera pixel. Unknown/unseen projector pixels remain zero,
 * which is the fail-closed value for mask, blend and additive correction maps.
 */
export function scatterCameraMapToProjector({
  values,
  cameraWidth,
  cameraHeight,
  projectorWidth,
  projectorHeight,
  projectorX,
  projectorY,
  confidence = null,
  sampleMask = null,
  minimumConfidence = 0.08,
  signal = null,
  returnMetadata = false,
} = {}) {
  const sourceWidth = Math.round(Number(cameraWidth));
  const sourceHeight = Math.round(Number(cameraHeight));
  const outputWidth = Math.round(Number(projectorWidth));
  const outputHeight = Math.round(Number(projectorHeight));
  if (![sourceWidth, sourceHeight, outputWidth, outputHeight].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new CameraCalibrationError("INVALID_SOLVER_MAP", "Camera and projector map dimensions must be positive integers");
  }
  const sourcePixels = sourceWidth * sourceHeight;
  if (values?.length !== sourcePixels || projectorX?.length !== sourcePixels || projectorY?.length !== sourcePixels
    || (confidence && confidence.length !== sourcePixels) || (sampleMask && sampleMask.length !== sourcePixels)) {
    throw new CameraCalibrationError("INVALID_SOLVER_MAP", "Camera-space values and correspondence arrays must have equal dimensions");
  }
  const outputPixels = outputWidth * outputHeight;
  const sums = new Float32Array(outputPixels);
  const weights = new Float32Array(outputPixels);
  const confidenceFloor = clamp(minimumConfidence, 0, 1);
  for (let index = 0; index < sourcePixels; index += 1) {
    if ((index & 0xffff) === 0) throwIfCancelled(signal);
    const value = Number(values[index]);
    const x = Number(projectorX[index]);
    const y = Number(projectorY[index]);
    const score = confidence ? Number(confidence[index]) : 1;
    if (!Number.isFinite(value) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(score)
      || score < confidenceFloor || x < 0 || y < 0 || x > outputWidth - 1 || y > outputHeight - 1
      || (sampleMask && Number(sampleMask[index]) <= 0)) continue;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(outputWidth - 1, x0 + 1);
    const y1 = Math.min(outputHeight - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const contributions = [
      [x0, y0, (1 - tx) * (1 - ty)],
      [x1, y0, tx * (1 - ty)],
      [x0, y1, (1 - tx) * ty],
      [x1, y1, tx * ty],
    ];
    for (const [px, py, coverage] of contributions) {
      if (coverage <= 0) continue;
      const outputIndex = py * outputWidth + px;
      const weight = coverage * score;
      sums[outputIndex] += value * weight;
      weights[outputIndex] += weight;
    }
  }
  throwIfCancelled(signal);
  const output = new Float32Array(outputPixels);
  let coveredPixels = 0;
  let left = outputWidth;
  let top = outputHeight;
  let right = -1;
  let bottom = -1;
  const tileColumns = Math.min(64, outputWidth);
  const tileRows = Math.min(64, outputHeight);
  const occupiedTiles = new Uint8Array(tileColumns * tileRows);
  for (let index = 0; index < outputPixels; index += 1) {
    if (weights[index] <= 1e-12) continue;
    output[index] = sums[index] / weights[index];
    coveredPixels += 1;
    const x = index % outputWidth;
    const y = Math.floor(index / outputWidth);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
    const tileX = Math.min(tileColumns - 1, Math.floor(x * tileColumns / outputWidth));
    const tileY = Math.min(tileRows - 1, Math.floor(y * tileRows / outputHeight));
    occupiedTiles[tileY * tileColumns + tileX] = 1;
  }
  if (!returnMetadata) return output;
  let tileLeft = tileColumns;
  let tileTop = tileRows;
  let tileRight = -1;
  let tileBottom = -1;
  let occupiedTileCount = 0;
  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      if (!occupiedTiles[tileY * tileColumns + tileX]) continue;
      occupiedTileCount += 1;
      tileLeft = Math.min(tileLeft, tileX);
      tileTop = Math.min(tileTop, tileY);
      tileRight = Math.max(tileRight, tileX);
      tileBottom = Math.max(tileBottom, tileY);
    }
  }
  const boundingPixels = coveredPixels > 0 ? (right - left + 1) * (bottom - top + 1) : 0;
  const boundingTiles = occupiedTileCount > 0 ? (tileRight - tileLeft + 1) * (tileBottom - tileTop + 1) : 0;
  return {
    values: output,
    coverage: {
      coveredPixels,
      boundingPixels,
      pixelRatio: coveredPixels / outputPixels,
      boundingPixelRatio: boundingPixels > 0 ? coveredPixels / boundingPixels : 0,
      occupiedTiles: occupiedTileCount,
      boundingTiles,
      tileRatio: occupiedTileCount / (tileColumns * tileRows),
      boundingTileRatio: boundingTiles > 0 ? occupiedTileCount / boundingTiles : 0,
      bounds: coveredPixels > 0 ? { left, top, right, bottom } : null,
      filledPixels: 0,
    },
  };
}

/**
 * Every black capture is made while all projectors output digital black, so it
 * observes the same room-wide optical baseline. Average those captures once,
 * compute one union target, then divide the additive correction by the blend
 * weights. Camera-space correction is divided by each projector's measured
 * white response before materialization, yielding the source-linear units the
 * shader consumes. Applying N overlapping outputs therefore produces the
 * requested optical lift once, not N times.
 */
export function allocateCombinedBlackCorrection({
  blackFrames,
  masks,
  blendWeights,
  uncertaintyFrames = null,
  responseScales = null,
  requireUncertainty = false,
  uncertaintySigma = 2,
  targetPercentile = 0.98,
  maxLift = 0.35,
} = {}) {
  if (!Array.isArray(blackFrames) || blackFrames.length < 1
    || !Array.isArray(masks) || masks.length !== blackFrames.length
    || !Array.isArray(blendWeights) || blendWeights.length !== blackFrames.length) {
    throw new CameraCalibrationError(
      "INVALID_SOLVER_MAP",
      "Black frames, surface masks and blend weights must contain one map per output",
    );
  }
  const length = blackFrames[0]?.length || 0;
  if (length < 1 || [...blackFrames, ...masks, ...blendWeights].some((map) => map?.length !== length)) {
    throw new CameraCalibrationError("INVALID_SOLVER_MAP", "Combined black-correction maps must have equal non-zero lengths");
  }
  if (uncertaintyFrames != null && (!Array.isArray(uncertaintyFrames)
    || uncertaintyFrames.length !== blackFrames.length
    || uncertaintyFrames.some((map) => map != null && map.length !== length))) {
    throw new CameraCalibrationError("INVALID_SOLVER_MAP", "Black uncertainty maps must match black-frame dimensions");
  }
  const calibratedScales = responseScales == null
    ? blackFrames.map(() => 1)
    : responseScales.map(Number);
  if (calibratedScales.length !== blackFrames.length
    || calibratedScales.some((value) => !Number.isFinite(value) || value <= 1e-9)) {
    throw new CameraCalibrationError(
      "INVALID_SOLVER_MAP",
      "Black-correction response scales must contain one positive calibrated white response per output",
    );
  }
  if (requireUncertainty && (!uncertaintyFrames || uncertaintyFrames.some((map) => !(map instanceof Float32Array)))) {
    throw new CameraCalibrationError(
      "CALIBRATION_BLACK_UNCERTAINTY_MISSING",
      "Strict black correction requires an uncertainty raster for every projector",
    );
  }
  const baseline = new Float32Array(length);
  const uncertainty = uncertaintyFrames ? new Float32Array(length) : null;
  const unionMask = new Float32Array(length);
  for (let pixel = 0; pixel < length; pixel += 1) {
    let total = 0;
    let conservativeUncertainty = 0;
    for (let output = 0; output < blackFrames.length; output += 1) {
      total += clamp(blackFrames[output][pixel]);
      // The schema uses one global projector-black exposure. Each output solve
      // references the same physical samples, so their errors are correlated;
      // averaging N copies must not claim a sqrt(N) uncertainty reduction.
      conservativeUncertainty = Math.max(
        conservativeUncertainty,
        Number(uncertaintyFrames?.[output]?.[pixel]) || 0,
      );
      if (Number(masks[output][pixel]) > 0) unionMask[pixel] = 1;
    }
    baseline[pixel] = total / blackFrames.length;
    if (uncertainty) uncertainty[pixel] = conservativeUncertainty;
  }
  const visibleBaseline = [];
  for (let pixel = 0; pixel < length; pixel += 1) {
    if (unionMask[pixel] > 0) visibleBaseline.push(baseline[pixel]);
  }
  if (visibleBaseline.length < 1) {
    throw new CameraCalibrationError("CALIBRATION_SURFACE_NOT_FOUND", "No illuminated union surface exists for black correction");
  }
  const target = buildBlackUniformityMap(Float32Array.from(visibleBaseline), {
    targetPercentile,
    maxLift,
  }).target;
  const limit = clamp(maxLift, 0, 1);
  let uncertainPixels = 0;
  let candidatePixels = 0;
  const sigma = Math.max(0, Math.min(10, Number(uncertaintySigma) || 2));
  const totalCorrection = Float32Array.from(baseline, (value, pixel) => {
    if (unionMask[pixel] <= 0) return 0;
    const candidate = Math.min(limit, Math.max(0, target - value));
    if (candidate <= 0) return 0;
    candidatePixels += 1;
    if (uncertainty && candidate <= sigma * uncertainty[pixel]) {
      uncertainPixels += 1;
      return 0;
    }
    return candidate;
  });
  if (requireUncertainty && candidatePixels > 0 && uncertainPixels / candidatePixels > 0.5) {
    throw new CameraCalibrationError(
      "CALIBRATION_BLACK_UNCERTAINTY_TOO_HIGH",
      "Most proposed black-level corrections are not distinguishable from capture uncertainty",
      { candidatePixels, uncertainPixels, uncertainFraction: uncertainPixels / candidatePixels, uncertaintySigma: sigma },
    );
  }
  const contributions = blendWeights.map(() => new Float32Array(length));
  for (let pixel = 0; pixel < length; pixel += 1) {
    const weightTotal = blendWeights.reduce((sum, map) => sum + Math.max(0, Number(map[pixel]) || 0), 0);
    if (weightTotal <= 1e-12) continue;
    for (let output = 0; output < blendWeights.length; output += 1) {
      contributions[output][pixel] = totalCorrection[pixel]
        * Math.max(0, Number(blendWeights[output][pixel]) || 0) / weightTotal
        / calibratedScales[output];
    }
  }
  return {
    baseline,
    uncertainty,
    target,
    totalCorrection,
    contributions,
    uncertaintyMetrics: {
      status: uncertainty ? "measured" : "unavailable",
      candidatePixels,
      uncertainPixels,
      uncertainFraction: candidatePixels > 0 ? uncertainPixels / candidatePixels : 0,
      uncertaintySigma: sigma,
    },
  };
}

function visibleBounds(mask, width, height) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Number(mask[y * width + x]) <= 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      count += 1;
    }
  }
  if (count < 4 || right <= left || bottom <= top) {
    throw new CameraCalibrationError(
      "CALIBRATION_SURFACE_NOT_FOUND",
      "Gray-code capture did not contain a usable illuminated projector surface",
      { visiblePixels: count },
    );
  }
  const xDivisor = Math.max(1, width - 1);
  const yDivisor = Math.max(1, height - 1);
  return [
    { x: left / xDivisor, y: top / yDivisor },
    { x: right / xDivisor, y: top / yDivisor },
    { x: right / xDivisor, y: bottom / yDivisor },
    { x: left / xDivisor, y: bottom / yDivisor },
  ];
}

function safeArtifactStem(value) {
  const text = String(value || "output");
  const readable = text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "output";
  return `${readable}-${createHash("sha256").update(text).digest("hex").slice(0, 10)}`;
}

function binaryBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array || value instanceof Float32Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(String(value), "utf8");
}

async function writeStagedArtifact(directory, filename, value) {
  const bytes = binaryBytes(value);
  await writeFile(join(directory, filename), bytes, { mode: 0o600 });
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function finalArtifactReference(directory, record, fields) {
  const pathname = join(directory, record.filename);
  return {
    uri: pathToFileURL(pathname).href,
    path: pathname,
    sha256: record.sha256,
    byteLength: record.byteLength,
    ...fields,
  };
}

function percentile(values, fraction) {
  const sorted = Array.from(values, Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const position = clamp(fraction) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function trimmedMean(values, fraction = 0.1) {
  const sorted = Array.from(values, Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const trim = Math.min(Math.floor(sorted.length * clamp(fraction, 0, 0.4)), Math.floor((sorted.length - 1) / 2));
  let total = 0;
  for (let index = trim; index < sorted.length - trim; index += 1) total += sorted[index];
  return total / (sorted.length - trim * 2);
}

function passForStep(plan, step) {
  return Array.isArray(plan?.passes) ? plan.passes.find((pass) => pass.id === step?.passId) : null;
}

function exposureProfileForStep(plan, step) {
  const profileId = step?.exposureProfileId || passForStep(plan, step)?.exposureProfileId || null;
  return Array.isArray(plan?.exposureProfiles)
    ? plan.exposureProfiles.find((profile) => profile.id === profileId) || null
    : null;
}

function exposureProfileIdForStep(plan, step) {
  return step?.exposureProfileId || passForStep(plan, step)?.exposureProfileId || null;
}

function referenceKindForStep(plan, step) {
  const explicit = step?.referenceKind || passForStep(plan, step)?.referenceKind;
  if (explicit) return String(explicit).replaceAll("_", "-").toLowerCase();
  const purpose = String(step?.purpose || "").replaceAll("_", "-").toLowerCase();
  if (["sensor-dark", "dark-frame"].includes(purpose)) return "sensor-dark";
  if (["projectors-off-ambient", "ambient", "ambient-reference"].includes(purpose)) return "projectors-off-ambient";
  if (["projector-black", "black"].includes(purpose)) return "projector-black";
  return null;
}

function radiometryIsStrict(plan) {
  return Number(plan?.schemaVersion) >= 2 || plan?.radiometry?.strict === true
    || (Array.isArray(plan?.passes) && plan.passes.some((pass) => pass?.kind === "radiometry"));
}

function exposureNormalizationScale(plan, step, capture = null) {
  const profile = exposureProfileForStep(plan, step);
  const candidates = [
    capture?.exposure?.normalizationScale,
    capture?.exposureNormalizationScale,
    capture?.exposureSettings?.normalizationScale,
    step?.exposure?.normalizationScale,
    step?.exposureSettings?.normalizationScale,
    profile?.normalizationScale,
    profile?.settings?.normalizationScale,
  ].filter((value) => value != null).map(Number);
  if (candidates.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new CameraCalibrationError(
      "INVALID_EXPOSURE_NORMALIZATION",
      `Capture ${capture?.id || step?.id || "unknown"} has an invalid linear exposure normalization scale`,
    );
  }
  if (candidates.some((value) => Math.abs(value / candidates[0] - 1) > 1e-6)) {
    throw new CameraCalibrationError(
      "EXPOSURE_PROVENANCE_MISMATCH",
      `Capture ${capture?.id || step?.id || "unknown"} disagrees with its planned exposure normalization`,
      { candidates },
    );
  }
  if (candidates.length) return candidates[0];
  if (Array.isArray(plan?.exposureProfiles) && plan.exposureProfiles.length) {
    throw new CameraCalibrationError(
      "MISSING_EXPOSURE_NORMALIZATION",
      `Exposure profile ${exposureProfileIdForStep(plan, step) || "unknown"} omitted normalizationScale`,
    );
  }
  return 1;
}

function referenceStepFor({ plan, outputId, targetStep, kind, required = false }) {
  const normalizedKind = String(kind).replaceAll("_", "-").toLowerCase();
  let candidates = plan.steps.filter((step) => step.capture && referenceKindForStep(plan, step) === normalizedKind);
  if (normalizedKind === "projector-black") {
    candidates = candidates.filter((step) => step.outputId === outputId || step.outputId == null);
  }
  const profileId = exposureProfileIdForStep(plan, targetStep);
  if (profileId) {
    const matching = candidates.filter((step) => exposureProfileIdForStep(plan, step) === profileId);
    if (matching.length) candidates = matching;
    // A projector/room reference may use another exposure profile after each
    // frame has its own matching sensor-dark subtraction and explicit linear
    // exposure normalization. Sensor-dark itself never uses this fallback.
    else if (normalizedKind === "sensor-dark") candidates = [];
  }
  const step = candidates[0] || null;
  if (!step && required) {
    throw new CameraCalibrationError(
      "MISSING_RADIOMETRIC_REFERENCE",
      `Measured radiometry requires a ${normalizedKind} reference for ${outputId}`,
      { outputId, exposureProfileId: profileId, referenceKind: normalizedKind },
    );
  }
  return step;
}

function matchingSensorDark({ plan, targetStep, outputId, required }) {
  return referenceStepFor({ plan, outputId, targetStep, kind: "sensor-dark", required });
}

function combineUncertainty(first, second, scale = 1) {
  if (!(first instanceof Float32Array) && !(second instanceof Float32Array)) return null;
  const length = first?.length || second?.length;
  if ((first && first.length !== length) || (second && second.length !== length)) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Uncertainty rasters have incompatible dimensions");
  }
  const output = new Float32Array(length);
  const divisor = Math.max(1e-12, Number(scale));
  for (let index = 0; index < length; index += 1) {
    output[index] = Math.hypot(Number(first?.[index]) || 0, Number(second?.[index]) || 0) / divisor;
  }
  return output;
}

function calibratedExposureNormalizationScale(plan, step, capture, measuredExposureNormalization = null) {
  const nominalScale = exposureNormalizationScale(plan, step, capture);
  if (!measuredExposureNormalization?.scaleByProfileId) return nominalScale;
  const profileId = exposureProfileIdForStep(plan, step);
  const measuredScale = measuredExposureNormalization.scaleByProfileId.get(profileId);
  if (!Number.isFinite(measuredScale) || measuredScale <= 0) {
    throw new CameraCalibrationError(
      "MISSING_MEASURED_EXPOSURE_NORMALIZATION",
      `No measured exposure normalization is available for profile ${profileId || "unknown"}`,
      { profileId, stepId: step?.id || null },
    );
  }
  return measuredScale;
}

function exposureScaleRelativeUncertainty(plan, step, measuredExposureNormalization = null) {
  const evidence = measuredExposureNormalization?.evidence;
  if (!evidence || exposureProfileIdForStep(plan, step) !== evidence.longProfileId) return 0;
  const uncertainty = Number(evidence.uncertaintyLuma);
  return Number.isFinite(uncertainty) && uncertainty >= 0 ? uncertainty : 0;
}

function includeExposureScaleUncertainty(baseUncertainty, values, relativeUncertainty) {
  const scaleUncertainty = Math.max(0, Number(relativeUncertainty) || 0);
  if (!(baseUncertainty instanceof Float32Array) && scaleUncertainty <= 0) return null;
  const output = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = Math.hypot(
      Number(baseUncertainty?.[index]) || 0,
      Math.abs(Number(values[index]) || 0) * scaleUncertainty,
    );
  }
  return output;
}

function normalizedLumaFrame({
  plan,
  step,
  capture,
  darkStep = null,
  darkCapture = null,
  measuredExposureNormalization = null,
}) {
  const data = captureLuma(capture);
  const dark = darkCapture ? captureLuma(darkCapture) : null;
  if (dark && dark.length !== data.length) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Sensor-dark and measured luma rasters differ in size");
  }
  if (darkStep && exposureProfileIdForStep(plan, step) !== exposureProfileIdForStep(plan, darkStep)) {
    throw new CameraCalibrationError("MISSING_MATCHED_RADIOMETRIC_REFERENCE", "Sensor-dark profile does not match measured luma profile");
  }
  const scale = calibratedExposureNormalizationScale(plan, step, capture, measuredExposureNormalization);
  const output = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) output[index] = (data[index] - (dark?.[index] || 0)) / scale;
  const uncertainty = includeExposureScaleUncertainty(
    combineUncertainty(capture.uncertainty, darkCapture?.uncertainty, scale),
    output,
    exposureScaleRelativeUncertainty(plan, step, measuredExposureNormalization),
  );
  return {
    width: capture.width,
    height: capture.height,
    data: output,
    uncertainty,
    normalizationScale: scale,
  };
}

function normalizedRgbFrame({
  plan,
  step,
  capture,
  darkStep = null,
  darkCapture = null,
  measuredExposureNormalization = null,
}) {
  const rgb = captureRgb(capture);
  const dark = darkCapture ? captureRgb(darkCapture) : null;
  if (dark && (dark.width !== rgb.width || dark.height !== rgb.height || dark.data.length !== rgb.data.length)) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Sensor-dark and measured RGB rasters differ in size");
  }
  if (darkStep && exposureProfileIdForStep(plan, step) !== exposureProfileIdForStep(plan, darkStep)) {
    throw new CameraCalibrationError("MISSING_MATCHED_RADIOMETRIC_REFERENCE", "Sensor-dark profile does not match measured RGB profile");
  }
  const scale = calibratedExposureNormalizationScale(plan, step, capture, measuredExposureNormalization);
  const data = new Float32Array(rgb.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = (rgb.data[index] - (dark?.data[index] || 0)) / scale;
  const uncertainty = includeExposureScaleUncertainty(
    combineUncertainty(rgb.uncertainty, dark?.uncertainty, scale),
    data,
    exposureScaleRelativeUncertainty(plan, step, measuredExposureNormalization),
  );
  return {
    width: rgb.width,
    height: rgb.height,
    data,
    uncertainty,
    normalizationScale: scale,
  };
}

function bridgeCaptureIds(capture) {
  return Array.isArray(capture?.sourceCaptureIds) && capture.sourceCaptureIds.length
    ? capture.sourceCaptureIds.map(String)
    : [String(capture?.id)];
}

function medianAbsoluteDeviation(values, center) {
  return percentile(values.map((value) => Math.abs(value - center)), 0.5);
}

/**
 * Measure the actual long/short RAW exposure ratio from paired neutral-solid
 * captures.  The nominal plan scale is a gate, never the value used to merge
 * passes: both bridge frames are sensor-dark-subtracted first, then a bounded
 * spatial sample is ratioed robustly per channel and in camera luma.
 */
export function measureExposureNormalization({ plan, output, captures }) {
  const strict = radiometryIsStrict(plan);
  const policy = plan?.exposureBridgePolicy;
  const bridgeSteps = plan.steps.filter((step) => (
    step.capture
    && step.outputId === output.id
    && (step.semantic === "exposure-bridge" || String(step.purpose || "").startsWith("exposure-bridge-"))
  ));
  if (!policy || bridgeSteps.length !== 2) {
    if (!strict && !policy) return null;
    throw new CameraCalibrationError(
      "MISSING_EXPOSURE_BRIDGE",
      `Projector ${output.id} requires one paired short/long exposure bridge`,
      { outputId: output.id, bridgeStepIds: bridgeSteps.map((step) => step.id) },
    );
  }
  const shortStep = bridgeSteps.find((step) => step.bridgeRole === "short");
  const longStep = bridgeSteps.find((step) => step.bridgeRole === "long");
  if (!shortStep || !longStep || shortStep.bridgeId !== longStep.bridgeId
    || shortStep.pairedExposureProfileId !== longStep.exposureProfileId
    || longStep.pairedExposureProfileId !== shortStep.exposureProfileId
    || shortStep.inputRgb?.some((value, index) => Math.abs(value - longStep.inputRgb?.[index]) > 1e-12)) {
    throw new CameraCalibrationError(
      "INVALID_EXPOSURE_BRIDGE",
      `Projector ${output.id} exposure bridge is not an exact paired neutral capture`,
      { shortStepId: shortStep?.id || null, longStepId: longStep?.id || null },
    );
  }

  const shortCapture = robustCaptureForStep(captures, shortStep, { requireRgb: true });
  const longCapture = robustCaptureForStep(captures, longStep, { requireRgb: true });
  const shortDarkStep = matchingSensorDark({
    plan, targetStep: shortStep, outputId: output.id, required: true,
  });
  const longDarkStep = matchingSensorDark({
    plan, targetStep: longStep, outputId: output.id, required: true,
  });
  const shortDarkCapture = robustCaptureForStep(captures, shortDarkStep, { requireRgb: true });
  const longDarkCapture = robustCaptureForStep(captures, longDarkStep, { requireRgb: true });
  const short = captureRgb(shortCapture);
  const long = captureRgb(longCapture);
  const shortDark = captureRgb(shortDarkCapture);
  const longDark = captureRgb(longDarkCapture);
  const frames = [long, shortDark, longDark];
  if (frames.some((frame) => frame.width !== short.width || frame.height !== short.height
    || frame.data.length !== short.data.length)) {
    throw new CameraCalibrationError(
      "CAMERA_FRAME_SIZE_CHANGED",
      `Projector ${output.id} exposure bridge and sensor-dark rasters differ in size`,
    );
  }
  if (strict && [short, long, shortDark, longDark].some((frame) => !(frame.uncertainty instanceof Float32Array))) {
    throw new CameraCalibrationError(
      "CALIBRATION_EXPOSURE_BRIDGE_UNCERTAINTY_MISSING",
      `Projector ${output.id} exposure bridge requires repeated short, long and sensor-dark captures`,
    );
  }

  const ratioSamples = [[], [], []];
  const ratioUncertaintySamples = [[], [], []];
  const snrSamples = [[], [], []];
  const lumaRatios = [];
  const lumaUncertaintySamples = [];
  const lumaSnrSamples = [];
  const pixels = short.width * short.height;
  const stride = Math.max(1, Math.floor(pixels / 8_192));
  let sampledPixels = 0;
  let clippedPixels = 0;
  const lumaWeights = [0.2126, 0.7152, 0.0722];
  const signalFloor = 1e-8;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    sampledPixels += 1;
    const shortSignals = [0, 0, 0];
    const longSignals = [0, 0, 0];
    const shortNoises = [0, 0, 0];
    const longNoises = [0, 0, 0];
    let clipped = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = pixel * 3 + channel;
      const rawShort = Number(short.data[index]);
      const rawLong = Number(long.data[index]);
      if (rawShort <= 1e-7 || rawLong <= 1e-7 || rawShort >= 0.995 || rawLong >= 0.995) clipped = true;
      shortSignals[channel] = rawShort - Number(shortDark.data[index]);
      longSignals[channel] = rawLong - Number(longDark.data[index]);
      shortNoises[channel] = Math.hypot(
        Number(short.uncertainty?.[index]) || 0,
        Number(shortDark.uncertainty?.[index]) || 0,
      );
      longNoises[channel] = Math.hypot(
        Number(long.uncertainty?.[index]) || 0,
        Number(longDark.uncertainty?.[index]) || 0,
      );
      const shortSignal = shortSignals[channel];
      const longSignal = longSignals[channel];
      const shortNoise = shortNoises[channel];
      const longNoise = longNoises[channel];
      const shortSnr = 20 * Math.log10(Math.max(signalFloor, shortSignal) / Math.max(signalFloor, shortNoise));
      const longSnr = 20 * Math.log10(Math.max(signalFloor, longSignal) / Math.max(signalFloor, longNoise));
      if (shortSignal > Math.max(signalFloor, shortNoise * 6)
        && longSignal > Math.max(signalFloor, longNoise * 6)) {
        const ratio = longSignal / shortSignal;
        if (Number.isFinite(ratio) && ratio > 0) {
          ratioSamples[channel].push(ratio);
          ratioUncertaintySamples[channel].push(Math.hypot(
            shortNoise / shortSignal,
            longNoise / longSignal,
          ));
          snrSamples[channel].push(Math.min(shortSnr, longSnr));
        }
      }
    }
    if (clipped) clippedPixels += 1;
    const shortLuma = lumaWeights.reduce((sum, weight, channel) => sum + weight * shortSignals[channel], 0);
    const longLuma = lumaWeights.reduce((sum, weight, channel) => sum + weight * longSignals[channel], 0);
    const shortLumaNoise = Math.hypot(...lumaWeights.map((weight, channel) => weight * shortNoises[channel]));
    const longLumaNoise = Math.hypot(...lumaWeights.map((weight, channel) => weight * longNoises[channel]));
    if (shortLuma > Math.max(signalFloor, shortLumaNoise * 6)
      && longLuma > Math.max(signalFloor, longLumaNoise * 6)) {
      const ratio = longLuma / shortLuma;
      if (Number.isFinite(ratio) && ratio > 0) {
        lumaRatios.push(ratio);
        lumaUncertaintySamples.push(Math.hypot(
          shortLumaNoise / shortLuma,
          longLumaNoise / longLuma,
        ));
        lumaSnrSamples.push(Math.min(
          20 * Math.log10(shortLuma / Math.max(signalFloor, shortLumaNoise)),
          20 * Math.log10(longLuma / Math.max(signalFloor, longLumaNoise)),
        ));
      }
    }
  }

  const minimumSamples = Math.max(8, Math.min(64, Math.ceil(sampledPixels * 0.01)));
  if (ratioSamples.some((values) => values.length < minimumSamples) || lumaRatios.length < minimumSamples) {
    throw new CameraCalibrationError(
      "CALIBRATION_EXPOSURE_BRIDGE_SNR_TOO_LOW",
      `Projector ${output.id} exposure bridge has too few high-SNR paired pixels`,
      {
        minimumSamples,
        usableRgb: ratioSamples.map((values) => values.length),
        usableLuma: lumaRatios.length,
      },
    );
  }
  const measuredScaleRgb = ratioSamples.map((values) => percentile(values, 0.5));
  const measuredScaleLuma = percentile(lumaRatios, 0.5);
  const relativeUncertainty = (values, propagated, center) => clamp(Math.hypot(
    1.4826 * medianAbsoluteDeviation(values, center) / Math.max(signalFloor, center),
    percentile(propagated, 0.5),
  ));
  const uncertaintyRgb = ratioSamples.map((values, channel) => (
    relativeUncertainty(values, ratioUncertaintySamples[channel], measuredScaleRgb[channel])
  ));
  const uncertaintyLuma = relativeUncertainty(lumaRatios, lumaUncertaintySamples, measuredScaleLuma);
  const nominalScale = Number(policy.nominalScale);
  const relativeErrorRgb = measuredScaleRgb.map((scale) => Math.abs(scale / nominalScale - 1));
  const relativeErrorLuma = Math.abs(measuredScaleLuma / nominalScale - 1);
  const snrDb = Math.min(
    ...snrSamples.map((values) => percentile(values, 0.1)),
    percentile(lumaSnrSamples, 0.1),
  );
  const clippedFraction = clippedPixels / Math.max(1, sampledPixels);
  const gates = {
    passed: false,
    maximumRelativeError: Number(policy.maximumRelativeError),
    maximumUncertainty: Number(policy.maximumUncertainty),
    minimumSnrDb: Number(policy.minimumSnrDb),
    maximumClippedFraction: Number(policy.maximumClippedFraction),
  };
  gates.passed = Math.max(...relativeErrorRgb, relativeErrorLuma) <= gates.maximumRelativeError
    && Math.max(...uncertaintyRgb, uncertaintyLuma) <= gates.maximumUncertainty
    && snrDb >= gates.minimumSnrDb
    && clippedFraction <= gates.maximumClippedFraction;
  const evidence = {
    bridgeId: shortStep.bridgeId,
    shortStepId: shortStep.id,
    longStepId: longStep.id,
    shortProfileId: shortStep.exposureProfileId,
    longProfileId: longStep.exposureProfileId,
    inputRgb: [...shortStep.inputRgb],
    shortCaptureIds: bridgeCaptureIds(shortCapture),
    longCaptureIds: bridgeCaptureIds(longCapture),
    nominalScale,
    measuredScaleRgb,
    measuredScaleLuma,
    relativeErrorRgb,
    relativeErrorLuma,
    uncertaintyRgb,
    uncertaintyLuma,
    snrDb,
    clippedFraction,
    status: gates.passed ? "passed" : "failed",
    gates,
  };
  if (!gates.passed) {
    const code = clippedFraction > gates.maximumClippedFraction
      ? "CALIBRATION_EXPOSURE_BRIDGE_CLIPPED"
      : snrDb < gates.minimumSnrDb
        ? "CALIBRATION_EXPOSURE_BRIDGE_SNR_TOO_LOW"
        : Math.max(...uncertaintyRgb, uncertaintyLuma) > gates.maximumUncertainty
          ? "CALIBRATION_EXPOSURE_BRIDGE_UNCERTAINTY_TOO_HIGH"
          : "CALIBRATION_EXPOSURE_NORMALIZATION_MISMATCH";
    throw new CameraCalibrationError(
      code,
      `Projector ${output.id} measured exposure bridge failed its physical consistency gates`,
      { measuredExposureNormalization: evidence },
    );
  }
  return {
    evidence,
    scaleByProfileId: new Map([
      [shortStep.exposureProfileId, 1],
      [longStep.exposureProfileId, measuredScaleLuma],
    ]),
  };
}

function subtractRgbFrames(measured, baseline) {
  if (measured.width !== baseline.width || measured.height !== baseline.height || measured.data.length !== baseline.data.length) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Radiometric measurement and black reference dimensions differ");
  }
  const data = new Float32Array(measured.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = measured.data[index] - baseline.data[index];
  return {
    width: measured.width,
    height: measured.height,
    data,
    uncertainty: combineUncertainty(measured.uncertainty, baseline.uncertainty, 1),
  };
}

function subtractLumaFrames(measured, baseline) {
  if (measured.width !== baseline.width || measured.height !== baseline.height || measured.data.length !== baseline.data.length) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Luma measurement and reference dimensions differ");
  }
  const data = new Float32Array(measured.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = measured.data[index] - baseline.data[index];
  return {
    width: measured.width,
    height: measured.height,
    data,
    uncertainty: combineUncertainty(measured.uncertainty, baseline.uncertainty, 1),
  };
}

function surfaceMaskValue(mask, maskWidth, maskHeight, x, y, width, height) {
  const sourceX = Math.min(maskWidth - 1, Math.max(0, Math.round((x + 0.5) / width * maskWidth - 0.5)));
  const sourceY = Math.min(maskHeight - 1, Math.max(0, Math.round((y + 0.5) / height * maskHeight - 0.5)));
  return Number(mask[sourceY * maskWidth + sourceX]) || 0;
}

function summarizeRgbFrame({ frame, rawCapture, surfaceMask, maskWidth, maskHeight }) {
  const raw = captureRgb(rawCapture);
  if (raw.width !== frame.width || raw.height !== frame.height) {
    throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Raw and corrected radiometric rasters differ in size");
  }
  const pixels = frame.width * frame.height;
  const stride = Math.max(1, Math.floor(pixels / 8_192));
  const samples = [[], [], []];
  const noises = [[], [], []];
  let maskPixels = 0;
  let validPixels = 0;
  let clippedPixels = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const x = pixel % frame.width;
    const y = Math.floor(pixel / frame.width);
    if (surfaceMaskValue(surfaceMask, maskWidth, maskHeight, x, y, frame.width, frame.height) <= 0) continue;
    maskPixels += 1;
    let valid = true;
    let clipped = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = pixel * 3 + channel;
      if (!Number.isFinite(frame.data[index])) valid = false;
      if (raw.data[index] >= 0.995) clipped = true;
    }
    if (!valid) continue;
    validPixels += 1;
    if (clipped) clippedPixels += 1;
    if (pixel % stride !== 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const index = pixel * 3 + channel;
      samples[channel].push(frame.data[index]);
      if (frame.uncertainty) noises[channel].push(Math.max(0, frame.uncertainty[index]));
    }
  }
  if (!maskPixels || !validPixels || samples.some((values) => !values.length)) {
    throw new CameraCalibrationError("CALIBRATION_SURFACE_NOT_FOUND", "Radiometric capture has no usable pixels on the decoded surface");
  }
  const rgb = samples.map((values) => trimmedMean(values));
  const uncertainty = noises.map((values) => values.length ? percentile(values, 0.5) : null);
  const snrDb = rgb.map((value, channel) => {
    const noise = uncertainty[channel];
    return noise == null ? null : 20 * Math.log10(Math.max(1e-12, Math.abs(value)) / Math.max(1e-12, noise));
  });
  return {
    rgb,
    uncertainty,
    snrDb,
    coverage: validPixels / maskPixels,
    clippedFraction: clippedPixels / validPixels,
    sampledPixels: samples[0].length,
  };
}

function isotonicResponse(points) {
  const sorted = points.slice().sort((first, second) => first.x - second.x);
  const blocks = [];
  for (const point of sorted) {
    blocks.push({ start: blocks.length, end: blocks.length, weight: point.weight || 1, value: point.y * (point.weight || 1) });
    while (blocks.length >= 2) {
      const right = blocks.at(-1);
      const left = blocks.at(-2);
      if (left.value / left.weight <= right.value / right.weight) break;
      blocks.splice(-2, 2, {
        start: left.start,
        end: right.end,
        weight: left.weight + right.weight,
        value: left.value + right.value,
      });
    }
  }
  const fitted = new Array(sorted.length);
  for (const block of blocks) {
    const value = block.value / block.weight;
    for (let index = block.start; index <= block.end; index += 1) fitted[index] = value;
  }
  return sorted.map((point, index) => ({ x: point.x, y: clamp(fitted[index]) }));
}

function fitResponseCurve(points, channel) {
  const valid = points.filter((point) => point.x > 0 && point.x <= 1 && point.y > 1e-7 && Number.isFinite(point.y));
  if (valid.length < 3) {
    throw new CameraCalibrationError(
      "CALIBRATION_RESPONSE_FIT_FAILED",
      `Channel ${channel} has fewer than three usable response samples`,
      { channel, usableSamples: valid.length },
    );
  }
  const gammaEstimates = valid.filter((point) => point.x < 0.999 && point.y < 0.999)
    .map((point) => Math.log(point.y) / Math.log(point.x))
    .filter((value) => Number.isFinite(value) && value >= 0.1 && value <= 8);
  if (gammaEstimates.length < 2) {
    throw new CameraCalibrationError("CALIBRATION_RESPONSE_FIT_FAILED", `Channel ${channel} gamma is not identifiable`);
  }
  const gamma = percentile(gammaEstimates, 0.5);
  const rmse = Math.sqrt(valid.reduce((sum, point) => sum + (point.y - Math.pow(point.x, gamma)) ** 2, 0) / valid.length);
  const maximumError = valid.reduce((maximum, point) => Math.max(maximum, Math.abs(point.y - Math.pow(point.x, gamma))), 0);
  const monotonic = isotonicResponse([{ x: 0, y: 0, weight: 1000 }, ...valid, { x: 1, y: 1, weight: 1000 }]);
  return {
    channel,
    gamma,
    rmse,
    maximumError,
    method: rmse <= 0.005 ? "robust-power-law" : "isotonic-piecewise",
    points: monotonic,
  };
}

function invertResponse(curve, target) {
  const value = clamp(target);
  if (curve.method === "robust-power-law") return Math.pow(value, 1 / curve.gamma);
  const points = curve.points;
  for (let index = 1; index < points.length; index += 1) {
    if (value > points[index].y) continue;
    const lower = points[index - 1];
    const upper = points[index];
    const span = upper.y - lower.y;
    return span <= 1e-9 ? upper.x : lower.x + (upper.x - lower.x) * (value - lower.y) / span;
  }
  return 1;
}

function determinant3(matrix) {
  return matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
    - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
    + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
}

function inverse3(matrix) {
  const determinant = determinant3(matrix);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-5) {
    throw new CameraCalibrationError(
      "CALIBRATION_COLOR_MATRIX_SINGULAR",
      "Measured RGB primaries do not form an invertible color response matrix",
      { determinant },
    );
  }
  return {
    determinant,
    matrix: [
      [
        (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) / determinant,
        (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) / determinant,
        (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) / determinant,
      ],
      [
        (matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) / determinant,
        (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) / determinant,
        (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) / determinant,
      ],
      [
        (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) / determinant,
        (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) / determinant,
        (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) / determinant,
      ],
    ],
  };
}

function matrixInfinityNorm(matrix) {
  return Math.max(...matrix.map((row) => row.reduce((sum, value) => sum + Math.abs(value), 0)));
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function buildMeasuredLut({ curves, colorMatrix, size = 17 }) {
  const inverse = inverse3(colorMatrix);
  const condition = matrixInfinityNorm(colorMatrix) * matrixInfinityNorm(inverse.matrix);
  if (!Number.isFinite(condition) || condition > 100) {
    throw new CameraCalibrationError(
      "CALIBRATION_COLOR_MATRIX_ILL_CONDITIONED",
      "Measured RGB response is too ill-conditioned for a safe color LUT",
      { determinant: inverse.determinant, condition },
    );
  }
  const values = new Float32Array(size * size * size * 4);
  let offset = 0;
  let inGamut = 0;
  let maximumIdentityDeviation = 0;
  for (let blue = 0; blue < size; blue += 1) {
    for (let green = 0; green < size; green += 1) {
      for (let red = 0; red < size; red += 1) {
        const shaderInput = [red, green, blue].map((coordinate) => coordinate / (size - 1));
        const targetLinear = shaderInput.map((value, channel) => Math.pow(value, curves[channel].gamma));
        const requiredLinear = multiplyMatrixVector(inverse.matrix, targetLinear);
        if (requiredLinear.every((value) => value >= -1e-6 && value <= 1 + 1e-6)) inGamut += 1;
        for (let channel = 0; channel < 3; channel += 1) {
          const corrected = clamp(invertResponse(curves[channel], requiredLinear[channel]));
          values[offset++] = corrected;
          maximumIdentityDeviation = Math.max(maximumIdentityDeviation, Math.abs(corrected - shaderInput[channel]));
        }
        values[offset++] = 1;
      }
    }
  }
  const gamutCoverage = inGamut / (size ** 3);
  if (gamutCoverage < 0.5) {
    throw new CameraCalibrationError(
      "CALIBRATION_COLOR_GAMUT_TOO_SMALL",
      "More than half of the measured RGB cube is outside the correctable projector gamut",
      { gamutCoverage },
    );
  }
  const fitRmse = Math.max(...curves.map((curve) => curve.rmse));
  const identityVerified = maximumIdentityDeviation <= 0.002
    && fitRmse <= 0.005
    && colorMatrix.every((row, rowIndex) => row.every((value, columnIndex) => (
      Math.abs(value - (rowIndex === columnIndex ? 1 : 0)) <= 0.002
    )));
  return {
    size,
    values,
    determinant: inverse.determinant,
    condition,
    gamutCoverage,
    maximumIdentityDeviation,
    identityVerified,
    method: "camera-relative-inverse-response-primary-matrix-v2",
  };
}

export function solveMeasuredRadiometry({
  plan,
  output,
  captures,
  surfaceMask,
  cameraWidth,
  cameraHeight,
  measuredExposureNormalization = null,
}) {
  const strict = radiometryIsStrict(plan);
  const exposureNormalization = measuredExposureNormalization
    || measureExposureNormalization({ plan, output, captures });
  const outputSteps = plan.steps.filter((step) => step.outputId === output.id);
  const responseSteps = outputSteps.filter((step) => step.purpose === "near-black" || step.purpose === "tone");
  const primarySteps = ["primary-red", "primary-green", "primary-blue"].map((purpose) => (
    requireCalibrationStep(outputSteps, (step) => step.purpose === purpose, `${output.id} ${purpose}`)
  ));
  const lowPrimarySteps = ["low-primary-red", "low-primary-green", "low-primary-blue"].map((purpose) => (
    outputSteps.find((step) => step.purpose === purpose) || null
  ));
  if (strict && lowPrimarySteps.some((step) => !step)) {
    throw new CameraCalibrationError(
      "MISSING_CALIBRATION_STEP",
      `Projector ${output.id} requires long-exposure low-primary RGB captures`,
    );
  }
  if (!responseSteps.some((step) => step.purpose === "near-black") || !responseSteps.some((step) => step.purpose === "tone")) {
    throw new CameraCalibrationError(
      "MISSING_CALIBRATION_STEP",
      `Projector ${output.id} requires both near-black and mid-tone response captures`,
    );
  }

  const captureCache = new Map();
  const captureFor = (step, requireRgb = true) => {
    if (!captureCache.has(step.id)) captureCache.set(step.id, robustCaptureForStep(captures, step, { requireRgb }));
    return captureCache.get(step.id);
  };
  const normalizedCache = new Map();
  const normalizedFor = (step) => {
    if (normalizedCache.has(step.id)) return normalizedCache.get(step.id);
    const darkStep = matchingSensorDark({ plan, targetStep: step, outputId: output.id, required: strict });
    const normalized = normalizedRgbFrame({
      plan,
      step,
      capture: captureFor(step),
      darkStep,
      darkCapture: darkStep ? captureFor(darkStep) : null,
      measuredExposureNormalization: exposureNormalization,
    });
    normalizedCache.set(step.id, normalized);
    return normalized;
  };
  const signalFor = (step) => {
    const blackStep = referenceStepFor({
      plan,
      outputId: output.id,
      targetStep: step,
      kind: "projector-black",
      required: true,
    });
    if (blackStep.id === step.id) {
      throw new CameraCalibrationError("MISSING_RADIOMETRIC_REFERENCE", "A signal capture cannot also be its projector-black reference");
    }
    return {
      frame: subtractRgbFrames(normalizedFor(step), normalizedFor(blackStep)),
      blackStep,
    };
  };
  const summarizeStep = (step) => {
    const signal = signalFor(step);
    return {
      step,
      blackStep: signal.blackStep,
      stats: summarizeRgbFrame({
        frame: signal.frame,
        rawCapture: captureFor(step),
        surfaceMask,
        maskWidth: cameraWidth,
        maskHeight: cameraHeight,
      }),
    };
  };

  const measured = [...responseSteps, ...primarySteps, ...lowPrimarySteps.filter(Boolean)].map(summarizeStep);
  const gates = {
    passed: true,
    minimumUsableSamples: 3,
    maximumRmse: 0.08,
    minimumSnrDb: 14,
    minimumCoverage: 0.8,
    maximumClippedFraction: 0.01,
  };
  const clipped = measured.filter((sample) => sample.stats.clippedFraction > gates.maximumClippedFraction);
  const lowCoverage = measured.filter((sample) => sample.stats.coverage < gates.minimumCoverage);
  if (clipped.length) {
    throw new CameraCalibrationError(
      "CALIBRATION_RADIOMETRY_CLIPPED",
      `Projector ${output.id} radiometric captures are clipped`,
      { steps: clipped.map((sample) => sample.step.id), maximumClippedFraction: gates.maximumClippedFraction },
    );
  }
  if (lowCoverage.length) {
    throw new CameraCalibrationError(
      "CALIBRATION_RADIOMETRY_COVERAGE_TOO_LOW",
      `Projector ${output.id} radiometric surface coverage is too low`,
      { steps: lowCoverage.map((sample) => sample.step.id), minimumCoverage: gates.minimumCoverage },
    );
  }
  if (strict && measured.some((sample) => sample.stats.snrDb.some((value) => value == null))) {
    throw new CameraCalibrationError(
      "CALIBRATION_RADIOMETRY_UNCERTAINTY_MISSING",
      `Projector ${output.id} strict radiometry requires at least three repeated frames per measured step and reference`,
    );
  }

  const primaries = primarySteps.map((step) => measured.find((sample) => sample.step.id === step.id));
  const whiteRgb = [0, 1, 2].map((sensorChannel) => (
    primaries.reduce((sum, sample) => sum + Math.max(0, sample.stats.rgb[sensorChannel]), 0)
  ));
  if (whiteRgb.some((value) => !Number.isFinite(value) || value <= 1e-4)) {
    throw new CameraCalibrationError("CALIBRATION_RADIOMETRY_LOW_SIGNAL", `Projector ${output.id} primary sum is not measurable`);
  }
  const usableResponse = measured.filter((sample) => responseSteps.some((step) => step.id === sample.step.id))
    .filter((sample) => {
      if (sample.step.purpose !== "near-black") return true;
      const known = sample.stats.snrDb.filter((value) => value != null);
      return known.length === 0 ? !strict : Math.min(...known) >= gates.minimumSnrDb;
    });
  if (!usableResponse.some((sample) => sample.step.purpose === "near-black")) {
    throw new CameraCalibrationError(
      "CALIBRATION_NEAR_BLACK_SNR_TOO_LOW",
      `Projector ${output.id} has no near-black level above the required SNR`,
      { minimumSnrDb: gates.minimumSnrDb },
    );
  }
  const lowPrimaries = lowPrimarySteps.map((step) => (
    step ? measured.find((sample) => sample.step.id === step.id) : null
  ));
  const responsePoints = [0, 1, 2].map((channel) => {
    const grayscale = usableResponse.map((sample) => ({
      x: Number(sample.step.inputRgb?.[channel] ?? sample.step.pattern?.rgb?.[channel]),
      y: sample.stats.rgb[channel] / whiteRgb[channel],
      weight: sample.stats.snrDb[channel] == null ? 1 : clamp((sample.stats.snrDb[channel] - 6) / 30, 0.1, 1),
    }));
    const lowPrimary = lowPrimaries[channel];
    if (lowPrimary) {
      const fullSignal = Math.max(1e-12, primaries[channel].stats.rgb[channel]);
      grayscale.push({
        x: Number(lowPrimary.step.inputRgb?.[channel] ?? lowPrimary.step.pattern?.rgb?.[channel]),
        y: lowPrimary.stats.rgb[channel] / fullSignal,
        weight: lowPrimary.stats.snrDb[channel] == null
          ? 1
          : clamp((lowPrimary.stats.snrDb[channel] - 6) / 30, 0.1, 1),
      });
    }
    return grayscale;
  });
  const curves = responsePoints.map((points, channel) => fitResponseCurve(points, channel));
  if (curves.some((curve) => curve.rmse > gates.maximumRmse)) {
    throw new CameraCalibrationError(
      "CALIBRATION_RESPONSE_FIT_FAILED",
      `Projector ${output.id} response fit exceeds the maximum error`,
      { channelRmse: curves.map((curve) => curve.rmse), maximumRmse: gates.maximumRmse },
    );
  }

  const colorMatrix = [0, 1, 2].map((sensorChannel) => {
    const row = primaries.map((sample) => Math.max(0, sample.stats.rgb[sensorChannel]));
    const sum = row.reduce((total, value) => total + value, 0);
    if (sum <= 1e-6) {
      throw new CameraCalibrationError("CALIBRATION_COLOR_MATRIX_SINGULAR", `Projector ${output.id} primary channel is not measurable`);
    }
    return row.map((value) => value / sum);
  });
  const lut = buildMeasuredLut({ curves, colorMatrix, size: 17 });
  const nearBlackSnrValues = usableResponse.filter((sample) => sample.step.purpose === "near-black")
    .flatMap((sample) => sample.stats.snrDb.filter((value) => value != null));
  const allSnrValues = [
    ...usableResponse.flatMap((sample) => sample.stats.snrDb.filter((value) => value != null)),
    ...primaries.flatMap((sample, channel) => sample.stats.snrDb[channel] == null ? [] : [sample.stats.snrDb[channel]]),
    ...lowPrimaries.flatMap((sample, channel) => sample?.stats.snrDb[channel] == null ? [] : [sample.stats.snrDb[channel]]),
  ];
  const confidence = clamp(
    (1 - Math.max(...curves.map((curve) => curve.rmse)) / gates.maximumRmse)
      * lut.gamutCoverage
      * Math.min(1, 10 / Math.max(1, lut.condition))
      * (allSnrValues.length ? clamp((Math.min(...allSnrValues) - 6) / 24) : 0.5),
  );
  const radiometryProfileId = plan.exposureProfiles?.find((profile) => profile.role === "radiometry")?.id || null;
  const referenceIds = (kind) => captureIdsForSteps(captures, (capture) => {
    const step = plan.steps.find((candidate) => candidate.id === capture.stepId);
    return step && referenceKindForStep(plan, step) === kind
      && (kind === "sensor-dark" || !radiometryProfileId
        || exposureProfileIdForStep(plan, step) === radiometryProfileId)
      && (step.outputId == null || step.outputId === output.id);
  });
  return {
    whiteResponseLuma: whiteRgb[0] * 0.2126 + whiteRgb[1] * 0.7152 + whiteRgb[2] * 0.0722,
    gamma: {
      rgb: curves.map((curve) => curve.gamma),
      confidence,
      method: "robust-per-channel-response-v2",
    },
    lut,
    radiometry: {
      method: "reference-subtracted-camera-relative-rgb-v2",
      colorBasis: "camera-relative-rgb",
      colorimetric: false,
      status: "passed",
      measuredExposureNormalization: exposureNormalization?.evidence || null,
      referenceCaptureIds: {
        sensorDark: referenceIds("sensor-dark"),
        projectorsOffAmbient: referenceIds("projectors-off-ambient"),
        projectorBlack: referenceIds("projector-black"),
      },
      samples: {
        total: measured.length * 3,
        usable: (usableResponse.length + primarySteps.length + lowPrimarySteps.filter(Boolean).length) * 3,
        rejectedClipped: clipped.length * 3,
        rejectedLowSnr: (responseSteps.length - usableResponse.length) * 3,
        rejectedNonMonotonic: 0,
      },
      fit: {
        rmse: Math.max(...curves.map((curve) => curve.rmse)),
        maxAbsoluteError: Math.max(...curves.map((curve) => curve.maximumError)),
        channelRmse: curves.map((curve) => curve.rmse),
        gammaRgb: curves.map((curve) => curve.gamma),
        snrDb: allSnrValues.length ? Math.min(...allSnrValues) : 0,
        nearBlackSnrDb: nearBlackSnrValues.length ? Math.min(...nearBlackSnrValues) : 0,
        coverage: Math.min(...measured.map((sample) => sample.stats.coverage)),
        clippedFraction: Math.max(...measured.map((sample) => sample.stats.clippedFraction)),
        matrixDeterminant: lut.determinant,
        matrixCondition: lut.condition,
        gamutCoverage: lut.gamutCoverage,
        identityVerified: lut.identityVerified,
      },
      gates,
      response: {
        method: curves.map((curve) => curve.method),
        points: curves.map((curve) => curve.points),
      },
      lut: {
        method: lut.method,
        artifactSha256: null,
      },
    },
  };
}

function estimateGamma(plan, steps, captures, black, white) {
  const whiteStep = steps.find((step) => step.purpose === "white");
  const blackStep = referenceStepFor({
    plan,
    outputId: whiteStep?.outputId,
    targetStep: whiteStep,
    kind: "projector-black",
    required: true,
  });
  const blackCapture = capturesForStep(captures, blackStep?.id)[0];
  const whiteCapture = capturesForStep(captures, whiteStep?.id)[0];
  const blackMean = mean(black) / exposureNormalizationScale(plan, blackStep, blackCapture);
  const scale = Math.max(
    1e-9,
    mean(white) / exposureNormalizationScale(plan, whiteStep, whiteCapture) - blackMean,
  );
  const estimates = [];
  for (const step of steps.filter((candidate) => candidate.purpose === "tone")) {
    const stepCaptures = capturesForStep(captures, step.id);
    const measured = (
      mean(averageFrames(stepCaptures)) / exposureNormalizationScale(plan, step, stepCaptures[0]) - blackMean
    ) / scale;
    const input = step.pattern.rgb[0];
    if (input > 0 && input < 1 && measured > 1e-9 && measured < 1) estimates.push(Math.log(measured) / Math.log(input));
  }
  const gamma = estimates.length ? estimates.reduce((total, value) => total + value, 0) / estimates.length : 1;
  return {
    rgb: [gamma, gamma, gamma],
    confidence: Math.min(1, estimates.length / Math.max(1, plan.toneLevels.length)),
    method: "tone-response-v1",
  };
}

function requireCalibrationStep(steps, predicate, label) {
  const step = steps.find(predicate);
  if (!step) throw new CameraCalibrationError("MISSING_CALIBRATION_STEP", `Calibration plan omitted ${label}`);
  return step;
}

export function cameraTargetMeshForOutput({ plan, output, cameraWidth, cameraHeight, fallbackCorners }) {
  if (!output.surfaceTarget) {
    return createCameraTargetMesh({
      columns: plan.mesh.columns,
      rows: plan.mesh.rows,
      corners: fallbackCorners,
    });
  }
  if (!plan.lensProfile) {
    throw new CameraCalibrationError(
      "CAMERA_LENS_PROFILE_REQUIRED",
      `Markerless surface target ${output.id} has no bound lens profile`,
    );
  }
  if (output.surfaceTarget.frame.width !== cameraWidth
    || output.surfaceTarget.frame.height !== cameraHeight
    || plan.lensProfile.frame.width !== cameraWidth
    || plan.lensProfile.frame.height !== cameraHeight
    || output.surfaceTarget.lensProfileSha256 !== plan.lensProfile.sha256) {
    throw new CameraCalibrationError(
      "CAMERA_LENS_PROFILE_MISMATCH",
      `Markerless surface target ${output.id}, captured raster and lens profile must match exactly`,
      {
        targetFrame: output.surfaceTarget.frame,
        captureFrame: { width: cameraWidth, height: cameraHeight },
        profileFrame: plan.lensProfile.frame,
      },
    );
  }
  try {
    const target = createDistortionAwarePlanarGrid({
      profile: plan.lensProfile,
      boundary: output.surfaceTarget.corners,
      columns: plan.mesh.columns + 1,
      rows: plan.mesh.rows + 1,
    });
    return {
      columns: plan.mesh.columns,
      rows: plan.mesh.rows,
      points: target.grid.vertices.map(({ u, v, x, y }) => ({
        u,
        v,
        cameraX: x,
        cameraY: y,
      })),
    };
  } catch (error) {
    throw new CameraCalibrationError(
      error?.code || "CALIBRATION_TARGET_GEOMETRY_INVALID",
      `Could not build a distortion-aware markerless target for ${output.id}: ${error?.message || error}`,
      error?.details ?? null,
    );
  }
}

function closeEnough(actual, expected, absoluteTolerance, relativeTolerance = 0) {
  const first = Number(actual);
  const second = Number(expected);
  return Number.isFinite(first) && Number.isFinite(second)
    && Math.abs(first - second) <= Math.max(absoluteTolerance, Math.abs(second) * relativeTolerance);
}

function assertLensProfileCaptureBinding({ plan, camera, captureProvenance, cameraWidth, cameraHeight }) {
  if (!plan.lensProfile) return;
  let profile;
  try {
    profile = normalizeCameraLensProfile(plan.lensProfile);
  } catch (error) {
    throw new CameraCalibrationError(
      error?.code || "CAMERA_LENS_PROFILE_INVALID",
      error?.message || "Camera lens profile is invalid",
      error?.details ?? null,
    );
  }
  const lens = captureProvenance?.lens;
  const cameraMatches = profile.camera.manufacturer === String(camera?.vendor || "")
    && profile.camera.model === String(camera?.model || "")
    && profile.camera.serialNumber === String(camera?.serial || "");
  const lensMatches = lens
    && profile.lens.manufacturer === String(lens.vendor || "")
    && profile.lens.model === String(lens.model || "")
    && profile.lens.serialNumber === String(lens.serial || "")
    && closeEnough(lens.focalLengthMm, profile.capture.focalLengthMm, 0.05)
    && closeEnough(lens.apertureF, profile.capture.apertureFNumber, 0.05)
    && closeEnough(lens.focusDistanceM, profile.capture.focusDistanceM, 0.02, 0.02)
    && lens.focusLocked === true
    && lens.zoomLocked === true
    && lens.stabilization === "off";
  const exposuresMatch = plan.exposureProfiles.every((exposureProfile) => (
    closeEnough(exposureProfile.settings.apertureF, profile.capture.apertureFNumber, 0.01)
  ));
  const frameMatches = profile.frame.width === cameraWidth && profile.frame.height === cameraHeight;
  if (!cameraMatches || !lensMatches || !exposuresMatch || !frameMatches) {
    throw new CameraCalibrationError(
      "CAMERA_LENS_PROFILE_CAPTURE_MISMATCH",
      "The markerless lens profile does not match the captured camera, lens, focal/focus/aperture lock or raster",
      {
        profileSha256: profile.sha256,
        cameraMatches,
        lensMatches: Boolean(lensMatches),
        exposuresMatch,
        frameMatches,
      },
    );
  }
}

function markerlessGeometryEvidence({ plan, output, warp, cameraWidth, cameraHeight, simulated = false }) {
  if (!output.surfaceTarget) return null;
  const maximumP95Px = Math.max(1.5, Math.min(12, Math.max(cameraWidth, cameraHeight) * 0.005));
  const maximumMaxPx = Math.max(2.5, Math.min(24, Math.max(cameraWidth, cameraHeight) * 0.01));
  const search = warp.searchDistancePx || {};
  const passed = warp.holes === 0
    && Number(warp.confidence) >= plan.mesh.minimumConfidence
    && Number(search.p95) <= maximumP95Px
    && Number(search.max) <= maximumMaxPx;
  const evidence = {
    status: simulated ? "simulated" : (passed ? "passed" : "failed"),
    method: output.surfaceTarget.method,
    surveyId: output.surfaceTarget.surveyId,
    wallId: output.surfaceTarget.wallId,
    cameraViewId: output.surfaceTarget.cameraViewId,
    lensProfileSha256: output.surfaceTarget.lensProfileSha256,
    frame: { width: cameraWidth, height: cameraHeight },
    targetPointCount: warp.points.length,
    correspondence: {
      confidence: warp.confidence,
      holes: warp.holes,
      searchDistancePx: {
        median: search.median,
        p95: search.p95,
        max: search.max,
      },
    },
    gates: {
      minimumConfidence: plan.mesh.minimumConfidence,
      maximumP95Px,
      maximumMaxPx,
      passed,
    },
  };
  if (!simulated && !passed) {
    throw new CameraCalibrationError(
      "CALIBRATION_MARKERLESS_GEOMETRY_GATES_FAILED",
      `Markerless target for ${output.id} is outside reliable decoded projector coverage`,
      { outputId: output.id, geometry: evidence },
    );
  }
  return evidence;
}

function solveMeasuredCameraSpace({ plan, output, captures, signal }) {
  throwIfCancelled(signal);
  const steps = plan.steps.filter((step) => step.outputId === output.id);
  const whiteStep = requireCalibrationStep(steps, (step) => step.purpose === "white", `${output.id} white`);
  const blackStep = referenceStepFor({
    plan,
    outputId: output.id,
    targetStep: whiteStep,
    kind: "projector-black",
    required: true,
  });
  const strict = radiometryIsStrict(plan);
  const measuredExposureNormalization = measureExposureNormalization({ plan, output, captures });
  const captureCache = new Map();
  const captureFor = (step) => {
    if (!captureCache.has(step.id)) captureCache.set(step.id, robustCaptureForStep(captures, step));
    return captureCache.get(step.id);
  };
  const normalizedCache = new Map();
  const normalizedLumaFor = (step) => {
    if (normalizedCache.has(step.id)) return normalizedCache.get(step.id);
    const darkStep = matchingSensorDark({ plan, targetStep: step, outputId: output.id, required: strict });
    const frame = normalizedLumaFrame({
      plan,
      step,
      capture: captureFor(step),
      darkStep,
      darkCapture: darkStep ? captureFor(darkStep) : null,
      measuredExposureNormalization,
    });
    normalizedCache.set(step.id, frame);
    return frame;
  };
  const blackReference = normalizedLumaFor(blackStep);
  const white = subtractLumaFrames(normalizedLumaFor(whiteStep), blackReference).data;
  const ambientStep = referenceStepFor({
    plan,
    outputId: output.id,
    targetStep: blackStep,
    kind: "projectors-off-ambient",
    required: strict,
  });
  const ambientReference = ambientStep ? normalizedLumaFor(ambientStep) : null;
  // A shader can add projector light but cannot remove room light.  Therefore
  // black uniformity must target the total observable black floor (ambient +
  // projector leakage) after sensor-dark subtraction.  The projectors-off
  // capture remains independent drift/reference evidence; subtracting it here
  // would hide spatial ambient variation that the additive correction can
  // legitimately raise the rest of the surface to match.
  const blackFloorFrame = blackReference;
  const black = Float32Array.from(blackFloorFrame.data, (value) => Math.max(0, value));
  const firstCapture = captureFor(blackStep);
  const cameraWidth = Number(firstCapture?.width);
  const cameraHeight = Number(firstCapture?.height);
  if (!Number.isSafeInteger(cameraWidth) || !Number.isSafeInteger(cameraHeight)
    || cameraWidth < 2 || cameraHeight < 2 || black.length !== cameraWidth * cameraHeight) {
    throw new CameraCalibrationError("INVALID_CAMERA_FRAME", "Measured solver requires a stable camera raster of at least 2 × 2 pixels");
  }
  const decoded = {};
  for (const axis of ["x", "y"]) {
    const bits = requiredGrayBits(axis === "x" ? output.width : output.height);
    const normalFrames = [];
    const inverseFrames = [];
    for (let bit = 0; bit < bits; bit += 1) {
      const normal = requireCalibrationStep(
        steps,
        (step) => step.purpose === "gray-code" && step.pattern.axis === axis
          && step.pattern.bit === bit && step.pattern.inverse === false,
        `${output.id} Gray ${axis} bit ${bit}`,
      );
      const inverse = requireCalibrationStep(
        steps,
        (step) => step.purpose === "gray-code" && step.pattern.axis === axis
          && step.pattern.bit === bit && step.pattern.inverse === true,
        `${output.id} inverse Gray ${axis} bit ${bit}`,
      );
      normalFrames.push(asGray8(normalizedLumaFor(normal).data));
      inverseFrames.push(asGray8(normalizedLumaFor(inverse).data));
    }
    decoded[axis] = decodeGrayCodeFrames({
      normalFrames,
      inverseFrames,
      width: cameraWidth,
      height: cameraHeight,
      threshold: 12,
    });
  }
  const pixelCount = cameraWidth * cameraHeight;
  const confidence = new Float32Array(pixelCount);
  let maximumWhiteDelta = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const valid = decoded.x.codes[index] >= 0 && decoded.x.codes[index] < output.width
      && decoded.y.codes[index] >= 0 && decoded.y.codes[index] < output.height;
    confidence[index] = valid ? Math.min(decoded.x.confidence[index], decoded.y.confidence[index]) : 0;
    if (valid) maximumWhiteDelta = Math.max(maximumWhiteDelta, Number(white[index]));
  }
  const surfaceThreshold = Math.max(0.01, Math.min(0.1, maximumWhiteDelta * 0.05));
  const surfaceMask = new Float32Array(pixelCount);
  let visiblePixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (confidence[index] >= plan.mesh.minimumConfidence && white[index] >= surfaceThreshold) {
      surfaceMask[index] = 1;
      visiblePixels += 1;
    }
  }
  if (visiblePixels < 4) {
    throw new CameraCalibrationError(
      "CALIBRATION_SURFACE_NOT_FOUND",
      `Projector ${output.id} did not produce enough decoded illuminated camera pixels`,
      { visiblePixels, surfaceThreshold },
    );
  }
  if (!ambientReference) {
    throw new CameraCalibrationError(
      "MISSING_RADIOMETRIC_REFERENCE",
      `Projector ${output.id} requires a projectors-off ambient diagnostic capture`,
    );
  }
  const projectorLeakage = subtractLumaFrames(blackReference, ambientReference);
  const visibleLeakage = [];
  const visibleLeakageUncertainty = [];
  let negativeBeyondUncertainty = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    if (surfaceMask[index] <= 0) continue;
    const value = Number(projectorLeakage.data[index]);
    const uncertainty = Math.max(0, Number(projectorLeakage.uncertainty?.[index]) || 0);
    visibleLeakage.push(value);
    visibleLeakageUncertainty.push(uncertainty);
    if (value < -2 * Math.max(1e-12, uncertainty)) negativeBeyondUncertainty += 1;
  }
  const ambientDiagnostic = {
    status: "passed",
    medianProjectorLeakage: percentile(visibleLeakage, 0.5),
    negativeBeyondUncertaintyFraction: negativeBeyondUncertainty / Math.max(1, visibleLeakage.length),
    uncertaintyP95: percentile(visibleLeakageUncertainty, 0.95),
    captureIds: [
      ...bridgeCaptureIds(captureFor(ambientStep)),
      ...bridgeCaptureIds(captureFor(blackStep)),
    ],
    maximumNegativeBeyondUncertaintyFraction: 0.05,
  };
  ambientDiagnostic.status = ambientDiagnostic.negativeBeyondUncertaintyFraction
      <= ambientDiagnostic.maximumNegativeBeyondUncertaintyFraction
    ? "passed"
    : "failed";
  if (ambientDiagnostic.status !== "passed") {
    throw new CameraCalibrationError(
      "CALIBRATION_AMBIENT_REFERENCE_INCONSISTENT",
      `Projector ${output.id} digital-black capture is materially below its projectors-off ambient reference`,
      { ambientDiagnostic },
    );
  }
  const targetMesh = cameraTargetMeshForOutput({
    plan,
    output,
    cameraWidth,
    cameraHeight,
    fallbackCorners: visibleBounds(surfaceMask, cameraWidth, cameraHeight),
  });
  let warp;
  try {
    warp = buildWarpMeshFromCameraMap({
      cameraWidth,
      cameraHeight,
      projectorWidth: output.width,
      projectorHeight: output.height,
      projectorX: decoded.x.codes,
      projectorY: decoded.y.codes,
      confidence,
      targetMesh,
      minimumConfidence: plan.mesh.minimumConfidence,
      maxSearchRadius: Math.min(48, Math.max(cameraWidth, cameraHeight)),
    });
  } catch (error) {
    throw new CameraCalibrationError(
      "CALIBRATION_WARP_SOLVE_FAILED",
      `Could not solve the dense camera warp for projector ${output.id}: ${error.message}`,
    );
  }
  const geometry = markerlessGeometryEvidence({
    plan,
    output,
    warp,
    cameraWidth,
    cameraHeight,
  });
  const radiometric = solveMeasuredRadiometry({
    plan,
    output,
    captures,
    surfaceMask,
    cameraWidth,
    cameraHeight,
    measuredExposureNormalization,
  });
  const whiteResponseScale = Number(radiometric.whiteResponseLuma);
  if (!Number.isFinite(whiteResponseScale) || whiteResponseScale <= 1e-6) {
    throw new CameraCalibrationError(
      "CALIBRATION_RADIOMETRY_LOW_SIGNAL",
      `Projector ${output.id} white response is too small to express black correction in calibrated linear-light units`,
      { whiteResponseScale },
    );
  }
  const visibleBlack = [];
  const visibleUncertainty = [];
  for (let index = 0; index < pixelCount; index += 1) {
    if (surfaceMask[index] <= 0) continue;
    visibleBlack.push(black[index] / whiteResponseScale);
    if (blackFloorFrame.uncertainty) {
      visibleUncertainty.push(blackFloorFrame.uncertainty[index] / whiteResponseScale);
    }
  }
  const blackRange = Math.max(0, percentile(visibleBlack, 0.95) - percentile(visibleBlack, 0.05));
  const blackUncertaintyP95 = visibleUncertainty.length ? percentile(visibleUncertainty, 0.95) : null;
  const blackSnrDb = blackUncertaintyP95 == null
    ? null
    : blackRange <= 1e-12 && blackUncertaintyP95 <= 1e-12
      ? 300
      : 20 * Math.log10(Math.max(1e-12, blackRange) / Math.max(1e-12, blackUncertaintyP95));
  if (strict && blackUncertaintyP95 == null) {
    throw new CameraCalibrationError(
      "CALIBRATION_BLACK_UNCERTAINTY_MISSING",
      `Projector ${output.id} strict black calibration requires repeated black and ambient captures`,
    );
  }
  if (strict && blackRange > 1e-5 && blackSnrDb < 10) {
    throw new CameraCalibrationError(
      "CALIBRATION_BLACK_UNCERTAINTY_TOO_HIGH",
      `Projector ${output.id} black nonuniformity is below the reliable measurement floor`,
      { blackRange, uncertaintyP95: blackUncertaintyP95, snrDb: blackSnrDb, minimumSnrDb: 10 },
    );
  }
  radiometric.radiometry.gates.minimumNearBlackSnrDb = radiometric.radiometry.gates.minimumSnrDb;
  radiometric.radiometry.gates.maximumBlackUncertaintyP95 = 0.02;
  radiometric.radiometry.gates.maximumBlackLift = 0.35;
  if (blackUncertaintyP95 > radiometric.radiometry.gates.maximumBlackUncertaintyP95) {
    throw new CameraCalibrationError(
      "CALIBRATION_BLACK_UNCERTAINTY_TOO_HIGH",
      `Projector ${output.id} black uncertainty exceeds the safe correction threshold`,
      {
        uncertaintyP95: blackUncertaintyP95,
        maximumBlackUncertaintyP95: radiometric.radiometry.gates.maximumBlackUncertaintyP95,
      },
    );
  }
  throwIfCancelled(signal);
  return {
    output,
    steps,
    cameraWidth,
    cameraHeight,
    black,
    blackUncertainty: blackFloorFrame.uncertainty,
    whiteResponseScale,
    white,
    surfaceMask,
    projectorX: decoded.x.codes,
    projectorY: decoded.y.codes,
    confidence,
    warp,
    geometry,
    gamma: radiometric.gamma,
    lut: radiometric.lut,
    radiometry: {
      ...radiometric.radiometry,
      ambientDiagnostic,
      black: {
        basis: "total-observed-projector-black-after-sensor-dark",
        status: "passed",
        uncertaintyP95: blackUncertaintyP95,
        nonuniformityRange: blackRange,
        snrDb: blackSnrDb,
        target: 0,
        maxLift: 0,
      },
    },
  };
}

/**
 * Test-only solver. It exercises the real Gray decoder and map builders, but
 * labels every artifact simulated and non-applicable so it can never be used
 * as projector calibration by mistake.
 */
export class DeterministicSimulatedCalibrationSolver {
  async solve({ plan, captures, camera, cameraLock, startedAt, completedAt }) {
    const frame = captures[0];
    if (!frame) throw new CameraCalibrationError("MISSING_CALIBRATION_CAPTURE", "Calibration captured no camera frames");
    const cameraWidth = frame.width;
    const cameraHeight = frame.height;
    const solved = [];

    for (const output of plan.outputs) {
      const steps = plan.steps.filter((step) => step.outputId === output.id);
      const find = (purpose) => steps.find((step) => step.purpose === purpose);
      const whiteStep = find("white");
      const blackStep = referenceStepFor({
        plan,
        outputId: output.id,
        targetStep: whiteStep,
        kind: "projector-black",
        required: true,
      });
      const black = averageFrames(capturesForStep(captures, blackStep.id));
      const white = averageFrames(capturesForStep(captures, whiteStep?.id));
      const decoded = {};
      for (const axis of ["x", "y"]) {
        const bits = requiredGrayBits(axis === "x" ? output.width : output.height);
        const normalFrames = [];
        const inverseFrames = [];
        for (let bit = 0; bit < bits; bit += 1) {
          const normal = steps.find((step) => step.purpose === "gray-code" && step.pattern.axis === axis
            && step.pattern.bit === bit && step.pattern.inverse === false);
          const inverse = steps.find((step) => step.purpose === "gray-code" && step.pattern.axis === axis
            && step.pattern.bit === bit && step.pattern.inverse === true);
          normalFrames.push(asGray8(averageFrames(capturesForStep(captures, normal?.id))));
          inverseFrames.push(asGray8(averageFrames(capturesForStep(captures, inverse?.id))));
        }
        decoded[axis] = decodeGrayCodeFrames({
          normalFrames,
          inverseFrames,
          width: cameraWidth,
          height: cameraHeight,
          threshold: 12,
        });
      }
      const confidence = Float32Array.from(decoded.x.confidence, (value, index) => Math.min(value, decoded.y.confidence[index]));
      const targetMesh = cameraTargetMeshForOutput({
        plan,
        output,
        cameraWidth,
        cameraHeight,
        fallbackCorners: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      });
      const warp = buildWarpMeshFromCameraMap({
        cameraWidth,
        cameraHeight,
        projectorWidth: output.width,
        projectorHeight: output.height,
        projectorX: decoded.x.codes,
        projectorY: decoded.y.codes,
        confidence,
        targetMesh,
        minimumConfidence: plan.mesh.minimumConfidence,
        maxSearchRadius: Math.max(cameraWidth, cameraHeight),
      });
      const mask = Float32Array.from(white, (value, index) => value - black[index] >= 0.08 ? 1 : 0);
      const blackPedestal = buildBlackUniformityMap(black).lift;
      const geometry = markerlessGeometryEvidence({
        plan,
        output,
        warp,
        cameraWidth,
        cameraHeight,
        simulated: true,
      });
      solved.push({ output, steps, black, white, confidence, warp, geometry, mask, blackPedestal });
    }

    const blendWeights = buildAutomaticBlendMaps(solved.map((item) => item.mask), {
      width: cameraWidth,
      height: cameraHeight,
    });
    const lutSize = 2;
    const lutValues = identityLut(lutSize);
    const outputs = solved.map((item, index) => {
      const base = `sim://${plan.sessionId}/${item.output.id}`;
      const blendWeight = resampleScalarMap(
        blendWeights[index], cameraWidth, cameraHeight, item.output.width, item.output.height,
      );
      const blackPedestal = resampleScalarMap(
        item.blackPedestal, cameraWidth, cameraHeight, item.output.width, item.output.height,
      );
      const mask = resampleScalarMap(item.mask, cameraWidth, cameraHeight, item.output.width, item.output.height);
      const confidence = resampleScalarMap(
        item.confidence, cameraWidth, cameraHeight, item.output.width, item.output.height,
      );
      const warpJson = JSON.stringify({
        columns: item.warp.columns,
        rows: item.warp.rows,
        interpolation: item.warp.interpolation,
        points: item.warp.points.map(({ u, v, x, y }) => ({ u, v, x, y })),
      });
      return {
        outputId: item.output.id,
        captureIds: captureIdsForSteps(captures, (capture) => capture.outputId === item.output.id),
        ...(item.geometry == null ? {} : { geometry: item.geometry }),
        artifacts: {
          warp: {
            ...assetRef({ uri: `${base}/warp.json`, format: "pb-warp-mesh-v1", value: warpJson }),
            columns: item.warp.columns,
            rows: item.warp.rows,
            interpolation: item.warp.interpolation,
            pointCount: item.warp.points.length,
          },
          blendWeight: assetRef({
            uri: `${base}/blend.r32f`, format: "r32_float", value: blendWeight,
            width: item.output.width, height: item.output.height,
          }),
          blackPedestal: assetRef({
            uri: `${base}/black-pedestal.r32f`, format: "r32_float", value: blackPedestal,
            width: item.output.width, height: item.output.height,
          }),
          mask: assetRef({
            uri: `${base}/mask.r32f`, format: "r32_float", value: mask,
            width: item.output.width, height: item.output.height,
          }),
          confidence: assetRef({
            uri: `${base}/confidence.r32f`, format: "r32_float", value: confidence,
            width: item.output.width, height: item.output.height,
          }),
          gamma: estimateGamma(plan, item.steps, captures, item.black, item.white),
          lut: {
            ...assetRef({ uri: `${base}/identity-lut.rgba32f`, format: "rgba32_float", value: lutValues, size: lutSize }),
            status: "identity-fallback",
            confidence: 0,
          },
        },
      };
    });

    return {
      schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
      sessionId: plan.sessionId,
      project: plan.project,
      provenance: "simulated",
      applicable: false,
      camera,
      cameraSettings: cameraLock.applied,
      ...(plan.lensProfile == null ? {} : { lensProfile: plan.lensProfile }),
      sourcePolicy: plan.sourcePolicy,
      startedAt,
      completedAt,
      outputs,
    };
  }
}

/**
 * Production solver for captures supplied by a real camera adapter. It keeps
 * every correction in linear light, inverts the measured Gray-code address
 * map into projector-resolution rasters, and commits the complete artifact set
 * with one directory rename. The class is camera-vendor agnostic; Canon EDSDK
 * remains a separate capture-adapter boundary.
 */
export class MeasuredCalibrationSolver {
  constructor({
    artifactRoot,
    maxOutputPixels = 67_108_864,
    minimumPixelCoverage = 0.85,
    minimumTileCoverage = 0.98,
  } = {}) {
    if (!artifactRoot) {
      throw new CameraCalibrationError(
        "CALIBRATION_ARTIFACT_ROOT_REQUIRED",
        "Measured calibration requires a persistent local artifact directory",
      );
    }
    this.artifactRoot = resolve(String(artifactRoot));
    this.maxOutputPixels = Math.max(4_096, Math.min(268_435_456, Math.round(Number(maxOutputPixels) || 67_108_864)));
    this.minimumPixelCoverage = Math.max(0.5, Math.min(1, Number(minimumPixelCoverage) || 0.85));
    this.minimumTileCoverage = Math.max(0.8, Math.min(1, Number(minimumTileCoverage) || 0.98));
  }

  async solve({ plan, captures, camera, cameraLock, captureProvenance = null, startedAt, completedAt, signal = null }) {
    throwIfCancelled(signal);
    if (!captureProvenance) {
      throw new CameraCalibrationError(
        "CAPTURE_PROVENANCE_REQUIRED",
        "Applicable measured calibration requires lens, pipeline, physical-capture and stack provenance",
      );
    }
    const firstCapture = captures[0];
    assertLensProfileCaptureBinding({
      plan,
      camera,
      captureProvenance,
      cameraWidth: Number(firstCapture?.width),
      cameraHeight: Number(firstCapture?.height),
    });
    const totalPixels = plan.outputs.reduce((total, output) => total + output.width * output.height, 0);
    if (!Number.isSafeInteger(totalPixels) || totalPixels > this.maxOutputPixels) {
      throw new CameraCalibrationError(
        "CALIBRATION_OUTPUT_TOO_LARGE",
        `Measured calibration output raster exceeds the configured ${this.maxOutputPixels}-pixel safety limit`,
        { totalPixels, maxOutputPixels: this.maxOutputPixels },
      );
    }
    const solved = plan.outputs.map((output) => solveMeasuredCameraSpace({ plan, output, captures, signal }));
    const cameraWidth = solved[0]?.cameraWidth;
    const cameraHeight = solved[0]?.cameraHeight;
    if (!cameraWidth || solved.some((item) => item.cameraWidth !== cameraWidth || item.cameraHeight !== cameraHeight)) {
      throw new CameraCalibrationError("CAMERA_FRAME_SIZE_CHANGED", "Camera raster changed between projector captures");
    }
    const cameraBlendWeights = buildAutomaticBlendMaps(solved.map((item) => item.surfaceMask), {
      width: cameraWidth,
      height: cameraHeight,
    });
    const blackCorrection = allocateCombinedBlackCorrection({
      blackFrames: solved.map((item) => item.black),
      masks: solved.map((item) => item.surfaceMask),
      blendWeights: cameraBlendWeights,
      uncertaintyFrames: solved.map((item) => item.blackUncertainty),
      responseScales: solved.map((item) => item.whiteResponseScale),
      requireUncertainty: radiometryIsStrict(plan),
    });
    const sessionStem = safeArtifactStem(plan.sessionId);
    const finalDirectory = join(this.artifactRoot, sessionStem);
    await mkdir(this.artifactRoot, { recursive: true });
    try {
      await stat(finalDirectory);
      throw new CameraCalibrationError(
        "CALIBRATION_ARTIFACT_SESSION_EXISTS",
        `Calibration artifact directory already exists for session ${plan.sessionId}`,
      );
    } catch (error) {
      if (error instanceof CameraCalibrationError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    const stagingDirectory = await mkdtemp(join(this.artifactRoot, `.${sessionStem}-`));
    try {
      const outputRecords = [];
      for (let outputIndex = 0; outputIndex < solved.length; outputIndex += 1) {
        throwIfCancelled(signal);
        const item = solved[outputIndex];
        const stem = safeArtifactStem(item.output.id);
        const scatter = (values, returnMetadata = false) => scatterCameraMapToProjector({
          values,
          cameraWidth,
          cameraHeight,
          projectorWidth: item.output.width,
          projectorHeight: item.output.height,
          projectorX: item.projectorX,
          projectorY: item.projectorY,
          confidence: item.confidence,
          sampleMask: item.surfaceMask,
          minimumConfidence: plan.mesh.minimumConfidence,
          signal,
          returnMetadata,
        });
        const measuredMask = scatter(item.surfaceMask, true);
        if (measuredMask.coverage.pixelRatio < this.minimumPixelCoverage
          || measuredMask.coverage.tileRatio < this.minimumTileCoverage) {
          throw new CameraCalibrationError(
            "CALIBRATION_MAP_COVERAGE_TOO_LOW",
            `Projector ${item.output.id} correction map is too sparse to apply safely`,
            {
              outputId: item.output.id,
              coverage: measuredMask.coverage,
              minimumPixelCoverage: this.minimumPixelCoverage,
              minimumTileCoverage: this.minimumTileCoverage,
            },
          );
        }
        const warpPayload = Buffer.from(JSON.stringify({
          columns: item.warp.columns,
          rows: item.warp.rows,
          interpolation: item.warp.interpolation,
          points: item.warp.points.map(({ u, v, x, y }) => ({ u, v, x, y })),
        }), "utf8");
        const records = {
          warp: await writeStagedArtifact(stagingDirectory, `${stem}.warp.json`, warpPayload),
          blendWeight: await writeStagedArtifact(
            stagingDirectory,
            `${stem}.blend.r32f`,
            scatter(cameraBlendWeights[outputIndex]),
          ),
          blackPedestal: await writeStagedArtifact(
            stagingDirectory,
            `${stem}.black-pedestal.r32f`,
            scatter(blackCorrection.contributions[outputIndex]),
          ),
          mask: await writeStagedArtifact(
            stagingDirectory,
            `${stem}.mask.r32f`,
            measuredMask.values,
          ),
          confidence: await writeStagedArtifact(
            stagingDirectory,
            `${stem}.confidence.r32f`,
            scatter(item.confidence),
          ),
        };
        const lutSize = item.lut.size;
        records.lut = await writeStagedArtifact(
          stagingDirectory,
          `${stem}.lut-${lutSize}.rgba32f`,
          item.lut.values,
        );
        outputRecords.push({ item, records, lutSize });
      }

      const candidate = {
        schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
        sessionId: plan.sessionId,
        project: plan.project,
        provenance: "measured",
        applicable: true,
        camera,
        cameraSettings: cameraLock.applied,
        exposureProfiles: plan.exposureProfiles,
        ...(plan.lensProfile == null ? {} : { lensProfile: plan.lensProfile }),
        captureProvenance,
        sourcePolicy: plan.sourcePolicy,
        startedAt,
        completedAt,
        outputs: outputRecords.map(({ item, records, lutSize }, outputIndex) => {
          const measuredMaxLift = Array.from(blackCorrection.contributions[outputIndex])
            .reduce((maximum, value) => Math.max(maximum, Number(value) || 0), 0);
          const radiometry = {
            ...item.radiometry,
            black: {
              ...item.radiometry.black,
              target: blackCorrection.target,
              maxLift: measuredMaxLift,
            },
            lut: {
              ...item.radiometry.lut,
              artifactSha256: records.lut.sha256,
            },
          };
          radiometry.gates.passed = radiometry.samples.usable >= radiometry.gates.minimumUsableSamples
            && radiometry.fit.rmse <= radiometry.gates.maximumRmse
            && radiometry.fit.snrDb >= radiometry.gates.minimumSnrDb
            && radiometry.fit.nearBlackSnrDb >= radiometry.gates.minimumNearBlackSnrDb
            && radiometry.fit.coverage >= radiometry.gates.minimumCoverage
            && radiometry.fit.clippedFraction <= radiometry.gates.maximumClippedFraction
            && radiometry.black.uncertaintyP95 <= radiometry.gates.maximumBlackUncertaintyP95
            && radiometry.black.maxLift <= radiometry.gates.maximumBlackLift
            && radiometry.black.status === "passed"
            && radiometry.ambientDiagnostic.status === "passed";
          if (!radiometry.gates.passed) {
            throw new CameraCalibrationError(
              "CALIBRATION_RADIOMETRY_GATES_FAILED",
              `Projector ${item.output.id} did not pass every radiometric application gate`,
              { radiometry },
            );
          }
          return {
            outputId: item.output.id,
            captureIds: captureIdsForSteps(
              captures,
              (capture) => capture.outputId == null || capture.outputId === item.output.id,
            ),
            ...(item.geometry == null ? {} : { geometry: item.geometry }),
            radiometry,
            artifacts: {
            warp: finalArtifactReference(finalDirectory, records.warp, {
              format: "pb-warp-mesh-v1",
              columns: item.warp.columns,
              rows: item.warp.rows,
              interpolation: item.warp.interpolation,
              pointCount: item.warp.points.length,
            }),
            blendWeight: finalArtifactReference(finalDirectory, records.blendWeight, {
              format: "r32_float", width: item.output.width, height: item.output.height,
            }),
            blackPedestal: finalArtifactReference(finalDirectory, records.blackPedestal, {
              format: "r32_float", width: item.output.width, height: item.output.height,
            }),
            mask: finalArtifactReference(finalDirectory, records.mask, {
              format: "r32_float", width: item.output.width, height: item.output.height,
            }),
            confidence: finalArtifactReference(finalDirectory, records.confidence, {
              format: "r32_float", width: item.output.width, height: item.output.height,
            }),
            gamma: item.gamma,
            lut: {
              ...finalArtifactReference(finalDirectory, records.lut, { format: "rgba32_float", size: lutSize }),
              status: "measured-relative",
              confidence: item.gamma.confidence,
            },
            },
          };
        }),
      };
      const manifest = normalizeCameraCalibrationManifest(candidate, { plan });
      throwIfCancelled(signal);
      await rename(stagingDirectory, finalDirectory);
      return manifest;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}

export class CameraCalibrationOrchestrator {
  constructor({
    cameraAdapter,
    patternAdapter,
    solver,
    maxCapturePixels = 4_194_304,
    maxCaptureWidth = 4_096,
    maxCaptureHeight = 4_096,
    maxRadiometricPixels = 262_144,
    maxRawCaptureBytes = 384 * 1024 * 1024,
    maxSessionCaptureBytes = 512 * 1024 * 1024,
    now = () => new Date().toISOString(),
    log = () => {},
    onTransition = () => {},
    requestOperatorConfirmation = null,
  } = {}) {
    if (!cameraAdapter || !patternAdapter || !solver) {
      throw new CameraCalibrationError("CALIBRATION_ADAPTER_REQUIRED", "Camera, pattern and solver adapters are required");
    }
    this.cameraAdapter = cameraAdapter;
    this.patternAdapter = patternAdapter;
    this.solver = solver;
    this.maxCapturePixels = Math.max(4_096, Math.min(16_777_216, Math.round(Number(maxCapturePixels) || 4_194_304)));
    this.maxCaptureWidth = Math.max(64, Math.min(8_192, Math.round(Number(maxCaptureWidth) || 4_096)));
    this.maxCaptureHeight = Math.max(64, Math.min(8_192, Math.round(Number(maxCaptureHeight) || 4_096)));
    this.maxRadiometricPixels = Math.max(4_096, Math.min(1_048_576,
      Math.round(Number(maxRadiometricPixels) || 262_144)));
    this.maxRawCaptureBytes = Math.max(16 * 1024 * 1024, Math.min(1024 * 1024 * 1024,
      Math.round(Number(maxRawCaptureBytes) || 384 * 1024 * 1024)));
    this.maxSessionCaptureBytes = Math.max(1_024, Math.min(4 * 1024 * 1024 * 1024,
      Math.round(Number(maxSessionCaptureBytes) || 512 * 1024 * 1024)));
    this.now = now;
    this.log = log;
    this.onTransition = onTransition;
    this.requestOperatorConfirmation = requestOperatorConfirmation;
    this.session = null;
  }

  #capturePolicy(plan) {
    const captureCount = plan.steps.reduce((total, step) => total + (step.capture ? step.repeats : 0), 0);
    if (!Number.isSafeInteger(captureCount) || captureCount < 1) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Calibration plan contains no camera captures");
    }
    const capturedSteps = plan.steps.filter((step) => step.capture);
    const radiometricSteps = capturedSteps.filter((step) => step.pattern?.kind === "solid");
    const lumaUncertaintySteps = capturedSteps.filter((step) => {
      const referenceKind = referenceKindForStep(plan, step);
      return referenceKind != null || step.purpose === "near-black";
    });
    const lumaComponents = capturedSteps.length + lumaUncertaintySteps.length;
    const minimumPixels = Math.max(4_096, (plan.mesh.columns + 1) * (plan.mesh.rows + 1) * 4);
    const minimumRadiometricPixels = radiometricSteps.length ? 4_096 : 0;
    const retainedLumaBytesPerPixel = lumaComponents * Float32Array.BYTES_PER_ELEMENT;
    const retainedRgbBytesPerPixel = radiometricSteps.length * 3 * Float32Array.BYTES_PER_ELEMENT * 2;
    // Peak for one active stack includes the raw RGB frame, area-bin sums and
    // counts, three Float64 median-of-means group sums, the first bounded
    // sample, and final value/uncertainty rasters. These conservative constants
    // bound simultaneous temporary memory, not merely retained final frames.
    const activeLumaBytesPerPixel = 56;
    const activeRgbBytesPerPixel = radiometricSteps.length ? 124 : 0;
    const lumaPeakCoefficient = retainedLumaBytesPerPixel + activeLumaBytesPerPixel;
    const rgbPeakCoefficient = retainedRgbBytesPerPixel + activeRgbBytesPerPixel;
    const estimatedMinimumPeakBytes = minimumPixels * lumaPeakCoefficient
      + minimumRadiometricPixels * rgbPeakCoefficient;
    if (estimatedMinimumPeakBytes > this.maxSessionCaptureBytes) {
      throw new CameraCalibrationError(
        "CALIBRATION_CAPTURE_MEMORY_BUDGET_EXCEEDED",
        "Calibration plan cannot retain and robustly aggregate enough camera samples inside the peak memory budget",
        {
          captureCount,
          minimumPixels,
          minimumRadiometricPixels,
          estimatedMinimumPeakBytes,
          maxSessionCaptureBytes: this.maxSessionCaptureBytes,
        },
      );
    }
    const maximumRgbInsideBudget = radiometricSteps.length
      ? Math.floor((this.maxSessionCaptureBytes - minimumPixels * lumaPeakCoefficient) / rgbPeakCoefficient)
      : 0;
    const maximumPixelsInsideDimensionCaps = this.maxCaptureWidth * this.maxCaptureHeight;
    const radiometricPixels = radiometricSteps.length
      ? Math.min(
        this.maxRadiometricPixels,
        maximumPixelsInsideDimensionCaps,
        Math.max(minimumRadiometricPixels, maximumRgbInsideBudget),
      )
      : 0;
    const retainedPixels = Math.min(
      this.maxCapturePixels,
      maximumPixelsInsideDimensionCaps,
      Math.floor((this.maxSessionCaptureBytes - radiometricPixels * rgbPeakCoefficient) / lumaPeakCoefficient),
    );
    if (retainedPixels < minimumPixels) {
      throw new CameraCalibrationError(
        "CALIBRATION_CAPTURE_MEMORY_BUDGET_EXCEEDED",
        "Calibration peak memory policy could not retain the required geometry raster",
        { retainedPixels, minimumPixels, radiometricPixels, maxSessionCaptureBytes: this.maxSessionCaptureBytes },
      );
    }
    const estimatedRetainedBytes = retainedPixels * retainedLumaBytesPerPixel
      + radiometricPixels * retainedRgbBytesPerPixel;
    const estimatedActiveStackBytes = retainedPixels * activeLumaBytesPerPixel
      + radiometricPixels * activeRgbBytesPerPixel;
    const estimatedMaximumBytes = estimatedRetainedBytes + estimatedActiveStackBytes;
    return {
      captureCount,
      maxPixels: retainedPixels,
      maxRadiometricPixels: radiometricPixels,
      maxWidth: this.maxCaptureWidth,
      maxHeight: this.maxCaptureHeight,
      maxRawBytes: Math.min(this.maxRawCaptureBytes, retainedPixels * 3 * Float32Array.BYTES_PER_ELEMENT),
      estimatedRetainedBytes,
      estimatedActiveStackBytes,
      estimatedMaximumBytes,
    };
  }

  #event(plan, type, data = {}) {
    this.session = transitionCameraCalibration(this.session, {
      sessionId: plan.sessionId,
      type,
      at: this.now(),
      ...data,
    }, plan);
    this.log("info", "camera-calibration.transition", { sessionId: plan.sessionId, state: this.session.state, event: type });
    this.onTransition(this.session, { type, ...data });
  }

  async run(plan, { signal = null } = {}) {
    this.session = createCameraCalibrationSession(plan, { at: this.now() });
    const captures = [];
    const physicalCaptures = [];
    const captureStacks = [];
    let lensProvenance = null;
    let pipelineProvenance = null;
    let decoderProvenance = null;
    let rawDecodeProvenance = null;
    const rawSourceDigests = new Set();
    let retainedCaptureBytes = 0;
    let cameraOpened = false;
    let overrideActive = false;
    const checkCancelled = () => {
      if (signal?.aborted) {
        throw new CameraCalibrationError("CALIBRATION_CANCELLED", "Camera calibration was cancelled");
      }
    };
    try {
      checkCancelled();
      this.#event(plan, CAMERA_CALIBRATION_EVENT.START);
      const capturePolicy = this.#capturePolicy(plan);
      const detection = await this.cameraAdapter.detect();
      checkCancelled();
      if (detection?.adapter?.available !== true) {
        throw new CameraCalibrationError(
          detection?.error?.code || "CAMERA_ADAPTER_UNAVAILABLE",
          detection?.error?.message || "Camera adapter is unavailable",
          { adapter: detection?.adapter ?? null },
        );
      }
      const cameras = Array.isArray(detection.cameras) ? detection.cameras.map(normalizeCameraDescriptor) : [];
      const camera = plan.requestedCameraId
        ? cameras.find((candidate) => candidate.id === plan.requestedCameraId)
        : cameras[0];
      if (!camera) throw new CameraCalibrationError("CAMERA_NOT_FOUND", "No matching calibration camera was detected");
      const physicalRawRequired = !(camera.transport === "simulation"
        && camera.backend === "deterministic-camera-v1");
      const missingCapabilities = ["manualExposure", "manualWhiteBalance", "manualFocus", "linearCapture"]
        .filter((capability) => camera.capabilities[capability] !== true);
      if (missingCapabilities.length) {
        throw new CameraCalibrationError("CAMERA_CAPABILITY_MISSING", "Camera lacks required calibration controls", { missingCapabilities });
      }
      this.#event(plan, CAMERA_CALIBRATION_EVENT.CAMERA_FOUND, { camera });
      this.#event(plan, CAMERA_CALIBRATION_EVENT.BEGIN_LOCK);
      await this.cameraAdapter.open(camera.id);
      cameraOpened = true;
      const cameraLock = verifyManualCameraLock(
        plan.cameraSettings,
        await this.cameraAdapter.lockManualSettings(plan.cameraSettings),
      );
      let activeCameraLock = cameraLock;
      let activeExposureProfileId = null;
      checkCancelled();
      this.#event(plan, CAMERA_CALIBRATION_EVENT.CAMERA_LOCKED, { cameraLock });
      this.#event(plan, CAMERA_CALIBRATION_EVENT.BEGIN_OVERRIDE);
      const ownership = await this.patternAdapter.beginCalibration({ plan, camera });
      if (ownership?.exclusive !== true || ownership?.arenaBlanked !== true || ownership?.mode !== "black") {
        throw new CameraCalibrationError("CALIBRATION_OUTPUT_OWNERSHIP_FAILED", "Pattern adapter did not confirm exclusive black output ownership");
      }
      overrideActive = true;
      this.#event(plan, CAMERA_CALIBRATION_EVENT.OVERRIDE_READY);

      let activeOperatorConfirmationLease = null;
      for (const step of plan.steps) {
        checkCancelled();
        let operatorVerification = null;
        const confirmationLeaseId = step.captureConditions?.requiresOperatorConfirmation === true
          ? String(step.confirmationLeaseId || step.captureConditions?.confirmationLeaseId || "").trim()
          : "";
        if (!confirmationLeaseId || activeOperatorConfirmationLease?.id !== confirmationLeaseId) {
          activeOperatorConfirmationLease = null;
        }
        const profile = exposureProfileForStep(plan, step);
        const profileId = exposureProfileIdForStep(plan, step);
        if (profileId && profileId !== activeExposureProfileId) {
          if (!profile?.settings) {
            throw new CameraCalibrationError(
              "MISSING_EXPOSURE_PROFILE_SETTINGS",
              `Exposure profile ${profileId} does not provide manual camera settings`,
            );
          }
          activeCameraLock = verifyManualCameraLock(
            profile.settings,
            await this.cameraAdapter.lockManualSettings(profile.settings),
          );
          activeExposureProfileId = profileId;
        }
        if (step.captureConditions?.requiresOperatorConfirmation === true) {
          if (typeof this.requestOperatorConfirmation !== "function") {
            throw new CameraCalibrationError(
              "CALIBRATION_OPERATOR_CONFIRMATION_REQUIRED",
              `Step ${step.id} requires explicit operator confirmation`,
              { stepId: step.id, operatorPrompt: step.captureConditions.operatorPrompt || null },
            );
          }
          let confirmation;
          if (activeOperatorConfirmationLease) {
            confirmation = {
              ...activeOperatorConfirmationLease.confirmation,
              stepId: step.id,
            };
            this.onTransition(this.session, {
              type: "operator-confirmation-reused",
              stepId: step.id,
              confirmationLeaseId,
              confirmationId: confirmation.confirmationId,
            });
          } else {
            this.onTransition(this.session, {
              type: "operator-confirmation-required",
              stepId: step.id,
              operatorPrompt: step.captureConditions.operatorPrompt || null,
              captureConditions: step.captureConditions,
              confirmationLeaseId,
            });
            confirmation = await this.requestOperatorConfirmation({ plan, step, signal });
          }
          checkCancelled();
          const verification = confirmation?.conditionVerification;
          const confirmationId = String(confirmation?.confirmationId || verification?.confirmationId || "").trim();
          if (confirmation?.confirmed !== true
            || (confirmation.stepId != null && String(confirmation.stepId) !== step.id)
            || !confirmationLeaseId
            || !confirmationId
            || !verification
            || verification.projectorState !== step.captureConditions.projectorState
            || verification.opticalPath !== step.captureConditions.opticalPath
            || verification.otherProjectors !== step.captureConditions.otherProjectors
            || !String(verification.method || "").trim()
            || !Number.isFinite(Date.parse(verification.verifiedAt))) {
            throw new CameraCalibrationError(
              "CALIBRATION_OPERATOR_CONFIRMATION_REJECTED",
              `Operator confirmation metadata did not verify capture conditions for ${step.id}`,
              { stepId: step.id, expected: step.captureConditions },
            );
          }
          operatorVerification = {
            projectorState: verification.projectorState,
            opticalPath: verification.opticalPath,
            otherProjectors: verification.otherProjectors,
            method: String(verification.method),
            verifiedAt: verification.verifiedAt,
            confirmationLeaseId,
            confirmationId,
          };
          activeOperatorConfirmationLease = {
            id: confirmationLeaseId,
            confirmation: {
              confirmed: true,
              confirmationId,
              conditionVerification: structuredClone(operatorVerification),
            },
          };
        }
        const presented = await this.patternAdapter.showStep(step);
        if (presented?.presented !== true || presented?.exclusive !== true || presented?.arenaBlanked !== true) {
          throw new CameraCalibrationError("CALIBRATION_PATTERN_NOT_CONFIRMED", `Pattern was not confirmed: ${step.id}`);
        }
        const conditionVerification = operatorVerification || (step.captureConditions ? {
          projectorState: step.captureConditions.projectorState,
          opticalPath: step.captureConditions.opticalPath,
          otherProjectors: step.captureConditions.otherProjectors,
          method: String(presented.conditionVerification?.method
            || step.captureConditions.verification
            || "pattern-and-output-controller"),
          verifiedAt: presented.conditionVerification?.verifiedAt || this.now(),
          confirmationLeaseId: null,
          confirmationId: null,
        } : null);
        if (step.capture) {
          const preserveRadiometricRgb = step.pattern?.kind === "solid";
          const referenceKind = referenceKindForStep(plan, step);
          const accumulator = new RobustCaptureAccumulator({
            retainLumaUncertainty: referenceKind != null || step.purpose === "near-black",
            retainRgbUncertainty: preserveRadiometricRgb,
          });
          for (let repeat = 0; repeat < step.repeats; repeat += 1) {
            checkCancelled();
            const rawCapture = await this.cameraAdapter.capture({
              step,
              repeat,
              settleFrames: step.settleFrames,
              signal,
              maxPixels: capturePolicy.maxPixels,
              maxWidth: capturePolicy.maxWidth,
              maxHeight: capturePolicy.maxHeight,
              preferredPixelFormat: "linear-rgb-f32",
              exposureProfileId: profileId,
              exposureSettings: activeCameraLock.applied,
            });
            const expectedCaptureId = `${step.id}#${repeat}`;
            const rawCaptureProvenance = rawCapture?.provenance || rawCapture?.captureProvenance || null;
            const rawLens = rawCapture?.lens || rawCapture?.captureProvenance?.lens || null;
            const rawPipeline = rawCapture?.pipeline || rawCapture?.captureProvenance?.pipeline || null;
            let sourceSha256 = null;
            let rasterSha256 = null;
            if (physicalRawRequired) {
              if (!rawLens || !rawPipeline || !rawCaptureProvenance) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_PROVENANCE_REQUIRED",
                  "Physical measured capture did not include lens, pipeline and RAW source provenance",
                  { captureId: expectedCaptureId },
                );
              }
              let rawDecoder;
              let rawDecode;
              try {
                rawDecoder = normalizeRawDecoderProvenance(
                  rawCaptureProvenance.decoder,
                  `capture.${expectedCaptureId}.decoder`,
                );
                rawDecode = normalizeRawDecodeMetadata(rawCaptureProvenance.rawDecode, {
                  field: `capture.${expectedCaptureId}.rawDecode`,
                  bitDepth: rawCapture?.sourceBitDepth ?? rawCapture?.bitDepth,
                });
              } catch (error) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_PROVENANCE_INVALID",
                  `Physical capture ${expectedCaptureId} has invalid bounded RAW decode provenance: ${error?.message || "unknown error"}`,
                );
              }
              sourceSha256 = String(rawCaptureProvenance.sourceSha256 || "");
              rasterSha256 = String(rawCapture?.rasterSha256 || rawCaptureProvenance.rasterSha256 || "");
              if (!/^[a-f0-9]{64}$/.test(sourceSha256) || !/^[a-f0-9]{64}$/.test(rasterSha256)) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_PROVENANCE_INVALID",
                  `Physical capture ${expectedCaptureId} must bind lowercase source and decoded-raster SHA-256 digests`,
                );
              }
              if (rawSourceDigests.has(sourceSha256)) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_SOURCE_REUSED",
                  `Physical capture ${expectedCaptureId} reused a RAW source digest from an earlier capture`,
                  { captureId: expectedCaptureId, sourceSha256 },
                );
              }
              rawSourceDigests.add(sourceSha256);
              if (decoderProvenance && JSON.stringify(decoderProvenance) !== JSON.stringify(rawDecoder)) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_DECODER_CHANGED",
                  `RAW decoder identity changed during calibration at ${expectedCaptureId}`,
                );
              }
              if (rawDecodeProvenance && JSON.stringify(rawDecodeProvenance) !== JSON.stringify(rawDecode)) {
                throw new CameraCalibrationError(
                  "CAPTURE_RAW_DECODE_CHANGED",
                  `RAW sensor/decode metadata changed during calibration at ${expectedCaptureId}`,
                );
              }
              decoderProvenance = structuredClone(rawDecoder);
              rawDecodeProvenance = structuredClone(rawDecode);
            }
            if (rawLens) {
              if (lensProvenance && JSON.stringify(lensProvenance) !== JSON.stringify(rawLens)) {
                throw new CameraCalibrationError("CAPTURE_PROVENANCE_CHANGED", "Lens provenance changed during calibration");
              }
              lensProvenance = structuredClone(rawLens);
            }
            if (rawPipeline) {
              if (pipelineProvenance && JSON.stringify(pipelineProvenance) !== JSON.stringify(rawPipeline)) {
                throw new CameraCalibrationError("CAPTURE_PROVENANCE_CHANGED", "Camera pipeline provenance changed during calibration");
              }
              pipelineProvenance = structuredClone(rawPipeline);
            }
            physicalCaptures.push({
              id: expectedCaptureId,
              stepId: step.id,
              repeat,
              outputId: step.outputId,
              passId: step.passId,
              exposureProfileId: profileId,
              referenceKind,
              capturedAt: rawCapture?.capturedAt,
              ...(physicalRawRequired ? { sourceSha256, rasterSha256 } : {}),
              exposure: structuredClone(step.exposure),
              frame: {
                width: rawCapture?.width,
                height: rawCapture?.height,
                pixelFormat: rawCapture?.pixelFormat,
                bitDepth: rawCapture?.bitDepth,
                linearized: rawCapture?.linearized,
              },
              conditionsVerified: Boolean(conditionVerification),
              conditionVerification,
            });
            const enrichedCapture = {
              id: expectedCaptureId,
              adapterCaptureId: rawCapture?.id == null ? null : String(rawCapture.id),
              stepId: step.id,
              outputId: step.outputId,
              repeat,
              capturedAt: rawCapture?.capturedAt,
              width: rawCapture?.width,
              height: rawCapture?.height,
              pixelFormat: rawCapture?.pixelFormat,
              bitDepth: rawCapture?.bitDepth,
              linearized: rawCapture?.linearized,
              data: rawCapture?.data,
              passId: step.passId || null,
              exposureProfileId: profileId,
              exposureSettings: activeCameraLock.applied,
              exposure: {
                normalizationScale: exposureNormalizationScale(plan, step, rawCapture),
              },
              referenceKind,
            };
            accumulator.add(boundCalibrationCapture(enrichedCapture, {
              ...capturePolicy,
              preserveRadiometricRgb,
            }));
          }
          const stackedCapture = accumulator.finish({ step });
          retainedCaptureBytes += stackedCapture.boundedCapture.retainedByteLength;
          if (retainedCaptureBytes > this.maxSessionCaptureBytes) {
            throw new CameraCalibrationError(
              "CALIBRATION_CAPTURE_MEMORY_BUDGET_EXCEEDED",
              "Camera adapter exceeded the bounded calibration-session memory budget",
              { retainedCaptureBytes, maxSessionCaptureBytes: this.maxSessionCaptureBytes },
            );
          }
          captures.push(stackedCapture);
          captureStacks.push({
            id: stackedCapture.id,
            stepId: step.id,
            method: stackedCapture.robustStack.method,
            channels: step.retention.channels,
            sourceCaptureIds: [...stackedCapture.sourceCaptureIds],
            statistics: [...step.retention.statistics],
            groupCounts: [...stackedCapture.robustStack.groupCounts],
            groupSpreadP95: stackedCapture.robustStack.groupSpreadP95,
          });
        }
        this.#event(plan, CAMERA_CALIBRATION_EVENT.STEP_COMPLETE, { stepId: step.id });
      }

      const completedAt = this.now();
      const captureProvenance = physicalRawRequired && lensProvenance && pipelineProvenance
        && decoderProvenance && rawDecodeProvenance ? {
        version: 2,
        device: camera,
        lens: lensProvenance,
        pipeline: pipelineProvenance,
        decoder: decoderProvenance,
        rawDecode: rawDecodeProvenance,
        colorCharacterization: {
          status: "uncharacterized",
          method: "none",
          targetColorSpace: null,
          profileSha256: null,
          characterizedAt: null,
          matrixRgbToXyz: null,
          maximumDeltaE: null,
        },
        exposureProfiles: structuredClone(plan.exposureProfiles),
        expectedCaptureIds: physicalCaptures.map((capture) => capture.id),
        captures: physicalCaptures,
        stacks: captureStacks,
      } : null;
      const candidate = await this.solver.solve({
        plan,
        captures,
        camera,
        cameraLock,
        captureProvenance,
        startedAt: this.session.startedAt,
        completedAt,
        signal,
      });
      checkCancelled();
      this.#event(plan, CAMERA_CALIBRATION_EVENT.SOLVED, { manifest: candidate });
      const manifest = normalizeCameraCalibrationManifest(candidate, { plan });
      this.#event(plan, CAMERA_CALIBRATION_EVENT.MANIFEST_VALID, { manifest });
      const restored = await this.patternAdapter.completeCalibration({ plan, manifest });
      if (restored?.restored !== true || restored?.mode !== "content") {
        throw new CameraCalibrationError("CONTENT_RESTORE_FAILED", "Pattern adapter did not restore the Arena composition");
      }
      overrideActive = false;
      this.#event(plan, CAMERA_CALIBRATION_EVENT.CONTENT_RESTORED);
      return {
        session: this.session,
        manifest,
        captureCount: capturePolicy.captureCount,
        retainedCaptureBytes,
        captureMemory: {
          retainedCaptureBytes,
          estimatedRetainedBytes: capturePolicy.estimatedRetainedBytes,
          estimatedActiveStackBytes: capturePolicy.estimatedActiveStackBytes,
          estimatedMaximumBytes: capturePolicy.estimatedMaximumBytes,
          maxSessionCaptureBytes: this.maxSessionCaptureBytes,
        },
      };
    } catch (error) {
      const failure = error instanceof CameraCalibrationError
        ? error
        : new CameraCalibrationError("CALIBRATION_FAILED", error?.message || "Calibration failed");
      let failClosedError = null;
      if (overrideActive) {
        try {
          await this.patternAdapter.failClosed({ plan, reason: failure });
        } catch (blankError) {
          failClosedError = blankError?.message || String(blankError);
        }
      }
      if (![CAMERA_CALIBRATION_STATE.COMPLETE, CAMERA_CALIBRATION_STATE.CANCELLED].includes(this.session.state)) {
        if (failure.code === "CALIBRATION_CANCELLED") {
          this.#event(plan, CAMERA_CALIBRATION_EVENT.CANCEL);
        } else {
          const failureDetails = failure.details && typeof failure.details === "object" && !Array.isArray(failure.details)
            ? failure.details
            : failure.details == null ? {} : { causeDetails: failure.details };
          this.#event(plan, CAMERA_CALIBRATION_EVENT.FAIL, {
            code: failure.code,
            message: failure.message,
            details: { ...failureDetails, ...(failClosedError ? { failClosedError } : {}) },
          });
        }
      }
      failure.session = this.session;
      throw failure;
    } finally {
      if (cameraOpened) await this.cameraAdapter.close();
    }
  }
}
