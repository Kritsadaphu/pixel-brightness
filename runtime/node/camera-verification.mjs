import { randomUUID } from "node:crypto";

import {
  buildWarpMeshFromCameraMap,
  decodeGrayCodeFrames,
  requiredGrayBits,
} from "../shared/calibration.mjs";
import {
  CameraCalibrationError,
  normalizeCameraDescriptor,
  normalizeManualCameraSettings,
  verifyManualCameraLock,
} from "../shared/camera-calibration.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_STATE,
  CameraOpticalVerificationError,
  createCameraOpticalVerificationOperatorPrompt,
  createCameraOpticalVerificationState,
  evaluateCameraOpticalVerification,
  normalizeCameraOpticalVerificationConfirmation,
  normalizeCameraOpticalVerificationPlan,
  normalizeCameraOpticalVerificationReport,
  normalizeCameraOpticalVerificationState,
} from "../shared/camera-verification.mjs";
import {
  FileCalibrationArtifactResolver,
  cameraTargetMeshForOutput,
  scatterCameraMapToProjector,
} from "./camera-calibration.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const DEFAULT_ANALYSIS_PIXELS = 1_048_576;
const DEFAULT_RUN_DEADLINE_MS = 45 * 60 * 1_000;
const MAX_CAMERA_HELPER_CLOCK_SKEW_MS = 30_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function runtimeError(code, message, details = null) {
  return new CameraOpticalVerificationError(code, message, details == null ? undefined : details);
}

function canonicalIso(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value) {
    throw runtimeError("INVALID_OPTICAL_VERIFICATION_EVIDENCE", `${field} must be a canonical UTC instant`);
  }
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value)));
}

function percentile(values, fraction, fallback = 0) {
  const sorted = Array.from(values, Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return fallback;
  const position = clamp(fraction) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, lower + 1);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

function mean(values) {
  if (!values?.length) return 0;
  let total = 0;
  for (const value of values) total += Number(value);
  return total / values.length;
}

function standardDeviation(values) {
  if (!values?.length || values.length < 2) return 0;
  const average = mean(values);
  let sum = 0;
  for (const value of values) sum += (Number(value) - average) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

function vectorMean(values) {
  if (!values?.length) return [0, 0, 0];
  return [0, 1, 2].map((channel) => mean(values.map((value) => value[channel])));
}

function finiteMetric(value, fallback = 1e6, minimum = 0, maximum = 1e6) {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function normalizedCamera(input) {
  try {
    return normalizeCameraDescriptor(input);
  } catch (error) {
    throw runtimeError(
      "OPTICAL_VERIFICATION_CAMERA_MISMATCH",
      error?.message || "Camera descriptor is invalid",
    );
  }
}

function exactCamera(actual, expected, field) {
  const normalized = normalizedCamera(actual);
  if (canonicalJson(normalized) !== canonicalJson(expected)) {
    throw runtimeError(
      "OPTICAL_VERIFICATION_CAMERA_MISMATCH",
      `${field} does not match the authoritative verification body`,
      { actual: normalized, expected },
    );
  }
  return normalized;
}

function lensEvidence(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    vendor: String(value.vendor ?? value.manufacturer ?? ""),
    model: String(value.model ?? ""),
    serial: String(value.serial ?? value.serialNumber ?? ""),
    focalLengthMm: Number(value.focalLengthMm),
    apertureF: Number(value.apertureF ?? value.apertureFNumber),
    focusDistanceM: Number(value.focusDistanceM),
    focusLocked: value.focusLocked === true,
    zoomLocked: value.zoomLocked === true,
    stabilization: String(value.stabilization ?? ""),
  };
}

function pipelineEvidence(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    captureMode: String(value.captureMode ?? ""),
    shutterMode: String(value.shutterMode ?? ""),
    rawEncoding: String(value.rawEncoding ?? ""),
    sourcePixelFormat: String(value.sourcePixelFormat ?? ""),
    retainedPixelFormat: String(value.retainedPixelFormat ?? ""),
    bitDepth: Number(value.bitDepth),
    linearized: value.linearized === true,
    blackLevelSubtracted: value.blackLevelSubtracted === true,
    whiteBalanceApplied: value.whiteBalanceApplied === true,
    toneCurveApplied: value.toneCurveApplied === true,
    noiseReductionApplied: value.noiseReductionApplied === true,
    lensCorrectionsApplied: value.lensCorrectionsApplied === true,
  };
}

function validateLens(lens, plan) {
  const expected = plan.lensProfile;
  const focusTolerance = Math.max(0.02, expected.capture.focusDistanceM * 0.02);
  if (lens.vendor !== expected.lens.manufacturer
    || lens.model !== expected.lens.model
    || lens.serial !== expected.lens.serialNumber
    || Math.abs(lens.focalLengthMm - expected.capture.focalLengthMm) > 0.05
    || Math.abs(lens.apertureF - expected.capture.apertureFNumber) > 0.05
    || Math.abs(lens.focusDistanceM - expected.capture.focusDistanceM) > focusTolerance
    || lens.focusLocked !== true
    || lens.zoomLocked !== true
    || lens.stabilization !== "off") {
    throw runtimeError(
      "OPTICAL_VERIFICATION_LENS_MISMATCH",
      "Captured lens provenance changed from the fixed calibrated lens profile",
      { lens, lensProfileSha256: expected.sha256 },
    );
  }
  return lens;
}

function validatePipeline(pipeline, plan) {
  const expected = plan.expectedPipeline;
  if (pipeline.captureMode !== expected.captureMode
    || !expected.shutterModes.includes(pipeline.shutterMode)
    || !expected.rawEncodings.includes(pipeline.rawEncoding)
    || pipeline.retainedPixelFormat !== expected.retainedPixelFormat
    || pipeline.bitDepth !== expected.bitDepth
    || pipeline.linearized !== true
    || pipeline.blackLevelSubtracted !== false
    || pipeline.whiteBalanceApplied !== false
    || pipeline.toneCurveApplied !== false
    || pipeline.noiseReductionApplied !== false
    || pipeline.lensCorrectionsApplied !== false) {
    throw runtimeError(
      "OPTICAL_VERIFICATION_PIPELINE_MISMATCH",
      "Capture did not use the required uncorrected linear 14-bit RAW pipeline",
      { pipeline },
    );
  }
  return pipeline;
}

function conditionVerification(step, confirmation) {
  return {
    projectorState: step.captureConditions.projectorState,
    opticalPath: step.captureConditions.opticalPath,
    otherProjectors: step.captureConditions.otherProjectors,
    method: "canonical-operator-confirmation",
    verifiedAt: confirmation.confirmedAt,
    confirmationLeaseId: confirmation.confirmationLeaseId,
    confirmationId: confirmation.confirmationId,
  };
}

function confirmationEvidence(plan, transports) {
  const scopes = [];
  for (const step of plan.steps) {
    const leaseId = step.captureConditions.confirmationLeaseId;
    const current = scopes.at(-1);
    if (current?.confirmationLeaseId === leaseId) {
      current.lastStepId = step.id;
      current.stepCount += 1;
    } else {
      scopes.push({
        confirmationLeaseId: leaseId,
        firstStepId: step.id,
        lastStepId: step.id,
        stepCount: 1,
      });
    }
  }
  if (transports.length !== scopes.length) {
    throw runtimeError(
      "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
      "Terminal verification evidence is missing an exact Server confirmation command",
    );
  }
  return scopes.map((scope, index) => {
    const transport = transports[index];
    if (transport.confirmation.confirmationLeaseId !== scope.confirmationLeaseId) {
      throw runtimeError(
        "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
        "Server confirmation command order does not match the physical-condition leases",
      );
    }
    return {
      confirmationId: transport.confirmation.confirmationId,
      confirmationLeaseId: scope.confirmationLeaseId,
      firstStepId: scope.firstStepId,
      lastStepId: scope.lastStepId,
      stepCount: scope.stepCount,
      confirmedAt: transport.confirmation.confirmedAt,
      serverCommandId: transport.serverCommandId,
      serverCommandSequence: transport.serverCommandSequence,
    };
  });
}

function pointInsidePolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, prior = polygon.length - 1; index < polygon.length; prior = index++) {
    const currentPoint = polygon[index];
    const priorPoint = polygon[prior];
    const intersects = ((currentPoint.y > y) !== (priorPoint.y > y))
      && x < (priorPoint.x - currentPoint.x) * (y - currentPoint.y)
        / ((priorPoint.y - currentPoint.y) || Number.EPSILON) + currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonArea(polygon) {
  let doubled = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    doubled += current.x * next.y - current.y * next.x;
  }
  return Math.abs(doubled) / 2;
}

