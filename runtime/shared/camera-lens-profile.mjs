const PROFILE_SCHEMA = "pixel-brightness.camera-lens-profile.v1";
const DISTORTION_MODEL = "brown-conrady-v1";
const CALIBRATION_METHOD = "opencv-charuco-brown-conrady-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROFILE_MAX_AGE_DAYS = 730;
const PROFILE_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1_000;
const MAX_RMS_RESIDUAL_PX = 0.5;
const MAX_RESIDUAL_PX = 1.5;
const FRAME_FOLD_SAMPLES = 17;
const GEOMETRY_EPSILON = 1e-10;

const SHA256_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class CameraLensProfileError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CameraLensProfileError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CameraLensProfileError(code, message, details);
}

function exactObject(value, field, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(
      "INVALID_LENS_PROFILE_SCHEMA",
      `${field} must contain exactly: ${expected.join(", ")}`,
      { actual, expected },
    );
  }
  return value;
}

function canonicalText(value, field, maximum = 256) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be a canonical 1-${maximum} character string`);
  }
  return value;
}

function finiteNumber(value, field, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)
    || value < minimum || value > maximum) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be an integer between ${minimum} and ${maximum}`);
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

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(text) {
  const source = new TextEncoder().encode(text);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const lengthHigh = Math.floor(bitLength / 0x1_0000_0000);
  const lengthLow = bitLength >>> 0;
  view.setUint32(paddedLength - 8, lengthHigh, false);
  view.setUint32(paddedLength - 4, lengthLow, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const first = words[index - 15];
      const second = words[index - 2];
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function normalizeInstant(value, field, now) {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be a canonical UTC ISO-8601 instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `${field} must be a real canonical UTC ISO-8601 instant`);
  }
  if (milliseconds > now + PROFILE_MAX_FUTURE_SKEW_MS) {
    fail("LENS_PROFILE_CALIBRATION_FUTURE", `${field} is in the future`);
  }
  if (now - milliseconds > PROFILE_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000) {
    fail("LENS_PROFILE_CALIBRATION_EXPIRED", `${field} is older than ${PROFILE_MAX_AGE_DAYS} days`);
  }
  return value;
}

function normalizeNow(input) {
  const now = input instanceof Date ? input.getTime() : input === undefined ? Date.now() : Number(input);
  if (!Number.isFinite(now)) fail("INVALID_LENS_PROFILE_SCHEMA", "now must be a finite epoch millisecond value or Date");
  return now;
}

