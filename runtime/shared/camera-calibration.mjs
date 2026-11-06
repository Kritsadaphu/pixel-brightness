import { requiredGrayBits } from "./calibration.mjs";
import { normalizeCameraLensProfile } from "./camera-lens-profile.mjs";
import { normalizePlanarSurfaceTargets } from "./camera-survey.mjs";
import { normalizeOutputConfig } from "./mapping.mjs";
import { sha256Utf8 } from "./sha256.mjs";

export const CAMERA_CALIBRATION_SCHEMA_VERSION = 2;

export const CAMERA_EXPOSURE_PROFILE_ROLE = Object.freeze({
  GEOMETRY: "geometry",
  RADIOMETRY: "radiometry",
});

export const CAMERA_CALIBRATION_PASS_KIND = Object.freeze({
  REFERENCE: "reference",
  GEOMETRY: "geometry",
  NEAR_BLACK: "near-black",
  RADIOMETRY: "radiometry",
});

export const CAMERA_CALIBRATION_REFERENCE_KIND = Object.freeze({
  SENSOR_DARK: "sensor-dark",
  PROJECTORS_OFF_AMBIENT: "projectors-off-ambient",
  PROJECTOR_BLACK: "projector-black",
});

export const CAMERA_CAPTURE_RETENTION_STRATEGY = Object.freeze({
  PER_STEP_STATISTICS: "per-step-statistics",
  INDIVIDUAL_FRAMES: "individual-frames",
});

export const CAMERA_CALIBRATION_REPEAT_LIMITS = Object.freeze({
  geometry: Object.freeze({ minimum: 1, maximum: 8, default: 1 }),
  radiometry: Object.freeze({ minimum: 3, maximum: 16, default: 5 }),
  nearBlack: Object.freeze({ minimum: 8, maximum: 32, default: 16 }),
  references: Object.freeze({ minimum: 8, maximum: 32, default: 16 }),
});

export const CAMERA_CALIBRATION_STATE = Object.freeze({
  IDLE: "idle",
  DETECTING: "detecting-camera",
  CAMERA_DETECTED: "camera-detected",
  LOCKING: "locking-camera",
  CAMERA_LOCKED: "camera-locked",
  BLANKING: "blanking-master",
  CAPTURING: "capturing",
  SOLVING: "solving",
  VALIDATING: "validating",
  RESTORING: "restoring-content",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const CAMERA_CALIBRATION_EVENT = Object.freeze({
  START: "start",
  CAMERA_FOUND: "camera-found",
  BEGIN_LOCK: "begin-lock",
  CAMERA_LOCKED: "camera-locked",
  BEGIN_OVERRIDE: "begin-pattern-override",
  OVERRIDE_READY: "pattern-override-ready",
  STEP_COMPLETE: "step-complete",
  SOLVED: "solved",
  MANIFEST_VALID: "manifest-valid",
  CONTENT_RESTORED: "content-restored",
  FAIL: "fail",
  CANCEL: "cancel",
  RESET: "reset",
});

export const CAMERA_LOCK_FIELDS = Object.freeze([
  "exposureMode",
  "iso",
  "apertureF",
  "shutterUs",
  "whiteBalance.mode",
  "whiteBalance.kelvin",
  "focusMode",
  "captureFormat",
]);

export class CameraCalibrationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "CameraCalibrationError";
    this.code = String(code || "CAMERA_CALIBRATION_ERROR");
    this.details = details;
  }
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} must be an object`);
  }
  return value;
}

function safeText(value, field, { maximum = 256, required = true } = {}) {
  const output = String(value ?? "").trim();
  let hasControl = false;
  for (const character of output) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      hasControl = true;
      break;
    }
  }
  if ((required && !output) || output.length > maximum || hasControl) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} is invalid`);
  }
  return output || null;
}

function integer(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} must be finite`);
  }
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function exactInteger(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return number;
}

function requiredExactInteger(value, minimum, maximum, field, code = "INVALID_CALIBRATION_CONTRACT") {
  if (value == null) throw new CameraCalibrationError(code, `${field} is required`);
  return exactInteger(value, null, minimum, maximum, field);
}

function finite(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function requiredFinite(value, minimum, maximum, field, code = "INVALID_CALIBRATION_CONTRACT") {
  if (value == null) throw new CameraCalibrationError(code, `${field} is required`);
  return finite(value, null, minimum, maximum, field);
}

function boolean(value, fallback, field) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "boolean") {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} must be a boolean`);
  }
  return candidate;
}

function oneOf(value, allowed, field) {
  const candidate = String(value ?? "");
  if (!allowed.includes(candidate)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return candidate;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactCanonical(value, expected, field, code = "INVALID_CALIBRATION_CONTRACT") {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new CameraCalibrationError(code, `${field} is not the canonical contract value`);
  }
  return expected;
}

function rejectUnknownKeys(value, allowed, field, code = "INVALID_CALIBRATION_CONTRACT") {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new CameraCalibrationError(code, `${field} contains unknown fields: ${unknown.join(", ")}`);
  }
}

function uniqueTextList(value, field, { minimum = 1, maximum = 4_096 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} must contain ${minimum}-${maximum} ids`,
    );
  }
  const normalized = value.map((item, index) => safeText(item, `${field}[${index}]`, { maximum: 512 }));
  if (new Set(normalized).size !== normalized.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field} ids must be unique`);
  }
  return normalized;
}

