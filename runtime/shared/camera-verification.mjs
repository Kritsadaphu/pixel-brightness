import { requiredGrayBits } from "./calibration.mjs";
import {
  CAMERA_CALIBRATION_SCHEMA_VERSION,
  normalizeCameraDescriptor,
  normalizeCameraExposureProfiles,
} from "./camera-calibration.mjs";
import { normalizeCameraLensProfile } from "./camera-lens-profile.mjs";
import { normalizePlanarSurfaceTargets } from "./camera-survey.mjs";
import { normalizeRendererCorrectionBinding } from "./renderer-correction-binding.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION,
  normalizeNativePatternCommand,
} from "./protocol.mjs";

export const CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION = CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION;
export const CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS =
  "sensor-dark-subtracted-exposure-normalized-camera-linear-luma";
export const CAMERA_OPTICAL_OVERLAP_MEASUREMENT_BASIS =
  "black-referenced-exposure-normalized-camera-linear-luma-relative-error";

export const CAMERA_OPTICAL_VERIFICATION_STATE = Object.freeze({
  PENDING: "pending-optical-capture",
  QUEUED: "queued",
  PREFLIGHT: "preflight",
  WAITING_OPERATOR: "waiting-operator",
  CAPTURING: "capturing",
  EVALUATING: "evaluating",
  VERIFIED: "verified",
  FAILED: "failed",
  BLOCKED: "blocked",
  ROLLING_BACK: "rolling-back",
  ROLLBACK_RENDERER_ACK: "rollback-renderer-ack",
  ROLLED_BACK: "rolled-back",
  ROLLBACK_BLOCKED: "rollback-blocked",
  SUPERSEDED: "superseded",
  CANCELLED: "cancelled",
});

