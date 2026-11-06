import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND,
  HOST_ACTION_TYPE,
  PROTOCOL_VERSION,
  createCommand,
  defaultProject,
  jsonSafe,
  normalizeNativePatternCommand,
  normalizeProject,
  normalizeRegistration,
  normalizeServerStateRecovery,
} from "../shared/protocol.mjs";
import {
  CAMERA_CALIBRATION_SCHEMA_VERSION,
  CAMERA_CALIBRATION_STATE,
  normalizeCameraCalibrationManifest,
  normalizeCameraCalibrationPlan,
  validateCameraCalibrationProjectPatch,
} from "../shared/camera-calibration.mjs";
import {
  CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE,
  CAMERA_CALIBRATION_BUNDLE_STATE,
  normalizeCameraCalibrationBundle,
} from "../shared/camera-calibration-bundle.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_STATE,
  normalizeCameraOpticalVerificationPlan,
  normalizeCameraOpticalVerificationState,
} from "../shared/camera-verification.mjs";
import {
  normalizeCameraSurveyPreviewCommand,
  normalizeCameraSurveyPreviewReport,
} from "../shared/camera-survey-preview.mjs";
import { normalizeOutputConfig } from "../shared/mapping.mjs";
import { normalizeRendererCorrectionBinding } from "../shared/renderer-correction-binding.mjs";
import {
  actionResultSummary,
  normalizeActionRequest,
  normalizeActionResults,
  normalizeCommandDeadLetters,
} from "./fleet.mjs";

const STATE_SCHEMA_VERSION = 1;
// Ordinary publication stops at 4,096 records. A first fleet fence may also
// have to retain every stale-polled timeline command (globally bounded at
// 8,192) so Node cursor hand-offs remain exactly replayable. This reserved
// emergency evidence budget is not available to ordinary dead letters.
const MAX_RETAINED_COMMAND_DEAD_LETTERS_PER_NODE = 4_096 + 8_192 + 1;

function stateStoreError(code, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isoNow() {
  return new Date().toISOString();
}

function invalidState(message, cause = null) {
  throw stateStoreError("SERVER_STATE_INVALID", message, cause);
}

function record(value, field, { optional = false } = {}) {
  if (value == null && optional) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalidState(`${field} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!key || key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) {
      invalidState(`${field} contains an unsafe or oversized key`);
    }
  }
  return value;
}

function array(value, field, { optional = false, max = 100_000 } = {}) {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || value.length > max) {
    invalidState(`${field} must be an array with at most ${max} entries`);
  }
  return value;
}

function boundedString(value, field, { nullable = false, max = 4_096 } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > max) {
    invalidState(`${field} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function safeInteger(value, field, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) invalidState(`${field} must be a safe integer >= ${min}`);
  return value;
}

function integerString(value, field, { nullable = false, signed = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !(signed ? /^-?\d+$/ : /^\d+$/).test(value)) {
    invalidState(`${field} must be ${nullable ? "null or " : ""}a canonical integer string`);
  }
  try {
    const parsed = BigInt(value);
    if (parsed.toString() !== value) invalidState(`${field} must be a canonical integer string`);
  } catch (error) {
    if (error?.code === "SERVER_STATE_INVALID") throw error;
    invalidState(`${field} is outside the supported integer range`, error);
  }
  return value;
}

function exactKeys(value, keys, field) {
  const input = record(value, field);
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidState(`${field} must contain exactly: ${expected.join(", ")}`);
  }
  return input;
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

function canonicalNormalized(input, normalizer, field) {
  let normalized;
  try {
    normalized = normalizer(input);
  } catch (error) {
    invalidState(`${field} is invalid: ${error.message}`, error);
  }
  if (!isDeepStrictEqual(input, normalized)) invalidState(`${field} is not in canonical persisted form`);
  return normalized;
}

function isoTimestamp(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  boundedString(value, field, { max: 64 });
  if (!Number.isFinite(Date.parse(value))) invalidState(`${field} must be an ISO timestamp`);
  return value;
}

function validateMedia(media) {
  for (const [sha256, raw] of Object.entries(media)) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) invalidState(`media contains invalid SHA-256 key ${sha256}`);
    const item = record(raw, `media.${sha256}`);
    if (item.sha256 !== sha256) invalidState(`media.${sha256}.sha256 does not match its key`);
    boundedString(item.name, `media.${sha256}.name`, { max: 255 });
    const names = array(item.names, `media.${sha256}.names`, { max: 32 });
    for (const [index, name] of names.entries()) boundedString(name, `media.${sha256}.names[${index}]`, { max: 255 });
    safeInteger(item.size, `media.${sha256}.size`);
    boundedString(item.mimeType, `media.${sha256}.mimeType`, { max: 255 });
    isoTimestamp(item.createdAt, `media.${sha256}.createdAt`);
    isoTimestamp(item.updatedAt, `media.${sha256}.updatedAt`);
  }
}

function validateNodes(nodes, nextCommandSequence, stateUpdatedAt) {
  for (const [nodeId, raw] of Object.entries(nodes)) {
    boundedString(nodeId, "nodes key", { max: 128 });
    const node = record(raw, `nodes.${nodeId}`);
    if (node.nodeId !== nodeId || node.protocolVersion !== PROTOCOL_VERSION) {
      invalidState(`nodes.${nodeId} identity or protocol version is invalid`);
    }
    record(node.capabilities, `nodes.${nodeId}.capabilities`);
    array(node.capabilities.outputs, `nodes.${nodeId}.capabilities.outputs`, { max: 256 });
    let registration;
    try {
      registration = normalizeRegistration({
        protocolVersion: node.protocolVersion,
        nodeId: node.nodeId,
        name: node.name,
        version: node.version,
        address: node.address,
        capabilities: node.capabilities,
      });
    } catch (error) {
      invalidState(`nodes.${nodeId} registration contract is invalid: ${error.message}`, error);
    }
    if (!isDeepStrictEqual({
      protocolVersion: node.protocolVersion,
      nodeId: node.nodeId,
      name: node.name,
      version: node.version,
      address: node.address,
      capabilities: node.capabilities,
    }, registration)) {
      invalidState(`nodes.${nodeId} registration is not in canonical bounded form`);
    }
    const ackSequence = safeInteger(node.ackSequence, `nodes.${nodeId}.ackSequence`);
    const commandSequence = safeInteger(node.commandSequence, `nodes.${nodeId}.commandSequence`);
    if (ackSequence > commandSequence) {
      invalidState(`nodes.${nodeId}.ackSequence cannot exceed commandSequence`);
    }
    if (commandSequence >= nextCommandSequence) {
      invalidState(`nodes.${nodeId}.commandSequence must be lower than nextCommandSequence`);
    }
    integerString(node.maxIssuedLeaseExpiresAtNs, `nodes.${nodeId}.maxIssuedLeaseExpiresAtNs`);
    const maxIssuedLeaseExpiresAtNs = BigInt(node.maxIssuedLeaseExpiresAtNs);
    const stateUpdatedAtNs = BigInt(Date.parse(stateUpdatedAt)) * 1_000_000n;
    if (maxIssuedLeaseExpiresAtNs > stateUpdatedAtNs + 5_100_000_000n) {
      invalidState(`nodes.${nodeId}.maxIssuedLeaseExpiresAtNs exceeds the bounded lease lifetime`);
    }
    const failClosedGeneration = safeInteger(
      node.failClosedGeneration,
      `nodes.${nodeId}.failClosedGeneration`,
    );
    if (node.failClosedFence == null) {
      if (failClosedGeneration !== 0) {
        invalidState(`nodes.${nodeId}.failClosedGeneration lacks its active fence`);
      }
    } else {
      const fence = exactKeys(node.failClosedFence, [
        "status", "generation", "deadLetterId", "activatedAt", "effectiveAtNs", "sourceCommand",
      ], `nodes.${nodeId}.failClosedFence`);
      if (fence.status !== "active" || fence.generation !== failClosedGeneration || fence.generation < 1) {
        invalidState(`nodes.${nodeId}.failClosedFence generation/status is invalid`);
      }
      boundedString(fence.deadLetterId, `nodes.${nodeId}.failClosedFence.deadLetterId`, { max: 96 });
      canonicalIsoTimestamp(fence.activatedAt, `nodes.${nodeId}.failClosedFence.activatedAt`);
      integerString(fence.effectiveAtNs, `nodes.${nodeId}.failClosedFence.effectiveAtNs`);
      const activatedAtNs = BigInt(Date.parse(fence.activatedAt)) * 1_000_000n;
      const effectiveAtNs = BigInt(fence.effectiveAtNs);
      if (effectiveAtNs < activatedAtNs || effectiveAtNs > activatedAtNs + 6_000_000_000n) {
        invalidState(`nodes.${nodeId}.failClosedFence.effectiveAtNs is outside its bounded lease drain window`);
      }
      if (effectiveAtNs < maxIssuedLeaseExpiresAtNs) {
        invalidState(`nodes.${nodeId}.failClosedFence becomes effective before an issued lease drains`);
      }
      const source = exactKeys(fence.sourceCommand, ["nodeId", "id", "sequence", "type"],
        `nodes.${nodeId}.failClosedFence.sourceCommand`);
      boundedString(source.nodeId, `nodes.${nodeId}.failClosedFence.sourceCommand.nodeId`, { max: 128 });
      boundedString(source.id, `nodes.${nodeId}.failClosedFence.sourceCommand.id`, { max: 256 });
      safeInteger(source.sequence, `nodes.${nodeId}.failClosedFence.sourceCommand.sequence`, { min: 1 });
      if (!Object.values(COMMAND).includes(source.type)) {
        invalidState(`nodes.${nodeId}.failClosedFence.sourceCommand.type is invalid`);
      }
    }
    if (node.requiresResync != null && typeof node.requiresResync !== "boolean") {
      invalidState(`nodes.${nodeId}.requiresResync must be boolean`);
    }
    if (node.requiresResync === true) {
      invalidState(
        `nodes.${nodeId} contains an unrecoverable legacy command-history gap; restore LKG or require operator recovery`,
      );
    }
  }
}

function validateCanonicalCommandProject(value, field) {
  const persisted = record(value, field);
  canonicalIsoTimestamp(persisted.updatedAt, `${field}.updatedAt`);
  let normalized;
  try {
    normalized = normalizeProject(persisted);
  } catch (error) {
    invalidState(`${field} is invalid: ${error.message}`, error);
  }
  // normalizeProject stamps updatedAt at API boundaries. A queued project is an
  // immutable Server snapshot, so retain its original canonical timestamp while
  // comparing every other normalized field exactly.
  const canonical = { ...normalized, updatedAt: persisted.updatedAt };
  if (!isDeepStrictEqual(canonical, persisted)) invalidState(`${field} is not in canonical persisted form`);
  return canonical;
}

function validateQueuedCommandPayload(command, field) {
  const payloadField = `${field}.payload`;
  const payload = record(command.payload, payloadField);
  const timed = new Set([COMMAND.PLAY_AT, COMMAND.PAUSE_AT, COMMAND.SEEK_AT]);
  if (timed.has(command.type)) integerString(command.effectiveAtNs, `${field}.effectiveAtNs`);
  else if (command.effectiveAtNs != null) invalidState(`${field}.effectiveAtNs is unsupported for ${command.type}`);

  switch (command.type) {
    case COMMAND.SYNC_PROJECT: {
      const reason = payload.reason ?? null;
      const keys = reason == null
        ? ["project", "revision"]
        : reason === "camera-calibration"
          ? ["project", "revision", "reason", "sessionId"]
          : reason === "camera-calibration-bundle"
            ? ["project", "revision", "reason", "bundleId", "commitId"]
            : reason === "camera-optical-verification-rollback"
              ? ["project", "revision", "reason", "sessionId", "verificationId"]
              : null;
      if (keys == null) invalidState(`${payloadField}.reason is unsupported`);
      exactKeys(payload, keys, payloadField);
      const project = validateCanonicalCommandProject(payload.project, `${payloadField}.project`);
      safeInteger(payload.revision, `${payloadField}.revision`, { min: 1 });
      if (payload.revision !== project.revision) invalidState(`${payloadField}.revision differs from project`);
      for (const key of keys.filter((key) => !["project", "revision", "reason"].includes(key))) {
        boundedString(payload[key], `${payloadField}.${key}`, { max: 128 });
      }
      break;
    }
    case COMMAND.PREPARE: {
      exactKeys(payload, [
        "assetSha256", "assets", "baseFrame", "project", "projectRevision",
        "frameRateNum", "frameRateDen",
      ], payloadField);
      if (payload.assetSha256 != null && !SHA256_PATTERN.test(payload.assetSha256)) {
        invalidState(`${payloadField}.assetSha256 is invalid`);
      }
      array(payload.assets, `${payloadField}.assets`, { max: 10_001 })
        .forEach((value, index) => {
          const assetField = `${payloadField}.assets[${index}]`;
          const asset = exactKeys(value, [
            "sha256", "name", "names", "size", "mimeType", "createdAt", "updatedAt",
          ], assetField);
          if (!SHA256_PATTERN.test(asset.sha256)) invalidState(`${assetField}.sha256 is invalid`);
          boundedString(asset.name, `${assetField}.name`, { max: 255 });
          const names = array(asset.names, `${assetField}.names`, { max: 32 });
          if (new Set(names).size !== names.length) invalidState(`${assetField}.names must be unique`);
          names.forEach((name, nameIndex) => boundedString(name, `${assetField}.names[${nameIndex}]`, { max: 255 }));
          safeInteger(asset.size, `${assetField}.size`, { min: 1 });
          boundedString(asset.mimeType, `${assetField}.mimeType`, { max: 255 });
          canonicalIsoTimestamp(asset.createdAt, `${assetField}.createdAt`);
          canonicalIsoTimestamp(asset.updatedAt, `${assetField}.updatedAt`);
        });
      integerString(payload.baseFrame, `${payloadField}.baseFrame`, { signed: true });
      const project = validateCanonicalCommandProject(payload.project, `${payloadField}.project`);
      safeInteger(payload.projectRevision, `${payloadField}.projectRevision`, { min: 1 });
      safeInteger(payload.frameRateNum, `${payloadField}.frameRateNum`, { min: 1 });
      safeInteger(payload.frameRateDen, `${payloadField}.frameRateDen`, { min: 1 });
      if (payload.projectRevision !== project.revision
        || payload.frameRateNum !== project.canvas.frameRateNum
        || payload.frameRateDen !== project.canvas.frameRateDen) {
        invalidState(`${payloadField} project revision/frame rate binding is invalid`);
      }
      break;
    }
    case COMMAND.PLAY_AT:
      exactKeys(payload, ["baseFrame", "projectRevision", "frameRateNum", "frameRateDen"], payloadField);
      integerString(payload.baseFrame, `${payloadField}.baseFrame`, { signed: true });
      safeInteger(payload.projectRevision, `${payloadField}.projectRevision`, { min: 1 });
      safeInteger(payload.frameRateNum, `${payloadField}.frameRateNum`, { min: 1 });
      safeInteger(payload.frameRateDen, `${payloadField}.frameRateDen`, { min: 1 });
      break;
    case COMMAND.PAUSE_AT:
      exactKeys(payload, ["frame"], payloadField);
      integerString(payload.frame, `${payloadField}.frame`, { signed: true });
      break;
    case COMMAND.SEEK_AT:
      exactKeys(payload, ["frame", "resume"], payloadField);
      integerString(payload.frame, `${payloadField}.frame`, { signed: true });
      if (typeof payload.resume !== "boolean") invalidState(`${payloadField}.resume must be boolean`);
      break;
    case COMMAND.STOP:
    case COMMAND.RESTART_ENGINE:
      exactKeys(payload, [], payloadField);
      break;
    case COMMAND.APPLY_OUTPUT: {
      const output = Object.keys(payload).length === 1 && Object.hasOwn(payload, "output")
        ? exactKeys(payload, ["output"], payloadField).output
        : payload;
      canonicalNormalized(output, normalizeOutputConfig, `${payloadField}.output`);
      break;
    }
    case COMMAND.IDENTIFY_OUTPUT:
    case COMMAND.CALIBRATION_PATTERN:
      canonicalNormalized(payload, normalizeNativePatternCommand, payloadField);
      break;
    case COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW:
      canonicalNormalized(payload, normalizeCameraSurveyPreviewCommand, payloadField);
      break;
    case COMMAND.START_CAMERA_CALIBRATION: {
      const keys = payload.bundle == null ? ["mode", "plan"] : ["mode", "plan", "bundle"];
      exactKeys(payload, keys, payloadField);
      if (!new Set(["measured", "simulation"]).has(payload.mode)) invalidState(`${payloadField}.mode is invalid`);
      canonicalNormalized(payload.plan, normalizeCameraCalibrationPlan, `${payloadField}.plan`);
      if (payload.bundle != null) {
        const bundle = exactKeys(payload.bundle, [
          "bundleId", "memberId", "cameraViewId", "viewCaptureId",
        ], `${payloadField}.bundle`);
        for (const key of Object.keys(bundle)) boundedString(bundle[key], `${payloadField}.bundle.${key}`, { max: 128 });
      }
      break;
    }
    case COMMAND.CONFIRM_CAMERA_CALIBRATION: {
      const confirmation = exactKeys(payload, [
        "sessionId", "stepId", "confirmationId", "confirmationLeaseId", "confirmedAt",
      ], payloadField);
      for (const key of ["sessionId", "stepId", "confirmationId", "confirmationLeaseId"]) {
        boundedString(confirmation[key], `${payloadField}.${key}`, { max: 256 });
      }
      canonicalIsoTimestamp(confirmation.confirmedAt, `${payloadField}.confirmedAt`);
      break;
    }
    case COMMAND.CANCEL_CAMERA_CALIBRATION:
      exactKeys(payload, ["sessionId"], payloadField);
      boundedString(payload.sessionId, `${payloadField}.sessionId`, { max: 128 });
      break;
    case COMMAND.START_CAMERA_OPTICAL_VERIFICATION:
      exactKeys(payload, ["plan"], payloadField);
      canonicalNormalized(payload.plan, normalizeCameraOpticalVerificationPlan, `${payloadField}.plan`);
      break;
    case COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION: {
      const confirmation = exactKeys(payload, [
        "schemaVersion", "verificationId", "calibrationSessionId", "nodeId", "projectRevision",
        "leaseToken", "stepId", "confirmationId", "confirmationLeaseId", "confirmedAt",
      ], payloadField);
      safeInteger(confirmation.schemaVersion, `${payloadField}.schemaVersion`, { min: 1 });
      safeInteger(confirmation.projectRevision, `${payloadField}.projectRevision`, { min: 1 });
      for (const key of [
        "verificationId", "calibrationSessionId", "nodeId", "leaseToken", "stepId",
        "confirmationId", "confirmationLeaseId",
      ]) boundedString(confirmation[key], `${payloadField}.${key}`, { max: 512 });
      canonicalIsoTimestamp(confirmation.confirmedAt, `${payloadField}.confirmedAt`);
      break;
    }
    case COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION:
      exactKeys(payload, ["verificationId", "leaseToken"], payloadField);
      boundedString(payload.verificationId, `${payloadField}.verificationId`, { max: 128 });
      boundedString(payload.leaseToken, `${payloadField}.leaseToken`, { max: 512 });
      break;
    case COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK:
      exactKeys(payload, [
        "verificationId", "leaseToken", "calibrationSessionId", "projectRevision",
      ], payloadField);
      boundedString(payload.verificationId, `${payloadField}.verificationId`, { max: 128 });
      boundedString(payload.leaseToken, `${payloadField}.leaseToken`, { max: 512 });
      boundedString(payload.calibrationSessionId, `${payloadField}.calibrationSessionId`, { max: 128 });
      safeInteger(payload.projectRevision, `${payloadField}.projectRevision`, { min: 1 });
      break;
    case COMMAND.HOST_ACTION: {
      exactKeys(payload, ["action"], payloadField);
      const action = record(payload.action, `${payloadField}.action`);
      const keys = action.confirmationToken == null
        ? ["id", "type", "payload"]
        : ["id", "type", "payload", "confirmationToken"];
      exactKeys(action, keys, `${payloadField}.action`);
      boundedString(action.id, `${payloadField}.action.id`, { max: 256 });
      if (!Object.values(HOST_ACTION_TYPE).includes(action.type)) invalidState(`${payloadField}.action.type is invalid`);
      const powerAction = action.type === HOST_ACTION_TYPE.REBOOT_HOST
        || action.type === HOST_ACTION_TYPE.SHUTDOWN_HOST;
      if (powerAction !== (action.confirmationToken != null)) {
        invalidState(`${payloadField}.action confirmation token presence differs from host-action policy`);
      }
      record(action.payload, `${payloadField}.action.payload`);
      let request;
      try {
        request = normalizeActionRequest({ type: action.type, payload: action.payload });
      } catch (error) {
        invalidState(`${payloadField}.action is outside the bounded host-action contract: ${error.message}`, error);
      }
      if (!isDeepStrictEqual(request.payload, action.payload)) {
        invalidState(`${payloadField}.action.payload is not canonical`);
      }
      if (action.confirmationToken != null) {
        boundedString(action.confirmationToken, `${payloadField}.action.confirmationToken`, { max: 4_096 });
      }
      if (!isDeepStrictEqual(command.action, action)) invalidState(`${field}.action does not mirror payload.action`);
      break;
    }
    default:
      invalidState(`${field}.type has no strict persisted payload validator`);
  }
}

