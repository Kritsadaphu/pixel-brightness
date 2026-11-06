import { normalizePlanarSurfaceSurveys } from "./camera-survey.mjs";

export const CAMERA_CALIBRATION_BUNDLE_SCHEMA_VERSION = 1;
export const CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION = "independent-planar";

export const CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE = Object.freeze({
  PENDING: "pending-calibration",
  CALIBRATED: "per-view-calibrated",
  VERIFIED: "per-view-verified",
  FAILED: "failed",
});

export const CAMERA_CALIBRATION_BUNDLE_STATE = Object.freeze({
  COLLECTING: "collecting-views",
  CALIBRATED: "per-view-calibrated",
  VERIFIED: "per-view-verified",
  SEAMS_UNVERIFIED: "cross-view-seams-unverified",
  ROOM_VERIFIED: "room-verified",
  FAILED: "failed",
});

export const CAMERA_CALIBRATION_BUNDLE_EVENT = Object.freeze({
  MEMBER_CALIBRATED: "member-calibrated",
  FINAL_RENDERER_ACKNOWLEDGED: "final-renderer-acknowledged",
  MEMBER_VERIFIED: "member-verified",
  ADJACENCY_OBSERVED: "adjacency-observed",
  MEMBER_FAILED: "member-failed",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VIEW_CAPTURE_ID_PATTERN = /^viewcap_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SURVEY_METHOD = "operator-four-corner-planar-v1";
const VIEW_CAPTURE_AUTHORITY = "server";
const PREVIEW_AUTHENTICATION = "server-verified-preview-artifact-v1";
const MAX_MEMBERS = 64;
const MAX_OUTPUTS = 256;

const CREATE_KEYS = [
  "bundleId", "baseProject", "expectedOutputIds", "members", "sameWallOverlaps",
  "physicalAdjacencies", "createdAt",
];
const BUNDLE_KEYS = [
  "schemaVersion", "bundleId", "baseProject", "poseRegistration", "expectedOutputIds",
  "members", "sameWallOverlaps", "physicalAdjacencies", "finalEvidence",
  "aggregateState", "createdAt", "updatedAt",
];
const CREATE_MEMBER_KEYS = [
  "memberId", "cameraViewId", "viewCaptureId", "viewCaptureAuthority", "poseRegistration",
  "lensProfileSha256", "frame", "outputIds", "preview", "survey",
];
const MEMBER_KEYS = [
  ...CREATE_MEMBER_KEYS, "state", "calibrationEvidence", "verificationEvidence", "failure",
];
const SURVEY_PAYLOAD_KEYS = [
  "id", "wallId", "cameraViewId", "frame", "lensProfileSha256", "boundary", "method",
];
const SURVEY_KEYS = [...SURVEY_PAYLOAD_KEYS, "sha256"];
const PREVIEW_KEYS = ["id", "artifactSha256", "capturedAt", "authenticatedAt", "authentication"];
const OVERLAP_KEYS = ["id", "wallId", "outputIds"];
const CREATE_ADJACENCY_KEYS = ["id", "wallIds", "outputIds"];
const ADJACENCY_KEYS = [...CREATE_ADJACENCY_KEYS, "observations"];
const CALIBRATION_EVIDENCE_KEYS = [
  "sessionId", "manifestSha256", "baseProjectRevision", "completedAt",
];
const FINAL_EVIDENCE_KEYS = [
  "commitId", "projectRevision", "rendererCorrectionFingerprint", "acknowledgedAt",
];
const VERIFICATION_EVIDENCE_KEYS = [
  "verificationId", "reportSha256", "projectRevision", "rendererCorrectionFingerprint", "completedAt",
];
const OBSERVATION_KEYS = [
  "observationId", "cameraViewId", "viewCaptureId", "viewCaptureAuthority", "preview",
  "evidenceSha256", "status", "projectRevision", "rendererCorrectionFingerprint", "observedAt",
];
const FAILURE_KEYS = ["code", "message", "failedAt"];

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

export class CameraCalibrationBundleError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CameraCalibrationBundleError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new CameraCalibrationBundleError(code, message, details);
}

function exactObject(value, field, keys, code = "INVALID_CAMERA_CALIBRATION_BUNDLE") {
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

function identifier(value, field) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field} must be a canonical identifier`);
  }
  return value;
}

function viewCaptureId(value, field) {
  if (typeof value !== "string" || !VIEW_CAPTURE_ID_PATTERN.test(value)) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `${field} must be a Server-issued viewcap_<uuid> identifier`,
    );
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function integer(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function instant(value, field) {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field} must be a canonical UTC ISO-8601 instant`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field} must be a real canonical UTC ISO-8601 instant`);
  }
  return value;
}

function assertAtOrAfter(value, minimum, field) {
  if (Date.parse(value) < Date.parse(minimum)) {
    fail("BUNDLE_EVIDENCE_TIME_INVALID", `${field} predates required bundle evidence`, { value, minimum });
  }
}

function assertAtOrBefore(value, maximum, field) {
  if (Date.parse(value) > Date.parse(maximum)) {
    fail("BUNDLE_EVIDENCE_TIME_INVALID", `${field} is later than the bundle update`, { value, maximum });
  }
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
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
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

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizeFrame(input, field) {
  const value = exactObject(input, field, ["width", "height"]);
  return {
    width: integer(value.width, `${field}.width`, 32, 16_384),
    height: integer(value.height, `${field}.height`, 32, 16_384),
  };
}

function normalizeIdentifierArray(
  input,
  field,
  { minimum = 1, maximum = MAX_OUTPUTS, duplicateCode = "DUPLICATE_BUNDLE_OUTPUT" } = {},
) {
  if (!Array.isArray(input) || input.length < minimum || input.length > maximum) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `${field} must contain ${minimum}-${maximum} identifiers`,
    );
  }
  const values = input.map((value, index) => identifier(value, `${field}[${index}]`));
  if (new Set(values).size !== values.length) {
    fail(duplicateCode, `${field} must not contain duplicate identifiers`);
  }
  return values;
}

function normalizeBaseProject(input, field = "baseProject") {
  const value = exactObject(input, field, ["id", "revision"]);
  return {
    id: identifier(value.id, `${field}.id`),
    revision: integer(value.revision, `${field}.revision`, 0, Number.MAX_SAFE_INTEGER - 1),
  };
}

function normalizeCurrentProject(input, field = "currentProject") {
  if (input == null) {
    fail("CURRENT_PROJECT_REQUIRED", `${field} is required for stale-project protection`);
  }
  return normalizeBaseProject(input, field);
}

function assertProject(value, expected, code, message) {
  if (value.id !== expected.id || value.revision !== expected.revision) {
    fail(code, message, { currentProject: value, expectedProject: expected });
  }
}

function normalizePreview(input, field) {
  const value = exactObject(input, field, PREVIEW_KEYS);
  if (value.authentication !== PREVIEW_AUTHENTICATION) {
    fail(
      "UNAUTHENTICATED_BUNDLE_PREVIEW",
      `${field}.authentication must be ${PREVIEW_AUTHENTICATION}`,
    );
  }
  const capturedAt = instant(value.capturedAt, `${field}.capturedAt`);
  const authenticatedAt = instant(value.authenticatedAt, `${field}.authenticatedAt`);
  assertAtOrAfter(authenticatedAt, capturedAt, `${field}.authenticatedAt`);
  return {
    id: identifier(value.id, `${field}.id`),
    artifactSha256: digest(value.artifactSha256, `${field}.artifactSha256`),
    capturedAt,
    authenticatedAt,
    authentication: PREVIEW_AUTHENTICATION,
  };
}

function normalizeSurveyPayload(input, field) {
  const value = exactObject(input, field, SURVEY_PAYLOAD_KEYS);
  if (value.method !== SURVEY_METHOD) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.method must be ${SURVEY_METHOD}`);
  }
  normalizeFrame(value.frame, `${field}.frame`);
  digest(value.lensProfileSha256, `${field}.lensProfileSha256`);
  if (!Array.isArray(value.boundary) || value.boundary.length !== 4) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.boundary must contain TL, TR, BR and BL`);
  }
  value.boundary.forEach((point, index) => {
    const pointValue = exactObject(point, `${field}.boundary[${index}]`, ["x", "y"]);
    for (const coordinate of ["x", "y"]) {
      if (typeof pointValue[coordinate] !== "number" || !Number.isFinite(pointValue[coordinate])
        || Object.is(pointValue[coordinate], -0)) {
        fail(
          "INVALID_CAMERA_CALIBRATION_BUNDLE",
          `${field}.boundary[${index}].${coordinate} must be a canonical finite number`,
        );
      }
    }
  });
  let normalized;
  try {
    [normalized] = normalizePlanarSurfaceSurveys([value]);
  } catch (error) {
    fail(error?.code || "INVALID_CAMERA_CALIBRATION_BUNDLE", error?.message || `${field} is invalid`, error?.details);
  }
  return normalized;
}

/** Return the bundle-local SHA-256 identity of one exact planar survey. */
export function cameraCalibrationBundleSurveySha256(input) {
  return sha256(canonicalJson(normalizeSurveyPayload(input, "survey")));
}

function normalizeSurvey(input, field, { includeSha256 }) {
  const value = exactObject(input, field, includeSha256 ? SURVEY_KEYS : SURVEY_PAYLOAD_KEYS);
  const payload = normalizeSurveyPayload(
    includeSha256 ? Object.fromEntries(SURVEY_PAYLOAD_KEYS.map((key) => [key, value[key]])) : value,
    field,
  );
  const expectedSha256 = sha256(canonicalJson(payload));
  if (includeSha256 && digest(value.sha256, `${field}.sha256`) !== expectedSha256) {
    fail(
      "SURVEY_IDENTITY_MISMATCH",
      `${field}.sha256 does not bind the exact survey, lens profile and frame`,
      { suppliedSha256: value.sha256, expectedSha256 },
    );
  }
  return { ...payload, sha256: expectedSha256 };
}

function normalizeCalibrationEvidence(input, field) {
  const value = exactObject(input, field, CALIBRATION_EVIDENCE_KEYS);
  return {
    sessionId: identifier(value.sessionId, `${field}.sessionId`),
    manifestSha256: digest(value.manifestSha256, `${field}.manifestSha256`),
    baseProjectRevision: integer(value.baseProjectRevision, `${field}.baseProjectRevision`, 0),
    completedAt: instant(value.completedAt, `${field}.completedAt`),
  };
}

function normalizeFinalEvidence(input, field = "finalEvidence") {
  const value = exactObject(input, field, FINAL_EVIDENCE_KEYS);
  return {
    commitId: identifier(value.commitId, `${field}.commitId`),
    projectRevision: integer(value.projectRevision, `${field}.projectRevision`, 1),
    rendererCorrectionFingerprint: digest(
      value.rendererCorrectionFingerprint,
      `${field}.rendererCorrectionFingerprint`,
    ),
    acknowledgedAt: instant(value.acknowledgedAt, `${field}.acknowledgedAt`),
  };
}

function normalizeVerificationEvidence(input, field) {
  const value = exactObject(input, field, VERIFICATION_EVIDENCE_KEYS);
  return {
    verificationId: identifier(value.verificationId, `${field}.verificationId`),
    reportSha256: digest(value.reportSha256, `${field}.reportSha256`),
    projectRevision: integer(value.projectRevision, `${field}.projectRevision`, 1),
    rendererCorrectionFingerprint: digest(
      value.rendererCorrectionFingerprint,
      `${field}.rendererCorrectionFingerprint`,
    ),
    completedAt: instant(value.completedAt, `${field}.completedAt`),
  };
}

function normalizeFailure(input, field) {
  const value = exactObject(input, field, FAILURE_KEYS);
  if (typeof value.message !== "string" || value.message.length < 1 || value.message.length > 2_048
    || value.message.trim() !== value.message) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.message must be canonical text`);
  }
  return {
    code: identifier(value.code, `${field}.code`),
    message: value.message,
    failedAt: instant(value.failedAt, `${field}.failedAt`),
  };
}