function normalizeProfilePayload(input, now) {
  const value = exactObject(input, "profile", [
    "schema", "camera", "lens", "frame", "capture", "intrinsics", "distortion", "calibration",
  ]);
  if (value.schema !== PROFILE_SCHEMA) {
    fail("INVALID_LENS_PROFILE_SCHEMA", `profile.schema must be ${PROFILE_SCHEMA}`);
  }

  const camera = exactObject(value.camera, "profile.camera", ["manufacturer", "model", "serialNumber"]);
  const lens = exactObject(value.lens, "profile.lens", ["manufacturer", "model", "serialNumber"]);
  const frame = exactObject(value.frame, "profile.frame", ["width", "height"]);
  const capture = exactObject(value.capture, "profile.capture", [
    "focalLengthMm", "focusDistanceM", "apertureFNumber",
  ]);
  const intrinsics = exactObject(value.intrinsics, "profile.intrinsics", ["fx", "fy", "cx", "cy"]);
  const distortion = exactObject(value.distortion, "profile.distortion", ["model", "k1", "k2", "k3", "p1", "p2"]);
  const calibration = exactObject(value.calibration, "profile.calibration", [
    "method", "calibratedAt", "rmsResidualPx", "maxResidualPx", "imageCount",
  ]);

  const normalizedFrame = {
    width: integer(frame.width, "profile.frame.width", 32, 16_384),
    height: integer(frame.height, "profile.frame.height", 32, 16_384),
  };
  const normalizedIntrinsics = {
    fx: finiteNumber(intrinsics.fx, "profile.intrinsics.fx", normalizedFrame.width * 0.05, normalizedFrame.width * 20),
    fy: finiteNumber(intrinsics.fy, "profile.intrinsics.fy", normalizedFrame.height * 0.05, normalizedFrame.height * 20),
    cx: finiteNumber(intrinsics.cx, "profile.intrinsics.cx", 0, normalizedFrame.width),
    cy: finiteNumber(intrinsics.cy, "profile.intrinsics.cy", 0, normalizedFrame.height),
  };
  if (distortion.model !== DISTORTION_MODEL) {
    fail("INVALID_LENS_PROFILE_METHOD", `profile.distortion.model must be ${DISTORTION_MODEL}`);
  }
  if (calibration.method !== CALIBRATION_METHOD) {
    fail("INVALID_LENS_PROFILE_METHOD", `profile.calibration.method must be ${CALIBRATION_METHOD}`);
  }
  const rmsResidualPx = finiteNumber(calibration.rmsResidualPx, "profile.calibration.rmsResidualPx", 0, 100);
  const maxResidualPx = finiteNumber(calibration.maxResidualPx, "profile.calibration.maxResidualPx", 0, 100);
  if (rmsResidualPx > MAX_RMS_RESIDUAL_PX || maxResidualPx > MAX_RESIDUAL_PX || maxResidualPx < rmsResidualPx) {
    fail(
      "LENS_PROFILE_RESIDUAL_GATE_FAILED",
      `Lens calibration residuals must be RMS <= ${MAX_RMS_RESIDUAL_PX}px, max <= ${MAX_RESIDUAL_PX}px and max >= RMS`,
      { rmsResidualPx, maxResidualPx },
    );
  }

  return {
    schema: PROFILE_SCHEMA,
    camera: {
      manufacturer: canonicalText(camera.manufacturer, "profile.camera.manufacturer", 128),
      model: canonicalText(camera.model, "profile.camera.model", 128),
      serialNumber: canonicalText(camera.serialNumber, "profile.camera.serialNumber", 128),
    },
    lens: {
      manufacturer: canonicalText(lens.manufacturer, "profile.lens.manufacturer", 128),
      model: canonicalText(lens.model, "profile.lens.model", 128),
      serialNumber: canonicalText(lens.serialNumber, "profile.lens.serialNumber", 128),
    },
    frame: normalizedFrame,
    capture: {
      focalLengthMm: finiteNumber(capture.focalLengthMm, "profile.capture.focalLengthMm", 1, 2_000),
      focusDistanceM: finiteNumber(capture.focusDistanceM, "profile.capture.focusDistanceM", 0.05, 100_000),
      apertureFNumber: finiteNumber(capture.apertureFNumber, "profile.capture.apertureFNumber", 0.5, 64),
    },
    intrinsics: normalizedIntrinsics,
    distortion: {
      model: DISTORTION_MODEL,
      k1: finiteNumber(distortion.k1, "profile.distortion.k1", -10, 10),
      k2: finiteNumber(distortion.k2, "profile.distortion.k2", -10, 10),
      k3: finiteNumber(distortion.k3, "profile.distortion.k3", -10, 10),
      p1: finiteNumber(distortion.p1, "profile.distortion.p1", -2, 2),
      p2: finiteNumber(distortion.p2, "profile.distortion.p2", -2, 2),
    },
    calibration: {
      method: CALIBRATION_METHOD,
      calibratedAt: normalizeInstant(calibration.calibratedAt, "profile.calibration.calibratedAt", now),
      rmsResidualPx,
      maxResidualPx,
      imageCount: integer(calibration.imageCount, "profile.calibration.imageCount", 12, 100_000),
    },
  };
}

function cameraPointFromImagePoint(profile, point) {
  return {
    x: (point.x * profile.frame.width - profile.intrinsics.cx) / profile.intrinsics.fx,
    y: (point.y * profile.frame.height - profile.intrinsics.cy) / profile.intrinsics.fy,
  };
}

function imagePointFromCameraPoint(profile, point) {
  return {
    x: (point.x * profile.intrinsics.fx + profile.intrinsics.cx) / profile.frame.width,
    y: (point.y * profile.intrinsics.fy + profile.intrinsics.cy) / profile.frame.height,
  };
}