function uniqueFiniteLevels(value, fallback, field, { minimum = 0, maximum = 1, limit = 32 } = {}) {
  const input = value == null ? fallback : value;
  if (!Array.isArray(input) || input.length < 1 || input.length > limit) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} must contain 1-${limit} levels`);
  }
  const levels = [...new Set(input.map((item) => finite(item, 0, minimum, maximum, field)))].sort((a, b) => a - b);
  if (levels.length !== input.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `${field} levels must be unique`);
  }
  return levels;
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

export function normalizeManualCameraSettings(input = {}) {
  const value = object(input, "camera.settings");
  const whiteBalance = value.whiteBalance == null ? {} : object(value.whiteBalance, "camera.settings.whiteBalance");
  const exposureMode = String(value.exposureMode || "manual").toLowerCase();
  const focusMode = String(value.focusMode || "manual").toLowerCase();
  const whiteBalanceMode = String(whiteBalance.mode || "kelvin").toLowerCase();
  if (exposureMode !== "manual" || focusMode !== "manual" || whiteBalanceMode !== "kelvin") {
    throw new CameraCalibrationError(
      "CAMERA_MANUAL_SETTINGS_REQUIRED",
      "Calibration requires manual exposure, manual focus and Kelvin white balance",
    );
  }
  const captureFormat = String(value.captureFormat || "linear-rgb").toLowerCase();
  if (captureFormat !== "linear-rgb") {
    throw new CameraCalibrationError("CAMERA_LINEAR_CAPTURE_REQUIRED", "Calibration capture format must be linear-rgb");
  }
  return {
    exposureMode: "manual",
    iso: exactInteger(value.iso, 400, 50, 102_400, "camera.settings.iso"),
    apertureF: finite(value.apertureF, 5.6, 0.7, 64, "camera.settings.apertureF"),
    shutterUs: exactInteger(value.shutterUs, 16_667, 50, 30_000_000, "camera.settings.shutterUs"),
    whiteBalance: {
      mode: "kelvin",
      kelvin: exactInteger(whiteBalance.kelvin, 5_600, 2_000, 12_000, "camera.settings.whiteBalance.kelvin"),
    },
    focusMode: "manual",
    captureFormat,
  };
}

function normalizeExactManualCameraSettings(input, field) {
  const value = object(input, field);
  const normalized = normalizeManualCameraSettings(value);
  return exactCanonical(value, normalized, field);
}

function defaultGeometrySettings() {
  return normalizeManualCameraSettings({
    exposureMode: "manual",
    iso: 100,
    apertureF: 5.6,
    shutterUs: 16_667,
    whiteBalance: { mode: "kelvin", kelvin: 5_600 },
    focusMode: "manual",
    captureFormat: "linear-rgb",
  });
}

function defaultRadiometrySettings() {
  return normalizeManualCameraSettings({
    exposureMode: "manual",
    iso: 100,
    apertureF: 5.6,
    shutterUs: 1_000_000,
    whiteBalance: { mode: "kelvin", kelvin: 5_600 },
    focusMode: "manual",
    captureFormat: "linear-rgb",
  });
}

function normalizeExposureProfile(input, index) {
  const field = `exposureProfiles[${index}]`;
  const value = object(input, field);
  const normalized = {
    id: safeText(value.id, `${field}.id`, { maximum: 64 }),
    role: oneOf(value.role, Object.values(CAMERA_EXPOSURE_PROFILE_ROLE), `${field}.role`),
    // This is E/E_geometry, not a value inferred from ISO and shutter time.
    // A 60x longer calibrated linear exposure therefore has scale 60 and the
    // solver divides its dark-subtracted signal by 60.
    normalizationScale: requiredFinite(value.normalizationScale, 1e-9, 1e9, `${field}.normalizationScale`),
    settings: normalizeExactManualCameraSettings(value.settings, `${field}.settings`),
  };
  return exactCanonical(value, normalized, field);
}

export function normalizeCameraExposureProfiles(input) {
  if (!Array.isArray(input) || input.length !== 2) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "Calibration requires exactly one geometry and one radiometry exposure profile",
    );
  }
  const profiles = input.map(normalizeExposureProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Exposure profile ids must be unique");
  }
  for (const role of Object.values(CAMERA_EXPOSURE_PROFILE_ROLE)) {
    if (profiles.filter((profile) => profile.role === role).length !== 1) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_CONTRACT",
        `Calibration requires exactly one ${role} exposure profile`,
      );
    }
  }
  const geometry = profiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY);
  const radiometry = profiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY);
  if (geometry.normalizationScale !== 1) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "The geometry exposure profile is the normalization reference and must have normalizationScale 1",
    );
  }
  if (radiometry.normalizationScale <= 1) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "The radiometry exposure profile must be a calibrated longer exposure with normalizationScale greater than 1",
    );
  }
  if (radiometry.settings.shutterUs <= geometry.settings.shutterUs) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "The radiometry profile must use a longer shutter time than the geometry profile",
    );
  }
  for (const field of ["apertureF", "focusMode", "captureFormat", "whiteBalance.mode", "whiteBalance.kelvin"]) {
    if (valueAtPath(geometry.settings, field) !== valueAtPath(radiometry.settings, field)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_CONTRACT",
        `Exposure profiles must keep ${field} fixed`,
      );
    }
  }
  return profiles;
}

function exposureProfilesFromPlanRequest(value) {
  if (value.exposureProfiles != null) {
    for (const legacyField of [
      "cameraSettings",
      "geometryCameraSettings",
      "radiometryCameraSettings",
      "geometryNormalizationScale",
      "radiometryNormalizationScale",
    ]) {
      if (value[legacyField] != null) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_CONTRACT",
          `exposureProfiles cannot be combined with ${legacyField}`,
        );
      }
    }
    return normalizeCameraExposureProfiles(value.exposureProfiles);
  }

  const customGeometry = value.geometryCameraSettings != null || value.cameraSettings != null;
  if (customGeometry && value.radiometryCameraSettings == null) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "Custom geometry camera settings require explicit radiometryCameraSettings and radiometryNormalizationScale",
    );
  }
  const geometrySettings = normalizeManualCameraSettings(
    value.geometryCameraSettings ?? value.cameraSettings ?? defaultGeometrySettings(),
  );
  const customRadiometry = value.radiometryCameraSettings != null;
  if (customRadiometry && value.radiometryNormalizationScale == null) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "Custom radiometryCameraSettings require an explicit calibrated radiometryNormalizationScale",
    );
  }
  const radiometrySettings = normalizeManualCameraSettings(
    value.radiometryCameraSettings ?? defaultRadiometrySettings(),
  );
  return normalizeCameraExposureProfiles([
    {
      id: "geometry-short",
      role: CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY,
      normalizationScale: finite(value.geometryNormalizationScale, 1, 1, 1, "geometryNormalizationScale"),
      settings: geometrySettings,
    },
    {
      id: "radiometry-long",
      role: CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY,
      normalizationScale: finite(value.radiometryNormalizationScale, 60, 1 + Number.EPSILON, 1e9, "radiometryNormalizationScale"),
      settings: radiometrySettings,
    },
  ]);
}

export function normalizeCameraDescriptor(input) {
  const value = object(input, "camera");
  const capabilities = value.capabilities == null ? {} : object(value.capabilities, "camera.capabilities");
  return {
    id: safeText(value.id, "camera.id", { maximum: 256 }),
    vendor: safeText(value.vendor || "unknown", "camera.vendor", { maximum: 128 }),
    model: safeText(value.model || "unknown", "camera.model", { maximum: 128 }),
    serial: safeText(value.serial, "camera.serial", { maximum: 256, required: false }),
    transport: safeText(value.transport || "unknown", "camera.transport", { maximum: 64 }),
    backend: safeText(value.backend || "unknown", "camera.backend", { maximum: 128 }),
    capabilities: {
      manualExposure: capabilities.manualExposure === true,
      manualWhiteBalance: capabilities.manualWhiteBalance === true,
      manualFocus: capabilities.manualFocus === true,
      linearCapture: capabilities.linearCapture === true,
    },
  };
}

export function verifyManualCameraLock(requested, result) {
  const expected = normalizeManualCameraSettings(requested);
  const value = object(result, "camera lock result");
  const applied = normalizeManualCameraSettings(value.applied);
  const lockedFields = new Set(Array.isArray(value.lockedFields) ? value.lockedFields.map(String) : []);
  const mismatches = CAMERA_LOCK_FIELDS.filter((field) => (
    !lockedFields.has(field) || valueAtPath(expected, field) !== valueAtPath(applied, field)
  ));
  if (value.confirmed !== true || mismatches.length > 0) {
    throw new CameraCalibrationError("CAMERA_SETTINGS_NOT_LOCKED", "Camera did not confirm every required manual setting", {
      mismatches,
    });
  }
  return { confirmed: true, applied, lockedFields: [...CAMERA_LOCK_FIELDS] };
}

function normalizePlanOutput(input, index) {
  const output = object(input, `outputs[${index}]`);
  const resolution = object(output.resolution, `outputs[${index}].resolution`);
  const normalized = {
    id: safeText(output.id, `outputs[${index}].id`, { maximum: 64 }),
    width: exactInteger(resolution.width, 1_920, 2, 16_384, `outputs[${index}].resolution.width`),
    height: exactInteger(resolution.height, 1_080, 2, 16_384, `outputs[${index}].resolution.height`),
  };
  const hasWall = output.wallId != null;
  const hasViewport = output.sourceViewport != null;
  if (hasWall !== hasViewport) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      `outputs[${index}] must provide wallId and sourceViewport together`,
    );
  }
  if (hasWall) {
    const viewport = object(output.sourceViewport, `outputs[${index}].sourceViewport`);
    normalized.wallId = safeText(output.wallId, `outputs[${index}].wallId`, { maximum: 128 });
    normalized.sourceViewport = {
      x: requiredFinite(viewport.x, 0, 1e9, `outputs[${index}].sourceViewport.x`),
      y: requiredFinite(viewport.y, 0, 1e9, `outputs[${index}].sourceViewport.y`),
      width: requiredFinite(viewport.width, 1e-6, 1e9, `outputs[${index}].sourceViewport.width`),
      height: requiredFinite(viewport.height, 1e-6, 1e9, `outputs[${index}].sourceViewport.height`),
    };
  }
  return normalized;
}

function attachSurfaceTargets(outputList, input, lensProfileInput) {
  if (input == null) {
    if (lensProfileInput != null) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_CONTRACT",
        "A camera lens profile may only be attached to a markerless planar surface run",
      );
    }
    return { outputs: outputList, lensProfile: null };
  }
  if (lensProfileInput == null) {
    throw new CameraCalibrationError(
      "CAMERA_LENS_PROFILE_REQUIRED",
      "A markerless planar run requires the complete validated lens profile, not only its digest",
    );
  }
  let targets;
  let lensProfile;
  try {
    targets = normalizePlanarSurfaceTargets(input, { requireSingleCameraView: true });
    lensProfile = normalizeCameraLensProfile(lensProfileInput);
  } catch (error) {
    throw new CameraCalibrationError(
      error?.code || "INVALID_CALIBRATION_CONTRACT",
      error?.message || "Surface targets are invalid",
      error?.details ?? null,
    );
  }
  if (targets.length !== outputList.length) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "A markerless planar run requires exactly one surface target for every selected output",
    );
  }
  if (targets.some((target) => (
    target.lensProfileSha256 !== lensProfile.sha256
    || target.frame.width !== lensProfile.frame.width
    || target.frame.height !== lensProfile.frame.height
  ))) {
    throw new CameraCalibrationError(
      "CAMERA_LENS_PROFILE_MISMATCH",
      "Every markerless surface target must use the exact raster and digest of the supplied lens profile",
    );
  }
  const targetsByOutput = new Map(targets.map((target) => [target.outputId, target]));
  const outputs = outputList.map((output) => {
    const target = targetsByOutput.get(output.id);
    if (!target || !output.wallId || !output.sourceViewport || target.wallId !== output.wallId) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_CONTRACT",
        `Surface target does not match calibrated output ${output.id} and its assigned wall`,
      );
    }
    return { ...output, surfaceTarget: target };
  });
  return { outputs, lensProfile };
}

function solidStep({ sessionId, outputId, purpose, value, rgb = null, capture = true }) {
  const level = finite(value, 0, 0, 1, `${purpose}.value`);
  const suffix = purpose === "near-black" || purpose === "tone"
    ? `-${String(Math.round(level * 65_535)).padStart(5, "0")}`
    : "";
  return {
    id: `${sessionId}/${outputId}/${purpose}${suffix}`,
    outputId,
    purpose,
    capture,
    isolateOutput: true,
    otherOutputs: "black",
    pattern: { kind: "solid", rgb: rgb || [level, level, level] },
    inputRgb: rgb || [level, level, level],
  };
}

function grayStep({ sessionId, output, axis, bit, inverse }) {
  return {
    id: `${sessionId}/${output.id}/gray-${axis}-${String(bit).padStart(2, "0")}-${inverse ? "inverse" : "normal"}`,
    outputId: output.id,
    purpose: "gray-code",
    capture: true,
    isolateOutput: true,
    otherOutputs: "black",
    pattern: {
      kind: "gray-code",
      axis,
      bit,
      inverse,
      width: output.width,
      height: output.height,
    },
    inputRgb: null,
  };
}

function passRetention(channels, repeats) {
  const robust = repeats >= 3;
  return {
    strategy: CAMERA_CAPTURE_RETENTION_STRATEGY.PER_STEP_STATISTICS,
    aggregationMethod: robust ? "median-of-means-3" : "mean-insufficient-repeats",
    channels,
    statistics: robust ? ["group-counts", "group-spread-p95"] : ["mean", "variance"],
    retainSourceFrames: 0,
  };
}

function captureConditions(referenceKind = null) {
  switch (referenceKind) {
    case CAMERA_CALIBRATION_REFERENCE_KIND.SENSOR_DARK:
      return {
        projectorState: "emission-off",
        opticalPath: "blocked",
        otherProjectors: "emission-off",
        requiresOperatorConfirmation: true,
        verification: "operator-and-camera-adapter",
        confirmationLeaseId: "sensor-dark-optical-blocked",
        operatorPrompt: "Block the camera optical path completely; keep projector thermal state and room lighting unchanged.",
        prompt: "Block the camera optical path completely; keep projector thermal state and room lighting unchanged.",
      };
    case CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTORS_OFF_AMBIENT:
      return {
        projectorState: "emission-off",
        opticalPath: "open",
        otherProjectors: "emission-off",
        requiresOperatorConfirmation: true,
        verification: "operator-and-projector-controller",
        confirmationLeaseId: "projectors-off-ambient",
        operatorPrompt: "Open the camera optical path and block all projector light with shutters or covers; keep projector thermal state and room lighting unchanged.",
        prompt: "Open the camera optical path and block all projector light with shutters or covers; keep projector thermal state and room lighting unchanged.",
      };
    case CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTOR_BLACK:
      return {
        projectorState: "target-digital-black",
        opticalPath: "open",
        otherProjectors: "digital-black",
        requiresOperatorConfirmation: true,
        verification: "operator-and-pattern-controller",
        confirmationLeaseId: "projector-black-restored",
        operatorPrompt: "Unblock the projector light paths and confirm that every thermally stable output is showing digital black.",
        prompt: "Unblock the projector light paths and confirm that every thermally stable output is showing digital black.",
      };
    default:
      return {
        projectorState: "target-pattern",
        opticalPath: "open",
        otherProjectors: "digital-black",
        requiresOperatorConfirmation: false,
        verification: "pattern-and-output-controller",
        confirmationLeaseId: null,
        operatorPrompt: null,
        prompt: null,
      };
  }
}

function createCapturePasses({ profiles, repeatPolicy }) {
  const geometry = profiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY);
  const radiometry = profiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY);
  const make = ({ id, kind, profile, repeats, referenceKind = null, channels }) => ({
    id,
    kind,
    exposureProfileId: profile.id,
    referenceKind,
    repeats,
    retention: passRetention(channels, repeats),
    captureConditions: captureConditions(referenceKind),
  });
  return [
    make({
      id: `sensor-dark-${geometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.REFERENCE,
      profile: geometry,
      repeats: repeatPolicy.references,
      referenceKind: CAMERA_CALIBRATION_REFERENCE_KIND.SENSOR_DARK,
      channels: "rgb",
    }),
    make({
      id: `sensor-dark-${radiometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.REFERENCE,
      profile: radiometry,
      repeats: repeatPolicy.references,
      referenceKind: CAMERA_CALIBRATION_REFERENCE_KIND.SENSOR_DARK,
      channels: "rgb",
    }),
    make({
      id: `projectors-off-ambient-${radiometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.REFERENCE,
      profile: radiometry,
      repeats: repeatPolicy.references,
      referenceKind: CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTORS_OFF_AMBIENT,
      channels: "rgb",
    }),
    make({
      id: `projector-black-${radiometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.REFERENCE,
      profile: radiometry,
      repeats: repeatPolicy.references,
      referenceKind: CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTOR_BLACK,
      channels: "rgb",
    }),
    make({
      id: `near-black-short-${geometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.NEAR_BLACK,
      profile: geometry,
      repeats: repeatPolicy.nearBlack,
      channels: "rgb",
    }),
    make({
      id: `near-black-long-${radiometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.NEAR_BLACK,
      profile: radiometry,
      repeats: repeatPolicy.nearBlack,
      channels: "rgb",
    }),
    make({
      id: `geometry-${geometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.GEOMETRY,
      profile: geometry,
      repeats: repeatPolicy.geometry,
      channels: "luma",
    }),
    make({
      id: `radiometry-short-${geometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.RADIOMETRY,
      profile: geometry,
      repeats: repeatPolicy.radiometry,
      channels: "rgb",
    }),
    make({
      id: `radiometry-long-${radiometry.id}`,
      kind: CAMERA_CALIBRATION_PASS_KIND.RADIOMETRY,
      profile: radiometry,
      repeats: repeatPolicy.radiometry,
      channels: "rgb",
    }),
  ];
}

function referenceStep({ sessionId, pass, profile }) {
  return {
    id: `${sessionId}/reference/${pass.referenceKind}/${profile.id}`,
    outputId: null,
    purpose: "reference",
    capture: true,
    isolateOutput: false,
    otherOutputs: "black",
    pattern: { kind: "solid", rgb: [0, 0, 0] },
    inputRgb: null,
  };
}

function exposureBridgeStep({ sessionId, outputId, inputLevel, bridgeId, role, peerProfileId }) {
  return {
    ...solidStep({
      sessionId,
      outputId,
      purpose: `exposure-bridge-${role}`,
      value: inputLevel,
    }),
    semantic: "exposure-bridge",
    bridgeId,
    bridgeRole: role,
    pairedExposureProfileId: peerProfileId,
  };
}

function repeatPolicyFromPlanRequest(value) {
  const input = value.repeatPolicy == null ? {} : object(value.repeatPolicy, "repeatPolicy");
  rejectUnknownKeys(input, Object.keys(CAMERA_CALIBRATION_REPEAT_LIMITS), "repeatPolicy");
  if (value.repeatPolicy != null && value.repeats != null) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "repeatPolicy cannot be combined with the legacy repeats field",
    );
  }
  const legacyGeometryRepeats = value.repeats == null ? undefined : value.repeats;
  const normalize = (name, fallback) => {
    const limits = CAMERA_CALIBRATION_REPEAT_LIMITS[name];
    return exactInteger(input[name], fallback, limits.minimum, limits.maximum, `repeatPolicy.${name}`);
  };
  return {
    geometry: normalize("geometry", legacyGeometryRepeats ?? CAMERA_CALIBRATION_REPEAT_LIMITS.geometry.default),
    radiometry: normalize("radiometry", CAMERA_CALIBRATION_REPEAT_LIMITS.radiometry.default),
    nearBlack: normalize("nearBlack", CAMERA_CALIBRATION_REPEAT_LIMITS.nearBlack.default),
    references: normalize("references", CAMERA_CALIBRATION_REPEAT_LIMITS.references.default),
  };
}

export function createCameraCalibrationPlan(input) {
  const value = object(input, "calibration plan");
  const sessionId = safeText(value.sessionId, "sessionId", { maximum: 128 });
  const requestedOutputs = Array.isArray(value.outputs) ? value.outputs : [];
  if (requestedOutputs.length < 1 || requestedOutputs.length > 32) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Calibration requires 1-32 outputs");
  }
  let outputs = requestedOutputs.map(normalizePlanOutput);
  if (new Set(outputs.map((output) => output.id)).size !== outputs.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Calibration output ids must be unique");
  }
  const surfaceBinding = attachSurfaceTargets(outputs, value.surfaceTargets, value.lensProfile);
  outputs = surfaceBinding.outputs;
  const exposureProfiles = exposureProfilesFromPlanRequest(value);
  const geometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY);
  const radiometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY);
  const nearBlackLevels = uniqueFiniteLevels(value.nearBlackLevels, [1 / 255, 4 / 255, 16 / 255], "nearBlackLevels", {
    minimum: 1 / 65_535,
    maximum: 0.1,
  });
  const toneLevels = uniqueFiniteLevels(value.toneLevels, [0.18, 0.5, 0.75], "toneLevels", {
    minimum: 0.05,
    maximum: 0.95,
  });
  const mesh = {
    columns: exactInteger(value.mesh?.columns, 32, 2, 128, "mesh.columns"),
    rows: exactInteger(value.mesh?.rows, 18, 2, 128, "mesh.rows"),
    minimumConfidence: finite(value.mesh?.minimumConfidence, 0.08, 0, 1, "mesh.minimumConfidence"),
  };
  const settleFrames = exactInteger(value.settleFrames, 3, 1, 120, "settleFrames");
  const repeatPolicy = repeatPolicyFromPlanRequest(value);
  const passes = createCapturePasses({ profiles: exposureProfiles, repeatPolicy });
  const pass = (id) => passes.find((candidate) => candidate.id === id);
  const steps = [];
  const longSafeNearBlackLevels = nearBlackLevels.filter((level) => (
    level * radiometryProfile.normalizationScale <= 0.9
  ));
  if (longSafeNearBlackLevels.length < 1) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "Radiometry exposure is too long for every requested near-black input level",
    );
  }
  const bridgeInputLevel = 0.5 / radiometryProfile.normalizationScale;
  if (bridgeInputLevel < 1 / 65_535 || bridgeInputLevel > 0.1) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      "Exposure normalization cannot be optically bridged inside the safe input range",
    );
  }
  const exposureBridgePolicy = {
    method: "paired-neutral-solid-v1",
    inputLevel: bridgeInputLevel,
    nominalScale: radiometryProfile.normalizationScale,
    maximumRelativeError: 0.05,
    maximumUncertainty: 0.03,
    minimumSnrDb: 20,
    maximumClippedFraction: 0.01,
    required: true,
  };
  const push = (step, capturePass = null) => {
    if (step.capture && !capturePass) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", `Capture step ${step.id} requires a pass`);
    }
    const profile = capturePass
      ? exposureProfiles.find((candidate) => candidate.id === capturePass.exposureProfileId)
      : null;
    steps.push({
      ...step,
      sequence: steps.length,
      settleFrames,
      repeats: step.capture ? capturePass.repeats : 0,
      passId: capturePass?.id ?? null,
      exposureProfileId: profile?.id ?? null,
      exposure: profile ? {
        normalizationScale: profile.normalizationScale,
        settings: structuredClone(profile.settings),
      } : null,
      referenceKind: capturePass?.referenceKind ?? null,
      retention: capturePass ? structuredClone(capturePass.retention) : null,
      captureConditions: capturePass ? structuredClone(capturePass.captureConditions) : null,
      requiresOperatorConfirmation: capturePass?.captureConditions?.requiresOperatorConfirmation ?? false,
      operatorPrompt: capturePass?.captureConditions?.operatorPrompt ?? null,
      confirmationLeaseId: capturePass?.captureConditions?.confirmationLeaseId ?? null,
    });
  };
  push({
    id: `${sessionId}/safety-black/start`,
    outputId: null,
    purpose: "safety-black",
    capture: false,
    isolateOutput: false,
    otherOutputs: "black",
    pattern: { kind: "solid", rgb: [0, 0, 0] },
    inputRgb: null,
  });

  for (const profile of exposureProfiles) {
    const sensorDarkPass = pass(`sensor-dark-${profile.id}`);
    push(referenceStep({ sessionId, pass: sensorDarkPass, profile }), sensorDarkPass);
  }
  const ambientPass = pass(`projectors-off-ambient-${radiometryProfile.id}`);
  push(referenceStep({ sessionId, pass: ambientPass, profile: radiometryProfile }), ambientPass);
  const globalBlackPass = pass(`projector-black-${radiometryProfile.id}`);
  push(referenceStep({ sessionId, pass: globalBlackPass, profile: radiometryProfile }), globalBlackPass);

  for (const output of outputs) {
    const nearBlackShortPass = pass(`near-black-short-${geometryProfile.id}`);
    const nearBlackLongPass = pass(`near-black-long-${radiometryProfile.id}`);
    const geometryPass = pass(`geometry-${geometryProfile.id}`);
    const radiometryShortPass = pass(`radiometry-short-${geometryProfile.id}`);
    const radiometryLongPass = pass(`radiometry-long-${radiometryProfile.id}`);
    const bridgeId = `${sessionId}/${output.id}/exposure-bridge`;
    push(exposureBridgeStep({
      sessionId,
      outputId: output.id,
      inputLevel: exposureBridgePolicy.inputLevel,
      bridgeId,
      role: "short",
      peerProfileId: radiometryProfile.id,
    }), radiometryShortPass);
    push(exposureBridgeStep({
      sessionId,
      outputId: output.id,
      inputLevel: exposureBridgePolicy.inputLevel,
      bridgeId,
      role: "long",
      peerProfileId: geometryProfile.id,
    }), radiometryLongPass);
    nearBlackLevels.forEach((level) => {
      const exposurePass = level * radiometryProfile.normalizationScale <= 0.9
        ? nearBlackLongPass
        : nearBlackShortPass;
      push(solidStep({ sessionId, outputId: output.id, purpose: "near-black", value: level }), exposurePass);
    });
    push(solidStep({ sessionId, outputId: output.id, purpose: "white", value: 1 }), geometryPass);
    for (const axis of ["x", "y"]) {
      const bits = requiredGrayBits(axis === "x" ? output.width : output.height);
      for (let bit = 0; bit < bits; bit += 1) {
        push(grayStep({ sessionId, output, axis, bit, inverse: false }), geometryPass);
        push(grayStep({ sessionId, output, axis, bit, inverse: true }), geometryPass);
      }
    }
    toneLevels.forEach((level) => push(
      solidStep({ sessionId, outputId: output.id, purpose: "tone", value: level }),
      radiometryShortPass,
    ));
    for (const [purpose, rgb] of [
      ["primary-red", [1, 0, 0]],
      ["primary-green", [0, 1, 0]],
      ["primary-blue", [0, 0, 1]],
    ]) {
      push(solidStep({ sessionId, outputId: output.id, purpose, value: 1, rgb }), radiometryShortPass);
    }
    const lowLevel = longSafeNearBlackLevels[0];
    for (const [purpose, rgb] of [
      ["low-primary-red", [lowLevel, 0, 0]],
      ["low-primary-green", [0, lowLevel, 0]],
      ["low-primary-blue", [0, 0, lowLevel]],
    ]) {
      push(solidStep({ sessionId, outputId: output.id, purpose, value: lowLevel, rgb }), radiometryLongPass);
    }
  }
  push({
    id: `${sessionId}/safety-black/end`,
    outputId: null,
    purpose: "safety-black",
    capture: false,
    isolateOutput: false,
    otherOutputs: "black",
    pattern: { kind: "solid", rgb: [0, 0, 0] },
    inputRgb: null,
  });

  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId,
    project: {
      id: safeText(value.projectId || "project-default", "projectId", { maximum: 128 }),
      revision: exactInteger(value.projectRevision, 1, 1, Number.MAX_SAFE_INTEGER, "projectRevision"),
    },
    requestedCameraId: safeText(value.cameraId, "cameraId", { maximum: 256, required: false }),
    // Kept as a read-only V1 alias for adapters that lock the initial profile.
    // V2 adapters must switch and verify the explicit exposure on every step.
    cameraSettings: structuredClone(geometryProfile.settings),
    exposureProfiles,
    passes,
    sourcePolicy: {
      arena: "blanked",
      owner: "pixel-brightness-pattern-override",
      failure: "remain-black",
      success: "restore-composition",
    },
    outputs,
    ...(surfaceBinding.lensProfile == null ? {} : { lensProfile: surfaceBinding.lensProfile }),
    mesh,
    nearBlackLevels,
    toneLevels,
    settleFrames,
    repeatPolicy,
    repeats: repeatPolicy.geometry,
    exposureBridgePolicy,
    steps,
  };
}

/**
 * Validate an already materialized V2 plan by rebuilding its deterministic
 * form. This rejects missing, altered and unknown fields instead of silently
 * normalizing a partially trusted persisted plan.
 */
export function normalizeCameraCalibrationPlan(input) {
  const value = object(input, "calibration plan");
  if (value.schemaVersion !== CAMERA_CALIBRATION_SCHEMA_VERSION) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_CONTRACT",
      `Calibration plan schemaVersion must be ${CAMERA_CALIBRATION_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(value.outputs)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Calibration plan outputs are required");
  }
  const expected = createCameraCalibrationPlan({
    sessionId: value.sessionId,
    projectId: value.project?.id,
    projectRevision: value.project?.revision,
    cameraId: value.requestedCameraId,
    outputs: value.outputs.map((output) => ({
      id: output?.id,
      resolution: { width: output?.width, height: output?.height },
      ...(output?.wallId == null ? {} : {
        wallId: output.wallId,
        sourceViewport: output.sourceViewport,
      }),
    })),
    ...(value.outputs.some((output) => output?.surfaceTarget != null)
      ? {
        surfaceTargets: value.outputs.map((output) => output?.surfaceTarget),
        lensProfile: value.lensProfile,
      }
      : {}),
    exposureProfiles: value.exposureProfiles,
    repeatPolicy: value.repeatPolicy,
    nearBlackLevels: value.nearBlackLevels,
    toneLevels: value.toneLevels,
    mesh: value.mesh,
    settleFrames: value.settleFrames,
  });
  return exactCanonical(value, expected, "calibration plan");
}

export function createCameraCalibrationSession(plan, { at = null } = {}) {
  const value = normalizeCameraCalibrationPlan(plan);
  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId: value.sessionId,
    state: CAMERA_CALIBRATION_STATE.IDLE,
    stepIndex: -1,
    completedStepIds: [],
    camera: null,
    manifest: null,
    failure: null,
    startedAt: null,
    updatedAt: at,
  };
}

function assertSessionEvent(session, event) {
  object(session, "calibration session");
  object(event, "calibration event");
  if (event.sessionId != null && String(event.sessionId) !== session.sessionId) {
    throw new CameraCalibrationError("CALIBRATION_SESSION_MISMATCH", "Calibration event belongs to another session");
  }
}

export function transitionCameraCalibration(session, event, plan) {
  assertSessionEvent(session, event);
  const type = String(event.type || "");
  const at = event.at ?? session.updatedAt ?? null;
  const next = { ...session, updatedAt: at };
  const requireState = (...states) => {
    if (!states.includes(session.state)) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_TRANSITION", `${type} is not valid from ${session.state}`);
    }
  };
  if (type === CAMERA_CALIBRATION_EVENT.FAIL) {
    requireState(...Object.values(CAMERA_CALIBRATION_STATE).filter((state) => ![
      CAMERA_CALIBRATION_STATE.COMPLETE,
      CAMERA_CALIBRATION_STATE.CANCELLED,
    ].includes(state)));
    return {
      ...next,
      state: CAMERA_CALIBRATION_STATE.FAILED,
      failure: {
        code: safeText(event.code || "CALIBRATION_FAILED", "failure.code", { maximum: 128 }),
        message: safeText(event.message || "Calibration failed", "failure.message", { maximum: 2_048 }),
        details: event.details ?? null,
      },
    };
  }
  if (type === CAMERA_CALIBRATION_EVENT.CANCEL) {
    requireState(...Object.values(CAMERA_CALIBRATION_STATE).filter((state) => ![
      CAMERA_CALIBRATION_STATE.COMPLETE,
      CAMERA_CALIBRATION_STATE.FAILED,
      CAMERA_CALIBRATION_STATE.CANCELLED,
    ].includes(state)));
    return { ...next, state: CAMERA_CALIBRATION_STATE.CANCELLED };
  }
  if (type === CAMERA_CALIBRATION_EVENT.RESET) {
    requireState(CAMERA_CALIBRATION_STATE.COMPLETE, CAMERA_CALIBRATION_STATE.FAILED, CAMERA_CALIBRATION_STATE.CANCELLED);
    return createCameraCalibrationSession(plan, { at });
  }

  switch (type) {
    case CAMERA_CALIBRATION_EVENT.START:
      requireState(CAMERA_CALIBRATION_STATE.IDLE);
      return { ...next, state: CAMERA_CALIBRATION_STATE.DETECTING, startedAt: at };
    case CAMERA_CALIBRATION_EVENT.CAMERA_FOUND:
      requireState(CAMERA_CALIBRATION_STATE.DETECTING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.CAMERA_DETECTED, camera: normalizeCameraDescriptor(event.camera) };
    case CAMERA_CALIBRATION_EVENT.BEGIN_LOCK:
      requireState(CAMERA_CALIBRATION_STATE.CAMERA_DETECTED);
      return { ...next, state: CAMERA_CALIBRATION_STATE.LOCKING };
    case CAMERA_CALIBRATION_EVENT.CAMERA_LOCKED:
      requireState(CAMERA_CALIBRATION_STATE.LOCKING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.CAMERA_LOCKED, cameraLock: event.cameraLock };
    case CAMERA_CALIBRATION_EVENT.BEGIN_OVERRIDE:
      requireState(CAMERA_CALIBRATION_STATE.CAMERA_LOCKED);
      return { ...next, state: CAMERA_CALIBRATION_STATE.BLANKING };
    case CAMERA_CALIBRATION_EVENT.OVERRIDE_READY:
      requireState(CAMERA_CALIBRATION_STATE.BLANKING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.CAPTURING, stepIndex: 0 };
    case CAMERA_CALIBRATION_EVENT.STEP_COMPLETE: {
      requireState(CAMERA_CALIBRATION_STATE.CAPTURING);
      const step = plan?.steps?.[session.stepIndex];
      if (!step || event.stepId !== step.id) {
        throw new CameraCalibrationError("CAPTURE_STEP_OUT_OF_ORDER", "Calibration capture steps must complete in plan order", {
          expected: step?.id ?? null,
          received: event.stepId ?? null,
        });
      }
      const completedStepIds = [...session.completedStepIds, step.id];
      if (session.stepIndex + 1 === plan.steps.length) {
        return { ...next, state: CAMERA_CALIBRATION_STATE.SOLVING, stepIndex: session.stepIndex, completedStepIds };
      }
      return { ...next, stepIndex: session.stepIndex + 1, completedStepIds };
    }
    case CAMERA_CALIBRATION_EVENT.SOLVED:
      requireState(CAMERA_CALIBRATION_STATE.SOLVING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.VALIDATING, manifest: event.manifest };
    case CAMERA_CALIBRATION_EVENT.MANIFEST_VALID:
      requireState(CAMERA_CALIBRATION_STATE.VALIDATING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.RESTORING, manifest: event.manifest };
    case CAMERA_CALIBRATION_EVENT.CONTENT_RESTORED:
      requireState(CAMERA_CALIBRATION_STATE.RESTORING);
      return { ...next, state: CAMERA_CALIBRATION_STATE.COMPLETE, completedAt: at };
    default:
      throw new CameraCalibrationError("INVALID_CALIBRATION_TRANSITION", `Unknown calibration event: ${type || "(missing)"}`);
  }
}

function normalizeSha256(value, field) {
  const sha256 = safeText(value, field, { maximum: 64 });
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field} must be a SHA-256 digest`);
  }
  return sha256.toLowerCase();
}

function normalizeArtifactRef(input, field, formats) {
  const value = object(input, field);
  const format = safeText(value.format, `${field}.format`, { maximum: 64 });
  if (!formats.includes(format)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.format is unsupported`);
  }
  return {
    uri: safeText(value.uri, `${field}.uri`, { maximum: 1_024 }),
    ...(value.path == null ? {} : { path: safeText(value.path, `${field}.path`, { maximum: 2_048 }) }),
    sha256: normalizeSha256(value.sha256, `${field}.sha256`),
    byteLength: integer(value.byteLength, 1, 1, Number.MAX_SAFE_INTEGER, `${field}.byteLength`),
    format,
    ...(value.width == null ? {} : { width: integer(value.width, 1, 1, 16_384, `${field}.width`) }),
    ...(value.height == null ? {} : { height: integer(value.height, 1, 1, 16_384, `${field}.height`) }),
    ...(value.size == null ? {} : { size: integer(value.size, 2, 2, 128, `${field}.size`) }),
  };
}