function normalizeCreateMember(input, index) {
  const field = `members[${index}]`;
  const value = exactObject(input, field, CREATE_MEMBER_KEYS);
  const frame = normalizeFrame(value.frame, `${field}.frame`);
  const lensProfileSha256 = digest(value.lensProfileSha256, `${field}.lensProfileSha256`);
  const cameraViewId = identifier(value.cameraViewId, `${field}.cameraViewId`);
  if (value.viewCaptureAuthority !== VIEW_CAPTURE_AUTHORITY) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.viewCaptureAuthority must be server`);
  }
  if (value.poseRegistration !== CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `${field}.poseRegistration must be ${CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION}`,
    );
  }
  const survey = normalizeSurvey(value.survey, `${field}.survey`, { includeSha256: false });
  if (survey.cameraViewId !== cameraViewId
    || survey.lensProfileSha256 !== lensProfileSha256
    || survey.frame.width !== frame.width
    || survey.frame.height !== frame.height) {
    fail(
      "BUNDLE_SURVEY_BINDING_MISMATCH",
      `${field}.survey must exactly match its camera view, lens digest and retained frame`,
    );
  }
  return {
    memberId: identifier(value.memberId, `${field}.memberId`),
    cameraViewId,
    viewCaptureId: viewCaptureId(value.viewCaptureId, `${field}.viewCaptureId`),
    viewCaptureAuthority: VIEW_CAPTURE_AUTHORITY,
    poseRegistration: CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION,
    lensProfileSha256,
    frame,
    outputIds: normalizeIdentifierArray(value.outputIds, `${field}.outputIds`),
    preview: normalizePreview(value.preview, `${field}.preview`),
    survey,
  };
}

function normalizeMember(input, index, bundle) {
  const field = `members[${index}]`;
  const value = exactObject(input, field, MEMBER_KEYS);
  const createPart = Object.fromEntries(CREATE_MEMBER_KEYS.map((key) => [key, value[key]]));
  const normalized = normalizeCreateMember(
    { ...createPart, survey: Object.fromEntries(SURVEY_PAYLOAD_KEYS.map((key) => [key, value.survey?.[key]])) },
    index,
  );
  const suppliedSurvey = normalizeSurvey(value.survey, `${field}.survey`, { includeSha256: true });
  normalized.survey = suppliedSurvey;
  const states = new Set(Object.values(CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE));
  if (!states.has(value.state)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.state is unsupported`);
  }
  const calibrationEvidence = value.calibrationEvidence == null
    ? null
    : normalizeCalibrationEvidence(value.calibrationEvidence, `${field}.calibrationEvidence`);
  const verificationEvidence = value.verificationEvidence == null
    ? null
    : normalizeVerificationEvidence(value.verificationEvidence, `${field}.verificationEvidence`);
  const failure = value.failure == null ? null : normalizeFailure(value.failure, `${field}.failure`);
  if (calibrationEvidence && calibrationEvidence.baseProjectRevision !== bundle.baseProject.revision) {
    fail(
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      `${field}.calibrationEvidence was measured against a different project revision`,
    );
  }
  const expectedEvidence = {
    [CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING]: [false, false, false],
    [CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED]: [true, false, false],
    [CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED]: [true, true, false],
  }[value.state];
  if (expectedEvidence
    && (Boolean(calibrationEvidence) !== expectedEvidence[0]
      || Boolean(verificationEvidence) !== expectedEvidence[1]
      || Boolean(failure) !== expectedEvidence[2])) {
    fail("BUNDLE_MEMBER_STATE_MISMATCH", `${field} evidence does not match ${value.state}`);
  }
  if (value.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.FAILED && (!failure || verificationEvidence)) {
    fail("BUNDLE_MEMBER_STATE_MISMATCH", `${field} failed state requires failure and forbids verification evidence`);
  }
  if (verificationEvidence) assertFinalBinding(verificationEvidence, bundle.finalEvidence, field);
  return { ...normalized, state: value.state, calibrationEvidence, verificationEvidence, failure };
}