function distortCameraPoint(distortion, point) {
  const { x, y } = point;
  const radius2 = x * x + y * y;
  const radius4 = radius2 * radius2;
  const radius6 = radius4 * radius2;
  const radial = 1 + distortion.k1 * radius2 + distortion.k2 * radius4 + distortion.k3 * radius6;
  return {
    x: x * radial + 2 * distortion.p1 * x * y + distortion.p2 * (radius2 + 2 * x * x),
    y: y * radial + distortion.p1 * (radius2 + 2 * y * y) + 2 * distortion.p2 * x * y,
  };
}

function distortionJacobian(distortion, point) {
  const { x, y } = point;
  const radius2 = x * x + y * y;
  const radius4 = radius2 * radius2;
  const slope = distortion.k1 + 2 * distortion.k2 * radius2 + 3 * distortion.k3 * radius4;
  const radial = 1 + distortion.k1 * radius2 + distortion.k2 * radius4 + distortion.k3 * radius4 * radius2;
  const radialX = 2 * x * slope;
  const radialY = 2 * y * slope;
  return {
    xx: radial + x * radialX + 2 * distortion.p1 * y + 6 * distortion.p2 * x,
    xy: x * radialY + 2 * distortion.p1 * x + 2 * distortion.p2 * y,
    yx: y * radialX + 2 * distortion.p1 * x + 2 * distortion.p2 * y,
    yy: radial + y * radialY + 6 * distortion.p1 * y + 2 * distortion.p2 * x,
  };
}

function validateProfileDoesNotFold(profile) {
  let minimumDeterminant = Number.POSITIVE_INFINITY;
  for (let row = 0; row < FRAME_FOLD_SAMPLES; row += 1) {
    for (let column = 0; column < FRAME_FOLD_SAMPLES; column += 1) {
      const imagePoint = {
        x: column / (FRAME_FOLD_SAMPLES - 1),
        y: row / (FRAME_FOLD_SAMPLES - 1),
      };
      const cameraPoint = cameraPointFromImagePoint(profile, imagePoint);
      const distorted = distortCameraPoint(profile.distortion, cameraPoint);
      const jacobian = distortionJacobian(profile.distortion, cameraPoint);
      const determinant = jacobian.xx * jacobian.yy - jacobian.xy * jacobian.yx;
      if (![distorted.x, distorted.y, determinant].every(Number.isFinite)) {
        fail("LENS_PROFILE_FOLDED", "Lens profile produces non-finite geometry inside its calibrated frame");
      }
      minimumDeterminant = Math.min(minimumDeterminant, determinant);
      if (determinant <= 1e-6) {
        fail(
          "LENS_PROFILE_FOLDED",
          "Lens profile folds or becomes singular inside its calibrated frame",
          { imagePoint, determinant },
        );
      }
    }
  }
  return minimumDeterminant;
}

/**
 * Return the SHA-256 identity for the canonical profile payload (everything
 * except sha256). This implementation has no Node or browser runtime imports.
 */
export function cameraLensProfilePayloadSha256(input, { now } = {}) {
  const payload = normalizeProfilePayload(input, normalizeNow(now));
  validateProfileDoesNotFold(payload);
  return sha256(canonicalJson(payload));
}

/** Build a canonical, identity-bearing profile from a strict payload. */
export function createCameraLensProfile(input, { now } = {}) {
  const payload = normalizeProfilePayload(input, normalizeNow(now));
  validateProfileDoesNotFold(payload);
  return { ...payload, sha256: sha256(canonicalJson(payload)) };
}

/** Validate schema, quality gates, distortion topology and SHA-256 identity. */
export function normalizeCameraLensProfile(input, { now } = {}) {
  const value = exactObject(input, "profile", [
    "schema", "sha256", "camera", "lens", "frame", "capture", "intrinsics", "distortion", "calibration",
  ]);
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail("INVALID_LENS_PROFILE_SCHEMA", "profile.sha256 must be a lowercase SHA-256 digest");
  }
  const { sha256: suppliedSha256, ...sourcePayload } = value;
  const payload = normalizeProfilePayload(sourcePayload, normalizeNow(now));
  validateProfileDoesNotFold(payload);
  const expectedSha256 = sha256(canonicalJson(payload));
  if (suppliedSha256 !== expectedSha256) {
    fail(
      "LENS_PROFILE_IDENTITY_MISMATCH",
      "Lens profile content does not match profile.sha256",
      { suppliedSha256, expectedSha256 },
    );
  }
  return { ...payload, sha256: expectedSha256 };
}

