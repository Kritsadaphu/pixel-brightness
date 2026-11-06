import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND,
  EXECUTION_LEASE_SCHEMA_VERSION,
  HOST_ACTION_TYPE,
  NODE_STATUS,
  PROTOCOL_VERSION,
  SOFTWARE_VERSION,
  assertProtocolVersion,
  createCommand,
  isSafetyCriticalCommand,
  jsonSafe,
  makeId,
  normalizeProject,
  normalizeRegistration,
  normalizeExecutionLease,
} from "../shared/protocol.mjs";
import { epochNowNs, frameAtTime, nsFromMs } from "../shared/timecore.mjs";
import {
  CAMERA_CALIBRATION_STATE,
  CameraCalibrationError,
  createCameraCalibrationPlan,
  normalizeCameraCalibrationManifest,
  validateCameraCalibrationProjectPatch,
} from "../shared/camera-calibration.mjs";
import { derivePlanarOutputTargets } from "../shared/camera-survey.mjs";
import {
  CameraSurveyPreviewError,
  normalizeCameraSurveyPreviewCommand,
  normalizeCameraSurveyPreviewReport,
} from "../shared/camera-survey-preview.mjs";
import {
  CAMERA_CALIBRATION_BUNDLE_EVENT,
  CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE,
  CameraCalibrationBundleError,
  createCameraCalibrationBundle,
  createServerCameraViewCaptureId,
  normalizeCameraCalibrationBundle,
  reduceCameraCalibrationBundle,
} from "../shared/camera-calibration-bundle.mjs";
import {
  CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS,
  CAMERA_OPTICAL_ROLLBACK_TRIGGER,
  CAMERA_OPTICAL_VERIFICATION_STATE,
  CameraOpticalVerificationError,
  createCameraOpticalVerificationPlan,
  createCameraOpticalVerificationState,
  normalizeCameraOpticalVerificationConfirmation,
  normalizeCameraOpticalVerificationState,
} from "../shared/camera-verification.mjs";
import { normalizeRendererCorrectionBinding } from "../shared/renderer-correction-binding.mjs";
import { HttpError, badRequest, conflict, forbidden, notFound } from "./errors.mjs";
import {
  POWER_ACTION_TYPES,
  actionResultSummary,
  boundedJson,
  deriveHostFaults,
  expectedConfirmationPhrase,
  normalizeActionRequest,
  normalizeActionResults,
  normalizeCommandDeadLetters,
  normalizeHostSnapshot,
} from "./fleet.mjs";

const VALID_NODE_STATUS = new Set(Object.values(NODE_STATUS));
const MAX_QUEUE_LENGTH = 4096;
const MAX_LONG_POLL_MS = 25_000;
const MAX_FRAME = 9_223_372_036_854_775_807n;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_CAMERA_SURVEY_PREVIEWS = 16;
const MAX_CAMERA_CALIBRATION_BUNDLES = 64;
const MAX_COMMAND_DEAD_LETTERS_PER_NODE = 4_096;
const MAX_EXECUTION_LEASE_TTL_MS = 5_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const ACTIVE_OPTICAL_VERIFICATION_STATES = new Set([
  CAMERA_OPTICAL_VERIFICATION_STATE.QUEUED,
  CAMERA_OPTICAL_VERIFICATION_STATE.PREFLIGHT,
  CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR,
  CAMERA_OPTICAL_VERIFICATION_STATE.CAPTURING,
  CAMERA_OPTICAL_VERIFICATION_STATE.EVALUATING,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
]);

function validateNodeId(value) {
  const nodeId = String(value ?? "");
  if (!NODE_ID_PATTERN.test(nodeId)) throw badRequest("Invalid node id", "invalid_node_id");
  return nodeId;
}

function mintExecutionLease(state, nodeId, ttlMs, serverStateRecovery = null) {
  const node = state.nodes[nodeId];
  if (serverStateRecovery?.status === "active" || node?.failClosedFence?.status === "active") return null;
  const issuedAtNs = epochNowNs();
  const lease = normalizeExecutionLease({
    schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
    leaseId: `execution_lease_${randomBytes(16).toString("hex")}`,
    nodeId: node.nodeId,
    fenceGeneration: Number(node.failClosedGeneration ?? 0),
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + BigInt(ttlMs) * 1_000_000n).toString(),
  }, {
    nodeId: node.nodeId,
    fenceGeneration: Number(node.failClosedGeneration ?? 0),
  });
  node.maxIssuedLeaseExpiresAtNs = BigInt(node.maxIssuedLeaseExpiresAtNs ?? "0")
    > BigInt(lease.expiresAtNs)
    ? node.maxIssuedLeaseExpiresAtNs
    : lease.expiresAtNs;
  return lease;
}

function frameValue(value, fallback = 0n) {
  if (value == null || value === "") return fallback;
  try {
    const frame = BigInt(value);
    if (frame < 0n || frame > MAX_FRAME) throw new Error("range");
    return frame;
  } catch {
    throw badRequest("Frame must be a non-negative 64-bit integer", "invalid_frame");
  }
}