export const CAMERA_OPTICAL_ROLLBACK_TRIGGER = Object.freeze({
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const STATE_VALUES = new Set(Object.values(CAMERA_OPTICAL_VERIFICATION_STATE));
const SHA256 = /^[a-f0-9]{64}$/;
const LEASE_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EPSILON = 1e-9;
const CANCELLATION_ROLLBACK_FAILURE_CODES = new Set([
  "OPTICAL_VERIFICATION_CANCELLED",
  "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
]);

export const CAMERA_OPTICAL_VERIFICATION_LIMITS = deepFreeze({
  operatorConfirmationTimeoutMs: 5 * 60 * 1_000,
  repeats: {
    geometry: 1,
    radiometry: 3,
    lowLight: 5,
    sensorDark: 5,
    ambient: 3,
  },
  geometry: {
    maximumTargetResidualP95FloorPx: 2,
    targetResidualRmsMultiplier: 4,
    maximumTargetResidualMaxFloorPx: 6,
    targetResidualMaxMultiplier: 4,
    maximumProjectorDriftP95Px: 2,
    maximumProjectorDriftMaxPx: 6,
    minimumPixelCoverage: 0.85,
    minimumTileCoverage: 0.98,
    maximumClippedFraction: 0.01,
  },
  radiometry: {
    minimumCoverage: 0.8,
    maximumClippedFraction: 0.01,
    minimumNormalSnrDb: 20,
    minimumNearBlackSnrDb: 14,
    maximumRelativeUncertainty: 0.03,
    maximumNeutralRatioRelativeError: 0.05,
    maximumNearBlackRelativeError: 0.1,
    maximumPrimaryRmse: 0.05,
    maximumPrimaryError: 0.1,
  },
  combined: {
    maximumBlackUncertaintyP95: 0.02,
    maximumBlackNonuniformityRange: 0.01,
    blackUncertaintyMultiplier: 3,
    maximumNegativeBeyondUncertaintyFraction: 0.05,
  },
  blackFloor: {
    maximumAbsoluteDrift: 0.01,
    maximumUncertaintyP95: 0.02,
    uncertaintyMultiplier: 3,
    minimumSampleCount: 64,
    maximumMeasuredNormalizationRelativeSpread: 0.05,
  },
  overlapBands: {
    cameraBandWidthPx: 12,
    maximumSharedEdgeEndpointMismatchPx: 6,
    minimumSampleCount: 64,
    minimumCoverage: 0.8,
    minimumAnalysisBandWidthPx: 2,
    maximumBoundaryResidualP95: 0.05,
    maximumBoundaryResidualMax: 0.1,
  },
  pipeline: {
    bitDepth: 14,
    retainedPixelFormat: "linear-rgb-f32",
  },
});

export class CameraOpticalVerificationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CameraOpticalVerificationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, message, details) {
  throw new CameraOpticalVerificationError(code, message, details);
}

function exactObject(value, field, keys, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${field} must contain exactly: ${expected.join(", ")}`, { actual, expected });
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertCanonicalEqual(actual, expected, field, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(code, `${field} does not match the authoritative verification contract`, { actual, expected });
  }
  return expected;
}

function text(value, field, maximum = 256, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    fail(code, `${field} must be a canonical 1-${maximum} character string`);
  }
  return value;
}

function finite(value, field, minimum, maximum, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
    || value < minimum || value > maximum) {
    fail(code, `${field} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function integer(value, field, minimum, maximum, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value, field, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (typeof value !== "boolean") fail(code, `${field} must be boolean`);
  return value;
}

function nullableIso(value, field, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  return value == null ? null : iso(value, field, code);
}

function iso(value, field, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) {
    fail(code, `${field} must be a canonical UTC ISO-8601 instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail(code, `${field} must be a real canonical UTC ISO-8601 instant`);
  }
  return value;
}

function normalizeStrictCamera(input, field, code = "INVALID_OPTICAL_VERIFICATION_CONTRACT") {
  const value = exactObject(input, field, ["id", "vendor", "model", "serial", "transport", "backend", "capabilities"], code);
  exactObject(value.capabilities, `${field}.capabilities`, [
    "manualExposure", "manualWhiteBalance", "manualFocus", "linearCapture",
  ], code);
  const normalized = normalizeCameraDescriptor(value);
  assertCanonicalEqual(value, normalized, field, code);
  if (Object.values(normalized.capabilities).some((capability) => capability !== true)) {
    fail(code, `${field} must prove manual exposure, white balance, focus and linear capture support`);
  }
  return normalized;
}

function normalizeSourceViewport(input, field) {
  const value = exactObject(input, field, ["x", "y", "width", "height"]);
  const viewport = {
    x: finite(value.x, `${field}.x`, 0, 1e9),
    y: finite(value.y, `${field}.y`, 0, 1e9),
    width: finite(value.width, `${field}.width`, 1e-6, 1e9),
    height: finite(value.height, `${field}.height`, 1e-6, 1e9),
  };
  if (viewport.x + viewport.width > 1e9 || viewport.y + viewport.height > 1e9) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", `${field} bounds exceed the supported source coordinate range`);
  }
  return viewport;
}

function polygonArea(points) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubled += current.x * next.y - current.y * next.x;
  }
  return doubled / 2;
}

function pointsNear(first, second, tolerance = 1e-12) {
  return Math.abs(first.x - second.x) <= tolerance && Math.abs(first.y - second.y) <= tolerance;
}

function canonicalDerivedPolygon(input, field) {
  const compact = [];
  for (const point of input) {
    if (!compact.length || !pointsNear(compact.at(-1), point)) compact.push({ x: point.x, y: point.y });
  }
  if (compact.length > 1 && pointsNear(compact[0], compact.at(-1))) compact.pop();
  if (compact.length < 3 || compact.length > 16 || Math.abs(polygonArea(compact)) < 1e-10) {
    fail("OPTICAL_VERIFICATION_OVERLAP_GEOMETRY_INVALID", `${field} does not have a measurable camera area`);
  }
  if (polygonArea(compact) < 0) compact.reverse();
  const firstIndex = compact.reduce((best, point, index) => {
    const candidate = compact[best];
    return point.x < candidate.x - 1e-12
      || (Math.abs(point.x - candidate.x) <= 1e-12 && point.y < candidate.y) ? index : best;
  }, 0);
  const rotated = [...compact.slice(firstIndex), ...compact.slice(0, firstIndex)];
  return rotated.map((point, index) => ({
    x: finite(point.x, `${field}[${index}].x`, 0, 1),
    y: finite(point.y, `${field}[${index}].y`, 0, 1),
  }));
}

function edgeCross(first, second, point) {
  return (second.x - first.x) * (point.y - first.y)
    - (second.y - first.y) * (point.x - first.x);
}

function lineIntersection(segmentStart, segmentEnd, clipStart, clipEnd) {
  const segmentX = segmentEnd.x - segmentStart.x;
  const segmentY = segmentEnd.y - segmentStart.y;
  const clipX = clipEnd.x - clipStart.x;
  const clipY = clipEnd.y - clipStart.y;
  const denominator = segmentX * clipY - segmentY * clipX;
  if (Math.abs(denominator) <= 1e-15) return { ...segmentEnd };
  const offsetX = clipStart.x - segmentStart.x;
  const offsetY = clipStart.y - segmentStart.y;
  const t = (offsetX * clipY - offsetY * clipX) / denominator;
  return { x: segmentStart.x + t * segmentX, y: segmentStart.y + t * segmentY };
}

function intersectConvexPolygons(subjectInput, clipInput) {
  let subject = subjectInput.map((point) => ({ ...point }));
  const clip = polygonArea(clipInput) < 0 ? [...clipInput].reverse() : clipInput;
  for (let edgeIndex = 0; edgeIndex < clip.length && subject.length; edgeIndex += 1) {
    const clipStart = clip[edgeIndex];
    const clipEnd = clip[(edgeIndex + 1) % clip.length];
    const source = subject;
    subject = [];
    let previous = source.at(-1);
    let previousInside = edgeCross(clipStart, clipEnd, previous) >= -1e-12;
    for (const current of source) {
      const currentInside = edgeCross(clipStart, clipEnd, current) >= -1e-12;
      if (currentInside) {
        if (!previousInside) subject.push(lineIntersection(previous, current, clipStart, clipEnd));
        subject.push(current);
      } else if (previousInside) {
        subject.push(lineIntersection(previous, current, clipStart, clipEnd));
      }
      previous = current;
      previousInside = currentInside;
    }
  }
  return subject;
}

function targetPointAtSource(output, sourceX, sourceY) {
  const viewport = output.sourceViewport;
  const u = Math.min(1, Math.max(0, (sourceX - viewport.x) / viewport.width));
  const v = Math.min(1, Math.max(0, (sourceY - viewport.y) / viewport.height));
  const [topLeft, topRight, bottomRight, bottomLeft] = output.surfaceTarget.corners;
  return {
    x: (1 - u) * (1 - v) * topLeft.x + u * (1 - v) * topRight.x
      + u * v * bottomRight.x + (1 - u) * v * bottomLeft.x,
    y: (1 - u) * (1 - v) * topLeft.y + u * (1 - v) * topRight.y
      + u * v * bottomRight.y + (1 - u) * v * bottomLeft.y,
  };
}

function sharedEdgeCameraBand(first, second, sourceRegion, frame) {
  const vertical = sourceRegion.width <= EPSILON;
  const sourcePoints = vertical
    ? [
      { x: sourceRegion.x, y: sourceRegion.y },
      { x: sourceRegion.x, y: sourceRegion.y + sourceRegion.height },
    ]
    : [
      { x: sourceRegion.x, y: sourceRegion.y },
      { x: sourceRegion.x + sourceRegion.width, y: sourceRegion.y },
    ];
  let endpointMismatchMaxPx = 0;
  const centerline = sourcePoints.map((point) => {
    const firstPoint = targetPointAtSource(first, point.x, point.y);
    const secondPoint = targetPointAtSource(second, point.x, point.y);
    endpointMismatchMaxPx = Math.max(
      endpointMismatchMaxPx,
      Math.hypot(
        (firstPoint.x - secondPoint.x) * frame.width,
        (firstPoint.y - secondPoint.y) * frame.height,
      ),
    );
    return { x: (firstPoint.x + secondPoint.x) / 2, y: (firstPoint.y + secondPoint.y) / 2 };
  });
  if (endpointMismatchMaxPx
    > CAMERA_OPTICAL_VERIFICATION_LIMITS.overlapBands.maximumSharedEdgeEndpointMismatchPx) {
    fail(
      "OPTICAL_VERIFICATION_SHARED_EDGE_UNRESOLVED",
      `Shared-edge endpoints for ${first.id}/${second.id} differ by ${endpointMismatchMaxPx.toFixed(3)} camera pixels`,
      {
        outputIds: [first.id, second.id],
        endpointMismatchMaxPx,
        maximumSharedEdgeEndpointMismatchPx:
          CAMERA_OPTICAL_VERIFICATION_LIMITS.overlapBands.maximumSharedEdgeEndpointMismatchPx,
      },
    );
  }
  const dx = (centerline[1].x - centerline[0].x) * frame.width;
  const dy = (centerline[1].y - centerline[0].y) * frame.height;
  const length = Math.hypot(dx, dy);
  if (length < 2) {
    fail("OPTICAL_VERIFICATION_OVERLAP_GEOMETRY_INVALID", "Shared edge is too short to sample optically");
  }
  const halfWidth = CAMERA_OPTICAL_VERIFICATION_LIMITS.overlapBands.cameraBandWidthPx / 2;
  const offset = {
    x: (-dy / length) * halfWidth / frame.width,
    y: (dx / length) * halfWidth / frame.height,
  };
  const band = [
    { x: centerline[0].x + offset.x, y: centerline[0].y + offset.y },
    { x: centerline[1].x + offset.x, y: centerline[1].y + offset.y },
    { x: centerline[1].x - offset.x, y: centerline[1].y - offset.y },
    { x: centerline[0].x - offset.x, y: centerline[0].y - offset.y },
  ];
  return {
    cameraPolygon: intersectConvexPolygons(band, [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ]),
    endpointMismatchMaxPx,
  };
}

function normalizeOutput(input, index, lensProfile) {
  const field = `outputs[${index}]`;
  const value = exactObject(input, field, ["id", "resolution", "sourceViewport", "surfaceTarget"]);
  const resolution = exactObject(value.resolution, `${field}.resolution`, ["width", "height"]);
  const surfaceTargetValue = exactObject(value.surfaceTarget, `${field}.surfaceTarget`, [
    "outputId", "wallId", "surveyId", "cameraViewId", "lensProfileSha256", "frame", "corners", "method",
  ]);
  let surfaceTarget;
  try {
    [surfaceTarget] = normalizePlanarSurfaceTargets([surfaceTargetValue], { requireSingleCameraView: false });
  } catch (error) {
    fail(
      error?.code || "INVALID_OPTICAL_VERIFICATION_CONTRACT",
      error?.message || `${field}.surfaceTarget is invalid`,
      error?.details,
    );
  }
  assertCanonicalEqual(surfaceTargetValue, surfaceTarget, `${field}.surfaceTarget`);
  const id = text(value.id, `${field}.id`, 64);
  if (surfaceTarget.outputId !== id
    || surfaceTarget.lensProfileSha256 !== lensProfile.sha256
    || surfaceTarget.frame.width !== lensProfile.frame.width
    || surfaceTarget.frame.height !== lensProfile.frame.height) {
    fail(
      "OPTICAL_VERIFICATION_SURFACE_TARGET_MISMATCH",
      `${field}.surfaceTarget must bind the output to the exact lens profile and retained camera frame`,
    );
  }
  return {
    id,
    resolution: {
      width: integer(resolution.width, `${field}.resolution.width`, 2, 16_384),
      height: integer(resolution.height, `${field}.resolution.height`, 2, 16_384),
    },
    sourceViewport: normalizeSourceViewport(value.sourceViewport, `${field}.sourceViewport`),
    surfaceTarget,
  };
}

function normalizeBlackFloorBaselines(input, { outputs, exposureProfiles, calibrationSessionId }) {
  if (!Array.isArray(input) || input.length !== outputs.length) {
    fail(
      "INVALID_OPTICAL_VERIFICATION_CONTRACT",
      "blackFloorBaselines must bind every verification output exactly once in authoritative order",
    );
  }
  const profile = exposureProfiles.find((candidate) => candidate.role === "radiometry");
  return input.map((entry, index) => {
    const field = `blackFloorBaselines[${index}]`;
    const value = exactObject(entry, field, [
      "outputId", "calibrationSessionId", "sourceManifestSchemaVersion", "blackPedestalSha256",
      "exposureProfileId", "normalizationScale", "exposureBridgeId", "exposureBridgeStatus",
      "exposureBridgeGatesPassed", "measuredNormalizationScale", "normalizationRelativeUncertainty",
      "measurementBasis", "targetLevel",
    ]);
    if (value.outputId !== outputs[index].id || value.calibrationSessionId !== calibrationSessionId) {
      fail("OPTICAL_VERIFICATION_BASELINE_MISMATCH", `${field} is not bound to the output calibration session`);
    }
    if (value.sourceManifestSchemaVersion !== CAMERA_CALIBRATION_SCHEMA_VERSION) {
      fail(
        "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
        `${field}.sourceManifestSchemaVersion must match the measured calibration manifest schema`,
      );
    }
    if (typeof value.blackPedestalSha256 !== "string" || !SHA256.test(value.blackPedestalSha256)) {
      fail("OPTICAL_VERIFICATION_BASELINE_MISMATCH", `${field}.blackPedestalSha256 must be a lowercase SHA-256 digest`);
    }
    if (value.exposureProfileId !== profile.id
      || value.normalizationScale !== profile.normalizationScale
      || value.measurementBasis !== CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS) {
      fail(
        "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
        `${field} must bind the radiometry exposure normalization and camera-linear black basis`,
      );
    }
    const measuredNormalizationScale = finite(
      value.measuredNormalizationScale,
      `${field}.measuredNormalizationScale`,
      1e-9,
      1e9,
    );
    const normalizationRelativeUncertainty = finite(
      value.normalizationRelativeUncertainty,
      `${field}.normalizationRelativeUncertainty`,
      0,
      1,
    );
    if (value.exposureBridgeStatus !== "passed" || value.exposureBridgeGatesPassed !== true
      || Math.abs(measuredNormalizationScale / profile.normalizationScale - 1)
        > CAMERA_OPTICAL_VERIFICATION_LIMITS.blackFloor.maximumMeasuredNormalizationRelativeSpread) {
      fail(
        "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
        `${field} must bind a passed optical exposure bridge consistent with the locked long profile`,
      );
    }
    return {
      outputId: outputs[index].id,
      calibrationSessionId,
      sourceManifestSchemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
      blackPedestalSha256: value.blackPedestalSha256,
      exposureProfileId: profile.id,
      normalizationScale: profile.normalizationScale,
      exposureBridgeId: text(value.exposureBridgeId, `${field}.exposureBridgeId`, 512),
      exposureBridgeStatus: "passed",
      exposureBridgeGatesPassed: true,
      measuredNormalizationScale,
      normalizationRelativeUncertainty,
      measurementBasis: CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS,
      targetLevel: finite(value.targetLevel, `${field}.targetLevel`, 0, 1),
    };
  });
}

function summarizeMeasuredNormalization(baselines) {
  const scales = baselines.map((baseline) => baseline.measuredNormalizationScale).sort((a, b) => a - b);
  const middle = Math.floor(scales.length / 2);
  const globalMeasuredNormalizationScale = scales.length % 2
    ? scales[middle]
    : (scales[middle - 1] + scales[middle]) / 2;
  const maximumRelativeSpread = Math.max(...scales.map(
    (scale) => Math.abs(scale / globalMeasuredNormalizationScale - 1),
  ));
  if (maximumRelativeSpread
    > CAMERA_OPTICAL_VERIFICATION_LIMITS.blackFloor.maximumMeasuredNormalizationRelativeSpread) {
    fail(
      "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
      "Per-output optical exposure bridges disagree beyond the permitted normalization spread",
      { globalMeasuredNormalizationScale, maximumRelativeSpread },
    );
  }
  return {
    globalMeasuredNormalizationScale,
    globalNormalizationRelativeUncertainty: Math.max(
      ...baselines.map((baseline) => baseline.normalizationRelativeUncertainty),
    ),
  };
}

function normalizeVerificationRendererCorrectionBinding(input, outputs, blackFloorBaselines) {
  let binding;
  try {
    binding = normalizeRendererCorrectionBinding(input, "rendererCorrectionBinding");
  } catch (error) {
    fail(
      error?.code || "INVALID_RENDERER_CORRECTION_BINDING",
      error?.message || "rendererCorrectionBinding is invalid",
      error?.details,
    );
  }
  const baselineByOutputId = new Map(blackFloorBaselines.map((baseline) => [baseline.outputId, baseline]));
  const bindingIndexByOutputId = new Map(binding.outputs.map((output, index) => [output.id, index]));
  let priorBindingIndex = -1;
  for (const output of outputs) {
    const bindingIndex = bindingIndexByOutputId.get(output.id);
    const bound = bindingIndex == null ? null : binding.outputs[bindingIndex];
    if (!bound || bindingIndex <= priorBindingIndex) {
      fail(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
        "Every verified output must occur exactly once in calibration output order within the full renderer binding",
        { outputId: output.id },
      );
    }
    priorBindingIndex = bindingIndex;
    const missingArtifacts = Object.entries(bound.artifacts)
      .filter(([, digestValue]) => digestValue == null)
      .map(([artifact]) => artifact);
    if (bound.processingBypass !== false || missingArtifacts.length) {
      fail(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_IDENTITY",
        `Verified output ${output.id} must actively load warp, blend, black, mask and color-LUT corrections`,
        { processingBypass: bound.processingBypass, missingArtifacts },
      );
    }
    const baseline = baselineByOutputId.get(output.id);
    if (bound.artifacts.blackMapSha256 !== baseline?.blackPedestalSha256) {
      fail(
        "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
        `Verified output ${output.id} renderer black-map digest differs from its calibration baseline`,
        {
          observed: bound.artifacts.blackMapSha256,
          expected: baseline?.blackPedestalSha256 ?? null,
        },
      );
    }
  }
  return binding;
}

function deriveOverlapBands({ verificationId, outputs, exposureProfiles }) {
  const geometry = exposureProfiles.find((profile) => profile.role === "geometry");
  const candidates = [];
  for (let firstIndex = 0; firstIndex < outputs.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < outputs.length; secondIndex += 1) {
      let first = outputs[firstIndex];
      let second = outputs[secondIndex];
      if (first.id.localeCompare(second.id) > 0) [first, second] = [second, first];
      const sameWall = first.surfaceTarget.wallId === second.surfaceTarget.wallId;
      const firstViewport = first.sourceViewport;
      const secondViewport = second.sourceViewport;
      const left = Math.max(firstViewport.x, secondViewport.x);
      const top = Math.max(firstViewport.y, secondViewport.y);
      const right = Math.min(
        firstViewport.x + firstViewport.width,
        secondViewport.x + secondViewport.width,
      );
      const bottom = Math.min(
        firstViewport.y + firstViewport.height,
        secondViewport.y + secondViewport.height,
      );
      const width = right - left;
      const height = bottom - top;
      const areaOverlap = sameWall && width > EPSILON && height > EPSILON;
      const sharedEdge = (Math.abs(width) <= EPSILON && height > EPSILON)
        || (width > EPSILON && Math.abs(height) <= EPSILON);
      if (!areaOverlap && !sharedEdge) continue;
      const relation = areaOverlap
        ? "area-overlap"
        : sameWall ? "shared-edge" : "cross-wall-shared-edge";
      const sourceRegion = {
        x: left,
        y: top,
        width: areaOverlap ? width : Math.max(0, width),
        height: areaOverlap ? height : Math.max(0, height),
      };
      const edgeBand = areaOverlap
        ? null
        : sharedEdgeCameraBand(first, second, sourceRegion, first.surfaceTarget.frame);
      const rawPolygon = areaOverlap
        ? intersectConvexPolygons(first.surfaceTarget.corners, second.surfaceTarget.corners)
        : edgeBand.cameraPolygon;
      const wallIds = [...new Set([
        first.surfaceTarget.wallId,
        second.surfaceTarget.wallId,
      ])].sort((a, b) => a.localeCompare(b));
      candidates.push({
        key: `${wallIds.join("\u0001")}\u0000${first.id}\u0000${second.id}\u0000${relation}`,
        wallIds,
        outputIds: [first.id, second.id],
        relation,
        endpointMismatchMaxPx: edgeBand?.endpointMismatchMaxPx ?? null,
        cameraPolygon: canonicalDerivedPolygon(rawPolygon, `overlap band ${first.id}/${second.id}.cameraPolygon`),
      });
    }
  }
  candidates.sort((first, second) => first.key.localeCompare(second.key));
  return candidates.map((candidate, index) => ({
    id: `${verificationId}/overlap-band/${String(index).padStart(3, "0")}`,
    wallIds: candidate.wallIds,
    outputIds: candidate.outputIds,
    relation: candidate.relation,
    endpointMismatchMaxPx: candidate.endpointMismatchMaxPx,
    cameraPolygon: candidate.cameraPolygon,
    cameraBandWidthPx: candidate.relation !== "area-overlap"
      ? CAMERA_OPTICAL_VERIFICATION_LIMITS.overlapBands.cameraBandWidthPx
      : 0,
    expectedLevel: 0.18,
    exposureProfileId: geometry.id,
    normalizationScale: geometry.normalizationScale,
    measurementBasis: CAMERA_OPTICAL_OVERLAP_MEASUREMENT_BASIS,
  }));
}

function normalizeMesh(input) {
  const value = exactObject(input, "mesh", ["columns", "rows", "minimumConfidence"]);
  return {
    columns: integer(value.columns, "mesh.columns", 2, 128),
    rows: integer(value.rows, "mesh.rows", 2, 128),
    minimumConfidence: finite(value.minimumConfidence, "mesh.minimumConfidence", 0, 1),
  };
}

function normalizeLevels(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "nearBlackLevels must contain 1-32 levels");
  }
  const levels = input.map((value, index) => finite(value, `nearBlackLevels[${index}]`, 1 / 65_535, 0.1));
  if (new Set(levels).size !== levels.length) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "nearBlackLevels must be unique");
  }
  return [...levels].sort((first, second) => first - second);
}

function conditions(projectorState, opticalPath, otherProjectors, confirmationLeaseId) {
  return {
    projectorState,
    opticalPath,
    otherProjectors,
    requiresOperatorConfirmation: true,
    confirmationLeaseId,
  };
}

function normalizedPattern(input) {
  const pattern = normalizeNativePatternCommand(input);
  const allowed = pattern.type === "solid"
    ? ["enabled", "type", "rgb", "applyCorrections", ...(pattern.outputId ? ["outputId"] : [])]
    : ["enabled", "type", "axis", "bit", "inverse", ...(pattern.outputId ? ["outputId"] : [])];
  exactObject(pattern, "generated pattern", allowed);
  return pattern;
}

function buildVerificationGates({ lensProfile, mesh }) {
  const limits = CAMERA_OPTICAL_VERIFICATION_LIMITS;
  return {
    geometry: {
      minimumConfidence: mesh.minimumConfidence,
      maximumTargetResidualP95Px: Math.max(
        limits.geometry.maximumTargetResidualP95FloorPx,
        limits.geometry.targetResidualRmsMultiplier * lensProfile.calibration.rmsResidualPx,
      ),
      maximumTargetResidualMaxPx: Math.max(
        limits.geometry.maximumTargetResidualMaxFloorPx,
        limits.geometry.targetResidualMaxMultiplier * lensProfile.calibration.maxResidualPx,
      ),
      maximumProjectorDriftP95Px: limits.geometry.maximumProjectorDriftP95Px,
      maximumProjectorDriftMaxPx: limits.geometry.maximumProjectorDriftMaxPx,
      minimumPixelCoverage: limits.geometry.minimumPixelCoverage,
      minimumTileCoverage: limits.geometry.minimumTileCoverage,
      maximumClippedFraction: limits.geometry.maximumClippedFraction,
    },
    radiometry: { ...limits.radiometry },
    combined: { ...limits.combined },
    blackFloor: { ...limits.blackFloor },
    overlapBands: {
      maximumSharedEdgeEndpointMismatchPx: limits.overlapBands.maximumSharedEdgeEndpointMismatchPx,
      minimumSampleCount: limits.overlapBands.minimumSampleCount,
      minimumCoverage: limits.overlapBands.minimumCoverage,
      minimumAnalysisBandWidthPx: limits.overlapBands.minimumAnalysisBandWidthPx,
      maximumBoundaryResidualP95: limits.overlapBands.maximumBoundaryResidualP95,
      maximumBoundaryResidualMax: limits.overlapBands.maximumBoundaryResidualMax,
    },
  };
}

function createSteps({ verificationId, outputs, exposureProfiles, lowLevel, settleFrames }) {
  const limits = CAMERA_OPTICAL_VERIFICATION_LIMITS.repeats;
  const geometry = exposureProfiles.find((profile) => profile.role === "geometry");
  const radiometry = exposureProfiles.find((profile) => profile.role === "radiometry");
  const sensorDark = conditions("emission-off", "blocked", "emission-off", "verification-sensor-dark");
  const ambient = conditions("emission-off", "open", "emission-off", "verification-ambient");
  const projected = conditions("target-pattern", "open", "digital-black", "verification-projectors-on");
  const globalProjected = conditions("all-target-pattern", "open", "same-corrected-pattern", "verification-projectors-on");
  const steps = [];
  const push = ({ id, outputId = null, purpose, profile, repeats, pattern = null, captureConditions }) => {
    steps.push({
      id: `${verificationId}/${id}`,
      sequence: steps.length,
      outputId,
      purpose,
      exposureProfileId: profile.id,
      repeats,
      settleFrames,
      pattern,
      captureConditions,
    });
  };

  for (const profile of [geometry, radiometry]) {
    push({
      id: `reference/sensor-dark/${profile.id}`,
      purpose: "sensor-dark",
      profile,
      repeats: limits.sensorDark,
      captureConditions: sensorDark,
    });
  }
  push({
    id: `reference/ambient/${radiometry.id}`,
    purpose: "projectors-off-ambient",
    profile: radiometry,
    repeats: limits.ambient,
    captureConditions: ambient,
  });

  for (const output of outputs) {
    const raw = (suffix, purpose, pattern) => push({
      id: `${output.id}/geometry/${suffix}`,
      outputId: output.id,
      purpose,
      profile: geometry,
      repeats: limits.geometry,
      pattern: normalizedPattern({ ...pattern, outputId: output.id }),
      captureConditions: projected,
    });
    raw("white", "geometry-white", { type: "solid", rgb: [1, 1, 1], applyCorrections: false });
    for (const axis of ["x", "y"]) {
      const dimension = axis === "x" ? output.resolution.width : output.resolution.height;
      for (let bit = 0; bit < requiredGrayBits(dimension); bit += 1) {
        for (const inverse of [false, true]) {
          raw(
            `gray-${axis}-${String(bit).padStart(2, "0")}-${inverse ? "inverse" : "normal"}`,
            "geometry-gray-code",
            { type: "gray-code", axis, bit, inverse },
          );
        }
      }
    }

    for (const [purpose, rgb] of [
      ["corrected-black-short", [0, 0, 0]],
      ["corrected-neutral-018", [0.18, 0.18, 0.18]],
      ["corrected-neutral-050", [0.5, 0.5, 0.5]],
      ["corrected-primary-red", [0.5, 0, 0]],
      ["corrected-primary-green", [0, 0.5, 0]],
      ["corrected-primary-blue", [0, 0, 0.5]],
    ]) {
      push({
        id: `${output.id}/radiometry-short/${purpose}`,
        outputId: output.id,
        purpose,
        profile: geometry,
        repeats: limits.radiometry,
        pattern: normalizedPattern({ type: "solid", rgb, applyCorrections: true, outputId: output.id }),
        captureConditions: projected,
      });
    }
    for (const [purpose, rgb] of [
      ["corrected-black-long", [0, 0, 0]],
      ["corrected-near-black", [lowLevel, lowLevel, lowLevel]],
    ]) {
      push({
        id: `${output.id}/radiometry-long/${purpose}`,
        outputId: output.id,
        purpose,
        profile: radiometry,
        repeats: limits.lowLight,
        pattern: normalizedPattern({ type: "solid", rgb, applyCorrections: true, outputId: output.id }),
        captureConditions: projected,
      });
    }
  }

  for (const [profile, repeats, purpose, rgb] of [
    [geometry, limits.radiometry, "global-corrected-black-short", [0, 0, 0]],
    [geometry, limits.radiometry, "global-corrected-neutral-018", [0.18, 0.18, 0.18]],
    [radiometry, limits.lowLight, "global-corrected-black-long", [0, 0, 0]],
    [radiometry, limits.lowLight, "global-corrected-near-black", [lowLevel, lowLevel, lowLevel]],
  ]) {
    push({
      id: `global/${purpose}`,
      purpose,
      profile,
      repeats,
      pattern: normalizedPattern({ type: "solid", rgb, applyCorrections: true }),
      captureConditions: globalProjected,
    });
  }
  return steps;
}

function normalizePlanSource(input, { now } = {}) {
  const value = exactObject(input, "verification request", [
    "verificationId", "leaseToken", "calibrationSessionId", "nodeId", "project",
    "rendererAcknowledgedAt", "camera", "lensProfile", "exposureProfiles", "outputs",
    "blackFloorBaselines", "rendererCorrectionBinding", "mesh", "nearBlackLevels", "settleFrames",
  ]);
  const project = exactObject(value.project, "project", ["id", "baseRevision", "appliedRevision"]);
  const baseRevision = integer(project.baseRevision, "project.baseRevision", 1, Number.MAX_SAFE_INTEGER - 1);
  const appliedRevision = integer(project.appliedRevision, "project.appliedRevision", 2, Number.MAX_SAFE_INTEGER);
  if (appliedRevision !== baseRevision + 1) {
    fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", "Applied revision must be exactly one revision after its calibration base");
  }
  const camera = normalizeStrictCamera(value.camera, "camera");
  let lensProfile;
  try {
    lensProfile = normalizeCameraLensProfile(value.lensProfile, { now });
  } catch (error) {
    fail(error?.code || "INVALID_OPTICAL_VERIFICATION_CONTRACT", error?.message || "Lens profile is invalid", error?.details);
  }
  if (camera.vendor !== lensProfile.camera.manufacturer
    || camera.model !== lensProfile.camera.model
    || camera.serial !== lensProfile.camera.serialNumber) {
    fail("OPTICAL_VERIFICATION_CAMERA_MISMATCH", "Verification camera does not match the bound lens profile body");
  }
  let exposureProfiles;
  try {
    exposureProfiles = normalizeCameraExposureProfiles(value.exposureProfiles);
  } catch (error) {
    fail(error?.code || "INVALID_OPTICAL_VERIFICATION_CONTRACT", error?.message || "Exposure profiles are invalid", error?.details);
  }
  if (exposureProfiles.some((profile) => Math.abs(profile.settings.apertureF - lensProfile.capture.apertureFNumber) > EPSILON)) {
    fail("OPTICAL_VERIFICATION_LENS_MISMATCH", "Exposure aperture does not match the bound lens profile");
  }
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 32) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "outputs must contain 1-32 render outputs");
  }
  const outputs = value.outputs.map((output, index) => normalizeOutput(output, index, lensProfile));
  if (new Set(outputs.map((output) => output.id)).size !== outputs.length) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "Verification output ids must be unique");
  }
  try {
    const normalizedTargets = normalizePlanarSurfaceTargets(outputs.map((output) => output.surfaceTarget));
    assertCanonicalEqual(
      outputs.map((output) => output.surfaceTarget),
      normalizedTargets,
      "outputs.surfaceTargets",
    );
  } catch (error) {
    if (error instanceof CameraOpticalVerificationError) throw error;
    fail(
      error?.code || "INVALID_OPTICAL_VERIFICATION_CONTRACT",
      error?.message || "Verification surface targets do not share one fixed camera view",
      error?.details,
    );
  }
  const calibrationSessionId = text(value.calibrationSessionId, "calibrationSessionId", 128);
  const blackFloorBaselines = normalizeBlackFloorBaselines(value.blackFloorBaselines, {
    outputs,
    exposureProfiles,
    calibrationSessionId,
  });
  const measuredNormalization = summarizeMeasuredNormalization(blackFloorBaselines);
  const rendererCorrectionBinding = normalizeVerificationRendererCorrectionBinding(
    value.rendererCorrectionBinding,
    outputs,
    blackFloorBaselines,
  );
  const verificationId = text(value.verificationId, "verificationId", 128);
  const overlapBands = deriveOverlapBands({ verificationId, outputs, exposureProfiles });
  const mesh = normalizeMesh(value.mesh);
  const nearBlackLevels = normalizeLevels(value.nearBlackLevels);
  const radiometry = exposureProfiles.find((profile) => profile.role === "radiometry");
  const lowLevel = nearBlackLevels.find((level) => level * radiometry.normalizationScale <= 0.9);
  if (lowLevel == null) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "No near-black level is safe for the radiometry exposure");
  }
  const leaseToken = text(value.leaseToken, "leaseToken", 128);
  if (!LEASE_TOKEN.test(leaseToken)) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "leaseToken must contain 32-128 URL-safe random characters");
  }
  return {
    verificationId,
    leaseToken,
    calibrationSessionId,
    nodeId: text(value.nodeId, "nodeId", 128),
    project: {
      id: text(project.id, "project.id", 128),
      baseRevision,
      appliedRevision,
    },
    rendererAcknowledgedAt: iso(value.rendererAcknowledgedAt, "rendererAcknowledgedAt"),
    camera,
    lensProfile,
    exposureProfiles,
    outputs,
    blackFloorBaselines,
    ...measuredNormalization,
    rendererCorrectionBinding,
    overlapBands,
    mesh,
    nearBlackLevels,
    lowLevel,
    settleFrames: integer(value.settleFrames, "settleFrames", 1, 120),
  };
}

export function createCameraOpticalVerificationPlan(input, options = {}) {
  const source = normalizePlanSource(input, options);
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: source.verificationId,
    leaseToken: source.leaseToken,
    calibrationSessionId: source.calibrationSessionId,
    nodeId: source.nodeId,
    project: source.project,
    rendererAcknowledgedAt: source.rendererAcknowledgedAt,
    camera: source.camera,
    lensProfile: source.lensProfile,
    exposureProfiles: source.exposureProfiles,
    outputs: source.outputs,
    blackFloorBaselines: source.blackFloorBaselines,
    globalMeasuredNormalizationScale: source.globalMeasuredNormalizationScale,
    globalNormalizationRelativeUncertainty: source.globalNormalizationRelativeUncertainty,
    rendererCorrectionBinding: source.rendererCorrectionBinding,
    overlapBands: source.overlapBands,
    mesh: source.mesh,
    nearBlackLevels: source.nearBlackLevels,
    lowLevel: source.lowLevel,
    settleFrames: source.settleFrames,
    expectedPipeline: {
      captureMode: "single-shot",
      shutterModes: ["mechanical", "efcs"],
      rawEncodings: ["uncompressed", "lossless-compressed"],
      bitDepth: CAMERA_OPTICAL_VERIFICATION_LIMITS.pipeline.bitDepth,
      retainedPixelFormat: CAMERA_OPTICAL_VERIFICATION_LIMITS.pipeline.retainedPixelFormat,
      linearized: true,
      blackLevelSubtracted: false,
      whiteBalanceApplied: false,
      toneCurveApplied: false,
      noiseReductionApplied: false,
      lensCorrectionsApplied: false,
    },
    gates: deepFreeze(buildVerificationGates(source)),
    steps: createSteps(source),
  };
}

export function normalizeCameraOpticalVerificationPlan(input, options = {}) {
  const value = exactObject(input, "verification plan", [
    "schemaVersion", "verificationId", "leaseToken", "calibrationSessionId", "nodeId", "project",
    "rendererAcknowledgedAt", "camera", "lensProfile", "exposureProfiles", "outputs",
    "blackFloorBaselines", "globalMeasuredNormalizationScale", "globalNormalizationRelativeUncertainty",
    "rendererCorrectionBinding", "overlapBands", "mesh",
    "nearBlackLevels", "lowLevel", "settleFrames", "expectedPipeline", "gates", "steps",
  ]);
  if (value.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION) {
    fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", `schemaVersion must be ${CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION}`);
  }
  const expected = createCameraOpticalVerificationPlan({
    verificationId: value.verificationId,
    leaseToken: value.leaseToken,
    calibrationSessionId: value.calibrationSessionId,
    nodeId: value.nodeId,
    project: value.project,
    rendererAcknowledgedAt: value.rendererAcknowledgedAt,
    camera: value.camera,
    lensProfile: value.lensProfile,
    exposureProfiles: value.exposureProfiles,
    outputs: value.outputs,
    blackFloorBaselines: value.blackFloorBaselines,
    rendererCorrectionBinding: value.rendererCorrectionBinding,
    mesh: value.mesh,
    nearBlackLevels: value.nearBlackLevels,
    settleFrames: value.settleFrames,
  }, options);
  return assertCanonicalEqual(value, expected, "verification plan");
}

function normalizeRendererEvidence(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const value = exactObject(input, "report.renderer", [
    "nodeProjectRevision", "rendererProjectRevision", "connected", "ready", "acknowledgedAt",
    "capabilities", "outputBindings", "activeCorrectionBinding", "activeCorrectionFingerprint",
  ], code);
  let activeCorrectionBinding;
  try {
    activeCorrectionBinding = normalizeRendererCorrectionBinding(
      value.activeCorrectionBinding,
      "report.renderer.activeCorrectionBinding",
    );
  } catch (error) {
    fail(
      error?.code || "INVALID_RENDERER_CORRECTION_BINDING",
      error?.message || "report.renderer.activeCorrectionBinding is invalid",
      error?.details,
    );
  }
  assertCanonicalEqual(
    activeCorrectionBinding,
    plan.rendererCorrectionBinding,
    "report.renderer.activeCorrectionBinding",
    "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
  );
  if (value.activeCorrectionFingerprint !== plan.rendererCorrectionBinding.fingerprint
    || value.activeCorrectionFingerprint !== activeCorrectionBinding.fingerprint) {
    fail(
      "OPTICAL_VERIFICATION_RENDERER_CORRECTION_MISMATCH",
      "Renderer correction fingerprint differs from the immutable applied correction receipt",
    );
  }
  const capabilities = exactObject(value.capabilities, "report.renderer.capabilities", [
    "correctedSolid", "rawGrayCode", "preservesWarp", "targetIsolation",
  ], code);
  const normalizedCapabilities = {
    correctedSolid: boolean(capabilities.correctedSolid, "report.renderer.capabilities.correctedSolid", code),
    rawGrayCode: boolean(capabilities.rawGrayCode, "report.renderer.capabilities.rawGrayCode", code),
    preservesWarp: boolean(capabilities.preservesWarp, "report.renderer.capabilities.preservesWarp", code),
    targetIsolation: boolean(capabilities.targetIsolation, "report.renderer.capabilities.targetIsolation", code),
  };
  if (Object.values(normalizedCapabilities).some((entry) => entry !== true)) {
    fail(code, "Renderer verification capabilities must all be true");
  }
  if (!Array.isArray(value.outputBindings) || value.outputBindings.length !== plan.outputs.length) {
    fail(code, "Renderer outputBindings must cover every verified output exactly once");
  }
  const outputBindings = value.outputBindings.map((binding, index) => {
    const field = `report.renderer.outputBindings[${index}]`;
    const item = exactObject(binding, field, ["outputId", "calibrationSessionId"], code);
    return {
      outputId: text(item.outputId, `${field}.outputId`, 64, code),
      calibrationSessionId: text(item.calibrationSessionId, `${field}.calibrationSessionId`, 128, code),
    };
  });
  const expectedBindings = plan.outputs.map((output) => ({
    outputId: output.id,
    calibrationSessionId: plan.calibrationSessionId,
  }));
  assertCanonicalEqual(outputBindings, expectedBindings, "report.renderer.outputBindings", code);
  const nodeProjectRevision = integer(
    value.nodeProjectRevision, "report.renderer.nodeProjectRevision", 1, Number.MAX_SAFE_INTEGER, code,
  );
  const rendererProjectRevision = integer(
    value.rendererProjectRevision, "report.renderer.rendererProjectRevision", 1, Number.MAX_SAFE_INTEGER, code,
  );
  if (nodeProjectRevision !== plan.project.appliedRevision || rendererProjectRevision !== plan.project.appliedRevision) {
    fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", "Node and renderer must both verify the exact applied project revision");
  }
  const acknowledgedAt = iso(value.acknowledgedAt, "report.renderer.acknowledgedAt", code);
  if (acknowledgedAt !== plan.rendererAcknowledgedAt) {
    fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", "Renderer acknowledgement timestamp does not match the verification lease");
  }
  if (value.connected !== true || value.ready !== true) {
    fail(code, "Renderer must remain connected and ready throughout optical verification");
  }
  return {
    nodeProjectRevision,
    rendererProjectRevision,
    connected: true,
    ready: true,
    acknowledgedAt,
    capabilities: normalizedCapabilities,
    outputBindings,
    activeCorrectionBinding,
    activeCorrectionFingerprint: activeCorrectionBinding.fingerprint,
  };
}

function normalizeLensEvidence(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const value = exactObject(input, "report.provenance.lens", [
    "vendor", "model", "serial", "focalLengthMm", "apertureF", "focusDistanceM",
    "focusLocked", "zoomLocked", "stabilization",
  ], code);
  const lens = {
    vendor: text(value.vendor, "report.provenance.lens.vendor", 128, code),
    model: text(value.model, "report.provenance.lens.model", 128, code),
    serial: text(value.serial, "report.provenance.lens.serial", 128, code),
    focalLengthMm: finite(value.focalLengthMm, "report.provenance.lens.focalLengthMm", 1, 2_000, code),
    apertureF: finite(value.apertureF, "report.provenance.lens.apertureF", 0.5, 64, code),
    focusDistanceM: finite(value.focusDistanceM, "report.provenance.lens.focusDistanceM", 0.05, 100_000, code),
    focusLocked: boolean(value.focusLocked, "report.provenance.lens.focusLocked", code),
    zoomLocked: boolean(value.zoomLocked, "report.provenance.lens.zoomLocked", code),
    stabilization: text(value.stabilization, "report.provenance.lens.stabilization", 32, code),
  };
  const expected = plan.lensProfile;
  const focusTolerance = Math.max(0.02, expected.capture.focusDistanceM * 0.02);
  if (lens.vendor !== expected.lens.manufacturer || lens.model !== expected.lens.model
    || lens.serial !== expected.lens.serialNumber
    || Math.abs(lens.focalLengthMm - expected.capture.focalLengthMm) > 0.05
    || Math.abs(lens.apertureF - expected.capture.apertureFNumber) > 0.05
    || Math.abs(lens.focusDistanceM - expected.capture.focusDistanceM) > focusTolerance
    || lens.focusLocked !== true || lens.zoomLocked !== true || lens.stabilization !== "off") {
    fail("OPTICAL_VERIFICATION_LENS_MISMATCH", "Verification lens evidence does not match the fixed calibrated lens state");
  }
  return lens;
}

function normalizePipelineEvidence(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const value = exactObject(input, "report.provenance.pipeline", [
    "captureMode", "shutterMode", "rawEncoding", "sourcePixelFormat", "retainedPixelFormat",
    "bitDepth", "linearized", "blackLevelSubtracted", "whiteBalanceApplied", "toneCurveApplied",
    "noiseReductionApplied", "lensCorrectionsApplied",
  ], code);
  const pipeline = {
    captureMode: text(value.captureMode, "report.provenance.pipeline.captureMode", 32, code),
    shutterMode: text(value.shutterMode, "report.provenance.pipeline.shutterMode", 32, code),
    rawEncoding: text(value.rawEncoding, "report.provenance.pipeline.rawEncoding", 64, code),
    sourcePixelFormat: text(value.sourcePixelFormat, "report.provenance.pipeline.sourcePixelFormat", 128, code),
    retainedPixelFormat: text(value.retainedPixelFormat, "report.provenance.pipeline.retainedPixelFormat", 64, code),
    bitDepth: integer(value.bitDepth, "report.provenance.pipeline.bitDepth", 1, 32, code),
    linearized: boolean(value.linearized, "report.provenance.pipeline.linearized", code),
    blackLevelSubtracted: boolean(value.blackLevelSubtracted, "report.provenance.pipeline.blackLevelSubtracted", code),
    whiteBalanceApplied: boolean(value.whiteBalanceApplied, "report.provenance.pipeline.whiteBalanceApplied", code),
    toneCurveApplied: boolean(value.toneCurveApplied, "report.provenance.pipeline.toneCurveApplied", code),
    noiseReductionApplied: boolean(value.noiseReductionApplied, "report.provenance.pipeline.noiseReductionApplied", code),
    lensCorrectionsApplied: boolean(value.lensCorrectionsApplied, "report.provenance.pipeline.lensCorrectionsApplied", code),
  };
  const expected = plan.expectedPipeline;
  if (pipeline.captureMode !== expected.captureMode
    || !expected.shutterModes.includes(pipeline.shutterMode)
    || !expected.rawEncodings.includes(pipeline.rawEncoding)
    || pipeline.retainedPixelFormat !== expected.retainedPixelFormat
    || pipeline.bitDepth !== expected.bitDepth
    || pipeline.linearized !== expected.linearized
    || pipeline.blackLevelSubtracted !== expected.blackLevelSubtracted
    || pipeline.whiteBalanceApplied !== expected.whiteBalanceApplied
    || pipeline.toneCurveApplied !== expected.toneCurveApplied
    || pipeline.noiseReductionApplied !== expected.noiseReductionApplied
    || pipeline.lensCorrectionsApplied !== expected.lensCorrectionsApplied) {
    fail("OPTICAL_VERIFICATION_PIPELINE_MISMATCH", "Verification capture pipeline is not the required unprocessed 14-bit RAW path");
  }
  return pipeline;
}

function patternParameters(pattern) {
  if (pattern.type === "solid") return { rgb: [...pattern.rgb], applyCorrections: pattern.applyCorrections === true };
  return { axis: pattern.axis, bit: pattern.bit, inverse: pattern.inverse === true };
}

function confirmationLeaseScopes(plan) {
  const scopes = [];
  const seen = new Set();
  for (const step of plan.steps) {
    if (step.captureConditions.requiresOperatorConfirmation !== true) {
      fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "Every optical capture step requires a physical-condition lease");
    }
    const leaseId = step.captureConditions.confirmationLeaseId;
    const current = scopes.at(-1);
    if (current?.confirmationLeaseId === leaseId) {
      current.lastStepId = step.id;
      current.stepCount += 1;
      continue;
    }
    if (seen.has(leaseId)) {
      fail("INVALID_OPTICAL_VERIFICATION_CONTRACT", "A physical-condition lease cannot reappear after another lease");
    }
    seen.add(leaseId);
    scopes.push({
      confirmationLeaseId: leaseId,
      firstStepId: step.id,
      lastStepId: step.id,
      stepCount: 1,
    });
  }
  const expectedLeaseIds = [
    "verification-sensor-dark",
    "verification-ambient",
    "verification-projectors-on",
  ];
  if (canonicalJson(scopes.map((scope) => scope.confirmationLeaseId)) !== canonicalJson(expectedLeaseIds)) {
    fail(
      "INVALID_OPTICAL_VERIFICATION_CONTRACT",
      "An optical plan must contain exactly the sensor-dark, ambient and projectors-on condition leases",
    );
  }
  return scopes;
}

function normalizeConfirmations(input, plan, startedAt, completedAt) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const scopes = confirmationLeaseScopes(plan);
  if (!Array.isArray(input) || input.length !== scopes.length) {
    fail(code, "Terminal evidence must contain exactly three physical-condition confirmation leases");
  }
  const confirmationIds = new Set();
  const commandIds = new Set();
  let priorConfirmedAt = startedAt;
  let priorCommandSequence = -1;
  return input.map((entry, index) => {
    const field = `report.confirmations[${index}]`;
    const value = exactObject(entry, field, [
      "confirmationId", "confirmationLeaseId", "firstStepId", "lastStepId", "stepCount",
      "confirmedAt", "serverCommandId", "serverCommandSequence",
    ], code);
    const expected = scopes[index];
    if (value.confirmationLeaseId !== expected.confirmationLeaseId
      || value.firstStepId !== expected.firstStepId
      || value.lastStepId !== expected.lastStepId
      || value.stepCount !== expected.stepCount) {
      fail(code, `${field} is swapped or does not cover its exact contiguous plan-step scope`);
    }
    const confirmationId = text(value.confirmationId, `${field}.confirmationId`, 128, code);
    if (!LEASE_TOKEN.test(confirmationId) || confirmationIds.has(confirmationId)) {
      fail(code, `${field}.confirmationId must be a unique 32-128 character random identifier`);
    }
    confirmationIds.add(confirmationId);
    const serverCommandId = text(value.serverCommandId, `${field}.serverCommandId`, 128, code);
    if (commandIds.has(serverCommandId)) fail(code, `${field}.serverCommandId must be unique`);
    commandIds.add(serverCommandId);
    const serverCommandSequence = integer(
      value.serverCommandSequence,
      `${field}.serverCommandSequence`,
      1,
      Number.MAX_SAFE_INTEGER,
      code,
    );
    if (serverCommandSequence <= priorCommandSequence) {
      fail(code, `${field}.serverCommandSequence must increase across physical-condition confirmations`);
    }
    priorCommandSequence = serverCommandSequence;
    const confirmedAt = iso(value.confirmedAt, `${field}.confirmedAt`, code);
    if (Date.parse(confirmedAt) <= Date.parse(priorConfirmedAt)
      || Date.parse(confirmedAt) > Date.parse(completedAt)) {
      fail(code, `${field}.confirmedAt must increase inside the verification interval`);
    }
    priorConfirmedAt = confirmedAt;
    return {
      confirmationId,
      confirmationLeaseId: expected.confirmationLeaseId,
      firstStepId: expected.firstStepId,
      lastStepId: expected.lastStepId,
      stepCount: expected.stepCount,
      confirmedAt,
      serverCommandId,
      serverCommandSequence,
    };
  });
}

function normalizePresentations(input, plan, startedAt, completedAt) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const expectedSteps = plan.steps.filter((step) => step.pattern != null);
  if (!Array.isArray(input) || input.length !== expectedSteps.length) {
    fail(code, "Pattern presentation evidence must cover every projected verification step exactly once");
  }
  let priorPresentedAt = startedAt;
  return input.map((entry, index) => {
    const field = `report.presentations[${index}]`;
    const value = exactObject(entry, field, [
      "stepId", "projectRevision", "outputId", "pattern", "outputs", "presentedAt",
    ], code);
    const step = expectedSteps[index];
    if (value.stepId !== step.id || value.outputId !== step.outputId) {
      fail(code, `${field} is out of deterministic step order`);
    }
    const projectRevision = integer(value.projectRevision, `${field}.projectRevision`, 1, Number.MAX_SAFE_INTEGER, code);
    if (projectRevision !== plan.project.appliedRevision) {
      fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", `${field} was presented under another project revision`);
    }
    const suppliedPattern = exactObject(
      value.pattern,
      `${field}.pattern`,
      Object.keys(step.pattern),
      code,
    );
    assertCanonicalEqual(suppliedPattern, step.pattern, `${field}.pattern`, code);
    if (!Array.isArray(value.outputs) || value.outputs.length !== plan.outputs.length) {
      fail(code, `${field}.outputs must cover every active verification output`);
    }
    const outputs = value.outputs.map((outputEvidence, outputIndex) => {
      const outputField = `${field}.outputs[${outputIndex}]`;
      const output = exactObject(outputEvidence, outputField, [
        "id", "pattern", "patternParameters", "correctionsBypassed", "processingBypass",
        "blank", "renderedFramesBefore", "renderedFramesAfter",
      ], code);
      const expectedOutput = plan.outputs[outputIndex];
      if (output.id !== expectedOutput.id) fail(code, `${outputField}.id is out of authoritative output order`);
      const targeted = step.outputId == null || step.outputId === expectedOutput.id;
      const expectedPattern = targeted ? step.pattern.type : "black";
      const expectedParameters = targeted ? patternParameters(step.pattern) : {};
      const expectedBypass = !targeted || step.pattern.applyCorrections !== true;
      if (output.pattern !== expectedPattern
        || canonicalJson(output.patternParameters) !== canonicalJson(expectedParameters)
        || output.correctionsBypassed !== expectedBypass
        || output.processingBypass !== false
        || output.blank !== false) {
        fail(code, `${outputField} does not prove the requested raw/corrected pattern path`, {
          expectedPattern,
          expectedParameters,
          expectedBypass,
        });
      }
      const before = integer(output.renderedFramesBefore, `${outputField}.renderedFramesBefore`, 0, Number.MAX_SAFE_INTEGER, code);
      const after = integer(output.renderedFramesAfter, `${outputField}.renderedFramesAfter`, 0, Number.MAX_SAFE_INTEGER, code);
      if (after - before < step.settleFrames) {
        fail(code, `${outputField} did not present the required settled frames`);
      }
      return {
        id: output.id,
        pattern: output.pattern,
        patternParameters: expectedParameters,
        correctionsBypassed: output.correctionsBypassed,
        processingBypass: false,
        blank: false,
        renderedFramesBefore: before,
        renderedFramesAfter: after,
      };
    });
    const presentedAt = iso(value.presentedAt, `${field}.presentedAt`, code);
    if (Date.parse(presentedAt) < Date.parse(startedAt)
      || Date.parse(presentedAt) < Date.parse(priorPresentedAt)
      || Date.parse(presentedAt) > Date.parse(completedAt)) {
      fail(code, `${field}.presentedAt is outside or out of order in the verification interval`);
    }
    priorPresentedAt = presentedAt;
    return {
      stepId: step.id,
      projectRevision,
      outputId: step.outputId,
      pattern: step.pattern,
      outputs,
      presentedAt,
    };
  });
}

function normalizeCaptures(input, plan, startedAt, completedAt, presentations, confirmations) {
  const code = "INVALID_OPTICAL_VERIFICATION_EVIDENCE";
  const expected = plan.steps.flatMap((step) => Array.from({ length: step.repeats }, (_, repeat) => ({ step, repeat })));
  if (!Array.isArray(input) || input.length !== expected.length) {
    fail(code, "Capture evidence must cover every verification repeat exactly once");
  }
  const digests = new Set();
  const presentationTimes = new Map(presentations.map((entry) => [entry.stepId, entry.presentedAt]));
  const confirmationWindows = new Map(confirmations.map((entry, index) => [
    entry.confirmationLeaseId,
    {
      confirmedAt: entry.confirmedAt,
      supersededAt: confirmations[index + 1]?.confirmedAt ?? null,
    },
  ]));
  let priorCapturedAt = startedAt;
  return input.map((entry, index) => {
    const field = `report.captures[${index}]`;
    const value = exactObject(entry, field, [
      "id", "stepId", "repeat", "capturedAt", "sourceSha256", "width", "height",
      "bitDepth", "linearized", "exposureProfileId",
    ], code);
    const expectedCapture = expected[index];
    const expectedId = `${expectedCapture.step.id}#${expectedCapture.repeat}`;
    if (value.id !== expectedId || value.stepId !== expectedCapture.step.id
      || value.repeat !== expectedCapture.repeat
      || value.exposureProfileId !== expectedCapture.step.exposureProfileId) {
      fail(code, `${field} is missing, duplicated or out of deterministic capture order`);
    }
    if (typeof value.sourceSha256 !== "string" || !SHA256.test(value.sourceSha256) || digests.has(value.sourceSha256)) {
      fail(code, `${field}.sourceSha256 must be a unique lowercase RAW SHA-256 digest`);
    }
    digests.add(value.sourceSha256);
    const capturedAt = iso(value.capturedAt, `${field}.capturedAt`, code);
    const presentedAt = presentationTimes.get(expectedCapture.step.id) ?? startedAt;
    const confirmationWindow = confirmationWindows.get(expectedCapture.step.captureConditions.confirmationLeaseId);
    if (Date.parse(capturedAt) < Date.parse(startedAt)
      || Date.parse(capturedAt) < Date.parse(priorCapturedAt)
      || Date.parse(capturedAt) < Date.parse(presentedAt)
      || confirmationWindow == null
      || Date.parse(capturedAt) < Date.parse(confirmationWindow.confirmedAt)
      || (confirmationWindow.supersededAt != null
        && Date.parse(capturedAt) >= Date.parse(confirmationWindow.supersededAt))
      || Date.parse(capturedAt) > Date.parse(completedAt)) {
      fail(code, `${field}.capturedAt is outside, out of order or predates its settled pattern/physical-condition lease`);
    }
    priorCapturedAt = capturedAt;
    if (value.width !== plan.lensProfile.frame.width || value.height !== plan.lensProfile.frame.height
      || value.bitDepth !== plan.expectedPipeline.bitDepth || value.linearized !== true) {
      fail(code, `${field} does not match the fixed profile raster and RAW path`);
    }
    return {
      id: expectedId,
      stepId: expectedCapture.step.id,
      repeat: expectedCapture.repeat,
      capturedAt,
      sourceSha256: value.sourceSha256,
      width: integer(value.width, `${field}.width`, 2, 16_384, code),
      height: integer(value.height, `${field}.height`, 2, 16_384, code),
      bitDepth: integer(value.bitDepth, `${field}.bitDepth`, 1, 32, code),
      linearized: true,
      exposureProfileId: value.exposureProfileId,
    };
  });
}

function vector3(input, field, maximum = 1e6) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  if (!Array.isArray(input) || input.length !== 3) fail(code, `${field} must contain three channels`);
  return input.map((value, index) => finite(value, `${field}[${index}]`, 0, maximum, code));
}