function validateCommandQueues(commandQueues, nodes, nextCommandSequence) {
  const commandIds = new Set();
  const sequences = new Set();
  let maximumSequence = 0;
  let retainedTimelineAuthority = 0;
  const timelineTypes = new Set([
    COMMAND.SYNC_PROJECT,
    COMMAND.PREPARE,
    COMMAND.PLAY_AT,
    COMMAND.PAUSE_AT,
    COMMAND.SEEK_AT,
    COMMAND.STOP,
  ]);
  for (const [nodeId, rawQueue] of Object.entries(commandQueues)) {
    if (!nodes[nodeId]) invalidState(`commandQueues.${nodeId} has no matching registered node`);
    const queue = array(rawQueue, `commandQueues.${nodeId}`, { max: 4_096 });
    let priorSequence = 0;
    for (const [index, raw] of queue.entries()) {
      const field = `commandQueues.${nodeId}[${index}]`;
      const command = exactKeys(raw, raw?.type === COMMAND.HOST_ACTION
        ? ["protocolVersion", "id", "sequence", "type", "createdAtNs", "effectiveAtNs", "payload", "action"]
        : ["protocolVersion", "id", "sequence", "type", "createdAtNs", "effectiveAtNs", "payload"], field);
      boundedString(command.id, `${field}.id`, { max: 256 });
      if (commandIds.has(command.id)) invalidState(`${field}.id is duplicated`);
      commandIds.add(command.id);
      safeInteger(command.sequence, `${field}.sequence`, { min: 1 });
      if (command.sequence <= priorSequence || sequences.has(command.sequence)) {
        invalidState(`${field}.sequence is duplicated or out of order`);
      }
      priorSequence = command.sequence;
      maximumSequence = Math.max(maximumSequence, command.sequence);
      sequences.add(command.sequence);
      if (command.sequence <= nodes[nodeId].ackSequence) {
        invalidState(`${field}.sequence must be greater than the node acknowledgement cursor`);
      }
      if (command.sequence > nodes[nodeId].commandSequence) {
        invalidState(`${field}.sequence cannot exceed the node command cursor`);
      }
      if (command.protocolVersion !== PROTOCOL_VERSION || !Object.values(COMMAND).includes(command.type)) {
        invalidState(`${field} has an unsupported protocol or command type`);
      }
      if (timelineTypes.has(command.type)) retainedTimelineAuthority += 1;
      record(command.payload, `${field}.payload`);
      integerString(command.createdAtNs, `${field}.createdAtNs`);
      integerString(command.effectiveAtNs, `${field}.effectiveAtNs`, { nullable: true });
      validateQueuedCommandPayload(command, field);
      try {
        const normalized = createCommand(command.type, command.payload, {
          id: command.id,
          sequence: command.sequence,
          createdAtNs: command.createdAtNs,
          effectiveAtNs: command.effectiveAtNs,
        });
        if (command.type === COMMAND.HOST_ACTION) normalized.action = command.payload.action;
        if (!isDeepStrictEqual(normalized, command)) invalidState(`${field} is not in canonical wire form`);
      } catch (error) {
        if (error?.code === "SERVER_STATE_INVALID") throw error;
        invalidState(`${field} payload is invalid: ${error.message}`, error);
      }
    }
  }
  if (nextCommandSequence <= maximumSequence) {
    invalidState("nextCommandSequence must be greater than every queued command sequence");
  }
  if (retainedTimelineAuthority > 8_192) {
    invalidState("Queued timeline authority exceeds bounded fail-closed audit capacity");
  }
}

function validateCommandDeadLetterState(commandDeadLetters, nodes, commandQueues) {
  const allDeadLetterIds = new Set(Object.values(commandDeadLetters).flatMap((records) => (
    Array.isArray(records) ? records.map((record) => record?.deadLetterId) : []
  )));
  const compensationClaims = [];
  const fenceClaims = new Map();
  const deadLetterIds = new Set();
  const deadLetterSequences = new Set();
  const deadLetterCommandIds = new Set();
  for (const [nodeId, rawRecords] of Object.entries(commandDeadLetters)) {
    if (!nodes[nodeId]) invalidState(`commandDeadLetters.${nodeId} has no matching registered node`);
    const records = array(rawRecords, `commandDeadLetters.${nodeId}`, {
      max: MAX_RETAINED_COMMAND_DEAD_LETTERS_PER_NODE,
    });
    let priorSequence = 0;
    let priorReceivedAt = null;
    for (const [index, value] of records.entries()) {
      const field = `commandDeadLetters.${nodeId}[${index}]`;
      const item = exactKeys(value, [
        "schemaVersion", "deadLetterId", "nodeId", "command", "attempts", "retryBudget",
        "safetyCritical", "firstFailedAt", "lastFailedAt", "deadLetteredAt", "errors",
        "failClosed", "receivedAt", "status", "recovery", "queueDisposition", "compensation",
      ], field);
      let normalized;
      try {
        [normalized] = normalizeCommandDeadLetters([{
          schemaVersion: item.schemaVersion,
          deadLetterId: item.deadLetterId,
          nodeId: item.nodeId,
          command: item.command,
          attempts: item.attempts,
          retryBudget: item.retryBudget,
          safetyCritical: item.safetyCritical,
          firstFailedAt: item.firstFailedAt,
          lastFailedAt: item.lastFailedAt,
          deadLetteredAt: item.deadLetteredAt,
          errors: item.errors,
          failClosed: item.failClosed,
        }], nodeId);
      } catch (error) {
        invalidState(`${field} wire evidence is invalid: ${error.message}`, error);
      }
      const wire = Object.fromEntries(Object.keys(normalized).map((key) => [key, item[key]]));
      if (!isDeepStrictEqual(wire, normalized)) invalidState(`${field} wire evidence is not canonical`);
      for (const timestampField of ["firstFailedAt", "lastFailedAt", "deadLetteredAt", "receivedAt"]) {
        canonicalIsoTimestamp(item[timestampField], `${field}.${timestampField}`);
      }
      item.errors.forEach((error, errorIndex) => {
        exactKeys(error, ["attempt", "failedAt", "name", "code", "message"], `${field}.errors[${errorIndex}]`);
        canonicalIsoTimestamp(error.failedAt, `${field}.errors[${errorIndex}].failedAt`);
      });
      if (item.nodeId !== nodeId || item.status !== "dead-lettered"
        || item.queueDisposition !== "removed-after-durable-evidence"
        || Date.parse(item.receivedAt) < Date.parse(item.deadLetteredAt)) {
        invalidState(`${field} retained Server authority is invalid`);
      }
      const recovery = exactKeys(item.recovery, [
        "status", "reviewedAt", "disposition", "replacementCommand",
      ], `${field}.recovery`);
      if (recovery.status !== "operator-review-required" || recovery.reviewedAt != null
        || recovery.disposition != null || recovery.replacementCommand != null) {
        invalidState(`${field}.recovery contains unsupported or forged operator disposition`);
      }
      const compensation = exactKeys(item.compensation, [
        "timelineInvalidated", "targetNodeIds", "supersededCommands", "commands", "fences", "inheritedFrom", "owner",
      ], `${field}.compensation`);
      if (typeof compensation.timelineInvalidated !== "boolean") {
        invalidState(`${field}.compensation.timelineInvalidated must be boolean`);
      }
      const targetNodeIds = array(
        compensation.targetNodeIds,
        `${field}.compensation.targetNodeIds`,
        { max: 4_096 },
      );
      if (new Set(targetNodeIds).size !== targetNodeIds.length
        || targetNodeIds.some((targetNodeId) => !nodes[targetNodeId])) {
        invalidState(`${field}.compensation.targetNodeIds is duplicated or references an unknown node`);
      }
      const validateReference = (referenceValue, referenceField, { queuedOrAcknowledged }) => {
        const reference = exactKeys(referenceValue, ["nodeId", "id", "sequence", "type"], referenceField);
        if (!nodes[reference.nodeId]) invalidState(`${referenceField}.nodeId is unknown`);
        boundedString(reference.id, `${referenceField}.id`, { max: 256 });
        safeInteger(reference.sequence, `${referenceField}.sequence`, { min: 1 });
        if (!Object.values(COMMAND).includes(reference.type)
          || reference.sequence > nodes[reference.nodeId].commandSequence) {
          invalidState(`${referenceField} is outside its node command authority`);
        }
        const queued = commandQueues[reference.nodeId]?.find((command) => (
          command.id === reference.id && command.sequence === reference.sequence && command.type === reference.type
        ));
        if (queuedOrAcknowledged) {
          const inheritedDeadLetter = Object.values(commandDeadLetters).flat().find((record) => (
            record.nodeId === reference.nodeId
            && record.command?.id === reference.id
            && record.command?.sequence === reference.sequence
            && record.command?.type === reference.type
            && record.compensation?.inheritedFrom === item.deadLetterId
          ));
          if (reference.sequence > nodes[reference.nodeId].ackSequence && !queued && !inheritedDeadLetter) {
            invalidState(`${referenceField} is neither queued, acknowledged nor exact inherited dead-letter evidence`);
          }
        } else if (queued) {
          invalidState(`${referenceField} remains queued after deterministic supersession`);
        }
        return reference;
      };
      const supersededCommands = array(
        compensation.supersededCommands,
        `${field}.compensation.supersededCommands`,
        { max: 8_192 },
      ).map((reference, referenceIndex) => validateReference(
        reference,
        `${field}.compensation.supersededCommands[${referenceIndex}]`,
        { queuedOrAcknowledged: false },
      ));
      const commands = array(
        compensation.commands,
        `${field}.compensation.commands`,
        { max: 8_192 },
      ).map((reference, referenceIndex) => validateReference(
        reference,
        `${field}.compensation.commands[${referenceIndex}]`,
        { queuedOrAcknowledged: true },
      ));
      const referenceIdentities = [...supersededCommands, ...commands]
        .map((reference) => `${reference.nodeId}:${reference.id}:${reference.sequence}`);
      if (new Set(referenceIdentities).size !== referenceIdentities.length
        || supersededCommands.some((reference) => ![
          COMMAND.SYNC_PROJECT,
          COMMAND.PREPARE,
          COMMAND.PLAY_AT,
          COMMAND.PAUSE_AT,
          COMMAND.SEEK_AT,
          COMMAND.STOP,
        ].includes(reference.type))
        || commands.some((reference) => !targetNodeIds.includes(reference.nodeId)
          || ![COMMAND.STOP, COMMAND.CALIBRATION_PATTERN].includes(reference.type))) {
        invalidState(`${field}.compensation command identities/types are invalid`);
      }
      if (commands.length !== 0) {
        invalidState(`${field}.compensation must use the emergency fence, not ordinary queued commands`);
      }
      const fences = array(compensation.fences, `${field}.compensation.fences`, { max: 4_096 })
        .map((fenceValue, fenceIndex) => {
          const fenceField = `${field}.compensation.fences[${fenceIndex}]`;
          const fence = exactKeys(fenceValue, ["nodeId", "generation", "effectiveAtNs"], fenceField);
          if (!nodes[fence.nodeId]) invalidState(`${fenceField}.nodeId is unknown`);
          safeInteger(fence.generation, `${fenceField}.generation`, { min: 1 });
          integerString(fence.effectiveAtNs, `${fenceField}.effectiveAtNs`);
          const claims = fenceClaims.get(fence.nodeId) || [];
          claims.push({ item, fence });
          fenceClaims.set(fence.nodeId, claims);
          return fence;
        });
      if (new Set(fences.map((fence) => fence.nodeId)).size !== fences.length
        || !isDeepStrictEqual(fences.map((fence) => fence.nodeId), targetNodeIds)) {
        invalidState(`${field}.compensation.fences must bind every target node exactly in order`);
      }
      const inheritedFrom = compensation.inheritedFrom == null
        ? null
        : boundedString(compensation.inheritedFrom, `${field}.compensation.inheritedFrom`, { max: 96 });
      if (inheritedFrom != null && (!allDeadLetterIds.has(inheritedFrom)
        || inheritedFrom === item.deadLetterId || compensation.timelineInvalidated
        || targetNodeIds.length > 0 || supersededCommands.length > 0 || commands.length > 0)) {
        invalidState(`${field}.compensation.inheritedFrom is invalid or claims repeated compensation`);
      }
      if (compensation.timelineInvalidated !== (targetNodeIds.length > 0)
        || (!compensation.timelineInvalidated && (supersededCommands.length > 0 || commands.length > 0))) {
        invalidState(`${field}.compensation timeline invalidation evidence is incoherent`);
      }
      let owner = null;
      if (compensation.owner != null) {
        owner = exactKeys(compensation.owner, ["kind", "id", "state"], `${field}.compensation.owner`);
        if (![
          "host-action", "camera-survey-preview", "camera-calibration", "camera-optical-verification",
        ].includes(owner.kind)) invalidState(`${field}.compensation.owner.kind is invalid`);
        boundedString(owner.id, `${field}.compensation.owner.id`, { max: 256 });
        boundedString(owner.state, `${field}.compensation.owner.state`, { max: 64 });
      }
      compensationClaims.push({ item, inheritedFrom, owner });
      if (deadLetterIds.has(item.deadLetterId) || deadLetterSequences.has(item.command.sequence)
        || deadLetterCommandIds.has(item.command.id) || item.command.sequence <= priorSequence
        || item.command.sequence > nodes[nodeId].commandSequence) {
        invalidState(`${field} identity/sequence is duplicated, reordered or outside its node command cursor`);
      }
      if (priorReceivedAt != null && Date.parse(item.receivedAt) < Date.parse(priorReceivedAt)) {
        invalidState(`${field}.receivedAt reorders append-only dead-letter history`);
      }
      if (commandQueues[nodeId]?.some((command) => (
        command.sequence === item.command.sequence || command.id === item.command.id
      ))) {
        invalidState(`${field} command still exists in the durable queue`);
      }
      const earlierPending = commandQueues[nodeId]?.some((command) => (
        command.sequence > nodes[nodeId].ackSequence && command.sequence < item.command.sequence
      ));
      if (earlierPending) invalidState(`${field} bypasses an earlier ordered queued command`);
      deadLetterIds.add(item.deadLetterId);
      deadLetterSequences.add(item.command.sequence);
      deadLetterCommandIds.add(item.command.id);
      priorSequence = item.command.sequence;
      priorReceivedAt = item.receivedAt;
    }

    const node = nodes[nodeId];
    if (Number(node.commandDeadLetterCount ?? 0) !== records.length) {
      invalidState(`nodes.${nodeId}.commandDeadLetterCount does not match durable evidence`);
    }
    const latest = records.at(-1) ?? null;
    if (latest == null) {
      if (node.latestCommandDeadLetter != null || node.commandFailureSafetyLock != null) {
        invalidState(`nodes.${nodeId} retains dead-letter summary/lock without durable evidence`);
      }
      continue;
    }
    const expectedLatest = {
      deadLetterId: latest.deadLetterId,
      command: latest.command,
      safetyCritical: latest.safetyCritical,
      receivedAt: latest.receivedAt,
      recoveryStatus: latest.recovery.status,
    };
    if (!isDeepStrictEqual(node.latestCommandDeadLetter, expectedLatest)) {
      invalidState(`nodes.${nodeId}.latestCommandDeadLetter does not bind the latest durable record`);
    }
    const latestSafety = records.findLast((item) => item.safetyCritical);
    if (latestSafety == null) {
      if (node.commandFailureSafetyLock != null) {
        invalidState(`nodes.${nodeId}.commandFailureSafetyLock has no safety-critical dead letter`);
      }
    } else {
      const expectedLock = {
        status: "active",
        deadLetterId: latestSafety.deadLetterId,
        command: latestSafety.command,
        blackApplied: latestSafety.failClosed.blackApplied === true,
        enforcementError: latestSafety.failClosed.enforcementError || null,
        receivedAt: latestSafety.receivedAt,
      };
      if (!isDeepStrictEqual(node.commandFailureSafetyLock, expectedLock)) {
        invalidState(`nodes.${nodeId}.commandFailureSafetyLock does not bind safety-critical evidence`);
      }
    }
  }

  for (const { item, inheritedFrom } of compensationClaims) {
    if (inheritedFrom == null) continue;
    const parent = Object.values(commandDeadLetters).flat().find((record) => record.deadLetterId === inheritedFrom);
    if (![...(parent?.compensation?.commands || []), ...(parent?.compensation?.supersededCommands || [])]
      .some((reference) => (
      reference.nodeId === item.nodeId
      && reference.id === item.command.id
      && reference.sequence === item.command.sequence
      && reference.type === item.command.type
    ))) {
      invalidState(`command dead letter ${item.deadLetterId} does not bind exact prior compensation evidence`);
    }
  }

  for (const [targetNodeId, claims] of fenceClaims) {
    const ordered = [...claims].sort((left, right) => left.fence.generation - right.fence.generation);
    ordered.forEach(({ fence }, index) => {
      if (fence.generation !== index + 1) {
        invalidState(`nodes.${targetNodeId} fail-closed fence generations are not consecutive`);
      }
    });
    const latest = ordered.at(-1);
    const expectedFence = {
      status: "active",
      generation: latest.fence.generation,
      deadLetterId: latest.item.deadLetterId,
      activatedAt: latest.item.receivedAt,
      effectiveAtNs: latest.fence.effectiveAtNs,
      sourceCommand: {
        nodeId: latest.item.nodeId,
        id: latest.item.command.id,
        sequence: latest.item.command.sequence,
        type: latest.item.command.type,
      },
    };
    if (nodes[targetNodeId].failClosedGeneration !== latest.fence.generation
      || !isDeepStrictEqual(nodes[targetNodeId].failClosedFence, expectedFence)) {
      invalidState(`nodes.${targetNodeId}.failClosedFence differs from its latest durable generation`);
    }
  }

  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!fenceClaims.has(nodeId)
      && (node.failClosedGeneration !== 0 || node.failClosedFence != null)) {
      invalidState(`nodes.${nodeId} claims a fail-closed fence without durable dead-letter compensation`);
    }
    if (Object.hasOwn(commandDeadLetters, nodeId)) continue;
    if (Number(node.commandDeadLetterCount ?? 0) !== 0
      || node.latestCommandDeadLetter != null || node.commandFailureSafetyLock != null) {
      invalidState(`nodes.${nodeId} claims dead-letter evidence absent from commandDeadLetters`);
    }
  }
}