function polygonAnalysisWidth(polygon, shape) {
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  return Math.min(
    (Math.max(...xs) - Math.min(...xs)) * shape.width,
    (Math.max(...ys) - Math.min(...ys)) * shape.height,
  );
}

function analysisDimensions(width, height, maximumPixels) {
  const pixels = width * height;
  if (pixels <= maximumPixels) return { width, height };
  const scale = Math.sqrt(maximumPixels / pixels);
  return {
    width: Math.max(2, Math.floor(width * scale)),
    height: Math.max(2, Math.floor(height * scale)),
  };
}

function sampleRaster(capture, shape, corners = null) {
  const luma = new Float32Array(shape.width * shape.height);
  const sums = [0, 0, 0];
  const regionSums = [0, 0, 0];
  let clipped = 0;
  let regionClipped = 0;
  let regionCount = 0;
  let count = 0;
  for (let y = 0; y < shape.height; y += 1) {
    const sourceY = Math.min(capture.height - 1, Math.floor((y + 0.5) * capture.height / shape.height));
    for (let x = 0; x < shape.width; x += 1) {
      const sourceX = Math.min(capture.width - 1, Math.floor((x + 0.5) * capture.width / shape.width));
      const source = (sourceY * capture.width + sourceX) * 3;
      const target = y * shape.width + x;
      const red = Number(capture.data[source]);
      const green = Number(capture.data[source + 1]);
      const blue = Number(capture.data[source + 2]);
      sums[0] += red;
      sums[1] += green;
      sums[2] += blue;
      clipped += red >= 0.999 || green >= 0.999 || blue >= 0.999 ? 1 : 0;
      luma[target] = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const u = (x + 0.5) / shape.width;
      const v = (y + 0.5) / shape.height;
      if (!corners || pointInsidePolygon(u, v, corners)) {
        regionSums[0] += red;
        regionSums[1] += green;
        regionSums[2] += blue;
        regionClipped += red >= 0.999 || green >= 0.999 || blue >= 0.999 ? 1 : 0;
        regionCount += 1;
      }
      count += 1;
    }
  }
  return {
    luma,
    meanRgb: sums.map((value) => value / Math.max(1, count)),
    clippedFraction: clipped / Math.max(1, count),
    region: {
      meanRgb: regionSums.map((value) => value / Math.max(1, regionCount)),
      clippedFraction: regionClipped / Math.max(1, regionCount),
      sampleCount: regionCount,
    },
  };
}

class MapAccumulator {
  constructor(length) {
    this.count = 0;
    this.mean = new Float64Array(length);
    this.m2 = new Float64Array(length);
  }

  add(values) {
    if (values.length !== this.mean.length) throw runtimeError("INVALID_CAMERA_FRAME", "Analysis raster changed dimensions");
    this.count += 1;
    for (let index = 0; index < values.length; index += 1) {
      const delta = Number(values[index]) - this.mean[index];
      this.mean[index] += delta / this.count;
      this.m2[index] += delta * (Number(values[index]) - this.mean[index]);
    }
  }

  standardError(index) {
    if (this.count < 2) return 0;
    return Math.sqrt(Math.max(0, this.m2[index] / (this.count - 1)) / this.count);
  }
}

function parseWarp(bytes, artifact, outputId) {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw runtimeError("OPTICAL_VERIFICATION_BASELINE_INVALID", `Baseline warp for ${outputId} is invalid JSON`, {
      cause: error.message,
    });
  }
  if (value?.columns !== artifact.columns || value?.rows !== artifact.rows
    || !Array.isArray(value?.points) || value.points.length !== artifact.pointCount) {
    throw runtimeError("OPTICAL_VERIFICATION_BASELINE_INVALID", `Baseline warp for ${outputId} does not match its manifest`);
  }
  const points = value.points.map((point) => ({
    u: Number(point.u),
    v: Number(point.v),
    x: Number(point.x),
    y: Number(point.y),
  }));
  if (points.some((point) => Object.values(point).some((entry) => !Number.isFinite(entry)))) {
    throw runtimeError("OPTICAL_VERIFICATION_BASELINE_INVALID", `Baseline warp for ${outputId} contains non-finite points`);
  }
  return { columns: value.columns, rows: value.rows, points };
}

/**
 * Bounded production metric extractor. Full camera rasters are never retained:
 * every RAW-derived frame is sampled once into a capped analysis raster, Gray
 * pairs are released after their output is decoded, and baseline artifacts are
 * accepted only after local path, byte-length and SHA-256 verification.
 */
export class MeasuredCameraOpticalVerificationSolver {
  constructor({ artifactRoot = null, maxAnalysisPixels = DEFAULT_ANALYSIS_PIXELS } = {}) {
    this.artifacts = new FileCalibrationArtifactResolver({ root: artifactRoot });
    this.maxAnalysisPixels = Math.max(65_536, Math.min(4_194_304, Math.round(Number(maxAnalysisPixels) || 0)));
  }

