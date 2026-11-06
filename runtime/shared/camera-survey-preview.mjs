import { normalizeManualCameraSettings } from "./camera-calibration.mjs";
import { normalizeCameraLensProfile } from "./camera-lens-profile.mjs";

export const CAMERA_SURVEY_PREVIEW_SCHEMA_VERSION = 1;
export const CAMERA_SURVEY_PREVIEW_MAX_WIDTH = 8_192;
export const CAMERA_SURVEY_PREVIEW_MAX_HEIGHT = 8_192;
export const CAMERA_SURVEY_PREVIEW_MAX_PIXELS = 16_777_216;
export const CAMERA_SURVEY_PREVIEW_MAX_RAW_BYTES = 256 * 1024 * 1024;
export const CAMERA_SURVEY_PREVIEW_MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export class CameraSurveyPreviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CameraSurveyPreviewError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CameraSurveyPreviewError(code, message, details);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", `${field} must be an object`);
  }
  return value;
}

function text(value, field, maximum = 256) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", `${field} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function identifier(value, field) {
  const normalized = text(value, field, 128);
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", `${field} contains unsupported characters`);
  }
  return normalized;
}

function integer(value, field, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function sha256(value, field) {
  const normalized = String(value ?? "").toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", `${field} must be a SHA-256 digest`);
  }
  return normalized;
}

function closeEnough(actual, expected, absoluteTolerance, relativeTolerance = 0) {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(absoluteTolerance, Math.abs(right) * relativeTolerance);
}

function normalizeSettings(input, profile) {
  let settings;
  try {
    settings = normalizeManualCameraSettings(input ?? {
      exposureMode: "manual",
      iso: 100,
      apertureF: profile.capture.apertureFNumber,
      shutterUs: 16_667,
      whiteBalance: { mode: "kelvin", kelvin: 5_600 },
      focusMode: "manual",
      captureFormat: "linear-rgb",
    });
  } catch (error) {
    fail(error?.code || "INVALID_CAMERA_SURVEY_PREVIEW", error?.message || "Camera settings are invalid");
  }
  if (!closeEnough(settings.apertureF, profile.capture.apertureFNumber, 0.01)) {
    fail(
      "CAMERA_SURVEY_PREVIEW_PROFILE_MISMATCH",
      "Survey preview aperture must match the lens-profile aperture",
      { requested: settings.apertureF, profile: profile.capture.apertureFNumber },
    );
  }
  return settings;
}

function fixedLimits(profile) {
  const { width, height } = profile.frame;
  const pixels = width * height;
  if (width > CAMERA_SURVEY_PREVIEW_MAX_WIDTH
    || height > CAMERA_SURVEY_PREVIEW_MAX_HEIGHT
    || pixels > CAMERA_SURVEY_PREVIEW_MAX_PIXELS) {
    fail(
      "CAMERA_SURVEY_PREVIEW_FRAME_TOO_LARGE",
      "Lens-profile raster exceeds the bounded survey-preview policy",
      {
        frame: profile.frame,
        maxWidth: CAMERA_SURVEY_PREVIEW_MAX_WIDTH,
        maxHeight: CAMERA_SURVEY_PREVIEW_MAX_HEIGHT,
        maxPixels: CAMERA_SURVEY_PREVIEW_MAX_PIXELS,
      },
    );
  }
  const maxRawBytes = pixels * 3 * Float32Array.BYTES_PER_ELEMENT;
  if (maxRawBytes > CAMERA_SURVEY_PREVIEW_MAX_RAW_BYTES) {
    fail("CAMERA_SURVEY_PREVIEW_FRAME_TOO_LARGE", "Survey-preview RAW raster exceeds its byte limit");
  }
  return {
    maxPixels: pixels,
    maxWidth: width,
    maxHeight: height,
    maxRawBytes,
    preferredPixelFormat: "linear-rgb-f32",
  };
}

/**
 * Canonical Server -> Node request. Limits are derived from the identity-bearing
 * lens profile and cannot be relaxed by an API client.
 */
export function normalizeCameraSurveyPreviewCommand(input) {
  const value = object(input, "camera survey preview command");
  let lensProfile;
  try {
    lensProfile = normalizeCameraLensProfile(value.lensProfile);
  } catch (error) {
    fail(error?.code || "INVALID_CAMERA_SURVEY_PREVIEW", error?.message || "Lens profile is invalid", error?.details);
  }
  const normalized = {
    schemaVersion: CAMERA_SURVEY_PREVIEW_SCHEMA_VERSION,
    requestId: identifier(value.requestId, "requestId"),
    nodeId: identifier(value.nodeId, "nodeId"),
    cameraId: text(value.cameraId, "cameraId", 256),
    cameraViewId: identifier(value.cameraViewId, "cameraViewId"),
    lensProfile,
    cameraSettings: normalizeSettings(value.cameraSettings, lensProfile),
    limits: fixedLimits(lensProfile),
  };
  if (value.schemaVersion != null
    && Number(value.schemaVersion) !== CAMERA_SURVEY_PREVIEW_SCHEMA_VERSION) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", "Unsupported survey-preview schema version");
  }
  if (value.limits != null && JSON.stringify(value.limits) !== JSON.stringify(normalized.limits)) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", "Survey-preview limits must exactly match the lens-profile-derived policy");
  }
  return normalized;
}