function normalizeBlackFloorObservation(input, field, expected, { includeOutputBinding }) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  const keys = [
    ...(includeOutputBinding ? [
      "outputId", "blackPedestalSha256", "exposureBridgeId", "measuredNormalizationScale",
      "normalizationRelativeUncertainty",
    ] : []),
    "targetLevel", "observedP95", "absoluteDrift", "uncertaintyP95", "sampleCount",
  ];
  const value = exactObject(input, field, keys, code);
  if (includeOutputBinding && (value.outputId !== expected.outputId
    || value.blackPedestalSha256 !== expected.blackPedestalSha256
    || value.exposureBridgeId !== expected.exposureBridgeId
    || value.measuredNormalizationScale !== expected.measuredNormalizationScale
    || value.normalizationRelativeUncertainty !== expected.normalizationRelativeUncertainty)) {
    fail("OPTICAL_VERIFICATION_BASELINE_MISMATCH", `${field} is not bound to its immutable black baseline`);
  }
  const targetLevel = finite(value.targetLevel, `${field}.targetLevel`, 0, 1, code);
  if (Math.abs(targetLevel - expected.targetLevel) > EPSILON) {
    fail("OPTICAL_VERIFICATION_BASELINE_MISMATCH", `${field}.targetLevel changed from the authoritative plan`);
  }
  const observedP95 = finite(value.observedP95, `${field}.observedP95`, -1e3, 1e3, code);
  const absoluteDrift = finite(value.absoluteDrift, `${field}.absoluteDrift`, 0, 1e3, code);
  const derivedAbsoluteDrift = Math.abs(observedP95 - targetLevel);
  if (Math.abs(absoluteDrift - derivedAbsoluteDrift) > EPSILON) {
    fail(code, `${field}.absoluteDrift must equal abs(observedP95 - targetLevel)`);
  }
  return {
    ...(includeOutputBinding
      ? {
        outputId: expected.outputId,
        blackPedestalSha256: expected.blackPedestalSha256,
        exposureBridgeId: expected.exposureBridgeId,
        measuredNormalizationScale: expected.measuredNormalizationScale,
        normalizationRelativeUncertainty: expected.normalizationRelativeUncertainty,
      }
      : {}),
    targetLevel,
    observedP95,
    absoluteDrift: derivedAbsoluteDrift,
    uncertaintyP95: finite(value.uncertaintyP95, `${field}.uncertaintyP95`, 0, 1e3, code),
    sampleCount: integer(value.sampleCount, `${field}.sampleCount`, 1, Number.MAX_SAFE_INTEGER, code),
  };
}