  async begin({ plan, baselineManifest }) {
    if (!baselineManifest || baselineManifest.sessionId !== plan.calibrationSessionId
      || baselineManifest.applicable !== true || baselineManifest.provenance !== "measured"
      || baselineManifest.lensProfile?.sha256 !== plan.lensProfile.sha256) {
      throw runtimeError(
        "OPTICAL_VERIFICATION_BASELINE_INVALID",
        "Optical verification requires the exact applicable measured calibration manifest and lens profile",
      );
    }
    const baselineCamera = baselineManifest.captureProvenance?.device || baselineManifest.camera;
    exactCamera(baselineCamera, plan.camera, "Calibration baseline camera");
    this.plan = plan;
    this.shape = analysisDimensions(
      plan.lensProfile.frame.width,
      plan.lensProfile.frame.height,
      this.maxAnalysisPixels,
    );
    this.baselineWarps = new Map();
    for (const output of plan.outputs) {
      const baseline = baselineManifest.outputs?.find((candidate) => candidate.outputId === output.id);
      const blackBaseline = plan.blackFloorBaselines.find((candidate) => candidate.outputId === output.id);
      const exposureBridge = baseline?.radiometry?.measuredExposureNormalization;
      const artifact = baseline?.artifacts?.warp;
      if (!baseline || baseline.geometry?.status !== "passed" || baseline.geometry?.lensProfileSha256 !== plan.lensProfile.sha256
        || !artifact || artifact.columns !== plan.mesh.columns || artifact.rows !== plan.mesh.rows) {
        throw runtimeError(
          "OPTICAL_VERIFICATION_BASELINE_INVALID",
          `Calibration baseline for ${output.id} is missing exact passed markerless geometry`,
        );
      }
      if (!blackBaseline
        || baselineManifest.schemaVersion !== blackBaseline.sourceManifestSchemaVersion
        || baseline.artifacts?.blackPedestal?.sha256 !== blackBaseline.blackPedestalSha256
        || baseline.radiometry?.black?.target !== blackBaseline.targetLevel
        || exposureBridge?.bridgeId !== blackBaseline.exposureBridgeId
        || exposureBridge?.longProfileId !== blackBaseline.exposureProfileId
        || exposureBridge?.nominalScale !== blackBaseline.normalizationScale
        || exposureBridge?.measuredScaleLuma !== blackBaseline.measuredNormalizationScale
        || exposureBridge?.uncertaintyLuma !== blackBaseline.normalizationRelativeUncertainty
        || exposureBridge?.status !== blackBaseline.exposureBridgeStatus
        || exposureBridge?.gates?.passed !== blackBaseline.exposureBridgeGatesPassed) {
        throw runtimeError(
          "OPTICAL_VERIFICATION_BASELINE_INVALID",
          `Calibration black-floor baseline for ${output.id} does not match its immutable manifest binding`,
        );
      }
      this.baselineWarps.set(output.id, parseWarp(await this.artifacts.read(artifact), artifact, output.id));
    }
    this.stepStats = new Map();
    this.mapAccumulators = new Map();
    this.gray = new Map();
    this.geometry = new Map();
    this.white = new Map();
  }