function normalizeOverlap(input, index) {
  const field = `sameWallOverlaps[${index}]`;
  const value = exactObject(input, field, OVERLAP_KEYS);
  return {
    id: identifier(value.id, `${field}.id`),
    wallId: identifier(value.wallId, `${field}.wallId`),
    outputIds: normalizeIdentifierArray(value.outputIds, `${field}.outputIds`, { minimum: 2, maximum: 32 }),
  };
}

function normalizeObservation(input, field) {
  const value = exactObject(input, field, OBSERVATION_KEYS);
  if (value.viewCaptureAuthority !== VIEW_CAPTURE_AUTHORITY) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.viewCaptureAuthority must be server`);
  }
  if (!new Set(["passed", "failed", "not-observable"]).has(value.status)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.status is unsupported`);
  }
  return {
    observationId: identifier(value.observationId, `${field}.observationId`),
    cameraViewId: identifier(value.cameraViewId, `${field}.cameraViewId`),
    viewCaptureId: viewCaptureId(value.viewCaptureId, `${field}.viewCaptureId`),
    viewCaptureAuthority: VIEW_CAPTURE_AUTHORITY,
    preview: normalizePreview(value.preview, `${field}.preview`),
    evidenceSha256: digest(value.evidenceSha256, `${field}.evidenceSha256`),
    status: value.status,
    projectRevision: integer(value.projectRevision, `${field}.projectRevision`, 1),
    rendererCorrectionFingerprint: digest(
      value.rendererCorrectionFingerprint,
      `${field}.rendererCorrectionFingerprint`,
    ),
    observedAt: instant(value.observedAt, `${field}.observedAt`),
  };
}