function normalizeTextureArtifact(input, field) {
  const value = normalizeArtifactRef(input, field, ["r32_float"]);
  if (value.width == null || value.height == null) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field} requires width and height`);
  }
  return value;
}

function isoTimestamp(value, field) {
  const timestamp = safeText(value, field, { maximum: 128 });
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function nullableReferenceKind(value, field) {
  if (value == null) return null;
  return oneOf(value, Object.values(CAMERA_CALIBRATION_REFERENCE_KIND), field);
}

function normalizeExposureSnapshot(input, field) {
  const value = object(input, field);
  return {
    normalizationScale: requiredFinite(
      value.normalizationScale,
      1e-9,
      1e9,
      `${field}.normalizationScale`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    settings: normalizeExactManualCameraSettings(value.settings, `${field}.settings`),
  };
}

function normalizeLensProvenance(input) {
  const value = object(input, "captureProvenance.lens");
  rejectUnknownKeys(value, [
    "id", "vendor", "model", "serial", "mount", "focalLengthMm", "apertureF", "focusDistanceM",
    "focusLocked", "zoomLocked", "stabilization",
  ], "captureProvenance.lens", "INVALID_CALIBRATION_MANIFEST");
  const lens = {
    id: safeText(value.id, "captureProvenance.lens.id", { maximum: 256 }),
    vendor: safeText(value.vendor || "unknown", "captureProvenance.lens.vendor", { maximum: 128 }),
    model: safeText(value.model, "captureProvenance.lens.model", { maximum: 256 }),
    serial: safeText(value.serial, "captureProvenance.lens.serial", { maximum: 256, required: false }),
    mount: safeText(value.mount || "unknown", "captureProvenance.lens.mount", { maximum: 64 }),
    focalLengthMm: requiredFinite(
      value.focalLengthMm,
      1,
      2_000,
      "captureProvenance.lens.focalLengthMm",
      "INVALID_CALIBRATION_MANIFEST",
    ),
    apertureF: requiredFinite(
      value.apertureF,
      0.7,
      64,
      "captureProvenance.lens.apertureF",
      "INVALID_CALIBRATION_MANIFEST",
    ),
    focusDistanceM: value.focusDistanceM == null
      ? null
      : requiredFinite(
        value.focusDistanceM,
        0.01,
        1_000_000,
        "captureProvenance.lens.focusDistanceM",
        "INVALID_CALIBRATION_MANIFEST",
      ),
    focusLocked: boolean(value.focusLocked, null, "captureProvenance.lens.focusLocked"),
    zoomLocked: boolean(value.zoomLocked, null, "captureProvenance.lens.zoomLocked"),
    stabilization: oneOf(value.stabilization, ["off"], "captureProvenance.lens.stabilization"),
  };
  if (!lens.focusLocked || !lens.zoomLocked) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Measured calibration requires locked focus and zoom",
    );
  }
  return lens;
}

function normalizeCapturePipeline(input) {
  const value = object(input, "captureProvenance.pipeline");
  rejectUnknownKeys(value, [
    "captureMode", "shutterMode", "rawEncoding", "sourcePixelFormat", "retainedPixelFormat", "bitDepth",
    "linearized", "blackLevelSubtracted", "whiteBalanceApplied", "toneCurveApplied", "noiseReductionApplied",
    "lensCorrectionsApplied",
  ], "captureProvenance.pipeline", "INVALID_CALIBRATION_MANIFEST");
  const pipeline = {
    captureMode: oneOf(value.captureMode, ["single-shot"], "captureProvenance.pipeline.captureMode"),
    shutterMode: oneOf(value.shutterMode, ["mechanical", "efcs"], "captureProvenance.pipeline.shutterMode"),
    rawEncoding: oneOf(
      value.rawEncoding,
      ["uncompressed", "lossless-compressed"],
      "captureProvenance.pipeline.rawEncoding",
    ),
    sourcePixelFormat: safeText(value.sourcePixelFormat, "captureProvenance.pipeline.sourcePixelFormat", { maximum: 128 }),
    retainedPixelFormat: oneOf(
      value.retainedPixelFormat,
      ["linear-rgb-f32", "linear-luma-f32", "per-step-statistics-f64"],
      "captureProvenance.pipeline.retainedPixelFormat",
    ),
    bitDepth: requiredExactInteger(
      value.bitDepth,
      12,
      32,
      "captureProvenance.pipeline.bitDepth",
      "INVALID_CALIBRATION_MANIFEST",
    ),
    linearized: boolean(value.linearized, null, "captureProvenance.pipeline.linearized"),
    blackLevelSubtracted: boolean(
      value.blackLevelSubtracted,
      null,
      "captureProvenance.pipeline.blackLevelSubtracted",
    ),
    whiteBalanceApplied: boolean(value.whiteBalanceApplied, null, "captureProvenance.pipeline.whiteBalanceApplied"),
    toneCurveApplied: boolean(value.toneCurveApplied, null, "captureProvenance.pipeline.toneCurveApplied"),
    noiseReductionApplied: boolean(value.noiseReductionApplied, null, "captureProvenance.pipeline.noiseReductionApplied"),
    lensCorrectionsApplied: boolean(
      value.lensCorrectionsApplied,
      null,
      "captureProvenance.pipeline.lensCorrectionsApplied",
    ),
  };
  if (!pipeline.linearized
    || pipeline.blackLevelSubtracted
    || pipeline.whiteBalanceApplied
    || pipeline.toneCurveApplied
    || pipeline.noiseReductionApplied
    || pipeline.lensCorrectionsApplied) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Measured radiometry requires uncorrected linear RAW samples with sensor black retained",
    );
  }
  return pipeline;
}

function normalizeStrictRawSha256(value, field) {
  const digest = safeText(value, field, { maximum: 64 });
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} must be one exact lowercase SHA-256 digest`,
    );
  }
  return digest;
}