function integer(value, fallback, min, max, fieldName) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${fieldName} must be a number`, `invalid_${fieldName}`);
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function nextProjectRevision(value, operation = "project mutation") {
  const currentRevision = Number(value);
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1
    || currentRevision >= Number.MAX_SAFE_INTEGER) {
    throw conflict(
      `Cannot perform ${operation}: the authoritative project revision is exhausted`,
      "project_revision_exhausted",
      { currentRevision: Number.isSafeInteger(currentRevision) ? currentRevision : null, operation },
    );
  }
  return currentRevision + 1;
}

function telemetryFrom(input = {}) {
  const outputs = Array.isArray(input.outputs)
    ? input.outputs.slice(0, 256).map((output) => ({
      id: String(output?.id ?? "").slice(0, 128),
      connector: String(output?.connector ?? "").slice(0, 128),
      state: String(output?.state ?? "unknown").slice(0, 64),
      currentFrame: output?.currentFrame == null ? null : String(output.currentFrame).slice(0, 32),
      droppedFrames: Math.max(0, Number(output?.droppedFrames ?? 0) || 0),
    }))
    : [];
  return {
    currentFrame: input.currentFrame == null ? null : String(input.currentFrame).slice(0, 32),
    clockOffsetNs: input.clockOffsetNs == null ? null : String(input.clockOffsetNs).slice(0, 32),
    bestRttNs: input.bestRttNs == null ? null : String(input.bestRttNs).slice(0, 32),
    clockRttNs: input.clockRttNs == null
      ? (input.bestRttNs == null ? null : String(input.bestRttNs).slice(0, 32))
      : String(input.clockRttNs).slice(0, 32),
    droppedFrames: Math.max(0, Number(input.droppedFrames ?? 0) || 0),
    repeatedFrames: Math.max(0, Number(input.repeatedFrames ?? 0) || 0),
    lateFrames: Math.max(0, Number(input.lateFrames ?? 0) || 0),
    temperatureC: input.temperatureC == null ? null : Math.max(-100, Math.min(200, Number(input.temperatureC) || 0)),
    projectRevision: input.projectRevision == null ? null : Math.max(0, Number(input.projectRevision) || 0),
    preparedAssetSha256: input.preparedAssetSha256 == null
      ? null
      : String(input.preparedAssetSha256).toLowerCase().slice(0, 64),
    cacheReady: Boolean(input.cacheReady),
    engine: String(input.engine ?? "unknown").slice(0, 128),
    error: input.error == null ? null : String(input.error).slice(0, 2048),
    cameraOpticalVerificationFailClosed: input.cameraOpticalVerificationFailClosed === true,
    commandFailureSafetyLock: input.commandFailureSafetyLock && typeof input.commandFailureSafetyLock === "object"
      ? boundedJson(input.commandFailureSafetyLock, {
        label: "Command failure safety lock", code: "command_failure_safety_lock", maxBytes: 32 * 1024,
        maxDepth: 6, maxArrayLength: 32, maxObjectKeys: 64, maxStringLength: 2_048,
      })
      : null,
    stateRecoverySafetyLock: input.stateRecoverySafetyLock && typeof input.stateRecoverySafetyLock === "object"
      ? boundedJson(input.stateRecoverySafetyLock, {
        label: "State recovery safety lock", code: "state_recovery_safety_lock", maxBytes: 32 * 1024,
        maxDepth: 6, maxArrayLength: 32, maxObjectKeys: 64, maxStringLength: 2_048,
      })
      : null,
    renderer: input.renderer && typeof input.renderer === "object"
      ? boundedJson(input.renderer, {
        label: "Renderer telemetry", code: "renderer_telemetry", maxBytes: 128 * 1024,
        maxDepth: 8, maxArrayLength: 256, maxObjectKeys: 256, maxStringLength: 16 * 1024,
      })
      : null,
    camera: input.camera && typeof input.camera === "object"
      ? boundedJson(input.camera, {
        label: "Camera telemetry", code: "camera_telemetry", maxBytes: 32 * 1024,
        maxDepth: 6, maxArrayLength: 64, maxObjectKeys: 128, maxStringLength: 4 * 1024,
      })
      : null,
    cameraCalibration: input.cameraCalibration && typeof input.cameraCalibration === "object"
      ? boundedJson(input.cameraCalibration, {
        label: "Camera calibration telemetry", code: "camera_calibration_telemetry", maxBytes: 64 * 1024 * 1024,
        maxDepth: 12, maxArrayLength: 100_000, maxObjectKeys: 4_096, maxStringLength: 64 * 1024,
      })
      : null,
    outputs,
  };
}

const TERMINAL_CALIBRATION_STATES = new Set(["complete", "failed", "cancelled"]);
const CAMERA_CALIBRATION_REPORT_STATES = new Set([
  ...Object.values(CAMERA_CALIBRATION_STATE),
  "queued",
]);

function calibrationHttpError(error) {
  if (!(error instanceof CameraCalibrationError)) return error;
  const conflictCodes = new Set([
    "CALIBRATION_PROJECT_REVISION_MISMATCH",
    "CALIBRATION_NODE_MISMATCH",
    "CALIBRATION_OUTPUT_NOT_FOUND",
  ]);
  return new HttpError(
    conflictCodes.has(error.code) ? 409 : 400,
    String(error.code || "invalid_camera_calibration").toLowerCase(),
    error.message,
    error.details ?? undefined,
  );
}

function cameraSurveyPreviewHttpError(error) {
  if (!(error instanceof CameraSurveyPreviewError)) return error;
  const conflictCodes = new Set([
    "CAMERA_SURVEY_PREVIEW_REQUEST_MISMATCH",
    "CAMERA_SURVEY_PREVIEW_PROFILE_MISMATCH",
  ]);
  return new HttpError(
    conflictCodes.has(error.code) ? 409 : 400,
    String(error.code || "invalid_camera_survey_preview").toLowerCase(),
    error.message,
    error.details ?? undefined,
  );
}

function cameraCalibrationBundleHttpError(error) {
  if (!(error instanceof CameraCalibrationBundleError)) return error;
  const conflictCodes = new Set([
    "BUNDLE_AGGREGATE_STATE_MISMATCH",
    "BUNDLE_MEMBER_STATE_MISMATCH",
    "BUNDLE_OUTPUT_COVERAGE_MISMATCH",
    "CURRENT_PROJECT_REQUIRED",
    "DUPLICATE_BUNDLE_OUTPUT",
    "FINAL_BUNDLE_EVIDENCE_MISMATCH",
    "INVALID_BUNDLE_TRANSITION",
    "PHYSICAL_ADJACENCY_BINDING_MISMATCH",
    "REUSED_CAMERA_VIEW_CAPTURE",
    "ROOM_VERIFICATION_EVIDENCE_MISSING",
    "SAME_WALL_OVERLAP_SPLIT",
    "STALE_CAMERA_CALIBRATION_BUNDLE_BASE",
    "SURVEY_IDENTITY_MISMATCH",
    "UNAUTHENTICATED_BUNDLE_PREVIEW",
  ]);
  return new HttpError(
    conflictCodes.has(error.code) ? 409 : 400,
    String(error.code || "invalid_camera_calibration_bundle").toLowerCase(),
    error.message,
    error.details ?? undefined,
  );
}

function cameraOpticalVerificationHttpError(error) {
  if (!(error instanceof CameraOpticalVerificationError)) return error;
  const conflictCodes = new Set([
    "OPTICAL_VERIFICATION_REVISION_MISMATCH",
    "OPTICAL_VERIFICATION_CAMERA_MISMATCH",
    "OPTICAL_VERIFICATION_LENS_MISMATCH",
    "OPTICAL_VERIFICATION_CONFIRMATION_STALE",
    "OPTICAL_VERIFICATION_CONFIRMATION_REPLAY",
  ]);
  return new HttpError(
    conflictCodes.has(error.code) ? 409 : 400,
    String(error.code || "invalid_camera_optical_verification").toLowerCase(),
    error.message,
    error.details ?? undefined,
  );
}

function boundedCameraOpticalVerificationState(value) {
  let document;
  try {
    document = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
  } catch {
    throw badRequest(
      "Camera optical verification state must be finite JSON",
      "invalid_camera_optical_verification_state",
    );
  }
  if (document == null || Buffer.byteLength(document) > 64 * 1024 * 1024) {
    throw badRequest(
      "Camera optical verification state exceeds 67108864 bytes",
      "camera_optical_verification_state_too_large",
    );
  }
  return JSON.parse(document);
}

function opticalRuntime(calibration) {
  return calibration?.opticalVerification?.runtime ?? null;
}

function opticalPlan(calibration) {
  return calibration?.opticalVerification?.plan ?? null;
}

function activeOpticalVerificationForNode(state, nodeId) {
  return Object.values(state.cameraCalibrations || {}).find((calibration) => (
    calibration?.nodeId === nodeId
    && ACTIVE_OPTICAL_VERIFICATION_STATES.has(calibration?.opticalVerification?.state)
  ));
}

function supersedeAppliedCameraCalibrations(state, {
  currentSessionId = null,
  projectRevision,
  at,
} = {}) {
  for (const calibration of Object.values(state.cameraCalibrations || {})) {
    if (calibration?.sessionId === currentSessionId
      || calibration?.projectCommitted !== true
      || calibration?.currentlyApplied !== true
      || Number(calibration?.appliedRevision) === Number(projectRevision)) continue;
    calibration.currentlyApplied = false;
    calibration.rendererCorrectionBinding = null;
    const wrapper = calibration.opticalVerification || {};
    if (wrapper.plan != null && wrapper.runtime != null) {
      const supersededRuntime = normalizeCameraOpticalVerificationState({
        ...wrapper.runtime,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED,
        updatedAt: at,
        operatorPrompt: null,
      }, { plan: wrapper.plan });
      calibration.opticalVerification = mirrorOpticalRuntime(wrapper, supersededRuntime, {
        required: true,
        verifiedAt: null,
        reason: "project-revision-changed",
        supersededAt: at,
        supersededByRevision: projectRevision,
      });
    } else {
      calibration.opticalVerification = {
        ...wrapper,
        state: "superseded",
        required: true,
        verifiedAt: null,
        reason: "project-revision-changed",
        supersededAt: at,
        supersededByRevision: projectRevision,
      };
    }
    calibration.updatedAt = at;
  }
}

function assertOpticalVerificationNodeAvailable(state, nodeId, operation) {
  const active = activeOpticalVerificationForNode(state, nodeId);
  if (!active) return;
  throw conflict(
    `Node ${nodeId} is reserved by optical verification ${active.opticalVerification.verificationId}`,
    "camera_optical_verification_busy",
    {
      nodeId,
      sessionId: active.sessionId,
      verificationId: active.opticalVerification.verificationId,
      operation,
    },
  );
}

function mirrorOpticalRuntime(wrapper, runtime, extras = {}) {
  return {
    ...wrapper,
    ...extras,
    state: runtime.state,
    verificationId: runtime.verificationId,
    appliedRevision: runtime.appliedRevision,
    progress: runtime.progress,
    operatorPrompt: runtime.operatorPrompt,
    failure: runtime.failure,
    report: runtime.report,
    rollback: runtime.rollback,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    completedAt: runtime.completedAt,
    runtime,
  };
}

function assertServerBoundOpticalConfirmations(wrapper, runtime, nodeAckSequence) {
  const confirmations = runtime?.report?.confirmations;
  if (confirmations == null) return;
  const commands = wrapper?.confirmationCommands;
  if (!Array.isArray(commands) || commands.length !== confirmations.length) {
    throw conflict(
      "Terminal optical evidence is not backed by every Server-issued physical confirmation",
      "camera_optical_verification_confirmation_evidence_mismatch",
    );
  }
  for (let index = 0; index < confirmations.length; index += 1) {
    const reported = confirmations[index];
    const issued = commands[index];
    if (issued?.type !== COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION
      || issued.id !== reported.serverCommandId
      || issued.sequence !== reported.serverCommandSequence
      || issued.confirmationId !== reported.confirmationId
      || issued.confirmationLeaseId !== reported.confirmationLeaseId
      || issued.stepId !== reported.firstStepId
      || issued.confirmedAt !== reported.confirmedAt) {
      throw conflict(
        "Terminal optical confirmation evidence differs from the authoritative Server command history",
        "camera_optical_verification_confirmation_evidence_mismatch",
      );
    }
  }
  const highestConfirmationSequence = commands.reduce(
    (highest, command) => Math.max(highest, Number(command.sequence) || 0),
    0,
  );
  if (Number(nodeAckSequence ?? 0) < highestConfirmationSequence) {
    throw conflict(
      "Terminal optical evidence arrived before every physical confirmation command was acknowledged",
      "camera_optical_verification_confirmation_not_acknowledged",
      {
        ackSequence: Number(nodeAckSequence ?? 0),
        requiredAckSequence: highestConfirmationSequence,
      },
    );
  }
}

function plannedCameraConfirmationLeases(plan) {
  const leases = new Map();
  for (const step of plan?.steps || []) {
    if (step?.requiresOperatorConfirmation !== true) continue;
    const leaseId = String(step.confirmationLeaseId || "");
    if (!leaseId) {
      throw conflict(
        "Camera calibration operator step is missing its immutable confirmation lease",
        "camera_calibration_confirmation_evidence_mismatch",
      );
    }
    if (!leases.has(leaseId)) leases.set(leaseId, step);
  }
  return [...leases.entries()].map(([confirmationLeaseId, firstStep]) => ({
    confirmationLeaseId,
    firstStepId: firstStep.id,
  }));
}

function measuredCameraConfirmationEvidence(manifest, plan) {
  const captures = manifest?.captureProvenance?.captures;
  if (!Array.isArray(captures)) return [];
  return plannedCameraConfirmationLeases(plan).map(({ confirmationLeaseId, firstStepId }) => {
    const matching = captures.filter((capture) => (
      capture.conditionVerification?.confirmationLeaseId === confirmationLeaseId
    ));
    const confirmationIds = new Set(matching.map((capture) => (
      capture.conditionVerification?.confirmationId
    )));
    const confirmedAts = new Set(matching.map((capture) => (
      capture.conditionVerification?.verifiedAt
    )));
    if (matching.length === 0 || confirmationIds.size !== 1 || confirmedAts.size !== 1
      || ![...confirmationIds][0] || ![...confirmedAts][0]) {
      throw conflict(
        "Measured camera evidence is not backed by one exact confirmation per physical-condition lease",
        "camera_calibration_confirmation_evidence_mismatch",
        { confirmationLeaseId },
      );
    }
    return {
      confirmationLeaseId,
      firstStepId,
      confirmationId: [...confirmationIds][0],
      confirmedAt: [...confirmedAts][0],
    };
  });
}

function assertServerBoundCameraConfirmations(calibration, nodeAckSequence) {
  if (calibration?.manifest?.applicable !== true) return;
  const evidence = measuredCameraConfirmationEvidence(calibration.manifest, calibration.plan);
  const commands = calibration.confirmationCommands;
  if (!Array.isArray(commands) || commands.length !== evidence.length) {
    throw conflict(
      "Measured camera evidence is not backed by every Server-issued physical confirmation",
      "camera_calibration_confirmation_evidence_mismatch",
    );
  }
  for (let index = 0; index < evidence.length; index += 1) {
    const reported = evidence[index];
    const issued = commands[index];
    if (issued?.type !== COMMAND.CONFIRM_CAMERA_CALIBRATION
      || issued.confirmationId !== reported.confirmationId
      || issued.confirmationLeaseId !== reported.confirmationLeaseId
      || issued.stepId !== reported.firstStepId
      || issued.confirmedAt !== reported.confirmedAt) {
      throw conflict(
        "Measured camera confirmation evidence differs from the authoritative Server command history",
        "camera_calibration_confirmation_evidence_mismatch",
      );
    }
  }
  const highestConfirmationSequence = commands.reduce(
    (highest, command) => Math.max(highest, Number(command.sequence) || 0),
    0,
  );
  if (Number(nodeAckSequence ?? 0) < highestConfirmationSequence) {
    throw conflict(
      "Measured camera evidence arrived before every physical confirmation command was acknowledged",
      "camera_calibration_confirmation_not_acknowledged",
      {
        ackSequence: Number(nodeAckSequence ?? 0),
        requiredAckSequence: highestConfirmationSequence,
      },
    );
  }
}

function observedCalibrationRendererCorrectionBinding(calibration, renderer) {
  if (renderer?.correctionBindingMatches !== true
    || renderer?.activeCorrectionBinding == null
    || renderer?.activeCorrectionFingerprint !== renderer.activeCorrectionBinding?.fingerprint) return null;
  let binding;
  try {
    binding = normalizeRendererCorrectionBinding(
      renderer.activeCorrectionBinding,
      "telemetry.renderer.activeCorrectionBinding",
    );
  } catch {
    return null;
  }
  const manifestOutputs = new Map(
    (calibration?.manifest?.outputs || []).map((output) => [output.outputId, output]),
  );
  const bindingIndexes = new Map(binding.outputs.map((output, index) => [output.id, index]));
  let priorBindingIndex = -1;
  for (const output of calibration?.plan?.outputs || []) {
    const bindingIndex = bindingIndexes.get(output.id);
    const observed = bindingIndex == null ? null : binding.outputs[bindingIndex];
    const manifest = manifestOutputs.get(output.id);
    const expected = manifest?.artifacts;
    if (!observed || bindingIndex <= priorBindingIndex || observed.processingBypass !== false
      || observed.artifacts.blendMapSha256 !== expected?.blendWeight?.sha256
      || observed.artifacts.blackMapSha256 !== expected?.blackPedestal?.sha256
      || observed.artifacts.maskSha256 !== expected?.mask?.sha256
      || observed.artifacts.colorLutSha256 !== expected?.lut?.sha256) return null;
    priorBindingIndex = bindingIndex;
  }
  return binding;
}

function cameraSurveyPreviewSummary(value) {
  if (!value) return null;
  const report = value.report == null ? null : {
    ...value.report,
    ...(value.report.artifact == null ? {} : {
      artifact: Object.fromEntries(
        Object.entries(value.report.artifact).filter(([key]) => key !== "dataBase64"),
      ),
    }),
  };
  return jsonSafe({
    ...value,
    report,
    artifactUrl: report?.status === "complete"
      ? `/v1/calibrations/camera/survey-previews/${encodeURIComponent(value.requestId)}/artifact`
      : null,
  });
}

function verifyCameraSurveyPreviewPng(bytes, frame) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 67
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || !bytes.subarray(bytes.length - PNG_IEND.length).equals(PNG_IEND)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
    || bytes.readUInt32BE(16) !== frame.width
    || bytes.readUInt32BE(20) !== frame.height
    || bytes[24] !== 8
    || bytes[25] !== 0
    || bytes[26] !== 0
    || bytes[27] !== 0
    || bytes[28] !== 0) {
    throw badRequest(
      "Survey-preview artifact is not the declared non-interlaced 8-bit grayscale PNG raster",
      "invalid_camera_survey_preview_artifact",
    );
  }
  const chunks = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw badRequest("Survey-preview PNG is truncated", "invalid_camera_survey_preview_artifact");
    }
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw badRequest("Survey-preview PNG chunk is oversized", "invalid_camera_survey_preview_artifact");
    }
    chunks.push({
      type: bytes.toString("ascii", offset + 4, offset + 8),
      length,
      dataOffset: offset + 8,
    });
    offset = end;
  }
  if (offset !== bytes.length
    || chunks.length !== 3
    || chunks[0].type !== "IHDR" || chunks[0].length !== 13
    || chunks[1].type !== "IDAT" || chunks[1].length < 1
    || chunks[2].type !== "IEND" || chunks[2].length !== 0) {
    throw badRequest(
      "Survey-preview PNG may contain only one IHDR, one IDAT and one IEND chunk",
      "invalid_camera_survey_preview_artifact",
    );
  }
  const expectedInflatedBytes = (frame.width + 1) * frame.height;
  let scanlines;
  try {
    scanlines = inflateSync(
      bytes.subarray(chunks[1].dataOffset, chunks[1].dataOffset + chunks[1].length),
      { maxOutputLength: expectedInflatedBytes },
    );
  } catch {
    throw badRequest("Survey-preview PNG deflate stream is invalid", "invalid_camera_survey_preview_artifact");
  }
  if (scanlines.byteLength !== expectedInflatedBytes) {
    throw badRequest("Survey-preview PNG raster length is invalid", "invalid_camera_survey_preview_artifact");
  }
  for (let row = 0; row < frame.height; row += 1) {
    if (scanlines[row * (frame.width + 1)] !== 0) {
      throw badRequest(
        "Survey-preview PNG must retain the encoder's non-spatial scanline filter",
        "invalid_camera_survey_preview_artifact",
      );
    }
  }
}

function verifiedCameraSurveyPreviewBytes(report) {
  if (report?.status !== "complete" || !report.artifact) {
    throw conflict("Survey-preview artifact is not ready", "camera_survey_preview_not_ready");
  }
  let bytes;
  try {
    bytes = Buffer.from(report.artifact.dataBase64, "base64");
  } catch {
    throw badRequest("Survey-preview artifact base64 is invalid", "invalid_camera_survey_preview_artifact");
  }
  if (bytes.toString("base64") !== report.artifact.dataBase64
    || bytes.byteLength !== report.artifact.byteLength
    || createHash("sha256").update(bytes).digest("hex") !== report.artifact.sha256) {
    throw badRequest(
      "Survey-preview artifact failed its canonical base64, size or SHA-256 check",
      "camera_survey_preview_hash_mismatch",
    );
  }
  verifyCameraSurveyPreviewPng(bytes, report.frame);
  return bytes;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function commandDeadLetterWireEvidence(record) {
  return {
    schemaVersion: record.schemaVersion,
    deadLetterId: record.deadLetterId,
    nodeId: record.nodeId,
    command: record.command,
    attempts: record.attempts,
    retryBudget: record.retryBudget,
    safetyCritical: record.safetyCritical,
    firstFailedAt: record.firstFailedAt,
    lastFailedAt: record.lastFailedAt,
    deadLetteredAt: record.deadLetteredAt,
    errors: record.errors,
    failClosed: record.failClosed,
  };
}

function sameCommandDeadLetter(left, right) {
  return sha256Json(commandDeadLetterWireEvidence(left)) === sha256Json(commandDeadLetterWireEvidence(right));
}

function latestIso(...values) {
  const milliseconds = values.reduce((maximum, value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
  }, 0);
  return new Date(milliseconds).toISOString();
}

function cameraCalibrationBundleId(value) {
  const normalized = String(value || "").trim().slice(0, 128);
  if (!normalized) throw badRequest("Camera calibration bundle id is required", "invalid_camera_calibration_bundle_id");
  return normalized;
}

function storedCameraCalibrationBundle(state, bundleIdInput) {
  const bundleId = cameraCalibrationBundleId(bundleIdInput);
  const record = state.cameraCalibrationBundles?.[bundleId];
  if (!record) throw notFound("Camera calibration bundle was not found", "camera_calibration_bundle_not_found");
  try {
    return { record, bundle: normalizeCameraCalibrationBundle(record.bundle), bundleId };
  } catch (error) {
    throw cameraCalibrationBundleHttpError(error);
  }
}

function cameraCalibrationBundleSessionIds(state) {
  const ids = new Set();
  for (const record of Object.values(state.cameraCalibrationBundles || {})) {
    for (const sessionId of Object.values(record?.memberSessions || {})) {
      if (sessionId) ids.add(String(sessionId));
    }
  }
  return ids;
}

function cameraCalibrationBundlePreviewIds(state) {
  const ids = new Set();
  for (const record of Object.values(state.cameraCalibrationBundles || {})) {
    const bundle = record?.bundle;
    for (const member of bundle?.members || []) {
      if (member?.preview?.id) ids.add(member.preview.id);
    }
    for (const adjacency of bundle?.physicalAdjacencies || []) {
      for (const observation of adjacency?.observations || []) {
        if (observation?.preview?.id) ids.add(observation.preview.id);
      }
    }
  }
  return ids;
}

function cameraCalibrationBundlePreApplyOutputs(state, calibration) {
  if (Array.isArray(calibration?.preApplyOutputs)) return calibration.preApplyOutputs;
  if (!calibration?.bundleId || !calibration?.bundleRollbackSnapshotId) return null;
  const record = state.cameraCalibrationBundles?.[calibration.bundleId];
  const snapshot = record?.rollbackSnapshot;
  if (!snapshot || snapshot.id !== calibration.bundleRollbackSnapshotId
    || Number(snapshot.projectRevision) !== Number(calibration.preApplyProjectRevision)
    || !Array.isArray(snapshot.outputs)) return null;
  const outputIds = new Set(calibration.outputIds || []);
  return snapshot.outputs.filter((output) => outputIds.has(output?.id));
}

function activeCameraCalibrationBundleCommit(state) {
  return Object.values(state.cameraCalibrationBundles || {}).find((record) => (
    record?.commit?.state === "awaiting-renderer-ack"
  ));
}

function cameraCalibrationBundleResponse(record, state, { summary = false } = {}) {
  let bundle;
  try {
    bundle = normalizeCameraCalibrationBundle(record.bundle);
  } catch (error) {
    throw cameraCalibrationBundleHttpError(error);
  }
  const currentRevision = Number(state.project?.revision);
  const committedRevision = record.commit?.projectRevision;
  const currentlyApplied = committedRevision != null
    && Number.isSafeInteger(Number(committedRevision))
    && state.project?.id === bundle.baseProject.id
    && currentRevision === Number(committedRevision);
  const members = bundle.members.map((member) => {
    const sessionId = record.memberSessions?.[member.memberId] ?? null;
    const calibration = sessionId ? state.cameraCalibrations?.[sessionId] : null;
    return {
      memberId: member.memberId,
      state: member.state,
      outputIds: member.outputIds,
      cameraViewId: member.cameraViewId,
      viewCaptureId: member.viewCaptureId,
      previewId: member.preview.id,
      sessionId,
      calibrationState: calibration?.state ?? null,
      manifestSha256: calibration?.manifestSha256 ?? null,
      projectPatchSha256: calibration?.projectPatchSha256 ?? null,
    };
  });
  const rollbackSnapshot = record.rollbackSnapshot == null ? null : {
    id: record.rollbackSnapshot.id,
    projectId: record.rollbackSnapshot.projectId,
    projectRevision: record.rollbackSnapshot.projectRevision,
    outputIds: record.rollbackSnapshot.outputIds,
    createdAt: record.rollbackSnapshot.createdAt,
  };
  const value = {
    bundleId: bundle.bundleId,
    aggregateState: bundle.aggregateState,
    currentlyApplied,
    currentProjectRevision: currentRevision,
    baseProject: bundle.baseProject,
    finalEvidence: bundle.finalEvidence,
    memberCount: bundle.members.length,
    members,
    commit: record.commit,
    rollbackSnapshot,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
  };
  return jsonSafe(summary ? value : { ...value, bundle });
}

function stageCameraCalibrationBundleMember(state, calibration, patch, at) {
  const { record, bundle } = storedCameraCalibrationBundle(state, calibration.bundleId);
  const member = bundle.members.find((candidate) => candidate.memberId === calibration.bundleMemberId);
  if (!member || record.memberSessions?.[member.memberId] !== calibration.sessionId) {
    throw conflict(
      "Camera calibration session is not the Server-bound bundle member session",
      "camera_calibration_bundle_member_session_mismatch",
    );
  }
  if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING) {
    throw conflict(
      `Bundle member ${member.memberId} is already ${member.state}`,
      "camera_calibration_bundle_member_finished",
    );
  }
  if (state.project?.id !== bundle.baseProject.id
    || Number(state.project?.revision) !== Number(bundle.baseProject.revision)) {
    throw conflict(
      "Project changed before the bundle member result could be staged",
      "camera_calibration_bundle_base_stale",
      { baseProject: bundle.baseProject, currentProjectRevision: state.project?.revision },
    );
  }
  const patchIds = patch.outputs.map((output) => output.id);
  if (JSON.stringify([...patchIds].sort()) !== JSON.stringify([...member.outputIds].sort())) {
    throw conflict(
      "Bundle member patch output ids differ from its immutable output assignment",
      "camera_calibration_bundle_member_outputs_mismatch",
    );
  }
  const manifestSha256 = sha256Json(calibration.manifest);
  const projectPatchSha256 = sha256Json(patch);
  const completedAt = calibration.manifest.completedAt;
  const eventAt = latestIso(at, completedAt, bundle.updatedAt);
  let nextBundle;
  try {
    nextBundle = reduceCameraCalibrationBundle(bundle, {
      type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_CALIBRATED,
      memberId: member.memberId,
      evidence: {
        sessionId: calibration.sessionId,
        manifestSha256,
        baseProjectRevision: bundle.baseProject.revision,
        completedAt,
      },
      at: eventAt,
    }, { currentProject: bundle.baseProject });
  } catch (error) {
    throw cameraCalibrationBundleHttpError(error);
  }
  calibration.projectPatch = patch;
  calibration.manifestSha256 = manifestSha256;
  calibration.projectPatchSha256 = projectPatchSha256;
  calibration.projectApplied = false;
  calibration.projectCommitted = false;
  calibration.currentlyApplied = false;
  calibration.opticalVerification = {
    state: "pending-bundle-commit",
    required: true,
    verifiedAt: null,
    reason: null,
  };
  calibration.updatedAt = eventAt;
  record.bundle = nextBundle;
  record.updatedAt = eventAt;
  return nextBundle;
}

function failCameraCalibrationBundleMember(state, calibration, failure, at) {
  if (!calibration?.bundleId || !calibration?.bundleMemberId) return;
  const { record, bundle } = storedCameraCalibrationBundle(state, calibration.bundleId);
  const member = bundle.members.find((candidate) => candidate.memberId === calibration.bundleMemberId);
  if (!member || member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING) return;
  if (state.project?.id !== bundle.baseProject.id
    || Number(state.project?.revision) !== Number(bundle.baseProject.revision)) {
    record.commit = {
      ...record.commit,
      state: "blocked",
      failure: {
        code: "CAMERA_CALIBRATION_BUNDLE_BASE_STALE",
        message: "The project changed before the failed bundle member could be recorded",
      },
    };
    record.updatedAt = at;
    return;
  }
  const failedAt = latestIso(at, bundle.updatedAt);
  const failureMessage = String(failure?.message || "Camera calibration member failed").trim()
    || "Camera calibration member failed";
  try {
    record.bundle = reduceCameraCalibrationBundle(bundle, {
      type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_FAILED,
      memberId: member.memberId,
      failure: {
        code: "CAMERA_CALIBRATION_MEMBER_FAILED",
        message: failureMessage.slice(0, 2_048),
        failedAt,
      },
      at: failedAt,
    }, { currentProject: bundle.baseProject });
  } catch (error) {
    throw cameraCalibrationBundleHttpError(error);
  }
  record.updatedAt = failedAt;
}

function acknowledgeCameraCalibrationBundleRenderer(state, at) {
  let changed = false;
  for (const record of Object.values(state.cameraCalibrationBundles || {})) {
    if (record?.commit?.state !== "awaiting-renderer-ack") continue;
    let bundle;
    try {
      bundle = normalizeCameraCalibrationBundle(record.bundle);
    } catch (error) {
      record.commit = {
        ...record.commit,
        state: "blocked",
        failure: {
          code: error?.code || "INVALID_CAMERA_CALIBRATION_BUNDLE",
          message: error?.message || "Persisted bundle is invalid",
        },
      };
      changed = true;
      continue;
    }
    if (state.project?.id !== bundle.baseProject.id
      || Number(state.project?.revision) !== Number(record.commit.projectRevision)) continue;
    const calibrations = bundle.members.map((member) => {
      const sessionId = record.memberSessions?.[member.memberId];
      return sessionId ? state.cameraCalibrations?.[sessionId] : null;
    });
    if (calibrations.some((calibration) => !calibration
      || calibration.state !== CAMERA_CALIBRATION_STATE.COMPLETE
      || calibration.rendererAcknowledged !== true
      || Number(calibration.appliedRevision) !== Number(record.commit.projectRevision)
      || calibration.rendererCorrectionBinding == null)) continue;
    const fingerprints = new Set(
      calibrations.map((calibration) => calibration.rendererCorrectionBinding.fingerprint),
    );
    if (fingerprints.size !== 1) {
      record.commit = {
        ...record.commit,
        state: "blocked",
        failure: {
          code: "CAMERA_CALIBRATION_BUNDLE_RENDERER_FINGERPRINT_MISMATCH",
          message: "Bundle members did not observe one exact renderer correction fingerprint",
        },
      };
      changed = true;
      continue;
    }
    const rendererCorrectionFingerprint = [...fingerprints][0];
    const acknowledgedAt = latestIso(
      at,
      bundle.updatedAt,
      ...calibrations.map((calibration) => calibration.rendererAcknowledgedAt),
    );
    try {
      record.bundle = reduceCameraCalibrationBundle(bundle, {
        type: CAMERA_CALIBRATION_BUNDLE_EVENT.FINAL_RENDERER_ACKNOWLEDGED,
        evidence: {
          commitId: record.commit.commitId,
          projectRevision: record.commit.projectRevision,
          rendererCorrectionFingerprint,
          acknowledgedAt,
        },
        at: acknowledgedAt,
      }, {
        currentProject: { id: bundle.baseProject.id, revision: record.commit.projectRevision },
      });
      record.commit = {
        ...record.commit,
        state: "renderer-acknowledged",
        rendererCorrectionFingerprint,
        rendererAcknowledgedAt: acknowledgedAt,
        failure: null,
      };
      record.updatedAt = acknowledgedAt;
      changed = true;
    } catch (error) {
      record.commit = {
        ...record.commit,
        state: "blocked",
        failure: {
          code: error?.code || "CAMERA_CALIBRATION_BUNDLE_RENDERER_ACK_FAILED",
          message: error?.message || "Bundle renderer evidence was rejected",
        },
      };
      changed = true;
    }
  }
  return changed;
}

function projectOutputsForNode(state, nodeId, requireExplicitOutputOwnership = false) {
  const project = state.project;
  const node = state.nodes[nodeId];
  const capabilities = new Set((node?.capabilities?.outputs || []).flatMap((output) => [
    String(output?.id || ""),
    String(output?.connector || ""),
  ]).filter(Boolean));
  return project.outputs.filter((output) => (
    output.nodeId === nodeId
    || (!requireExplicitOutputOwnership
      && !output.nodeId
      && (capabilities.has(output.id) || capabilities.has(output.connector)))
  ));
}

function projectForNode(state, nodeId, requireExplicitOutputOwnership = false) {
  const project = state.project;
  const outputs = projectOutputsForNode(state, nodeId, requireExplicitOutputOwnership);
  const outputIds = new Set(outputs.map((output) => output.id));
  return {
    ...project,
    outputs,
    timeline: {
      ...project.timeline,
      cues: (project.timeline?.cues || []).flatMap((cue) => {
        const targetedOutputIds = cue.outputIds || [];
        if (targetedOutputIds.length === 0) {
          return (!requireExplicitOutputOwnership || outputs.length > 0)
            ? [{ ...cue, outputIds: [] }]
            : [];
        }
        const scopedOutputIds = targetedOutputIds.filter((id) => outputIds.has(id));
        return scopedOutputIds.length > 0 ? [{ ...cue, outputIds: scopedOutputIds }] : [];
      }),
    },
  };
}

function queueCommand(state, nodeId, type, payload, { effectiveAtNs = null } = {}) {
  const queue = state.commandQueues[nodeId] ?? (state.commandQueues[nodeId] = []);
  if (type === COMMAND.SYNC_PROJECT) {
    // A sync-project command is a complete authoritative snapshot. Keeping
    // consecutive older snapshots cannot add information, but a snapshot
    // separated from a later command is an ordering dependency for that
    // command. Only coalesce the contiguous trailing run; removing snapshots
    // across an intervening calibration/action could execute that command
    // against a stale local project before the replacement snapshot arrives.
    while (queue.at(-1)?.type === COMMAND.SYNC_PROJECT) queue.pop();
  }
  if (TIMELINE_DEAD_LETTER_TYPES.has(type)) {
    const retainedTimelineAuthority = Object.values(state.commandQueues)
      .reduce((count, commands) => count + commands.filter((command) => (
        TIMELINE_DEAD_LETTER_TYPES.has(command.type)
      )).length, 0);
    if (retainedTimelineAuthority >= 8_192) {
      throw conflict(
        "Outstanding timeline command authority reached its bounded fail-closed audit capacity",
        "timeline_command_authority_capacity",
        { capacity: 8_192 },
      );
    }
  }
  if (queue.length >= MAX_QUEUE_LENGTH) {
    throw conflict(
      `Command queue for ${nodeId} reached its ${MAX_QUEUE_LENGTH} entry safety limit`,
      "command_queue_capacity",
      { nodeId, capacity: MAX_QUEUE_LENGTH },
    );
  }
  const sequence = state.nextCommandSequence;
  if (!Number.isSafeInteger(sequence)) throw new Error("Command sequence exhausted");
  state.nextCommandSequence += 1;
  const command = createCommand(type, payload, {
    sequence,
    createdAtNs: epochNowNs().toString(),
    effectiveAtNs: effectiveAtNs == null ? null : String(effectiveAtNs),
  });
  if (type === COMMAND.HOST_ACTION && payload?.action) command.action = payload.action;
  queue.push(command);
  if (state.nodes[nodeId]) state.nodes[nodeId].commandSequence = sequence;
  return command;
}

function trimAudit(state, maxLength) {
  const excess = state.actionAudit.length - maxLength;
  if (excess <= 0) return;
  const removableIndexes = [];
  for (const [index, audit] of state.actionAudit.entries()) {
    const stillQueued = audit.commandId != null && (state.commandQueues[audit.nodeId] || []).some((command) => (
      command.id === audit.commandId && command.sequence === audit.commandSequence
    ));
    if (audit.status !== "queued" && !stillQueued) removableIndexes.push(index);
    if (removableIndexes.length === excess) break;
  }
  if (removableIndexes.length !== excess) {
    throw conflict(
      "Host-action audit capacity is exhausted by pending commands",
      "host_action_audit_capacity",
      { capacity: maxLength },
    );
  }
  const removable = new Set(removableIndexes);
  const removed = state.actionAudit.filter((_audit, index) => removable.has(index));
  state.actionAudit = state.actionAudit.filter((_audit, index) => !removable.has(index));
  const affectedNodeIds = new Set();
  for (const audit of removed) {
    affectedNodeIds.add(audit.nodeId);
    for (const resultId of audit.resultIds || []) delete state.processedActionResults?.[resultId];
  }
  for (const nodeId of affectedNodeIds) {
    const latest = Object.values(state.processedActionResults || {})
      .filter((processed) => processed.nodeId === nodeId)
      .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
      .at(-1);
    state.nodes[nodeId].lastActionResult = latest == null
      ? null
      : {
        actionType: latest.result.actionType,
        commandId: latest.result.commandId,
        ...actionResultSummary(latest.result),
      };
  }
}

function hostActionResultMatchesCommand(result, command) {
  const action = command?.payload?.action || command?.action;
  return result != null
    && command?.type === COMMAND.HOST_ACTION
    && result.commandId === command.id
    && result.sequence === command.sequence
    && result.actionId === action?.id
    && result.actionType === action?.type;
}

function hostActionHasTerminalEvidence(state, nodeId, command) {
  const audit = [...(state.actionAudit || [])].reverse().find((entry) => (
    entry.nodeId === nodeId
    && entry.commandId === command.id
    && entry.commandSequence === command.sequence
  ));
  if (!audit || audit.status === "queued" || !Array.isArray(audit.resultIds)
    || audit.resultIds.length !== 1) return false;
  const processed = state.processedActionResults?.[audit.resultIds[0]];
  return processed?.nodeId === nodeId
    && processed.auditId === audit.id
    && hostActionResultMatchesCommand(processed.result, command);
}

function assertHostActionAckEvidence(state, nodeId, currentAck, requestedAck, actionResults) {
  if (requestedAck == null || requestedAck <= currentAck) return;
  const submittedByCommand = new Map(actionResults.map((result) => [
    `${result.commandId}\0${result.sequence}`,
    result,
  ]));
  for (const command of state.commandQueues[nodeId] || []) {
    if (command.sequence <= currentAck || command.sequence > requestedAck
      || command.type !== COMMAND.HOST_ACTION) continue;
    const submitted = submittedByCommand.get(`${command.id}\0${command.sequence}`);
    if (hostActionResultMatchesCommand(submitted, command)
      || hostActionHasTerminalEvidence(state, nodeId, command)) continue;
    throw conflict(
      "ackSequence cannot advance across a host action without durable terminal result evidence",
      "host_action_ack_result_required",
      { commandId: command.id, sequence: command.sequence },
    );
  }
}

const TIMELINE_DEAD_LETTER_TYPES = new Set([
  COMMAND.SYNC_PROJECT,
  COMMAND.PREPARE,
  COMMAND.PLAY_AT,
  COMMAND.PAUSE_AT,
  COMMAND.SEEK_AT,
  COMMAND.STOP,
]);

function commandReference(nodeId, command) {
  return { nodeId, id: command.id, sequence: command.sequence, type: command.type };
}

function deadLetterFailure(retained) {
  return {
    code: "COMMAND_DEAD_LETTERED",
    message: `Command ${retained.command.sequence} (${retained.command.type}) exhausted its retry budget`,
    details: { deadLetterId: retained.deadLetterId },
  };
}

function terminalizeDeadLetterOwner(state, nodeId, queued, retained) {
  const at = retained.receivedAt;
  if (queued.type === COMMAND.HOST_ACTION) {
    const audit = (state.actionAudit || []).find((entry) => (
      entry.nodeId === nodeId
      && entry.commandId === queued.id
      && entry.commandSequence === queued.sequence
    ));
    if (!audit || audit.status !== "queued") {
      throw conflict(
        "Dead-lettered host action has no queued authoritative audit owner",
        "command_dead_letter_owner_mismatch",
      );
    }
    audit.status = "dead-lettered";
    audit.deadLetterId = retained.deadLetterId;
    audit.deadLetteredAt = at;
    audit.updatedAt = at;
    return { kind: "host-action", id: audit.id, state: "dead-lettered" };
  }

  if (queued.type === COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW) {
    const preview = Object.values(state.cameraSurveyPreviews || {}).find((candidate) => (
      candidate.nodeId === nodeId
      && candidate.command?.id === queued.id
      && candidate.command?.sequence === queued.sequence
    ));
    if (!preview) {
      throw conflict(
        "Dead-lettered survey preview has no pending authoritative owner",
        "command_dead_letter_owner_mismatch",
      );
    }
    if (preview.report != null && ["complete", "failed"].includes(preview.status)) {
      // Completion may already be durable while its HTTP response was lost.
      // Preserve the exact authenticated terminal report and bind the later
      // command dead letter as ambiguous-success audit evidence.
      return { kind: "camera-survey-preview", id: preview.requestId, state: preview.status };
    }
    preview.report = normalizeCameraSurveyPreviewReport({
      schemaVersion: 1,
      requestId: preview.requestId,
      nodeId,
      cameraViewId: preview.cameraViewId,
      lensProfileSha256: preview.lensProfileSha256,
      status: "failed",
      completedAt: at,
      error: {
        code: "COMMAND_DEAD_LETTERED",
        message: `Survey preview command exhausted its retry budget (${retained.deadLetterId})`,
      },
    }, preview.request);
    preview.status = "failed";
    preview.authenticatedAt = at;
    preview.failure = preview.report.error;
    preview.updatedAt = at;
    return { kind: "camera-survey-preview", id: preview.requestId, state: "failed" };
  }

  if ([
    COMMAND.START_CAMERA_CALIBRATION,
    COMMAND.CONFIRM_CAMERA_CALIBRATION,
    COMMAND.CANCEL_CAMERA_CALIBRATION,
  ].includes(queued.type)) {
    const sessionId = queued.type === COMMAND.START_CAMERA_CALIBRATION
      ? queued.payload?.plan?.sessionId
      : queued.payload?.sessionId;
    const calibration = state.cameraCalibrations?.[sessionId];
    if (!calibration || calibration.nodeId !== nodeId || TERMINAL_CALIBRATION_STATES.has(calibration.state)) {
      throw conflict(
        "Dead-lettered camera command has no active authoritative calibration owner",
        "command_dead_letter_owner_mismatch",
      );
    }
    const failure = deadLetterFailure(retained);
    calibration.state = CAMERA_CALIBRATION_STATE.FAILED;
    calibration.failure = failure;
    calibration.operatorPrompt = null;
    calibration.updatedAt = at;
    calibration.completedAt = at;
    failCameraCalibrationBundleMember(state, calibration, failure, at);
    return { kind: "camera-calibration", id: calibration.sessionId, state: calibration.state };
  }

  if ([
    COMMAND.START_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK,
  ].includes(queued.type)) {
    const sessionId = queued.type === COMMAND.START_CAMERA_OPTICAL_VERIFICATION
      ? queued.payload?.plan?.calibrationSessionId
      : queued.type === COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION
        ? queued.payload?.calibrationSessionId
        : queued.type === COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK
          ? queued.payload?.calibrationSessionId
          : Object.values(state.cameraCalibrations || {}).find((candidate) => (
            candidate.nodeId === nodeId
            && candidate.opticalVerification?.plan?.verificationId === queued.payload?.verificationId
          ))?.sessionId;
    const calibration = state.cameraCalibrations?.[sessionId];
    const wrapper = calibration?.opticalVerification;
    const plan = wrapper?.plan;
    const runtime = wrapper?.runtime;
    if (!calibration || calibration.nodeId !== nodeId || !plan || !runtime) {
      throw conflict(
        "Dead-lettered optical command has no active authoritative verification owner",
        "command_dead_letter_owner_mismatch",
      );
    }
    const failure = deadLetterFailure(retained);
    let blockedInput;
    if (queued.type === COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK) {
      if (runtime.rollback == null) {
        throw conflict(
          "Dead-lettered rollback restore has no authoritative rollback owner",
          "command_dead_letter_owner_mismatch",
        );
      }
      blockedInput = {
        ...runtime,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
        updatedAt: at,
        failure: runtime.failure ?? failure,
        rollback: {
          ...runtime.rollback,
          state: "blocked",
          reason: failure.message,
          restoredAt: null,
        },
        operatorPrompt: null,
      };
    } else {
      blockedInput = {
        ...runtime,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
        progress: {
          ...runtime.progress,
          currentStepId: null,
          currentStepIndex: null,
        },
        updatedAt: at,
        completedAt: null,
        failure,
        report: null,
        rollback: null,
        operatorPrompt: null,
      };
    }
    let blocked;
    try {
      blocked = normalizeCameraOpticalVerificationState(blockedInput, { plan });
    } catch (error) {
      throw conflict(
        `Dead-lettered optical owner could not enter fail-closed state: ${error.message}`,
        "command_dead_letter_owner_mismatch",
      );
    }
    calibration.opticalVerification = mirrorOpticalRuntime(wrapper, blocked, {
      reason: "command-dead-lettered",
      verifiedAt: null,
    });
    calibration.updatedAt = at;
    return {
      kind: "camera-optical-verification",
      id: blocked.verificationId,
      state: blocked.state,
    };
  }
  return null;
}

function activateEmergencyFailClosedFence(state, targetNodeId, sourceNodeId, retained) {
  const target = state.nodes[targetNodeId];
  const generation = Number(target.failClosedGeneration ?? 0) + 1;
  const fence = {
    status: "active",
    generation,
    deadLetterId: retained.deadLetterId,
    activatedAt: retained.receivedAt,
    // A response carrying the previous generation may already be in flight.
    // No prior lease can outlive this conservative fixed-TTL boundary; new
    // leases stop immediately because the active fence is persisted below.
    effectiveAtNs: (() => {
      const activatedAtNs = epochNowNs();
      const maxIssuedLeaseExpiresAtNs = BigInt(target.maxIssuedLeaseExpiresAtNs ?? "0");
      // Lease issuance is serialized and tracked in authoritative RAM, but a
      // steady heartbeat must not rewrite a multi-megabyte project merely to
      // renew this five-second safety horizon. A Server crash can therefore
      // lose only the in-memory maximum. Draining one complete maximum TTL
      // from the post-restart fence activation conservatively covers every
      // pre-crash response which could still be in flight.
      const crashSafeDrainAtNs = activatedAtNs + BigInt(MAX_EXECUTION_LEASE_TTL_MS) * 1_000_000n;
      return (maxIssuedLeaseExpiresAtNs > crashSafeDrainAtNs
        ? maxIssuedLeaseExpiresAtNs
        : crashSafeDrainAtNs).toString();
    })(),
    sourceCommand: {
      nodeId: sourceNodeId,
      id: retained.command.id,
      sequence: retained.command.sequence,
      type: retained.command.type,
    },
  };
  target.failClosedGeneration = generation;
  target.failClosedFence = fence;
  return { nodeId: targetNodeId, generation, effectiveAtNs: fence.effectiveAtNs };
}

function compensateTimelineDeadLetter(state, nodeId, queued, retained) {
  if (!TIMELINE_DEAD_LETTER_TYPES.has(queued.type)) {
    return {
      timelineInvalidated: false,
      targetNodeIds: [],
      supersededCommands: [],
      commands: [],
      fences: [],
      inheritedFrom: null,
    };
  }
  const targetNodeIds = Array.from(new Set(
    state.timeline?.targetNodeIds?.length > 0 ? state.timeline.targetNodeIds : [nodeId],
  ));
  const supersededCommands = [];
  for (const targetNodeId of targetNodeIds) {
    const queue = state.commandQueues[targetNodeId] || [];
    const retainedQueue = [];
    for (const command of queue) {
      if (TIMELINE_DEAD_LETTER_TYPES.has(command.type)) {
        supersededCommands.push(commandReference(targetNodeId, command));
      } else {
        retainedQueue.push(command);
      }
    }
    state.commandQueues[targetNodeId] = retainedQueue;
  }
  // queueCommand bounds retained timeline authority before publication, so an
  // emergency fence can never be blocked by compensation-audit capacity.
  invalidatePreparedTimeline(state);
  const fences = targetNodeIds.map((targetNodeId) => (
    activateEmergencyFailClosedFence(state, targetNodeId, nodeId, retained)
  ));
  return {
    timelineInvalidated: true,
    targetNodeIds,
    supersededCommands,
    commands: [],
    fences,
    inheritedFrom: null,
  };
}

function selectedNodes(state, requested) {
  if (requested == null) return Object.keys(state.nodes);
  if (!Array.isArray(requested)) throw badRequest("nodeIds must be an array", "invalid_node_ids");
  const ids = Array.from(new Set(requested.map(validateNodeId)));
  if (ids.length === 0) throw badRequest("nodeIds must not be empty", "empty_node_ids");
  for (const id of ids) {
    if (!state.nodes[id]) throw notFound(`Node ${id} is not registered`, "node_not_found");
  }
  return ids;
}

function prepareTargetNodes(state, requested, requireExplicitOutputOwnership) {
  const selected = selectedNodes(state, requested);
  if (!requireExplicitOutputOwnership) return selected;
  const owned = selected.filter((nodeId) => (
    projectOutputsForNode(state, nodeId, true).length > 0
  ));
  if (requested != null && owned.length !== selected.length) {
    const unassignedNodeIds = selected.filter((nodeId) => !owned.includes(nodeId));
    throw conflict(
      "Secured PREPARE targets must own at least one explicitly assigned project output",
      "timeline_target_output_ownership_required",
      { unassignedNodeIds },
    );
  }
  return owned;
}

function timelineNodes(state, requested, operation) {
  const current = Array.isArray(state.timeline?.targetNodeIds) ? state.timeline.targetNodeIds : [];
  if (current.length === 0) {
    throw conflict(
      `Cannot ${operation} before PREPARE establishes the authoritative timeline node set`,
      "timeline_target_nodes_required",
    );
  }
  const ids = requested == null ? selectedNodes(state, current) : selectedNodes(state, requested);
  const expected = [...new Set(current)].sort();
  const actual = [...ids].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw conflict(
      `${operation} must target the complete authoritative timeline node set`,
      "timeline_target_nodes_mismatch",
      { expectedNodeIds: expected, requestedNodeIds: actual, operation },
    );
  }
  return ids;
}

function timelineFrameAt(timeline, atNs) {
  const baseFrame = frameValue(timeline.baseFrame, 0n);
  if (!timeline.playAtNs) return baseFrame;
  const instant = BigInt(atNs);
  const playAt = BigInt(timeline.playAtNs);
  if (instant < playAt) return baseFrame;
  if (timeline.pauseAtNs && instant >= BigInt(timeline.pauseAtNs)) {
    return frameValue(timeline.pauseFrame, baseFrame);
  }
  return baseFrame + frameAtTime(instant, playAt, timeline.frameRateNum, timeline.frameRateDen);
}

function invalidatePreparedTimeline(state, atNs = epochNowNs()) {
  state.timeline = {
    ...state.timeline,
    status: "idle",
    baseFrame: "0",
    playAtNs: null,
    pauseAtNs: null,
    pauseFrame: null,
    preparedAssetSha256: null,
    targetNodeIds: [],
    prepareSequences: {},
    frameRateNum: state.project.canvas.frameRateNum,
    frameRateDen: state.project.canvas.frameRateDen,
    updatedAtNs: atNs.toString(),
  };
}

function timelineSnapshot(timeline, nowNs = epochNowNs()) {
  const now = BigInt(nowNs);
  let status = timeline.status;
  if (timeline.pauseAtNs) {
    status = now >= BigInt(timeline.pauseAtNs) ? "paused" : "pause-scheduled";
  } else if (timeline.playAtNs) {
    status = now >= BigInt(timeline.playAtNs) ? "playing" : "scheduled";
  }
  return {
    ...timeline,
    status,
    state: status,
    playing: status === "playing" || status === "scheduled" || status === "pause-scheduled",
    currentFrame: timelineFrameAt(timeline, now).toString(),
  };
}

export class ControlPlane {
  constructor(store, {
    offlineAfterMs = 5_000,
    allowPowerActions = false,
    powerActionToken = null,
    maxActionAudit = 10_000,
    requireExplicitOutputOwnership = false,
    executionLeaseTtlMs = MAX_EXECUTION_LEASE_TTL_MS,
  } = {}) {
    this.store = store;
    this.offlineAfterMs = offlineAfterMs;
    this.allowPowerActions = Boolean(allowPowerActions);
    this.powerActionToken = powerActionToken ? String(powerActionToken) : null;
    this.maxActionAudit = Math.max(100, Math.min(100_000, Number(maxActionAudit) || 10_000));
    this.requireExplicitOutputOwnership = Boolean(requireExplicitOutputOwnership);
    this.executionLeaseTtlMs = Math.max(
      50,
      Math.min(MAX_EXECUTION_LEASE_TTL_MS, Number(executionLeaseTtlMs) || MAX_EXECUTION_LEASE_TTL_MS),
    );
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.closed = false;
    this.startedAtNs = epochNowNs();
    this.offlineAfterNs = BigInt(Math.max(1, Math.trunc(Number(this.offlineAfterMs)))) * 1_000_000n;
    // Liveness is deliberately process-local. Persisted wall-clock heartbeat
    // timestamps remain diagnostics only and can never make a node READY
    // after a Server restart or clock jump before fresh authenticated traffic.
    this.liveNodeSeenNs = new Map();
  }

  #nodeIsLive(nodeId) {
    const seenAt = this.liveNodeSeenNs.get(nodeId);
    return typeof seenAt === "bigint"
      && process.hrtime.bigint() - seenAt <= this.offlineAfterNs;
  }

  health() {
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    return {
      ok: !this.closed && serverStateRecovery == null,
      service: "pixel-brightness-server",
      protocolVersion: PROTOCOL_VERSION,
      version: SOFTWARE_VERSION,
      features: {
        hostActions: true,
        powerActions: this.allowPowerActions,
      },
      serverStateRecovery,
      serverTimeNs: epochNowNs().toString(),
      uptimeNs: (epochNowNs() - this.startedAtNs).toString(),
    };
  }

  time() {
    return { protocolVersion: PROTOCOL_VERSION, serverTimeNs: epochNowNs().toString() };
  }

  stateSummary({ includeCalibrationPatch = false } = {}) {
    const state = this.store.state;
    const nodes = Object.values(state.nodes).map((node) => {
      const stale = !this.#nodeIsLive(node.nodeId);
      return {
        ...node,
        status: stale ? NODE_STATUS.OFFLINE : node.status,
        readiness: this.nodeReadiness(node.nodeId),
      };
    });
    const timelineReadiness = this.readinessSnapshot(state.timeline);
    const latestCalibration = state.latestCameraCalibrationId
      ? state.cameraCalibrations?.[state.latestCameraCalibrationId] ?? null
      : null;
    const cameraCalibration = latestCalibration && !includeCalibrationPatch
      ? Object.fromEntries(Object.entries(latestCalibration).filter(([key]) => (
        key !== "projectPatch" && key !== "preApplyOutputs"
      )))
      : latestCalibration;
    return jsonSafe({
      protocolVersion: PROTOCOL_VERSION,
      version: SOFTWARE_VERSION,
      server: this.health(),
      projectRevision: state.project.revision,
      timeline: {
        ...timelineSnapshot(state.timeline),
        readiness: timelineReadiness,
      },
      nodes,
      media: Object.values(state.media),
      commandSequence: state.nextCommandSequence - 1,
      fleet: {
        powerActionsEnabled: this.allowPowerActions,
        actionAuditCount: state.actionAudit.length,
        commandDeadLetterCount: Object.values(state.commandDeadLetters || {})
          .reduce((count, records) => count + (Array.isArray(records) ? records.length : 0), 0),
        warnings: timelineReadiness.warnings,
      },
      cameraCalibration,
    });
  }

  stateSnapshot() {
    const summary = this.stateSummary({ includeCalibrationPatch: true });
    return { ...summary, project: jsonSafe(this.store.state.project) };
  }

  nodeReadiness(nodeIdInput) {
    const nodeId = validateNodeId(nodeIdInput);
    const state = this.store.state;
    const node = state.nodes[nodeId];
    if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    const active = this.#nodeIsLive(nodeId);
    const commandFailureSafetyLock = node.commandFailureSafetyLock?.status === "active"
      ? node.commandFailureSafetyLock
      : node.telemetry?.commandFailureSafetyLock?.status === "active"
        ? node.telemetry.commandFailureSafetyLock
        : null;
    const stateRecoverySafetyLock = node.telemetry?.stateRecoverySafetyLock?.status === "active"
      ? node.telemetry.stateRecoverySafetyLock
      : null;
    const opticalVerificationFailClosed = node.telemetry?.cameraOpticalVerificationFailClosed === true;
    const serverFailClosedFence = node.failClosedFence?.status === "active"
      ? node.failClosedFence
      : null;
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    const faults = [
      ...deriveHostFaults(node.host, { node, project: state.project }),
      ...(commandFailureSafetyLock ? [{
        code: "COMMAND_DEAD_LETTER_SAFETY_LOCK",
        severity: "critical",
        subsystem: "renderer",
        message: `Safety command ${commandFailureSafetyLock.command?.sequence ?? "unknown"} failed; sticky black requires operator recovery`,
      }] : []),
      ...(stateRecoverySafetyLock ? [{
        code: "NODE_STATE_RECOVERY_SAFETY_LOCK",
        severity: "critical",
        subsystem: "renderer",
        message: "Node recovered from an older state generation; sticky black requires operator reconciliation",
      }] : []),
      ...(opticalVerificationFailClosed ? [{
        code: "CAMERA_OPTICAL_VERIFICATION_FAIL_CLOSED",
        severity: "critical",
        subsystem: "renderer",
        message: "Optical verification retains sticky black until exact rollback restore",
      }] : []),
      ...(serverFailClosedFence ? [{
        code: "SERVER_FAIL_CLOSED_FENCE_ACTIVE",
        severity: "critical",
        subsystem: "renderer",
        message: `Server fail-closed fence generation ${serverFailClosedFence.generation} is active`,
      }] : []),
      ...(serverStateRecovery ? [{
        code: "SERVER_STATE_RECOVERY_REQUIRED",
        severity: "critical",
        subsystem: "renderer",
        message: `Server restored older state under recovery generation ${serverStateRecovery.generation}; operator reconciliation is required`,
      }] : []),
    ];
    const blockingFaults = faults.filter((fault) => fault.severity === "error" || fault.severity === "critical");
    return {
      ready: active
        && [NODE_STATUS.READY, NODE_STATUS.PLAYING, NODE_STATUS.PAUSED].includes(node.status)
        && blockingFaults.length === 0,
      active,
      faults,
      blockingFaults: blockingFaults.length,
      driverFaults: faults.filter((fault) => fault.subsystem === "driver").length,
      displayFaults: faults.filter((fault) => fault.subsystem === "display").length,
    };
  }

  readinessSnapshot(timelineInput = this.store.state.timeline) {
    const state = this.store.state;
    const timeline = timelineInput ?? state.timeline;
    const requiredNodes = Array.isArray(timeline.targetNodeIds) ? timeline.targetNodeIds : [];
    const prepareSequences = timeline.prepareSequences ?? {};
    const readyNodes = [];
    const pendingNodes = [];
    const warningNodeIds = requiredNodes.length > 0 ? requiredNodes : Object.keys(state.nodes);
    const warnings = warningNodeIds.flatMap((nodeId) => {
      const node = state.nodes[nodeId];
      if (!node) return [];
      return this.nodeReadiness(nodeId).faults
        .map((fault) => ({ nodeId, ...fault }));
    });
    for (const nodeId of requiredNodes) {
      const node = state.nodes[nodeId];
      const requiredSequence = Number(prepareSequences[nodeId] ?? 0);
      const acknowledged = requiredSequence > 0 && Number(node?.ackSequence ?? 0) >= requiredSequence;
      const active = Boolean(node) && this.#nodeIsLive(nodeId);
      const validStatus = [NODE_STATUS.READY, NODE_STATUS.PLAYING, NODE_STATUS.PAUSED].includes(node?.status);
      const currentProject = Number(node?.telemetry?.projectRevision) === Number(state.project.revision);
      const currentAsset = !timeline.preparedAssetSha256
        || (node?.telemetry?.preparedAssetSha256 === timeline.preparedAssetSha256
          && node?.telemetry?.cacheReady === true);
      const blockingFault = warnings.some((fault) => fault.nodeId === nodeId
        && (fault.severity === "error" || fault.severity === "critical"));
      if (active && acknowledged && validStatus && currentProject && currentAsset && !blockingFault) readyNodes.push(nodeId);
      else pendingNodes.push(nodeId);
    }
    const driverFaults = warnings.filter((fault) => fault.subsystem === "driver");
    const displayFaults = warnings.filter((fault) => fault.subsystem === "display");
    const summaryParts = [];
    if (pendingNodes.length > 0) summaryParts.push(`${pendingNodes.length} render node(s) are not PREPARE-ready`);
    if (driverFaults.length > 0) summaryParts.push(`${driverFaults.length} graphics driver fault(s)`);
    if (displayFaults.length > 0) summaryParts.push(`${displayFaults.length} display fault(s)`);
    return {
      required: requiredNodes.length,
      ready: readyNodes.length,
      allReady: pendingNodes.length === 0,
      readyNodeIds: readyNodes,
      pendingNodeIds: pendingNodes,
      warning: summaryParts.length > 0 ? summaryParts.join("; ") : null,
      warnings,
      driverFaults: driverFaults.length,
      displayFaults: displayFaults.length,
    };
  }

  getProject() {
    return jsonSafe(this.store.state.project);
  }

  async saveProject(input, { ifMatchRevision = null } = {}) {
    let normalized;
    try {
      normalized = normalizeProject(input);
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : "Project configuration is invalid", "invalid_project");
    }
    if (ifMatchRevision != null
      && (!Number.isSafeInteger(ifMatchRevision) || ifMatchRevision < 1)) {
      throw badRequest(
        "Project revision precondition must be a positive safe integer",
        "invalid_project_revision_precondition",
      );
    }
    const result = await this.store.transaction((state) => {
      const activeVerification = Object.values(state.cameraCalibrations || {}).find((calibration) => (
        ACTIVE_OPTICAL_VERIFICATION_STATES.has(calibration?.opticalVerification?.state)
      ));
      if (activeVerification) {
        throw conflict(
          `Project editing is locked by optical verification ${activeVerification.opticalVerification.verificationId}`,
          "camera_optical_verification_busy",
          {
            nodeId: activeVerification.nodeId,
            sessionId: activeVerification.sessionId,
            verificationId: activeVerification.opticalVerification.verificationId,
            operation: "save-project",
          },
        );
      }
      const activeBundleCommit = activeCameraCalibrationBundleCommit(state);
      if (activeBundleCommit) {
        throw conflict(
          `Project editing is locked by camera calibration bundle ${activeBundleCommit.bundle?.bundleId}`,
          "camera_calibration_bundle_commit_busy",
          { bundleId: activeBundleCommit.bundle?.bundleId, operation: "save-project" },
        );
      }
      const currentRevision = Number(state.project?.revision ?? 0);
      if (ifMatchRevision != null && ifMatchRevision !== currentRevision) {
        throw conflict(
          `Project revision changed: expected ${ifMatchRevision}, current ${currentRevision}`,
          "project_revision_mismatch",
          { expectedRevision: ifMatchRevision, currentRevision },
        );
      }
      const frameRateChanged = normalized.canvas.frameRateNum !== state.project.canvas.frameRateNum
        || normalized.canvas.frameRateDen !== state.project.canvas.frameRateDen;
      if (frameRateChanged && state.timeline.status !== "idle") {
        throw conflict(
          "Stop the active timeline before changing the project frame rate",
          "project_frame_rate_change_requires_idle_timeline",
          {
            timelineStatus: state.timeline.status,
            currentFrameRate: {
              numerator: state.project.canvas.frameRateNum,
              denominator: state.project.canvas.frameRateDen,
            },
            requestedFrameRate: {
              numerator: normalized.canvas.frameRateNum,
              denominator: normalized.canvas.frameRateDen,
            },
          },
        );
      }
      normalized.revision = nextProjectRevision(currentRevision, "save-project");
      normalized.updatedAt = new Date().toISOString();
      state.project = normalized;
      supersedeAppliedCameraCalibrations(state, {
        projectRevision: normalized.revision,
        at: normalized.updatedAt,
      });
      invalidatePreparedTimeline(state);
      const nodes = Object.keys(state.nodes);
      const commands = nodes.map((nodeId) => queueCommand(state, nodeId, COMMAND.SYNC_PROJECT, {
        project: projectForNode(state, nodeId, this.requireExplicitOutputOwnership),
        revision: normalized.revision,
      }));
      return { project: normalized, nodeIds: nodes, commands };
    });
    this.#notify(result.nodeIds);
    const syncTargets = result.commands.map((command, index) => ({
      nodeId: result.nodeIds[index],
      commandSequence: command.sequence,
    }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      project: result.project,
      commandSequence: result.commands.at(-1)?.sequence ?? this.store.state.nextCommandSequence - 1,
      syncTargets,
    };
  }

  getCameraSurveyPreview(requestIdInput = null) {
    const state = this.store.state;
    const requestId = requestIdInput == null || requestIdInput === "latest"
      ? state.latestCameraSurveyPreviewId
      : String(requestIdInput).trim().slice(0, 128);
    const preview = requestId ? state.cameraSurveyPreviews?.[requestId] : null;
    if (!preview) throw notFound("Camera survey preview was not found", "camera_survey_preview_not_found");
    return {
      protocolVersion: PROTOCOL_VERSION,
      preview: cameraSurveyPreviewSummary(preview),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  getCameraSurveyPreviewArtifact(requestIdInput) {
    const requestId = String(requestIdInput || "").trim().slice(0, 128);
    const preview = this.store.state.cameraSurveyPreviews?.[requestId];
    if (!preview) throw notFound("Camera survey preview was not found", "camera_survey_preview_not_found");
    const bytes = verifiedCameraSurveyPreviewBytes(preview.report);
    return {
      bytes,
      mimeType: "image/png",
      sha256: preview.report.artifact.sha256,
      capturedAt: preview.report.capturedAt,
    };
  }

  async requestCameraSurveyPreview(input = {}) {
    const state = this.store.state;
    const requestedNodeId = input.nodeId == null ? null : validateNodeId(input.nodeId);
    const nodeIds = requestedNodeId ? [requestedNodeId] : Object.keys(state.nodes);
    if (nodeIds.length !== 1) {
      throw badRequest(
        "nodeId is required unless exactly one render node is registered",
        "camera_survey_preview_node_required",
      );
    }
    const nodeId = nodeIds[0];
    if (!state.nodes[nodeId]) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    assertOpticalVerificationNodeAvailable(state, nodeId, "camera-survey-preview");
    const activeCalibration = Object.values(state.cameraCalibrations || {}).find((session) => (
      session.nodeId === nodeId && !TERMINAL_CALIBRATION_STATES.has(session.state)
    ));
    if (activeCalibration) {
      throw conflict(
        `Node ${nodeId} is running camera calibration ${activeCalibration.sessionId}`,
        "camera_survey_preview_camera_busy",
      );
    }
    const pending = Object.values(state.cameraSurveyPreviews || {}).find((preview) => (
      preview.nodeId === nodeId && ["queued", "capturing"].includes(preview.status)
    ));
    if (pending) {
      throw conflict(
        `Node ${nodeId} already has camera survey preview ${pending.requestId}`,
        "camera_survey_preview_camera_busy",
      );
    }
    const requestId = makeId("camera-survey-preview").slice(0, 128);
    let request;
    try {
      request = normalizeCameraSurveyPreviewCommand({
        schemaVersion: 1,
        requestId,
        nodeId,
        cameraId: input.cameraId,
        cameraViewId: input.cameraViewId,
        lensProfile: input.lensProfile,
        cameraSettings: input.cameraSettings,
      });
    } catch (error) {
      throw cameraSurveyPreviewHttpError(error);
    }
    const createdAt = new Date().toISOString();
    const result = await this.store.transaction((draft) => {
      assertOpticalVerificationNodeAvailable(draft, nodeId, "camera-survey-preview");
      if (!draft.nodes[nodeId]) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
      const liveCalibration = Object.values(draft.cameraCalibrations || {}).find((session) => (
        session.nodeId === nodeId && !TERMINAL_CALIBRATION_STATES.has(session.state)
      ));
      if (liveCalibration) {
        throw conflict(
          `Node ${nodeId} is running camera calibration ${liveCalibration.sessionId}`,
          "camera_survey_preview_camera_busy",
        );
      }
      const livePendingPreview = Object.values(draft.cameraSurveyPreviews || {}).find((preview) => (
        preview.nodeId === nodeId && ["queued", "capturing"].includes(preview.status)
      ));
      if (livePendingPreview) {
        throw conflict(
          `Node ${nodeId} already has camera survey preview ${livePendingPreview.requestId}`,
          "camera_survey_preview_camera_busy",
        );
      }
      draft.cameraSurveyPreviews ??= {};
      const pinnedPreviewIds = cameraCalibrationBundlePreviewIds(draft);
      const terminal = Object.values(draft.cameraSurveyPreviews)
        .filter((candidate) => !["queued", "capturing"].includes(candidate.status)
          && !pinnedPreviewIds.has(candidate.requestId))
        .sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)));
      while (Object.keys(draft.cameraSurveyPreviews).length >= MAX_CAMERA_SURVEY_PREVIEWS && terminal.length > 0) {
        delete draft.cameraSurveyPreviews[terminal.shift().requestId];
      }
      if (Object.keys(draft.cameraSurveyPreviews).length >= MAX_CAMERA_SURVEY_PREVIEWS) {
        throw conflict(
          "Too many camera survey previews are still pending",
          "camera_survey_preview_capacity",
        );
      }
      const command = queueCommand(draft, nodeId, COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW, request);
      const preview = {
        schemaVersion: 1,
        requestId,
        nodeId,
        cameraViewId: request.cameraViewId,
        lensProfileSha256: request.lensProfile.sha256,
        frame: structuredClone(request.lensProfile.frame),
        status: "queued",
        request,
        report: null,
        authenticatedAt: null,
        failure: null,
        command: { id: command.id, sequence: command.sequence, type: command.type },
        createdAt,
        updatedAt: createdAt,
      };
      draft.cameraSurveyPreviews[requestId] = preview;
      draft.latestCameraSurveyPreviewId = requestId;
      return { preview, command };
    });
    this.#notify([nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      preview: cameraSurveyPreviewSummary(result.preview),
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async completeCameraSurveyPreview(nodeIdInput, requestIdInput, input = {}) {
    const nodeId = validateNodeId(nodeIdInput);
    const requestId = String(requestIdInput || "").trim().slice(0, 128);
    const current = this.store.state.cameraSurveyPreviews?.[requestId];
    if (!current) throw notFound("Camera survey preview was not found", "camera_survey_preview_not_found");
    if (current.nodeId !== nodeId) {
      throw conflict("Camera survey preview belongs to another node", "camera_survey_preview_node_mismatch");
    }
    let report;
    try {
      report = normalizeCameraSurveyPreviewReport(input, current.request);
      if (report.status === "complete") verifiedCameraSurveyPreviewBytes(report);
    } catch (error) {
      throw cameraSurveyPreviewHttpError(error);
    }
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    const result = await this.store.transaction((state) => {
      const authenticatedAt = new Date().toISOString();
      const preview = state.cameraSurveyPreviews?.[requestId];
      if (!preview) throw notFound("Camera survey preview was not found", "camera_survey_preview_not_found");
      if (preview.nodeId !== nodeId) {
        throw conflict("Camera survey preview belongs to another node", "camera_survey_preview_node_mismatch");
      }
      const failClosedReason = state.nodes[nodeId]?.failClosedFence?.status === "active"
        ? {
          code: "SERVER_FAIL_CLOSED_FENCE_ACTIVE",
          message: "Survey preview completion arrived after the Server activated a fail-closed fence",
        }
        : serverStateRecovery?.status === "active"
          ? {
            code: "SERVER_STATE_RECOVERY_REQUIRED",
            message: "Survey preview completion arrived while Server state recovery requires reconciliation",
          }
          : null;
      const acceptedReport = report.status === "complete" && failClosedReason != null
        ? normalizeCameraSurveyPreviewReport({
          schemaVersion: 1,
          requestId: preview.requestId,
          nodeId,
          cameraViewId: preview.cameraViewId,
          lensProfileSha256: preview.lensProfileSha256,
          status: "failed",
          completedAt: authenticatedAt,
          error: failClosedReason,
        }, preview.request)
        : report;
      if (preview.report != null) {
        const sameTerminalReport = preview.report.status === acceptedReport.status
          && preview.report.lensProfileSha256 === acceptedReport.lensProfileSha256
          && (acceptedReport.status === "failed"
            ? preview.report.error?.code === acceptedReport.error?.code
            : preview.report.artifact?.sha256 === acceptedReport.artifact?.sha256);
        if (!sameTerminalReport) {
          throw conflict("Camera survey preview already has a different terminal report", "camera_survey_preview_replay");
        }
        return preview;
      }
      preview.report = acceptedReport;
      preview.status = acceptedReport.status;
      preview.authenticatedAt = authenticatedAt;
      preview.failure = acceptedReport.status === "failed" ? acceptedReport.error : null;
      preview.updatedAt = authenticatedAt;
      return preview;
    });
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      acknowledgedCameraSurveyPreviewId: requestId,
      preview: cameraSurveyPreviewSummary(result),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  listCameraCalibrationBundles() {
    const state = this.store.state;
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundles: Object.values(state.cameraCalibrationBundles || {})
        .map((record) => cameraCalibrationBundleResponse(record, state, { summary: true }))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  getCameraCalibrationBundle(bundleIdInput = null) {
    const state = this.store.state;
    const bundleId = bundleIdInput == null || bundleIdInput === "latest"
      ? state.latestCameraCalibrationBundleId
      : cameraCalibrationBundleId(bundleIdInput);
    if (!bundleId || !state.cameraCalibrationBundles?.[bundleId]) {
      throw notFound("Camera calibration bundle was not found", "camera_calibration_bundle_not_found");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundle: cameraCalibrationBundleResponse(state.cameraCalibrationBundles[bundleId], state),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async createCameraCalibrationBundle(input = {}, { ifMatchRevision = null } = {}) {
    if (!Number.isSafeInteger(ifMatchRevision) || ifMatchRevision < 1) {
      throw new HttpError(
        428,
        "camera_calibration_bundle_project_precondition_required",
        "Creating a camera calibration bundle requires If-Match with the exact project revision",
      );
    }
    if (!Array.isArray(input.members) || input.members.length < 1) {
      throw badRequest("Camera calibration bundle members must be a non-empty array", "invalid_camera_calibration_bundle");
    }
    const bundleId = makeId("camera-calibration-bundle").slice(0, 128);
    const requestedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      if (Object.keys(state.cameraCalibrationBundles || {}).length >= MAX_CAMERA_CALIBRATION_BUNDLES) {
        throw conflict("Camera calibration bundle capacity is full", "camera_calibration_bundle_capacity");
      }
      if (Number(state.project?.revision) !== ifMatchRevision) {
        throw conflict(
          `Project revision changed: expected ${ifMatchRevision}, current ${state.project?.revision}`,
          "camera_calibration_bundle_base_stale",
          { expectedRevision: ifMatchRevision, currentRevision: state.project?.revision },
        );
      }
      const alreadyBoundPreviewIds = cameraCalibrationBundlePreviewIds(state);
      const projectOutputs = new Map((state.project.outputs || []).map((output) => [output.id, output]));
      const nodeIds = new Set();
      const memberInputs = input.members.map((memberInput, index) => {
        const previewId = String(memberInput?.previewId || "").trim().slice(0, 128);
        const preview = state.cameraSurveyPreviews?.[previewId];
        if (!preview || preview.status !== "complete" || preview.report?.status !== "complete"
          || !preview.authenticatedAt) {
          throw conflict(
            `Bundle member ${index} requires an existing Server-authenticated completed preview`,
            "camera_calibration_bundle_preview_not_ready",
          );
        }
        if (alreadyBoundPreviewIds.has(previewId)) {
          throw conflict(
            `Survey preview ${previewId} is already bound to a calibration bundle`,
            "camera_calibration_bundle_preview_reused",
          );
        }
        verifiedCameraSurveyPreviewBytes(preview.report);
        nodeIds.add(preview.nodeId);
        const outputIds = Array.isArray(memberInput?.outputIds)
          ? memberInput.outputIds.map((outputId) => String(outputId))
          : [];
        const wallId = String(memberInput?.survey?.wallId || "");
        for (const outputId of outputIds) {
          const output = projectOutputs.get(outputId);
          if (!output) {
            throw conflict(`Project output ${outputId} does not exist`, "camera_calibration_bundle_output_not_found");
          }
          if (String(output.wallId || "") !== wallId) {
            throw conflict(
              `Project output ${outputId} is not assigned to survey wall ${wallId}`,
              "camera_calibration_bundle_wall_mismatch",
            );
          }
        }
        const cameraViewId = preview.cameraViewId;
        return {
          memberId: memberInput?.memberId,
          cameraViewId,
          viewCaptureId: createServerCameraViewCaptureId(),
          viewCaptureAuthority: "server",
          poseRegistration: "independent-planar",
          lensProfileSha256: preview.lensProfileSha256,
          frame: structuredClone(preview.frame),
          outputIds,
          preview: {
            id: preview.requestId,
            artifactSha256: preview.report.artifact.sha256,
            capturedAt: preview.report.capturedAt,
            authenticatedAt: preview.authenticatedAt,
            authentication: "server-verified-preview-artifact-v1",
          },
          survey: {
            id: memberInput?.survey?.id,
            wallId,
            cameraViewId,
            frame: structuredClone(preview.frame),
            lensProfileSha256: preview.lensProfileSha256,
            boundary: memberInput?.survey?.boundary,
            method: "operator-four-corner-planar-v1",
          },
        };
      });
      if (nodeIds.size !== 1) {
        throw conflict(
          "The first bundle implementation requires every view to use one render node and one renderer fingerprint",
          "camera_calibration_bundle_multiple_nodes_unsupported",
        );
      }
      const createdAt = latestIso(
        requestedAt,
        ...memberInputs.map((member) => member.preview.authenticatedAt),
      );
      let bundle;
      try {
        bundle = createCameraCalibrationBundle({
          bundleId,
          baseProject: { id: state.project.id, revision: state.project.revision },
          expectedOutputIds: input.expectedOutputIds,
          members: memberInputs,
          sameWallOverlaps: input.sameWallOverlaps ?? [],
          physicalAdjacencies: input.physicalAdjacencies ?? [],
          createdAt,
        }, { currentProject: { id: state.project.id, revision: state.project.revision } });
      } catch (error) {
        throw cameraCalibrationBundleHttpError(error);
      }
      const record = {
        schemaVersion: 1,
        bundle,
        nodeId: [...nodeIds][0],
        memberSessions: Object.fromEntries(bundle.members.map((member) => [member.memberId, null])),
        rollbackSnapshot: null,
        commit: {
          state: "not-requested",
          commitId: null,
          requestedAt: null,
          projectRevision: null,
          rendererCorrectionFingerprint: null,
          rendererAcknowledgedAt: null,
          failure: null,
        },
        createdAt,
        updatedAt: createdAt,
      };
      state.cameraCalibrationBundles ??= {};
      state.cameraCalibrationBundles[bundleId] = record;
      state.latestCameraCalibrationBundleId = bundleId;
      return record;
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundle: cameraCalibrationBundleResponse(result, this.store.state),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async startCameraCalibrationBundleMember(bundleIdInput, memberIdInput, input = {}) {
    const state = this.store.state;
    const { record, bundle, bundleId } = storedCameraCalibrationBundle(state, bundleIdInput);
    const memberId = String(memberIdInput || "").trim().slice(0, 128);
    const member = bundle.members.find((candidate) => candidate.memberId === memberId);
    if (!member) throw notFound("Camera calibration bundle member was not found", "camera_calibration_bundle_member_not_found");
    if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING
      || record.memberSessions?.[memberId]) {
      throw conflict(`Bundle member ${memberId} is already assigned`, "camera_calibration_bundle_member_finished");
    }
    if (state.project?.id !== bundle.baseProject.id
      || Number(state.project?.revision) !== Number(bundle.baseProject.revision)) {
      throw conflict("Camera calibration bundle base project is stale", "camera_calibration_bundle_base_stale");
    }
    const preview = state.cameraSurveyPreviews?.[member.preview.id];
    if (!preview || preview.status !== "complete" || preview.report?.status !== "complete"
      || !preview.authenticatedAt
      || preview.cameraViewId !== member.cameraViewId
      || preview.lensProfileSha256 !== member.lensProfileSha256
      || preview.report.artifact?.sha256 !== member.preview.artifactSha256
      || preview.report.capturedAt !== member.preview.capturedAt
      || preview.authenticatedAt !== member.preview.authenticatedAt
      || Number(preview.frame?.width) !== Number(member.frame.width)
      || Number(preview.frame?.height) !== Number(member.frame.height)) {
      throw conflict("The bound Server preview is unavailable", "camera_calibration_bundle_preview_not_ready");
    }
    verifiedCameraSurveyPreviewBytes(preview.report);
    const survey = structuredClone(member.survey);
    delete survey.sha256;
    const tuningFields = [
      "exposureProfiles", "cameraSettings", "geometryCameraSettings", "radiometryCameraSettings",
      "geometryNormalizationScale", "radiometryNormalizationScale", "mesh", "nearBlackLevels",
      "toneLevels", "settleFrames", "repeatPolicy", "repeats",
    ];
    const tuning = Object.fromEntries(tuningFields
      .filter((field) => input[field] != null)
      .map((field) => [field, input[field]]));
    if (String(input.mode || "measured").toLowerCase() !== "measured") {
      throw badRequest("Bundle members require measured calibration", "invalid_camera_calibration_bundle_mode");
    }
    return this.startCameraCalibration({
      ...tuning,
      mode: "measured",
      nodeId: preview.nodeId,
      outputIds: member.outputIds,
      cameraId: preview.request.cameraId,
      lensProfile: preview.request.lensProfile,
      surfaceSurveys: [survey],
    }, { bundleBinding: { bundleId, memberId } });
  }

  async commitCameraCalibrationBundle(bundleIdInput, { ifMatchRevision = null } = {}) {
    if (!Number.isSafeInteger(ifMatchRevision) || ifMatchRevision < 1) {
      throw new HttpError(
        428,
        "camera_calibration_bundle_project_precondition_required",
        "Committing a camera calibration bundle requires If-Match with its exact base revision",
      );
    }
    const requestedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const { record, bundle, bundleId } = storedCameraCalibrationBundle(state, bundleIdInput);
      if (ifMatchRevision !== bundle.baseProject.revision
        || state.project?.id !== bundle.baseProject.id
        || Number(state.project?.revision) !== Number(bundle.baseProject.revision)) {
        throw conflict(
          "Camera calibration bundle commit lost its base-project compare-and-swap",
          "camera_calibration_bundle_base_stale",
          { baseProject: bundle.baseProject, currentProjectRevision: state.project?.revision },
        );
      }
      if (record.commit?.state !== "not-requested" || bundle.finalEvidence != null) {
        throw conflict("Camera calibration bundle commit was already requested", "camera_calibration_bundle_commit_finished");
      }
      if (!bundle.members.every((member) => member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED)) {
        throw conflict("Every bundle member must be calibrated before commit", "camera_calibration_bundle_members_incomplete");
      }
      const activeVerification = Object.values(state.cameraCalibrations || {}).find((calibration) => (
        ACTIVE_OPTICAL_VERIFICATION_STATES.has(calibration?.opticalVerification?.state)
      ));
      if (activeVerification) {
        throw conflict(
          `Bundle commit is locked by optical verification ${activeVerification.opticalVerification.verificationId}`,
          "camera_optical_verification_busy",
        );
      }
      const runningCalibration = Object.values(state.cameraCalibrations || {}).find((calibration) => (
        !TERMINAL_CALIBRATION_STATES.has(calibration?.state)
      ));
      if (runningCalibration) {
        throw conflict(
          `Bundle commit is locked by running calibration ${runningCalibration.sessionId}`,
          "camera_calibration_busy",
        );
      }
      const updates = new Map();
      const calibrations = [];
      for (const member of bundle.members) {
        const sessionId = record.memberSessions?.[member.memberId];
        const calibration = sessionId ? state.cameraCalibrations?.[sessionId] : null;
        if (!calibration || calibration.bundleId !== bundleId
          || calibration.bundleMemberId !== member.memberId
          || calibration.state !== CAMERA_CALIBRATION_STATE.COMPLETE
          || calibration.manifest?.applicable !== true
          || calibration.projectPatch == null) {
          throw conflict(
            `Bundle member ${member.memberId} has no retained applicable manifest and patch`,
            "camera_calibration_bundle_member_evidence_missing",
          );
        }
        const retainedManifestSha256 = sha256Json(calibration.manifest);
        if (member.calibrationEvidence?.sessionId !== sessionId
          || member.calibrationEvidence?.manifestSha256 !== retainedManifestSha256
          || calibration.manifestSha256 !== retainedManifestSha256) {
          throw conflict(
            `Bundle member ${member.memberId} retained manifest differs from its staged evidence`,
            "camera_calibration_bundle_member_evidence_changed",
          );
        }
        let patch;
        try {
          patch = validateCameraCalibrationProjectPatch(
            calibration.projectPatch,
            calibration.manifest,
            state.project,
            { nodeId: calibration.nodeId },
          );
        } catch (error) {
          throw calibrationHttpError(error);
        }
        if (calibration.projectPatchSha256 !== sha256Json(patch)) {
          throw conflict(
            `Bundle member ${member.memberId} retained project patch changed after staging`,
            "camera_calibration_bundle_member_evidence_changed",
          );
        }
        if (JSON.stringify(patch.outputs.map((output) => output.id).sort())
          !== JSON.stringify([...member.outputIds].sort())) {
          throw conflict(
            `Bundle member ${member.memberId} retained patch changed output ownership`,
            "camera_calibration_bundle_member_outputs_mismatch",
          );
        }
        for (const output of patch.outputs) {
          if (updates.has(output.id)) {
            throw conflict(`Bundle output ${output.id} is duplicated`, "camera_calibration_bundle_output_duplicate");
          }
          updates.set(output.id, output);
        }
        calibrations.push(calibration);
      }
      if (updates.size !== bundle.expectedOutputIds.length
        || bundle.expectedOutputIds.some((outputId) => !updates.has(outputId))) {
        throw conflict("Bundle patches do not cover every expected output", "camera_calibration_bundle_output_missing");
      }
      const snapshotOutputs = state.project.outputs
        .filter((output) => updates.has(output.id))
        .map((output) => structuredClone(output));
      if (snapshotOutputs.length !== bundle.expectedOutputIds.length) {
        throw conflict("Bundle rollback snapshot is incomplete", "camera_calibration_bundle_rollback_snapshot_missing");
      }
      const commitId = makeId("camera-calibration-bundle-commit").slice(0, 128);
      const rollbackSnapshotId = makeId("camera-calibration-bundle-rollback").slice(0, 128);
      const targetRevision = nextProjectRevision(bundle.baseProject.revision, "camera-calibration-bundle-commit");
      const nextProject = normalizeProject({
        ...state.project,
        revision: targetRevision,
        updatedAt: requestedAt,
        outputs: state.project.outputs.map((output) => updates.get(output.id) || output),
      });
      if (Number(nextProject.revision) !== targetRevision) {
        throw conflict("Bundle project normalization changed the atomic target revision", "camera_calibration_bundle_commit_invalid");
      }
      state.project = nextProject;
      supersedeAppliedCameraCalibrations(state, {
        projectRevision: nextProject.revision,
        at: requestedAt,
      });
      record.rollbackSnapshot = {
        id: rollbackSnapshotId,
        projectId: bundle.baseProject.id,
        projectRevision: bundle.baseProject.revision,
        outputIds: [...bundle.expectedOutputIds],
        outputs: snapshotOutputs,
        createdAt: requestedAt,
      };
      record.commit = {
        state: "awaiting-renderer-ack",
        commitId,
        requestedAt,
        projectRevision: nextProject.revision,
        rendererCorrectionFingerprint: null,
        rendererAcknowledgedAt: null,
        failure: null,
      };
      record.updatedAt = requestedAt;
      for (const calibration of calibrations) {
        calibration.projectApplied = true;
        calibration.projectCommitted = true;
        calibration.currentlyApplied = true;
        calibration.appliedRevision = nextProject.revision;
        calibration.preApplyProjectRevision = bundle.baseProject.revision;
        calibration.preApplyOutputs = null;
        calibration.bundleRollbackSnapshotId = rollbackSnapshotId;
        calibration.rendererAcknowledged = false;
        calibration.rendererAcknowledgedAt = null;
        calibration.rendererCorrectionBinding = null;
        calibration.opticalVerification = {
          state: "pending-bundle-renderer-ack",
          required: true,
          verifiedAt: null,
          reason: "bundle-verification-node-wiring-required",
        };
        calibration.updatedAt = requestedAt;
      }
      invalidatePreparedTimeline(state);
      const nodeIds = Object.keys(state.nodes);
      const commands = nodeIds.map((nodeId) => queueCommand(state, nodeId, COMMAND.SYNC_PROJECT, {
        project: projectForNode(state, nodeId, this.requireExplicitOutputOwnership),
        revision: nextProject.revision,
        reason: "camera-calibration-bundle",
        bundleId,
        commitId,
      }));
      return { record, nodeIds, commands };
    });
    this.#notify(result.nodeIds);
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundle: cameraCalibrationBundleResponse(result.record, this.store.state),
      commandSequence: result.commands.at(-1)?.sequence ?? this.store.state.nextCommandSequence - 1,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async recordCameraCalibrationBundleMemberVerification(bundleIdInput, memberIdInput) {
    const recordedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const { record, bundle } = storedCameraCalibrationBundle(state, bundleIdInput);
      const memberId = String(memberIdInput || "").trim().slice(0, 128);
      const member = bundle.members.find((candidate) => candidate.memberId === memberId);
      if (!member) throw notFound("Camera calibration bundle member was not found", "camera_calibration_bundle_member_not_found");
      if (member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED) return record;
      if (!bundle.finalEvidence
        || state.project?.id !== bundle.baseProject.id
        || Number(state.project?.revision) !== Number(bundle.finalEvidence.projectRevision)) {
        throw conflict("The exact final bundle revision is not current", "camera_calibration_bundle_final_stale");
      }
      const sessionId = record.memberSessions?.[memberId];
      const calibration = sessionId ? state.cameraCalibrations?.[sessionId] : null;
      const runtime = opticalRuntime(calibration);
      if (!runtime || runtime.state !== CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED || runtime.report == null) {
        throw conflict(
          "No conclusive Server-validated optical verification exists for this member",
          "camera_calibration_bundle_member_verification_missing",
        );
      }
      if (calibration.rendererCorrectionBinding?.fingerprint
        !== bundle.finalEvidence.rendererCorrectionFingerprint
        || Number(runtime.appliedRevision) !== Number(bundle.finalEvidence.projectRevision)) {
        throw conflict(
          "Member optical evidence is not bound to the final bundle renderer revision",
          "camera_calibration_bundle_member_verification_stale",
        );
      }
      const completedAt = runtime.completedAt;
      const eventAt = latestIso(recordedAt, completedAt, bundle.updatedAt);
      try {
        record.bundle = reduceCameraCalibrationBundle(bundle, {
          type: CAMERA_CALIBRATION_BUNDLE_EVENT.MEMBER_VERIFIED,
          memberId,
          evidence: {
            verificationId: runtime.verificationId,
            reportSha256: sha256Json(runtime.report),
            projectRevision: bundle.finalEvidence.projectRevision,
            rendererCorrectionFingerprint: bundle.finalEvidence.rendererCorrectionFingerprint,
            completedAt,
          },
          at: eventAt,
        }, {
          currentProject: {
            id: bundle.baseProject.id,
            revision: bundle.finalEvidence.projectRevision,
          },
        });
      } catch (error) {
        throw cameraCalibrationBundleHttpError(error);
      }
      record.updatedAt = eventAt;
      return record;
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundle: cameraCalibrationBundleResponse(result, this.store.state),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async appendCameraCalibrationBundleAdjacencyObservation(bundleIdInput, adjacencyIdInput, input = {}) {
    const status = String(input.status || "");
    if (status === "passed") {
      throw conflict(
        "A preview alone cannot prove a cross-view seam passed; Node bridge verification is not implemented",
        "camera_calibration_bundle_adjacency_pass_requires_verifier",
      );
    }
    if (!new Set(["failed", "not-observable"]).has(status)) {
      throw badRequest(
        "Adjacency observation status must be failed or not-observable",
        "invalid_camera_calibration_bundle_adjacency_status",
      );
    }
    const observedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const { record, bundle } = storedCameraCalibrationBundle(state, bundleIdInput);
      const adjacencyId = String(adjacencyIdInput || "").trim().slice(0, 128);
      if (!bundle.physicalAdjacencies.some((adjacency) => adjacency.id === adjacencyId)) {
        throw notFound("Physical bundle adjacency was not found", "camera_calibration_bundle_adjacency_not_found");
      }
      if (!bundle.finalEvidence
        || state.project?.id !== bundle.baseProject.id
        || Number(state.project?.revision) !== Number(bundle.finalEvidence.projectRevision)) {
        throw conflict("The exact final bundle revision is not current", "camera_calibration_bundle_final_stale");
      }
      const previewId = String(input.previewId || "").trim().slice(0, 128);
      const preview = state.cameraSurveyPreviews?.[previewId];
      if (!preview || preview.status !== "complete" || preview.report?.status !== "complete"
        || !preview.authenticatedAt) {
        throw conflict("Adjacency observation requires an authenticated completed preview", "camera_calibration_bundle_preview_not_ready");
      }
      if (cameraCalibrationBundlePreviewIds(state).has(previewId)) {
        throw conflict("Adjacency preview is already bound to bundle evidence", "camera_calibration_bundle_preview_reused");
      }
      verifiedCameraSurveyPreviewBytes(preview.report);
      const eventAt = latestIso(observedAt, preview.authenticatedAt, bundle.updatedAt);
      const observationId = makeId("camera-calibration-adjacency-observation").slice(0, 128);
      const evidenceSha256 = sha256Json({
        bundleId: bundle.bundleId,
        adjacencyId,
        observationId,
        previewId,
        previewArtifactSha256: preview.report.artifact.sha256,
        status,
        projectRevision: bundle.finalEvidence.projectRevision,
        rendererCorrectionFingerprint: bundle.finalEvidence.rendererCorrectionFingerprint,
      });
      try {
        record.bundle = reduceCameraCalibrationBundle(bundle, {
          type: CAMERA_CALIBRATION_BUNDLE_EVENT.ADJACENCY_OBSERVED,
          adjacencyId,
          observation: {
            observationId,
            cameraViewId: preview.cameraViewId,
            viewCaptureId: createServerCameraViewCaptureId(),
            viewCaptureAuthority: "server",
            preview: {
              id: preview.requestId,
              artifactSha256: preview.report.artifact.sha256,
              capturedAt: preview.report.capturedAt,
              authenticatedAt: preview.authenticatedAt,
              authentication: "server-verified-preview-artifact-v1",
            },
            evidenceSha256,
            status,
            projectRevision: bundle.finalEvidence.projectRevision,
            rendererCorrectionFingerprint: bundle.finalEvidence.rendererCorrectionFingerprint,
            observedAt: eventAt,
          },
          at: eventAt,
        }, {
          currentProject: {
            id: bundle.baseProject.id,
            revision: bundle.finalEvidence.projectRevision,
          },
        });
      } catch (error) {
        throw cameraCalibrationBundleHttpError(error);
      }
      record.updatedAt = eventAt;
      return record;
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      bundle: cameraCalibrationBundleResponse(result, this.store.state),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  getCameraCalibration(sessionIdInput = null) {
    const state = this.store.state;
    const sessionId = sessionIdInput == null || sessionIdInput === "latest"
      ? state.latestCameraCalibrationId
      : String(sessionIdInput).trim().slice(0, 128);
    if (!sessionId || !state.cameraCalibrations?.[sessionId]) {
      throw notFound("Camera calibration session was not found", "camera_calibration_not_found");
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: jsonSafe(state.cameraCalibrations[sessionId]),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async startCameraCalibration(input = {}, { bundleBinding = null } = {}) {
    const mode = String(input.mode || "measured").toLowerCase();
    if (!new Set(["measured", "simulation"]).has(mode)) {
      throw badRequest("Camera calibration mode must be measured or simulation", "invalid_camera_calibration_mode");
    }
    const state = this.store.state;
    let normalizedBundleBinding = null;
    if (bundleBinding != null) {
      const bundleId = cameraCalibrationBundleId(bundleBinding.bundleId);
      const memberId = String(bundleBinding.memberId || "").trim().slice(0, 128);
      const { record, bundle } = storedCameraCalibrationBundle(state, bundleId);
      const member = bundle.members.find((candidate) => candidate.memberId === memberId);
      if (!member) {
        throw notFound("Camera calibration bundle member was not found", "camera_calibration_bundle_member_not_found");
      }
      if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING
        || record.memberSessions?.[memberId]) {
        throw conflict(`Bundle member ${memberId} is already assigned`, "camera_calibration_bundle_member_finished");
      }
      if (state.project?.id !== bundle.baseProject.id
        || Number(state.project?.revision) !== Number(bundle.baseProject.revision)) {
        throw conflict("Camera calibration bundle base project is stale", "camera_calibration_bundle_base_stale");
      }
      normalizedBundleBinding = { bundleId, memberId, member, record };
    }
    const requestedNodeId = input.nodeId == null ? null : validateNodeId(input.nodeId);
    const nodeIds = requestedNodeId ? [requestedNodeId] : Object.keys(state.nodes);
    if (nodeIds.length !== 1) {
      throw badRequest("nodeId is required unless exactly one render node is registered", "camera_calibration_node_required");
    }
    const nodeId = nodeIds[0];
    const node = state.nodes[nodeId];
    if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    if (normalizedBundleBinding && normalizedBundleBinding.record.nodeId !== nodeId) {
      throw conflict(
        "Camera calibration bundle member belongs to another render node",
        "camera_calibration_bundle_node_mismatch",
      );
    }
    const activeBundleCommit = activeCameraCalibrationBundleCommit(state);
    if (activeBundleCommit) {
      throw conflict(
        `Camera calibration is locked by bundle ${activeBundleCommit.bundle?.bundleId}`,
        "camera_calibration_bundle_commit_busy",
        { bundleId: activeBundleCommit.bundle?.bundleId, operation: "start-camera-calibration" },
      );
    }
    assertOpticalVerificationNodeAvailable(state, nodeId, "start-camera-calibration");
    const running = Object.values(state.cameraCalibrations || {}).find((session) => (
      session.nodeId === nodeId && !TERMINAL_CALIBRATION_STATES.has(session.state)
    ));
    if (running) {
      throw conflict(`Node ${nodeId} already has camera calibration ${running.sessionId}`, "camera_calibration_busy");
    }

    const requestedIds = input.outputIds == null
      ? null
      : Array.from(new Set(Array.isArray(input.outputIds) ? input.outputIds.map(String) : []));
    if (input.outputIds != null && requestedIds.length === 0) {
      throw badRequest("outputIds must be a non-empty array", "invalid_camera_calibration_outputs");
    }
    const ownedOutputs = projectOutputsForNode(
      state,
      nodeId,
      this.requireExplicitOutputOwnership,
    );
    const selectedOutputs = requestedIds
      ? requestedIds.map((id) => ownedOutputs.find((output) => output.id === id)).filter(Boolean)
      : ownedOutputs;
    if (selectedOutputs.length === 0 || (requestedIds && selectedOutputs.length !== requestedIds.length)) {
      throw badRequest("Every calibration output must exist and belong to the selected node", "invalid_camera_calibration_outputs");
    }
    const plannedProjectId = state.project.id;
    const plannedProjectRevision = Number(state.project.revision);
    const plannedOutputIds = selectedOutputs.map((output) => output.id);
    const plannedOutputsSha256 = sha256Json(selectedOutputs);
    const sessionId = makeId("camera-calibration").slice(0, 128);
    let plan;
    try {
      if (input.surfaceTargets != null) {
        throw new CameraCalibrationError(
          "INVALID_CALIBRATION_CONTRACT",
          "Clients submit surfaceSurveys; authoritative per-output targets are derived from the saved project",
        );
      }
      const surfaceTargets = input.surfaceSurveys == null
        ? null
        : derivePlanarOutputTargets({
          surveys: input.surfaceSurveys,
          outputs: selectedOutputs,
          lensProfile: input.lensProfile,
        });
      plan = createCameraCalibrationPlan({
        sessionId,
        projectId: state.project.id,
        projectRevision: state.project.revision,
        cameraId: input.cameraId,
        ...(input.exposureProfiles != null
          ? { exposureProfiles: input.exposureProfiles }
          : {
            cameraSettings: input.cameraSettings,
            geometryCameraSettings: input.geometryCameraSettings,
            radiometryCameraSettings: input.radiometryCameraSettings,
            geometryNormalizationScale: input.geometryNormalizationScale,
            radiometryNormalizationScale: input.radiometryNormalizationScale,
          }),
        mesh: input.mesh,
        nearBlackLevels: input.nearBlackLevels,
        toneLevels: input.toneLevels,
        settleFrames: input.settleFrames,
        ...(input.repeatPolicy != null ? { repeatPolicy: input.repeatPolicy } : { repeats: input.repeats }),
        ...(input.lensProfile == null ? {} : { lensProfile: input.lensProfile }),
        outputs: selectedOutputs.map((output) => ({
          id: output.id,
          resolution: output.resolution,
          wallId: output.wallId,
          sourceViewport: output.sourceViewport,
        })),
        ...(surfaceTargets == null ? {} : { surfaceTargets }),
      });
    } catch (error) {
      throw calibrationHttpError(error);
    }
    const createdAt = new Date().toISOString();
    const result = await this.store.transaction((draft) => {
      assertOpticalVerificationNodeAvailable(draft, nodeId, "start-camera-calibration");
      if (draft.project?.id !== plannedProjectId
        || Number(draft.project?.revision) !== plannedProjectRevision
        || plan.project.id !== plannedProjectId
        || Number(plan.project.revision) !== plannedProjectRevision) {
        throw conflict(
          "Camera calibration plan belongs to a stale project revision",
          "camera_calibration_project_stale",
          {
            expectedProjectId: plannedProjectId,
            expectedRevision: plannedProjectRevision,
            currentProjectId: draft.project?.id ?? null,
            currentRevision: Number(draft.project?.revision ?? 0),
          },
        );
      }
      const liveSelectedOutputs = plannedOutputIds.map((outputId) => (
        draft.project.outputs.find((output) => output.id === outputId)
      ));
      if (liveSelectedOutputs.some((output) => output == null)
        || sha256Json(liveSelectedOutputs) !== plannedOutputsSha256) {
        throw conflict(
          "Camera calibration output bindings changed while the plan was being queued",
          "camera_calibration_output_binding_stale",
          { outputIds: plannedOutputIds },
        );
      }
      const liveBundleCommit = activeCameraCalibrationBundleCommit(draft);
      if (liveBundleCommit) {
        throw conflict(
          `Camera calibration is locked by bundle ${liveBundleCommit.bundle?.bundleId}`,
          "camera_calibration_bundle_commit_busy",
          { bundleId: liveBundleCommit.bundle?.bundleId, operation: "start-camera-calibration" },
        );
      }
      const liveRunning = Object.values(draft.cameraCalibrations || {}).find((session) => (
        session.nodeId === nodeId && !TERMINAL_CALIBRATION_STATES.has(session.state)
      ));
      if (liveRunning) {
        throw conflict(
          `Node ${nodeId} already has camera calibration ${liveRunning.sessionId}`,
          "camera_calibration_busy",
        );
      }
      let bundleRecord = null;
      if (normalizedBundleBinding) {
        const stored = storedCameraCalibrationBundle(draft, normalizedBundleBinding.bundleId);
        bundleRecord = stored.record;
        const member = stored.bundle.members.find(
          (candidate) => candidate.memberId === normalizedBundleBinding.memberId,
        );
        if (draft.project?.id !== stored.bundle.baseProject.id
          || Number(draft.project?.revision) !== Number(stored.bundle.baseProject.revision)
          || plan.project.id !== stored.bundle.baseProject.id
          || Number(plan.project.revision) !== Number(stored.bundle.baseProject.revision)) {
          throw conflict("Camera calibration bundle base project is stale", "camera_calibration_bundle_base_stale");
        }
        if (!member || member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING
          || bundleRecord.memberSessions?.[member.memberId]) {
          throw conflict(
            `Bundle member ${normalizedBundleBinding.memberId} is already assigned`,
            "camera_calibration_bundle_member_finished",
          );
        }
        if (bundleRecord.nodeId !== nodeId
          || JSON.stringify([...member.outputIds].sort())
            !== JSON.stringify(plan.outputs.map((output) => output.id).sort())) {
          throw conflict(
            "Camera calibration plan changed the immutable bundle member binding",
            "camera_calibration_bundle_member_binding_mismatch",
          );
        }
      }
      const commandPayload = { mode, plan };
      if (normalizedBundleBinding) {
        commandPayload.bundle = {
          bundleId: normalizedBundleBinding.bundleId,
          memberId: normalizedBundleBinding.memberId,
          cameraViewId: normalizedBundleBinding.member.cameraViewId,
          viewCaptureId: normalizedBundleBinding.member.viewCaptureId,
        };
      }
      const command = queueCommand(draft, nodeId, COMMAND.START_CAMERA_CALIBRATION, commandPayload);
      const calibration = {
        schemaVersion: 1,
        sessionId,
        nodeId,
        mode,
        state: "queued",
        progress: { completedSteps: 0, totalSteps: plan.steps.length, stepIndex: -1 },
        project: plan.project,
        outputIds: plan.outputs.map((output) => output.id),
        cameraId: plan.requestedCameraId,
        plan,
        manifest: null,
        manifestSha256: null,
        terminalReportSha256: null,
        projectPatch: null,
        projectPatchSha256: null,
        failure: null,
        projectApplied: false,
        projectCommitted: false,
        currentlyApplied: false,
        appliedRevision: null,
        preApplyProjectRevision: null,
        preApplyOutputs: null,
        bundleId: normalizedBundleBinding?.bundleId ?? null,
        bundleMemberId: normalizedBundleBinding?.memberId ?? null,
        viewCaptureId: normalizedBundleBinding?.member.viewCaptureId ?? null,
        bundleRollbackSnapshotId: null,
        rendererAcknowledged: false,
        rendererAcknowledgedAt: null,
        rendererCorrectionBinding: null,
        operatorPrompt: null,
        confirmationCommands: [],
        opticalVerification: mode === "simulation"
          ? { state: "not-applicable", required: false, verifiedAt: null, reason: "simulation" }
          : { state: "pending-apply", required: true, verifiedAt: null, reason: null },
        createdAt,
        updatedAt: createdAt,
        command: { id: command.id, sequence: command.sequence, type: command.type },
      };
      draft.cameraCalibrations ??= {};
      draft.cameraCalibrations[sessionId] = calibration;
      draft.latestCameraCalibrationId = sessionId;
      if (bundleRecord) {
        bundleRecord.memberSessions[normalizedBundleBinding.memberId] = sessionId;
        bundleRecord.updatedAt = createdAt;
      }
      const ids = Object.keys(draft.cameraCalibrations);
      let excess = Math.max(0, ids.length - 20);
      if (excess > 0) {
        const pinnedSessionIds = cameraCalibrationBundleSessionIds(draft);
        for (const stale of ids) {
          if (excess < 1) break;
          if (stale === sessionId || pinnedSessionIds.has(stale)) continue;
          delete draft.cameraCalibrations[stale];
          excess -= 1;
        }
      }
      return { calibration, command };
    });
    this.#notify([nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async cancelCameraCalibration(sessionIdInput) {
    const sessionId = String(sessionIdInput || "").trim().slice(0, 128);
    const current = this.store.state.cameraCalibrations?.[sessionId];
    if (!current) throw notFound("Camera calibration session was not found", "camera_calibration_not_found");
    if (TERMINAL_CALIBRATION_STATES.has(current.state)) {
      throw conflict(`Camera calibration is already ${current.state}`, "camera_calibration_finished");
    }
    const requestedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const calibration = state.cameraCalibrations[sessionId];
      const command = queueCommand(state, calibration.nodeId, COMMAND.CANCEL_CAMERA_CALIBRATION, { sessionId });
      calibration.cancelRequestedAt = requestedAt;
      calibration.updatedAt = requestedAt;
      return { calibration, command };
    });
    this.#notify([current.nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async confirmCameraCalibration(sessionIdInput, input = {}) {
    const sessionId = String(sessionIdInput || "").trim().slice(0, 128);
    const current = this.store.state.cameraCalibrations?.[sessionId];
    if (!current) throw notFound("Camera calibration session was not found", "camera_calibration_not_found");
    if (TERMINAL_CALIBRATION_STATES.has(current.state)) {
      throw conflict(`Camera calibration is already ${current.state}`, "camera_calibration_finished");
    }
    const prompt = current.operatorPrompt;
    const stepId = String(input?.stepId || "").trim().slice(0, 256);
    const confirmationId = String(input?.confirmationId || "").trim().slice(0, 256);
    if (input?.confirmed !== true || !prompt || prompt.state !== "waiting"
      || !stepId || stepId !== String(prompt.stepId)
      || !confirmationId || confirmationId !== String(prompt.confirmationId)) {
      throw conflict(
        "Camera confirmation is stale or does not match the step currently waiting on the render node",
        "camera_calibration_confirmation_mismatch",
      );
    }
    const confirmedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const calibration = state.cameraCalibrations[sessionId];
      const livePrompt = calibration?.operatorPrompt;
      if (!calibration || livePrompt?.state !== "waiting"
        || String(livePrompt.stepId) !== stepId
        || String(livePrompt.confirmationId) !== confirmationId) {
        throw conflict(
          "Camera confirmation changed before it could be queued",
          "camera_calibration_confirmation_mismatch",
        );
      }
      const planStep = calibration.plan.steps.find((step) => step.id === stepId);
      const confirmationLeaseId = String(planStep?.confirmationLeaseId || "");
      const firstLeaseStep = calibration.plan.steps.find((step) => (
        step.requiresOperatorConfirmation === true
        && step.confirmationLeaseId === confirmationLeaseId
      ));
      if (planStep?.requiresOperatorConfirmation !== true || !confirmationLeaseId
        || firstLeaseStep?.id !== stepId) {
        throw conflict(
          "Camera confirmation is not bound to an operator-confirmed plan step and lease",
          "camera_calibration_confirmation_mismatch",
        );
      }
      const confirmationCommands = Array.isArray(calibration.confirmationCommands)
        ? calibration.confirmationCommands
        : [];
      if (confirmationCommands.some((entry) => (
        entry.confirmationLeaseId === confirmationLeaseId
        || entry.confirmationId === confirmationId
      ))) {
        throw conflict(
          "Camera confirmation lease or id was already consumed",
          "camera_calibration_confirmation_mismatch",
        );
      }
      const command = queueCommand(state, calibration.nodeId, COMMAND.CONFIRM_CAMERA_CALIBRATION, {
        sessionId,
        stepId,
        confirmationId,
        confirmationLeaseId,
        confirmedAt,
      });
      calibration.confirmationCommands = [...confirmationCommands, {
        id: command.id,
        sequence: command.sequence,
        type: command.type,
        stepId,
        confirmationId,
        confirmationLeaseId,
        confirmedAt,
      }];
      calibration.operatorPrompt = {
        ...livePrompt,
        state: "confirmation-queued",
        confirmedAt,
      };
      calibration.updatedAt = confirmedAt;
      return { calibration, command };
    });
    this.#notify([current.nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async startCameraOpticalVerification(sessionIdInput) {
    const sessionId = String(sessionIdInput || "").trim().slice(0, 128);
    const requestedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const calibration = state.cameraCalibrations?.[sessionId];
      if (!calibration) throw notFound("Camera calibration session was not found", "camera_calibration_not_found");
      if (calibration.bundleId) {
        throw conflict(
          "Bundle members require pinned multi-session manifests and one bundle-wide rollback before optical verification can start",
          "camera_calibration_bundle_verification_wiring_required",
          { bundleId: calibration.bundleId, sessionId },
        );
      }
      if (calibration.mode !== "measured" || calibration.state !== CAMERA_CALIBRATION_STATE.COMPLETE
        || calibration.manifest?.applicable !== true || calibration.manifest?.provenance !== "measured") {
        throw conflict(
          "Only a completed applicable measured calibration can be optically verified",
          "camera_optical_verification_not_applicable",
        );
      }
      if (calibration.projectCommitted !== true || calibration.rendererAcknowledged !== true
        || calibration.currentlyApplied !== true || calibration.appliedRevision == null
        || calibration.rendererCorrectionBinding == null
        || Number(state.project.revision) !== Number(calibration.appliedRevision)) {
        throw conflict(
          "The exact committed calibration revision must still be current and renderer-acknowledged",
          "camera_optical_verification_revision_mismatch",
        );
      }
      const preApplyOutputs = cameraCalibrationBundlePreApplyOutputs(state, calibration);
      if (!Array.isArray(preApplyOutputs) || preApplyOutputs.length < 1
        || Number(calibration.preApplyProjectRevision) !== Number(calibration.project?.revision)) {
        throw conflict(
          "The exact pre-apply output snapshot required for rollback is unavailable",
          "camera_optical_verification_rollback_snapshot_missing",
        );
      }
      const active = activeOpticalVerificationForNode(state, calibration.nodeId);
      if (active) {
        throw conflict(
          `Node ${calibration.nodeId} already owns optical verification ${active.opticalVerification.verificationId}`,
          "camera_optical_verification_busy",
        );
      }
      const previousState = calibration.opticalVerification?.state;
      if (previousState === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
        throw conflict("This calibration revision is already optically verified", "camera_optical_verification_finished");
      }
      const verificationId = makeId("camera-optical-verification").slice(0, 128);
      const leaseToken = randomBytes(32).toString("base64url");
      let plan;
      try {
        const manifestOutputs = new Map(
          (calibration.manifest.outputs || []).map((output) => [output.outputId, output]),
        );
        const radiometryProfile = calibration.plan.exposureProfiles
          .find((profile) => profile.role === "radiometry");
        plan = createCameraOpticalVerificationPlan({
          verificationId,
          leaseToken,
          calibrationSessionId: sessionId,
          nodeId: calibration.nodeId,
          project: {
            id: state.project.id,
            baseRevision: Number(calibration.project.revision),
            appliedRevision: Number(calibration.appliedRevision),
          },
          rendererAcknowledgedAt: calibration.rendererAcknowledgedAt,
          rendererCorrectionBinding: calibration.rendererCorrectionBinding,
          camera: calibration.manifest.camera,
          lensProfile: calibration.plan.lensProfile,
          exposureProfiles: calibration.plan.exposureProfiles,
          outputs: calibration.plan.outputs.map((output) => ({
            id: output.id,
            resolution: {
              width: Number(output.width),
              height: Number(output.height),
            },
            sourceViewport: output.sourceViewport,
            surfaceTarget: output.surfaceTarget,
          })),
          blackFloorBaselines: calibration.plan.outputs.map((output) => {
            const manifestOutput = manifestOutputs.get(output.id);
            const exposureBridge = manifestOutput?.radiometry?.measuredExposureNormalization;
            return {
              outputId: output.id,
              calibrationSessionId: sessionId,
              sourceManifestSchemaVersion: calibration.manifest.schemaVersion,
              blackPedestalSha256: manifestOutput?.artifacts?.blackPedestal?.sha256,
              exposureProfileId: radiometryProfile?.id,
              normalizationScale: radiometryProfile?.normalizationScale,
              exposureBridgeId: exposureBridge?.bridgeId,
              exposureBridgeStatus: exposureBridge?.status,
              exposureBridgeGatesPassed: exposureBridge?.gates?.passed,
              measuredNormalizationScale: exposureBridge?.measuredScaleLuma,
              normalizationRelativeUncertainty: exposureBridge?.uncertaintyLuma,
              measurementBasis: CAMERA_OPTICAL_BLACK_FLOOR_MEASUREMENT_BASIS,
              targetLevel: manifestOutput?.radiometry?.black?.target,
            };
          }),
          mesh: calibration.plan.mesh,
          nearBlackLevels: calibration.plan.nearBlackLevels,
          settleFrames: calibration.plan.settleFrames,
        });
      } catch (error) {
        throw cameraOpticalVerificationHttpError(error);
      }
      let runtime = createCameraOpticalVerificationState(plan, { at: requestedAt });
      runtime = normalizeCameraOpticalVerificationState({
        ...runtime,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.QUEUED,
      }, { plan });
      const command = queueCommand(state, calibration.nodeId, COMMAND.START_CAMERA_OPTICAL_VERIFICATION, { plan });
      calibration.opticalVerification = mirrorOpticalRuntime({
        required: true,
        plan,
        command: { id: command.id, sequence: command.sequence, type: command.type },
        reason: null,
        verifiedAt: null,
        restoreCommand: null,
        confirmationCommands: [],
      }, runtime);
      calibration.updatedAt = requestedAt;
      return { calibration, command, nodeId: calibration.nodeId };
    });
    this.#notify([result.nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async confirmCameraOpticalVerification(sessionIdInput, input = {}) {
    const sessionId = String(sessionIdInput || "").trim().slice(0, 128);
    const current = this.store.state.cameraCalibrations?.[sessionId];
    if (!current) throw notFound("Camera calibration session was not found", "camera_calibration_not_found");
    const plan = opticalPlan(current);
    const runtime = opticalRuntime(current);
    const prompt = runtime?.operatorPrompt;
    if (!plan || !runtime || runtime.state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
      || prompt?.state !== "waiting" || input?.confirmed !== true) {
      throw conflict("Optical verification is not waiting for this confirmation", "camera_optical_verification_confirmation_mismatch");
    }
    const confirmedAt = new Date().toISOString();
    let confirmation;
    try {
      confirmation = normalizeCameraOpticalVerificationConfirmation({
        schemaVersion: plan.schemaVersion,
        verificationId: plan.verificationId,
        calibrationSessionId: plan.calibrationSessionId,
        nodeId: plan.nodeId,
        projectRevision: plan.project.appliedRevision,
        leaseToken: plan.leaseToken,
        stepId: String(input.stepId || ""),
        confirmationId: String(input.confirmationId || ""),
        confirmationLeaseId: prompt.confirmationLeaseId,
        confirmedAt,
      }, { plan, state: runtime });
    } catch (error) {
      throw cameraOpticalVerificationHttpError(error);
    }
    const result = await this.store.transaction((state) => {
      const calibration = state.cameraCalibrations?.[sessionId];
      const livePlan = opticalPlan(calibration);
      const liveRuntime = opticalRuntime(calibration);
      if (!calibration || !livePlan || !liveRuntime
        || liveRuntime.operatorPrompt?.state !== "waiting"
        || liveRuntime.operatorPrompt?.confirmationId !== confirmation.confirmationId
        || liveRuntime.progress.currentStepId !== confirmation.stepId) {
        throw conflict(
          "Optical verification confirmation changed before it could be queued",
          "camera_optical_verification_confirmation_mismatch",
        );
      }
      let queuedRuntime;
      try {
        queuedRuntime = normalizeCameraOpticalVerificationState({
          ...liveRuntime,
          updatedAt: confirmedAt,
          operatorPrompt: {
            ...liveRuntime.operatorPrompt,
            state: "confirmation-queued",
            confirmedAt,
          },
        }, { plan: livePlan });
      } catch (error) {
        throw cameraOpticalVerificationHttpError(error);
      }
      const command = queueCommand(state, calibration.nodeId, COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION, confirmation);
      const confirmationCommands = Array.isArray(calibration.opticalVerification.confirmationCommands)
        ? calibration.opticalVerification.confirmationCommands
        : [];
      if (confirmationCommands.some((entry) => entry.confirmationLeaseId === confirmation.confirmationLeaseId)) {
        throw conflict(
          "This physical-condition lease already has an authoritative confirmation command",
          "camera_optical_verification_confirmation_replay",
        );
      }
      calibration.opticalVerification = mirrorOpticalRuntime(calibration.opticalVerification, queuedRuntime, {
        confirmationCommand: { id: command.id, sequence: command.sequence, type: command.type },
        confirmationCommands: [...confirmationCommands, {
          id: command.id,
          sequence: command.sequence,
          type: command.type,
          confirmationId: confirmation.confirmationId,
          confirmationLeaseId: confirmation.confirmationLeaseId,
          stepId: confirmation.stepId,
          confirmedAt: confirmation.confirmedAt,
        }],
      });
      calibration.updatedAt = confirmedAt;
      return { calibration, command, nodeId: calibration.nodeId };
    });
    this.#notify([result.nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async cancelCameraOpticalVerification(sessionIdInput) {
    const sessionId = String(sessionIdInput || "").trim().slice(0, 128);
    const requestedAt = new Date().toISOString();
    const result = await this.store.transaction((state) => {
      const calibration = state.cameraCalibrations?.[sessionId];
      const plan = opticalPlan(calibration);
      const runtime = opticalRuntime(calibration);
      if (!calibration || !plan || !runtime) {
        throw notFound("Camera optical verification was not found", "camera_optical_verification_not_found");
      }
      if (!ACTIVE_OPTICAL_VERIFICATION_STATES.has(runtime.state)) {
        throw conflict(`Optical verification is already ${runtime.state}`, "camera_optical_verification_finished");
      }
      if ([
        CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
        CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
      ].includes(runtime.state)) {
        throw conflict(
          "Automatic rollback has started and must reach renderer-safe restoration before it can finish",
          "camera_optical_verification_rollback_in_progress",
        );
      }
      const command = queueCommand(state, calibration.nodeId, COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION, {
        verificationId: plan.verificationId,
        leaseToken: plan.leaseToken,
      });
      calibration.opticalVerification = {
        ...calibration.opticalVerification,
        cancelRequestedAt: requestedAt,
        cancelCommand: { id: command.id, sequence: command.sequence, type: command.type },
      };
      calibration.updatedAt = requestedAt;
      return { calibration, command, nodeId: calibration.nodeId };
    });
    this.#notify([result.nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      calibration: result.calibration,
      command: result.command,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async register(input, remoteAddress = null) {
    const registration = normalizeRegistration(input);
    validateNodeId(registration.nodeId);
    const now = new Date().toISOString();
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    const result = await this.store.transaction((state) => {
      const existing = state.nodes[registration.nodeId];
      const node = {
        ...registration,
        address: registration.address || remoteAddress || existing?.address || null,
        status: NODE_STATUS.IDLE,
        registeredAt: existing?.registeredAt ?? now,
        lastSeenAt: now,
        ackSequence: Number(existing?.ackSequence ?? 0),
        commandSequence: Number(existing?.commandSequence ?? 0),
        telemetry: existing?.telemetry ?? telemetryFrom(),
        host: existing?.host ?? null,
        hostUpdatedAt: existing?.hostUpdatedAt ?? null,
        latestDiagnostics: existing?.latestDiagnostics ?? null,
        lastActionResult: existing?.lastActionResult ?? null,
        latestCommandDeadLetter: existing?.latestCommandDeadLetter ?? null,
        commandDeadLetterCount: Number(existing?.commandDeadLetterCount
          ?? state.commandDeadLetters?.[registration.nodeId]?.length ?? 0),
        commandFailureSafetyLock: existing?.commandFailureSafetyLock ?? null,
        failClosedGeneration: Number(existing?.failClosedGeneration ?? 0),
        failClosedFence: existing?.failClosedFence ?? null,
        maxIssuedLeaseExpiresAtNs: existing?.maxIssuedLeaseExpiresAtNs ?? "0",
        requiresResync: false,
      };
      state.nodes[registration.nodeId] = node;
      state.commandQueues[registration.nodeId] ??= [];
      const nodeProject = projectForNode(
        state,
        registration.nodeId,
        this.requireExplicitOutputOwnership,
      );
      // Reconnecting is part of the durable command retry contract. Reuse an
      // already-authoritative pending snapshot instead of replacing it with a
      // fresh id/sequence on every transient failure; otherwise a permanently
      // invalid sync could evade its retry budget forever.
      const command = serverStateRecovery?.status === "active" || node.failClosedFence?.status === "active"
        ? null
        : state.commandQueues[registration.nodeId].find((queued) => (
          queued.type === COMMAND.SYNC_PROJECT
          && queued.payload?.revision === state.project.revision
          && isDeepStrictEqual(queued.payload?.project, nodeProject)
          && queued.sequence > node.ackSequence
        )) || queueCommand(state, registration.nodeId, COMMAND.SYNC_PROJECT, {
          project: nodeProject,
          revision: state.project.revision,
        });
      const commandDeadLetters = (state.commandDeadLetters?.[registration.nodeId] || []).slice(-32).map((record) => ({
        deadLetterId: record.deadLetterId,
        command: record.command,
        receivedAt: record.receivedAt,
      }));
      const executionLease = mintExecutionLease(
        state,
        registration.nodeId,
        this.executionLeaseTtlMs,
        serverStateRecovery,
      );
      return { node, command, project: nodeProject, commandDeadLetters, executionLease };
    });
    this.liveNodeSeenNs.set(registration.nodeId, process.hrtime.bigint());
    this.#notify([registration.nodeId]);
    const currentNode = this.store.state.nodes[registration.nodeId] || result.node;
    const executionLease = serverStateRecovery?.status === "active"
      || currentNode.failClosedFence?.status === "active"
      ? null
      : result.executionLease;
    return {
      protocolVersion: PROTOCOL_VERSION,
      node: jsonSafe(currentNode),
      commandSequence: Number(currentNode.commandSequence ?? 0),
      commandDeadLetters: result.commandDeadLetters,
      serverStateRecovery,
      executionLease,
      project: result.project,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async heartbeat(nodeIdInput, input = {}) {
    const nodeId = validateNodeId(nodeIdInput);
    if (input.protocolVersion != null) assertProtocolVersion(input.protocolVersion);
    const requestedStatus = input.status == null ? null : String(input.status);
    if (requestedStatus && !VALID_NODE_STATUS.has(requestedStatus)) {
      throw badRequest("Unknown node status", "invalid_node_status");
    }
    const ackSequence = integer(input.ackSequence, null, 0, Number.MAX_SAFE_INTEGER, "ack_sequence");
    const actionResults = normalizeActionResults(input.actionResults);
    const commandDeadLetters = normalizeCommandDeadLetters(input.commandDeadLetters, nodeId);
    const cameraCalibrationReport = input.cameraCalibration ?? input.telemetry?.cameraCalibration ?? null;
    const cameraOpticalVerificationReport = input.cameraOpticalVerification
      ?? input.telemetry?.cameraOpticalVerification
      ?? null;
    const normalizedTelemetry = telemetryFrom(input.telemetry ?? input);
    const directDiagnostics = input.diagnostics == null ? null : boundedJson(input.diagnostics, {
      label: "Node diagnostics",
      code: "node_diagnostics",
      maxBytes: 768 * 1024,
      maxDepth: 10,
      maxArrayLength: 512,
      maxObjectKeys: 512,
      maxStringLength: 64 * 1024,
    });
    const persistedAckSequence = Number(this.store.state.nodes[nodeId]?.ackSequence ?? 0);
    const durableHeartbeat = actionResults.length > 0
      || commandDeadLetters.length > 0
      || cameraCalibrationReport != null
      || cameraOpticalVerificationReport != null
      || (ackSequence != null && ackSequence > persistedAckSequence);
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    const result = await this.store.transaction((state) => {
      // Capture all durable evidence time only after this request owns the
      // serialized transaction. A request may wait behind a slow fsync; using
      // its arrival time would make a newly minted fence appear to exceed its
      // bounded lease-drain window on the very next hydrate.
      const now = new Date().toISOString();
      const host = input.host == null ? null : normalizeHostSnapshot(input.host, now);
      let durableTransition = false;
      const synchronizedNodeIds = [];
      const node = state.nodes[nodeId];
      if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
      if (ackSequence != null && ackSequence > Number(node.commandSequence ?? 0)) {
        throw badRequest(
          "ackSequence cannot acknowledge another node's or an unissued command sequence",
          "ack_sequence_out_of_range",
        );
      }
      assertHostActionAckEvidence(
        state,
        nodeId,
        Number(node.ackSequence ?? 0),
        ackSequence,
        actionResults,
      );
      node.lastSeenAt = now;
      node.status = requestedStatus || node.status || NODE_STATUS.IDLE;
      node.telemetry = normalizedTelemetry;
      if (host) {
        node.host = host;
        node.hostUpdatedAt = now;
      }
      if (directDiagnostics) {
        node.latestDiagnostics = {
          capturedAt: now,
          source: "heartbeat",
          data: directDiagnostics,
        };
      }
      if (ackSequence != null) {
        node.ackSequence = Math.max(Number(node.ackSequence ?? 0), ackSequence);
        const queue = state.commandQueues[nodeId] ?? [];
        state.commandQueues[nodeId] = queue.filter((command) => command.sequence > node.ackSequence);
        node.requiresResync = false;
      }
      state.commandDeadLetters ??= {};
      state.commandDeadLetters[nodeId] ??= [];
      const acknowledgedCommandDeadLetters = [];
      for (const incoming of commandDeadLetters) {
        const records = state.commandDeadLetters[nodeId];
        const existing = records.find((record) => record.deadLetterId === incoming.deadLetterId);
        if (existing) {
          if (!sameCommandDeadLetter(existing, incoming)) {
            throw conflict(
              "Command dead-letter replay changed its durable evidence",
              "command_dead_letter_replay_mismatch",
              { deadLetterId: incoming.deadLetterId },
            );
          }
          acknowledgedCommandDeadLetters.push({
            deadLetterId: existing.deadLetterId,
            sequence: existing.command.sequence,
            receivedAt: existing.receivedAt,
          });
          continue;
        }
        const sequenceConflict = records.find((record) => record.command?.sequence === incoming.command.sequence);
        if (sequenceConflict) {
          throw conflict(
            "Command sequence already has different dead-letter evidence",
            "command_dead_letter_sequence_conflict",
            { sequence: incoming.command.sequence, deadLetterId: sequenceConflict.deadLetterId },
          );
        }
        const queue = state.commandQueues[nodeId] ?? [];
        const pending = queue.filter((command) => command.sequence > Number(node.ackSequence ?? 0));
        const queued = pending[0];
        const queuedMatches = queued != null
          && queued.id === incoming.command.id
          && queued.sequence === incoming.command.sequence
          && queued.type === incoming.command.type;
        const supersedingDeadLetter = queuedMatches ? null : Object.values(state.commandDeadLetters)
          .flat()
          .find((record) => record.compensation?.supersededCommands?.some((reference) => (
            reference.nodeId === nodeId
            && reference.id === incoming.command.id
            && reference.sequence === incoming.command.sequence
            && reference.type === incoming.command.type
          )));
        if (!queuedMatches && !supersedingDeadLetter) {
          throw conflict(
            "Dead-letter evidence does not identify the next ordered queued command",
            "command_dead_letter_queue_mismatch",
            {
              expected: queued == null ? null : { id: queued.id, sequence: queued.sequence, type: queued.type },
              received: incoming.command,
            },
          );
        }
        const expectedSafetyCritical = isSafetyCriticalCommand(queuedMatches ? queued : incoming.command);
        if (incoming.safetyCritical !== expectedSafetyCritical) {
          throw conflict(
            "Dead-letter safety classification differs from the authoritative command",
            "command_dead_letter_safety_mismatch",
            { sequence: incoming.command.sequence, expectedSafetyCritical },
          );
        }
        const retainedAt = new Date().toISOString();
        const retained = {
          ...incoming,
          receivedAt: retainedAt,
          status: "dead-lettered",
          recovery: {
            status: "operator-review-required",
            reviewedAt: null,
            disposition: null,
            replacementCommand: null,
          },
          queueDisposition: "removed-after-durable-evidence",
        };
        const emergencyEvidence = supersedingDeadLetter != null
          || TIMELINE_DEAD_LETTER_TYPES.has(queued?.type);
        if (records.length >= MAX_COMMAND_DEAD_LETTERS_PER_NODE && !emergencyEvidence) {
          throw conflict(
            "Command dead-letter audit capacity is exhausted; operator archival is required",
            "command_dead_letter_capacity",
          );
        }
        // The record, owner terminalization, exact queue-head removal and any
        // peer fail-closed compensation publish in one copy-on-write store
        // transaction. A disk/rename failure exposes none of these mutations.
        const owner = supersedingDeadLetter
          ? null
          : terminalizeDeadLetterOwner(state, nodeId, queued, retained);
        if (!supersedingDeadLetter) {
          state.commandQueues[nodeId] = queue.filter((command) => command.id !== queued.id);
        }
        const compensation = supersedingDeadLetter
          ? {
            timelineInvalidated: false,
            targetNodeIds: [],
            supersededCommands: [],
            commands: [],
            fences: [],
            inheritedFrom: supersedingDeadLetter.deadLetterId,
          }
          : compensateTimelineDeadLetter(
            state,
            nodeId,
            queued,
            retained,
          );
        retained.compensation = { ...compensation, owner };
        records.push(retained);
        synchronizedNodeIds.push(...compensation.targetNodeIds);
        node.latestCommandDeadLetter = {
          deadLetterId: retained.deadLetterId,
          command: retained.command,
          safetyCritical: retained.safetyCritical,
          receivedAt: retained.receivedAt,
          recoveryStatus: retained.recovery.status,
        };
        node.commandDeadLetterCount = records.length;
        if (retained.safetyCritical) {
          node.commandFailureSafetyLock = {
            status: "active",
            deadLetterId: retained.deadLetterId,
            command: retained.command,
            blackApplied: retained.failClosed?.blackApplied === true,
            enforcementError: retained.failClosed?.enforcementError || null,
            receivedAt: retained.receivedAt,
          };
        }
        acknowledgedCommandDeadLetters.push({
          deadLetterId: retained.deadLetterId,
          sequence: retained.command.sequence,
          receivedAt: retained.receivedAt,
        });
      }
      state.actionAudit ??= [];
      state.processedActionResults ??= {};
      const acknowledgedActionResultIds = [];
      for (const actionResult of actionResults) {
        const audit = [...state.actionAudit].reverse().find((entry) => (
          entry.nodeId === nodeId
          && entry.commandId === actionResult.commandId
          && entry.commandSequence === actionResult.sequence
        ));
        if (!audit || audit.actionId !== actionResult.actionId || audit.type !== actionResult.actionType) {
          throw conflict(
            "Host-action result does not match an authoritative Server-issued action command",
            "host_action_result_authority_mismatch",
            {
              resultId: actionResult.resultId,
              commandId: actionResult.commandId,
              sequence: actionResult.sequence,
            },
          );
        }
        const resultSha256 = sha256Json(actionResult);
        const retained = state.processedActionResults[actionResult.resultId];
        if (retained != null) {
          if (retained.nodeId !== nodeId || retained.auditId !== audit.id
            || retained.resultSha256 !== resultSha256
            || canonicalJson(retained.result) !== canonicalJson(actionResult)) {
            throw conflict(
              "Host-action result replay changed its durable terminal evidence",
              "host_action_result_replay_mismatch",
              { resultId: actionResult.resultId },
            );
          }
          acknowledgedActionResultIds.push(actionResult.resultId);
          continue;
        }
        if (audit.status !== "queued" || Array.isArray(audit.resultIds)) {
          throw conflict(
            "Host-action result has no unconsumed authoritative audit entry",
            "host_action_result_authority_mismatch",
            { resultId: actionResult.resultId, auditId: audit.id },
          );
        }
        state.processedActionResults[actionResult.resultId] = {
          resultId: actionResult.resultId,
          nodeId,
          auditId: audit.id,
          receivedAt: now,
          resultSha256,
          result: actionResult,
        };
        const summary = actionResultSummary(actionResult);
        audit.status = actionResult.status;
        audit.startedAt = actionResult.startedAt;
        audit.completedAt = actionResult.completedAt;
        audit.result = summary.result;
        audit.error = summary.error;
        audit.resultIds = [actionResult.resultId];
        audit.updatedAt = now;
        node.lastActionResult = { actionType: actionResult.actionType, commandId: actionResult.commandId, ...summary };
        if (actionResult.actionType === HOST_ACTION_TYPE.COLLECT_DIAGNOSTICS && actionResult.result != null) {
          node.latestDiagnostics = {
            capturedAt: actionResult.completedAt ?? now,
            source: "host-action",
            commandId: actionResult.commandId,
            data: actionResult.result?.diagnostics ?? actionResult.result,
          };
        }
        acknowledgedActionResultIds.push(actionResult.resultId);
      }
      trimAudit(state, this.maxActionAudit);
      let acknowledgedCameraCalibrationId = null;
      let acknowledgedCameraOpticalVerificationId = null;
      if (cameraCalibrationReport != null) {
        cameraCalibrationReportProcessing: {
        const report = boundedJson(cameraCalibrationReport, {
          label: "Camera calibration report", code: "camera_calibration_report", maxBytes: 64 * 1024 * 1024,
          maxDepth: 12, maxArrayLength: 100_000, maxObjectKeys: 4_096, maxStringLength: 64 * 1024,
        });
        const sessionId = String(report.sessionId || "").trim().slice(0, 128);
        const calibration = state.cameraCalibrations?.[sessionId];
        if (!calibration) throw badRequest("Node reported an unknown camera calibration", "camera_calibration_not_found");
        if (calibration.nodeId !== nodeId) throw badRequest("Camera calibration belongs to another node", "camera_calibration_node_mismatch");
        const reportState = String(report.state || "");
        if (!CAMERA_CALIBRATION_REPORT_STATES.has(reportState)) {
          throw badRequest("Camera calibration report has an invalid state", "invalid_camera_calibration_report");
        }
        if (TERMINAL_CALIBRATION_STATES.has(calibration.state)) {
          const deadLetterId = calibration.failure?.details?.deadLetterId;
          const failClosedDeadLetter = deadLetterId == null ? null : (state.commandDeadLetters?.[nodeId] || [])
            .find((record) => (
              record.deadLetterId === deadLetterId
              && record.compensation?.owner?.kind === "camera-calibration"
              && record.compensation.owner.id === calibration.sessionId
            ));
          if (calibration.failure?.code === "COMMAND_DEAD_LETTERED" && failClosedDeadLetter) {
            // The Node may finish or publish a stale terminal report after the
            // Server has durably accepted command-failure evidence (for
            // example a CONFIRM response lost on the wire). ACK the bounded
            // same-session report so the Node can compact it, but never let it
            // replace Server-owned fail-closed terminal authority.
            acknowledgedCameraCalibrationId = sessionId;
            break cameraCalibrationReportProcessing;
          }
          const terminalReportSha256 = sha256Json(report);
          if (calibration.terminalReportSha256 == null
            || terminalReportSha256 !== calibration.terminalReportSha256) {
            throw conflict(
              "Terminal camera calibration evidence cannot be replaced by a different replay",
              "camera_calibration_terminal_replay_mismatch",
              { sessionId },
            );
          }
          acknowledgedCameraCalibrationId = sessionId;
          break cameraCalibrationReportProcessing;
        }
        if (calibration.bundleId && calibration.projectPatch != null
          && reportState !== CAMERA_CALIBRATION_STATE.COMPLETE) {
          throw conflict(
            "A staged bundle member cannot be replaced by a different calibration state replay",
            "camera_calibration_bundle_member_replay",
            { bundleId: calibration.bundleId, sessionId },
          );
        }
        const completedSteps = Math.max(0, Math.min(calibration.plan.steps.length, Number(report.completedSteps) || 0));
        calibration.state = reportState;
        calibration.progress = {
          completedSteps,
          totalSteps: calibration.plan.steps.length,
          stepIndex: Math.max(-1, Math.min(calibration.plan.steps.length - 1, Number(report.stepIndex) || 0)),
        };
        calibration.camera = report.camera ?? calibration.camera ?? null;
        if (report.operatorPrompt != null) {
          const prompt = report.operatorPrompt;
          const promptState = String(prompt?.state || "");
          const promptStepId = String(prompt?.stepId || "").trim().slice(0, 256);
          const confirmationId = String(prompt?.confirmationId || "").trim().slice(0, 256);
          if (!["waiting", "confirmation-queued", "confirmed"].includes(promptState)
            || !promptStepId || !confirmationId) {
            throw badRequest("Camera calibration operator prompt is invalid", "invalid_camera_calibration_prompt");
          }
          const preserveQueued = calibration.operatorPrompt?.state === "confirmation-queued"
            && calibration.operatorPrompt?.confirmationId === confirmationId
            && promptState === "waiting";
          calibration.operatorPrompt = preserveQueued ? calibration.operatorPrompt : {
            state: promptState,
            stepId: promptStepId,
            confirmationId,
            title: String(prompt?.title || "Operator confirmation required").slice(0, 256),
            instructions: String(prompt?.instructions || "").slice(0, 4_096),
            conditions: Array.isArray(prompt?.conditions)
              ? prompt.conditions.slice(0, 32).map((condition) => String(condition).slice(0, 256))
              : [],
            requestedAt: prompt?.requestedAt == null ? null : String(prompt.requestedAt).slice(0, 64),
            confirmedAt: prompt?.confirmedAt == null ? null : String(prompt.confirmedAt).slice(0, 64),
          };
        } else if (TERMINAL_CALIBRATION_STATES.has(reportState)) {
          calibration.operatorPrompt = null;
        }
        calibration.failure = report.failure ?? null;
        calibration.startedAt = report.startedAt ?? calibration.startedAt ?? null;
        calibration.completedAt = report.completedAt ?? calibration.completedAt ?? null;
        calibration.updatedAt = now;
        if (report.manifest != null) {
          let normalizedManifest;
          try {
            normalizedManifest = normalizeCameraCalibrationManifest(report.manifest, { plan: calibration.plan });
          } catch (error) {
            throw calibrationHttpError(error);
          }
          if (calibration.manifest != null
            && sha256Json(calibration.manifest) !== sha256Json(normalizedManifest)) {
            throw conflict(
              "Camera calibration session replay changed its validated manifest",
              "camera_calibration_manifest_replay",
              { sessionId },
            );
          }
          calibration.manifest = normalizedManifest;
        }
        if (reportState === CAMERA_CALIBRATION_STATE.COMPLETE && !calibration.manifest) {
          throw badRequest("Completed camera calibration omitted its manifest", "camera_calibration_manifest_required");
        }
        if (reportState === CAMERA_CALIBRATION_STATE.COMPLETE) {
          assertServerBoundCameraConfirmations(calibration, node.ackSequence);
        }
        if (reportState === CAMERA_CALIBRATION_STATE.COMPLETE && calibration.manifest?.applicable
          && calibration.appliedRevision == null && calibration.projectPatch == null
          && report.projectPatch == null) {
          calibration.state = CAMERA_CALIBRATION_STATE.FAILED;
          calibration.failure = {
            code: "CALIBRATION_PROJECT_PATCH_REQUIRED",
            message: "Measured camera calibration omitted its verified project patch",
          };
          failCameraCalibrationBundleMember(state, calibration, calibration.failure, now);
        }
        if (reportState === CAMERA_CALIBRATION_STATE.COMPLETE
          && calibration.manifest?.applicable !== true && calibration.bundleId) {
          calibration.state = CAMERA_CALIBRATION_STATE.FAILED;
          calibration.failure = {
            code: "CALIBRATION_NOT_APPLICABLE",
            message: "Measured camera calibration did not produce applicable evidence",
          };
          failCameraCalibrationBundleMember(state, calibration, calibration.failure, now);
        }
        if (report.projectPatch != null && reportState !== CAMERA_CALIBRATION_STATE.COMPLETE) {
          throw badRequest(
            "Camera calibration project patch is accepted only with a completed session report",
            "camera_calibration_project_patch_premature",
          );
        }
        if (report.projectPatch != null && calibration.appliedRevision == null
          && calibration.projectPatch == null) {
          const activeVerification = Object.values(state.cameraCalibrations || {}).find((candidate) => (
            ACTIVE_OPTICAL_VERIFICATION_STATES.has(candidate?.opticalVerification?.state)
          ));
          if (activeVerification) {
            throw conflict(
              `Calibration project commit is locked by optical verification ${activeVerification.opticalVerification.verificationId}`,
              "camera_optical_verification_busy",
              {
                nodeId: activeVerification.nodeId,
                sessionId: activeVerification.sessionId,
                verificationId: activeVerification.opticalVerification.verificationId,
                operation: "camera-calibration-project-commit",
              },
            );
          }
          const activeBundleCommit = activeCameraCalibrationBundleCommit(state);
          if (activeBundleCommit && activeBundleCommit.bundle?.bundleId !== calibration.bundleId) {
            throw conflict(
              `Calibration project commit is locked by bundle ${activeBundleCommit.bundle?.bundleId}`,
              "camera_calibration_bundle_commit_busy",
              { bundleId: activeBundleCommit.bundle?.bundleId, operation: "camera-calibration-project-commit" },
            );
          }
          if (!calibration.manifest) {
            throw badRequest("Calibration project patch requires a validated manifest", "camera_calibration_manifest_required");
          }
          let patch;
          try {
            patch = validateCameraCalibrationProjectPatch(
              report.projectPatch,
              calibration.manifest,
              state.project,
              { nodeId },
            );
          } catch (error) {
            const rejected = error instanceof CameraCalibrationError
              ? error
              : new CameraCalibrationError("INVALID_CALIBRATION_PROJECT_PATCH", error?.message || "Calibration patch was rejected");
            calibration.state = CAMERA_CALIBRATION_STATE.FAILED;
            calibration.failure = {
              code: rejected.code,
              message: rejected.message,
              details: rejected.details ?? null,
            };
            calibration.projectApplied = false;
            calibration.projectCommitted = false;
            calibration.rendererAcknowledged = false;
            calibration.rendererAcknowledgedAt = null;
            calibration.rendererCorrectionBinding = null;
            calibration.opticalVerification = {
              state: "blocked",
              required: true,
              verifiedAt: null,
              reason: "project-patch-rejected",
            };
            calibration.updatedAt = now;
            failCameraCalibrationBundleMember(state, calibration, calibration.failure, now);
            calibration.terminalReportSha256 = sha256Json(report);
            acknowledgedCameraCalibrationId = sessionId;
            return {
              node,
              commandSequence: Number(node.commandSequence ?? 0),
              acknowledgedActionResultIds,
              acknowledgedCommandDeadLetters,
              acknowledgedCameraCalibrationId,
              acknowledgedCameraOpticalVerificationId,
              synchronizedNodeIds,
              durableTransition,
            };
          }
          if (calibration.bundleId) {
            stageCameraCalibrationBundleMember(state, calibration, patch, now);
          } else {
            const updates = new Map(patch.outputs.map((output) => [output.id, output]));
            calibration.preApplyProjectRevision = state.project.revision;
            calibration.preApplyOutputs = state.project.outputs
              .filter((output) => updates.has(output.id))
              .map((output) => structuredClone(output));
            const outputs = state.project.outputs.map((output) => updates.get(output.id) || output);
            const targetRevision = nextProjectRevision(
              state.project.revision,
              "camera-calibration-project-commit",
            );
            state.project = normalizeProject({
              ...state.project,
              revision: targetRevision,
              outputs,
            });
            supersedeAppliedCameraCalibrations(state, {
              currentSessionId: sessionId,
              projectRevision: state.project.revision,
              at: now,
            });
            calibration.projectApplied = true;
            calibration.projectCommitted = true;
            calibration.currentlyApplied = true;
            calibration.appliedRevision = state.project.revision;
            calibration.rendererAcknowledged = false;
            calibration.rendererAcknowledgedAt = null;
            calibration.rendererCorrectionBinding = null;
            calibration.opticalVerification = {
              state: "pending-renderer-ack",
              required: true,
              verifiedAt: null,
              reason: null,
            };
            calibration.updatedAt = now;
            invalidatePreparedTimeline(state);
            synchronizedNodeIds.push(...Object.keys(state.nodes));
            for (const targetNodeId of synchronizedNodeIds) {
              queueCommand(state, targetNodeId, COMMAND.SYNC_PROJECT, {
                project: projectForNode(state, targetNodeId, this.requireExplicitOutputOwnership),
                revision: state.project.revision,
                reason: "camera-calibration",
                sessionId,
              });
            }
          }
        }
        if ([CAMERA_CALIBRATION_STATE.FAILED, "cancelled"].includes(calibration.state)) {
          failCameraCalibrationBundleMember(state, calibration, calibration.failure, now);
        }
        if (TERMINAL_CALIBRATION_STATES.has(calibration.state)) {
          calibration.terminalReportSha256 = sha256Json(report);
        }
        acknowledgedCameraCalibrationId = sessionId;
        }
      }

      if (cameraOpticalVerificationReport != null) {
        const submittedState = boundedCameraOpticalVerificationState(cameraOpticalVerificationReport);
        const sessionId = String(submittedState.calibrationSessionId || "").trim().slice(0, 128);
        const calibration = state.cameraCalibrations?.[sessionId];
        if (!calibration) {
          throw badRequest(
            "Node reported an unknown camera optical verification",
            "camera_optical_verification_not_found",
          );
        }
        const plan = opticalPlan(calibration);
        const currentRuntime = opticalRuntime(calibration);
        if (!plan || !currentRuntime) {
          throw conflict(
            "Camera optical verification has no authoritative Server plan",
            "camera_optical_verification_not_started",
          );
        }
        if (calibration.nodeId !== nodeId || plan.nodeId !== nodeId) {
          throw badRequest(
            "Camera optical verification belongs to another node",
            "camera_optical_verification_node_mismatch",
          );
        }

        let incomingRuntime;
        try {
          incomingRuntime = normalizeCameraOpticalVerificationState(submittedState, { plan });
        } catch (error) {
          throw cameraOpticalVerificationHttpError(error);
        }
        if (incomingRuntime.verificationId !== currentRuntime.verificationId) {
          throw conflict(
            "Camera optical verification report belongs to a stale attempt",
            "camera_optical_verification_attempt_mismatch",
          );
        }
        const opticalDeadLetterOwner = calibration.opticalVerification?.reason === "command-dead-lettered"
          ? Object.values(state.commandDeadLetters || {}).flat().find((record) => (
            record.nodeId === nodeId
            && record.compensation?.owner?.kind === "camera-optical-verification"
            && record.compensation.owner.id === currentRuntime.verificationId
            && record.compensation.owner.state === currentRuntime.state
            && record.deadLetterId === currentRuntime.failure?.details?.deadLetterId
          ))
          : null;
        if (opticalDeadLetterOwner) {
          // A stale retransmission can cross the dead-letter response. ACK the
          // same attempt against the exact durable owner without replacing the
          // stricter Server-owned fail-closed runtime.
          incomingRuntime = currentRuntime;
        }
        assertServerBoundOpticalConfirmations(
          calibration.opticalVerification,
          incomingRuntime,
          node.ackSequence,
        );

        const incomingCancellation = incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED;
        const authoritativeCancelCommand = calibration.opticalVerification?.cancelCommand;
        const incomingCancelledFailClosedBlock = incomingRuntime.state
          === CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED
          && incomingRuntime.report == null
          && incomingRuntime.failure?.code === "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED"
          && authoritativeCancelCommand?.type === COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION;
        const incomingCancellationOutcome = incomingCancellation || incomingCancelledFailClosedBlock;
        if (incomingCancellationOutcome) {
          const cancelCommand = authoritativeCancelCommand;
          const cancelSequence = Number(cancelCommand?.sequence ?? 0);
          if (cancelCommand?.type !== COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION
            || !String(cancelCommand?.id || "")
            || !Number.isSafeInteger(cancelSequence)
            || cancelSequence < 1
            || Number(node.ackSequence ?? 0) < cancelSequence
            || (incomingCancellation
              ? incomingRuntime.failure?.code !== "OPTICAL_VERIFICATION_CANCELLED"
              : incomingRuntime.failure?.code !== "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED")
            || calibration.opticalVerification?.cancelRequestedAt == null
            || Date.parse(incomingRuntime.completedAt) < Date.parse(calibration.opticalVerification.cancelRequestedAt)) {
            throw conflict(
              "Cancelled optical verification is not backed by an acknowledged authoritative Server command",
              "camera_optical_verification_cancel_not_acknowledged",
            );
          }
        }

        const reportChanged = currentRuntime.report != null && incomingRuntime.report != null
          && JSON.stringify(currentRuntime.report) !== JSON.stringify(incomingRuntime.report);
        if (reportChanged) {
          throw conflict(
            "Camera optical verification replay changed its conclusive evidence",
            "camera_optical_verification_replay",
          );
        }
        if (incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
          && (calibration.currentlyApplied !== true
            || Number(state.project?.revision) !== Number(plan.project.appliedRevision))) {
          throw conflict(
            "Verified optical evidence no longer belongs to the current applied project revision",
            "camera_optical_verification_revision_mismatch",
          );
        }

        if (currentRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK) {
          if (incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK) {
            const restoreSequence = Number(calibration.opticalVerification?.restoreCommand?.sequence ?? 0);
            const targetRevision = Number(currentRuntime.rollback?.targetRevision);
            const exactRestoredRevision = Number.isSafeInteger(targetRevision)
              && Number(state.project?.revision) === targetRevision
              && Number(node.telemetry?.projectRevision) === targetRevision
              && Number(node.telemetry?.renderer?.projectRevision) === targetRevision
              && node.telemetry?.renderer?.ready === true
              && node.telemetry?.renderer?.connected === true;
            if (restoreSequence < 1 || Number(node.ackSequence ?? 0) < restoreSequence || !exactRestoredRevision) {
              throw conflict(
                "Rollback restoration cannot complete before the restore command and exact renderer revision are acknowledged",
                "camera_optical_verification_restore_not_acknowledged",
              );
            }
            let restoredRuntime;
            try {
              restoredRuntime = normalizeCameraOpticalVerificationState({
                ...currentRuntime,
                state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
                updatedAt: incomingRuntime.updatedAt,
                completedAt: incomingRuntime.completedAt,
                rollback: {
                  ...currentRuntime.rollback,
                  state: "restored",
                  restoredAt: incomingRuntime.rollback?.restoredAt,
                },
              }, { plan });
            } catch (error) {
              throw cameraOpticalVerificationHttpError(error);
            }
            calibration.opticalVerification = mirrorOpticalRuntime(
              calibration.opticalVerification,
              restoredRuntime,
              {
                reason: currentRuntime.rollback.trigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
                  ? "optical-verification-cancelled"
                  : "optical-verification-failed",
                verifiedAt: null,
              },
            );
            calibration.updatedAt = restoredRuntime.updatedAt;
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          } else if (incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED) {
            const triggerEvidenceMatches = currentRuntime.rollback.trigger
              === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
              ? incomingRuntime.report == null
                && [
                  "OPTICAL_VERIFICATION_CANCELLED",
                  "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
                ].includes(incomingRuntime.failure?.code)
              : incomingRuntime.report?.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED;
            if (!triggerEvidenceMatches) {
              throw conflict(
                "A blocked rollback must retain evidence for its exact Server-owned trigger",
                "camera_optical_verification_rollback_evidence_missing",
              );
            }
            if (incomingRuntime.rollback?.sourceRevision !== currentRuntime.rollback?.sourceRevision
              || incomingRuntime.rollback?.targetRevision !== currentRuntime.rollback?.targetRevision) {
              throw conflict(
                "Node rollback failure does not belong to the Server-owned rollback revision",
                "camera_optical_verification_rollback_revision_mismatch",
              );
            }
            let blockedRuntime;
            try {
              blockedRuntime = normalizeCameraOpticalVerificationState({
                ...currentRuntime,
                state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
                updatedAt: incomingRuntime.updatedAt,
                completedAt: incomingRuntime.completedAt,
                failure: incomingRuntime.failure ?? currentRuntime.failure,
                rollback: {
                  ...currentRuntime.rollback,
                  state: "blocked",
                  reason: incomingRuntime.rollback.reason,
                  restoredAt: null,
                },
              }, { plan });
            } catch (error) {
              throw cameraOpticalVerificationHttpError(error);
            }
            calibration.opticalVerification = mirrorOpticalRuntime(
              calibration.opticalVerification,
              blockedRuntime,
              { reason: "automatic-rollback-restore-blocked", verifiedAt: null },
            );
            calibration.updatedAt = blockedRuntime.updatedAt;
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          } else {
            const triggerEvidenceMatches = currentRuntime.rollback.trigger
              === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
              ? incomingRuntime.report == null
                && ((incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
                  && incomingRuntime.failure?.code === "OPTICAL_VERIFICATION_CANCELLED")
                  || (incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED
                    && incomingRuntime.failure?.code === "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED"))
              : incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED
                && incomingRuntime.report?.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED;
            if (!triggerEvidenceMatches) {
              throw conflict(
                "Server rollback ownership cannot be replaced by evidence for another trigger",
                "camera_optical_verification_rollback_in_progress",
              );
            }
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          }
        } else if ([
          CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
          CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
          CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
          CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED,
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
        ].includes(currentRuntime.state)) {
          const failedReplayAfterServerRollback = [
            CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
            CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
          ].includes(currentRuntime.state)
            && incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED
            && currentRuntime.report != null
            && incomingRuntime.report != null;
          if (incomingRuntime.state !== currentRuntime.state && !failedReplayAfterServerRollback) {
            throw conflict(
              "Terminal camera optical verification state cannot be replaced by a different replay",
              "camera_optical_verification_replay",
            );
          }
          if (currentRuntime.report != null && incomingRuntime.report == null) {
            throw conflict(
              "Terminal camera optical verification replay omitted its conclusive evidence",
              "camera_optical_verification_replay",
            );
          }
          acknowledgedCameraOpticalVerificationId = plan.verificationId;
        } else if ([
          CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
          CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
        ].includes(incomingRuntime.state) || incomingCancelledFailClosedBlock) {
          const rollbackTrigger = incomingCancellationOutcome
            ? CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
            : CAMERA_OPTICAL_ROLLBACK_TRIGGER.FAILED;
          const appliedRevision = Number(plan.project.appliedRevision);
          const expectedOutputIds = plan.outputs.map((output) => output.id);
          const snapshotOutputs = cameraCalibrationBundlePreApplyOutputs(state, calibration);
          let rollbackProject = null;
          let rollbackTargetRevision = null;
          let rollbackBlockedReason = null;
          if (calibration.currentlyApplied !== true
            || Number(state.project?.revision) !== appliedRevision
            || state.project?.id !== plan.project.id) {
            rollbackBlockedReason = "The applied project revision moved before automatic rollback could commit";
          } else if (!Array.isArray(snapshotOutputs)
            || snapshotOutputs.length !== expectedOutputIds.length
            || Number(calibration.preApplyProjectRevision) !== Number(plan.project.baseRevision)) {
            rollbackBlockedReason = "The exact pre-apply output snapshot is unavailable or incomplete";
          } else {
            const snapshotById = new Map(snapshotOutputs.map((output) => [output?.id, output]));
            const currentOutputIds = new Set(state.project.outputs.map((output) => output.id));
            if (snapshotById.size !== expectedOutputIds.length
              || expectedOutputIds.some((outputId) => !snapshotById.has(outputId) || !currentOutputIds.has(outputId))) {
              rollbackBlockedReason = "The pre-apply output snapshot no longer matches the authoritative output set";
            } else {
              try {
                rollbackTargetRevision = nextProjectRevision(
                  appliedRevision,
                  "camera-optical-verification-rollback",
                );
                rollbackProject = normalizeProject({
                  ...state.project,
                  revision: rollbackTargetRevision,
                  updatedAt: now,
                  outputs: state.project.outputs.map((output) => (
                    snapshotById.has(output.id) ? structuredClone(snapshotById.get(output.id)) : output
                  )),
                });
                if (Number(rollbackProject.revision) !== rollbackTargetRevision) {
                  rollbackBlockedReason = "Rollback project normalization did not preserve the required target revision";
                  rollbackProject = null;
                } else if (expectedOutputIds.some((outputId) => {
                  const restored = rollbackProject.outputs.find((output) => output.id === outputId);
                  return JSON.stringify(restored) !== JSON.stringify(snapshotById.get(outputId));
                })) {
                  rollbackBlockedReason = "The pre-apply output snapshot is not an exact canonical project output";
                  rollbackProject = null;
                }
              } catch (error) {
                rollbackBlockedReason = `The pre-apply output snapshot is invalid: ${error?.message || "normalization failed"}`;
              }
            }
          }

          if (rollbackProject == null) {
            let blockedRuntime;
            try {
              blockedRuntime = normalizeCameraOpticalVerificationState({
                ...incomingRuntime,
                state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
                updatedAt: now,
                completedAt: now,
                rollback: {
                  state: "blocked",
                  trigger: rollbackTrigger,
                  sourceRevision: appliedRevision,
                  targetRevision: null,
                  reason: rollbackBlockedReason || "Automatic rollback was blocked",
                  rendererAcknowledgedAt: null,
                  restoredAt: null,
                },
              }, { plan });
            } catch (error) {
              throw cameraOpticalVerificationHttpError(error);
            }
            calibration.opticalVerification = mirrorOpticalRuntime(
              calibration.opticalVerification,
              blockedRuntime,
              {
                reason: rollbackTrigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
                  ? "automatic-cancellation-rollback-blocked"
                  : "automatic-rollback-blocked",
                verifiedAt: null,
              },
            );
            if (Number(state.project?.revision) !== appliedRevision) calibration.currentlyApplied = false;
            calibration.updatedAt = now;
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          } else {
            const rollbackReason = rollbackTrigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
              ? "Optical verification cancelled; restore exact pre-apply outputs"
              : "Optical verification failed; restore exact pre-apply outputs";
            let awaitingRendererRuntime;
            try {
              awaitingRendererRuntime = normalizeCameraOpticalVerificationState({
                ...incomingRuntime,
                state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
                updatedAt: now,
                completedAt: null,
                rollback: {
                  state: "renderer-ack",
                  trigger: rollbackTrigger,
                  sourceRevision: appliedRevision,
                  targetRevision: rollbackTargetRevision,
                  reason: rollbackReason,
                  rendererAcknowledgedAt: null,
                  restoredAt: null,
                },
              }, { plan });
            } catch (error) {
              throw cameraOpticalVerificationHttpError(error);
            }
            state.project = rollbackProject;
            invalidatePreparedTimeline(state);
            calibration.currentlyApplied = false;
            calibration.opticalVerification = mirrorOpticalRuntime(
              calibration.opticalVerification,
              awaitingRendererRuntime,
              {
                reason: rollbackTrigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
                  ? "optical-verification-cancelled"
                  : "optical-verification-failed",
                verifiedAt: null,
                rollbackCommittedAt: now,
                restoreCommand: null,
              },
            );
            calibration.updatedAt = now;
            const targetNodeIds = Object.keys(state.nodes);
            synchronizedNodeIds.push(...targetNodeIds);
            for (const targetNodeId of targetNodeIds) {
              queueCommand(state, targetNodeId, COMMAND.SYNC_PROJECT, {
                project: projectForNode(state, targetNodeId, this.requireExplicitOutputOwnership),
                revision: rollbackProject.revision,
                reason: "camera-optical-verification-rollback",
                sessionId,
                verificationId: plan.verificationId,
              });
            }
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          }
        } else if ([
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
          CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
        ].includes(incomingRuntime.state)) {
          throw conflict(
            "Only the Server may initiate or advance an automatic rollback",
            "camera_optical_verification_rollback_owned_by_server",
          );
        } else {
          const preserveQueuedConfirmation = currentRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
            && currentRuntime.operatorPrompt?.state === "confirmation-queued"
            && incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
            && incomingRuntime.operatorPrompt?.state === "waiting"
            && incomingRuntime.operatorPrompt?.confirmationId === currentRuntime.operatorPrompt.confirmationId;
          const activePhase = new Map([
            [CAMERA_OPTICAL_VERIFICATION_STATE.PENDING, 0],
            [CAMERA_OPTICAL_VERIFICATION_STATE.QUEUED, 1],
            [CAMERA_OPTICAL_VERIFICATION_STATE.PREFLIGHT, 2],
            [CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR, 3],
            [CAMERA_OPTICAL_VERIFICATION_STATE.CAPTURING, 4],
            [CAMERA_OPTICAL_VERIFICATION_STATE.EVALUATING, 5],
          ]);
          const stalePhase = incomingRuntime.progress.completedSteps === currentRuntime.progress.completedSteps
            && activePhase.has(incomingRuntime.state)
            && activePhase.has(currentRuntime.state)
            && activePhase.get(incomingRuntime.state) < activePhase.get(currentRuntime.state);
          const staleProgress = incomingRuntime.progress.completedSteps < currentRuntime.progress.completedSteps
            || stalePhase;
          if (!preserveQueuedConfirmation && !staleProgress) {
            calibration.opticalVerification = mirrorOpticalRuntime(calibration.opticalVerification, incomingRuntime, {
              reason: null,
              verifiedAt: incomingRuntime.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
                ? incomingRuntime.completedAt
                : null,
            });
            calibration.updatedAt = now;
          }
          if ([
            CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
            CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
            CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
            CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED,
          ].includes(incomingRuntime.state)) {
            acknowledgedCameraOpticalVerificationId = plan.verificationId;
          }
        }
      }

      for (const calibration of Object.values(state.cameraCalibrations || {})) {
        if (calibration?.nodeId !== nodeId
          || calibration?.state !== CAMERA_CALIBRATION_STATE.COMPLETE
          || calibration?.projectCommitted !== true
          || calibration?.rendererAcknowledged === true
          || !new Set(["pending-renderer-ack", "pending-bundle-renderer-ack"])
            .has(calibration?.opticalVerification?.state)
          || opticalRuntime(calibration) != null
          || Number(calibration?.appliedRevision) !== Number(node.telemetry?.projectRevision)
          || Number(calibration?.appliedRevision) !== Number(node.telemetry?.renderer?.projectRevision)
          || node.telemetry?.renderer?.ready !== true
          || node.telemetry?.renderer?.connected !== true) continue;
        const rendererCorrectionBinding = observedCalibrationRendererCorrectionBinding(
          calibration,
          node.telemetry?.renderer,
        );
        if (rendererCorrectionBinding == null) continue;
        calibration.rendererAcknowledged = true;
        calibration.rendererAcknowledgedAt = now;
        calibration.rendererCorrectionBinding = rendererCorrectionBinding;
        calibration.opticalVerification = calibration.bundleId
          ? {
            state: "pending-bundle-optical-verification",
            required: true,
            verifiedAt: null,
            reason: "bundle-verification-node-wiring-required",
          }
          : {
            state: "pending-optical-capture",
            required: true,
            verifiedAt: null,
            reason: null,
          };
        calibration.updatedAt = now;
        durableTransition = true;
      }
      durableTransition = acknowledgeCameraCalibrationBundleRenderer(state, now) || durableTransition;

      for (const calibration of Object.values(state.cameraCalibrations || {})) {
        const plan = opticalPlan(calibration);
        const runtime = opticalRuntime(calibration);
        const targetRevision = Number(runtime?.rollback?.targetRevision);
        if (calibration?.nodeId !== nodeId
          || !plan
          || runtime?.state !== CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK
          || runtime.rollback?.rendererAcknowledgedAt != null
          || calibration.opticalVerification?.restoreCommand != null
          || !Number.isSafeInteger(targetRevision)
          || Number(state.project?.revision) !== targetRevision
          || Number(node.telemetry?.projectRevision) !== targetRevision
          || Number(node.telemetry?.renderer?.projectRevision) !== targetRevision
          || node.telemetry?.renderer?.ready !== true
          || node.telemetry?.renderer?.connected !== true) continue;
        let rendererAcknowledgedRuntime;
        try {
          rendererAcknowledgedRuntime = normalizeCameraOpticalVerificationState({
            ...runtime,
            updatedAt: now,
            rollback: {
              ...runtime.rollback,
              rendererAcknowledgedAt: now,
            },
          }, { plan });
        } catch (error) {
          throw cameraOpticalVerificationHttpError(error);
        }
        const command = queueCommand(state, nodeId, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK, {
          verificationId: plan.verificationId,
          leaseToken: plan.leaseToken,
          calibrationSessionId: plan.calibrationSessionId,
          projectRevision: targetRevision,
        });
        calibration.opticalVerification = mirrorOpticalRuntime(
          calibration.opticalVerification,
          rendererAcknowledgedRuntime,
          {
            restoreCommand: { id: command.id, sequence: command.sequence, type: command.type },
            restoreRequestedAt: now,
          },
        );
        calibration.updatedAt = now;
        synchronizedNodeIds.push(nodeId);
        durableTransition = true;
      }
      const executionLease = mintExecutionLease(
        state,
        nodeId,
        this.executionLeaseTtlMs,
        serverStateRecovery,
      );
      return {
        node,
        executionLease,
        commandSequence: Number(node.commandSequence ?? 0),
        acknowledgedActionResultIds,
        acknowledgedCommandDeadLetters,
        acknowledgedCameraCalibrationId,
        acknowledgedCameraOpticalVerificationId,
        synchronizedNodeIds,
        durableTransition,
      };
    }, {
      persist: durableHeartbeat,
      schedulePersist: false,
      persistWhen: (_state, transactionResult) => transactionResult?.durableTransition === true,
      // Dead-letter publication also creates fleet fence timing evidence. Run
      // the exact restart validator before exposing that safety transition;
      // the other report/result paths use their dedicated canonical validators.
      validateBeforePersist: commandDeadLetters.length > 0,
    });
    this.liveNodeSeenNs.set(nodeId, process.hrtime.bigint());
    if (result.synchronizedNodeIds.length > 0) this.#notify([...new Set(result.synchronizedNodeIds)]);
    if (result.acknowledgedCommandDeadLetters.length > 0) this.#notify([nodeId]);
    const currentNode = this.store.state.nodes[nodeId] || result.node;
    const executionLease = serverStateRecovery?.status === "active"
      || currentNode.failClosedFence?.status === "active"
      ? null
      : result.executionLease;
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      serverTimeNs: epochNowNs().toString(),
      commandSequence: result.commandSequence,
      ackSequence: Number(currentNode.ackSequence ?? 0),
      serverStateRecovery,
      failClosedFence: currentNode.failClosedFence ?? null,
      executionLease,
      acknowledgedActionResultIds: result.acknowledgedActionResultIds,
      acknowledgedCommandDeadLetterIds: result.acknowledgedCommandDeadLetters.map((item) => item.deadLetterId),
      acknowledgedCommandDeadLetters: result.acknowledgedCommandDeadLetters,
      acknowledgedCameraCalibrationId: result.acknowledgedCameraCalibrationId,
      acknowledgedCameraOpticalVerificationId: result.acknowledgedCameraOpticalVerificationId,
    };
  }

  getNodeDetail(nodeIdInput) {
    const nodeId = validateNodeId(nodeIdInput);
    const snapshot = this.store.snapshot();
    const node = snapshot.nodes[nodeId];
    if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    const stale = !this.#nodeIsLive(nodeId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      node: { ...node, status: stale ? NODE_STATUS.OFFLINE : node.status },
      readiness: this.nodeReadiness(nodeId),
      recentActions: snapshot.actionAudit
        .filter((entry) => entry.nodeId === nodeId)
        .slice(-20)
        .reverse(),
      recentCommandDeadLetters: (snapshot.commandDeadLetters?.[nodeId] || []).slice(-100).reverse(),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  getNodeDiagnostics(nodeIdInput) {
    const detail = this.getNodeDetail(nodeIdInput);
    const snapshot = this.store.snapshot();
    const nodeId = detail.node.nodeId;
    return {
      protocolVersion: PROTOCOL_VERSION,
      nodeId,
      status: detail.node.status,
      host: detail.node.host ?? null,
      hostUpdatedAt: detail.node.hostUpdatedAt ?? null,
      telemetry: detail.node.telemetry,
      readiness: detail.readiness,
      latestDiagnostics: detail.node.latestDiagnostics ?? null,
      lastActionResult: detail.node.lastActionResult ?? null,
      actions: snapshot.actionAudit
        .filter((entry) => entry.nodeId === nodeId)
        .slice(-100)
        .reverse(),
      commandDeadLetters: (snapshot.commandDeadLetters?.[nodeId] || []).slice().reverse(),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async requestHostAction(nodeIdInput, input, { requestedBy = "api" } = {}) {
    const nodeId = validateNodeId(nodeIdInput);
    if (!this.store.state.nodes[nodeId]) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    assertOpticalVerificationNodeAvailable(this.store.state, nodeId, "host-action");
    const request = normalizeActionRequest(input);
    const isPowerAction = POWER_ACTION_TYPES.has(request.type);
    const expectedPhrase = expectedConfirmationPhrase(request.type, nodeId);
    const requestedAt = new Date().toISOString();
    const actor = String(requestedBy || "api").slice(0, 256);

    if (isPowerAction && !this.allowPowerActions) {
      await this.#auditRejectedHostAction({
        nodeId,
        request,
        requestedAt,
        actor,
        reason: "Power actions are disabled on this server",
        code: "power_actions_disabled",
      });
      throw forbidden("Power actions are disabled on this server", "power_actions_disabled");
    }
    if (isPowerAction && request.confirmationPhrase !== expectedPhrase) {
      await this.#auditRejectedHostAction({
        nodeId,
        request,
        requestedAt,
        actor,
        reason: "Confirmation phrase did not match",
        code: "confirmation_phrase_mismatch",
      });
      throw badRequest("Power action confirmation phrase does not match", "confirmation_phrase_mismatch", {
        expected: expectedPhrase,
      });
    }
    if (isPowerAction && !this.powerActionToken) {
      await this.#auditRejectedHostAction({
        nodeId,
        request,
        requestedAt,
        actor,
        reason: "Server power confirmation token is not configured",
        code: "power_confirmation_unconfigured",
      });
      throw new HttpError(
        503,
        "power_confirmation_unconfigured",
        "Power actions require PB_POWER_ACTION_TOKEN on the server and a matching node confirmation token",
      );
    }

    const actionId = makeId("action");
    const result = await this.store.transaction((state) => {
      const node = state.nodes[nodeId];
      if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
      assertOpticalVerificationNodeAvailable(state, nodeId, "host-action");
      const action = {
        id: actionId,
        type: request.type,
        payload: request.payload,
        ...(isPowerAction ? { confirmationToken: this.powerActionToken } : {}),
      };
      const command = queueCommand(state, nodeId, COMMAND.HOST_ACTION, { action });
      const audit = {
        id: makeId("audit"),
        actionId,
        nodeId,
        type: request.type,
        payload: request.payload,
        status: "queued",
        requestedAt,
        requestedBy: actor,
        confirmationRequired: isPowerAction,
        confirmationPhraseAccepted: isPowerAction ? true : null,
        commandId: command.id,
        commandSequence: command.sequence,
        createdAtNs: command.createdAtNs,
        updatedAt: requestedAt,
      };
      state.actionAudit ??= [];
      state.actionAudit.push(audit);
      trimAudit(state, this.maxActionAudit);
      return { action: audit, command };
    });
    this.#notify([nodeId]);
    return {
      protocolVersion: PROTOCOL_VERSION,
      action: {
        ...result.action,
        id: result.action.actionId,
        auditId: result.action.id,
      },
      command: {
        id: result.command.id,
        sequence: result.command.sequence,
        type: result.command.type,
      },
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async pollCommands(nodeIdInput, afterInput, waitMsInput, signal) {
    const nodeId = validateNodeId(nodeIdInput);
    if (!this.store.state.nodes[nodeId]) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
    const after = integer(afterInput, 0, 0, Number.MAX_SAFE_INTEGER, "after");
    const waitMs = integer(waitMsInput, 0, 0, MAX_LONG_POLL_MS, "wait_ms");
    let commands = this.#commandsAfter(nodeId, after);
    if (commands.length === 0 && waitMs > 0 && !this.closed && !signal?.aborted) {
      await this.#waitForCommands(nodeId, waitMs, signal);
    }
    const serverStateRecovery = this.store.recoverySnapshot?.() ?? null;
    const authority = await this.store.transaction((state) => {
      const node = state.nodes[nodeId];
      if (!node) throw notFound(`Node ${nodeId} is not registered`, "node_not_found");
      const queue = state.commandQueues[nodeId] ?? [];
      const authorizedCommands = serverStateRecovery?.status === "active"
        ? []
        : queue.filter((command) => command.sequence > after);
      return {
        commands: authorizedCommands,
        commandSequence: Number(node.commandSequence ?? 0),
        failClosedFence: node.failClosedFence ?? null,
        executionLease: mintExecutionLease(
          state,
          nodeId,
          this.executionLeaseTtlMs,
          serverStateRecovery,
        ),
        earliestSequence: queue[0]?.sequence ?? null,
        resetRequired: Boolean(node.requiresResync),
      };
    }, {
      persist: false,
      schedulePersist: false,
      // Publish the serialized maximum to authoritative RAM. A later durable
      // transition (especially a fence) includes it; crash recovery uses the
      // conservative full-TTL drain above.
      persistWhen: () => false,
    });
    commands = authority.commands;
    const currentNode = this.store.state.nodes[nodeId];
    const failClosedFence = currentNode?.failClosedFence ?? authority.failClosedFence;
    const executionLease = serverStateRecovery?.status === "active"
      || failClosedFence?.status === "active"
      ? null
      : authority.executionLease;
    return {
      protocolVersion: PROTOCOL_VERSION,
      commands,
      nextSequence: commands.at(-1)?.sequence ?? after,
      commandSequence: Number(currentNode?.commandSequence ?? authority.commandSequence),
      serverStateRecovery,
      failClosedFence,
      executionLease,
      earliestSequence: authority.earliestSequence,
      resetRequired: authority.resetRequired,
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async prepare(input = {}) {
    const assetSha256 = input.assetSha256 == null ? null : String(input.assetSha256).toLowerCase();
    if (assetSha256 != null && !/^[a-f0-9]{64}$/.test(assetSha256)) {
      throw badRequest("assetSha256 must be a canonical SHA-256 digest", "invalid_asset_sha256");
    }
    const baseFrame = frameValue(input.baseFrame, 0n);
    const result = await this.store.transaction((state) => {
      const nodeIds = prepareTargetNodes(
        state,
        input.nodeIds,
        this.requireExplicitOutputOwnership,
      );
      if (nodeIds.length === 0) {
        throw conflict("PREPARE requires at least one registered render node", "timeline_target_nodes_required");
      }
      const preparations = nodeIds.map((nodeId) => {
        const project = projectForNode(state, nodeId, this.requireExplicitOutputOwnership);
        const requiredSha256 = Array.from(new Set([
          ...(assetSha256 ? [assetSha256] : []),
          ...project.timeline.cues.map((cue) => cue.assetSha256).filter(Boolean),
        ]));
        return { nodeId, project, requiredSha256 };
      });
      const missingSha256 = Array.from(new Set(preparations.flatMap(({ requiredSha256 }) => (
        requiredSha256.filter((sha256) => (
          !/^[a-f0-9]{64}$/.test(sha256)
          || state.media[sha256]?.sha256 !== sha256
        ))
      ))));
      if (missingSha256.length > 0) {
        throw new HttpError(
          404,
          "timeline_asset_not_found",
          "Every prepared asset and project cue must exist in the authoritative media library",
          { missingSha256 },
        );
      }
      const nowNs = epochNowNs();
      state.timeline = {
        ...state.timeline,
        status: "prepared",
        baseFrame: baseFrame.toString(),
        playAtNs: null,
        pauseAtNs: null,
        pauseFrame: null,
        preparedAssetSha256: assetSha256,
        frameRateNum: state.project.canvas.frameRateNum,
        frameRateDen: state.project.canvas.frameRateDen,
        updatedAtNs: nowNs.toString(),
      };
      const commands = preparations.map(({ nodeId, project, requiredSha256 }) => queueCommand(
        state,
        nodeId,
        COMMAND.PREPARE,
        {
          assetSha256,
          assets: requiredSha256.map((sha256) => state.media[sha256]),
          baseFrame: baseFrame.toString(),
          project,
          projectRevision: state.project.revision,
          frameRateNum: state.project.canvas.frameRateNum,
          frameRateDen: state.project.canvas.frameRateDen,
        },
      ));
      state.timeline.targetNodeIds = nodeIds;
      state.timeline.prepareSequences = Object.fromEntries(commands.map((command, index) => [nodeIds[index], command.sequence]));
      return { nodeIds, commands, timeline: state.timeline };
    });
    this.#notify(result.nodeIds);
    return this.#timelineResponse(result);
  }

  async play(input = {}) {
    const delayMs = integer(input.delayMs, 750, 100, 30_000, "delay_ms");
    const effectiveAtNs = epochNowNs() + nsFromMs(delayMs);
    const result = await this.store.transaction((state) => {
      const nodeIds = timelineNodes(state, input.nodeIds, "play");
      const baseFrame = frameValue(input.baseFrame, timelineFrameAt(state.timeline, epochNowNs()));
      state.timeline = {
        ...state.timeline,
        status: "scheduled",
        baseFrame: baseFrame.toString(),
        playAtNs: effectiveAtNs.toString(),
        pauseAtNs: null,
        pauseFrame: null,
        frameRateNum: state.project.canvas.frameRateNum,
        frameRateDen: state.project.canvas.frameRateDen,
        updatedAtNs: epochNowNs().toString(),
        targetNodeIds: nodeIds,
      };
      const payload = {
        baseFrame: baseFrame.toString(),
        projectRevision: state.project.revision,
        frameRateNum: state.project.canvas.frameRateNum,
        frameRateDen: state.project.canvas.frameRateDen,
      };
      const commands = nodeIds.map((nodeId) => queueCommand(state, nodeId, COMMAND.PLAY_AT, payload, { effectiveAtNs }));
      return { nodeIds, commands, timeline: state.timeline };
    });
    this.#notify(result.nodeIds);
    return this.#timelineResponse(result);
  }

  async pause(input = {}) {
    const delayMs = integer(input.delayMs, 250, 50, 30_000, "delay_ms");
    const effectiveAtNs = epochNowNs() + nsFromMs(delayMs);
    const result = await this.store.transaction((state) => {
      const nodeIds = timelineNodes(state, input.nodeIds, "pause");
      const pauseFrame = frameValue(input.frame, timelineFrameAt(state.timeline, effectiveAtNs));
      state.timeline = {
        ...state.timeline,
        status: "pause-scheduled",
        pauseAtNs: effectiveAtNs.toString(),
        pauseFrame: pauseFrame.toString(),
        updatedAtNs: epochNowNs().toString(),
      };
      const commands = nodeIds.map((nodeId) => queueCommand(state, nodeId, COMMAND.PAUSE_AT, {
        frame: pauseFrame.toString(),
      }, { effectiveAtNs }));
      return { nodeIds, commands, timeline: state.timeline };
    });
    this.#notify(result.nodeIds);
    return this.#timelineResponse(result);
  }

  async seek(input = {}) {
    const frame = frameValue(input.frame, null);
    if (frame == null) throw badRequest("frame is required", "missing_frame");
    const delayMs = integer(input.delayMs, 250, 50, 30_000, "delay_ms");
    const effectiveAtNs = epochNowNs() + nsFromMs(delayMs);
    const result = await this.store.transaction((state) => {
      const nodeIds = timelineNodes(state, input.nodeIds, "seek");
      const wasPlaying = Boolean(state.timeline.playAtNs)
        && (!state.timeline.pauseAtNs || epochNowNs() < BigInt(state.timeline.pauseAtNs));
      state.timeline = {
        ...state.timeline,
        status: wasPlaying ? "scheduled" : "paused",
        baseFrame: frame.toString(),
        playAtNs: wasPlaying ? effectiveAtNs.toString() : null,
        pauseAtNs: wasPlaying ? null : effectiveAtNs.toString(),
        pauseFrame: wasPlaying ? null : frame.toString(),
        updatedAtNs: epochNowNs().toString(),
      };
      const commands = nodeIds.map((nodeId) => queueCommand(state, nodeId, COMMAND.SEEK_AT, {
        frame: frame.toString(),
        resume: wasPlaying,
      }, { effectiveAtNs }));
      return { nodeIds, commands, timeline: state.timeline };
    });
    this.#notify(result.nodeIds);
    return this.#timelineResponse(result);
  }

  async outputPattern(outputIdInput, input = {}) {
    const outputId = String(outputIdInput ?? "").trim().slice(0, 128);
    if (!outputId) throw badRequest("Output id is required", "invalid_output_id");
    if (Object.prototype.hasOwnProperty.call(input, "applyCorrections")) {
      throw badRequest(
        "applyCorrections is reserved for an explicit solid optical-verification command",
        "invalid_pattern_correction_mode",
      );
    }
    const enabled = input.enabled !== false;
    const type = enabled ? String(input.type || "grid") : "content";
    if (!["grid", "identify", "content"].includes(type)) {
      throw badRequest("Pattern type must be grid, identify, or content", "invalid_pattern_type");
    }
    const cellSize = integer(input.cellSize, 32, 2, 2_048, "cell_size");
    const result = await this.store.transaction((state) => {
      const output = state.project.outputs.find((candidate) => candidate.id === outputId);
      if (!output) throw notFound(`Output ${outputId} is not present in the project`, "output_not_found");
      let nodeIds;
      if (this.requireExplicitOutputOwnership) {
        if (!output.nodeId) {
          throw notFound(
            `Output ${outputId} has no explicit render-node assignment`,
            "output_node_not_found",
          );
        }
        const requestedNodeIds = input.nodeIds == null
          ? [output.nodeId]
          : selectedNodes(state, input.nodeIds);
        if (requestedNodeIds.length !== 1 || requestedNodeIds[0] !== output.nodeId) {
          throw conflict(
            `Output ${outputId} may be routed only to its explicitly assigned node`,
            "output_node_ownership_mismatch",
            { outputId, ownerNodeId: output.nodeId, requestedNodeIds },
          );
        }
        nodeIds = selectedNodes(state, [output.nodeId]);
      } else if (input.nodeIds != null) {
        nodeIds = selectedNodes(state, input.nodeIds);
      } else if (output.nodeId) {
        nodeIds = selectedNodes(state, [output.nodeId]);
      } else {
        nodeIds = Object.values(state.nodes)
          .filter((node) => node.capabilities?.outputs?.some((candidate) => (
            candidate.id === outputId || (output.connector && candidate.connector === output.connector)
          )))
          .map((node) => node.nodeId);
      }
      if (nodeIds.length === 0) {
        throw notFound(`No registered node owns output ${outputId}`, "output_node_not_found");
      }
      for (const nodeId of nodeIds) {
        assertOpticalVerificationNodeAvailable(state, nodeId, "output-pattern");
      }
      const commandType = type === "identify" ? COMMAND.IDENTIFY_OUTPUT : COMMAND.CALIBRATION_PATTERN;
      const commands = nodeIds.map((nodeId) => queueCommand(state, nodeId, commandType, {
        outputId,
        enabled,
        type,
        cellSize,
      }));
      return { nodeIds, commands };
    });
    this.#notify(result.nodeIds);
    return {
      protocolVersion: PROTOCOL_VERSION,
      outputId,
      enabled,
      type,
      cellSize,
      nodeIds: result.nodeIds,
      commands: result.commands.map((command) => ({
        id: command.id,
        sequence: command.sequence,
        type: command.type,
      })),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  close() {
    this.closed = true;
    this.events.emit("shutdown");
  }

  #timelineResponse(result) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      timeline: {
        ...timelineSnapshot(result.timeline),
        readiness: this.readinessSnapshot(result.timeline),
      },
      nodeIds: result.nodeIds,
      commands: result.commands.map((command) => ({ id: command.id, sequence: command.sequence, type: command.type })),
      serverTimeNs: epochNowNs().toString(),
    };
  }

  async #auditRejectedHostAction({ nodeId, request, requestedAt, actor, reason, code }) {
    await this.store.transaction((state) => {
      state.actionAudit ??= [];
      state.actionAudit.push({
        id: makeId("audit"),
        actionId: null,
        nodeId,
        type: request.type,
        payload: request.payload,
        status: "rejected",
        requestedAt,
        requestedBy: actor,
        confirmationRequired: true,
        confirmationPhraseAccepted: false,
        rejection: { code, message: reason },
        updatedAt: requestedAt,
      });
      trimAudit(state, this.maxActionAudit);
      return null;
    });
  }

  #commandsAfter(nodeId, after) {
    return jsonSafe((this.store.state.commandQueues[nodeId] ?? []).filter((command) => command.sequence > after));
  }

  #notify(nodeIds) {
    for (const nodeId of nodeIds) this.events.emit(`commands:${nodeId}`);
  }

  #waitForCommands(nodeId, waitMs, signal) {
    return new Promise((resolve) => {
      let timer;
      const eventName = `commands:${nodeId}`;
      const finish = () => {
        clearTimeout(timer);
        this.events.off(eventName, finish);
        this.events.off("shutdown", finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, waitMs);
      timer.unref?.();
      this.events.once(eventName, finish);
      this.events.once("shutdown", finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