function validateActionState(actionAudit, processedActionResults, nodes, commandQueues, commandDeadLetters) {
  const auditIds = new Set();
  const actionIds = new Set();
  const commandIds = new Set();
  const commandSequences = new Set();
  const auditsById = new Map();
  for (const [index, value] of actionAudit.entries()) {
    const field = `actionAudit[${index}]`;
    const audit = record(value, field);
    const rejected = audit.status === "rejected";
    const terminal = ["succeeded", "failed", "denied", "dry-run"].includes(audit.status);
    const deadLettered = audit.status === "dead-lettered";
    const keys = rejected
      ? [
        "id", "actionId", "nodeId", "type", "payload", "status", "requestedAt", "requestedBy",
        "confirmationRequired", "confirmationPhraseAccepted", "rejection", "updatedAt",
      ]
      : deadLettered
        ? [
          "id", "actionId", "nodeId", "type", "payload", "status", "requestedAt", "requestedBy",
          "confirmationRequired", "confirmationPhraseAccepted", "commandId", "commandSequence",
          "createdAtNs", "deadLetterId", "deadLetteredAt", "updatedAt",
        ]
        : [
        "id", "actionId", "nodeId", "type", "payload", "status", "requestedAt", "requestedBy",
        "confirmationRequired", "confirmationPhraseAccepted", "commandId", "commandSequence",
        "createdAtNs", "updatedAt",
        ...(terminal ? ["startedAt", "completedAt", "result", "error", "resultIds"] : []),
      ];
    exactKeys(audit, keys, field);
    boundedString(audit.id, `${field}.id`, { max: 256 });
    if (auditIds.has(audit.id)) invalidState(`${field}.id is duplicated`);
    auditIds.add(audit.id);
    auditsById.set(audit.id, audit);
    if (!nodes[audit.nodeId]) invalidState(`${field}.nodeId has no registered node`);
    if (!Object.values(HOST_ACTION_TYPE).includes(audit.type)) invalidState(`${field}.type is invalid`);
    record(audit.payload, `${field}.payload`);
    let request;
    try {
      request = normalizeActionRequest({ type: audit.type, payload: audit.payload });
    } catch (error) {
      invalidState(`${field}.payload is outside the bounded host-action contract: ${error.message}`, error);
    }
    if (!isDeepStrictEqual(request.payload, audit.payload)) invalidState(`${field}.payload is not canonical`);
    canonicalIsoTimestamp(audit.requestedAt, `${field}.requestedAt`);
    canonicalIsoTimestamp(audit.updatedAt, `${field}.updatedAt`);
    boundedString(audit.requestedBy, `${field}.requestedBy`, { max: 256 });
    if (audit.confirmationRequired !== (audit.type === HOST_ACTION_TYPE.REBOOT_HOST
      || audit.type === HOST_ACTION_TYPE.SHUTDOWN_HOST)) {
      invalidState(`${field}.confirmationRequired differs from action policy`);
    }
    if (rejected) {
      if (audit.actionId != null || audit.confirmationRequired !== true
        || audit.confirmationPhraseAccepted !== false || audit.updatedAt !== audit.requestedAt) {
        invalidState(`${field} rejected authority fields are invalid`);
      }
      const rejection = exactKeys(audit.rejection, ["code", "message"], `${field}.rejection`);
      boundedString(rejection.code, `${field}.rejection.code`, { max: 128 });
      boundedString(rejection.message, `${field}.rejection.message`, { max: 2_048 });
      continue;
    }
    if (audit.status !== "queued" && !terminal && !deadLettered) {
      invalidState(`${field}.status is invalid`);
    }
    boundedString(audit.actionId, `${field}.actionId`, { max: 256 });
    boundedString(audit.commandId, `${field}.commandId`, { max: 256 });
    safeInteger(audit.commandSequence, `${field}.commandSequence`, { min: 1 });
    integerString(audit.createdAtNs, `${field}.createdAtNs`);
    if (actionIds.has(audit.actionId) || commandIds.has(audit.commandId)
      || commandSequences.has(audit.commandSequence)) {
      invalidState(`${field} duplicates an action or command identity`);
    }
    actionIds.add(audit.actionId);
    commandIds.add(audit.commandId);
    commandSequences.add(audit.commandSequence);
    const node = nodes[audit.nodeId];
    if (audit.commandSequence > node.commandSequence) invalidState(`${field} exceeds its node command cursor`);
    if (audit.confirmationPhraseAccepted !== (audit.confirmationRequired ? true : null)) {
      invalidState(`${field}.confirmationPhraseAccepted is invalid`);
    }
    if (audit.commandSequence > node.ackSequence && !deadLettered) {
      const command = commandQueues[audit.nodeId]?.find((candidate) => (
        candidate.id === audit.commandId && candidate.sequence === audit.commandSequence
      ));
      if (command?.type !== COMMAND.HOST_ACTION || command.payload?.action?.id !== audit.actionId
        || command.payload?.action?.type !== audit.type
        || !isDeepStrictEqual(command.payload?.action?.payload, audit.payload)
        || command.createdAtNs !== audit.createdAtNs) {
        invalidState(`${field} is not bound to its pending HOST_ACTION command`);
      }
    }
    if (deadLettered) {
      canonicalIsoTimestamp(audit.deadLetteredAt, `${field}.deadLetteredAt`);
      if (audit.updatedAt !== audit.deadLetteredAt) {
        invalidState(`${field}.updatedAt differs from its dead-letter terminal instant`);
      }
      const deadLetter = commandDeadLetters[audit.nodeId]?.find((record) => (
        record.deadLetterId === audit.deadLetterId
      ));
      if (!deadLetter
        || deadLetter.command.id !== audit.commandId
        || deadLetter.command.sequence !== audit.commandSequence
        || deadLetter.command.type !== COMMAND.HOST_ACTION
        || deadLetter.receivedAt !== audit.deadLetteredAt
        || !isDeepStrictEqual(deadLetter.compensation?.owner, {
          kind: "host-action",
          id: audit.id,
          state: "dead-lettered",
        })) {
        invalidState(`${field} is not bound to exact durable host-action dead-letter evidence`);
      }
      continue;
    }
    if (!terminal) {
      if (audit.updatedAt !== audit.requestedAt) invalidState(`${field}.updatedAt differs from its queued authority`);
      continue;
    }
    canonicalIsoTimestamp(audit.startedAt, `${field}.startedAt`);
    canonicalIsoTimestamp(audit.completedAt, `${field}.completedAt`);
    if (Date.parse(audit.completedAt) < Date.parse(audit.startedAt)) {
      invalidState(`${field}.completedAt precedes startedAt`);
    }
    const resultIds = array(audit.resultIds, `${field}.resultIds`, { max: 1 });
    if (resultIds.length !== 1) invalidState(`${field}.resultIds must bind exactly one terminal result`);
    boundedString(resultIds[0], `${field}.resultIds[0]`, { max: 256 });
    const processed = processedActionResults[resultIds[0]];
    if (!processed || processed.auditId !== audit.id) {
      invalidState(`${field} terminal state lacks its exact processed result record`);
    }
  }

  for (const records of Object.values(commandDeadLetters)) {
    for (const deadLetter of records) {
      const owner = deadLetter.compensation?.owner;
      if (owner?.kind !== "host-action") continue;
      const audit = auditsById.get(owner.id);
      if (!audit || audit.status !== "dead-lettered" || audit.deadLetterId !== deadLetter.deadLetterId) {
        invalidState(`Command dead letter ${deadLetter.deadLetterId} has no exact host-action audit owner`);
      }
    }
  }

  const processedIds = new Set();
  const latestByNode = new Map();
  for (const [resultId, value] of Object.entries(processedActionResults)) {
    const field = `processedActionResults.${resultId}`;
    const processed = exactKeys(value, [
      "resultId", "nodeId", "auditId", "receivedAt", "resultSha256", "result",
    ], field);
    if (processedIds.has(resultId) || processed.resultId !== resultId) {
      invalidState(`${field} identity is duplicated or mismatched`);
    }
    processedIds.add(resultId);
    if (!nodes[processed.nodeId]) invalidState(`${field}.nodeId has no registered node`);
    boundedString(processed.auditId, `${field}.auditId`, { max: 256 });
    canonicalIsoTimestamp(processed.receivedAt, `${field}.receivedAt`);
    nullableSha256(processed.resultSha256, `${field}.resultSha256`);
    let normalized;
    try {
      [normalized] = normalizeActionResults([processed.result]);
    } catch (error) {
      invalidState(`${field}.result is invalid: ${error.message}`, error);
    }
    if (!isDeepStrictEqual(normalized, processed.result)
      || normalized.resultId !== resultId
      || processed.resultSha256 !== sha256Json(normalized)) {
      invalidState(`${field} does not bind its exact canonical result body`);
    }
    const audit = auditsById.get(processed.auditId);
    const summary = actionResultSummary(normalized);
    if (!audit || audit.nodeId !== processed.nodeId || audit.actionId !== normalized.actionId
      || audit.commandId !== normalized.commandId || audit.commandSequence !== normalized.sequence
      || audit.type !== normalized.actionType || audit.status !== normalized.status
      || audit.startedAt !== normalized.startedAt || audit.completedAt !== normalized.completedAt
      || !isDeepStrictEqual(audit.result, summary.result)
      || !isDeepStrictEqual(audit.error, summary.error)
      || !isDeepStrictEqual(audit.resultIds, [resultId])
      || audit.updatedAt !== processed.receivedAt) {
      invalidState(`${field} differs from its authoritative action audit entry`);
    }
    const previous = latestByNode.get(processed.nodeId);
    if (!previous || Date.parse(previous.receivedAt) <= Date.parse(processed.receivedAt)) {
      latestByNode.set(processed.nodeId, processed);
    }
  }
  for (const [nodeId, processed] of latestByNode.entries()) {
    const result = processed.result;
    const expected = {
      actionType: result.actionType,
      commandId: result.commandId,
      resultId: result.resultId,
      status: result.status,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      result: result.result ?? null,
      error: result.error ?? null,
    };
    if (!isDeepStrictEqual(nodes[nodeId].lastActionResult, expected)) {
      invalidState(`nodes.${nodeId}.lastActionResult differs from durable host-action evidence`);
    }
  }
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!latestByNode.has(nodeId) && node.lastActionResult != null) {
      invalidState(`nodes.${nodeId}.lastActionResult has no retained durable host-action evidence`);
    }
  }
}