/**
 * Canonical identity of the executable RAW decoder. The binary digest binds
 * the claimed name/version to the actual pinned decoder build instead of
 * trusting a display string supplied by a camera helper.
 */
export function normalizeRawDecoderProvenance(input, field = "captureProvenance.decoder") {
  const value = object(input, field);
  rejectUnknownKeys(value, ["name", "version", "binarySha256"], field, "INVALID_CALIBRATION_MANIFEST");
  const normalized = {
    name: safeText(value.name, `${field}.name`, { maximum: 128 }),
    version: safeText(value.version, `${field}.version`, { maximum: 128 }),
    binarySha256: normalizeStrictRawSha256(value.binarySha256, `${field}.binarySha256`),
  };
  return exactCanonical(value, normalized, field, "INVALID_CALIBRATION_MANIFEST");
}

function normalizeRawCodeLevels(input, field, maximumCode) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} must contain 1-64 bounded RAW code values`,
    );
  }
  return input.map((value, index) => requiredExactInteger(
    value,
    0,
    maximumCode,
    `${field}[${index}]`,
    "INVALID_CALIBRATION_MANIFEST",
  ));
}

/**
 * Bounded scalar metadata needed to reproduce and audit one linear RAW decode.
 * No maker-note blob, ICC payload, thumbnail or other unbounded/binary value is
 * admitted into the calibration manifest.
 */
export function normalizeRawDecodeMetadata(input, {
  field = "captureProvenance.rawDecode",
  bitDepth,
} = {}) {
  const value = object(input, field);
  rejectUnknownKeys(value, [
    "rawFormat", "sensorWidth", "sensorHeight", "cfaPattern", "blackLevels", "whiteLevels",
  ], field, "INVALID_CALIBRATION_MANIFEST");
  const exactBitDepth = requiredExactInteger(
    bitDepth,
    8,
    32,
    `${field}.bitDepth`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const rawFormat = safeText(value.rawFormat, `${field}.rawFormat`, { maximum: 64 });
  if (rawFormat !== rawFormat.toUpperCase() || !/^[A-Z0-9][A-Z0-9._+-]{0,63}$/.test(rawFormat)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field}.rawFormat must be one canonical uppercase RAW format identifier`,
    );
  }
  const cfaPattern = safeText(value.cfaPattern, `${field}.cfaPattern`, { maximum: 64 });
  if (cfaPattern !== cfaPattern.toUpperCase() || !/^[A-Z]{1,64}$/.test(cfaPattern)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field}.cfaPattern must be one canonical uppercase sensor mosaic`,
    );
  }
  const maximumCode = (2 ** exactBitDepth) - 1;
  const blackLevels = normalizeRawCodeLevels(value.blackLevels, `${field}.blackLevels`, maximumCode);
  const whiteLevels = normalizeRawCodeLevels(value.whiteLevels, `${field}.whiteLevels`, maximumCode);
  const expectedLevelCount = cfaPattern === "MONO" ? 1 : cfaPattern.length;
  if (blackLevels.length !== expectedLevelCount || whiteLevels.length !== expectedLevelCount
    || whiteLevels.some((white, index) => white <= blackLevels[index])) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} CFA, black levels and white levels must describe the same valid sensor channels`,
    );
  }
  const normalized = {
    rawFormat,
    sensorWidth: requiredExactInteger(
      value.sensorWidth,
      2,
      65_536,
      `${field}.sensorWidth`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    sensorHeight: requiredExactInteger(
      value.sensorHeight,
      2,
      65_536,
      `${field}.sensorHeight`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    cfaPattern,
    blackLevels,
    whiteLevels,
  };
  return exactCanonical(value, normalized, field, "INVALID_CALIBRATION_MANIFEST");
}

function normalizeColorCharacterization(input) {
  const field = "captureProvenance.colorCharacterization";
  const value = object(input, field);
  const status = oneOf(value.status, ["uncharacterized", "validated"], `${field}.status`);
  if (status === "uncharacterized") {
    const normalized = {
      status,
      method: "none",
      targetColorSpace: null,
      profileSha256: null,
      characterizedAt: null,
      matrixRgbToXyz: null,
      maximumDeltaE: null,
    };
    return exactCanonical(value, normalized, field, "INVALID_CALIBRATION_MANIFEST");
  }
  if (!Array.isArray(value.matrixRgbToXyz) || value.matrixRgbToXyz.length !== 3
    || value.matrixRgbToXyz.some((row) => !Array.isArray(row) || row.length !== 3)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.matrixRgbToXyz must be a 3x3 matrix`);
  }
  const normalized = {
    status,
    method: safeText(value.method, `${field}.method`, { maximum: 128 }),
    targetColorSpace: safeText(value.targetColorSpace, `${field}.targetColorSpace`, { maximum: 128 }),
    profileSha256: normalizeSha256(value.profileSha256, `${field}.profileSha256`),
    characterizedAt: isoTimestamp(value.characterizedAt, `${field}.characterizedAt`),
    matrixRgbToXyz: value.matrixRgbToXyz.map((row, rowIndex) => row.map((item, columnIndex) => requiredFinite(
      item,
      -10,
      10,
      `${field}.matrixRgbToXyz[${rowIndex}][${columnIndex}]`,
      "INVALID_CALIBRATION_MANIFEST",
    ))),
    maximumDeltaE: requiredFinite(
      value.maximumDeltaE,
      0,
      100,
      `${field}.maximumDeltaE`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
  };
  if (normalized.method === "none") {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.method must identify the validation method`);
  }
  return exactCanonical(value, normalized, field, "INVALID_CALIBRATION_MANIFEST");
}

function normalizeCaptureFrame(input, field) {
  const value = object(input, field);
  rejectUnknownKeys(value, ["width", "height", "pixelFormat", "bitDepth", "linearized"], field, "INVALID_CALIBRATION_MANIFEST");
  return {
    width: requiredExactInteger(value.width, 1, 16_384, `${field}.width`, "INVALID_CALIBRATION_MANIFEST"),
    height: requiredExactInteger(value.height, 1, 16_384, `${field}.height`, "INVALID_CALIBRATION_MANIFEST"),
    pixelFormat: safeText(value.pixelFormat, `${field}.pixelFormat`, { maximum: 128 }),
    bitDepth: requiredExactInteger(value.bitDepth, 8, 32, `${field}.bitDepth`, "INVALID_CALIBRATION_MANIFEST"),
    linearized: boolean(value.linearized, null, `${field}.linearized`),
  };
}

function normalizeCaptureConditionVerification(input, field) {
  const value = object(input, field);
  rejectUnknownKeys(value, [
    "projectorState", "opticalPath", "otherProjectors", "method", "verifiedAt", "confirmationLeaseId",
    "confirmationId",
  ], field, "INVALID_CALIBRATION_MANIFEST");
  const verification = {
    projectorState: safeText(value.projectorState, `${field}.projectorState`, { maximum: 64 }),
    opticalPath: oneOf(value.opticalPath, ["open", "blocked"], `${field}.opticalPath`),
    otherProjectors: safeText(value.otherProjectors, `${field}.otherProjectors`, { maximum: 64 }),
    method: safeText(value.method, `${field}.method`, { maximum: 128 }),
    verifiedAt: isoTimestamp(value.verifiedAt, `${field}.verifiedAt`),
    confirmationLeaseId: value.confirmationLeaseId == null
      ? null
      : safeText(value.confirmationLeaseId, `${field}.confirmationLeaseId`, { maximum: 128 }),
    confirmationId: value.confirmationId == null
      ? null
      : safeText(value.confirmationId, `${field}.confirmationId`, { maximum: 256 }),
  };
  if ((verification.confirmationLeaseId == null) !== (verification.confirmationId == null)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} must bind an operator confirmation id and lease together`,
    );
  }
  return verification;
}

function normalizePhysicalCapture(input, index) {
  const field = `captureProvenance.captures[${index}]`;
  const value = object(input, field);
  rejectUnknownKeys(value, [
    "id", "stepId", "repeat", "outputId", "passId", "exposureProfileId", "referenceKind", "capturedAt",
    "sourceSha256", "rasterSha256", "exposure", "frame", "conditionsVerified", "conditionVerification",
  ], field, "INVALID_CALIBRATION_MANIFEST");
  const frame = normalizeCaptureFrame(value.frame, `${field}.frame`);
  if (frame.linearized !== true) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.frame must be linearized`);
  }
  return {
    id: safeText(value.id, `${field}.id`, { maximum: 512 }),
    stepId: safeText(value.stepId, `${field}.stepId`, { maximum: 512 }),
    repeat: requiredExactInteger(value.repeat, 0, 31, `${field}.repeat`, "INVALID_CALIBRATION_MANIFEST"),
    outputId: value.outputId == null ? null : safeText(value.outputId, `${field}.outputId`, { maximum: 64 }),
    passId: safeText(value.passId, `${field}.passId`, { maximum: 128 }),
    exposureProfileId: safeText(value.exposureProfileId, `${field}.exposureProfileId`, { maximum: 64 }),
    referenceKind: nullableReferenceKind(value.referenceKind, `${field}.referenceKind`),
    capturedAt: isoTimestamp(value.capturedAt, `${field}.capturedAt`),
    sourceSha256: normalizeStrictRawSha256(value.sourceSha256, `${field}.sourceSha256`),
    rasterSha256: normalizeStrictRawSha256(value.rasterSha256, `${field}.rasterSha256`),
    exposure: normalizeExposureSnapshot(value.exposure, `${field}.exposure`),
    frame,
    conditionsVerified: boolean(value.conditionsVerified, null, `${field}.conditionsVerified`),
    conditionVerification: normalizeCaptureConditionVerification(
      value.conditionVerification,
      `${field}.conditionVerification`,
    ),
  };
}

function normalizeCaptureStack(input, index) {
  const field = `captureProvenance.stacks[${index}]`;
  const value = object(input, field);
  rejectUnknownKeys(value, [
    "id", "stepId", "method", "channels", "sourceCaptureIds", "groupCounts", "groupSpreadP95", "statistics",
  ], field, "INVALID_CALIBRATION_MANIFEST");
  const statistics = uniqueTextList(value.statistics, `${field}.statistics`, { minimum: 2, maximum: 8 });
  const allowedStatistics = new Set([
    "mean",
    "variance",
    "median",
    "mad",
    "group-counts",
    "group-spread-p95",
    "clipped-low-count",
    "clipped-high-count",
  ]);
  if (statistics.some((statistic) => !allowedStatistics.has(statistic))) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.statistics contains an unsupported statistic`);
  }
  if (!Array.isArray(value.groupCounts) || value.groupCounts.length < 1 || value.groupCounts.length > 3) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.groupCounts must contain 1-3 groups`);
  }
  const groupCounts = value.groupCounts.map((count, groupIndex) => requiredExactInteger(
    count,
    1,
    32,
    `${field}.groupCounts[${groupIndex}]`,
    "INVALID_CALIBRATION_MANIFEST",
  ));
  const groupSpreadP95 = value.groupSpreadP95 == null
    ? null
    : requiredFinite(
      value.groupSpreadP95,
      0,
      1e6,
      `${field}.groupSpreadP95`,
      "INVALID_CALIBRATION_MANIFEST",
    );
  const sourceCaptureIds = uniqueTextList(value.sourceCaptureIds, `${field}.sourceCaptureIds`, {
    minimum: 1,
    maximum: 32,
  });
  if (groupCounts.reduce((total, count) => total + count, 0) !== sourceCaptureIds.length
    || (sourceCaptureIds.length >= 3 && groupSpreadP95 == null)
    || (sourceCaptureIds.length < 3 && groupSpreadP95 != null)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} group counts or spread do not match its physical captures`,
    );
  }
  return {
    id: safeText(value.id, `${field}.id`, { maximum: 512 }),
    stepId: safeText(value.stepId, `${field}.stepId`, { maximum: 512 }),
    method: oneOf(
      value.method,
      ["mean-variance", "mean-insufficient-repeats", "sigma-clipped-mean", "median-mad", "median-of-means-3"],
      `${field}.method`,
    ),
    channels: oneOf(value.channels, ["luma", "rgb"], `${field}.channels`),
    sourceCaptureIds,
    groupCounts,
    groupSpreadP95,
    statistics,
  };
}

function expectedPlanCaptureRecords(plan) {
  return plan.steps.filter((step) => step.capture).flatMap((step) => (
    Array.from({ length: step.repeats }, (_value, repeat) => ({
      id: `${step.id}#${repeat}`,
      step,
      repeat,
    }))
  ));
}

