const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function fail(message) {
  const error = new Error(message);
  error.name = "CanonCameraEvidenceError";
  error.code = "CANON_CAPTURE_EVIDENCE_INVALID";
  throw error;
}

function exactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function text(value, field, maximum = 256) {
  const output = String(value ?? "").trim();
  if (!output || output.length > maximum || [...output].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  })) fail(`${field} is invalid`);
  return output;
}

function number(value, field, minimum, maximum) {
  const output = Number(value);
  if (!Number.isFinite(output) || output < minimum || output > maximum) {
    fail(`${field} must be between ${minimum} and ${maximum}`);
  }
  return output;
}

function integer(value, field, minimum, maximum) {
  const output = Number(value);
  if (!Number.isSafeInteger(output) || output < minimum || output > maximum) {
    fail(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return output;
}

function sha256(value, field) {
  const output = String(value ?? "");
  if (!SHA256_PATTERN.test(output)) fail(`${field} must be one lowercase SHA-256 digest`);
  return output;
}

function frame(input, field) {
  const value = exactObject(input, ["width", "height", "pixelFormat"], field);
  const output = {
    width: integer(value.width, `${field}.width`, 2, 65_536),
    height: integer(value.height, `${field}.height`, 2, 65_536),
    pixelFormat: text(value.pixelFormat, `${field}.pixelFormat`, 64),
  };
  if (output.pixelFormat !== "linear-rgb-f32") fail(`${field}.pixelFormat must be linear-rgb-f32`);
  return output;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizeCameraSpatialTransform(input, field = "spatialTransform") {
  if (input === "none-raw-sensor-raster-v1") return input;
  const value = exactObject(input, [
    "kind", "sourceFrame", "retainedFrame", "binX", "binY", "crop",
  ], field);
  const sourceFrame = frame(value.sourceFrame, `${field}.sourceFrame`);
  const retainedFrame = frame(value.retainedFrame, `${field}.retainedFrame`);
  const binX = integer(value.binX, `${field}.binX`, 1, 32_768);
  const binY = integer(value.binY, `${field}.binY`, 1, 32_768);
  const cropValue = exactObject(value.crop, ["x", "y", "width", "height"], `${field}.crop`);
  const crop = {
    x: integer(cropValue.x, `${field}.crop.x`, 0, 65_535),
    y: integer(cropValue.y, `${field}.crop.y`, 0, 65_535),
    width: integer(cropValue.width, `${field}.crop.width`, 2, 65_536),
    height: integer(cropValue.height, `${field}.crop.height`, 2, 65_536),
  };
  if (value.kind !== "full-frame-area-bin-v1"
    || binX !== binY
    || sourceFrame.width % binX !== 0
    || sourceFrame.height % binY !== 0
    || retainedFrame.width !== sourceFrame.width / binX
    || retainedFrame.height !== sourceFrame.height / binY
    || crop.x !== 0 || crop.y !== 0
    || crop.width !== sourceFrame.width || crop.height !== sourceFrame.height) {
    fail(`${field} must prove an uncropped, square-integer, exactly divisible full-frame area bin`);
  }
  return {
    kind: "full-frame-area-bin-v1",
    sourceFrame,
    retainedFrame,
    binX,
    binY,
    crop,
  };
}

function sdkFiles(input, field) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 256) {
    fail(`${field} must contain 1-256 runtime files`);
  }
  const files = input.map((item, index) => {
    const value = exactObject(item, ["name", "sha256"], `${field}[${index}]`);
    const name = text(value.name, `${field}[${index}].name`, 128);
    if (name.includes("/") || name.includes("\\") || !name.toLowerCase().endsWith(".dll")) {
      fail(`${field}[${index}].name must be one DLL basename`);
    }
    return { name, sha256: sha256(value.sha256, `${field}[${index}].sha256`) };
  });
  if (new Set(files.map((file) => file.name.toLowerCase())).size !== files.length) {
    fail(`${field} names must be case-insensitively unique`);
  }
  return files;
}

export function normalizeCanonCaptureEvidence(input, {
  runtimeBinding = null,
  lens = null,
  expectedFocalLengthMm = null,
  spatialTransform = null,
} = {}) {
  const value = exactObject(input, [
    "schema", "sdk", "lensSerial", "focusDistance", "stabilization", "sourceBitDepth",
    "focalLength", "spatialTransform",
  ], "evidence");
  if (value.schema !== "pixel-brightness.canon-capture-evidence.v1") {
    fail("evidence.schema is unsupported");
  }
  const sdkValue = exactObject(value.sdk, [
    "name", "version", "architecture", "runtimeManifestSha256", "files",
  ], "evidence.sdk");
  const sdk = {
    name: text(sdkValue.name, "evidence.sdk.name", 128),
    version: text(sdkValue.version, "evidence.sdk.version", 64),
    architecture: text(sdkValue.architecture, "evidence.sdk.architecture", 16),
    runtimeManifestSha256: sha256(
      sdkValue.runtimeManifestSha256,
      "evidence.sdk.runtimeManifestSha256",
    ),
    files: sdkFiles(sdkValue.files, "evidence.sdk.files"),
  };
  if (sdk.name !== "Canon EDSDK" || sdk.architecture !== "x64") {
    fail("evidence.sdk must identify the x64 Canon EDSDK runtime");
  }
  const lensSerialValue = exactObject(value.lensSerial, ["value", "source"], "evidence.lensSerial");
  const lensSerial = {
    value: text(lensSerialValue.value, "evidence.lensSerial.value", 256),
    source: text(lensSerialValue.source, "evidence.lensSerial.source", 32),
  };
  if (!new Set(["edsdk-property", "cr3-metadata"]).has(lensSerial.source)) {
    fail("evidence.lensSerial.source is unsupported");
  }
  const focusValue = exactObject(value.focusDistance, ["valueM", "source"], "evidence.focusDistance");
  const focusDistance = {
    valueM: number(focusValue.valueM, "evidence.focusDistance.valueM", 0.01, 1_000_000),
    source: text(focusValue.source, "evidence.focusDistance.source", 32),
  };
  if (!new Set(["edsdk-property", "cr3-metadata"]).has(focusDistance.source)) {
    fail("evidence.focusDistance.source is unsupported");
  }
  const stabilizationValue = exactObject(
    value.stabilization,
    ["value", "source", "property"],
    "evidence.stabilization",
  );
  const stabilization = {
    value: text(stabilizationValue.value, "evidence.stabilization.value", 16),
    source: text(stabilizationValue.source, "evidence.stabilization.source", 64),
    property: text(stabilizationValue.property, "evidence.stabilization.property", 64),
  };
  if (stabilization.value !== "off"
    || stabilization.source !== "edsdk-property-readback"
    || stabilization.property !== "kEdsPropID_LensIsSetting") {
    fail("evidence.stabilization must prove LensIsSetting=off from EDSDK readback");
  }
  const bitDepthValue = exactObject(value.sourceBitDepth, ["value", "source"], "evidence.sourceBitDepth");
  const sourceBitDepth = {
    value: integer(bitDepthValue.value, "evidence.sourceBitDepth.value", 14, 14),
    source: text(bitDepthValue.source, "evidence.sourceBitDepth.source", 32),
  };
  if (sourceBitDepth.source !== "cr3-decoder") fail("evidence.sourceBitDepth.source must be cr3-decoder");
  const focalValue = exactObject(
    value.focalLength,
    ["valueMm", "cameraValueMm", "cr3ValueMm", "source"],
    "evidence.focalLength",
  );
  const focalLength = {
    valueMm: number(focalValue.valueMm, "evidence.focalLength.valueMm", 1, 2_000),
    cameraValueMm: number(focalValue.cameraValueMm, "evidence.focalLength.cameraValueMm", 1, 2_000),
    cr3ValueMm: number(focalValue.cr3ValueMm, "evidence.focalLength.cr3ValueMm", 1, 2_000),
    source: text(focalValue.source, "evidence.focalLength.source", 32),
  };
  if (focalLength.source !== "edsdk-and-cr3"
    || Math.abs(focalLength.valueMm - focalLength.cameraValueMm) > 0.05
    || Math.abs(focalLength.valueMm - focalLength.cr3ValueMm) > 0.05) {
    fail("evidence.focalLength must agree between EDSDK and CR3 within 0.05 mm");
  }
  const normalizedSpatialTransform = normalizeCameraSpatialTransform(
    value.spatialTransform,
    "evidence.spatialTransform",
  );

  if (runtimeBinding && (sdk.version !== runtimeBinding.manifest.sdkVersion
    || sdk.runtimeManifestSha256 !== runtimeBinding.sha256
    || canonicalJson(sdk.files) !== canonicalJson(runtimeBinding.manifest.files))) {
    fail("evidence.sdk does not match the independently verified runtime manifest");
  }
  if (lens && (lensSerial.value !== lens.serial
    || focusDistance.valueM !== Number(lens.focusDistanceM)
    || stabilization.value !== lens.stabilization
    || Math.abs(focalLength.valueMm - Number(lens.focalLengthMm)) > 0.05)) {
    fail("evidence body does not exactly bind the captured lens readbacks");
  }
  if (expectedFocalLengthMm != null
    && Math.abs(focalLength.valueMm - Number(expectedFocalLengthMm)) > 0.05) {
    fail("evidence focal length does not match the configured calibration zoom lock");
  }
  if (spatialTransform != null
    && canonicalJson(normalizedSpatialTransform) !== canonicalJson(spatialTransform)) {
    fail("evidence spatial transform does not match the requested deterministic area bin");
  }
  return {
    schema: "pixel-brightness.canon-capture-evidence.v1",
    sdk,
    lensSerial,
    focusDistance,
    stabilization,
    sourceBitDepth,
    focalLength,
    spatialTransform: normalizedSpatialTransform,
  };
}