function normalizePersistedProject(input) {
  const persisted = record(input, "project");
  isoTimestamp(persisted.updatedAt, "project.updatedAt");
  let normalized;
  try {
    normalized = normalizeProject(persisted);
  } catch (error) {
    invalidState(`Server project is invalid: ${error.message}`, error);
  }

  // normalizeProject is intentionally forgiving at API boundaries, but a
  // persisted authoritative project must already be canonical. Otherwise a
  // damaged-but-valid JSON object (for example {}) could be silently replaced
  // with defaults and erase the room topology instead of restoring the LKG.
  const canonical = { ...normalized, updatedAt: persisted.updatedAt };
  if (!isDeepStrictEqual(canonical, persisted)) {
    invalidState("Server project is not in canonical persisted form");
  }
  return canonical;
}

function validateTimeline(timeline, project, nodes, commandQueues, media) {
  exactKeys(timeline, [
    "status", "baseFrame", "playAtNs", "pauseAtNs", "pauseFrame",
    "frameRateNum", "frameRateDen", "preparedAssetSha256", "targetNodeIds",
    "prepareSequences", "updatedAtNs",
  ], "timeline");
  const statuses = new Set(["idle", "prepared", "scheduled", "pause-scheduled", "paused"]);
  if (!statuses.has(timeline.status)) invalidState("timeline.status is invalid");
  integerString(timeline.baseFrame, "timeline.baseFrame", { signed: true });
  integerString(timeline.playAtNs, "timeline.playAtNs", { nullable: true });
  integerString(timeline.pauseAtNs, "timeline.pauseAtNs", { nullable: true });
  integerString(timeline.pauseFrame, "timeline.pauseFrame", { nullable: true, signed: true });
  integerString(timeline.updatedAtNs, "timeline.updatedAtNs", { nullable: true });
  if (timeline.frameRateNum !== project.canvas.frameRateNum || timeline.frameRateDen !== project.canvas.frameRateDen) {
    invalidState("timeline frame rate does not match the authoritative project canvas");
  }
  if (timeline.preparedAssetSha256 != null && !/^[a-f0-9]{64}$/.test(timeline.preparedAssetSha256)) {
    invalidState("timeline.preparedAssetSha256 is invalid");
  }
  if (timeline.preparedAssetSha256 != null && media[timeline.preparedAssetSha256]?.sha256 !== timeline.preparedAssetSha256) {
    invalidState("timeline.preparedAssetSha256 is absent from the authoritative media library");
  }
  const targetNodeIds = array(timeline.targetNodeIds, "timeline.targetNodeIds", { max: 10_000 });
  if (new Set(targetNodeIds).size !== targetNodeIds.length) invalidState("timeline.targetNodeIds must be unique");
  for (const [index, nodeId] of targetNodeIds.entries()) {
    boundedString(nodeId, `timeline.targetNodeIds[${index}]`, { max: 128 });
    if (!nodes[nodeId]) invalidState(`timeline references unknown node ${nodeId}`);
  }
  const prepareSequences = record(timeline.prepareSequences, "timeline.prepareSequences");
  const prepareNodeIds = Object.keys(prepareSequences);
  if (prepareNodeIds.length !== targetNodeIds.length
    || targetNodeIds.some((nodeId) => !Object.hasOwn(prepareSequences, nodeId))) {
    invalidState("timeline.prepareSequences must bind exactly every authoritative target node");
  }
  for (const [nodeId, sequence] of Object.entries(prepareSequences)) {
    if (!nodes[nodeId]) invalidState(`timeline.prepareSequences references unknown node ${nodeId}`);
    safeInteger(sequence, `timeline.prepareSequences.${nodeId}`, { min: 1 });
    const node = nodes[nodeId];
    if (sequence > node.commandSequence) {
      invalidState(`timeline.prepareSequences.${nodeId} exceeds the node command cursor`);
    }
    if (sequence > node.ackSequence) {
      const command = commandQueues[nodeId]?.find((candidate) => candidate.sequence === sequence);
      if (command?.type !== COMMAND.PREPARE
        || command.payload?.assetSha256 !== timeline.preparedAssetSha256
        || Number(command.payload?.projectRevision) !== Number(project.revision)
        || command.payload?.frameRateNum !== timeline.frameRateNum
        || command.payload?.frameRateDen !== timeline.frameRateDen) {
        invalidState(`timeline.prepareSequences.${nodeId} is not an acknowledged or durably queued PREPARE`);
      }
    }
  }

  if (timeline.status === "idle") {
    if (timeline.baseFrame !== "0" || timeline.playAtNs != null || timeline.pauseAtNs != null
      || timeline.pauseFrame != null || timeline.preparedAssetSha256 != null
      || targetNodeIds.length !== 0 || prepareNodeIds.length !== 0) {
      invalidState("idle timeline cannot retain playback, asset, target or PREPARE authority");
    }
    return;
  }
  if (targetNodeIds.length < 1) invalidState(`${timeline.status} timeline requires at least one target node`);
  if (timeline.status === "prepared") {
    if (timeline.playAtNs != null || timeline.pauseAtNs != null || timeline.pauseFrame != null) {
      invalidState("prepared timeline cannot retain play or pause scheduling fields");
    }
    return;
  }
  if (timeline.status === "scheduled") {
    if (timeline.playAtNs == null || timeline.pauseAtNs != null || timeline.pauseFrame != null) {
      invalidState("scheduled timeline requires only playAtNs");
    }
    return;
  }
  if (timeline.status === "pause-scheduled") {
    if (timeline.pauseAtNs == null || timeline.pauseFrame == null) {
      invalidState("pause-scheduled timeline requires pauseAtNs and pauseFrame");
    }
    return;
  }
  if (timeline.playAtNs != null || timeline.pauseAtNs == null || timeline.pauseFrame == null
    || timeline.baseFrame !== timeline.pauseFrame) {
    invalidState("paused timeline must bind its exact paused base frame and effective instant");
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CAMERA_RECORD_STATES = new Set(["queued", ...Object.values(CAMERA_CALIBRATION_STATE)]);
const TERMINAL_CAMERA_RECORD_STATES = new Set([
  CAMERA_CALIBRATION_STATE.COMPLETE,
  CAMERA_CALIBRATION_STATE.FAILED,
  CAMERA_CALIBRATION_STATE.CANCELLED,
]);
const SIMPLE_OPTICAL_STATES = new Set([
  "not-applicable",
  "pending-apply",
  "pending-bundle-commit",
  "blocked",
  "pending-renderer-ack",
  "pending-bundle-renderer-ack",
  "pending-optical-capture",
  "pending-bundle-optical-verification",
  "superseded",
]);
const CAMERA_RECORD_KEYS = new Set([
  "schemaVersion", "sessionId", "nodeId", "mode", "state", "progress", "project", "outputIds",
  "cameraId", "plan", "camera", "manifest", "manifestSha256", "terminalReportSha256",
  "projectPatch", "projectPatchSha256",
  "failure", "projectApplied", "projectCommitted", "currentlyApplied", "appliedRevision",
  "preApplyProjectRevision", "preApplyOutputs", "bundleId", "bundleMemberId", "viewCaptureId",
  "bundleRollbackSnapshotId", "rendererAcknowledged", "rendererAcknowledgedAt",
  "rendererCorrectionBinding", "operatorPrompt", "confirmationCommands", "opticalVerification", "createdAt", "updatedAt",
  "startedAt", "completedAt", "cancelRequestedAt", "command",
]);

function rejectUnknownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) invalidState(`${field} contains unknown fields: ${unknown.join(", ")}`);
}

function canonicalIsoTimestamp(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  isoTimestamp(value, field);
  if (new Date(Date.parse(value)).toISOString() !== value) invalidState(`${field} must be a canonical UTC instant`);
  return value;
}

function nullableSha256(value, field) {
  if (value != null && (typeof value !== "string" || !SHA256_PATTERN.test(value))) {
    invalidState(`${field} must be null or a lowercase SHA-256 digest`);
  }
  return value;
}

function validateCommandReference(reference, expectedType, node, commandQueues, commandDeadLetters, field) {
  if (reference == null) return null;
  const value = exactKeys(reference, ["id", "sequence", "type"], field);
  boundedString(value.id, `${field}.id`, { max: 256 });
  safeInteger(value.sequence, `${field}.sequence`, { min: 1 });
  if (value.type !== expectedType || value.sequence > node.commandSequence) {
    invalidState(`${field} is not a valid ${expectedType} command reference`);
  }
  if (value.sequence > node.ackSequence) {
    const queued = commandQueues[node.nodeId]?.find((command) => command.sequence === value.sequence);
    const deadLetter = commandDeadLetters[node.nodeId]?.find((record) => (
      record.command?.id === value.id
      && record.command?.sequence === value.sequence
      && record.command?.type === value.type
    ));
    if ((queued?.id !== value.id || queued?.type !== value.type) && !deadLetter) {
      invalidState(`${field} is neither acknowledged, queued nor bound to exact dead-letter evidence`);
    }
  }
  return value;
}

function validateCameraProgress(progressInput, plan, state, field) {
  const progress = exactKeys(progressInput, ["completedSteps", "totalSteps", "stepIndex"], field);
  safeInteger(progress.completedSteps, `${field}.completedSteps`);
  safeInteger(progress.totalSteps, `${field}.totalSteps`);
  if (!Number.isSafeInteger(progress.stepIndex) || progress.stepIndex < -1) {
    invalidState(`${field}.stepIndex must be an integer >= -1`);
  }
  if (progress.totalSteps !== plan.steps.length || progress.completedSteps > progress.totalSteps
    || progress.stepIndex >= progress.totalSteps) {
    invalidState(`${field} does not match the immutable calibration plan`);
  }
  if (state === "queued" && (progress.completedSteps !== 0 || progress.stepIndex !== -1)) {
    invalidState(`${field} cannot claim progress before the calibration command starts`);
  }
  if (state === CAMERA_CALIBRATION_STATE.COMPLETE
    && (progress.completedSteps !== progress.totalSteps || progress.stepIndex !== progress.totalSteps - 1)) {
    invalidState(`${field} is incomplete for a completed camera calibration`);
  }
  return progress;
}

function validateFailure(value, field) {
  if (value == null) return null;
  const failure = record(value, field);
  boundedString(failure.code, `${field}.code`, { max: 128 });
  boundedString(failure.message, `${field}.message`, { max: 2_048 });
  return failure;
}

function validateOperatorPrompt(value, field) {
  if (value == null) return null;
  const prompt = exactKeys(value, [
    "state", "stepId", "confirmationId", "title", "instructions", "conditions",
    "requestedAt", "confirmedAt",
  ], field);
  if (!["waiting", "confirmation-queued", "confirmed"].includes(prompt.state)) {
    invalidState(`${field}.state is invalid`);
  }
  boundedString(prompt.stepId, `${field}.stepId`, { max: 256 });
  boundedString(prompt.confirmationId, `${field}.confirmationId`, { max: 256 });
  boundedString(prompt.title, `${field}.title`, { max: 256 });
  if (typeof prompt.instructions !== "string" || prompt.instructions.length > 4_096) {
    invalidState(`${field}.instructions is invalid`);
  }
  for (const [index, condition] of array(prompt.conditions, `${field}.conditions`, { max: 32 }).entries()) {
    boundedString(condition, `${field}.conditions[${index}]`, { max: 256 });
  }
  canonicalIsoTimestamp(prompt.requestedAt, `${field}.requestedAt`, { nullable: true });
  canonicalIsoTimestamp(prompt.confirmedAt, `${field}.confirmedAt`, { nullable: true });
  return prompt;
}

function plannedCameraConfirmationLeases(plan, field) {
  const leases = new Map();
  for (const step of plan.steps) {
    if (step.requiresOperatorConfirmation !== true) continue;
    const leaseId = step.confirmationLeaseId;
    if (typeof leaseId !== "string" || leaseId.length < 1) {
      invalidState(`${field} contains an operator step without a confirmation lease`);
    }
    if (!leases.has(leaseId)) leases.set(leaseId, step);
  }
  return [...leases.entries()].map(([confirmationLeaseId, firstStep]) => ({
    confirmationLeaseId,
    firstStepId: firstStep.id,
  }));
}

function validateCameraConfirmationCommands(
  calibration,
  plan,
  manifest,
  node,
  commandQueues,
  commandDeadLetters,
  field,
) {
  const commands = array(calibration.confirmationCommands, `${field}.confirmationCommands`, {
    max: plan.steps.length,
  });
  const planned = plannedCameraConfirmationLeases(plan, `${field}.plan`);
  const plannedByLease = new Map(planned.map((entry) => [entry.confirmationLeaseId, entry]));
  const seenLeases = new Set();
  const seenIds = new Set();
  let priorSequence = 0;
  for (const [index, entry] of commands.entries()) {
    const commandField = `${field}.confirmationCommands[${index}]`;
    exactKeys(entry, [
      "id", "sequence", "type", "stepId", "confirmationId", "confirmationLeaseId", "confirmedAt",
    ], commandField);
    validateCommandReference(
      { id: entry.id, sequence: entry.sequence, type: entry.type },
      COMMAND.CONFIRM_CAMERA_CALIBRATION,
      node,
      commandQueues,
      commandDeadLetters,
      `${commandField}.command`,
    );
    boundedString(entry.stepId, `${commandField}.stepId`, { max: 512 });
    boundedString(entry.confirmationId, `${commandField}.confirmationId`, { max: 256 });
    boundedString(entry.confirmationLeaseId, `${commandField}.confirmationLeaseId`, { max: 128 });
    canonicalIsoTimestamp(entry.confirmedAt, `${commandField}.confirmedAt`);
    const expected = plannedByLease.get(entry.confirmationLeaseId);
    if (!expected || expected.firstStepId !== entry.stepId
      || seenLeases.has(entry.confirmationLeaseId) || seenIds.has(entry.confirmationId)
      || entry.sequence <= priorSequence) {
      invalidState(`${commandField} is replayed, out of order or not bound to the first step of its plan lease`);
    }
    seenLeases.add(entry.confirmationLeaseId);
    seenIds.add(entry.confirmationId);
    priorSequence = entry.sequence;
  }

  if (calibration.operatorPrompt?.state !== "waiting" && calibration.operatorPrompt != null) {
    const promptCommand = commands.find((entry) => (
      entry.stepId === calibration.operatorPrompt.stepId
      && entry.confirmationId === calibration.operatorPrompt.confirmationId
    ));
    if (!promptCommand || promptCommand.confirmedAt !== calibration.operatorPrompt.confirmedAt) {
      invalidState(`${field}.operatorPrompt is not bound to its durable Server confirmation command`);
    }
  }

  if (manifest?.applicable !== true) return commands;
  const captures = manifest.captureProvenance?.captures;
  if (!Array.isArray(captures) || commands.length !== planned.length) {
    invalidState(`${field} applicable manifest lacks every Server-bound physical confirmation`);
  }
  for (let index = 0; index < planned.length; index += 1) {
    const expected = planned[index];
    const issued = commands[index];
    const matching = captures.filter((capture) => (
      capture.conditionVerification?.confirmationLeaseId === expected.confirmationLeaseId
    ));
    const confirmationIds = new Set(matching.map((capture) => (
      capture.conditionVerification?.confirmationId
    )));
    const confirmedAts = new Set(matching.map((capture) => (
      capture.conditionVerification?.verifiedAt
    )));
    if (matching.length === 0 || confirmationIds.size !== 1 || confirmedAts.size !== 1
      || issued.confirmationLeaseId !== expected.confirmationLeaseId
      || issued.stepId !== expected.firstStepId
      || issued.confirmationId !== [...confirmationIds][0]
      || issued.confirmedAt !== [...confirmedAts][0]) {
      invalidState(`${field}.manifest confirmation evidence differs from Server command history`);
    }
  }
  if (commands.some((entry) => entry.sequence > node.ackSequence)) {
    invalidState(`${field} accepted measured evidence before every confirmation command was acknowledged`);
  }
  return commands;
}