function normalizeCamera(input) {
  const value = object(input, "camera");
  return {
    id: text(value.id, "camera.id", 256),
    vendor: text(value.vendor, "camera.vendor", 128),
    model: text(value.model, "camera.model", 128),
    serial: text(value.serial, "camera.serial", 128),
  };
}

function normalizeLens(input) {
  const value = object(input, "lens");
  return {
    id: value.id == null ? null : text(value.id, "lens.id", 256),
    vendor: text(value.vendor, "lens.vendor", 128),
    model: text(value.model, "lens.model", 128),
    serial: text(value.serial, "lens.serial", 128),
    focalLengthMm: Number(value.focalLengthMm),
    apertureF: Number(value.apertureF),
    focusDistanceM: Number(value.focusDistanceM),
    focusLocked: value.focusLocked === true,
    zoomLocked: value.zoomLocked === true,
    stabilization: String(value.stabilization || ""),
  };
}

function normalizePipeline(input) {
  const value = object(input, "pipeline");
  const normalized = {
    captureMode: String(value.captureMode || ""),
    shutterMode: String(value.shutterMode || ""),
    rawEncoding: String(value.rawEncoding || ""),
    sourcePixelFormat: text(value.sourcePixelFormat, "pipeline.sourcePixelFormat", 128),
    retainedPixelFormat: String(value.retainedPixelFormat || ""),
    bitDepth: integer(value.bitDepth, "pipeline.bitDepth", 8, 32),
    linearized: value.linearized === true,
    blackLevelSubtracted: value.blackLevelSubtracted === true,
    whiteBalanceApplied: value.whiteBalanceApplied === true,
    toneCurveApplied: value.toneCurveApplied === true,
    noiseReductionApplied: value.noiseReductionApplied === true,
    lensCorrectionsApplied: value.lensCorrectionsApplied === true,
  };
  if (normalized.captureMode !== "single-shot"
    || !["mechanical", "efcs"].includes(normalized.shutterMode)
    || !["uncompressed", "lossless-compressed"].includes(normalized.rawEncoding)
    || normalized.retainedPixelFormat !== "linear-rgb-f32"
    || normalized.bitDepth !== 14
    || !normalized.linearized
    || normalized.blackLevelSubtracted
    || normalized.whiteBalanceApplied
    || normalized.toneCurveApplied
    || normalized.noiseReductionApplied
    || normalized.lensCorrectionsApplied) {
    fail(
      "CAMERA_SURVEY_PREVIEW_PIPELINE_MISMATCH",
      "Survey preview must come from uncorrected 14-bit lossless single-shot linear RAW",
    );
  }
  return normalized;
}

function assertProfileBinding(request, camera, lens, frame, lensProfileSha256) {
  const profile = request.lensProfile;
  const cameraMatches = camera.vendor === profile.camera.manufacturer
    && camera.model === profile.camera.model
    && camera.serial === profile.camera.serialNumber;
  const lensMatches = lens.vendor === profile.lens.manufacturer
    && lens.model === profile.lens.model
    && lens.serial === profile.lens.serialNumber
    && closeEnough(lens.focalLengthMm, profile.capture.focalLengthMm, 0.05)
    && closeEnough(lens.apertureF, profile.capture.apertureFNumber, 0.05)
    && closeEnough(lens.focusDistanceM, profile.capture.focusDistanceM, 0.02, 0.02)
    && lens.focusLocked
    && lens.zoomLocked
    && lens.stabilization === "off";
  const frameMatches = frame.width === profile.frame.width && frame.height === profile.frame.height;
  if (lensProfileSha256 !== profile.sha256 || !cameraMatches || !lensMatches || !frameMatches) {
    fail(
      "CAMERA_SURVEY_PREVIEW_PROFILE_MISMATCH",
      "Survey preview camera, lens, raster or profile digest does not match the requested lens profile",
      { cameraMatches, lensMatches, frameMatches, lensProfileSha256, expectedSha256: profile.sha256 },
    );
  }
}