function imagePoint(input, field) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_IMAGE_POINT", `${field} must be an {x,y} object`);
  }
  if (typeof input.x !== "number" || typeof input.y !== "number"
    || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    fail("INVALID_IMAGE_POINT", `${field} must contain finite x and y numbers`);
  }
  if (input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) {
    fail("LENS_POINT_OUT_OF_FRAME", `${field} must be inside normalized raw frame [0,1]`);
  }
  return { x: input.x, y: input.y };
}

function checkedImageResult(point, field) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    fail("INVALID_IMAGE_POINT", `${field} produced a non-finite point`);
  }
  const epsilon = 1e-9;
  if (point.x < -epsilon || point.x > 1 + epsilon || point.y < -epsilon || point.y > 1 + epsilon) {
    fail("LENS_POINT_OUT_OF_FRAME", `${field} leaves normalized raw frame [0,1]`, { point });
  }
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  };
}

function distortImagePoint(profile, point, field) {
  const cameraPoint = cameraPointFromImagePoint(profile, point);
  const distorted = distortCameraPoint(profile.distortion, cameraPoint);
  return checkedImageResult(imagePointFromCameraPoint(profile, distorted), field);
}

/** Distort an undistorted [0,1] image point into raw-sensor [0,1] space. */
export function distortNormalizedImagePoint(profileInput, pointInput, { now } = {}) {
  const profile = normalizeCameraLensProfile(profileInput, { now });
  const point = imagePoint(pointInput, "point");
  return distortImagePoint(profile, point, "distortNormalizedImagePoint");
}

function undistortImagePoint(profile, point, { maxIterations, tolerance }) {
  const target = cameraPointFromImagePoint(profile, point);
  let estimate = { ...target };
  let finalResidual = Number.POSITIVE_INFINITY;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const projected = distortCameraPoint(profile.distortion, estimate);
    const residualX = projected.x - target.x;
    const residualY = projected.y - target.y;
    finalResidual = Math.hypot(residualX, residualY);
    if (finalResidual <= tolerance) {
      return checkedImageResult(
        imagePointFromCameraPoint(profile, estimate),
        "undistortNormalizedImagePoint",
      );
    }
    const jacobian = distortionJacobian(profile.distortion, estimate);
    const determinant = jacobian.xx * jacobian.yy - jacobian.xy * jacobian.yx;
    if (!Number.isFinite(determinant) || determinant <= 1e-12) {
      fail(
        "LENS_UNDISTORT_NONCONVERGENT",
        "Lens undistortion reached a singular or folded inverse",
        { iteration, determinant, finalResidual },
      );
    }
    const deltaX = (jacobian.yy * residualX - jacobian.xy * residualY) / determinant;
    const deltaY = (-jacobian.yx * residualX + jacobian.xx * residualY) / determinant;
    estimate = { x: estimate.x - deltaX, y: estimate.y - deltaY };
    if (![estimate.x, estimate.y, deltaX, deltaY].every(Number.isFinite)
      || Math.hypot(deltaX, deltaY) > 100) {
      fail(
        "LENS_UNDISTORT_NONCONVERGENT",
        "Lens undistortion diverged",
        { iteration, deltaX, deltaY, finalResidual },
      );
    }
  }
  const projected = distortCameraPoint(profile.distortion, estimate);
  finalResidual = Math.hypot(projected.x - target.x, projected.y - target.y);
  if (finalResidual <= tolerance) {
    return checkedImageResult(imagePointFromCameraPoint(profile, estimate), "undistortNormalizedImagePoint");
  }
  fail(
    "LENS_UNDISTORT_NONCONVERGENT",
    `Lens undistortion did not converge within ${maxIterations} iterations`,
    { maxIterations, finalResidual, tolerance },
  );
}