function validateCanonicalOutput(output, field) {
  return canonicalNormalized(output, normalizeOutputConfig, field);
}

function calibrationSnapshotOutputs(calibration, cameraCalibrationBundles) {
  if (Array.isArray(calibration.preApplyOutputs)) return calibration.preApplyOutputs;
  if (!calibration.bundleId || !calibration.bundleRollbackSnapshotId) return null;
  const snapshot = cameraCalibrationBundles[calibration.bundleId]?.rollbackSnapshot;
  if (snapshot?.id !== calibration.bundleRollbackSnapshotId || !Array.isArray(snapshot.outputs)) return null;
  const outputIds = new Set(calibration.outputIds || []);
  return snapshot.outputs.filter((output) => outputIds.has(output?.id));
}

function validateCalibrationProjectPatch(calibration, manifest, project, cameraCalibrationBundles, field) {
  const patch = exactKeys(calibration.projectPatch, [
    "schemaVersion", "sessionId", "projectId", "baseRevision", "outputs",
  ], `${field}.projectPatch`);
  if (patch.schemaVersion !== CAMERA_CALIBRATION_SCHEMA_VERSION
    || patch.sessionId !== calibration.sessionId
    || patch.projectId !== calibration.plan.project.id
    || patch.baseRevision !== calibration.plan.project.revision) {
    invalidState(`${field}.projectPatch identity is invalid`);
  }
  const outputs = array(patch.outputs, `${field}.projectPatch.outputs`, { max: 256 });
  for (const [index, output] of outputs.entries()) {
    validateCanonicalOutput(output, `${field}.projectPatch.outputs[${index}]`);
  }
  const snapshot = calibrationSnapshotOutputs(calibration, cameraCalibrationBundles) || [];
  const baseline = new Map(snapshot.map((output) => [output?.id, output]));
  const patchById = new Map(outputs.map((output) => [output.id, output]));
  const syntheticOutputs = project.outputs.map((output) => baseline.get(output.id) || output);
  for (const output of [...snapshot, ...outputs]) {
    if (!syntheticOutputs.some((candidate) => candidate.id === output.id)) {
      syntheticOutputs.push(baseline.get(output.id) || output);
    }
  }
  let normalized;
  try {
    normalized = validateCameraCalibrationProjectPatch(patch, manifest, {
      ...project,
      id: calibration.plan.project.id,
      revision: calibration.plan.project.revision,
      outputs: syntheticOutputs.map((output) => patchById.has(output.id) && !baseline.has(output.id)
        ? { ...output, nodeId: output.nodeId || calibration.nodeId }
        : output),
    }, { nodeId: calibration.nodeId });
  } catch (error) {
    invalidState(`${field}.projectPatch is invalid: ${error.message}`, error);
  }
  if (!isDeepStrictEqual(patch, normalized)) invalidState(`${field}.projectPatch is not canonical`);
  if (calibration.projectPatchSha256 !== sha256Json(normalized)) {
    invalidState(`${field}.projectPatchSha256 does not bind the exact canonical patch`);
  }
  return normalized;
}

function validateRendererBinding(calibration, field) {
  const binding = canonicalNormalized(
    calibration.rendererCorrectionBinding,
    (value) => normalizeRendererCorrectionBinding(value, `${field}.rendererCorrectionBinding`),
    `${field}.rendererCorrectionBinding`,
  );
  const manifestOutputs = new Map(calibration.manifest.outputs.map((output) => [output.outputId, output]));
  const bindingIndexes = new Map(binding.outputs.map((output, index) => [output.id, index]));
  let priorIndex = -1;
  for (const output of calibration.plan.outputs) {
    const index = bindingIndexes.get(output.id);
    const observed = index == null ? null : binding.outputs[index];
    const artifacts = manifestOutputs.get(output.id)?.artifacts;
    if (!observed || index <= priorIndex || observed.processingBypass !== false
      || observed.artifacts.blendMapSha256 !== artifacts?.blendWeight?.sha256
      || observed.artifacts.blackMapSha256 !== artifacts?.blackPedestal?.sha256
      || observed.artifacts.maskSha256 !== artifacts?.mask?.sha256
      || observed.artifacts.colorLutSha256 !== artifacts?.lut?.sha256) {
      invalidState(`${field}.rendererCorrectionBinding does not bind the exact manifest outputs in plan order`);
    }
    priorIndex = index;
  }
  return binding;
}

function validateOpticalVerification(calibration, node, commandQueues, commandDeadLetters, project, field) {
  const wrapper = record(calibration.opticalVerification, `${field}.opticalVerification`);
  if (wrapper.runtime == null || wrapper.plan == null) {
    if (wrapper.runtime != null || wrapper.plan != null || !SIMPLE_OPTICAL_STATES.has(wrapper.state)) {
      invalidState(`${field}.opticalVerification is missing its authoritative plan/runtime evidence`);
    }
    if (wrapper.required !== (wrapper.state !== "not-applicable") || wrapper.verifiedAt != null) {
      invalidState(`${field}.opticalVerification simple state has invalid applicability evidence`);
    }
    if (wrapper.state === "not-applicable" && calibration.mode !== "simulation") {
      invalidState(`${field}.opticalVerification cannot be not-applicable for measured calibration`);
    }
    if (wrapper.state === "pending-bundle-commit" && (!calibration.bundleId || calibration.projectPatch == null)) {
      invalidState(`${field}.opticalVerification pending bundle commit lacks staged evidence`);
    }
    if (["pending-renderer-ack", "pending-bundle-renderer-ack"].includes(wrapper.state)
      && (calibration.projectCommitted !== true || calibration.rendererAcknowledged !== false
        || calibration.currentlyApplied !== true)) {
      invalidState(`${field}.opticalVerification renderer-ack state is inconsistent with project authority`);
    }
    if (["pending-optical-capture", "pending-bundle-optical-verification"].includes(wrapper.state)
      && (calibration.rendererAcknowledged !== true || calibration.currentlyApplied !== true)) {
      invalidState(`${field}.opticalVerification capture state lacks current renderer acknowledgement`);
    }
    if (wrapper.state === "superseded" && calibration.currentlyApplied !== false) {
      invalidState(`${field}.opticalVerification superseded state still claims current application`);
    }
    return;
  }

  const plan = canonicalNormalized(
    wrapper.plan,
    normalizeCameraOpticalVerificationPlan,
    `${field}.opticalVerification.plan`,
  );
  const runtime = canonicalNormalized(
    wrapper.runtime,
    (value) => normalizeCameraOpticalVerificationState(value, { plan }),
    `${field}.opticalVerification.runtime`,
  );
  if (plan.calibrationSessionId !== calibration.sessionId || plan.nodeId !== calibration.nodeId
    || plan.project.id !== calibration.plan.project.id
    || plan.project.baseRevision !== calibration.plan.project.revision
    || plan.project.appliedRevision !== calibration.appliedRevision
    || plan.rendererAcknowledgedAt !== calibration.rendererAcknowledgedAt
    || !isDeepStrictEqual(plan.rendererCorrectionBinding, calibration.rendererCorrectionBinding)) {
    invalidState(`${field}.opticalVerification plan is not bound to the exact applied calibration revision`);
  }
  if (wrapper.required !== true) invalidState(`${field}.opticalVerification runtime must be required`);
  for (const key of [
    "state", "verificationId", "appliedRevision", "progress", "operatorPrompt", "failure", "report",
    "rollback", "startedAt", "updatedAt", "completedAt",
  ]) {
    if (!isDeepStrictEqual(wrapper[key], runtime[key])) {
      invalidState(`${field}.opticalVerification.${key} does not mirror its canonical runtime`);
    }
  }
  if (wrapper.verifiedAt !== (runtime.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
    ? runtime.completedAt
    : null)) {
    invalidState(`${field}.opticalVerification.verifiedAt is inconsistent with conclusive runtime evidence`);
  }
  validateCommandReference(wrapper.command, COMMAND.START_CAMERA_OPTICAL_VERIFICATION, node, commandQueues,
    commandDeadLetters,
    `${field}.opticalVerification.command`);
  if (wrapper.cancelCommand != null) {
    validateCommandReference(wrapper.cancelCommand, COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION, node, commandQueues,
      commandDeadLetters,
      `${field}.opticalVerification.cancelCommand`);
    canonicalIsoTimestamp(wrapper.cancelRequestedAt, `${field}.opticalVerification.cancelRequestedAt`);
  }
  if (wrapper.restoreCommand != null) {
    validateCommandReference(wrapper.restoreCommand, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK, node, commandQueues,
      commandDeadLetters,
      `${field}.opticalVerification.restoreCommand`);
  }
  const confirmationCommands = array(
    wrapper.confirmationCommands,
    `${field}.opticalVerification.confirmationCommands`,
    { max: plan.steps.length },
  );
  const leases = new Set();
  for (const [index, entry] of confirmationCommands.entries()) {
    const commandField = `${field}.opticalVerification.confirmationCommands[${index}]`;
    exactKeys(entry, [
      "id", "sequence", "type", "confirmationId", "confirmationLeaseId", "stepId", "confirmedAt",
    ], commandField);
    validateCommandReference(
      { id: entry.id, sequence: entry.sequence, type: entry.type },
      COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
      node,
      commandQueues,
      commandDeadLetters,
      `${commandField}.command`,
    );
    boundedString(entry.confirmationId, `${commandField}.confirmationId`, { max: 256 });
    boundedString(entry.confirmationLeaseId, `${commandField}.confirmationLeaseId`, { max: 256 });
    boundedString(entry.stepId, `${commandField}.stepId`, { max: 512 });
    canonicalIsoTimestamp(entry.confirmedAt, `${commandField}.confirmedAt`);
    if (leases.has(entry.confirmationLeaseId)) invalidState(`${commandField} reuses a confirmation lease`);
    leases.add(entry.confirmationLeaseId);
  }
  const confirmations = runtime.report?.confirmations;
  if (confirmations != null) {
    if (confirmations.length !== confirmationCommands.length) {
      invalidState(`${field}.opticalVerification report is not backed by every Server confirmation command`);
    }
    confirmations.forEach((reported, index) => {
      const issued = confirmationCommands[index];
      if (issued.id !== reported.serverCommandId || issued.sequence !== reported.serverCommandSequence
        || issued.confirmationId !== reported.confirmationId
        || issued.confirmationLeaseId !== reported.confirmationLeaseId
        || issued.stepId !== reported.firstStepId || issued.confirmedAt !== reported.confirmedAt) {
        invalidState(`${field}.opticalVerification confirmation report differs from Server command history`);
      }
    });
  }
  if (runtime.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
    && (calibration.currentlyApplied !== true || calibration.rendererAcknowledged !== true
      || project.id !== plan.project.id || project.revision !== plan.project.appliedRevision
      || runtime.report?.state !== CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED)) {
    invalidState(`${field}.opticalVerification verified state is not current and conclusive`);
  }
  if ([
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
  ].includes(runtime.state) && calibration.currentlyApplied !== false) {
    invalidState(`${field}.opticalVerification rollback state still claims calibration application`);
  }
}

function validateCameraCalibrationRecord(calibration, sessionId, input) {
  const field = `cameraCalibrations.${sessionId}`;
  rejectUnknownKeys(calibration, CAMERA_RECORD_KEYS, field);
  if (calibration.schemaVersion !== 1 || calibration.sessionId !== sessionId
    || !input.nodes[calibration.nodeId]) invalidState(`${field} identity, schema or node binding is invalid`);
  if (!new Set(["measured", "simulation"]).has(calibration.mode)
    || !CAMERA_RECORD_STATES.has(calibration.state)) invalidState(`${field} mode or state is invalid`);
  const plan = canonicalNormalized(calibration.plan, normalizeCameraCalibrationPlan, `${field}.plan`);
  if (plan.sessionId !== sessionId || plan.project.id !== calibration.project?.id
    || plan.project.revision !== calibration.project?.revision
    || !isDeepStrictEqual(calibration.outputIds, plan.outputs.map((output) => output.id))
    || calibration.cameraId !== plan.requestedCameraId) {
    invalidState(`${field} outer project/output/camera identity does not match its immutable plan`);
  }
  validateCameraProgress(calibration.progress, plan, calibration.state, `${field}.progress`);
  canonicalIsoTimestamp(calibration.createdAt, `${field}.createdAt`);
  canonicalIsoTimestamp(calibration.updatedAt, `${field}.updatedAt`);
  canonicalIsoTimestamp(calibration.startedAt, `${field}.startedAt`, { nullable: true });
  canonicalIsoTimestamp(calibration.completedAt, `${field}.completedAt`, { nullable: true });
  canonicalIsoTimestamp(calibration.cancelRequestedAt, `${field}.cancelRequestedAt`, { nullable: true });
  validateFailure(calibration.failure, `${field}.failure`);
  validateOperatorPrompt(calibration.operatorPrompt, `${field}.operatorPrompt`);
  validateCommandReference(calibration.command, COMMAND.START_CAMERA_CALIBRATION, input.nodes[calibration.nodeId],
    input.commandQueues, input.commandDeadLetters, `${field}.command`);

  let manifest = null;
  if (calibration.manifest != null) {
    manifest = canonicalNormalized(
      calibration.manifest,
      (value) => normalizeCameraCalibrationManifest(value, { plan }),
      `${field}.manifest`,
    );
    if ((calibration.mode === "simulation") !== (manifest.provenance === "simulated")
      || (calibration.mode === "simulation" && manifest.applicable !== false)) {
      invalidState(`${field}.manifest provenance exceeds its requested calibration mode`);
    }
  }
  nullableSha256(calibration.manifestSha256, `${field}.manifestSha256`);
  if (calibration.manifestSha256 != null
    && (manifest == null || calibration.manifestSha256 !== sha256Json(manifest))) {
    invalidState(`${field}.manifestSha256 does not bind the exact canonical manifest`);
  }
  if (calibration.terminalReportSha256 != null) {
    nullableSha256(calibration.terminalReportSha256, `${field}.terminalReportSha256`);
    if (!TERMINAL_CAMERA_RECORD_STATES.has(calibration.state)) {
      invalidState(`${field}.terminalReportSha256 exists before a terminal calibration state`);
    }
  }
  if (calibration.state === CAMERA_CALIBRATION_STATE.COMPLETE && manifest == null) {
    invalidState(`${field} completed without a canonical calibration manifest`);
  }
  if (manifest != null && calibration.state === CAMERA_CALIBRATION_STATE.COMPLETE
    && !isDeepStrictEqual(calibration.camera, manifest.camera)) {
    invalidState(`${field}.camera does not match its completed manifest provenance`);
  }
  validateCameraConfirmationCommands(
    calibration,
    plan,
    manifest,
    input.nodes[calibration.nodeId],
    input.commandQueues,
    input.commandDeadLetters,
    field,
  );

  for (const name of ["projectApplied", "projectCommitted", "currentlyApplied", "rendererAcknowledged"]) {
    if (typeof calibration[name] !== "boolean") invalidState(`${field}.${name} must be boolean`);
  }
  if (calibration.projectApplied !== calibration.projectCommitted) {
    invalidState(`${field} projectApplied/projectCommitted authority is inconsistent`);
  }
  if (calibration.appliedRevision != null) safeInteger(calibration.appliedRevision, `${field}.appliedRevision`, { min: 1 });
  if (calibration.preApplyProjectRevision != null) {
    safeInteger(calibration.preApplyProjectRevision, `${field}.preApplyProjectRevision`, { min: 1 });
  }
  nullableSha256(calibration.projectPatchSha256, `${field}.projectPatchSha256`);
  if ((calibration.projectPatch == null) !== (calibration.projectPatchSha256 == null)) {
    invalidState(`${field} project patch and digest must appear together`);
  }
  if (calibration.projectPatch != null) {
    if (!calibration.bundleId || manifest == null || manifest.applicable !== true) {
      invalidState(`${field} retained project patch is not a measured bundle member patch`);
    }
    validateCalibrationProjectPatch(calibration, manifest, input.project, input.cameraCalibrationBundles, field);
  }
  if (calibration.projectCommitted) {
    if (manifest?.applicable !== true || calibration.mode !== "measured"
      || calibration.state !== CAMERA_CALIBRATION_STATE.COMPLETE
      || calibration.appliedRevision !== plan.project.revision + 1
      || calibration.preApplyProjectRevision !== plan.project.revision) {
      invalidState(`${field} applied revision lacks exact completed measured evidence`);
    }
    const snapshot = calibrationSnapshotOutputs(calibration, input.cameraCalibrationBundles);
    if (!Array.isArray(snapshot) || snapshot.length !== calibration.outputIds.length) {
      invalidState(`${field} exact pre-apply rollback snapshot is unavailable`);
    }
    const snapshotIds = snapshot.map((output, index) => {
      validateCanonicalOutput(output, `${field}.preApplySnapshot[${index}]`);
      return output.id;
    });
    if (new Set(snapshotIds).size !== snapshotIds.length
      || calibration.outputIds.some((outputId) => !snapshotIds.includes(outputId))) {
      invalidState(`${field} rollback snapshot output binding is incomplete`);
    }
  } else if (calibration.appliedRevision != null || calibration.preApplyProjectRevision != null
    || calibration.preApplyOutputs != null || calibration.bundleRollbackSnapshotId != null
    || calibration.currentlyApplied) {
    invalidState(`${field} claims applied/rollback authority without a committed project revision`);
  }
  if (calibration.currentlyApplied
    && (input.project.id !== plan.project.id || input.project.revision !== calibration.appliedRevision)) {
    invalidState(`${field}.currentlyApplied does not match the authoritative project revision`);
  }
  if (calibration.rendererAcknowledged) {
    canonicalIsoTimestamp(calibration.rendererAcknowledgedAt, `${field}.rendererAcknowledgedAt`);
    if (!calibration.projectCommitted) invalidState(`${field} renderer acknowledgement predates project commit`);
    if (calibration.rendererCorrectionBinding != null) validateRendererBinding(calibration, field);
    else if (calibration.currentlyApplied) invalidState(`${field} current renderer acknowledgement lacks a correction receipt`);
  } else if (calibration.rendererAcknowledgedAt != null || calibration.rendererCorrectionBinding != null) {
    invalidState(`${field} retains renderer evidence without renderer acknowledgement`);
  }
  if (manifest?.applicable === true && calibration.state === CAMERA_CALIBRATION_STATE.COMPLETE
    && !calibration.projectCommitted && calibration.projectPatch == null) {
    invalidState(`${field} completed applicable calibration has neither staged nor committed project evidence`);
  }
  if (calibration.mode === "simulation" && (calibration.projectCommitted || calibration.projectPatch != null)) {
    invalidState(`${field} simulated calibration cannot mutate authoritative projector configuration`);
  }
  if (!TERMINAL_CAMERA_RECORD_STATES.has(calibration.state) && calibration.completedAt != null) {
    invalidState(`${field} non-terminal calibration has completedAt evidence`);
  }
  validateOpticalVerification(
    calibration,
    input.nodes[calibration.nodeId],
    input.commandQueues,
    input.commandDeadLetters,
    input.project,
    field,
  );
  return calibration;
}