function normalizeCaptureProvenance(input, { plan, camera, profiles }) {
  const value = object(input, "captureProvenance");
  rejectUnknownKeys(value, [
    "version", "device", "lens", "pipeline", "decoder", "rawDecode", "colorCharacterization",
    "exposureProfiles", "expectedCaptureIds", "captures", "stacks",
  ], "captureProvenance", "INVALID_CALIBRATION_MANIFEST");
  if (value.version !== 2) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "captureProvenance.version must be 2");
  }
  const device = normalizeCameraDescriptor(value.device);
  if (canonicalJson(device) !== canonicalJson(camera)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Capture device does not match manifest camera");
  }
  const provenanceProfiles = normalizeCameraExposureProfiles(value.exposureProfiles);
  if (canonicalJson(provenanceProfiles) !== canonicalJson(profiles)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Capture exposure profiles do not match the manifest",
    );
  }
  const expectedCaptureIds = uniqueTextList(
    value.expectedCaptureIds,
    "captureProvenance.expectedCaptureIds",
    { minimum: 1, maximum: 65_536 },
  );
  const captures = Array.isArray(value.captures) ? value.captures.map(normalizePhysicalCapture) : [];
  if (captures.length !== expectedCaptureIds.length || new Set(captures.map((capture) => capture.id)).size !== captures.length
    || canonicalJson(captures.map((capture) => capture.id).sort()) !== canonicalJson([...expectedCaptureIds].sort())) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Capture provenance must contain every expected physical capture exactly once",
    );
  }
  if (new Set(captures.map((capture) => capture.sourceSha256)).size !== captures.length) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Every physical capture must bind one unique RAW source SHA-256 digest",
    );
  }
  const stacks = Array.isArray(value.stacks) ? value.stacks.map(normalizeCaptureStack) : [];
  if (new Set(stacks.map((stack) => stack.id)).size !== stacks.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Capture stack ids must be unique");
  }
  const captureById = new Map(captures.map((capture) => [capture.id, capture]));
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const capture of captures) {
    const profile = profileById.get(capture.exposureProfileId);
    const expectedConfirmationLeaseId = captureConditions(capture.referenceKind).confirmationLeaseId;
    if (!profile || capture.conditionsVerified !== true
      || Date.parse(capture.capturedAt) < Date.parse(capture.conditionVerification.verifiedAt)
      || canonicalJson(capture.exposure) !== canonicalJson({
        normalizationScale: profile.normalizationScale,
        settings: profile.settings,
      })
      || capture.conditionVerification.confirmationLeaseId !== expectedConfirmationLeaseId
      || (expectedConfirmationLeaseId != null && !capture.conditionVerification.confirmationId)
      || (expectedConfirmationLeaseId == null && capture.conditionVerification.confirmationId != null)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        `Capture ${capture.id} does not contain a verified matching exposure and condition snapshot`,
      );
    }
  }
  const genericLeaseIds = [...new Set(captures
    .map((capture) => capture.conditionVerification.confirmationLeaseId)
    .filter((leaseId) => leaseId != null))];
  const genericConfirmationIds = [];
  for (const leaseId of genericLeaseIds) {
    const confirmationIds = new Set(captures
      .filter((capture) => capture.conditionVerification.confirmationLeaseId === leaseId)
      .map((capture) => capture.conditionVerification.confirmationId));
    if (confirmationIds.size !== 1) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        `Operator confirmation lease ${leaseId} is not backed by one exact confirmation`,
      );
    }
    genericConfirmationIds.push([...confirmationIds][0]);
  }
  if (new Set(genericConfirmationIds).size !== genericConfirmationIds.length) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Operator confirmation ids cannot be replayed across different physical-condition leases",
    );
  }
  for (const stack of stacks) {
    if (stack.sourceCaptureIds.some((id) => !captureById.has(id))) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `Capture stack ${stack.id} has an unknown source`);
    }
    if (stack.sourceCaptureIds.some((id) => captureById.get(id).stepId !== stack.stepId)) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `Capture stack ${stack.id} mixes capture steps`);
    }
  }
  const capturedStepIds = [...new Set(captures.map((capture) => capture.stepId))];
  if (stacks.length !== capturedStepIds.length) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Every physical capture step requires one bounded aggregate stack",
    );
  }
  for (const stepId of capturedStepIds) {
    const matching = stacks.filter((stack) => stack.stepId === stepId);
    const physicalIds = captures.filter((capture) => capture.stepId === stepId).map((capture) => capture.id).sort();
    if (matching.length !== 1
      || canonicalJson([...matching[0].sourceCaptureIds].sort()) !== canonicalJson(physicalIds)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        `Capture stack does not exactly cover physical step ${stepId}`,
      );
    }
  }
  if (plan) {
    const expected = expectedPlanCaptureRecords(plan);
    if (canonicalJson(expected.map((item) => item.id).sort()) !== canonicalJson([...expectedCaptureIds].sort())) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Capture provenance does not match the plan");
    }
    for (const expectedCapture of expected) {
      const capture = captureById.get(expectedCapture.id);
      const { step, repeat } = expectedCapture;
      if (!capture
        || capture.stepId !== step.id
        || capture.repeat !== repeat
        || capture.outputId !== step.outputId
        || capture.passId !== step.passId
        || capture.exposureProfileId !== step.exposureProfileId
        || capture.referenceKind !== step.referenceKind
        || capture.conditionsVerified !== true
        || canonicalJson(capture.exposure) !== canonicalJson(step.exposure)
        || capture.conditionVerification.projectorState !== step.captureConditions.projectorState
        || capture.conditionVerification.opticalPath !== step.captureConditions.opticalPath
        || capture.conditionVerification.otherProjectors !== step.captureConditions.otherProjectors
        || capture.conditionVerification.confirmationLeaseId !== step.confirmationLeaseId
        || (step.requiresOperatorConfirmation && !capture.conditionVerification.confirmationId)
        || (!step.requiresOperatorConfirmation && capture.conditionVerification.confirmationId != null)) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Capture provenance does not exactly match step ${step.id}`,
        );
      }
    }
    const capturedSteps = plan.steps.filter((step) => step.capture);
    const operatorLeaseIds = [...new Set(capturedSteps
      .filter((step) => step.requiresOperatorConfirmation)
      .map((step) => step.confirmationLeaseId))];
    const confirmationIdByLease = new Map();
    for (const leaseId of operatorLeaseIds) {
      const confirmationIds = new Set(captures
        .filter((capture) => capture.conditionVerification.confirmationLeaseId === leaseId)
        .map((capture) => capture.conditionVerification.confirmationId));
      if (!leaseId || confirmationIds.size !== 1) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Operator confirmation lease ${leaseId || "(missing)"} is not backed by one exact confirmation`,
        );
      }
      confirmationIdByLease.set(leaseId, [...confirmationIds][0]);
    }
    if (new Set(confirmationIdByLease.values()).size !== confirmationIdByLease.size) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        "Operator confirmation ids cannot be replayed across different physical-condition leases",
      );
    }
    for (const step of capturedSteps) {
      const matching = stacks.filter((stack) => stack.stepId === step.id);
      const expectedIds = expected.filter((item) => item.step.id === step.id).map((item) => item.id).sort();
      if (matching.length !== 1
        || canonicalJson([...matching[0].sourceCaptureIds].sort()) !== canonicalJson(expectedIds)
        || matching[0].channels !== step.retention.channels
        || matching[0].method !== step.retention.aggregationMethod
        || canonicalJson([...matching[0].statistics].sort()) !== canonicalJson([...step.retention.statistics].sort())) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Capture stack does not exactly cover step ${step.id}`,
        );
      }
    }
  }
  const lens = normalizeLensProvenance(value.lens);
  if (profiles.some((profile) => profile.settings.apertureF !== lens.apertureF)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Lens aperture provenance does not match every exposure profile",
    );
  }
  const pipeline = normalizeCapturePipeline(value.pipeline);
  const decoder = normalizeRawDecoderProvenance(value.decoder);
  const rawDecode = normalizeRawDecodeMetadata(value.rawDecode, { bitDepth: pipeline.bitDepth });
  if (captures.some((capture) => capture.frame.bitDepth !== pipeline.bitDepth
    || capture.frame.linearized !== pipeline.linearized
    || capture.frame.pixelFormat !== pipeline.retainedPixelFormat)
    || new Set(captures.map((capture) => `${capture.frame.width}x${capture.frame.height}`)).size !== 1) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Per-capture frame provenance or raster dimensions do not match the capture pipeline",
    );
  }
  return {
    version: 2,
    device,
    lens,
    pipeline,
    decoder,
    rawDecode,
    colorCharacterization: normalizeColorCharacterization(value.colorCharacterization),
    exposureProfiles: provenanceProfiles,
    expectedCaptureIds,
    captures,
    stacks,
  };
}

function normalizeOptionalFiniteVector(value, field, length, minimum, maximum) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length !== length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field} must contain ${length} values`);
  }
  return value.map((item, index) => requiredFinite(
    item,
    minimum,
    maximum,
    `${field}[${index}]`,
    "INVALID_CALIBRATION_MANIFEST",
  ));
}

function normalizeMeasuredExposureNormalization(input, field) {
  const value = object(input, field);
  const gatesValue = object(value.gates, `${field}.gates`);
  const nominalScale = requiredFinite(
    value.nominalScale,
    1 + Number.EPSILON,
    1e9,
    `${field}.nominalScale`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const measuredScaleRgb = normalizeOptionalFiniteVector(value.measuredScaleRgb, `${field}.measuredScaleRgb`, 3, 1e-9, 1e9);
  const relativeErrorRgb = normalizeOptionalFiniteVector(value.relativeErrorRgb, `${field}.relativeErrorRgb`, 3, 0, 1e6);
  const uncertaintyRgb = normalizeOptionalFiniteVector(value.uncertaintyRgb, `${field}.uncertaintyRgb`, 3, 0, 1);
  if (!measuredScaleRgb || !relativeErrorRgb || !uncertaintyRgb) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} requires three-channel measured scale, error and uncertainty`,
    );
  }
  const measuredScaleLuma = requiredFinite(
    value.measuredScaleLuma,
    1e-9,
    1e9,
    `${field}.measuredScaleLuma`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const relativeErrorLuma = requiredFinite(
    value.relativeErrorLuma,
    0,
    1e6,
    `${field}.relativeErrorLuma`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const uncertaintyLuma = requiredFinite(
    value.uncertaintyLuma,
    0,
    1,
    `${field}.uncertaintyLuma`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const inputRgb = normalizeOptionalFiniteVector(value.inputRgb, `${field}.inputRgb`, 3, 1 / 65_535, 0.1);
  if (!inputRgb || Math.max(...inputRgb) - Math.min(...inputRgb) > 1e-12) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.inputRgb must be one neutral bridge level`);
  }
  const gates = {
    passed: boolean(gatesValue.passed, null, `${field}.gates.passed`),
    maximumRelativeError: requiredFinite(
      gatesValue.maximumRelativeError,
      0,
      1,
      `${field}.gates.maximumRelativeError`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumUncertainty: requiredFinite(
      gatesValue.maximumUncertainty,
      0,
      1,
      `${field}.gates.maximumUncertainty`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    minimumSnrDb: requiredFinite(
      gatesValue.minimumSnrDb,
      -100,
      300,
      `${field}.gates.minimumSnrDb`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumClippedFraction: requiredFinite(
      gatesValue.maximumClippedFraction,
      0,
      1,
      `${field}.gates.maximumClippedFraction`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
  };
  const expectedRgbErrors = measuredScaleRgb.map((scale) => Math.abs(scale / nominalScale - 1));
  const expectedLumaError = Math.abs(measuredScaleLuma / nominalScale - 1);
  if (relativeErrorRgb.some((error, index) => Math.abs(error - expectedRgbErrors[index]) > 1e-9)
    || Math.abs(relativeErrorLuma - expectedLumaError) > 1e-9) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} relative errors do not match measured and nominal exposure scales`,
    );
  }
  const snrDb = requiredFinite(value.snrDb, -100, 300, `${field}.snrDb`, "INVALID_CALIBRATION_MANIFEST");
  const clippedFraction = requiredFinite(
    value.clippedFraction,
    0,
    1,
    `${field}.clippedFraction`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const actuallyPassed = Math.max(...relativeErrorRgb, relativeErrorLuma) <= gates.maximumRelativeError
    && Math.max(...uncertaintyRgb, uncertaintyLuma) <= gates.maximumUncertainty
    && snrDb >= gates.minimumSnrDb
    && clippedFraction <= gates.maximumClippedFraction;
  const status = oneOf(value.status, ["passed", "failed"], `${field}.status`);
  if (gates.passed !== actuallyPassed || (status === "passed") !== actuallyPassed) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} status does not match its measured scale gates`,
    );
  }
  return {
    bridgeId: safeText(value.bridgeId, `${field}.bridgeId`, { maximum: 512 }),
    shortStepId: safeText(value.shortStepId, `${field}.shortStepId`, { maximum: 512 }),
    longStepId: safeText(value.longStepId, `${field}.longStepId`, { maximum: 512 }),
    shortProfileId: safeText(value.shortProfileId, `${field}.shortProfileId`, { maximum: 64 }),
    longProfileId: safeText(value.longProfileId, `${field}.longProfileId`, { maximum: 64 }),
    inputRgb,
    shortCaptureIds: uniqueTextList(value.shortCaptureIds, `${field}.shortCaptureIds`, { minimum: 3, maximum: 16 }),
    longCaptureIds: uniqueTextList(value.longCaptureIds, `${field}.longCaptureIds`, { minimum: 3, maximum: 16 }),
    nominalScale,
    measuredScaleRgb,
    measuredScaleLuma,
    relativeErrorRgb,
    relativeErrorLuma,
    uncertaintyRgb,
    uncertaintyLuma,
    snrDb,
    clippedFraction,
    status,
    gates,
  };
}