function normalizeBlackFloorMetrics(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  const value = exactObject(input, "report.metrics.blackFloor", [
    "measurementBasis", "exposureProfileId", "normalizationScale", "globalMeasuredNormalizationScale",
    "globalNormalizationRelativeUncertainty", "global", "outputs",
  ], code);
  const profile = plan.exposureProfiles.find((candidate) => candidate.role === "radiometry");
  if (value.measurementBasis !== CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS
    || value.exposureProfileId !== profile.id
    || value.normalizationScale !== profile.normalizationScale
    || value.globalMeasuredNormalizationScale !== plan.globalMeasuredNormalizationScale
    || value.globalNormalizationRelativeUncertainty !== plan.globalNormalizationRelativeUncertainty) {
    fail(
      "OPTICAL_VERIFICATION_BASELINE_MISMATCH",
      "blackFloor metrics do not use the matched long-exposure profile and short-unit normalization",
    );
  }
  if (!Array.isArray(value.outputs) || value.outputs.length !== plan.blackFloorBaselines.length) {
    fail(code, "blackFloor.outputs must cover every immutable output baseline exactly once");
  }
  const outputs = value.outputs.map((entry, index) => normalizeBlackFloorObservation(
    entry,
    `report.metrics.blackFloor.outputs[${index}]`,
    plan.blackFloorBaselines[index],
    { includeOutputBinding: true },
  ));
  const globalTarget = Math.max(...plan.blackFloorBaselines.map((baseline) => baseline.targetLevel));
  const global = normalizeBlackFloorObservation(
    value.global,
    "report.metrics.blackFloor.global",
    { targetLevel: globalTarget },
    { includeOutputBinding: false },
  );
  return {
    measurementBasis: CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS,
    exposureProfileId: profile.id,
    normalizationScale: profile.normalizationScale,
    globalMeasuredNormalizationScale: plan.globalMeasuredNormalizationScale,
    globalNormalizationRelativeUncertainty: plan.globalNormalizationRelativeUncertainty,
    global,
    outputs,
  };
}