function normalizeAdjacency(input, index, { includeObservations }) {
  const field = `physicalAdjacencies[${index}]`;
  const value = exactObject(
    input,
    field,
    includeObservations ? ADJACENCY_KEYS : CREATE_ADJACENCY_KEYS,
  );
  const wallIds = normalizeIdentifierArray(value.wallIds, `${field}.wallIds`, {
    minimum: 2,
    maximum: 2,
    duplicateCode: "INVALID_CAMERA_CALIBRATION_BUNDLE",
  });
  const outputIds = normalizeIdentifierArray(value.outputIds, `${field}.outputIds`, { minimum: 2, maximum: 2 });
  return {
    id: identifier(value.id, `${field}.id`),
    wallIds,
    outputIds,
    ...(includeObservations ? {
      observations: Array.isArray(value.observations)
        ? value.observations.map((entry, observationIndex) => normalizeObservation(
          entry,
          `${field}.observations[${observationIndex}]`,
        ))
        : fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `${field}.observations must be an array`),
    } : {}),
  };
}

function assertFinalBinding(evidence, finalEvidence, field) {
  if (!finalEvidence
    || evidence.projectRevision !== finalEvidence.projectRevision
    || evidence.rendererCorrectionFingerprint !== finalEvidence.rendererCorrectionFingerprint) {
    fail(
      "FINAL_BUNDLE_EVIDENCE_MISMATCH",
      `${field} is not bound to the final renderer revision and correction fingerprint`,
    );
  }
}

function assertUnique(values, field, code) {
  if (new Set(values).size !== values.length) fail(code, `${field} values must be unique`, { values });
}