function validateMeasuredExposureNormalization({
  evidence,
  output,
  captureById,
  exposureProfiles,
  plan,
  sessionId,
}) {
  const field = `manifest.outputs[${output.outputId}].radiometry.measuredExposureNormalization`;
  const geometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY);
  const radiometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY);
  const expectedBridgeId = `${sessionId}/${output.outputId}/exposure-bridge`;
  const expectedShortStepId = `${expectedBridgeId}-short`;
  const expectedLongStepId = `${expectedBridgeId}-long`;
  const policy = plan?.exposureBridgePolicy ?? {
    method: "paired-neutral-solid-v1",
    inputLevel: 0.5 / radiometryProfile.normalizationScale,
    nominalScale: radiometryProfile.normalizationScale,
    maximumRelativeError: 0.05,
    maximumUncertainty: 0.03,
    minimumSnrDb: 20,
    maximumClippedFraction: 0.01,
    required: true,
  };
  const expectedInputRgb = Array(3).fill(policy.inputLevel);
  const expectedGateThresholds = {
    maximumRelativeError: policy.maximumRelativeError,
    maximumUncertainty: policy.maximumUncertainty,
    minimumSnrDb: policy.minimumSnrDb,
    maximumClippedFraction: policy.maximumClippedFraction,
  };
  if (evidence.bridgeId !== expectedBridgeId
    || evidence.shortStepId !== expectedShortStepId
    || evidence.longStepId !== expectedLongStepId
    || evidence.shortProfileId !== geometryProfile.id
    || evidence.longProfileId !== radiometryProfile.id
    || evidence.nominalScale !== policy.nominalScale
    || canonicalJson(evidence.inputRgb) !== canonicalJson(expectedInputRgb)
    || canonicalJson({
      maximumRelativeError: evidence.gates.maximumRelativeError,
      maximumUncertainty: evidence.gates.maximumUncertainty,
      minimumSnrDb: evidence.gates.minimumSnrDb,
      maximumClippedFraction: evidence.gates.maximumClippedFraction,
    }) !== canonicalJson(expectedGateThresholds)
    || evidence.status !== "passed"
    || evidence.gates.passed !== true) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} does not match the required optical bridge and gates`,
    );
  }
  const validateSide = ({ captureIds, stepId, profile, passId }) => {
    const physicalIds = [...captureById.values()]
      .filter((capture) => capture.stepId === stepId)
      .map((capture) => capture.id)
      .sort();
    if (canonicalJson([...captureIds].sort()) !== canonicalJson(physicalIds)
      || physicalIds.length < CAMERA_CALIBRATION_REPEAT_LIMITS.radiometry.minimum
      || captureIds.some((id) => !output.captureIds.includes(id))) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        `${field} does not exactly cover its physical bridge captures`,
      );
    }
    for (const id of captureIds) {
      const capture = captureById.get(id);
      if (!capture
        || capture.outputId !== output.outputId
        || capture.passId !== passId
        || capture.exposureProfileId !== profile.id
        || capture.referenceKind !== null
        || capture.conditionVerification.projectorState !== "target-pattern"
        || capture.conditionVerification.opticalPath !== "open"
        || capture.conditionVerification.otherProjectors !== "digital-black"
        || canonicalJson(capture.exposure) !== canonicalJson({
          normalizationScale: profile.normalizationScale,
          settings: profile.settings,
        })) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `${field} capture ${id} is not a verified matching bridge capture`,
        );
      }
    }
  };
  validateSide({
    captureIds: evidence.shortCaptureIds,
    stepId: expectedShortStepId,
    profile: geometryProfile,
    passId: `radiometry-short-${geometryProfile.id}`,
  });
  validateSide({
    captureIds: evidence.longCaptureIds,
    stepId: expectedLongStepId,
    profile: radiometryProfile,
    passId: `radiometry-long-${radiometryProfile.id}`,
  });
  if (plan) {
    const bridgeSteps = plan.steps.filter((step) => (
      step.outputId === output.outputId && step.semantic === "exposure-bridge"
    ));
    const expectedPlanSteps = [
      { role: "short", id: expectedShortStepId, profileId: geometryProfile.id, peerId: radiometryProfile.id },
      { role: "long", id: expectedLongStepId, profileId: radiometryProfile.id, peerId: geometryProfile.id },
    ];
    if (bridgeSteps.length !== 2 || expectedPlanSteps.some((expected) => {
      const step = bridgeSteps.find((candidate) => candidate.bridgeRole === expected.role);
      return !step
        || step.id !== expected.id
        || step.bridgeId !== expectedBridgeId
        || step.exposureProfileId !== expected.profileId
        || step.pairedExposureProfileId !== expected.peerId
        || canonicalJson(step.inputRgb) !== canonicalJson(expectedInputRgb);
    })) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        `${field} does not match the planned bridge pair`,
      );
    }
  }
}

function normalizeAmbientDiagnostic(input, field) {
  const value = object(input, field);
  const negativeBeyondUncertaintyFraction = requiredFinite(
    value.negativeBeyondUncertaintyFraction,
    0,
    1,
    `${field}.negativeBeyondUncertaintyFraction`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const maximumNegativeBeyondUncertaintyFraction = requiredFinite(
    value.maximumNegativeBeyondUncertaintyFraction,
    0,
    1,
    `${field}.maximumNegativeBeyondUncertaintyFraction`,
    "INVALID_CALIBRATION_MANIFEST",
  );
  const status = oneOf(value.status, ["passed", "failed"], `${field}.status`);
  const actuallyPassed = negativeBeyondUncertaintyFraction <= maximumNegativeBeyondUncertaintyFraction;
  if ((status === "passed") !== actuallyPassed) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field}.status does not match the ambient comparison threshold`,
    );
  }
  return {
    status,
    medianProjectorLeakage: requiredFinite(
      value.medianProjectorLeakage,
      -1,
      1,
      `${field}.medianProjectorLeakage`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    negativeBeyondUncertaintyFraction,
    uncertaintyP95: requiredFinite(
      value.uncertaintyP95,
      0,
      1,
      `${field}.uncertaintyP95`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    captureIds: uniqueTextList(value.captureIds, `${field}.captureIds`, { minimum: 2, maximum: 256 }),
    maximumNegativeBeyondUncertaintyFraction,
  };
}

function normalizeRadiometryEvidence(input, field, lutArtifact) {
  const value = object(input, field);
  const referenceCaptureIds = object(value.referenceCaptureIds, `${field}.referenceCaptureIds`);
  const samplesValue = object(value.samples, `${field}.samples`);
  const fitValue = object(value.fit, `${field}.fit`);
  const blackValue = object(value.black, `${field}.black`);
  const gatesValue = object(value.gates, `${field}.gates`);
  const lutValue = object(value.lut, `${field}.lut`);
  const ambientDiagnostic = normalizeAmbientDiagnostic(value.ambientDiagnostic, `${field}.ambientDiagnostic`);
  const samples = {
    total: requiredExactInteger(
      samplesValue.total,
      1,
      Number.MAX_SAFE_INTEGER,
      `${field}.samples.total`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    usable: requiredExactInteger(
      samplesValue.usable,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.samples.usable`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    rejectedClipped: requiredExactInteger(
      samplesValue.rejectedClipped,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.samples.rejectedClipped`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    rejectedLowSnr: requiredExactInteger(
      samplesValue.rejectedLowSnr,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.samples.rejectedLowSnr`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    rejectedNonMonotonic: exactInteger(
      samplesValue.rejectedNonMonotonic,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.samples.rejectedNonMonotonic`,
    ),
  };
  if (samples.usable + samples.rejectedClipped + samples.rejectedLowSnr + samples.rejectedNonMonotonic > samples.total) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.samples rejection counts exceed total`);
  }
  const fit = {
    rmse: requiredFinite(fitValue.rmse, 0, 1, `${field}.fit.rmse`, "INVALID_CALIBRATION_MANIFEST"),
    maxAbsoluteError: requiredFinite(
      fitValue.maxAbsoluteError,
      0,
      1,
      `${field}.fit.maxAbsoluteError`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    snrDb: requiredFinite(fitValue.snrDb, -100, 300, `${field}.fit.snrDb`, "INVALID_CALIBRATION_MANIFEST"),
    nearBlackSnrDb: requiredFinite(
      fitValue.nearBlackSnrDb,
      -100,
      300,
      `${field}.fit.nearBlackSnrDb`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    coverage: requiredFinite(fitValue.coverage, 0, 1, `${field}.fit.coverage`, "INVALID_CALIBRATION_MANIFEST"),
    clippedFraction: requiredFinite(
      fitValue.clippedFraction,
      0,
      1,
      `${field}.fit.clippedFraction`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    gammaRgb: normalizeOptionalFiniteVector(fitValue.gammaRgb, `${field}.fit.gammaRgb`, 3, 0.1, 8),
    channelRmse: normalizeOptionalFiniteVector(fitValue.channelRmse, `${field}.fit.channelRmse`, 3, 0, 1),
    matrixDeterminant: fitValue.matrixDeterminant == null
      ? null
      : requiredFinite(
        fitValue.matrixDeterminant,
        -1e6,
        1e6,
        `${field}.fit.matrixDeterminant`,
        "INVALID_CALIBRATION_MANIFEST",
      ),
    matrixCondition: fitValue.matrixCondition == null
      ? null
      : requiredFinite(
        fitValue.matrixCondition,
        1,
        1e12,
        `${field}.fit.matrixCondition`,
        "INVALID_CALIBRATION_MANIFEST",
      ),
    gamutCoverage: fitValue.gamutCoverage == null
      ? null
      : requiredFinite(
        fitValue.gamutCoverage,
        0,
        1,
        `${field}.fit.gamutCoverage`,
        "INVALID_CALIBRATION_MANIFEST",
      ),
    identityVerified: boolean(fitValue.identityVerified, null, `${field}.fit.identityVerified`),
  };
  const combinedUncertaintyValue = blackValue.combinedUncertainty == null
    ? null
    : object(blackValue.combinedUncertainty, `${field}.black.combinedUncertainty`);
  const combinedUncertainty = combinedUncertaintyValue == null ? null : {
    status: oneOf(
      combinedUncertaintyValue.status,
      ["measured", "unavailable"],
      `${field}.black.combinedUncertainty.status`,
    ),
    candidatePixels: requiredExactInteger(
      combinedUncertaintyValue.candidatePixels,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.black.combinedUncertainty.candidatePixels`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    uncertainPixels: requiredExactInteger(
      combinedUncertaintyValue.uncertainPixels,
      0,
      Number.MAX_SAFE_INTEGER,
      `${field}.black.combinedUncertainty.uncertainPixels`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    uncertainFraction: requiredFinite(
      combinedUncertaintyValue.uncertainFraction,
      0,
      1,
      `${field}.black.combinedUncertainty.uncertainFraction`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    uncertaintySigma: requiredFinite(
      combinedUncertaintyValue.uncertaintySigma,
      0,
      20,
      `${field}.black.combinedUncertainty.uncertaintySigma`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
  };
  if (combinedUncertainty
    && (combinedUncertainty.uncertainPixels > combinedUncertainty.candidatePixels
      || Math.abs(combinedUncertainty.uncertainFraction - (
        combinedUncertainty.candidatePixels > 0
          ? combinedUncertainty.uncertainPixels / combinedUncertainty.candidatePixels
          : 0
      )) > 1e-9)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field}.black.combinedUncertainty counts and fraction disagree`,
    );
  }
  const black = {
    basis: oneOf(
      blackValue.basis,
      ["total-observed-projector-black-after-sensor-dark"],
      `${field}.black.basis`,
    ),
    status: oneOf(blackValue.status, ["passed", "failed"], `${field}.black.status`),
    uncertaintyP95: requiredFinite(
      blackValue.uncertaintyP95,
      0,
      1,
      `${field}.black.uncertaintyP95`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    nonuniformityRange: requiredFinite(
      blackValue.nonuniformityRange,
      0,
      1,
      `${field}.black.nonuniformityRange`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    snrDb: requiredFinite(blackValue.snrDb, -100, 300, `${field}.black.snrDb`, "INVALID_CALIBRATION_MANIFEST"),
    target: requiredFinite(blackValue.target, 0, 1, `${field}.black.target`, "INVALID_CALIBRATION_MANIFEST"),
    maxLift: requiredFinite(blackValue.maxLift, 0, 1, `${field}.black.maxLift`, "INVALID_CALIBRATION_MANIFEST"),
    combinedUncertainty,
  };
  const gates = {
    passed: boolean(gatesValue.passed, null, `${field}.gates.passed`),
    minimumUsableSamples: requiredExactInteger(
      gatesValue.minimumUsableSamples,
      1,
      Number.MAX_SAFE_INTEGER,
      `${field}.gates.minimumUsableSamples`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumRmse: requiredFinite(
      gatesValue.maximumRmse,
      0,
      1,
      `${field}.gates.maximumRmse`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    minimumSnrDb: requiredFinite(
      gatesValue.minimumSnrDb,
      -100,
      300,
      `${field}.gates.minimumSnrDb`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    minimumNearBlackSnrDb: requiredFinite(
      gatesValue.minimumNearBlackSnrDb,
      -100,
      300,
      `${field}.gates.minimumNearBlackSnrDb`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    minimumCoverage: requiredFinite(
      gatesValue.minimumCoverage,
      0,
      1,
      `${field}.gates.minimumCoverage`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumClippedFraction: requiredFinite(
      gatesValue.maximumClippedFraction,
      0,
      1,
      `${field}.gates.maximumClippedFraction`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumBlackUncertaintyP95: requiredFinite(
      gatesValue.maximumBlackUncertaintyP95,
      0,
      1,
      `${field}.gates.maximumBlackUncertaintyP95`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumBlackLift: requiredFinite(
      gatesValue.maximumBlackLift,
      0,
      1,
      `${field}.gates.maximumBlackLift`,
      "INVALID_CALIBRATION_MANIFEST",
    ),
  };
  const gateActuallyPassed = samples.usable >= gates.minimumUsableSamples
    && fit.rmse <= gates.maximumRmse
    && fit.snrDb >= gates.minimumSnrDb
    && fit.nearBlackSnrDb >= gates.minimumNearBlackSnrDb
    && fit.coverage >= gates.minimumCoverage
    && fit.clippedFraction <= gates.maximumClippedFraction
    && black.uncertaintyP95 <= gates.maximumBlackUncertaintyP95
    && black.maxLift <= gates.maximumBlackLift
    && black.status === "passed"
    && ambientDiagnostic.status === "passed";
  if (gates.passed !== gateActuallyPassed) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field}.gates.passed does not match the recorded metrics and thresholds`,
    );
  }
  const lut = {
    method: safeText(lutValue.method, `${field}.lut.method`, { maximum: 128 }),
    artifactSha256: normalizeSha256(lutValue.artifactSha256, `${field}.lut.artifactSha256`),
  };
  if (lut.artifactSha256 !== lutArtifact.sha256) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `${field}.lut digest does not match the LUT artifact`);
  }
  return {
    method: safeText(value.method, `${field}.method`, { maximum: 128 }),
    status: oneOf(value.status, ["passed", "failed"], `${field}.status`),
    colorBasis: oneOf(
      value.colorBasis,
      ["camera-relative-rgb", "characterized-colorimetric", "identity-only"],
      `${field}.colorBasis`,
    ),
    colorimetric: boolean(value.colorimetric, null, `${field}.colorimetric`),
    measuredExposureNormalization: normalizeMeasuredExposureNormalization(
      value.measuredExposureNormalization,
      `${field}.measuredExposureNormalization`,
    ),
    ambientDiagnostic,
    referenceCaptureIds: {
      sensorDark: uniqueTextList(referenceCaptureIds.sensorDark, `${field}.referenceCaptureIds.sensorDark`, {
        minimum: 1,
        maximum: 128,
      }),
      projectorsOffAmbient: uniqueTextList(
        referenceCaptureIds.projectorsOffAmbient,
        `${field}.referenceCaptureIds.projectorsOffAmbient`,
        { minimum: 1, maximum: 128 },
      ),
      projectorBlack: uniqueTextList(referenceCaptureIds.projectorBlack, `${field}.referenceCaptureIds.projectorBlack`, {
        minimum: 1,
        maximum: 128,
      }),
    },
    samples,
    fit,
    black,
    gates,
    lut,
  };
}

function normalizeMarkerlessGeometryEvidence(input, field) {
  const value = object(input, field);
  rejectUnknownKeys(value, [
    "status", "method", "surveyId", "wallId", "cameraViewId", "lensProfileSha256", "frame",
    "targetPointCount", "correspondence", "gates",
  ], field, "INVALID_CALIBRATION_MANIFEST");
  const frame = object(value.frame, `${field}.frame`);
  const correspondence = object(value.correspondence, `${field}.correspondence`);
  const searchDistancePx = object(correspondence.searchDistancePx, `${field}.correspondence.searchDistancePx`);
  const gates = object(value.gates, `${field}.gates`);
  const status = oneOf(value.status, ["passed", "failed", "simulated"], `${field}.status`);
  const normalizedGates = {
    minimumConfidence: requiredFinite(
      gates.minimumConfidence, 0, 1, `${field}.gates.minimumConfidence`, "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumP95Px: requiredFinite(
      gates.maximumP95Px, 0, 1_024, `${field}.gates.maximumP95Px`, "INVALID_CALIBRATION_MANIFEST",
    ),
    maximumMaxPx: requiredFinite(
      gates.maximumMaxPx, 0, 1_024, `${field}.gates.maximumMaxPx`, "INVALID_CALIBRATION_MANIFEST",
    ),
    passed: boolean(gates.passed, null, `${field}.gates.passed`),
  };
  if (status === "passed" && normalizedGates.passed !== true) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `${field} cannot claim passed while a markerless geometry gate failed`,
    );
  }
  return {
    status,
    method: oneOf(value.method, ["operator-four-corner-planar-v1"], `${field}.method`),
    surveyId: safeText(value.surveyId, `${field}.surveyId`, { maximum: 128 }),
    wallId: safeText(value.wallId, `${field}.wallId`, { maximum: 128 }),
    cameraViewId: safeText(value.cameraViewId, `${field}.cameraViewId`, { maximum: 128 }),
    lensProfileSha256: normalizeSha256(value.lensProfileSha256, `${field}.lensProfileSha256`),
    frame: {
      width: requiredExactInteger(frame.width, 32, 16_384, `${field}.frame.width`, "INVALID_CALIBRATION_MANIFEST"),
      height: requiredExactInteger(frame.height, 32, 16_384, `${field}.frame.height`, "INVALID_CALIBRATION_MANIFEST"),
    },
    targetPointCount: requiredExactInteger(
      value.targetPointCount, 9, 16_641, `${field}.targetPointCount`, "INVALID_CALIBRATION_MANIFEST",
    ),
    correspondence: {
      confidence: requiredFinite(
        correspondence.confidence, 0, 1, `${field}.correspondence.confidence`, "INVALID_CALIBRATION_MANIFEST",
      ),
      holes: requiredExactInteger(
        correspondence.holes, 0, 16_641, `${field}.correspondence.holes`, "INVALID_CALIBRATION_MANIFEST",
      ),
      searchDistancePx: {
        median: requiredFinite(
          searchDistancePx.median, 0, 65_536, `${field}.correspondence.searchDistancePx.median`,
          "INVALID_CALIBRATION_MANIFEST",
        ),
        p95: requiredFinite(
          searchDistancePx.p95, 0, 65_536, `${field}.correspondence.searchDistancePx.p95`,
          "INVALID_CALIBRATION_MANIFEST",
        ),
        max: requiredFinite(
          searchDistancePx.max, 0, 65_536, `${field}.correspondence.searchDistancePx.max`,
          "INVALID_CALIBRATION_MANIFEST",
        ),
      },
    },
    gates: normalizedGates,
  };
}