function normalizeOverlapBandMetrics(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  if (!Array.isArray(input) || input.length !== plan.overlapBands.length) {
    fail(code, "overlapBands metrics must cover every planned overlap/shared edge exactly once");
  }
  return input.map((entry, index) => {
    const field = `report.metrics.overlapBands[${index}]`;
    const value = exactObject(entry, field, [
      "bandId", "outputIds", "relation", "measurementBasis", "exposureProfileId",
      "normalizationScale", "expectedLevel", "sampleCount", "coverage", "analysisBandWidthPx",
      "boundaryResidualP95", "boundaryResidualMax",
    ], code);
    const expected = plan.overlapBands[index];
    if (value.bandId !== expected.id
      || canonicalJson(value.outputIds) !== canonicalJson(expected.outputIds)
      || value.relation !== expected.relation
      || value.measurementBasis !== expected.measurementBasis
      || value.exposureProfileId !== expected.exposureProfileId
      || value.normalizationScale !== expected.normalizationScale
      || value.expectedLevel !== expected.expectedLevel) {
      fail(code, `${field} is not bound to the authoritative overlap-band sampling plan`);
    }
    const boundaryResidualP95 = finite(
      value.boundaryResidualP95,
      `${field}.boundaryResidualP95`,
      0,
      1e6,
      code,
    );
    const boundaryResidualMax = finite(
      value.boundaryResidualMax,
      `${field}.boundaryResidualMax`,
      0,
      1e6,
      code,
    );
    if (boundaryResidualMax + EPSILON < boundaryResidualP95) {
      fail(code, `${field}.boundaryResidualMax cannot be less than its P95`);
    }
    return {
      bandId: expected.id,
      outputIds: [...expected.outputIds],
      relation: expected.relation,
      measurementBasis: expected.measurementBasis,
      exposureProfileId: expected.exposureProfileId,
      normalizationScale: expected.normalizationScale,
      expectedLevel: expected.expectedLevel,
      sampleCount: integer(value.sampleCount, `${field}.sampleCount`, 0, Number.MAX_SAFE_INTEGER, code),
      coverage: finite(value.coverage, `${field}.coverage`, 0, 1, code),
      analysisBandWidthPx: finite(value.analysisBandWidthPx, `${field}.analysisBandWidthPx`, 0, 1e6, code),
      boundaryResidualP95,
      boundaryResidualMax,
    };
  });
}