function assertBundleRelationships(bundle) {
  assertUnique(bundle.members.map((member) => member.memberId), "memberId", "REUSED_CAMERA_VIEW_CAPTURE");
  const cameraViewIds = bundle.members.map((member) => member.cameraViewId);
  const viewCaptureIds = bundle.members.map((member) => member.viewCaptureId);
  const previewIds = bundle.members.map((member) => member.preview.id);
  const previewArtifactSha256s = bundle.members.map((member) => member.preview.artifactSha256);
  assertUnique(cameraViewIds, "cameraViewId", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(viewCaptureIds, "viewCaptureId", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(previewIds, "preview.id", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(previewArtifactSha256s, "preview.artifactSha256", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(bundle.members.map((member) => member.survey.id), "survey.id", "REUSED_CAMERA_VIEW_CAPTURE");
  const calibrationEvidence = bundle.members.map((member) => member.calibrationEvidence).filter(Boolean);
  const verificationEvidence = bundle.members.map((member) => member.verificationEvidence).filter(Boolean);
  assertUnique(calibrationEvidence.map((item) => item.sessionId), "calibration sessionId", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(calibrationEvidence.map((item) => item.manifestSha256), "calibration manifest", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(verificationEvidence.map((item) => item.verificationId), "verificationId", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(verificationEvidence.map((item) => item.reportSha256), "verification report", "REUSED_CAMERA_VIEW_CAPTURE");

  const outputOwner = new Map();
  for (const member of bundle.members) {
    for (const outputId of member.outputIds) {
      if (outputOwner.has(outputId)) {
        fail("DUPLICATE_BUNDLE_OUTPUT", `Output ${outputId} belongs to multiple bundle members`);
      }
      outputOwner.set(outputId, member);
    }
  }
  const expected = new Set(bundle.expectedOutputIds);
  const actual = new Set(outputOwner.keys());
  const missing = bundle.expectedOutputIds.filter((outputId) => !actual.has(outputId));
  const unexpected = [...actual].filter((outputId) => !expected.has(outputId));
  if (missing.length || unexpected.length) {
    fail(
      "BUNDLE_OUTPUT_COVERAGE_MISMATCH",
      "Bundle members must cover every expected output exactly once",
      { missing, unexpected },
    );
  }

  assertUnique(bundle.sameWallOverlaps.map((overlap) => overlap.id), "sameWallOverlaps.id", "INVALID_CAMERA_CALIBRATION_BUNDLE");
  for (const overlap of bundle.sameWallOverlaps) {
    const owners = overlap.outputIds.map((outputId) => outputOwner.get(outputId));
    if (owners.some((owner) => !owner)) {
      fail("BUNDLE_OUTPUT_COVERAGE_MISMATCH", `Overlap ${overlap.id} references an unknown output`);
    }
    const memberIds = new Set(owners.map((owner) => owner.memberId));
    const walls = new Set(owners.map((owner) => owner.survey.wallId));
    if (memberIds.size !== 1 || walls.size !== 1 || !walls.has(overlap.wallId)) {
      fail(
        "SAME_WALL_OVERLAP_SPLIT",
        `Declared same-wall overlap ${overlap.id} must be solved by one fixed-view member`,
        { memberIds: [...memberIds], walls: [...walls], declaredWallId: overlap.wallId },
      );
    }
  }

  assertUnique(bundle.physicalAdjacencies.map((adjacency) => adjacency.id), "physicalAdjacencies.id", "INVALID_CAMERA_CALIBRATION_BUNDLE");
  const adjacencyOutputPairs = [];
  const observations = [];
  for (const adjacency of bundle.physicalAdjacencies) {
    adjacencyOutputPairs.push([...adjacency.outputIds].sort().join("\0"));
    for (let index = 0; index < 2; index += 1) {
      const owner = outputOwner.get(adjacency.outputIds[index]);
      if (!owner || owner.survey.wallId !== adjacency.wallIds[index]) {
        fail(
          "PHYSICAL_ADJACENCY_BINDING_MISMATCH",
          `Adjacency ${adjacency.id} must bind one known output to each declared wall`,
        );
      }
    }
    observations.push(...adjacency.observations);
  }
  assertUnique(adjacencyOutputPairs, "physical adjacency output pair", "INVALID_CAMERA_CALIBRATION_BUNDLE");
  assertUnique(observations.map((item) => item.observationId), "observationId", "REUSED_CAMERA_VIEW_CAPTURE");
  assertUnique(
    [...cameraViewIds, ...observations.map((item) => item.cameraViewId)],
    "member/observation cameraViewId",
    "REUSED_CAMERA_VIEW_CAPTURE",
  );
  assertUnique(
    [...viewCaptureIds, ...observations.map((item) => item.viewCaptureId)],
    "member/observation viewCaptureId",
    "REUSED_CAMERA_VIEW_CAPTURE",
  );
  assertUnique(
    [...previewIds, ...observations.map((item) => item.preview.id)],
    "member/observation preview.id",
    "REUSED_CAMERA_VIEW_CAPTURE",
  );
  assertUnique(
    [...previewArtifactSha256s, ...observations.map((item) => item.preview.artifactSha256)],
    "member/observation preview artifact",
    "REUSED_CAMERA_VIEW_CAPTURE",
  );
  assertUnique(observations.map((item) => item.evidenceSha256), "adjacency evidence", "REUSED_CAMERA_VIEW_CAPTURE");
  for (const observation of observations) assertFinalBinding(observation, bundle.finalEvidence, "adjacency observation");
}

function assertBundleChronology(bundle) {
  if (Date.parse(bundle.updatedAt) < Date.parse(bundle.createdAt)) {
    fail("BUNDLE_EVIDENCE_TIME_INVALID", "updatedAt must not predate createdAt");
  }
  for (const member of bundle.members) {
    assertAtOrBefore(member.preview.authenticatedAt, bundle.createdAt, `${member.memberId}.preview.authenticatedAt`);
    if (member.calibrationEvidence) {
      assertAtOrAfter(member.calibrationEvidence.completedAt, bundle.createdAt, `${member.memberId}.calibrationEvidence.completedAt`);
      assertAtOrBefore(member.calibrationEvidence.completedAt, bundle.updatedAt, `${member.memberId}.calibrationEvidence.completedAt`);
    }
    if (member.verificationEvidence) {
      assertAtOrAfter(member.verificationEvidence.completedAt, bundle.finalEvidence.acknowledgedAt, `${member.memberId}.verificationEvidence.completedAt`);
      assertAtOrBefore(member.verificationEvidence.completedAt, bundle.updatedAt, `${member.memberId}.verificationEvidence.completedAt`);
    }
    if (member.failure) {
      assertAtOrAfter(member.failure.failedAt, bundle.createdAt, `${member.memberId}.failure.failedAt`);
      if (bundle.finalEvidence) {
        assertAtOrAfter(
          member.failure.failedAt,
          bundle.finalEvidence.acknowledgedAt,
          `${member.memberId}.failure.failedAt`,
        );
      }
      assertAtOrBefore(member.failure.failedAt, bundle.updatedAt, `${member.memberId}.failure.failedAt`);
    }
  }
  if (bundle.finalEvidence) {
    assertAtOrAfter(bundle.finalEvidence.acknowledgedAt, bundle.createdAt, "finalEvidence.acknowledgedAt");
    assertAtOrBefore(bundle.finalEvidence.acknowledgedAt, bundle.updatedAt, "finalEvidence.acknowledgedAt");
    for (const member of bundle.members) {
      assertAtOrAfter(
        bundle.finalEvidence.acknowledgedAt,
        member.calibrationEvidence.completedAt,
        "finalEvidence.acknowledgedAt",
      );
    }
  }
  for (const adjacency of bundle.physicalAdjacencies) {
    for (const observation of adjacency.observations) {
      assertAtOrAfter(observation.preview.authenticatedAt, observation.preview.capturedAt, `${observation.observationId}.preview.authenticatedAt`);
      assertAtOrAfter(observation.preview.capturedAt, bundle.finalEvidence.acknowledgedAt, `${observation.observationId}.preview.capturedAt`);
      assertAtOrBefore(observation.preview.authenticatedAt, observation.observedAt, `${observation.observationId}.preview.authenticatedAt`);
      assertAtOrAfter(observation.observedAt, bundle.finalEvidence.acknowledgedAt, `${observation.observationId}.observedAt`);
      assertAtOrBefore(observation.observedAt, bundle.updatedAt, `${observation.observationId}.observedAt`);
    }
  }
}

/** Derive the only truthful aggregate claim supported by current evidence. */
export function deriveCameraCalibrationBundleState(input) {
  const members = input?.members;
  const adjacencies = input?.physicalAdjacencies;
  if (!Array.isArray(members) || !Array.isArray(adjacencies)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", "Bundle members and physicalAdjacencies are required");
  }
  if (members.some((member) => member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.FAILED)) {
    return CAMERA_CALIBRATION_BUNDLE_STATE.FAILED;
  }
  const allCalibrated = members.every((member) => new Set([
    CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED,
    CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED,
  ]).has(member.state));
  if (!allCalibrated) return CAMERA_CALIBRATION_BUNDLE_STATE.COLLECTING;
  if (!members.every((member) => member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED)) {
    return CAMERA_CALIBRATION_BUNDLE_STATE.CALIBRATED;
  }
  if (adjacencies.length === 0) return CAMERA_CALIBRATION_BUNDLE_STATE.VERIFIED;
  if (adjacencies.every((adjacency) => adjacency.observations.some((item) => item.status === "passed"))) {
    return CAMERA_CALIBRATION_BUNDLE_STATE.ROOM_VERIFIED;
  }
  return CAMERA_CALIBRATION_BUNDLE_STATE.SEAMS_UNVERIFIED;
}

/** Validate a persisted bundle without weakening evidence or recomputing supplied claims. */
export function normalizeCameraCalibrationBundle(input, { expectedBaseProject } = {}) {
  const value = exactObject(input, "bundle", BUNDLE_KEYS);
  if (value.schemaVersion !== CAMERA_CALIBRATION_BUNDLE_SCHEMA_VERSION) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `schemaVersion must be ${CAMERA_CALIBRATION_BUNDLE_SCHEMA_VERSION}`,
    );
  }
  if (value.poseRegistration !== CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION) {
    fail(
      "INVALID_CAMERA_CALIBRATION_BUNDLE",
      `poseRegistration must be ${CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION}`,
    );
  }
  const baseProject = normalizeBaseProject(value.baseProject);
  if (expectedBaseProject != null) {
    assertProject(
      baseProject,
      normalizeBaseProject(expectedBaseProject, "expectedBaseProject"),
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Bundle base project id or revision has changed",
    );
  }
  const finalEvidence = value.finalEvidence == null ? null : normalizeFinalEvidence(value.finalEvidence);
  if (finalEvidence && finalEvidence.projectRevision !== baseProject.revision + 1) {
    fail(
      "FINAL_BUNDLE_EVIDENCE_MISMATCH",
      "Final project revision must be the single atomic successor of the immutable base revision",
    );
  }
  const bundleContext = { baseProject, finalEvidence };
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > MAX_MEMBERS) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `members must contain 1-${MAX_MEMBERS} views`);
  }
  const members = value.members.map((member, index) => normalizeMember(member, index, bundleContext));
  if (!Array.isArray(value.sameWallOverlaps) || value.sameWallOverlaps.length > MAX_OUTPUTS) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `sameWallOverlaps must contain 0-${MAX_OUTPUTS} entries`);
  }
  if (!Array.isArray(value.physicalAdjacencies) || value.physicalAdjacencies.length > MAX_OUTPUTS) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `physicalAdjacencies must contain 0-${MAX_OUTPUTS} entries`);
  }
  const bundle = {
    schemaVersion: CAMERA_CALIBRATION_BUNDLE_SCHEMA_VERSION,
    bundleId: identifier(value.bundleId, "bundleId"),
    baseProject,
    poseRegistration: CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION,
    expectedOutputIds: normalizeIdentifierArray(value.expectedOutputIds, "expectedOutputIds"),
    members,
    sameWallOverlaps: value.sameWallOverlaps.map(normalizeOverlap),
    physicalAdjacencies: value.physicalAdjacencies.map((entry, index) => normalizeAdjacency(
      entry,
      index,
      { includeObservations: true },
    )),
    finalEvidence,
    aggregateState: value.aggregateState,
    createdAt: instant(value.createdAt, "createdAt"),
    updatedAt: instant(value.updatedAt, "updatedAt"),
  };
  if (finalEvidence && !members.every((member) => member.calibrationEvidence)) {
    fail("INVALID_BUNDLE_TRANSITION", "Final renderer evidence requires every member calibration result");
  }
  if (!finalEvidence && members.some((member) => member.verificationEvidence)) {
    fail("FINAL_BUNDLE_EVIDENCE_MISMATCH", "Member verification requires final renderer evidence");
  }
  assertBundleRelationships(bundle);
  assertBundleChronology(bundle);
  const aggregateState = deriveCameraCalibrationBundleState(bundle);
  if (bundle.aggregateState !== aggregateState) {
    if (bundle.aggregateState === CAMERA_CALIBRATION_BUNDLE_STATE.ROOM_VERIFIED) {
      fail(
        "ROOM_VERIFICATION_EVIDENCE_MISSING",
        "room-verified requires every declared physical adjacency to have passed final-revision evidence",
      );
    }
    fail(
      "BUNDLE_AGGREGATE_STATE_MISMATCH",
      `aggregateState must be derived as ${aggregateState}`,
      { supplied: bundle.aggregateState, expected: aggregateState },
    );
  }
  return deepFreeze(bundle);
}