function normalizeOutputManifest(input, index) {
  const value = object(input, `manifest.outputs[${index}]`);
  const artifacts = object(value.artifacts, `manifest.outputs[${index}].artifacts`);
  if (!Array.isArray(value.captureIds) || value.captureIds.length < 1 || value.captureIds.length > 4_096) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `manifest.outputs[${index}].captureIds must contain 1-4096 capture ids`,
    );
  }
  const warpValue = object(artifacts.warp, `manifest.outputs[${index}].artifacts.warp`);
  const warpAsset = normalizeArtifactRef(warpValue, `manifest.outputs[${index}].artifacts.warp`, ["pb-warp-mesh-v1"]);
  const columns = integer(warpValue.columns, 32, 2, 128, "warp.columns");
  const rows = integer(warpValue.rows, 18, 2, 128, "warp.rows");
  const pointCount = integer(warpValue.pointCount, 0, 9, 16_641, "warp.pointCount");
  if (pointCount !== (columns + 1) * (rows + 1)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Warp point count does not match rows and columns");
  }
  const gamma = object(artifacts.gamma, `manifest.outputs[${index}].artifacts.gamma`);
  if (!Array.isArray(gamma.rgb) || gamma.rgb.length !== 3) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Gamma artifact requires three channels");
  }
  const lutValue = object(artifacts.lut, `manifest.outputs[${index}].artifacts.lut`);
  const lut = normalizeArtifactRef(lutValue, `manifest.outputs[${index}].artifacts.lut`, ["rgba32_float"]);
  const lutStatus = String(lutValue.status || "");
  if (!new Set(["measured", "measured-relative", "identity-fallback"]).has(lutStatus)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "LUT status must be measured, measured-relative or identity-fallback",
    );
  }
  const normalizedLut = { ...lut, status: lutStatus, confidence: finite(lutValue.confidence, 0, 0, 1, "lut.confidence") };
  const captureIds = value.captureIds.map((id, captureIndex) => safeText(id, `captureIds[${captureIndex}]`, { maximum: 512 }));
  if (new Set(captureIds).size !== captureIds.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `manifest.outputs[${index}].captureIds must be unique`);
  }
  return {
    outputId: safeText(value.outputId, `manifest.outputs[${index}].outputId`, { maximum: 64 }),
    captureIds,
    geometry: value.geometry == null
      ? null
      : normalizeMarkerlessGeometryEvidence(value.geometry, `manifest.outputs[${index}].geometry`),
    artifacts: {
      warp: {
        ...warpAsset,
        columns,
        rows,
        interpolation: String(warpValue.interpolation || "bicubic") === "bilinear" ? "bilinear" : "bicubic",
        pointCount,
      },
      blendWeight: normalizeTextureArtifact(artifacts.blendWeight, `manifest.outputs[${index}].artifacts.blendWeight`),
      blackPedestal: normalizeTextureArtifact(artifacts.blackPedestal, `manifest.outputs[${index}].artifacts.blackPedestal`),
      mask: normalizeTextureArtifact(artifacts.mask, `manifest.outputs[${index}].artifacts.mask`),
      confidence: normalizeTextureArtifact(artifacts.confidence, `manifest.outputs[${index}].artifacts.confidence`),
      gamma: {
        rgb: gamma.rgb.map((channel, channelIndex) => finite(channel, 1, 0.1, 8, `gamma.rgb[${channelIndex}]`)),
        confidence: finite(gamma.confidence, 0, 0, 1, "gamma.confidence"),
        method: safeText(gamma.method || "tone-response-v1", "gamma.method", { maximum: 128 }),
      },
      lut: normalizedLut,
    },
    radiometry: value.radiometry == null
      ? null
      : normalizeRadiometryEvidence(value.radiometry, `manifest.outputs[${index}].radiometry`, normalizedLut),
  };
}

export function normalizeCameraCalibrationManifest(input, { plan = null } = {}) {
  const value = object(input, "calibration manifest");
  if (value.schemaVersion !== CAMERA_CALIBRATION_SCHEMA_VERSION) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      `Calibration manifest schemaVersion must be ${CAMERA_CALIBRATION_SCHEMA_VERSION}`,
    );
  }
  const sessionId = safeText(value.sessionId, "manifest.sessionId", { maximum: 128 });
  const normalizedPlan = plan == null ? null : normalizeCameraCalibrationPlan(plan);
  const provenance = String(value.provenance || "");
  if (!new Set(["measured", "simulated"]).has(provenance)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest provenance must be measured or simulated");
  }
  const requestedApplicable = boolean(value.applicable, null, "manifest.applicable");
  if (provenance === "simulated" && requestedApplicable) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "A simulated manifest can never be applicable");
  }
  const applicable = provenance === "measured" && requestedApplicable;
  const camera = normalizeCameraDescriptor(value.camera);
  if (applicable && (camera.transport === "simulation" || camera.backend === "deterministic-camera-v1")) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "A simulated camera source can never produce an applicable measured manifest",
    );
  }
  const exposureProfiles = normalizeCameraExposureProfiles(value.exposureProfiles ?? normalizedPlan?.exposureProfiles);
  if (normalizedPlan && canonicalJson(exposureProfiles) !== canonicalJson(normalizedPlan.exposureProfiles)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest exposure profiles do not match the plan");
  }
  const geometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.GEOMETRY);
  const cameraSettings = normalizeManualCameraSettings(value.cameraSettings ?? geometryProfile.settings);
  if (canonicalJson(cameraSettings) !== canonicalJson(geometryProfile.settings)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Manifest cameraSettings alias must exactly match the geometry exposure profile",
    );
  }
  const expectedSourcePolicy = {
    arena: "blanked",
    owner: "pixel-brightness-pattern-override",
    failure: "remain-black",
    success: "restore-composition",
  };
  const sourcePolicy = value.sourcePolicy ?? normalizedPlan?.sourcePolicy;
  if (canonicalJson(sourcePolicy) !== canonicalJson(expectedSourcePolicy)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest source policy is not fail-closed");
  }
  const outputs = Array.isArray(value.outputs) ? value.outputs.map(normalizeOutputManifest) : [];
  if (outputs.length < 1 || new Set(outputs.map((output) => output.outputId)).size !== outputs.length) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest outputs must be non-empty and unique");
  }
  const captureProvenance = value.captureProvenance == null
    ? null
    : normalizeCaptureProvenance(value.captureProvenance, {
      plan: normalizedPlan,
      camera,
      profiles: exposureProfiles,
    });
  let lensProfile = null;
  if (value.lensProfile != null || normalizedPlan?.lensProfile != null) {
    try {
      lensProfile = normalizeCameraLensProfile(value.lensProfile ?? normalizedPlan.lensProfile);
    } catch (error) {
      throw new CameraCalibrationError(
        error?.code || "INVALID_CALIBRATION_MANIFEST",
        error?.message || "Manifest lens profile is invalid",
        error?.details ?? null,
      );
    }
    if (normalizedPlan?.lensProfile
      && canonicalJson(lensProfile) !== canonicalJson(normalizedPlan.lensProfile)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        "Manifest lens profile does not match the calibration plan",
      );
    }
  }
  const markerlessOutputs = outputs.filter((output) => output.geometry != null);
  if ((markerlessOutputs.length > 0) !== Boolean(lensProfile)) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "Markerless geometry evidence and its complete lens profile must be present together",
    );
  }
  if (applicable && !captureProvenance) {
    throw new CameraCalibrationError(
      "INVALID_CALIBRATION_MANIFEST",
      "An applicable measured manifest requires complete capture provenance",
    );
  }
  if (applicable && lensProfile) {
    const lens = captureProvenance.lens;
    const matches = lensProfile.camera.manufacturer === camera.vendor
      && lensProfile.camera.model === camera.model
      && lensProfile.camera.serialNumber === camera.serial
      && lensProfile.lens.manufacturer === lens.vendor
      && lensProfile.lens.model === lens.model
      && lensProfile.lens.serialNumber === lens.serial
      && Math.abs(lensProfile.capture.focalLengthMm - lens.focalLengthMm) <= 0.05
      && Math.abs(lensProfile.capture.apertureFNumber - lens.apertureF) <= 0.05
      && lens.focusDistanceM != null
      && Math.abs(lensProfile.capture.focusDistanceM - lens.focusDistanceM)
        <= Math.max(0.02, lensProfile.capture.focusDistanceM * 0.02)
      && exposureProfiles.every((profile) => (
        Math.abs(profile.settings.apertureF - lensProfile.capture.apertureFNumber) <= 0.01
      ))
      && captureProvenance.captures.every((capture) => (
        capture.frame.width === lensProfile.frame.width && capture.frame.height === lensProfile.frame.height
      ));
    if (!matches) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_MANIFEST",
        "Applicable markerless geometry is not bound to matching camera, lens, focus, focal length, aperture and raster provenance",
      );
    }
  }
  const captureById = new Map((captureProvenance?.captures ?? []).map((capture) => [capture.id, capture]));
  if (captureProvenance) {
    for (const output of outputs) {
      if (output.captureIds.some((id) => !captureById.has(id))) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Output ${output.outputId} refers to a capture missing from provenance`,
        );
      }
    }
  }
  if (normalizedPlan) {
    if (sessionId !== normalizedPlan.sessionId) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest session does not match plan");
    }
    const expected = normalizedPlan.outputs.map((output) => output.id).sort();
    const actual = outputs.map((output) => output.outputId).sort();
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest outputs do not match the calibration plan");
    }
    const globalCaptureIds = normalizedPlan.steps
      .filter((step) => step.outputId == null && step.capture)
      .flatMap((step) => Array.from({ length: step.repeats }, (_value, repeat) => `${step.id}#${repeat}`));
    for (const plannedOutput of normalizedPlan.outputs) {
      const manifestOutput = outputs.find((output) => output.outputId === plannedOutput.id);
      if (plannedOutput.surfaceTarget) {
        const geometry = manifestOutput.geometry;
        const target = plannedOutput.surfaceTarget;
        if (!geometry
          || geometry.method !== target.method
          || geometry.surveyId !== target.surveyId
          || geometry.wallId !== target.wallId
          || geometry.cameraViewId !== target.cameraViewId
          || geometry.lensProfileSha256 !== target.lensProfileSha256
          || geometry.frame.width !== target.frame.width
          || geometry.frame.height !== target.frame.height
          || geometry.targetPointCount !== manifestOutput.artifacts.warp.pointCount
          || (applicable && (geometry.status !== "passed" || geometry.gates.passed !== true))) {
          throw new CameraCalibrationError(
            "INVALID_CALIBRATION_MANIFEST",
            `Markerless geometry evidence does not match the planned surface target for ${plannedOutput.id}`,
          );
        }
      } else if (manifestOutput.geometry != null) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Output ${plannedOutput.id} contains markerless geometry evidence without a planned surface target`,
        );
      }
      const outputCaptureIds = normalizedPlan.steps
        .filter((step) => step.outputId === plannedOutput.id && step.capture)
        .flatMap((step) => Array.from({ length: step.repeats }, (_value, repeat) => `${step.id}#${repeat}`));
      // Legacy simulated manifests may omit global references because they can
      // never be applied. Every measured/applicable V2 output must include them.
      const expectedCaptureIds = [...(applicable ? globalCaptureIds : []), ...outputCaptureIds].sort();
      if (canonicalJson([...manifestOutput.captureIds].sort()) !== canonicalJson(expectedCaptureIds)) {
        throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", `Capture manifest is incomplete for output ${plannedOutput.id}`);
      }
      for (const field of ["blendWeight", "blackPedestal", "mask", "confidence"]) {
        const artifact = manifestOutput.artifacts[field];
        if (artifact.width !== plannedOutput.width || artifact.height !== plannedOutput.height) {
          throw new CameraCalibrationError(
            "INVALID_CALIBRATION_MANIFEST",
            `${plannedOutput.id}.${field} must be materialized at projector resolution`,
          );
        }
      }
    }
  }
  if (applicable) {
    const radiometryProfile = exposureProfiles.find((profile) => profile.role === CAMERA_EXPOSURE_PROFILE_ROLE.RADIOMETRY);
    for (const output of outputs) {
      const evidence = output.radiometry;
      if (!evidence || evidence.status !== "passed" || evidence.gates.passed !== true) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Output ${output.outputId} is missing passed radiometric evidence`,
        );
      }
      validateMeasuredExposureNormalization({
        evidence: evidence.measuredExposureNormalization,
        output,
        captureById,
        exposureProfiles,
        plan: normalizedPlan,
        sessionId,
      });
      const lutStatus = output.artifacts.lut.status;
      const characterization = captureProvenance.colorCharacterization;
      const colorTruthValid = lutStatus === "measured"
        ? evidence.colorBasis === "characterized-colorimetric"
          && evidence.colorimetric === true
          && characterization.status === "validated"
        : lutStatus === "measured-relative"
          ? evidence.colorBasis === "camera-relative-rgb"
            && evidence.colorimetric === false
          : evidence.colorBasis === "identity-only"
            && evidence.colorimetric === false
            && evidence.fit.identityVerified === true;
      if (!colorTruthValid) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Output ${output.outputId} LUT color claim exceeds its camera characterization provenance`,
        );
      }
      const expectedReferences = {
        sensorDark: [...captureById.values()].filter((capture) => (
          capture.referenceKind === CAMERA_CALIBRATION_REFERENCE_KIND.SENSOR_DARK
        )).map((capture) => capture.id).sort(),
        projectorsOffAmbient: [...captureById.values()].filter((capture) => (
          capture.referenceKind === CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTORS_OFF_AMBIENT
          && capture.exposureProfileId === radiometryProfile.id
        )).map((capture) => capture.id).sort(),
        projectorBlack: [...captureById.values()].filter((capture) => (
          capture.referenceKind === CAMERA_CALIBRATION_REFERENCE_KIND.PROJECTOR_BLACK
          && capture.exposureProfileId === radiometryProfile.id
          && (capture.outputId === output.outputId || capture.outputId == null)
        )).map((capture) => capture.id).sort(),
      };
      for (const [kind, ids] of Object.entries(expectedReferences)) {
        if (ids.length < 1
          || canonicalJson([...evidence.referenceCaptureIds[kind]].sort()) !== canonicalJson(ids)
          || ids.some((id) => !output.captureIds.includes(id))) {
          throw new CameraCalibrationError(
            "INVALID_CALIBRATION_MANIFEST",
            `Output ${output.outputId} has incomplete or mismatched ${kind} provenance`,
          );
        }
      }
      const expectedAmbientDiagnosticIds = [
        ...expectedReferences.projectorsOffAmbient,
        ...expectedReferences.projectorBlack,
      ].sort();
      if (evidence.ambientDiagnostic.status !== "passed"
        || evidence.ambientDiagnostic.maximumNegativeBeyondUncertaintyFraction !== 0.05
        || canonicalJson([...evidence.ambientDiagnostic.captureIds].sort()) !== canonicalJson(expectedAmbientDiagnosticIds)) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_MANIFEST",
          `Output ${output.outputId} has incomplete or failed ambient diagnostic provenance`,
        );
      }
    }
  }
  const startedAt = isoTimestamp(value.startedAt, "manifest.startedAt");
  const completedAt = isoTimestamp(value.completedAt, "manifest.completedAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_MANIFEST", "Manifest completion precedes its start");
  }
  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId,
    project: {
      id: safeText(value.project?.id || normalizedPlan?.project?.id, "manifest.project.id", { maximum: 128 }),
      revision: exactInteger(
        value.project?.revision ?? normalizedPlan?.project?.revision,
        1,
        1,
        Number.MAX_SAFE_INTEGER,
        "manifest.project.revision",
      ),
    },
    provenance,
    applicable,
    camera,
    cameraSettings,
    exposureProfiles,
    ...(lensProfile == null ? {} : { lensProfile }),
    captureProvenance,
    sourcePolicy: expectedSourcePolicy,
    startedAt,
    completedAt,
    outputs,
  };
}