function normalizeMetrics(input, plan) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  const value = exactObject(input, "report.metrics", [
    "geometry", "radiometry", "combined", "blackFloor", "overlapBands",
  ], code);
  if (!Array.isArray(value.geometry) || value.geometry.length !== plan.outputs.length
    || !Array.isArray(value.radiometry) || value.radiometry.length !== plan.outputs.length) {
    fail(code, "Geometry and radiometry metrics must cover every verified output exactly once");
  }
  const geometry = value.geometry.map((entry, index) => {
    const field = `report.metrics.geometry[${index}]`;
    const metric = exactObject(entry, field, [
      "outputId", "holes", "confidence", "targetResidualP95Px", "targetResidualMaxPx",
      "projectorDriftP95Px", "projectorDriftMaxPx", "pixelCoverage", "tileCoverage", "clippedFraction",
    ], code);
    if (metric.outputId !== plan.outputs[index].id) fail(code, `${field}.outputId is out of authoritative order`);
    return {
      outputId: metric.outputId,
      holes: integer(metric.holes, `${field}.holes`, 0, Number.MAX_SAFE_INTEGER, code),
      confidence: finite(metric.confidence, `${field}.confidence`, 0, 1, code),
      targetResidualP95Px: finite(metric.targetResidualP95Px, `${field}.targetResidualP95Px`, 0, 1e6, code),
      targetResidualMaxPx: finite(metric.targetResidualMaxPx, `${field}.targetResidualMaxPx`, 0, 1e6, code),
      projectorDriftP95Px: finite(metric.projectorDriftP95Px, `${field}.projectorDriftP95Px`, 0, 1e6, code),
      projectorDriftMaxPx: finite(metric.projectorDriftMaxPx, `${field}.projectorDriftMaxPx`, 0, 1e6, code),
      pixelCoverage: finite(metric.pixelCoverage, `${field}.pixelCoverage`, 0, 1, code),
      tileCoverage: finite(metric.tileCoverage, `${field}.tileCoverage`, 0, 1, code),
      clippedFraction: finite(metric.clippedFraction, `${field}.clippedFraction`, 0, 1, code),
    };
  });
  const radiometry = value.radiometry.map((entry, index) => {
    const field = `report.metrics.radiometry[${index}]`;
    const metric = exactObject(entry, field, [
      "outputId", "coverage", "clippedFraction", "normalSnrDb", "nearBlackSnrDb",
      "relativeUncertainty", "neutralRatioRelativeErrorRgb", "nearBlackRelativeErrorRgb",
      "primaryRmse", "primaryMaxError",
    ], code);
    if (metric.outputId !== plan.outputs[index].id) fail(code, `${field}.outputId is out of authoritative order`);
    return {
      outputId: metric.outputId,
      coverage: finite(metric.coverage, `${field}.coverage`, 0, 1, code),
      clippedFraction: finite(metric.clippedFraction, `${field}.clippedFraction`, 0, 1, code),
      normalSnrDb: finite(metric.normalSnrDb, `${field}.normalSnrDb`, -100, 300, code),
      nearBlackSnrDb: finite(metric.nearBlackSnrDb, `${field}.nearBlackSnrDb`, -100, 300, code),
      relativeUncertainty: finite(metric.relativeUncertainty, `${field}.relativeUncertainty`, 0, 1, code),
      neutralRatioRelativeErrorRgb: vector3(metric.neutralRatioRelativeErrorRgb, `${field}.neutralRatioRelativeErrorRgb`),
      nearBlackRelativeErrorRgb: vector3(metric.nearBlackRelativeErrorRgb, `${field}.nearBlackRelativeErrorRgb`),
      primaryRmse: finite(metric.primaryRmse, `${field}.primaryRmse`, 0, 1e6, code),
      primaryMaxError: finite(metric.primaryMaxError, `${field}.primaryMaxError`, 0, 1e6, code),
    };
  });
  const combinedValue = exactObject(value.combined, "report.metrics.combined", [
    "blackUncertaintyP95", "blackNonuniformityRange", "negativeBeyondUncertaintyFraction",
    "seamResidualP95", "seamResidualMax",
  ], code);
  const combined = {
    blackUncertaintyP95: finite(combinedValue.blackUncertaintyP95, "report.metrics.combined.blackUncertaintyP95", 0, 1, code),
    blackNonuniformityRange: finite(combinedValue.blackNonuniformityRange, "report.metrics.combined.blackNonuniformityRange", 0, 1, code),
    negativeBeyondUncertaintyFraction: finite(
      combinedValue.negativeBeyondUncertaintyFraction,
      "report.metrics.combined.negativeBeyondUncertaintyFraction",
      0,
      1,
      code,
    ),
    seamResidualP95: finite(combinedValue.seamResidualP95, "report.metrics.combined.seamResidualP95", 0, 1e6, code),
    seamResidualMax: finite(combinedValue.seamResidualMax, "report.metrics.combined.seamResidualMax", 0, 1e6, code),
  };
  const blackFloor = normalizeBlackFloorMetrics(value.blackFloor, plan);
  const overlapBands = normalizeOverlapBandMetrics(value.overlapBands, plan);
  return { geometry, radiometry, combined, blackFloor, overlapBands };
}

export function evaluateCameraOpticalVerification(metricsInput, planInput, options = {}) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, options);
  const metrics = normalizeMetrics(metricsInput, plan);
  const failedGateIds = [];
  const geometryGates = plan.gates.geometry;
  for (const metric of metrics.geometry) {
    const checks = [
      ["holes", metric.holes === 0],
      ["confidence", metric.confidence >= geometryGates.minimumConfidence],
      ["target-residual-p95", metric.targetResidualP95Px <= geometryGates.maximumTargetResidualP95Px],
      ["target-residual-max", metric.targetResidualMaxPx <= geometryGates.maximumTargetResidualMaxPx],
      ["projector-drift-p95", metric.projectorDriftP95Px <= geometryGates.maximumProjectorDriftP95Px],
      ["projector-drift-max", metric.projectorDriftMaxPx <= geometryGates.maximumProjectorDriftMaxPx],
      ["pixel-coverage", metric.pixelCoverage >= geometryGates.minimumPixelCoverage],
      ["tile-coverage", metric.tileCoverage >= geometryGates.minimumTileCoverage],
      ["clipping", metric.clippedFraction <= geometryGates.maximumClippedFraction],
    ];
    for (const [gate, passed] of checks) if (!passed) failedGateIds.push(`geometry:${metric.outputId}:${gate}`);
  }
  const radiometryGates = plan.gates.radiometry;
  for (const metric of metrics.radiometry) {
    const checks = [
      ["coverage", metric.coverage >= radiometryGates.minimumCoverage],
      ["clipping", metric.clippedFraction <= radiometryGates.maximumClippedFraction],
      ["normal-snr", metric.normalSnrDb >= radiometryGates.minimumNormalSnrDb],
      ["near-black-snr", metric.nearBlackSnrDb >= radiometryGates.minimumNearBlackSnrDb],
      ["uncertainty", metric.relativeUncertainty <= radiometryGates.maximumRelativeUncertainty],
      ["neutral-ratio", Math.max(...metric.neutralRatioRelativeErrorRgb) <= radiometryGates.maximumNeutralRatioRelativeError],
      ["near-black-ratio", Math.max(...metric.nearBlackRelativeErrorRgb) <= radiometryGates.maximumNearBlackRelativeError],
      ["primary-rmse", metric.primaryRmse <= radiometryGates.maximumPrimaryRmse],
      ["primary-max", metric.primaryMaxError <= radiometryGates.maximumPrimaryError],
    ];
    for (const [gate, passed] of checks) if (!passed) failedGateIds.push(`radiometry:${metric.outputId}:${gate}`);
  }
  const combined = metrics.combined;
  const combinedGates = plan.gates.combined;
  const allowedBlackRange = Math.max(
    combinedGates.maximumBlackNonuniformityRange,
    combinedGates.blackUncertaintyMultiplier * combined.blackUncertaintyP95,
  );
  for (const [gate, passed] of [
    ["black-uncertainty", combined.blackUncertaintyP95 <= combinedGates.maximumBlackUncertaintyP95],
    ["black-nonuniformity", combined.blackNonuniformityRange <= allowedBlackRange],
    ["negative-black", combined.negativeBeyondUncertaintyFraction <= combinedGates.maximumNegativeBeyondUncertaintyFraction],
  ]) if (!passed) failedGateIds.push(`combined:${gate}`);

  const blackFloorGates = plan.gates.blackFloor;
  for (const [id, observation] of [
    ["global", metrics.blackFloor.global],
    ...metrics.blackFloor.outputs.map((entry) => [entry.outputId, entry]),
  ]) {
    const maximumAllowedDrift = Math.max(
      blackFloorGates.maximumAbsoluteDrift,
      blackFloorGates.uncertaintyMultiplier * observation.uncertaintyP95,
    );
    for (const [gate, passed] of [
      ["absolute-drift", observation.absoluteDrift <= maximumAllowedDrift],
      ["uncertainty", observation.uncertaintyP95 <= blackFloorGates.maximumUncertaintyP95],
      ["sample-count", observation.sampleCount >= blackFloorGates.minimumSampleCount],
    ]) if (!passed) failedGateIds.push(`black-floor:${id}:${gate}`);
  }

  const overlapGates = plan.gates.overlapBands;
  for (const band of metrics.overlapBands) {
    for (const [gate, passed] of [
      ["sample-count", band.sampleCount >= overlapGates.minimumSampleCount],
      ["coverage", band.coverage >= overlapGates.minimumCoverage],
      ["analysis-band-width", band.analysisBandWidthPx >= overlapGates.minimumAnalysisBandWidthPx],
      ["boundary-residual-p95", band.boundaryResidualP95 <= overlapGates.maximumBoundaryResidualP95],
      ["boundary-residual-max", band.boundaryResidualMax <= overlapGates.maximumBoundaryResidualMax],
    ]) if (!passed) failedGateIds.push(`overlap-band:${band.bandId}:${gate}`);
  }
  return {
    passed: failedGateIds.length === 0,
    failedGateIds,
    gates: structuredClone(plan.gates),
    metrics,
  };
}