function validateBundleCommit(recordValue, bundle, field) {
  const commit = exactKeys(recordValue.commit, [
    "state", "commitId", "requestedAt", "projectRevision", "rendererCorrectionFingerprint",
    "rendererAcknowledgedAt", "failure",
  ], `${field}.commit`);
  if (!["not-requested", "awaiting-renderer-ack", "renderer-acknowledged", "blocked"].includes(commit.state)) {
    invalidState(`${field}.commit.state is invalid`);
  }
  validateFailure(commit.failure, `${field}.commit.failure`);
  if (commit.state === "not-requested") {
    if ([commit.commitId, commit.requestedAt, commit.projectRevision, commit.rendererCorrectionFingerprint,
      commit.rendererAcknowledgedAt, commit.failure].some((value) => value != null)
      || recordValue.rollbackSnapshot != null || bundle.finalEvidence != null) {
      invalidState(`${field}.commit not-requested state contains forged commit evidence`);
    }
    return commit;
  }
  if (commit.state === "blocked" && commit.commitId == null) {
    if (commit.failure == null || bundle.finalEvidence != null) {
      invalidState(`${field}.commit blocked pre-commit state lacks exact failure evidence`);
    }
    return commit;
  }
  boundedString(commit.commitId, `${field}.commit.commitId`, { max: 128 });
  canonicalIsoTimestamp(commit.requestedAt, `${field}.commit.requestedAt`);
  safeInteger(commit.projectRevision, `${field}.commit.projectRevision`, { min: 1 });
  if (commit.projectRevision !== bundle.baseProject.revision + 1 || recordValue.rollbackSnapshot == null) {
    invalidState(`${field}.commit is not the bundle base revision's atomic successor`);
  }
  if (commit.state === "awaiting-renderer-ack") {
    if (commit.rendererCorrectionFingerprint != null || commit.rendererAcknowledgedAt != null
      || commit.failure != null || bundle.finalEvidence != null) {
      invalidState(`${field}.commit awaiting state contains premature final evidence`);
    }
  } else if (commit.state === "renderer-acknowledged") {
    nullableSha256(commit.rendererCorrectionFingerprint, `${field}.commit.rendererCorrectionFingerprint`);
    canonicalIsoTimestamp(commit.rendererAcknowledgedAt, `${field}.commit.rendererAcknowledgedAt`);
    if (commit.failure != null || bundle.finalEvidence?.commitId !== commit.commitId
      || bundle.finalEvidence?.projectRevision !== commit.projectRevision
      || bundle.finalEvidence?.rendererCorrectionFingerprint !== commit.rendererCorrectionFingerprint
      || bundle.finalEvidence?.acknowledgedAt !== commit.rendererAcknowledgedAt) {
      invalidState(`${field}.commit final renderer evidence is not mirrored by the canonical bundle`);
    }
  } else if (commit.failure == null || bundle.finalEvidence != null) {
    invalidState(`${field}.commit blocked state lacks failure or retains forged final evidence`);
  }
  return commit;
}

function validateBundleRecord(recordValue, bundleId, input) {
  const field = `cameraCalibrationBundles.${bundleId}`;
  exactKeys(recordValue, [
    "schemaVersion", "bundle", "nodeId", "memberSessions", "rollbackSnapshot", "commit",
    "createdAt", "updatedAt",
  ], field);
  if (recordValue.schemaVersion !== 1 || !input.nodes[recordValue.nodeId]) {
    invalidState(`${field} schema or node binding is invalid`);
  }
  const bundle = canonicalNormalized(recordValue.bundle, normalizeCameraCalibrationBundle, `${field}.bundle`);
  if (bundle.bundleId !== bundleId) invalidState(`${field} identity is invalid`);
  canonicalIsoTimestamp(recordValue.createdAt, `${field}.createdAt`);
  canonicalIsoTimestamp(recordValue.updatedAt, `${field}.updatedAt`);
  if (recordValue.createdAt !== bundle.createdAt) invalidState(`${field}.createdAt does not mirror its bundle`);
  const sessions = record(recordValue.memberSessions, `${field}.memberSessions`);
  const memberIds = bundle.members.map((member) => member.memberId);
  if (Object.keys(sessions).length !== memberIds.length
    || memberIds.some((memberId) => !Object.hasOwn(sessions, memberId))) {
    invalidState(`${field}.memberSessions must bind exactly every immutable bundle member`);
  }
  const commit = validateBundleCommit(recordValue, bundle, field);
  if (recordValue.rollbackSnapshot != null) {
    const snapshot = exactKeys(recordValue.rollbackSnapshot, [
      "id", "projectId", "projectRevision", "outputIds", "outputs", "createdAt",
    ], `${field}.rollbackSnapshot`);
    boundedString(snapshot.id, `${field}.rollbackSnapshot.id`, { max: 128 });
    canonicalIsoTimestamp(snapshot.createdAt, `${field}.rollbackSnapshot.createdAt`);
    if (snapshot.projectId !== bundle.baseProject.id || snapshot.projectRevision !== bundle.baseProject.revision
      || !isDeepStrictEqual(snapshot.outputIds, bundle.expectedOutputIds)) {
      invalidState(`${field}.rollbackSnapshot does not bind the immutable bundle base/output set`);
    }
    const outputs = array(snapshot.outputs, `${field}.rollbackSnapshot.outputs`, { max: 256 });
    if (outputs.length !== bundle.expectedOutputIds.length) invalidState(`${field}.rollbackSnapshot is incomplete`);
    outputs.forEach((output, index) => validateCanonicalOutput(output, `${field}.rollbackSnapshot.outputs[${index}]`));
    if (!isDeepStrictEqual(outputs.map((output) => output.id), bundle.expectedOutputIds)) {
      invalidState(`${field}.rollbackSnapshot output order/identity is not canonical`);
    }
  }
  const correctionFingerprints = new Set();
  for (const member of bundle.members) {
    const sessionId = sessions[member.memberId];
    if (sessionId == null) {
      if (member.state !== CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.PENDING) {
        invalidState(`${field}.${member.memberId} has evidence without a Server-bound session`);
      }
      continue;
    }
    boundedString(sessionId, `${field}.memberSessions.${member.memberId}`, { max: 128 });
    const calibration = input.cameraCalibrations[sessionId];
    if (!calibration || calibration.bundleId !== bundleId || calibration.bundleMemberId !== member.memberId
      || calibration.viewCaptureId !== member.viewCaptureId || calibration.nodeId !== recordValue.nodeId
      || !isDeepStrictEqual(calibration.outputIds, member.outputIds)) {
      invalidState(`${field}.${member.memberId} session cross-link is invalid`);
    }
    if ([CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.CALIBRATED,
      CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED].includes(member.state)) {
      if (calibration.state !== CAMERA_CALIBRATION_STATE.COMPLETE || calibration.manifest?.applicable !== true
        || calibration.projectPatch == null || calibration.manifestSha256 !== member.calibrationEvidence?.manifestSha256
        || calibration.manifestSha256 !== sha256Json(calibration.manifest)
        || member.calibrationEvidence?.sessionId !== sessionId
        || member.calibrationEvidence?.baseProjectRevision !== bundle.baseProject.revision
        || member.calibrationEvidence?.completedAt !== calibration.manifest.completedAt) {
        invalidState(`${field}.${member.memberId} calibrated evidence differs from its retained session`);
      }
    }
    if (commit.state === "awaiting-renderer-ack" || commit.state === "renderer-acknowledged") {
      if (!calibration.projectCommitted || calibration.appliedRevision !== commit.projectRevision
        || calibration.bundleRollbackSnapshotId !== recordValue.rollbackSnapshot.id) {
        invalidState(`${field}.${member.memberId} does not share the atomic bundle commit/rollback authority`);
      }
    }
    if (commit.state === "renderer-acknowledged") {
      if (!calibration.rendererAcknowledged || calibration.rendererCorrectionBinding == null) {
        invalidState(`${field}.${member.memberId} lacks final renderer correction evidence`);
      }
      correctionFingerprints.add(calibration.rendererCorrectionBinding.fingerprint);
    }
    if (member.state === CAMERA_CALIBRATION_BUNDLE_MEMBER_STATE.VERIFIED) {
      const runtime = calibration.opticalVerification?.runtime;
      const report = runtime?.report;
      if (runtime?.state !== CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED
        || member.verificationEvidence?.verificationId !== runtime.verificationId
        || member.verificationEvidence?.reportSha256 !== sha256Json(report)
        || member.verificationEvidence?.projectRevision !== commit.projectRevision
        || member.verificationEvidence?.rendererCorrectionFingerprint !== commit.rendererCorrectionFingerprint
        || member.verificationEvidence?.completedAt !== report?.completedAt) {
        invalidState(`${field}.${member.memberId} forged final verification evidence`);
      }
    }
  }
  if (commit.state === "renderer-acknowledged"
    && (correctionFingerprints.size !== 1 || !correctionFingerprints.has(commit.rendererCorrectionFingerprint))) {
    invalidState(`${field} member renderer fingerprints do not match the atomic final evidence`);
  }
  if ([CAMERA_CALIBRATION_BUNDLE_STATE.VERIFIED,
    CAMERA_CALIBRATION_BUNDLE_STATE.SEAMS_UNVERIFIED,
    CAMERA_CALIBRATION_BUNDLE_STATE.ROOM_VERIFIED].includes(bundle.aggregateState)
    && commit.state !== "renderer-acknowledged") {
    invalidState(`${field} final verification state predates renderer acknowledgement`);
  }
  for (const adjacency of bundle.physicalAdjacencies) {
    for (const observation of adjacency.observations) {
      const preview = input.cameraSurveyPreviews[observation.preview.id];
      const expectedSha256 = sha256Json({
        bundleId,
        adjacencyId: adjacency.id,
        observationId: observation.observationId,
        previewId: observation.preview.id,
        previewArtifactSha256: observation.preview.artifactSha256,
        status: observation.status,
        projectRevision: observation.projectRevision,
        rendererCorrectionFingerprint: observation.rendererCorrectionFingerprint,
      });
      if (!preview || preview.status !== "complete" || preview.authenticatedAt !== observation.preview.authenticatedAt
        || preview.report?.artifact?.sha256 !== observation.preview.artifactSha256
        || expectedSha256 !== observation.evidenceSha256) {
        invalidState(`${field}.${adjacency.id} observation is not backed by authenticated Server preview evidence`);
      }
    }
  }
  return bundle;
}

function validateCameraSurveyPreview(preview, requestId, input) {
  const field = `cameraSurveyPreviews.${requestId}`;
  exactKeys(preview, [
    "schemaVersion", "requestId", "nodeId", "cameraViewId", "lensProfileSha256", "frame",
    "status", "request", "report", "authenticatedAt", "failure", "command", "createdAt", "updatedAt",
  ], field);
  if (preview.schemaVersion !== 1 || preview.requestId !== requestId || !input.nodes[preview.nodeId]) {
    invalidState(`${field} identity, schema or node binding is invalid`);
  }
  const request = canonicalNormalized(preview.request, normalizeCameraSurveyPreviewCommand, `${field}.request`);
  if (request.requestId !== requestId || request.nodeId !== preview.nodeId
    || request.cameraViewId !== preview.cameraViewId
    || request.lensProfile.sha256 !== preview.lensProfileSha256
    || !isDeepStrictEqual(request.lensProfile.frame, preview.frame)) {
    invalidState(`${field} outer camera/lens/frame binding differs from its request`);
  }
  validateCommandReference(preview.command, COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW, input.nodes[preview.nodeId],
    input.commandQueues, input.commandDeadLetters, `${field}.command`);
  canonicalIsoTimestamp(preview.createdAt, `${field}.createdAt`);
  canonicalIsoTimestamp(preview.updatedAt, `${field}.updatedAt`);
  if (preview.report == null) {
    if (preview.status !== "queued" || preview.authenticatedAt != null || preview.failure != null) {
      invalidState(`${field} pending preview contains terminal evidence`);
    }
    return;
  }
  const reportValue = canonicalNormalized(
    preview.report,
    (value) => normalizeCameraSurveyPreviewReport(value, request),
    `${field}.report`,
  );
  if (preview.status !== reportValue.status || !["complete", "failed"].includes(preview.status)) {
    invalidState(`${field}.status does not mirror its canonical terminal report`);
  }
  canonicalIsoTimestamp(preview.authenticatedAt, `${field}.authenticatedAt`);
  if (preview.status === "failed") {
    if (!isDeepStrictEqual(preview.failure, reportValue.error)) invalidState(`${field}.failure differs from report`);
  } else if (preview.failure != null) {
    invalidState(`${field} completed preview retains failure evidence`);
  }
}