  #statsKey(step) {
    return step.id;
  }

  #mapKey(step) {
    return `${step.purpose}:${step.exposureProfileId}`;
  }

  #outputForStep(step) {
    return step.outputId == null ? null : this.plan.outputs.find((output) => output.id === step.outputId) || null;
  }

  #recordGray(step, sample) {
    let record = this.gray.get(step.outputId);
    if (!record) {
      record = { x: { normal: [], inverse: [] }, y: { normal: [], inverse: [] } };
      this.gray.set(step.outputId, record);
    }
    const bytes = Uint8Array.from(sample.luma, (value) => Math.round(clamp(value, 0, 1) * 255));
    const bucket = step.pattern.inverse ? record[step.pattern.axis].inverse : record[step.pattern.axis].normal;
    bucket[step.pattern.bit] = bytes;
  }

  #recordMap(step, sample) {
    const key = this.#mapKey(step);
    let accumulator = this.mapAccumulators.get(key);
    if (!accumulator) {
      accumulator = new MapAccumulator(sample.luma.length);
      this.mapAccumulators.set(key, accumulator);
    }
    accumulator.add(sample.luma);
  }

  #finishGeometry(output) {
    if (this.geometry.has(output.id)) return;
    const record = this.gray.get(output.id);
    const white = this.white.get(output.id);
    if (!record || !white) {
      throw runtimeError("OPTICAL_VERIFICATION_GEOMETRY_INCOMPLETE", `Gray/white recapture is incomplete for ${output.id}`);
    }
    const decoded = {};
    for (const axis of ["x", "y"]) {
      const bits = requiredGrayBits(axis === "x" ? output.resolution.width : output.resolution.height);
      if (record[axis].normal.length !== bits || record[axis].inverse.length !== bits
        || record[axis].normal.some((frame) => !frame) || record[axis].inverse.some((frame) => !frame)) {
        throw runtimeError("OPTICAL_VERIFICATION_GEOMETRY_INCOMPLETE", `Gray ${axis} pairs are incomplete for ${output.id}`);
      }
      decoded[axis] = decodeGrayCodeFrames({
        normalFrames: record[axis].normal,
        inverseFrames: record[axis].inverse,
        width: this.shape.width,
        height: this.shape.height,
        threshold: 12,
      });
    }
    const confidence = Float32Array.from(
      decoded.x.confidence,
      (value, index) => Math.min(value, decoded.y.confidence[index]),
    );
    const targetMesh = cameraTargetMeshForOutput({
      plan: this.plan,
      output,
      cameraWidth: this.plan.lensProfile.frame.width,
      cameraHeight: this.plan.lensProfile.frame.height,
      fallbackCorners: output.surfaceTarget.corners,
    });
    const warp = buildWarpMeshFromCameraMap({
      cameraWidth: this.shape.width,
      cameraHeight: this.shape.height,
      projectorWidth: output.resolution.width,
      projectorHeight: output.resolution.height,
      projectorX: decoded.x.codes,
      projectorY: decoded.y.codes,
      confidence,
      targetMesh,
      minimumConfidence: this.plan.mesh.minimumConfidence,
      maxSearchRadius: Math.max(this.shape.width, this.shape.height),
      allowHoles: true,
    });
    const baseline = this.baselineWarps.get(output.id);
    if (baseline.points.length !== warp.points.length) {
      throw runtimeError("OPTICAL_VERIFICATION_BASELINE_INVALID", `Baseline mesh point count changed for ${output.id}`);
    }
    const drift = warp.points.map((point, index) => {
      if (point.confidence <= 0) return 1e6;
      const prior = baseline.points[index];
      return Math.hypot(
        (point.x - prior.x) * Math.max(1, output.resolution.width - 1),
        (point.y - prior.y) * Math.max(1, output.resolution.height - 1),
      );
    });
    const dark = this.mapAccumulators.get(`sensor-dark:${this.plan.exposureProfiles.find((profile) => profile.role === "geometry").id}`);
    const darkMean = dark ? mean(dark.mean) : 0;
    const sampleMask = Uint8Array.from(white.luma, (value, index) => (
      decoded.x.codes[index] >= 0 && decoded.y.codes[index] >= 0
        && confidence[index] >= this.plan.mesh.minimumConfidence
        && Number(value) - darkMean > 0.01 ? 1 : 0
    ));
    const coverage = scatterCameraMapToProjector({
      values: Float32Array.from(sampleMask, Number),
      cameraWidth: this.shape.width,
      cameraHeight: this.shape.height,
      projectorWidth: output.resolution.width,
      projectorHeight: output.resolution.height,
      projectorX: decoded.x.codes,
      projectorY: decoded.y.codes,
      confidence,
      sampleMask,
      minimumConfidence: this.plan.mesh.minimumConfidence,
      returnMetadata: true,
    }).coverage;
    const fullScale = Math.max(
      this.plan.lensProfile.frame.width / this.shape.width,
      this.plan.lensProfile.frame.height / this.shape.height,
    );
    this.geometry.set(output.id, {
      outputId: output.id,
      holes: warp.holes,
      confidence: finiteMetric(warp.confidence, 0, 0, 1),
      targetResidualP95Px: finiteMetric(warp.searchDistancePx.p95 == null ? 1e6 : warp.searchDistancePx.p95 * fullScale),
      targetResidualMaxPx: finiteMetric(warp.searchDistancePx.max == null ? 1e6 : warp.searchDistancePx.max * fullScale),
      projectorDriftP95Px: finiteMetric(percentile(drift, 0.95, 1e6)),
      projectorDriftMaxPx: finiteMetric(percentile(drift, 1, 1e6)),
      pixelCoverage: finiteMetric(coverage.pixelRatio, 0, 0, 1),
      tileCoverage: finiteMetric(coverage.tileRatio, 0, 0, 1),
      clippedFraction: finiteMetric(white.clippedFraction, 1, 0, 1),
    });
    this.gray.delete(output.id);
    this.white.delete(output.id);
  }

  async consumeCapture({ step, capture }) {
    const output = this.#outputForStep(step);
    if (output && !this.geometry.has(output.id) && step.purpose.startsWith("corrected-")) {
      this.#finishGeometry(output);
    }
    const sample = sampleRaster(capture, this.shape, output?.surfaceTarget?.corners || null);
    const stats = sample.region;
    const key = this.#statsKey(step);
    const entries = this.stepStats.get(key) || [];
    entries.push(stats);
    this.stepStats.set(key, entries);
    if (step.purpose === "geometry-white") {
      this.white.set(step.outputId, {
        luma: sample.luma,
        clippedFraction: sample.clippedFraction,
      });
    } else if (step.purpose === "geometry-gray-code") {
      this.#recordGray(step, sample);
    }
    if (step.purpose === "sensor-dark"
      || step.purpose === "global-corrected-black-short"
      || step.purpose === "global-corrected-neutral-018"
      || step.purpose === "global-corrected-black-long") {
      this.#recordMap(step, sample);
    }
  }

  #step(outputId, purpose) {
    return this.plan.steps.find((step) => step.outputId === outputId && step.purpose === purpose)
      || this.plan.steps.find((step) => step.outputId == null && step.purpose === purpose)
      || null;
  }

  #stats(outputId, purpose) {
    const step = this.#step(outputId, purpose);
    const entries = step ? this.stepStats.get(step.id) || [] : [];
    if (entries.length !== step?.repeats) {
      throw runtimeError("OPTICAL_VERIFICATION_CAPTURE_INCOMPLETE", `Capture stack is incomplete for ${purpose}`);
    }
    return {
      step,
      entries,
      meanRgb: vectorMean(entries.map((entry) => entry.meanRgb)),
      clippedFraction: Math.max(...entries.map((entry) => entry.clippedFraction)),
      sampleCount: Math.min(...entries.map((entry) => entry.sampleCount)),
    };
  }

  #radiometry(output) {
    const blackShort = this.#stats(output.id, "corrected-black-short");
    const neutral018 = this.#stats(output.id, "corrected-neutral-018");
    const neutral050 = this.#stats(output.id, "corrected-neutral-050");
    const red = this.#stats(output.id, "corrected-primary-red");
    const green = this.#stats(output.id, "corrected-primary-green");
    const blue = this.#stats(output.id, "corrected-primary-blue");
    const blackLong = this.#stats(output.id, "corrected-black-long");
    const nearBlack = this.#stats(output.id, "corrected-near-black");
    const shortScale = this.plan.exposureProfiles.find((profile) => profile.id === neutral050.step.exposureProfileId).normalizationScale;
    const longScale = this.plan.exposureProfiles.find((profile) => profile.id === nearBlack.step.exposureProfileId).normalizationScale;
    const response = (value, black, scale) => value.map((channel, index) => (channel - black[index]) / scale);
    const response018 = response(neutral018.meanRgb, blackShort.meanRgb, shortScale);
    const response050 = response(neutral050.meanRgb, blackShort.meanRgb, shortScale);
    const responseNear = response(nearBlack.meanRgb, blackLong.meanRgb, longScale);
    const neutralExpected = 0.18 / 0.5;
    const nearExpected = this.plan.lowLevel / 0.5;
    const neutralRatioRelativeErrorRgb = response018.map((value, index) => finiteMetric(
      Math.abs(value / Math.max(1e-12, response050[index]) / neutralExpected - 1),
    ));
    const nearBlackRelativeErrorRgb = responseNear.map((value, index) => finiteMetric(
      Math.abs(value / Math.max(1e-12, response050[index]) / nearExpected - 1),
    ));
    const primaryMeasurements = [red, green, blue].map((stack) => response(stack.meanRgb, blackShort.meanRgb, shortScale)
      .map((value, channel) => value / Math.max(1e-12, response050[channel])));
    const primaryErrors = primaryMeasurements.flatMap((channels, primary) => channels.map(
      (value, channel) => Math.abs(value - (primary === channel ? 1 : 0)),
    ));
    const repeatSignal = (stack, black, scale) => stack.entries.map((entry) => mean(response(entry.meanRgb, black.meanRgb, scale)));
    const normalSignals = repeatSignal(neutral050, blackShort, shortScale);
    const nearSignals = repeatSignal(nearBlack, blackLong, longScale);
    const snr = (values) => finiteMetric(
      20 * Math.log10(Math.max(1e-12, Math.abs(mean(values))) / Math.max(1e-15, standardDeviation(values))),
      300,
      -100,
      300,
    );
    const uncertainty = (values) => standardDeviation(values) / Math.sqrt(Math.max(1, values.length))
      / Math.max(1e-12, Math.abs(mean(values)));
    return {
      outputId: output.id,
      coverage: this.geometry.get(output.id).pixelCoverage,
      clippedFraction: finiteMetric(Math.max(
        neutral018.clippedFraction,
        neutral050.clippedFraction,
        red.clippedFraction,
        green.clippedFraction,
        blue.clippedFraction,
        nearBlack.clippedFraction,
      ), 1, 0, 1),
      normalSnrDb: snr(normalSignals),
      nearBlackSnrDb: snr(nearSignals),
      relativeUncertainty: finiteMetric(Math.max(uncertainty(normalSignals), uncertainty(nearSignals)), 1, 0, 1),
      neutralRatioRelativeErrorRgb,
      nearBlackRelativeErrorRgb,
      primaryRmse: finiteMetric(Math.sqrt(mean(primaryErrors.map((value) => value ** 2)))),
      primaryMaxError: finiteMetric(Math.max(...primaryErrors)),
    };
  }

  #combined() {
    const geometryProfile = this.plan.exposureProfiles.find((profile) => profile.role === "geometry");
    const dark = this.mapAccumulators.get(`sensor-dark:${geometryProfile.id}`);
    const black = this.mapAccumulators.get(`global-corrected-black-short:${geometryProfile.id}`);
    const neutral = this.mapAccumulators.get(`global-corrected-neutral-018:${geometryProfile.id}`);
    if (!dark || !black || !neutral || dark.mean.length !== black.mean.length || black.mean.length !== neutral.mean.length) {
      throw runtimeError("OPTICAL_VERIFICATION_CAPTURE_INCOMPLETE", "Global black/neutral evidence is incomplete");
    }
    const blackValues = [];
    const uncertainties = [];
    let negative = 0;
    const masks = this.plan.outputs.map((output) => output.surfaceTarget.corners);
    for (let y = 0; y < this.shape.height; y += 1) {
      for (let x = 0; x < this.shape.width; x += 1) {
        const u = (x + 0.5) / this.shape.width;
        const v = (y + 0.5) / this.shape.height;
        if (!masks.some((corners) => pointInsidePolygon(u, v, corners))) continue;
        const index = y * this.shape.width + x;
        const value = black.mean[index] - dark.mean[index];
        const uncertainty = Math.hypot(black.standardError(index), dark.standardError(index));
        blackValues.push(value);
        uncertainties.push(uncertainty);
        if (value < -3 * Math.max(1e-12, uncertainty)) negative += 1;
      }
    }
    const surfaceSignals = this.plan.outputs.map((output) => {
      const values = [];
      for (let y = 0; y < this.shape.height; y += 1) {
        for (let x = 0; x < this.shape.width; x += 1) {
          const u = (x + 0.5) / this.shape.width;
          const v = (y + 0.5) / this.shape.height;
          if (!pointInsidePolygon(u, v, output.surfaceTarget.corners)) continue;
          const index = y * this.shape.width + x;
          values.push(neutral.mean[index] - black.mean[index]);
        }
      }
      return mean(values) / 0.18;
    });
    const center = percentile(surfaceSignals, 0.5, 0);
    const seamResiduals = surfaceSignals.map((value) => Math.abs(value - center));
    return {
      blackUncertaintyP95: finiteMetric(percentile(uncertainties, 0.95, 1), 1, 0, 1),
      blackNonuniformityRange: finiteMetric(
        percentile(blackValues, 0.95, 1) - percentile(blackValues, 0.05, 0),
        1,
        0,
        1,
      ),
      negativeBeyondUncertaintyFraction: finiteMetric(negative / Math.max(1, blackValues.length), 1, 0, 1),
      seamResidualP95: finiteMetric(percentile(seamResiduals, 0.95, 1)),
      seamResidualMax: finiteMetric(percentile(seamResiduals, 1, 1)),
    };
  }

  #blackFloor() {
    const profile = this.plan.exposureProfiles.find((candidate) => candidate.role === "radiometry");
    const dark = this.mapAccumulators.get(`sensor-dark:${profile.id}`);
    const black = this.mapAccumulators.get(`global-corrected-black-long:${profile.id}`);
    if (!dark || !black || dark.mean.length !== black.mean.length) {
      throw runtimeError(
        "OPTICAL_VERIFICATION_CAPTURE_INCOMPLETE",
        "Long-exposure global black-floor evidence is incomplete",
      );
    }
    const observation = ({
      polygons,
      targetLevel,
      measuredNormalizationScale,
      normalizationRelativeUncertainty,
      outputBinding = null,
    }) => {
      const values = [];
      const uncertainties = [];
      for (let y = 0; y < this.shape.height; y += 1) {
        for (let x = 0; x < this.shape.width; x += 1) {
          const u = (x + 0.5) / this.shape.width;
          const v = (y + 0.5) / this.shape.height;
          if (!polygons.some((polygon) => pointInsidePolygon(u, v, polygon))) continue;
          const index = y * this.shape.width + x;
          const value = (black.mean[index] - dark.mean[index]) / measuredNormalizationScale;
          values.push(value);
          uncertainties.push(
            Math.hypot(
              Math.hypot(black.standardError(index), dark.standardError(index)) / measuredNormalizationScale,
              Math.abs(value) * normalizationRelativeUncertainty,
            ),
          );
        }
      }
      if (values.length < 1) {
        throw runtimeError(
          "OPTICAL_VERIFICATION_BLACK_FLOOR_COVERAGE_LOW",
          `Black-floor analysis has no samples for ${outputBinding?.outputId || "the global surface union"}`,
        );
      }
      const observedP95 = clamp(percentile(values, 0.95, 1e3), -1e3, 1e3);
      return {
        ...(outputBinding || {}),
        targetLevel,
        observedP95,
        absoluteDrift: Math.abs(observedP95 - targetLevel),
        uncertaintyP95: clamp(percentile(uncertainties, 0.95, 1e3), 0, 1e3),
        sampleCount: values.length,
      };
    };
    const outputs = this.plan.blackFloorBaselines.map((baseline) => {
      const output = this.plan.outputs.find((candidate) => candidate.id === baseline.outputId);
      return observation({
        polygons: [output.surfaceTarget.corners],
        targetLevel: baseline.targetLevel,
        measuredNormalizationScale: baseline.measuredNormalizationScale,
        normalizationRelativeUncertainty: baseline.normalizationRelativeUncertainty,
        outputBinding: {
          outputId: baseline.outputId,
          blackPedestalSha256: baseline.blackPedestalSha256,
          exposureBridgeId: baseline.exposureBridgeId,
          measuredNormalizationScale: baseline.measuredNormalizationScale,
          normalizationRelativeUncertainty: baseline.normalizationRelativeUncertainty,
        },
      });
    });
    const globalTarget = Math.max(...this.plan.blackFloorBaselines.map((baseline) => baseline.targetLevel));
    return {
      measurementBasis: this.plan.blackFloorBaselines[0].measurementBasis,
      exposureProfileId: profile.id,
      normalizationScale: profile.normalizationScale,
      globalMeasuredNormalizationScale: this.plan.globalMeasuredNormalizationScale,
      globalNormalizationRelativeUncertainty: this.plan.globalNormalizationRelativeUncertainty,
      global: observation({
        polygons: this.plan.outputs.map((output) => output.surfaceTarget.corners),
        targetLevel: globalTarget,
        measuredNormalizationScale: this.plan.globalMeasuredNormalizationScale,
        normalizationRelativeUncertainty: this.plan.globalNormalizationRelativeUncertainty,
      }),
      outputs,
    };
  }

  #overlapBands() {
    const profile = this.plan.exposureProfiles.find((candidate) => candidate.role === "geometry");
    const black = this.mapAccumulators.get(`global-corrected-black-short:${profile.id}`);
    const neutral = this.mapAccumulators.get(`global-corrected-neutral-018:${profile.id}`);
    if (!black || !neutral || black.mean.length !== neutral.mean.length) {
      throw runtimeError(
        "OPTICAL_VERIFICATION_CAPTURE_INCOMPLETE",
        "Global corrected neutral evidence is unavailable for overlap-band analysis",
      );
    }
    const analysisScale = Math.min(
      this.shape.width / this.plan.lensProfile.frame.width,
      this.shape.height / this.plan.lensProfile.frame.height,
    );
    return this.plan.overlapBands.map((band) => {
      const residuals = [];
      for (let y = 0; y < this.shape.height; y += 1) {
        for (let x = 0; x < this.shape.width; x += 1) {
          const u = (x + 0.5) / this.shape.width;
          const v = (y + 0.5) / this.shape.height;
          if (!pointInsidePolygon(u, v, band.cameraPolygon)) continue;
          const index = y * this.shape.width + x;
          const signal = (neutral.mean[index] - black.mean[index]) / band.normalizationScale;
          residuals.push(Math.abs(signal / Math.max(1e-12, band.expectedLevel) - 1));
        }
      }
      const expectedSamples = polygonArea(band.cameraPolygon) * this.shape.width * this.shape.height;
      const analysisBandWidthPx = band.relation.endsWith("shared-edge")
        ? band.cameraBandWidthPx * analysisScale
        : polygonAnalysisWidth(band.cameraPolygon, this.shape);
      return {
        bandId: band.id,
        outputIds: [...band.outputIds],
        relation: band.relation,
        measurementBasis: band.measurementBasis,
        exposureProfileId: band.exposureProfileId,
        normalizationScale: band.normalizationScale,
        expectedLevel: band.expectedLevel,
        sampleCount: residuals.length,
        coverage: clamp(residuals.length / Math.max(1, expectedSamples), 0, 1),
        analysisBandWidthPx: finiteMetric(analysisBandWidthPx, 0),
        boundaryResidualP95: finiteMetric(percentile(residuals, 0.95, 1e6)),
        boundaryResidualMax: finiteMetric(percentile(residuals, 1, 1e6)),
      };
    });
  }

  async solve() {
    for (const output of this.plan.outputs) this.#finishGeometry(output);
    return {
      geometry: this.plan.outputs.map((output) => this.geometry.get(output.id)),
      radiometry: this.plan.outputs.map((output) => this.#radiometry(output)),
      combined: this.#combined(),
      blackFloor: this.#blackFloor(),
      overlapBands: this.#overlapBands(),
    };
  }
}