function normalizeFailure(input, field, required) {
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  if (input == null) {
    if (required) fail(code, `${field} is required for a failed verification`);
    return null;
  }
  const value = exactObject(input, field, ["code", "message", "details"], code);
  return {
    code: text(value.code, `${field}.code`, 128, code),
    message: text(value.message, `${field}.message`, 2_048, code),
    details: value.details ?? null,
  };
}

export function normalizeCameraOpticalVerificationReport(input, { plan: planInput, now } = {}) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, { now });
  const code = "INVALID_OPTICAL_VERIFICATION_REPORT";
  const value = exactObject(input, "verification report", [
    "schemaVersion", "verificationId", "calibrationSessionId", "leaseToken", "state",
    "projectRevision", "startedAt", "completedAt", "renderer", "provenance", "presentations",
    "confirmations", "captures", "metrics", "evaluation", "failure",
  ], code);
  if (value.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION
    || value.verificationId !== plan.verificationId
    || value.calibrationSessionId !== plan.calibrationSessionId
    || value.leaseToken !== plan.leaseToken) {
    fail(code, "Verification report identity does not match its authoritative plan");
  }
  if (value.projectRevision !== plan.project.appliedRevision) {
    fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", "Verification report revision does not match the applied revision");
  }
  const state = text(value.state, "report.state", 64, code);
  if (![CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED, CAMERA_OPTICAL_VERIFICATION_STATE.FAILED].includes(state)) {
    fail(code, "A conclusive verification report state must be verified or failed");
  }
  const startedAt = iso(value.startedAt, "report.startedAt", code);
  const completedAt = iso(value.completedAt, "report.completedAt", code);
  if (Date.parse(startedAt) < Date.parse(plan.rendererAcknowledgedAt)
    || Date.parse(completedAt) < Date.parse(startedAt)) {
    fail(code, "Verification report interval is invalid or predates renderer acknowledgement");
  }
  const renderer = normalizeRendererEvidence(value.renderer, plan);
  const provenanceValue = exactObject(value.provenance, "report.provenance", [
    "camera", "lens", "pipeline", "exposureProfiles", "lensProfileSha256",
  ], "INVALID_OPTICAL_VERIFICATION_EVIDENCE");
  const camera = normalizeStrictCamera(
    provenanceValue.camera,
    "report.provenance.camera",
    "INVALID_OPTICAL_VERIFICATION_EVIDENCE",
  );
  assertCanonicalEqual(camera, plan.camera, "report.provenance.camera", "OPTICAL_VERIFICATION_CAMERA_MISMATCH");
  const lens = normalizeLensEvidence(provenanceValue.lens, plan);
  const pipeline = normalizePipelineEvidence(provenanceValue.pipeline, plan);
  assertCanonicalEqual(
    provenanceValue.exposureProfiles,
    plan.exposureProfiles,
    "report.provenance.exposureProfiles",
    "OPTICAL_VERIFICATION_CAMERA_MISMATCH",
  );
  if (provenanceValue.lensProfileSha256 !== plan.lensProfile.sha256) {
    fail("OPTICAL_VERIFICATION_LENS_MISMATCH", "Verification report lens-profile identity changed");
  }
  const confirmations = normalizeConfirmations(value.confirmations, plan, startedAt, completedAt);
  const presentations = normalizePresentations(value.presentations, plan, startedAt, completedAt);
  const captures = normalizeCaptures(value.captures, plan, startedAt, completedAt, presentations, confirmations);
  const evaluation = evaluateCameraOpticalVerification(value.metrics, plan, { now });
  const suppliedEvaluation = exactObject(value.evaluation, "report.evaluation", [
    "passed", "failedGateIds", "gates",
  ], code);
  if (canonicalJson(suppliedEvaluation) !== canonicalJson({
    passed: evaluation.passed,
    failedGateIds: evaluation.failedGateIds,
    gates: evaluation.gates,
  })) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Reported optical result or gates do not match deterministic evaluation");
  }
  const shouldBeVerified = evaluation.passed;
  if ((state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) !== shouldBeVerified) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Verification state does not match deterministic gate results");
  }
  const failure = normalizeFailure(value.failure, "report.failure", !shouldBeVerified);
  if (shouldBeVerified && failure != null) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "A verified report cannot contain failure evidence");
  }
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    leaseToken: plan.leaseToken,
    state,
    projectRevision: plan.project.appliedRevision,
    startedAt,
    completedAt,
    renderer,
    provenance: {
      camera,
      lens,
      pipeline,
      exposureProfiles: structuredClone(plan.exposureProfiles),
      lensProfileSha256: plan.lensProfile.sha256,
    },
    confirmations,
    presentations,
    captures,
    metrics: evaluation.metrics,
    evaluation: {
      passed: evaluation.passed,
      failedGateIds: evaluation.failedGateIds,
      gates: evaluation.gates,
    },
    failure,
  };
}

function normalizeRollback(input, field) {
  const code = "INVALID_OPTICAL_VERIFICATION_STATE";
  if (input == null) return null;
  const value = exactObject(input, field, [
    "state", "trigger", "sourceRevision", "targetRevision", "reason", "rendererAcknowledgedAt", "restoredAt",
  ], code);
  const state = text(value.state, `${field}.state`, 64, code);
  if (!["pending", "renderer-ack", "restored", "blocked"].includes(state)) {
    fail(code, `${field}.state is invalid`);
  }
  const trigger = text(value.trigger, `${field}.trigger`, 64, code);
  if (!Object.values(CAMERA_OPTICAL_ROLLBACK_TRIGGER).includes(trigger)) {
    fail(code, `${field}.trigger must be failed or cancelled`);
  }
  const sourceRevision = integer(value.sourceRevision, `${field}.sourceRevision`, 1, Number.MAX_SAFE_INTEGER, code);
  const targetRevision = value.targetRevision == null
    ? null
    : integer(value.targetRevision, `${field}.targetRevision`, 1, Number.MAX_SAFE_INTEGER, code);
  if (targetRevision != null && targetRevision <= sourceRevision) {
    fail(code, `${field}.targetRevision must advance monotonically`);
  }
  return {
    state,
    trigger,
    sourceRevision,
    targetRevision,
    reason: value.reason == null ? null : text(value.reason, `${field}.reason`, 2_048, code),
    rendererAcknowledgedAt: nullableIso(value.rendererAcknowledgedAt, `${field}.rendererAcknowledgedAt`, code),
    restoredAt: nullableIso(value.restoredAt, `${field}.restoredAt`, code),
  };
}

function operatorPromptCopy(step) {
  if (step.captureConditions.confirmationLeaseId === "verification-sensor-dark") {
    return {
      title: "Block the camera optical path",
      instructions: "Fit the camera lens cap without moving the camera. Keep every projector powered, warmed and EDID-connected; stop emission only with its manufacturer-rated shutter/dowser or a tested optical mute. Never disconnect a display or place material over a hot projector lens, then confirm.",
    };
  }
  if (step.captureConditions.confirmationLeaseId === "verification-ambient") {
    return {
      title: "Open the camera optical path",
      instructions: "Remove the camera lens cap without moving the camera. Keep every projector powered, warmed and EDID-connected; stop emission only with its manufacturer-rated shutter/dowser or a tested optical mute. Never disconnect a display or place material over a hot projector lens, then confirm.",
    };
  }
  return {
    title: "Enable verification projection",
    instructions: "Keep the camera fixed and every projector powered, warmed and EDID-connected. Open the rated shutter/dowser or tested optical mute, ensure non-target projectors show digital black, never disconnect a display or cover a hot projector lens, then confirm.",
  };
}

function normalizeOperatorPrompt(input, { plan, progress, state, startedAt, updatedAt }) {
  const code = "INVALID_OPTICAL_VERIFICATION_STATE";
  if (input == null) {
    if (state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR) {
      fail(code, "waiting-operator requires a bound operator prompt");
    }
    return null;
  }
  if (state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR) {
    fail(code, "Only waiting-operator may carry an operator prompt");
  }
  const value = exactObject(input, "verification state.operatorPrompt", [
    "state", "stepId", "confirmationId", "confirmationLeaseId", "title", "instructions",
    "conditions", "requestedAt", "confirmedAt",
  ], code);
  const promptState = text(value.state, "verification state.operatorPrompt.state", 64, code);
  if (!["waiting", "confirmation-queued"].includes(promptState)) {
    fail(code, "operatorPrompt.state must be waiting or confirmation-queued");
  }
  if (progress.currentStepId == null || value.stepId !== progress.currentStepId) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Operator prompt is not bound to the current verification step");
  }
  const step = plan.steps[progress.currentStepIndex];
  if (!step || step.id !== value.stepId || step.captureConditions.requiresOperatorConfirmation !== true) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Operator prompt references an unavailable verification step");
  }
  const confirmationId = text(value.confirmationId, "verification state.operatorPrompt.confirmationId", 128, code);
  if (!LEASE_TOKEN.test(confirmationId)) {
    fail(code, "operatorPrompt.confirmationId must contain 32-128 URL-safe random characters");
  }
  if (value.confirmationLeaseId !== step.captureConditions.confirmationLeaseId) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Operator prompt lease does not match the current verification step");
  }
  const copy = operatorPromptCopy(step);
  if (value.title !== copy.title || value.instructions !== copy.instructions) {
    fail(code, "Operator prompt copy does not match the safety instructions for its physical condition");
  }
  assertCanonicalEqual(
    value.conditions,
    step.captureConditions,
    "verification state.operatorPrompt.conditions",
    code,
  );
  const requestedAt = iso(value.requestedAt, "verification state.operatorPrompt.requestedAt", code);
  if (startedAt == null || Date.parse(requestedAt) < Date.parse(startedAt)
    || (updatedAt != null && Date.parse(requestedAt) > Date.parse(updatedAt))) {
    fail(code, "Operator prompt request is outside the persisted verification interval");
  }
  const confirmedAt = nullableIso(value.confirmedAt, "verification state.operatorPrompt.confirmedAt", code);
  if (promptState === "waiting" && confirmedAt != null) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_REPLAY", "A waiting prompt cannot contain consumed confirmation evidence");
  }
  if (promptState === "confirmation-queued") {
    if (confirmedAt == null || Date.parse(confirmedAt) < Date.parse(requestedAt)
      || Date.parse(confirmedAt) - Date.parse(requestedAt)
        > CAMERA_OPTICAL_VERIFICATION_LIMITS.operatorConfirmationTimeoutMs
      || (updatedAt != null && Date.parse(confirmedAt) > Date.parse(updatedAt))) {
      fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Queued confirmation is missing, predates or outlives its prompt lease");
    }
  }
  return {
    state: promptState,
    stepId: step.id,
    confirmationId,
    confirmationLeaseId: step.captureConditions.confirmationLeaseId,
    title: copy.title,
    instructions: copy.instructions,
    conditions: structuredClone(step.captureConditions),
    requestedAt,
    confirmedAt,
  };
}