function validateCameraState(input) {
  for (const [sessionId, raw] of Object.entries(input.cameraCalibrations)) {
    const calibration = record(raw, `cameraCalibrations.${sessionId}`);
    validateCameraCalibrationRecord(calibration, sessionId, input);
  }
  for (const [requestId, raw] of Object.entries(input.cameraSurveyPreviews)) {
    validateCameraSurveyPreview(record(raw, `cameraSurveyPreviews.${requestId}`), requestId, input);
  }
  for (const [bundleId, raw] of Object.entries(input.cameraCalibrationBundles)) {
    validateBundleRecord(record(raw, `cameraCalibrationBundles.${bundleId}`), bundleId, input);
  }
  const ownerClaims = new Map();
  for (const records of Object.values(input.commandDeadLetters || {})) {
    for (const deadLetter of records || []) {
      const owner = deadLetter.compensation?.owner;
      if (owner == null || owner.kind === "host-action") continue;
      const key = `${owner.kind}:${owner.id}`;
      if (ownerClaims.has(key)) invalidState(`Multiple command dead letters claim terminal owner ${key}`);
      ownerClaims.set(key, deadLetter);
      if (owner.kind === "camera-survey-preview") {
        const preview = input.cameraSurveyPreviews[owner.id];
        const deadLetterTerminal = preview?.status === "failed"
          && preview.report?.error?.code === "COMMAND_DEAD_LETTERED";
        const ambiguousSuccess = ["complete", "failed"].includes(preview?.status)
          && preview?.report != null && !deadLetterTerminal;
        if (!preview || (!deadLetterTerminal && !ambiguousSuccess)
          || (deadLetterTerminal && (preview.authenticatedAt !== deadLetter.receivedAt
            || preview.updatedAt !== deadLetter.receivedAt))
          || owner.state !== preview.status || preview.command?.id !== deadLetter.command.id
          || preview.command?.sequence !== deadLetter.command.sequence) {
          invalidState(`Command dead letter ${deadLetter.deadLetterId} has forged survey-preview owner evidence`);
        }
      } else if (owner.kind === "camera-calibration") {
        const calibration = input.cameraCalibrations[owner.id];
        if (!calibration || calibration.state !== CAMERA_CALIBRATION_STATE.FAILED
          || calibration.failure?.code !== "COMMAND_DEAD_LETTERED"
          || calibration.failure?.details?.deadLetterId !== deadLetter.deadLetterId
          || calibration.completedAt !== deadLetter.receivedAt || calibration.updatedAt !== deadLetter.receivedAt
          || owner.state !== calibration.state) {
          invalidState(`Command dead letter ${deadLetter.deadLetterId} has forged calibration owner evidence`);
        }
      } else if (owner.kind === "camera-optical-verification") {
        const calibration = Object.values(input.cameraCalibrations).find((candidate) => (
          candidate.opticalVerification?.verificationId === owner.id
        ));
        const wrapper = calibration?.opticalVerification;
        if (!calibration || wrapper?.reason !== "command-dead-lettered"
          || wrapper.state !== owner.state || wrapper.updatedAt !== deadLetter.receivedAt
          || ![
            CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
            CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
          ].includes(wrapper.state)) {
          invalidState(`Command dead letter ${deadLetter.deadLetterId} has forged optical owner evidence`);
        }
      }
    }
  }
  for (const preview of Object.values(input.cameraSurveyPreviews)) {
    if (preview.report?.error?.code === "COMMAND_DEAD_LETTERED"
      && !ownerClaims.has(`camera-survey-preview:${preview.requestId}`)) {
      invalidState(`cameraSurveyPreviews.${preview.requestId} lacks durable dead-letter owner evidence`);
    }
  }
  for (const calibration of Object.values(input.cameraCalibrations)) {
    if (calibration.failure?.code === "COMMAND_DEAD_LETTERED"
      && !ownerClaims.has(`camera-calibration:${calibration.sessionId}`)) {
      invalidState(`cameraCalibrations.${calibration.sessionId} lacks durable dead-letter owner evidence`);
    }
    if (calibration.opticalVerification?.reason === "command-dead-lettered"
      && !ownerClaims.has(
        `camera-optical-verification:${calibration.opticalVerification.verificationId}`,
      )) {
      invalidState(`cameraCalibrations.${calibration.sessionId} optical block lacks dead-letter owner evidence`);
    }
  }
}

function persistedProjectForNode(project, node, explicit) {
  const capabilities = new Set((node.capabilities?.outputs || []).flatMap((output) => [
    String(output?.id || ""),
    String(output?.connector || ""),
  ]).filter(Boolean));
  const outputs = project.outputs.filter((output) => (
    output.nodeId === node.nodeId
    || (!explicit && !output.nodeId
      && (capabilities.has(output.id) || capabilities.has(output.connector)))
  ));
  const outputIds = new Set(outputs.map((output) => output.id));
  return {
    ...project,
    outputs,
    timeline: {
      ...project.timeline,
      cues: (project.timeline?.cues || []).flatMap((cue) => {
        const targets = cue.outputIds || [];
        if (targets.length === 0) return (!explicit || outputs.length > 0) ? [{ ...cue, outputIds: [] }] : [];
        const scoped = targets.filter((outputId) => outputIds.has(outputId));
        return scoped.length > 0 ? [{ ...cue, outputIds: scoped }] : [];
      }),
    },
  };
}

function commandReferenceEquals(command, reference) {
  return reference?.id === command.id
    && reference?.sequence === command.sequence
    && reference?.type === command.type;
}

function validateCameraCommandAuthority(command, nodeId, input, field) {
  const payload = command.payload;
  if (command.type === COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW) {
    const preview = input.cameraSurveyPreviews[payload.requestId];
    if (!preview || preview.nodeId !== nodeId || !commandReferenceEquals(command, preview.command)
      || !isDeepStrictEqual(payload, preview.request)) {
      invalidState(`${field} is not bound to an authoritative camera survey preview request`);
    }
    return;
  }
  if (command.type === COMMAND.START_CAMERA_CALIBRATION) {
    const calibration = input.cameraCalibrations[payload.plan.sessionId];
    if (!calibration || calibration.nodeId !== nodeId || !commandReferenceEquals(command, calibration.command)
      || calibration.mode !== payload.mode || !isDeepStrictEqual(calibration.plan, payload.plan)
      || (payload.bundle == null) !== (calibration.bundleId == null)
      || (payload.bundle != null && (
        payload.bundle.bundleId !== calibration.bundleId
        || payload.bundle.memberId !== calibration.bundleMemberId
        || payload.bundle.viewCaptureId !== calibration.viewCaptureId
      ))) {
      invalidState(`${field} is not bound to its authoritative camera calibration session`);
    }
    return;
  }
  if (command.type === COMMAND.CONFIRM_CAMERA_CALIBRATION) {
    const calibration = input.cameraCalibrations[payload.sessionId];
    const issued = calibration?.confirmationCommands?.find((entry) => commandReferenceEquals(command, entry));
    if (!calibration || calibration.nodeId !== nodeId || !issued
      || !isDeepStrictEqual(payload, {
        sessionId: calibration.sessionId,
        stepId: issued.stepId,
        confirmationId: issued.confirmationId,
        confirmationLeaseId: issued.confirmationLeaseId,
        confirmedAt: issued.confirmedAt,
      })) {
      invalidState(`${field} is not bound to Server camera confirmation history`);
    }
    return;
  }
  if (command.type === COMMAND.CANCEL_CAMERA_CALIBRATION) {
    const calibration = input.cameraCalibrations[payload.sessionId];
    if (!calibration || calibration.nodeId !== nodeId || calibration.cancelRequestedAt == null) {
      invalidState(`${field} is not bound to a cancelled camera calibration session`);
    }
    return;
  }
  if (command.type === COMMAND.START_CAMERA_OPTICAL_VERIFICATION) {
    const calibration = input.cameraCalibrations[payload.plan.calibrationSessionId];
    const wrapper = calibration?.opticalVerification;
    if (!calibration || calibration.nodeId !== nodeId || !commandReferenceEquals(command, wrapper?.command)
      || !isDeepStrictEqual(payload.plan, wrapper?.plan)) {
      invalidState(`${field} is not bound to an authoritative optical verification attempt`);
    }
    return;
  }
  if (command.type === COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION) {
    const calibration = input.cameraCalibrations[payload.calibrationSessionId];
    const wrapper = calibration?.opticalVerification;
    const issued = wrapper?.confirmationCommands?.find((entry) => commandReferenceEquals(command, entry));
    if (!calibration || calibration.nodeId !== nodeId || !issued
      || payload.verificationId !== wrapper.plan?.verificationId
      || payload.nodeId !== nodeId || payload.projectRevision !== wrapper.plan?.project?.appliedRevision
      || payload.leaseToken !== wrapper.plan?.leaseToken
      || payload.stepId !== issued.stepId || payload.confirmationId !== issued.confirmationId
      || payload.confirmationLeaseId !== issued.confirmationLeaseId || payload.confirmedAt !== issued.confirmedAt) {
      invalidState(`${field} is not bound to Server optical confirmation history`);
    }
    return;
  }
  if (command.type === COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION) {
    const calibration = Object.values(input.cameraCalibrations).find((candidate) => (
      candidate.nodeId === nodeId
      && candidate.opticalVerification?.plan?.verificationId === payload.verificationId
    ));
    const wrapper = calibration?.opticalVerification;
    if (!calibration || !commandReferenceEquals(command, wrapper?.cancelCommand)
      || payload.leaseToken !== wrapper.plan.leaseToken) {
      invalidState(`${field} is not bound to an authoritative optical cancellation`);
    }
    return;
  }
  if (command.type === COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK) {
    const calibration = input.cameraCalibrations[payload.calibrationSessionId];
    const wrapper = calibration?.opticalVerification;
    if (!calibration || calibration.nodeId !== nodeId || !commandReferenceEquals(command, wrapper?.restoreCommand)
      || payload.verificationId !== wrapper.plan?.verificationId
      || payload.leaseToken !== wrapper.plan?.leaseToken
      || payload.projectRevision !== wrapper.runtime?.rollback?.targetRevision) {
      invalidState(`${field} is not bound to an authoritative optical rollback restore`);
    }
  }
}

function validateQueuedCommandAuthority(input) {
  const cameraTypes = new Set([
    COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW,
    COMMAND.START_CAMERA_CALIBRATION,
    COMMAND.CONFIRM_CAMERA_CALIBRATION,
    COMMAND.CANCEL_CAMERA_CALIBRATION,
    COMMAND.START_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION,
    COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK,
  ]);
  const timelineTypes = new Set([
    COMMAND.PREPARE, COMMAND.PLAY_AT, COMMAND.PAUSE_AT, COMMAND.SEEK_AT,
  ]);
  const auditsByCommand = new Map(input.actionAudit
    .filter((audit) => audit.commandId != null)
    .map((audit) => [`${audit.nodeId}:${audit.commandId}:${audit.commandSequence}`, audit]));
  for (const [nodeId, queue] of Object.entries(input.commandQueues)) {
    const node = input.nodes[nodeId];
    for (const [index, command] of queue.entries()) {
      const field = `commandQueues.${nodeId}[${index}]`;
      if (command.type === COMMAND.PREPARE) {
        const assetIds = command.payload.assets.map((asset) => asset.sha256);
        if (new Set(assetIds).size !== assetIds.length
          || assetIds.some((sha256, assetIndex) => {
            const embedded = command.payload.assets[assetIndex];
            const authoritative = input.media[sha256];
            return !SHA256_PATTERN.test(sha256)
              || authoritative?.sha256 !== sha256
              || embedded.size !== authoritative.size;
          })) {
          invalidState(`${field}.payload.assets differs from authoritative media records`);
        }
        const expectedAssets = Array.from(new Set([
          ...(command.payload.assetSha256 ? [command.payload.assetSha256] : []),
          ...command.payload.project.timeline.cues.map((cue) => cue.assetSha256).filter(Boolean),
        ]));
        if (!isDeepStrictEqual(assetIds, expectedAssets)) {
          invalidState(`${field}.payload.assets does not exactly cover its prepared project cues`);
        }
      } else if ([COMMAND.IDENTIFY_OUTPUT, COMMAND.CALIBRATION_PATTERN].includes(command.type)) {
        const output = input.project.outputs.find((candidate) => candidate.id === command.payload.outputId);
        if (!output || (output.nodeId && output.nodeId !== nodeId)) {
          invalidState(`${field} targets an output not owned by its node`);
        }
      } else if (command.type === COMMAND.APPLY_OUTPUT) {
        const proposed = command.payload.output ?? command.payload;
        const output = input.project.outputs.find((candidate) => candidate.id === proposed.id);
        if (!output || !isDeepStrictEqual(output, proposed) || (output.nodeId && output.nodeId !== nodeId)) {
          invalidState(`${field} does not bind an authoritative project output`);
        }
      } else if (command.type === COMMAND.HOST_ACTION) {
        const audit = auditsByCommand.get(`${nodeId}:${command.id}:${command.sequence}`);
        if (!audit || audit.actionId !== command.payload.action.id || audit.type !== command.payload.action.type
          || !isDeepStrictEqual(audit.payload, command.payload.action.payload)) {
          invalidState(`${field} has no exact authoritative host-action audit entry`);
        }
      } else if (cameraTypes.has(command.type)) {
        validateCameraCommandAuthority(command, nodeId, input, field);
      }
      if (command.type === COMMAND.SYNC_PROJECT) {
        const reason = command.payload.reason;
        if (reason === "camera-calibration" && !input.cameraCalibrations[command.payload.sessionId]) {
          invalidState(`${field} references an unknown camera calibration session`);
        }
        if (reason === "camera-calibration-bundle") {
          const bundle = input.cameraCalibrationBundles[command.payload.bundleId];
          if (!bundle || bundle.commit?.commitId !== command.payload.commitId) {
            invalidState(`${field} references unknown bundle commit authority`);
          }
        }
        if (reason === "camera-optical-verification-rollback") {
          const calibration = input.cameraCalibrations[command.payload.sessionId];
          if (calibration?.opticalVerification?.plan?.verificationId !== command.payload.verificationId) {
            invalidState(`${field} references unknown optical rollback authority`);
          }
        }
      }
    }

    const latestSync = queue.findLast((command) => command.type === COMMAND.SYNC_PROJECT);
    if (latestSync) {
      const fallbackProject = persistedProjectForNode(input.project, node, false);
      const explicitProject = persistedProjectForNode(input.project, node, true);
      if (latestSync.payload.revision !== input.project.revision
        || (!isDeepStrictEqual(latestSync.payload.project, fallbackProject)
          && !isDeepStrictEqual(latestSync.payload.project, explicitProject))) {
        invalidState(`commandQueues.${nodeId} latest SYNC_PROJECT is not the exact current scoped project`);
      }
    }

    const queuedTimeline = queue.filter((command) => timelineTypes.has(command.type));
    const latestTimeline = queuedTimeline.at(-1) ?? null;
    // A later authoritative project snapshot invalidates an older PREPARE/play
    // lease. The queue deliberately retains commands separated by an ordering
    // dependency, so only a timeline command newer than the last SYNC can still
    // carry current timeline authority.
    const authoritativeTimeline = latestTimeline != null
      && (latestSync == null || latestTimeline.sequence > latestSync.sequence)
      ? latestTimeline
      : null;
    const targeted = input.timeline.targetNodeIds.includes(nodeId);
    if (input.timeline.status === "idle" && authoritativeTimeline != null) {
      invalidState(`commandQueues.${nodeId} retains timeline authority while the Server timeline is idle`);
    }
    if (!targeted && input.timeline.status !== "idle" && authoritativeTimeline != null) {
      invalidState(`commandQueues.${nodeId} retains timeline authority outside the authoritative target set`);
    }
    if (!targeted || authoritativeTimeline == null) continue;
    const payload = authoritativeTimeline.payload;
    if (input.timeline.status === "prepared") {
      if (authoritativeTimeline.type !== COMMAND.PREPARE
        || authoritativeTimeline.sequence !== input.timeline.prepareSequences[nodeId]
        || payload.assetSha256 !== input.timeline.preparedAssetSha256
        || payload.baseFrame !== input.timeline.baseFrame
        || payload.projectRevision !== input.project.revision
        || (!isDeepStrictEqual(payload.project, persistedProjectForNode(input.project, node, false))
          && !isDeepStrictEqual(payload.project, persistedProjectForNode(input.project, node, true)))) {
        invalidState(`commandQueues.${nodeId} latest timeline command differs from PREPARE authority`);
      }
    } else if (input.timeline.status === "scheduled") {
      const play = authoritativeTimeline.type === COMMAND.PLAY_AT
        && payload.baseFrame === input.timeline.baseFrame
        && payload.projectRevision === input.project.revision
        && payload.frameRateNum === input.timeline.frameRateNum
        && payload.frameRateDen === input.timeline.frameRateDen;
      const seek = authoritativeTimeline.type === COMMAND.SEEK_AT
        && payload.resume === true && payload.frame === input.timeline.baseFrame;
      if ((!play && !seek) || authoritativeTimeline.effectiveAtNs !== input.timeline.playAtNs) {
        invalidState(`commandQueues.${nodeId} latest timeline command differs from scheduled play authority`);
      }
    } else if (input.timeline.status === "pause-scheduled") {
      if (authoritativeTimeline.type !== COMMAND.PAUSE_AT || payload.frame !== input.timeline.pauseFrame
        || authoritativeTimeline.effectiveAtNs !== input.timeline.pauseAtNs) {
        invalidState(`commandQueues.${nodeId} latest timeline command differs from scheduled pause authority`);
      }
    } else if (input.timeline.status === "paused") {
      if (authoritativeTimeline.type !== COMMAND.SEEK_AT || payload.resume !== false
        || payload.frame !== input.timeline.baseFrame || payload.frame !== input.timeline.pauseFrame
        || authoritativeTimeline.effectiveAtNs !== input.timeline.pauseAtNs) {
        invalidState(`commandQueues.${nodeId} latest timeline command differs from paused seek authority`);
      }
    }
  }
}