/**
 * Create an immutable-base bundle after the authenticated Server has collected
 * each view preview. currentProject is mandatory so callers cannot omit the
 * initial stale-revision guard.
 */
export function createCameraCalibrationBundle(input, { currentProject } = {}) {
  const value = exactObject(input, "bundle input", CREATE_KEYS);
  const baseProject = normalizeBaseProject(value.baseProject);
  assertProject(
    normalizeCurrentProject(currentProject),
    baseProject,
    "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
    "Cannot create a bundle from a stale project revision",
  );
  const createdAt = instant(value.createdAt, "createdAt");
  if (!Array.isArray(value.members) || value.members.length < 1 || value.members.length > MAX_MEMBERS) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", `members must contain 1-${MAX_MEMBERS} views`);
  }
  const members = value.members.map((member, index) => ({
    ...normalizeCreateMember(member, index),
    state: CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING,
    calibrationEvidence: null,
    verificationEvidence: null,
    failure: null,
  }));
  if (!Array.isArray(value.sameWallOverlaps) || !Array.isArray(value.physicalAdjacencies)) {
    fail("INVALID_CAMERA_CALIBRATION_BUNDLE", "sameWallOverlaps and physicalAdjacencies must be arrays");
  }
  const materialized = {
    schemaVersion: CAMERA_CALIBRATION_BUNDLE_SCHEMA_VERSION,
    bundleId: identifier(value.bundleId, "bundleId"),
    baseProject,
    poseRegistration: CAMERA_CALIBRATION_BUNDLE_POSE_REGISTRATION,
    expectedOutputIds: normalizeIdentifierArray(value.expectedOutputIds, "expectedOutputIds"),
    members,
    sameWallOverlaps: value.sameWallOverlaps.map(normalizeOverlap),
    physicalAdjacencies: value.physicalAdjacencies.map((entry, index) => ({
      ...normalizeAdjacency(entry, index, { includeObservations: false }),
      observations: [],
    })),
    finalEvidence: null,
    aggregateState: CAMERA_CALIBRATION_BUNDLE_STATE.COLLECTING,
    createdAt,
    updatedAt: createdAt,
  };
  return normalizeCameraCalibrationBundle(materialized);
}