export function assertCalibrationManifestApplicable(manifest) {
  const normalized = normalizeCameraCalibrationManifest(manifest);
  if (!normalized.applicable || normalized.provenance !== "measured") {
    throw new CameraCalibrationError(
      "CALIBRATION_ARTIFACT_NOT_APPLICABLE",
      "Only a validated measured calibration manifest may be applied to projector outputs",
    );
  }
  return normalized;
}

function normalizeWarpPayload(input, artifact) {
  let value = input;
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value);
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new CameraCalibrationError("INVALID_WARP_ARTIFACT", `Warp artifact is not valid JSON: ${error.message}`);
    }
  }
  const warp = object(value, "warp artifact");
  const columns = integer(warp.columns, artifact.columns, 2, 128, "warp.columns");
  const rows = integer(warp.rows, artifact.rows, 2, 128, "warp.rows");
  if (columns !== artifact.columns || rows !== artifact.rows) {
    throw new CameraCalibrationError("INVALID_WARP_ARTIFACT", "Warp payload dimensions do not match its manifest");
  }
  const expected = (columns + 1) * (rows + 1);
  if (!Array.isArray(warp.points) || warp.points.length !== expected || expected !== artifact.pointCount) {
    throw new CameraCalibrationError("INVALID_WARP_ARTIFACT", "Warp payload point count does not match its manifest");
  }
  const points = warp.points.map((point, index) => {
    const source = object(point, `warp.points[${index}]`);
    return {
      u: finite(source.u, 0, 0, 1, `warp.points[${index}].u`),
      v: finite(source.v, 0, 0, 1, `warp.points[${index}].v`),
      x: finite(source.x, 0, -2, 3, `warp.points[${index}].x`),
      y: finite(source.y, 0, -2, 3, `warp.points[${index}].y`),
    };
  });
  return {
    enabled: true,
    columns,
    rows,
    interpolation: artifact.interpolation,
    points,
  };
}

function nativeTextureReference(artifact, path, field) {
  const pathname = safeText(path, `${field}.path`, { maximum: 2_048 });
  return {
    path: pathname,
    width: artifact.width,
    height: artifact.height,
    format: artifact.format,
  };
}

/**
 * Convert an applicable, measured camera manifest into the exact output fields
 * consumed by the final renderer. Artifact IO stays outside this shared module:
 * the caller must verify/read the warp and resolve every binary to a local path
 * on the Windows node that owns the projector.
 */
export async function buildCameraCalibrationProjectPatch(manifestInput, projectInput, {
  loadWarp,
  resolveArtifactPath,
} = {}) {
  const manifest = assertCalibrationManifestApplicable(manifestInput);
  const project = object(projectInput, "project");
  if (manifest.project.id !== project.id || manifest.project.revision !== Number(project.revision)) {
    throw new CameraCalibrationError(
      "CALIBRATION_PROJECT_REVISION_MISMATCH",
      "Calibration artifacts were measured for another project revision",
      {
        expected: { id: manifest.project.id, revision: manifest.project.revision },
        actual: { id: project.id, revision: project.revision },
      },
    );
  }
  if (typeof loadWarp !== "function" || typeof resolveArtifactPath !== "function") {
    throw new CameraCalibrationError(
      "CALIBRATION_ARTIFACT_RESOLVER_REQUIRED",
      "Measured calibration requires verified local artifact resolvers",
    );
  }
  const currentOutputs = Array.isArray(project.outputs) ? project.outputs : [];
  const outputs = [];
  for (const calibrated of manifest.outputs) {
    const existing = currentOutputs.find((output) => String(output.id) === calibrated.outputId);
    if (!existing) {
      throw new CameraCalibrationError("CALIBRATION_OUTPUT_NOT_FOUND", `Project output ${calibrated.outputId} no longer exists`);
    }
    const artifacts = calibrated.artifacts;
    const warp = normalizeWarpPayload(await loadWarp(artifacts.warp), artifacts.warp);
    const [blendPath, blackPath, maskPath, lutPath] = await Promise.all([
      resolveArtifactPath(artifacts.blendWeight, `${calibrated.outputId}.blendWeight`),
      resolveArtifactPath(artifacts.blackPedestal, `${calibrated.outputId}.blackPedestal`),
      resolveArtifactPath(artifacts.mask, `${calibrated.outputId}.mask`),
      resolveArtifactPath(artifacts.lut, `${calibrated.outputId}.lut`),
    ]);
    outputs.push(normalizeOutputConfig({
      ...existing,
      warp,
      blend: {
        ...(existing.blend || {}),
        enabled: true,
        map: nativeTextureReference(artifacts.blendWeight, blendPath, `${calibrated.outputId}.blendWeight`),
      },
      blackUniformity: {
        ...(existing.blackUniformity || {}),
        enabled: true,
        // The measured per-pixel additive map is authoritative. A scalar lift
        // remains zero so it cannot be applied a second time by the renderer.
        lift: 0,
        map: nativeTextureReference(artifacts.blackPedestal, blackPath, `${calibrated.outputId}.blackPedestal`),
      },
      mask: {
        ...(existing.mask || {}),
        enabled: true,
        map: nativeTextureReference(artifacts.mask, maskPath, `${calibrated.outputId}.mask`),
        path: null,
      },
      color: {
        ...(existing.color || {}),
        gamma: [...artifacts.gamma.rgb],
        lut: {
          path: safeText(lutPath, `${calibrated.outputId}.lut.path`, { maximum: 2_048 }),
          size: artifacts.lut.size,
          format: artifacts.lut.format,
        },
      },
      calibration: {
        sessionId: manifest.sessionId,
        measuredAt: manifest.completedAt,
        cameraId: manifest.camera.id,
        confidence: {
          gamma: artifacts.gamma.confidence,
          lut: artifacts.lut.confidence,
        },
      },
    }));
  }
  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId: manifest.sessionId,
    projectId: manifest.project.id,
    baseRevision: manifest.project.revision,
    outputs,
  };
}

/** Validate a node-proposed patch before the Server makes it authoritative. */
export function validateCameraCalibrationProjectPatch(patchInput, manifestInput, projectInput, { nodeId = null } = {}) {
  const manifest = assertCalibrationManifestApplicable(manifestInput);
  const patch = object(patchInput, "calibration project patch");
  const project = object(projectInput, "project");
  if (patch.sessionId !== manifest.sessionId || patch.projectId !== project.id
    || Number(patch.baseRevision) !== Number(project.revision)
    || manifest.project.id !== project.id || manifest.project.revision !== Number(project.revision)) {
    throw new CameraCalibrationError("CALIBRATION_PROJECT_REVISION_MISMATCH", "Calibration project patch is stale or mismatched");
  }
  const expectedIds = manifest.outputs.map((output) => output.outputId).sort();
  const proposed = Array.isArray(patch.outputs) ? patch.outputs.map(normalizeOutputConfig) : [];
  const actualIds = proposed.map((output) => output.id).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_PROJECT_PATCH", "Calibration patch output ids do not match the manifest");
  }
  for (const output of proposed) {
    const manifestOutput = manifest.outputs.find((candidate) => candidate.outputId === output.id);
    const current = project.outputs?.find((candidate) => String(candidate.id) === output.id);
    if (!current) throw new CameraCalibrationError("CALIBRATION_OUTPUT_NOT_FOUND", `Project output ${output.id} no longer exists`);
    if (nodeId && current.nodeId && String(current.nodeId) !== String(nodeId)) {
      throw new CameraCalibrationError("CALIBRATION_NODE_MISMATCH", `Output ${output.id} is not owned by node ${nodeId}`);
    }
    const requiredMaps = [
      [output.blend.map, manifestOutput.artifacts.blendWeight, "blend"],
      [output.blackUniformity.map, manifestOutput.artifacts.blackPedestal, "blackUniformity"],
      [output.mask.map, manifestOutput.artifacts.mask, "mask"],
    ];
    for (const [map, artifact, field] of requiredMaps) {
      if (!map || canonicalJson(Object.keys(map).sort()) !== canonicalJson(["format", "height", "path", "width"])
        || typeof map.path !== "string" || map.path.length < 1 || map.path.length > 2_048
        || map.width !== artifact.width || map.height !== artifact.height || map.format !== artifact.format) {
        throw new CameraCalibrationError("INVALID_CALIBRATION_PROJECT_PATCH", `${output.id}.${field} does not match its manifest artifact`);
      }
    }
    if (!output.warp.enabled || output.warp.columns !== manifestOutput.artifacts.warp.columns
      || output.warp.rows !== manifestOutput.artifacts.warp.rows
      || output.warp.points.length !== manifestOutput.artifacts.warp.pointCount) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_PROJECT_PATCH", `${output.id}.warp does not match its manifest artifact`);
    }
    const warpArtifactJson = JSON.stringify({
      columns: output.warp.columns,
      rows: output.warp.rows,
      interpolation: output.warp.interpolation,
      points: output.warp.points.map(({ u, v, x, y }) => ({ u, v, x, y })),
    });
    if (sha256Utf8(warpArtifactJson) !== manifestOutput.artifacts.warp.sha256) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_PROJECT_PATCH",
        `${output.id}.warp content does not match its manifest artifact digest`,
      );
    }
    if (JSON.stringify(output.color.gamma) !== JSON.stringify(manifestOutput.artifacts.gamma.rgb)) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_PROJECT_PATCH", `${output.id}.color.gamma does not match its manifest artifact`);
    }
    const lut = output.color.lut;
    if (!lut || canonicalJson(Object.keys(lut).sort()) !== canonicalJson(["format", "path", "size"])
      || typeof lut.path !== "string" || lut.path.length < 1 || lut.path.length > 2_048
      || lut.size !== manifestOutput.artifacts.lut.size || lut.format !== manifestOutput.artifacts.lut.format) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_PROJECT_PATCH",
        `${output.id}.color.lut does not match its manifest artifact`,
      );
    }
    const expectedCalibration = {
      sessionId: manifest.sessionId,
      measuredAt: manifest.completedAt,
      cameraId: manifest.camera.id,
      confidence: {
        gamma: manifestOutput.artifacts.gamma.confidence,
        lut: manifestOutput.artifacts.lut.confidence,
      },
    };
    if (canonicalJson(output.calibration) !== canonicalJson(expectedCalibration)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_PROJECT_PATCH",
        `${output.id}.calibration metadata does not bind the exact manifest`,
      );
    }

    // A calibration result may update only correction-owned fields. Physical
    // routing, mode, viewport, overlap, wall assignment, scalar tuning and
    // every unknown/future field remain authoritative Server project data.
    const expectedOutput = normalizeOutputConfig({
      ...current,
      warp: output.warp,
      blend: {
        ...(current.blend || {}),
        enabled: true,
        map: output.blend.map,
      },
      blackUniformity: {
        ...(current.blackUniformity || {}),
        enabled: true,
        lift: 0,
        map: output.blackUniformity.map,
      },
      mask: {
        ...(current.mask || {}),
        enabled: true,
        map: output.mask.map,
        path: null,
      },
      color: {
        ...(current.color || {}),
        gamma: [...manifestOutput.artifacts.gamma.rgb],
        lut: output.color.lut,
      },
      calibration: expectedCalibration,
    });
    if (canonicalJson(output) !== canonicalJson(expectedOutput)) {
      throw new CameraCalibrationError(
        "INVALID_CALIBRATION_PROJECT_PATCH",
        `${output.id} changes fields outside the calibration correction allowlist`,
      );
    }
  }
  return {
    schemaVersion: CAMERA_CALIBRATION_SCHEMA_VERSION,
    sessionId: manifest.sessionId,
    projectId: project.id,
    baseRevision: Number(project.revision),
    outputs: proposed,
  };
}