function initialState() {
  const createdAt = isoNow();
  const project = normalizeProject(defaultProject());
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    createdAt,
    updatedAt: createdAt,
    serverStateRecovery: null,
    project,
    media: {},
    nodes: {},
    commandQueues: {},
    commandDeadLetters: {},
    nextCommandSequence: 1,
    actionAudit: [],
    processedActionResults: {},
    cameraCalibrations: {},
    latestCameraCalibrationId: null,
    cameraCalibrationBundles: {},
    latestCameraCalibrationBundleId: null,
    cameraSurveyPreviews: {},
    latestCameraSurveyPreviewId: null,
    timeline: {
      status: "idle",
      baseFrame: "0",
      playAtNs: null,
      pauseAtNs: null,
      pauseFrame: null,
      frameRateNum: project.canvas.frameRateNum,
      frameRateDen: project.canvas.frameRateDen,
      preparedAssetSha256: null,
      targetNodeIds: [],
      prepareSequences: {},
      updatedAtNs: null,
    },
  };
}

function hydrateState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw stateStoreError("SERVER_STATE_INVALID", "Server state must be a JSON object");
  }
  if (input.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw stateStoreError(
      "SERVER_STATE_SCHEMA_UNSUPPORTED",
      `Server state schema ${String(input.schemaVersion)} is unsupported; expected ${STATE_SCHEMA_VERSION}`,
    );
  }
  if (input.protocolVersion !== PROTOCOL_VERSION) {
    invalidState(`Server state protocol ${String(input.protocolVersion)} is unsupported`);
  }
  isoTimestamp(input.createdAt, "createdAt");
  isoTimestamp(input.updatedAt, "updatedAt");
  let serverStateRecovery = null;
  try {
    serverStateRecovery = normalizeServerStateRecovery(input.serverStateRecovery);
  } catch (error) {
    invalidState(`serverStateRecovery is invalid: ${error.message}`, error);
  }
  const project = normalizePersistedProject(input.project);
  const media = record(input.media, "media");
  const nodes = record(input.nodes, "nodes");
  const commandQueues = record(input.commandQueues, "commandQueues");
  const commandDeadLetters = record(input.commandDeadLetters, "commandDeadLetters", { optional: true });
  const actionAudit = array(input.actionAudit, "actionAudit", { max: 100_000 });
  const processedActionResults = record(input.processedActionResults, "processedActionResults", { optional: true });
  const cameraCalibrations = record(input.cameraCalibrations, "cameraCalibrations", { optional: true });
  const cameraCalibrationBundles = record(
    input.cameraCalibrationBundles,
    "cameraCalibrationBundles",
    { optional: true },
  );
  const cameraSurveyPreviews = record(input.cameraSurveyPreviews, "cameraSurveyPreviews", { optional: true });
  const nextCommandSequence = safeInteger(input.nextCommandSequence, "nextCommandSequence", { min: 1 });
  const timeline = record(input.timeline, "timeline");

  validateMedia(media);
  validateNodes(nodes, nextCommandSequence, input.updatedAt);
  validateCommandQueues(commandQueues, nodes, nextCommandSequence);
  validateCommandDeadLetterState(commandDeadLetters, nodes, commandQueues);
  validateTimeline(timeline, project, nodes, commandQueues, media);
  validateCameraState({
    cameraCalibrations,
    cameraCalibrationBundles,
    cameraSurveyPreviews,
    nodes,
    commandQueues,
    project,
    commandDeadLetters,
  });
  validateActionState(actionAudit, processedActionResults, nodes, commandQueues, commandDeadLetters);
  validateQueuedCommandAuthority({
    project,
    media,
    nodes,
    commandQueues,
    timeline,
    actionAudit,
    cameraCalibrations,
    cameraCalibrationBundles,
    cameraSurveyPreviews,
  });

  const latestCameraCalibrationId = input.latestCameraCalibrationId == null
    ? null
    : boundedString(input.latestCameraCalibrationId, "latestCameraCalibrationId", { max: 128 });
  if (latestCameraCalibrationId && !cameraCalibrations[latestCameraCalibrationId]) {
    invalidState("latestCameraCalibrationId does not reference a stored calibration");
  }
  const latestCameraCalibrationBundleId = input.latestCameraCalibrationBundleId == null
    ? null
    : boundedString(input.latestCameraCalibrationBundleId, "latestCameraCalibrationBundleId", { max: 128 });
  if (latestCameraCalibrationBundleId && !cameraCalibrationBundles[latestCameraCalibrationBundleId]) {
    invalidState("latestCameraCalibrationBundleId does not reference a stored bundle");
  }
  const latestCameraSurveyPreviewId = input.latestCameraSurveyPreviewId == null
    ? null
    : boundedString(input.latestCameraSurveyPreviewId, "latestCameraSurveyPreviewId", { max: 128 });
  if (latestCameraSurveyPreviewId && !cameraSurveyPreviews[latestCameraSurveyPreviewId]) {
    invalidState("latestCameraSurveyPreviewId does not reference a stored preview");
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    serverStateRecovery,
    project,
    media,
    nodes,
    commandQueues,
    commandDeadLetters,
    nextCommandSequence,
    actionAudit,
    processedActionResults,
    cameraCalibrations,
    latestCameraCalibrationId,
    cameraCalibrationBundles,
    latestCameraCalibrationBundleId,
    cameraSurveyPreviews,
    latestCameraSurveyPreviewId,
    timeline,
  };
}

export class PersistentStore {
  #writeChain = Promise.resolve();
  #persistTimer = null;
  #dirty = false;

  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.statePath = path.join(this.dataDir, "state.json");
    this.backupStatePath = path.join(this.dataDir, "state.last-known-good.json");
    this.recoveryStatePath = path.join(this.dataDir, "state.recovery-lock.json");
    this.assetsDir = path.join(this.dataDir, "assets");
    this.uploadsDir = path.join(this.dataDir, "uploads");
    this.state = initialState();
    this.serverStateRecovery = null;
  }

  async init() {
    await mkdir(this.assetsDir, { recursive: true });
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      this.serverStateRecovery = await this.#readRecoveryState();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw stateStoreError(
          "SERVER_STATE_RECOVERY_FAILED",
          `Server recovery lock is invalid and cannot safely be ignored (${error.message})`,
          error,
        );
      }
    }
    if (this.serverStateRecovery != null) {
      this.state.serverStateRecovery = this.serverStateRecovery;
    }
    try {
      this.state = await this.#readState(this.statePath);
      await this.#reconcileRecoveryState();
    } catch (primaryError) {
      if (primaryError?.code === "ENOENT") {
        // A missing primary is also the expected crash window after an invalid
        // file was quarantined but before its LKG replacement was published.
        // Prefer a valid durable backup; defaults are safe only on a genuinely
        // empty first boot where neither authoritative file exists.
        try {
          const recovered = await this.#readState(this.backupStatePath);
          await this.#activateRecoveryState(recovered, "primary-missing-lkg-rollback");
          await this.#persist(recovered, { rotateBackup: false });
          this.state = recovered;
          return this.snapshot();
        } catch (backupError) {
          if (backupError?.code !== "ENOENT") {
            throw stateStoreError(
              "SERVER_STATE_RECOVERY_FAILED",
              `Primary state is missing and the last-known-good backup is invalid (${backupError.message})`,
              backupError,
            );
          }
          await this.#persist(this.state, { rotateBackup: false });
          return this.snapshot();
        }
      }
      let recovered;
      try {
        recovered = await this.#readState(this.backupStatePath);
      } catch (backupError) {
        throw stateStoreError(
          "SERVER_STATE_RECOVERY_FAILED",
          `Server state is invalid and no valid last-known-good backup is available (${primaryError.message}; ${backupError.message})`,
          primaryError,
        );
      }
      const quarantinePath = `${this.statePath}.invalid-${Date.now()}`;
      try {
        await this.#activateRecoveryState(recovered, "primary-invalid-lkg-rollback");
        await rename(this.statePath, quarantinePath);
        await this.#syncDirectory();
        await this.#persist(recovered, { rotateBackup: false });
      } catch (recoveryError) {
        throw stateStoreError(
          "SERVER_STATE_RECOVERY_FAILED",
          `Last-known-good state was valid but could not be restored safely: ${recoveryError.message}`,
          recoveryError,
        );
      }
      this.state = recovered;
    }
    return this.snapshot();
  }

  snapshot() {
    return jsonSafe(this.state);
  }

  recoverySnapshot() {
    return this.serverStateRecovery == null ? null : jsonSafe(this.serverStateRecovery);
  }

  async transaction(mutator, {
    persist = true,
    schedulePersist = !persist,
    persistWhen = null,
    validateBeforePersist = false,
  } = {}) {
    const operation = this.#writeChain.then(async () => {
      // Durable transactions are copy-on-write. Do not publish a mutation to
      // memory until the complete draft has reached the atomic state file;
      // otherwise a disk-full/rename failure would leave RAM ahead of disk and
      // a later request could observe or distribute state that cannot survive
      // restart. Truly volatile heartbeat updates intentionally stay in-place
      // to avoid cloning a dense projector mesh every two seconds.
      const dynamicPersistence = typeof persistWhen === "function";
      const draft = persist || schedulePersist || dynamicPersistence ? jsonSafe(this.state) : this.state;
      const result = await mutator(draft);
      draft.updatedAt = isoNow();
      const shouldPersist = persist || (dynamicPersistence && await persistWhen(draft, result) === true);
      if (shouldPersist) {
        if (validateBeforePersist) hydrateState(jsonSafe(draft));
        await this.#persist(draft);
        this.state = draft;
        this.#dirty = false;
      } else if (schedulePersist) {
        this.state = draft;
        this.#dirty = true;
        this.#schedulePersist();
      } else if (draft !== this.state) {
        // Dynamic transactions still clone up front so a later decision to
        // persist is atomic. Publish genuinely volatile results to RAM only
        // after the serialized mutator has completed.
        this.state = draft;
      }
      return result === undefined ? undefined : jsonSafe(result);
    });
    this.#writeChain = operation.catch(() => undefined);
    return operation;
  }

  async flush() {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    await this.#writeChain;
    if (this.#dirty) {
      await this.#persist();
      this.#dirty = false;
    }
  }

  #schedulePersist() {
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      const operation = this.#writeChain.then(async () => {
        if (!this.#dirty) return;
        await this.#persist();
        this.#dirty = false;
      });
      this.#writeChain = operation.catch(() => undefined);
    }, 500);
    this.#persistTimer.unref?.();
  }

  async #readState(pathname) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(pathname, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      throw stateStoreError("SERVER_STATE_INVALID", `Cannot parse ${path.basename(pathname)}: ${error.message}`, error);
    }
    return hydrateState(parsed);
  }

  async #readRecoveryState() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.recoveryStatePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      throw stateStoreError(
        "SERVER_STATE_RECOVERY_INVALID",
        `Cannot parse ${path.basename(this.recoveryStatePath)}: ${error.message}`,
        error,
      );
    }
    try {
      const normalized = normalizeServerStateRecovery(parsed);
      if (!isDeepStrictEqual(parsed, normalized)) {
        throw new Error("Recovery marker is not in canonical persisted form");
      }
      return normalized;
    } catch (error) {
      throw stateStoreError(
        "SERVER_STATE_RECOVERY_INVALID",
        `Cannot hydrate ${path.basename(this.recoveryStatePath)}: ${error.message}`,
        error,
      );
    }
  }

  async #activateRecoveryState(recovered, reason) {
    const detectedAt = isoNow();
    const generation = Number(this.serverStateRecovery?.generation ?? 0) + 1;
    const recoveredStateSha256 = sha256Json(recovered);
    const recoveryId = `server_state_recovery_${createHash("sha256").update(canonicalJson({
      generation,
      detectedAt,
      reason,
      recoveredStateSha256,
    })).digest("hex").slice(0, 32)}`;
    const marker = normalizeServerStateRecovery({
      schemaVersion: 1,
      status: "active",
      generation,
      recoveryId,
      detectedAt,
      reason,
      recoveredStateUpdatedAt: recovered.updatedAt,
      recoveredStateSha256,
    });
    // The sidecar is published and fsynced before recovered state can replace
    // the primary. A later rollback of both state generations therefore cannot
    // erase the fact that Server authority became ambiguous.
    await this.#persistRecoveryState(marker);
    this.serverStateRecovery = marker;
    recovered.serverStateRecovery = marker;
    return marker;
  }

  async #reconcileRecoveryState() {
    const persisted = this.state.serverStateRecovery ?? null;
    const sidecar = this.serverStateRecovery;
    if (persisted == null && sidecar == null) return;
    if (persisted != null && sidecar == null) {
      await this.#persistRecoveryState(persisted);
      this.serverStateRecovery = persisted;
      return;
    }
    if (persisted == null && sidecar != null) {
      this.state.serverStateRecovery = sidecar;
      await this.#persist(this.state, { rotateBackup: false });
      return;
    }
    if (isDeepStrictEqual(persisted, sidecar)) return;
    if (persisted.generation === sidecar.generation) {
      throw stateStoreError(
        "SERVER_STATE_RECOVERY_FAILED",
        "Primary state and recovery sidecar changed the same recovery generation",
      );
    }
    const authoritative = persisted.generation > sidecar.generation ? persisted : sidecar;
    if (authoritative === persisted) {
      await this.#persistRecoveryState(persisted);
      this.serverStateRecovery = persisted;
    } else {
      this.state.serverStateRecovery = sidecar;
      await this.#persist(this.state, { rotateBackup: false });
    }
  }

  async #persistRecoveryState(marker) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temporary = `${this.recoveryStatePath}.${suffix}.tmp`;
    const document = `${JSON.stringify(marker, null, 2)}\n`;
    try {
      await this.#writeAndSync(temporary, document);
      await rename(temporary, this.recoveryStatePath);
      await this.#syncDirectory();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #writeAndSync(pathname, document) {
    let handle;
    try {
      handle = await open(pathname, "wx", 0o600);
      await handle.writeFile(document, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #syncFile(pathname) {
    // Windows FlushFileBuffers requires a writable handle; r+ never truncates.
    const handle = await open(pathname, process.platform === "win32" ? "r+" : "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncDirectory() {
    let handle;
    try {
      handle = await open(this.dataDir, "r");
      await handle.sync();
    } catch (error) {
      // Windows does not expose directory handles through node:fs in every
      // supported runtime. File contents are still flushed explicitly; only
      // documented directory-handle limitations are tolerated here.
      if (!new Set(["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"]).has(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #persist(state = this.state, { rotateBackup = true } = {}) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temporary = `${this.statePath}.${suffix}.tmp`;
    const backupTemporary = `${this.backupStatePath}.${suffix}.tmp`;
    // State is kept JSON-safe at every protocol boundary. Stringify it once;
    // cloning the complete dense projector project before every atomic write
    // doubles CPU and memory pressure for no durability benefit.
    const document = `${JSON.stringify(state, (_key, item) => (
      typeof item === "bigint" ? item.toString() : item
    ), 2)}\n`;
    try {
      await this.#writeAndSync(temporary, document);
      if (rotateBackup) {
        try {
          await copyFile(this.statePath, backupTemporary);
          await this.#syncFile(backupTemporary);
          await rename(backupTemporary, this.backupStatePath);
          await this.#syncDirectory();
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await rm(backupTemporary, { force: true }).catch(() => {});
        }
      }
      await rename(temporary, this.statePath);
      await this.#syncDirectory();
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(backupTemporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