/** Iteratively invert a raw-sensor [0,1] point into undistorted [0,1] space. */
export function undistortNormalizedImagePoint(profileInput, pointInput, options = {}) {
  const profile = normalizeCameraLensProfile(profileInput, { now: options.now });
  const point = imagePoint(pointInput, "point");
  const maxIterations = options.maxIterations === undefined
    ? 24
    : integer(options.maxIterations, "options.maxIterations", 1, 100);
  const tolerance = options.tolerance === undefined
    ? 1e-12
    : finiteNumber(options.tolerance, "options.tolerance", 1e-15, 1e-4);
  return undistortImagePoint(profile, point, { maxIterations, tolerance });
}

function cross(first, second, third) {
  return (second.x - first.x) * (third.y - second.y)
    - (second.y - first.y) * (third.x - second.x);
}

function polygonArea(points) {
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubledArea += current.x * next.y - current.y * next.x;
  }
  return doubledArea / 2;
}

function wallBoundary(input, field) {
  if (!Array.isArray(input) || input.length !== 4) {
    fail("INVALID_WALL_BOUNDARY", `${field} must contain TL, TR, BR and BL in that order`);
  }
  const points = input.map((point, index) => imagePoint(point, `${field}[${index}]`));
  const area = polygonArea(points);
  const turns = points.map((point, index) => cross(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  if (area <= 1e-6 || turns.some((turn) => turn <= GEOMETRY_EPSILON)) {
    fail(
      "INVALID_WALL_BOUNDARY",
      `${field} must be a non-folded TL/TR/BR/BL quadrilateral with useful area`,
      { area, turns },
    );
  }
  return points;
}

function unitSquareHomography(corners) {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > GEOMETRY_EPSILON || Math.abs(dy3) > GEOMETRY_EPSILON) {
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (!Number.isFinite(denominator) || Math.abs(denominator) <= GEOMETRY_EPSILON) {
      fail("DEGENERATE_WALL_HOMOGRAPHY", "Wall boundary does not define a stable planar homography");
    }
    g = (dx3 * dy2 - dx2 * dy3) / denominator;
    h = (dx1 * dy3 - dx3 * dy1) / denominator;
  }
  const homography = {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
  if (!Object.values(homography).every(Number.isFinite)) {
    fail("DEGENERATE_WALL_HOMOGRAPHY", "Wall homography contains non-finite coefficients");
  }
  return homography;
}

function projectHomography(homography, u, v) {
  const denominator = homography.g * u + homography.h * v + 1;
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= GEOMETRY_EPSILON) {
    fail("DEGENERATE_WALL_HOMOGRAPHY", "Wall homography crosses infinity inside the requested grid", { u, v });
  }
  const point = {
    x: (homography.a * u + homography.b * v + homography.c) / denominator,
    y: (homography.d * u + homography.e * v + homography.f) / denominator,
  };
  return checkedImageResult(point, "planar wall homography");
}

function assertGridDoesNotFold(vertices, columns, rows) {
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = vertices[row * columns + column];
      const topRight = vertices[row * columns + column + 1];
      const bottomLeft = vertices[(row + 1) * columns + column];
      const bottomRight = vertices[(row + 1) * columns + column + 1];
      const firstArea = cross(topLeft, topRight, bottomRight);
      const secondArea = cross(topLeft, bottomRight, bottomLeft);
      if (!Number.isFinite(firstArea) || !Number.isFinite(secondArea)
        || firstArea <= GEOMETRY_EPSILON || secondArea <= GEOMETRY_EPSILON) {
        fail(
          "FOLDED_WALL_GRID",
          "Distortion-corrected planar wall grid contains a folded or singular cell",
          { row, column, firstArea, secondArea },
        );
      }
    }
  }
}