/** Canonical Node -> Server report. Byte/hash verification remains a Server duty. */
export function normalizeCameraSurveyPreviewReport(input, requestInput) {
  const request = normalizeCameraSurveyPreviewCommand(requestInput);
  const value = object(input, "camera survey preview report");
  const status = String(value.status || "");
  if (!new Set(["complete", "failed"]).has(status)) {
    fail("INVALID_CAMERA_SURVEY_PREVIEW", "Survey-preview report status must be complete or failed");
  }
  const base = {
    schemaVersion: CAMERA_SURVEY_PREVIEW_SCHEMA_VERSION,
    requestId: identifier(value.requestId, "requestId"),
    nodeId: identifier(value.nodeId, "nodeId"),
    cameraViewId: identifier(value.cameraViewId, "cameraViewId"),
    lensProfileSha256: sha256(value.lensProfileSha256, "lensProfileSha256"),
    status,
    completedAt: text(value.completedAt, "completedAt", 64),
  };
  if (base.requestId !== request.requestId || base.nodeId !== request.nodeId
    || base.cameraViewId !== request.cameraViewId
    || base.lensProfileSha256 !== request.lensProfile.sha256) {
    fail("CAMERA_SURVEY_PREVIEW_REQUEST_MISMATCH", "Survey-preview report is not bound to its queued request");
  }
  if (status === "failed") {
    const error = object(value.error, "error");
    return {
      ...base,
      error: {
        code: text(error.code, "error.code", 128),
        message: text(error.message, "error.message", 2_048),
      },
    };
  }

  const frameValue = object(value.frame, "frame");
  const frame = {
    width: integer(frameValue.width, "frame.width", 32, CAMERA_SURVEY_PREVIEW_MAX_WIDTH),
    height: integer(frameValue.height, "frame.height", 32, CAMERA_SURVEY_PREVIEW_MAX_HEIGHT),
    pixelFormat: String(frameValue.pixelFormat || ""),
  };
  if (frame.pixelFormat !== "linear-rgb-f32") {
    fail("CAMERA_SURVEY_PREVIEW_PIPELINE_MISMATCH", "Survey-preview source frame must be linear-rgb-f32");
  }
  const camera = normalizeCamera(value.camera);
  const lens = normalizeLens(value.lens);
  const pipeline = normalizePipeline(value.pipeline);
  assertProfileBinding(request, camera, lens, frame, base.lensProfileSha256);
  const source = object(value.source, "source");
  const artifact = object(value.artifact, "artifact");
  const normalizedArtifact = {
    mimeType: String(artifact.mimeType || ""),
    encoding: String(artifact.encoding || ""),
    byteLength: integer(
      artifact.byteLength,
      "artifact.byteLength",
      67,
      CAMERA_SURVEY_PREVIEW_MAX_ARTIFACT_BYTES,
    ),
    sha256: sha256(artifact.sha256, "artifact.sha256"),
    dataBase64: text(
      artifact.dataBase64,
      "artifact.dataBase64",
      Math.ceil(CAMERA_SURVEY_PREVIEW_MAX_ARTIFACT_BYTES * 4 / 3) + 4,
    ),
  };
  if (normalizedArtifact.mimeType !== "image/png" || normalizedArtifact.encoding !== "base64") {
    fail("INVALID_CAMERA_SURVEY_PREVIEW_ARTIFACT", "Survey-preview artifact must be a base64 PNG");
  }
  if (String(source.kind || "") !== "single-shot-linear-raw-decode-v1") {
    fail("CAMERA_SURVEY_PREVIEW_PIPELINE_MISMATCH", "Survey preview cannot use processed JPEG or live-view geometry");
  }
  const rawFormat = text(source.rawFormat, "source.rawFormat", 64).toUpperCase();
  if (!new Set(["ARW", "SONY-ARW"]).has(rawFormat) || Number(source.sourceBitDepth) !== 14) {
    fail(
      "CAMERA_SURVEY_PREVIEW_PIPELINE_MISMATCH",
      "Survey-preview source must be the Sony 14-bit ARW still image, not JPEG or live view",
    );
  }
  const decoder = source.decoder == null ? null : object(source.decoder, "source.decoder");
  return {
    ...base,
    capturedAt: text(value.capturedAt, "capturedAt", 64),
    frame,
    camera,
    lens,
    pipeline,
    source: {
      kind: "single-shot-linear-raw-decode-v1",
      rawFormat,
      sourceBitDepth: integer(source.sourceBitDepth, "source.sourceBitDepth", 14, 14),
      sourceSha256: sha256(source.sourceSha256, "source.sourceSha256"),
      rasterSha256: sha256(source.rasterSha256, "source.rasterSha256"),
      decoder: decoder == null ? null : {
        name: text(decoder.name, "source.decoder.name", 128),
        version: text(decoder.version, "source.decoder.version", 128),
      },
    },
    displayTransform: "linear-rec709-luma-to-srgb-v1",
    spatialTransform: "none-raw-sensor-raster-v1",
    artifact: normalizedArtifact,
  };
}