export function createCameraOpticalVerificationOperatorPrompt(
  planInput,
  { stepId, confirmationId, requestedAt, now } = {},
) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, { now });
  const stepIndex = plan.steps.findIndex((step) => step.id === stepId);
  if (stepIndex < 0) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Cannot prompt for a step outside the authoritative plan");
  }
  const step = plan.steps[stepIndex];
  const copy = operatorPromptCopy(step);
  return normalizeOperatorPrompt({
    state: "waiting",
    stepId: step.id,
    confirmationId,
    confirmationLeaseId: step.captureConditions.confirmationLeaseId,
    title: copy.title,
    instructions: copy.instructions,
    conditions: structuredClone(step.captureConditions),
    requestedAt,
    confirmedAt: null,
  }, {
    plan,
    progress: {
      completedSteps: stepIndex,
      totalSteps: plan.steps.length,
      currentStepId: step.id,
      currentStepIndex: stepIndex,
    },
    state: CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
    startedAt: requestedAt,
    updatedAt: requestedAt,
  });
}

export function createCameraOpticalVerificationState(planInput, { at = null, now } = {}) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, { now });
  const timestamp = at == null ? null : iso(at, "at", "INVALID_OPTICAL_VERIFICATION_STATE");
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    leaseToken: plan.leaseToken,
    state: CAMERA_OPTICAL_VERIFICATION_STATE.PENDING,
    appliedRevision: plan.project.appliedRevision,
    attempt: 1,
    progress: {
      completedSteps: 0,
      totalSteps: plan.steps.length,
      currentStepId: null,
      currentStepIndex: null,
    },
    startedAt: null,
    updatedAt: timestamp,
    completedAt: null,
    failure: null,
    report: null,
    rollback: null,
    operatorPrompt: null,
  };
}

export function normalizeCameraOpticalVerificationState(input, { plan: planInput, now } = {}) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, { now });
  const code = "INVALID_OPTICAL_VERIFICATION_STATE";
  const value = exactObject(input, "verification state", [
    "schemaVersion", "verificationId", "calibrationSessionId", "leaseToken", "state",
    "appliedRevision", "attempt", "progress", "startedAt", "updatedAt", "completedAt",
    "failure", "report", "rollback", "operatorPrompt",
  ], code);
  if (value.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION
    || value.verificationId !== plan.verificationId
    || value.calibrationSessionId !== plan.calibrationSessionId
    || value.leaseToken !== plan.leaseToken
    || value.appliedRevision !== plan.project.appliedRevision) {
    fail(code, "Persisted verification state identity does not match its authoritative plan");
  }
  const state = text(value.state, "verification state.state", 64, code);
  if (!STATE_VALUES.has(state)) fail(code, `Unknown optical verification state: ${state}`);
  const progressValue = exactObject(value.progress, "verification state.progress", [
    "completedSteps", "totalSteps", "currentStepId", "currentStepIndex",
  ], code);
  const totalSteps = integer(progressValue.totalSteps, "verification state.progress.totalSteps", 0, plan.steps.length, code);
  const completedSteps = integer(progressValue.completedSteps, "verification state.progress.completedSteps", 0, totalSteps, code);
  if (totalSteps !== plan.steps.length) fail(code, "Persisted verification totalSteps does not match its plan");
  const currentStepId = progressValue.currentStepId == null
    ? null
    : text(progressValue.currentStepId, "verification state.progress.currentStepId", 512, code);
  const currentStepIndex = progressValue.currentStepIndex == null
    ? null
    : integer(
      progressValue.currentStepIndex,
      "verification state.progress.currentStepIndex",
      0,
      plan.steps.length - 1,
      code,
    );
  if ((currentStepId == null) !== (currentStepIndex == null)) {
    fail(code, "currentStepId and currentStepIndex must both be null or both identify one step");
  }
  if (currentStepIndex != null
    && (plan.steps[currentStepIndex]?.id !== currentStepId || completedSteps !== currentStepIndex)) {
    fail(code, "Current step identity and completed step count are not in authoritative plan order");
  }
  if (completedSteps === totalSteps && currentStepId != null) {
    fail(code, "A completed verification sequence cannot retain a current step");
  }
  const activeStepStates = new Set([
    CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
    CAMERA_OPTICAL_VERIFICATION_STATE.CAPTURING,
  ]);
  if (activeStepStates.has(state) !== (currentStepId != null)) {
    fail(code, `${state} has an invalid current-step binding`);
  }
  const conclusiveReportStates = new Set([
    CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
    CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
  ]);
  // Superseding an applied revision must not erase the already authenticated
  // optical report. The runtime remains a canonical terminal evidence record;
  // only its authority to describe the current project is revoked.
  const supersededWithReport = state === CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED
    && value.report != null;
  const rollbackStates = new Set([
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
  ]);
  const rollback = normalizeRollback(value.rollback, "verification state.rollback");
  if (rollbackStates.has(state) !== Boolean(rollback)) {
    fail(code, "Rollback state and rollback evidence must appear together");
  }
  let report = null;
  if (value.report != null) report = normalizeCameraOpticalVerificationReport(value.report, { plan, now });
  const failedRollback = rollback?.trigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.FAILED;
  const cancelledRollback = rollback?.trigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED;
  if ((conclusiveReportStates.has(state) || failedRollback) && !report) {
    fail(code, `${state} requires a validated conclusive optical report`);
  }
  if (!conclusiveReportStates.has(state) && !failedRollback && !supersededWithReport && report) {
    fail(code, `${state} cannot carry a conclusive optical report`);
  }
  if (report && completedSteps !== totalSteps) {
    fail(code, "A conclusive optical report requires every verification step to be complete");
  }
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED && report?.state !== state) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Persisted verified state requires a validated verified report");
  }
  if (report && state !== CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
    && state !== CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED
    && report.state !== CAMERA_OPTICAL_VERIFICATION_STATE.FAILED) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Rollback/failure state requires a validated failed report");
  }
  if (cancelledRollback && report != null) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Cancellation rollback cannot carry a conclusive gate report");
  }
  if (rollback) {
    const expectedRollbackState = new Map([
      [CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK, "pending"],
      [CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK, "renderer-ack"],
      [CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK, "restored"],
      [CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED, "blocked"],
    ]).get(state);
    if (rollback.state !== expectedRollbackState
      || rollback.sourceRevision !== plan.project.appliedRevision
      || (rollback.targetRevision != null && rollback.targetRevision !== plan.project.appliedRevision + 1)) {
      fail("OPTICAL_VERIFICATION_REVISION_MISMATCH", "Rollback evidence does not follow the authoritative revision sequence");
    }
    if (rollback.state === "pending" && (rollback.targetRevision != null
      || rollback.rendererAcknowledgedAt != null || rollback.restoredAt != null)) {
      fail(code, "Pending rollback cannot claim a target revision or renderer/restoration acknowledgement");
    }
    if (rollback.state === "renderer-ack" && (rollback.targetRevision == null || rollback.restoredAt != null)) {
      fail(code, "Renderer-ack rollback requires its committed target revision and cannot claim restoration");
    }
    if (rollback.state === "restored" && (rollback.targetRevision == null
      || rollback.rendererAcknowledgedAt == null || rollback.restoredAt == null
      || Date.parse(rollback.restoredAt) < Date.parse(rollback.rendererAcknowledgedAt))) {
      fail(code, "Restored rollback requires ordered target-revision renderer and content acknowledgements");
    }
    if (rollback.state === "blocked" && rollback.reason == null) {
      fail(code, "Blocked rollback requires a concrete reason");
    }
  }
  const cancellationState = state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED || cancelledRollback;
  const failure = normalizeFailure(
    value.failure,
    "verification state.failure",
    state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED || cancellationState,
  );
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED && failure != null) {
    fail("OPTICAL_VERIFICATION_RESULT_SPOOFED", "Verified state cannot contain failure evidence");
  }
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
    && failure?.code !== "OPTICAL_VERIFICATION_CANCELLED") {
    fail(
      "OPTICAL_VERIFICATION_RESULT_SPOOFED",
      "Cancelled verification requires exact cancellation failure evidence",
    );
  }
  if (cancelledRollback && !CANCELLATION_ROLLBACK_FAILURE_CODES.has(failure?.code)) {
    fail(
      "OPTICAL_VERIFICATION_RESULT_SPOOFED",
      "Cancellation rollback requires retained cancellation or fail-closed failure evidence",
    );
  }
  const startedAt = nullableIso(value.startedAt, "verification state.startedAt", code);
  const updatedAt = nullableIso(value.updatedAt, "verification state.updatedAt", code);
  const completedAt = nullableIso(value.completedAt, "verification state.completedAt", code);
  if (startedAt != null && updatedAt != null && Date.parse(updatedAt) < Date.parse(startedAt)) {
    fail(code, "verification state.updatedAt cannot predate startedAt");
  }
  if (completedAt != null && (startedAt == null || Date.parse(completedAt) < Date.parse(startedAt)
    || (updatedAt != null && Date.parse(updatedAt) < Date.parse(completedAt)))) {
    fail(code, "verification state completion timestamps are out of order");
  }
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.EVALUATING && completedSteps !== totalSteps) {
    fail(code, "evaluating requires every planned capture step to be complete");
  }
  if ([CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED, CAMERA_OPTICAL_VERIFICATION_STATE.FAILED].includes(state)
    && (startedAt !== report.startedAt || completedAt !== report.completedAt)) {
    fail(code, "Conclusive state timestamps must match its validated report exactly");
  }
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED && report
    && (startedAt !== report.startedAt || completedAt !== report.completedAt)) {
    fail(code, "Superseded conclusive evidence must retain its exact report interval");
  }
  if (state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
    && (startedAt == null || completedAt == null)) {
    fail(code, "Cancelled verification requires a bounded started/completed interval");
  }
  const operatorPrompt = normalizeOperatorPrompt(value.operatorPrompt, {
    plan,
    progress: { completedSteps, totalSteps, currentStepId, currentStepIndex },
    state,
    startedAt,
    updatedAt,
  });
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    leaseToken: plan.leaseToken,
    state,
    appliedRevision: plan.project.appliedRevision,
    attempt: integer(value.attempt, "verification state.attempt", 1, 1_000, code),
    progress: { completedSteps, totalSteps, currentStepId, currentStepIndex },
    startedAt,
    updatedAt,
    completedAt,
    failure,
    report,
    rollback,
    operatorPrompt,
  };
}

export function normalizeCameraOpticalVerificationConfirmation(
  input,
  { plan: planInput, state: stateInput, now } = {},
) {
  const plan = normalizeCameraOpticalVerificationPlan(planInput, { now });
  const state = normalizeCameraOpticalVerificationState(stateInput, { plan, now });
  const code = "INVALID_OPTICAL_VERIFICATION_CONFIRMATION";
  const value = exactObject(input, "optical verification confirmation", [
    "schemaVersion", "verificationId", "calibrationSessionId", "nodeId", "projectRevision",
    "leaseToken", "stepId", "confirmationId", "confirmationLeaseId", "confirmedAt",
  ], code);
  if (value.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION
    || value.verificationId !== plan.verificationId
    || value.calibrationSessionId !== plan.calibrationSessionId
    || value.nodeId !== plan.nodeId
    || value.projectRevision !== plan.project.appliedRevision
    || value.leaseToken !== plan.leaseToken) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Confirmation identity or revision is stale");
  }
  const prompt = state.operatorPrompt;
  if (state.state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR || prompt == null) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "No operator confirmation is currently expected");
  }
  if (prompt.state !== "waiting") {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_REPLAY", "This operator prompt has already consumed a confirmation");
  }
  if (value.stepId !== prompt.stepId
    || value.confirmationId !== prompt.confirmationId
    || value.confirmationLeaseId !== prompt.confirmationLeaseId) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Confirmation does not match the active random prompt and lease ids");
  }
  const confirmedAt = iso(value.confirmedAt, "optical verification confirmation.confirmedAt", code);
  const elapsed = Date.parse(confirmedAt) - Date.parse(prompt.requestedAt);
  if (elapsed < 0 || elapsed > CAMERA_OPTICAL_VERIFICATION_LIMITS.operatorConfirmationTimeoutMs) {
    fail("OPTICAL_VERIFICATION_CONFIRMATION_STALE", "Confirmation is outside the active prompt lease window");
  }
  if (now != null) {
    const currentMilliseconds = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(currentMilliseconds) || Date.parse(confirmedAt) > currentMilliseconds) {
      fail(code, "confirmedAt cannot be later than the verification clock");
    }
  }
  return {
    schemaVersion: CAMERA_OPTICAL_VERIFICATION_SCHEMA_VERSION,
    verificationId: plan.verificationId,
    calibrationSessionId: plan.calibrationSessionId,
    nodeId: plan.nodeId,
    projectRevision: plan.project.appliedRevision,
    leaseToken: plan.leaseToken,
    stepId: prompt.stepId,
    confirmationId: prompt.confirmationId,
    confirmationLeaseId: prompt.confirmationLeaseId,
    confirmedAt,
  };
}