function cleanFailure(error, fallbackCode = "OPTICAL_VERIFICATION_BLOCKED") {
  const details = error?.details == null
    ? null
    : typeof error.details === "object" ? clone(error.details) : { causeDetails: String(error.details) };
  return {
    code: String(error?.code || fallbackCode).slice(0, 128),
    message: String(error?.message || "Optical verification was blocked").slice(0, 2_048),
    details,
  };
}

function combineAbortSignal(external, timeoutMs) {
  const controller = new AbortController();
  let deadlineExceeded = false;
  const onAbort = () => controller.abort(external?.reason);
  external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineExceeded = true;
    controller.abort(runtimeError(
      "OPTICAL_VERIFICATION_DEADLINE_EXCEEDED",
      `Optical verification exceeded its ${timeoutMs} ms bounded deadline`,
    ));
  }, timeoutMs);
  return {
    signal: controller.signal,
    deadlineExceeded: () => deadlineExceeded,
    close: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Coordinates exact revision, presentation, RAW provenance and metric gates. */
export class CameraOpticalVerificationRunner {
  constructor({
    cameraAdapter,
    patternAdapter,
    solver,
    requestOperatorConfirmation,
    now = () => new Date().toISOString(),
    onTransition = () => {},
    log = () => {},
    maxCaptureBytes = MAX_CAPTURE_BYTES,
    runDeadlineMs = DEFAULT_RUN_DEADLINE_MS,
  } = {}) {
    if (!cameraAdapter || !patternAdapter || !solver || typeof requestOperatorConfirmation !== "function") {
      throw runtimeError(
        "OPTICAL_VERIFICATION_ADAPTER_REQUIRED",
        "Camera, native pattern, measured solver and operator-confirmation adapters are required",
      );
    }
    this.cameraAdapter = cameraAdapter;
    this.patternAdapter = patternAdapter;
    this.solver = solver;
    this.requestOperatorConfirmation = requestOperatorConfirmation;
    this.now = now;
    this.onTransition = onTransition;
    this.log = log;
    this.maxCaptureBytes = Math.max(16 * 1024 * 1024, Math.min(MAX_CAPTURE_BYTES,
      Math.round(Number(maxCaptureBytes) || MAX_CAPTURE_BYTES)));
    this.runDeadlineMs = Math.max(60_000, Math.min(2 * 60 * 60 * 1_000,
      Math.round(Number(runDeadlineMs) || DEFAULT_RUN_DEADLINE_MS)));
    this.lastTimestampMs = null;
  }

  #time(...minimumValues) {
    const current = canonicalIso(this.now(), "verification clock");
    let milliseconds = Date.parse(current);
    if (this.lastTimestampMs != null) milliseconds = Math.max(milliseconds, this.lastTimestampMs);
    for (const value of minimumValues) {
      if (value == null) continue;
      milliseconds = Math.max(milliseconds, Date.parse(canonicalIso(value, "verification timestamp floor")));
    }
    this.lastTimestampMs = milliseconds;
    return new Date(milliseconds).toISOString();
  }

  async #setState(next) {
    this.state = normalizeCameraOpticalVerificationState(next, { plan: this.plan });
    await this.onTransition(clone(this.state));
    return this.state;
  }

  #cancelled(signal, deadlineExceeded) {
    if (!signal.aborted) return;
    if (deadlineExceeded()) {
      throw runtimeError(
        "OPTICAL_VERIFICATION_DEADLINE_EXCEEDED",
        "Optical verification exceeded its bounded deadline",
      );
    }
    throw runtimeError("OPTICAL_VERIFICATION_CANCELLED", "Optical verification was cancelled");
  }

  async #confirmation(step, signal, deadlineExceeded) {
    const requestedAt = this.#time();
    const prompt = createCameraOpticalVerificationOperatorPrompt(this.plan, {
      stepId: step.id,
      confirmationId: randomUUID(),
      requestedAt,
    });
    const waiting = await this.#setState({
      ...this.state,
      state: CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
      progress: {
        ...this.state.progress,
        currentStepId: step.id,
        currentStepIndex: step.sequence,
      },
      operatorPrompt: prompt,
      updatedAt: requestedAt,
    });
    const response = await this.requestOperatorConfirmation({
      plan: this.plan,
      step,
      state: clone(waiting),
      signal,
    });
    this.#cancelled(signal, deadlineExceeded);
    if (!response?.confirmation) {
      throw runtimeError(
        "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
        "Operator confirmation must retain its exact Server command identity",
      );
    }
    const confirmation = normalizeCameraOpticalVerificationConfirmation(
      response.confirmation,
      {
        plan: this.plan,
        state: waiting,
      },
    );
    this.#time(confirmation.confirmedAt);
    const serverCommandId = String(response.serverCommandId || "").trim();
    const serverCommandSequence = Number(response.serverCommandSequence);
    if (!serverCommandId || serverCommandId.length > 128
      || !Number.isSafeInteger(serverCommandSequence) || serverCommandSequence < 1) {
      throw runtimeError(
        "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
        "Operator confirmation transport omitted its exact Server command identity",
      );
    }
    this.confirmationTransports.push({
      confirmation: clone(confirmation),
      serverCommandId,
      serverCommandSequence,
    });
    return confirmation;
  }

  #validateCapture(rawCapture, step, repeat, profile, prior, receivedAtInput) {
    const expectedPixels = this.plan.lensProfile.frame.width * this.plan.lensProfile.frame.height;
    const expectedBytes = expectedPixels * 3 * Float32Array.BYTES_PER_ELEMENT;
    if (rawCapture?.width !== this.plan.lensProfile.frame.width
      || rawCapture?.height !== this.plan.lensProfile.frame.height
      || rawCapture?.pixelFormat !== "linear-rgb-f32"
      || !(rawCapture.data instanceof Float32Array)
      || rawCapture.data.length !== expectedPixels * 3
      || rawCapture.data.byteLength !== expectedBytes
      || expectedBytes > this.maxCaptureBytes
      || rawCapture.bitDepth !== this.plan.expectedPipeline.bitDepth
      || rawCapture.linearized !== true) {
      throw runtimeError(
        "INVALID_CAMERA_FRAME",
        "RAW helper returned a raster outside the exact profile frame, RGB format or byte limit",
        { expectedBytes, maximumBytes: this.maxCaptureBytes },
      );
    }
    exactCamera(rawCapture.cameraDevice, this.plan.camera, "Capture camera");
    const lens = validateLens(lensEvidence(rawCapture.lens), this.plan);
    const pipeline = validatePipeline(pipelineEvidence(rawCapture.pipeline), this.plan);
    if (prior.lens && canonicalJson(prior.lens) !== canonicalJson(lens)) {
      throw runtimeError("OPTICAL_VERIFICATION_LENS_MISMATCH", "Lens provenance changed between RAW captures");
    }
    if (prior.pipeline && canonicalJson(prior.pipeline) !== canonicalJson(pipeline)) {
      throw runtimeError("OPTICAL_VERIFICATION_PIPELINE_MISMATCH", "RAW pipeline provenance changed between captures");
    }
    const settings = rawCapture.provenance?.settings;
    let normalizedSettings;
    try {
      normalizedSettings = normalizeManualCameraSettings(settings);
    } catch (error) {
      throw runtimeError("OPTICAL_VERIFICATION_CAMERA_MISMATCH", "Capture omitted exact manual exposure provenance", {
        cause: error.message,
      });
    }
    if (canonicalJson(normalizedSettings) !== canonicalJson(profile.settings)) {
      throw runtimeError("OPTICAL_VERIFICATION_CAMERA_MISMATCH", "Capture exposure settings changed from the active profile");
    }
    const sourceSha256 = String(rawCapture.provenance?.sourceSha256 || "");
    if (!SHA256.test(sourceSha256) || prior.sourceDigests.has(sourceSha256)) {
      throw runtimeError(
        "INVALID_OPTICAL_VERIFICATION_EVIDENCE",
        "Each verification exposure must carry one unique lowercase source RAW SHA-256",
      );
    }
    prior.sourceDigests.add(sourceSha256);
    prior.lens = clone(lens);
    prior.pipeline = clone(pipeline);
    const helperCapturedAt = canonicalIso(rawCapture.capturedAt, `capture ${step.id}#${repeat} helper clock`);
    const capturedAt = canonicalIso(receivedAtInput, `capture ${step.id}#${repeat} receipt clock`);
    if (Math.abs(Date.parse(helperCapturedAt) - Date.parse(capturedAt)) > MAX_CAMERA_HELPER_CLOCK_SKEW_MS) {
      throw runtimeError(
        "OPTICAL_VERIFICATION_CAMERA_CLOCK_SKEW",
        "Camera helper capture time is outside the bounded slewed node receipt window",
        { helperCapturedAt, receivedAt: capturedAt, maximumSkewMs: MAX_CAMERA_HELPER_CLOCK_SKEW_MS },
      );
    }
    if (Date.parse(capturedAt) < Date.parse(prior.lastEvidenceAt)) {
      throw runtimeError("INVALID_OPTICAL_VERIFICATION_EVIDENCE", "RAW capture timestamps are out of order");
    }
    prior.lastEvidenceAt = capturedAt;
    return {
      capture: rawCapture,
      evidence: {
        id: `${step.id}#${repeat}`,
        stepId: step.id,
        repeat,
        capturedAt,
        sourceSha256,
        width: rawCapture.width,
        height: rawCapture.height,
        bitDepth: rawCapture.bitDepth,
        linearized: true,
        exposureProfileId: step.exposureProfileId,
      },
    };
  }

  async run(planInput, { signal: externalSignal = null, baselineManifest, nodeProjectRevision } = {}) {
    this.plan = normalizeCameraOpticalVerificationPlan(planInput);
    this.lastTimestampMs = null;
    const bounded = combineAbortSignal(externalSignal, this.runDeadlineMs);
    const { signal } = bounded;
    const startedAt = this.#time(this.plan.rendererAcknowledgedAt);
    this.state = createCameraOpticalVerificationState(this.plan, { at: startedAt });
    let cameraOpened = false;
    let failClosed = false;
    let report = null;
    const captures = [];
    const retainedCaptures = [];
    const presentations = [];
    this.confirmationTransports = [];
    const provenance = {
      lens: null,
      pipeline: null,
      sourceDigests: new Set(),
      lastEvidenceAt: startedAt,
    };
    try {
      await this.#setState({
        ...this.state,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.PREFLIGHT,
        startedAt,
        updatedAt: startedAt,
      });
      this.#cancelled(signal, bounded.deadlineExceeded);
      if (this.plan.nodeId == null || Number(nodeProjectRevision) !== this.plan.project.appliedRevision) {
        throw runtimeError(
          "OPTICAL_VERIFICATION_REVISION_MISMATCH",
          "Local node project revision does not match the verification lease",
        );
      }
      await this.solver.begin?.({ plan: this.plan, baselineManifest, signal });
      const detection = await this.cameraAdapter.detect({ signal });
      this.#cancelled(signal, bounded.deadlineExceeded);
      if (detection?.adapter?.available !== true) {
        throw runtimeError(
          detection?.error?.code || "CAMERA_ADAPTER_UNAVAILABLE",
          detection?.error?.message || "Verification camera is unavailable",
        );
      }
      const detected = (detection.cameras || []).map(normalizedCamera)
        .find((camera) => canonicalJson(camera) === canonicalJson(this.plan.camera));
      if (!detected) {
        throw runtimeError("OPTICAL_VERIFICATION_CAMERA_MISMATCH", "The exact leased verification camera was not detected");
      }
      const opened = await this.cameraAdapter.open(detected.id, { signal });
      exactCamera(opened, this.plan.camera, "Opened camera");
      cameraOpened = true;
      const ownership = await this.patternAdapter.beginVerification({
        plan: this.plan,
        camera: detected,
        nodeProjectRevision,
      });
      if (ownership?.exclusive !== true || ownership?.arenaBlanked !== true || ownership?.mode !== "black") {
        throw runtimeError("OPTICAL_VERIFICATION_OUTPUT_OWNERSHIP_FAILED", "Renderer did not establish sticky exclusive black ownership");
      }
      let activeProfileId = null;
      let activeLock = null;
      let activeConfirmationLease = null;
      for (const step of this.plan.steps) {
        this.#cancelled(signal, bounded.deadlineExceeded);
        const profile = this.plan.exposureProfiles.find((candidate) => candidate.id === step.exposureProfileId);
        if (!profile) throw runtimeError("OPTICAL_VERIFICATION_CAMERA_MISMATCH", `Missing exposure profile ${step.exposureProfileId}`);
        if (activeProfileId !== profile.id) {
          activeLock = verifyManualCameraLock(
            profile.settings,
            await this.cameraAdapter.lockManualSettings(profile.settings, { signal }),
          );
          activeProfileId = profile.id;
        }
        const leaseId = step.captureConditions.confirmationLeaseId;
        let confirmation;
        if (activeConfirmationLease?.id === leaseId) {
          confirmation = {
            ...activeConfirmationLease.confirmation,
            stepId: step.id,
          };
          await this.#setState({
            ...this.state,
            state: CAMERA_OPTICAL_VERIFICATION_STATE.CAPTURING,
            progress: {
              ...this.state.progress,
              currentStepId: step.id,
              currentStepIndex: step.sequence,
            },
            operatorPrompt: null,
            updatedAt: this.#time(),
          });
        } else {
          confirmation = await this.#confirmation(step, signal, bounded.deadlineExceeded);
          activeConfirmationLease = { id: leaseId, confirmation };
          await this.#setState({
            ...this.state,
            state: CAMERA_OPTICAL_VERIFICATION_STATE.CAPTURING,
            operatorPrompt: null,
            updatedAt: confirmation.confirmedAt,
          });
        }
        const presented = await this.patternAdapter.showVerificationStep(step, {
          plan: this.plan,
          conditionVerification: conditionVerification(step, confirmation),
        });
        if (presented?.presented !== true || presented?.exclusive !== true || presented?.arenaBlanked !== true
          || presented.stepId !== step.id) {
          throw runtimeError("OPTICAL_VERIFICATION_PATTERN_NOT_CONFIRMED", `Renderer did not confirm ${step.id}`);
        }
        if (step.pattern != null) {
          const presentedAt = this.#time();
          if (!presented.presentation || !Array.isArray(presented.presentation.outputs)) {
            throw runtimeError("INVALID_OPTICAL_VERIFICATION_EVIDENCE", `Renderer omitted presentation evidence for ${step.id}`);
          }
          presentations.push({
            stepId: step.id,
            projectRevision: this.plan.project.appliedRevision,
            outputId: step.outputId,
            pattern: clone(step.pattern),
            outputs: clone(presented.presentation.outputs),
            presentedAt,
          });
          provenance.lastEvidenceAt = presentedAt;
        }
        for (let repeat = 0; repeat < step.repeats; repeat += 1) {
          this.#cancelled(signal, bounded.deadlineExceeded);
          const rawCapture = await this.cameraAdapter.capture({
            step,
            repeat,
            signal,
            maxPixels: this.plan.lensProfile.frame.width * this.plan.lensProfile.frame.height,
            maxWidth: this.plan.lensProfile.frame.width,
            maxHeight: this.plan.lensProfile.frame.height,
            maxRawBytes: this.maxCaptureBytes,
            preferredPixelFormat: "linear-rgb-f32",
            exposureProfileId: profile.id,
            exposureSettings: activeLock.applied,
            lensProfileSha256: this.plan.lensProfile.sha256,
          });
          const receivedAt = this.#time();
          const validated = this.#validateCapture(rawCapture, step, repeat, profile, provenance, receivedAt);
          captures.push(validated.evidence);
          if (typeof this.solver.consumeCapture === "function") {
            await this.solver.consumeCapture({ plan: this.plan, step, capture: validated.capture, signal });
          } else {
            retainedCaptures.push({ step, capture: validated.capture });
          }
        }
        await this.#setState({
          ...this.state,
          state: CAMERA_OPTICAL_VERIFICATION_STATE.PREFLIGHT,
          progress: {
            completedSteps: step.sequence + 1,
            totalSteps: this.plan.steps.length,
            currentStepId: null,
            currentStepIndex: null,
          },
          operatorPrompt: null,
          updatedAt: this.#time(),
        });
      }
      await this.#setState({
        ...this.state,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.EVALUATING,
        updatedAt: this.#time(),
      });
      const metrics = await this.solver.solve({
        plan: this.plan,
        captures: retainedCaptures,
        baselineManifest,
        signal,
      });
      this.#cancelled(signal, bounded.deadlineExceeded);
      const evaluation = evaluateCameraOpticalVerification(metrics, this.plan);
      const renderer = await this.patternAdapter.verificationRendererEvidence({
        plan: this.plan,
        nodeProjectRevision,
      });
      const completedAt = this.#time();
      report = normalizeCameraOpticalVerificationReport({
        schemaVersion: this.plan.schemaVersion,
        verificationId: this.plan.verificationId,
        calibrationSessionId: this.plan.calibrationSessionId,
        leaseToken: this.plan.leaseToken,
        state: evaluation.passed
          ? CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
          : CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
        projectRevision: this.plan.project.appliedRevision,
        startedAt,
        completedAt,
        renderer,
        provenance: {
          camera: clone(this.plan.camera),
          lens: clone(provenance.lens),
          pipeline: clone(provenance.pipeline),
          exposureProfiles: clone(this.plan.exposureProfiles),
          lensProfileSha256: this.plan.lensProfile.sha256,
        },
        confirmations: confirmationEvidence(this.plan, this.confirmationTransports),
        presentations,
        captures,
        metrics: evaluation.metrics,
        evaluation: {
          passed: evaluation.passed,
          failedGateIds: evaluation.failedGateIds,
          gates: evaluation.gates,
        },
        failure: evaluation.passed ? null : {
          code: "OPTICAL_GATES_FAILED",
          message: "One or more optical verification gates failed",
          details: evaluation.failedGateIds,
        },
      }, { plan: this.plan });
      // This is the release linearization point. If cancellation won before
      // this synchronous check, sticky black is retained for Server rollback.
      // Once a complete validated report passes this point, terminal VERIFIED
      // (or FAILED) owns the outcome even if a cancel command arrives while the
      // renderer is completing that already-conclusive transition.
      this.#cancelled(signal, bounded.deadlineExceeded);
      if (report.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
        const restored = await this.patternAdapter.completeVerification({ plan: this.plan, report });
        if (restored?.restored !== true || restored?.mode !== "content") {
          throw runtimeError("CONTENT_RESTORE_FAILED", "Renderer did not confirm content after successful verification");
        }
      } else {
        const blanked = await this.patternAdapter.failClosed({ plan: this.plan, reason: report.failure });
        if (blanked?.failClosed !== true || blanked?.mode !== "black") {
          throw runtimeError("OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED", "Renderer did not confirm sticky black after failed gates");
        }
        failClosed = true;
      }
      await this.#setState({
        ...this.state,
        state: report.state,
        progress: {
          completedSteps: this.plan.steps.length,
          totalSteps: this.plan.steps.length,
          currentStepId: null,
          currentStepIndex: null,
        },
        operatorPrompt: null,
        completedAt: report.completedAt,
        updatedAt: report.completedAt,
        failure: report.failure,
        report,
      });
      return { state: clone(this.state), report: clone(report), failClosed };
    } catch (inputError) {
      let error = inputError;
      if (signal.aborted) {
        error = bounded.deadlineExceeded()
          ? runtimeError("OPTICAL_VERIFICATION_DEADLINE_EXCEEDED", "Optical verification exceeded its bounded deadline")
          : runtimeError("OPTICAL_VERIFICATION_CANCELLED", "Optical verification was cancelled");
      } else if (!(error instanceof CameraOpticalVerificationError) && !(error instanceof CameraCalibrationError)) {
        error = runtimeError("OPTICAL_VERIFICATION_BLOCKED", error?.message || "Optical verification was blocked");
      }
      const cancellationRequested = error.code === "OPTICAL_VERIFICATION_CANCELLED";
      let stickyBlackConfirmed = false;
      failClosed = true;
      try {
        const blanked = await this.patternAdapter.failClosed({ plan: this.plan, reason: error });
        if (blanked?.failClosed !== true || blanked?.mode !== "black") {
          throw runtimeError(
            "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
            "Renderer did not confirm sticky black after optical verification stopped",
          );
        }
        stickyBlackConfirmed = true;
      } catch (blankError) {
        error = runtimeError(
          "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
          "Optical verification stopped and the renderer could not confirm sticky black",
          { cause: error.message, blankError: blankError?.message || String(blankError) },
        );
      }
      const completedAt = this.#time();
      const state = cancellationRequested && stickyBlackConfirmed
        ? CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
        : CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED;
      await this.#setState({
        ...this.state,
        state,
        progress: {
          ...this.state.progress,
          currentStepId: null,
          currentStepIndex: null,
        },
        operatorPrompt: null,
        completedAt,
        updatedAt: completedAt,
        failure: cleanFailure(error),
        report: null,
      });
      this.log("warn", state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
        ? "camera-optical-verification.cancelled-fail-closed"
        : "camera-optical-verification.blocked", {
        verificationId: this.plan.verificationId,
        code: error.code,
        error: error.message,
      });
      return { state: clone(this.state), report: null, failClosed, error };
    } finally {
      bounded.close();
      if (cameraOpened) await this.cameraAdapter.close().catch(() => {});
    }
  }
}