/** Generate an opaque capture identity; call this only in authenticated Server code. */
export function createServerCameraViewCaptureId({ randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto) } = {}) {
  if (typeof randomUUID !== "function") {
    fail("SERVER_RANDOM_UUID_REQUIRED", "A cryptographically secure Server randomUUID function is required");
  }
  const uuid = String(randomUUID()).toLowerCase();
  const generated = `viewcap_${uuid}`;
  return viewCaptureId(generated, "generated viewCaptureId");
}

function normalizeTransitionEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_BUNDLE_TRANSITION", "event must be an object");
  }
  const common = ["type", "at"];
  const keysByType = {
    [CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_CALIBRATED]: [...common, "memberId", "evidence"],
    [CAMERA_CALIBRATION_BUNDLE_EVENT.FINAL_RENDERER_ACKNOWLEDGED]: [...common, "evidence"],
    [CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_VERIFIED]: [...common, "memberId", "evidence"],
    [CAMERA_CALIBRATION_BUNDLE_EVENT.ADJACENCY_OBSERVED]: [...common, "adjacencyId", "observation"],
    [CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_FAILED]: [...common, "memberId", "failure"],
  };
  const keys = keysByType[input.type];
  if (!keys) fail("INVALID_BUNDLE_TRANSITION", `Unsupported bundle event ${String(input.type)}`);
  exactObject(input, "event", keys, "INVALID_BUNDLE_TRANSITION");
  return { ...input, at: instant(input.at, "event.at") };
}

function memberIndex(bundle, memberId) {
  const normalizedId = identifier(memberId, "event.memberId");
  const index = bundle.members.findIndex((member) => member.memberId === normalizedId);
  if (index < 0) fail("INVALID_BUNDLE_TRANSITION", `Unknown bundle member ${normalizedId}`);
  return index;
}