function planarWallProjection({ profile: profileInput, boundary: boundaryInput, now, maxIterations, tolerance }) {
  const profile = normalizeCameraLensProfile(profileInput, { now });
  const distortedBoundary = wallBoundary(boundaryInput, "boundary");
  const inverseOptions = {
    maxIterations: integer(maxIterations, "maxIterations", 1, 100),
    tolerance: finiteNumber(tolerance, "tolerance", 1e-15, 1e-4),
  };
  const undistortedBoundary = distortedBoundary.map((point) => (
    undistortImagePoint(profile, point, inverseOptions)
  ));
  wallBoundary(undistortedBoundary, "undistortedBoundary");
  const homography = unitSquareHomography(undistortedBoundary);
  return {
    profile,
    distortedBoundary,
    undistortedBoundary,
    project(u, v) {
      const undistorted = projectHomography(homography, u, v);
      return distortImagePoint(profile, undistorted, "distortion-aware planar point");
    },
  };
}

/**
 * Map arbitrary normalized wall-plane coordinates through one global planar
 * homography into the raw distorted camera raster. This must be used before
 * splitting one surveyed wall into per-output source viewports.
 */
export function mapPlanarWallPointsToRaw({
  profile,
  boundary,
  points,
  now,
  maxIterations = 24,
  tolerance = 1e-12,
}) {
  if (!Array.isArray(points) || points.length < 1 || points.length > 65_536) {
    fail("INVALID_WALL_COORDINATES", "points must contain 1-65536 normalized wall-plane coordinates");
  }
  const projection = planarWallProjection({ profile, boundary, now, maxIterations, tolerance });
  const mapped = points.map((point, index) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) {
      fail("INVALID_WALL_COORDINATES", `points[${index}] must be an {u,v} object`);
    }
    const u = finiteNumber(point.u, `points[${index}].u`, 0, 1);
    const v = finiteNumber(point.v, `points[${index}].v`, 0, 1);
    const raw = projection.project(u, v);
    return { u, v, x: raw.x, y: raw.y };
  });
  return {
    profileSha256: projection.profile.sha256,
    frame: { ...projection.profile.frame },
    coordinateSpace: "raw-sensor-normalized-v1",
    distortedBoundary: projection.distortedBoundary,
    undistortedBoundary: projection.undistortedBoundary,
    points: mapped,
  };
}

/**
 * Build Gray-map targets in the raw sensor coordinate space. The operator's
 * distorted wall corners are first undistorted, the planar homography is
 * sampled there, then every target is redistorted into the captured raster.
 */
export function createDistortionAwarePlanarGrid({
  profile: profileInput,
  boundary: boundaryInput,
  columns = 17,
  rows = 17,
  now,
  maxIterations = 24,
  tolerance = 1e-12,
}) {
  const normalizedColumns = integer(columns, "columns", 2, 257);
  const normalizedRows = integer(rows, "rows", 2, 257);
  const wallPoints = [];
  for (let row = 0; row < normalizedRows; row += 1) {
    const v = row / (normalizedRows - 1);
    for (let column = 0; column < normalizedColumns; column += 1) {
      const u = column / (normalizedColumns - 1);
      wallPoints.push({ u, v });
    }
  }
  const mapped = mapPlanarWallPointsToRaw({
    profile: profileInput,
    boundary: boundaryInput,
    points: wallPoints,
    now,
    maxIterations,
    tolerance,
  });
  const vertices = mapped.points;
  assertGridDoesNotFold(vertices, normalizedColumns, normalizedRows);
  return {
    profileSha256: mapped.profileSha256,
    frame: mapped.frame,
    coordinateSpace: mapped.coordinateSpace,
    distortedBoundary: mapped.distortedBoundary,
    undistortedBoundary: mapped.undistortedBoundary,
    grid: {
      columns: normalizedColumns,
      rows: normalizedRows,
      vertices,
    },
  };
}

export const CAMERA_LENS_PROFILE_LIMITS = Object.freeze({
  schema: PROFILE_SCHEMA,
  distortionModel: DISTORTION_MODEL,
  calibrationMethod: CALIBRATION_METHOD,
  maxAgeDays: PROFILE_MAX_AGE_DAYS,
  maxRmsResidualPx: MAX_RMS_RESIDUAL_PX,
  maxResidualPx: MAX_RESIDUAL_PX,
});