function assertEventTime(bundle, event, evidenceTime) {
  assertAtOrAfter(event.at, bundle.updatedAt, "event.at");
  assertAtOrAfter(evidenceTime, bundle.updatedAt, "event evidence time");
  assertAtOrBefore(evidenceTime, event.at, "event evidence time");
}

/**
 * Apply one append-only evidence transition. The current project is mandatory:
 * collection events require the frozen base, while final/verification events
 * require the exact committed final revision.
 */
export function reduceCameraCalibrationBundle(input, eventInput, { currentProject } = {}) {
  const bundle = normalizeCameraCalibrationBundle(input);
  const event = normalizeTransitionEvent(eventInput);
  const project = normalizeCurrentProject(currentProject);
  const next = structuredClone(bundle);

  if (event.type === CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_CALIBRATED) {
    assertProject(
      project,
      bundle.baseProject,
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Member calibration cannot use a stale bundle base",
    );
    const index = memberIndex(bundle, event.memberId);
    const member = bundle.members[index];
    if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING || bundle.finalEvidence) {
      fail("INVALID_BUNDLE_TRANSITION", `${member.memberId} is not awaiting calibration`);
    }
    const evidence = normalizeCalibrationEvidence(event.evidence, "event.evidence");
    if (evidence.baseProjectRevision !== bundle.baseProject.revision) {
      fail("STALE_CAMERA_CALIBRATION_BUNDLE_BASE", "Calibration evidence was measured from a stale project");
    }
    assertEventTime(bundle, event, evidence.completedAt);
    next.members[index].state = CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED;
    next.members[index].calibrationEvidence = evidence;
  } else if (event.type === CAMERA_CALIBRATION_BUNDLE_EVENT.FINAL_RENDERER_ACKNOWLEDGED) {
    if (bundle.finalEvidence || !bundle.members.every(
      (member) => member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED,
    )) {
      fail("INVALID_BUNDLE_TRANSITION", "Final commit requires every member calibrated exactly once");
    }
    const evidence = normalizeFinalEvidence(event.evidence, "event.evidence");
    if (evidence.projectRevision !== bundle.baseProject.revision + 1) {
      fail("FINAL_BUNDLE_EVIDENCE_MISMATCH", "Final commit must atomically advance the base by one revision");
    }
    assertProject(
      project,
      { id: bundle.baseProject.id, revision: evidence.projectRevision },
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Renderer acknowledgement is not for the bundle's atomic successor revision",
    );
    assertEventTime(bundle, event, evidence.acknowledgedAt);
    next.finalEvidence = evidence;
  } else if (event.type === CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_VERIFIED) {
    if (!bundle.finalEvidence) fail("INVALID_BUNDLE_TRANSITION", "Final renderer evidence is required before verification");
    assertProject(
      project,
      { id: bundle.baseProject.id, revision: bundle.finalEvidence.projectRevision },
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Member verification is stale relative to the final bundle revision",
    );
    const index = memberIndex(bundle, event.memberId);
    const member = bundle.members[index];
    if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED) {
      fail("INVALID_BUNDLE_TRANSITION", `${member.memberId} is not awaiting verification`);
    }
    const evidence = normalizeVerificationEvidence(event.evidence, "event.evidence");
    assertFinalBinding(evidence, bundle.finalEvidence, "event.evidence");
    assertEventTime(bundle, event, evidence.completedAt);
    next.members[index].state = CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED;
    next.members[index].verificationEvidence = evidence;
  } else if (event.type === CAMERA_CALIBRATION_BUNDLE_EVENT.ADJACENCY_OBSERVED) {
    if (!bundle.finalEvidence
      || !bundle.members.every((member) => member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED)) {
      fail("INVALID_BUNDLE_TRANSITION", "Physical adjacency observation requires all views verified");
    }
    assertProject(
      project,
      { id: bundle.baseProject.id, revision: bundle.finalEvidence.projectRevision },
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Adjacency observation is stale relative to the final bundle revision",
    );
    const adjacencyId = identifier(event.adjacencyId, "event.adjacencyId");
    const index = bundle.physicalAdjacencies.findIndex((adjacency) => adjacency.id === adjacencyId);
    if (index < 0) fail("INVALID_BUNDLE_TRANSITION", `Unknown physical adjacency ${adjacencyId}`);
    const observation = normalizeObservation(event.observation, "event.observation");
    assertFinalBinding(observation, bundle.finalEvidence, "event.observation");
    assertEventTime(bundle, event, observation.observedAt);
    next.physicalAdjacencies[index].observations.push(observation);
  } else {
    const index = memberIndex(bundle, event.memberId);
    const member = bundle.members[index];
    if (member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED
      || member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.FAILED) {
      fail("INVALID_BUNDLE_TRANSITION", `${member.memberId} cannot transition to failed`);
    }
    const expectedProject = bundle.finalEvidence
      ? { id: bundle.baseProject.id, revision: bundle.finalEvidence.projectRevision }
      : bundle.baseProject;
    assertProject(
      project,
      expectedProject,
      "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
      "Failure evidence is stale relative to the bundle",
    );
    const failure = normalizeFailure(event.failure, "event.failure");
    assertEventTime(bundle, event, failure.failedAt);
    next.members[index].state = CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.FAILED;
    next.members[index].failure = failure;
  }
  next.updatedAt = event.at;
  next.aggregateState = deriveCameraCalibrationBundleState(next);
  return normalizeCameraCalibrationBundle(next);
}
