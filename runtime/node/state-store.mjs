import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND,
  HOST_ACTION_TYPE,
  PROTOCOL_VERSION,
  jsonSafe,
  normalizeProject,
} from "../shared/protocol.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_STATE,
  normalizeCameraOpticalVerificationPlan,
  normalizeCameraOpticalVerificationState,
} from "../shared/camera-verification.mjs";

const SCHEMA_VERSION = 1;
export const MAX_PENDING_HOST_ACTION_RESULTS = 128;
const TERMINAL_CAMERA_CALIBRATION_STATES = new Set(["complete", "failed", "cancelled"]);

function defaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    lastSequence: 0,
    project: null,
    transport: null,
    preparedAssetSha256: null,
    preparedAssets: [],
    pendingActions: [],
    actionResults: [],
    hostActionJournal: [],
    commandFailures: {},
    pendingCommandDeadLetters: [],
    commandDeadLetterReceipts: [],
    commandFailureSafetyLock: null,
    stateRecoverySafetyLock: null,
    serverFailClosedFence: null,
    cameraCalibration: null,
    cameraCalibrationAcknowledgementReceipt: null,
    cameraOpticalVerification: null,
    cameraOpticalVerificationPlan: null,
    cameraOpticalVerificationConfirmationReceipt: null,
    cameraOpticalVerificationRestoreReceipt: null,
    cameraOpticalVerificationReportAcknowledged: false,
    cameraOpticalVerificationFailClosed: false,
    updatedAt: null,
  };
}

function invalidState(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "NODE_STATE_INVALID";
  throw error;
}

function invalidGeneration(message) {
  const error = new Error(message);
  error.code = "NODE_STATE_GENERATION_INVALID";
  throw error;
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

function array(value, field, { optional = false, max = 1_024 } = {}) {
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

function integerString(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    invalidState(`${field} must be ${nullable ? "null or " : ""}a canonical non-negative integer string`);
  }
  try {
    BigInt(value);
  } catch (error) {
    invalidState(`${field} is outside the supported integer range`, error);
  }
  return value;
}

function normalizePersistedProject(value) {
  if (value == null) return null;
  const persisted = record(value, "project");
  if (typeof persisted.updatedAt !== "string" || !Number.isFinite(Date.parse(persisted.updatedAt))) {
    invalidState("project.updatedAt must be an ISO timestamp");
  }
  let normalized;
  try {
    normalized = normalizeProject(persisted);
  } catch (error) {
    invalidState(`Persisted project is invalid: ${error.message}`, error);
  }
  const canonical = { ...normalized, updatedAt: persisted.updatedAt };
  if (!isDeepStrictEqual(canonical, persisted)) {
    invalidState("Persisted project is not in canonical form");
  }
  return canonical;
}

function normalizePersistedTransport(value) {
  if (value == null) return null;
  const persisted = record(value, "transport");
  const expectedKeys = ["baseFrame", "frameRateDen", "frameRateNum", "pausedFrame", "startNs", "state"];
  if (!isDeepStrictEqual(Object.keys(persisted).sort(), expectedKeys)) {
    invalidState("transport contains missing or unsupported fields");
  }
  const state = boundedString(persisted.state, "transport.state", { max: 32 });
  if (!["idle", "ready", "scheduled", "playing", "paused"].includes(state)) {
    invalidState("transport.state is invalid");
  }
  const startNs = integerString(persisted.startNs, "transport.startNs", { nullable: true });
  const baseFrame = integerString(persisted.baseFrame, "transport.baseFrame");
  const pausedFrame = integerString(persisted.pausedFrame, "transport.pausedFrame");
  const frameRateNum = safeInteger(persisted.frameRateNum, "transport.frameRateNum", { min: 1 });
  const frameRateDen = safeInteger(persisted.frameRateDen, "transport.frameRateDen", { min: 1 });
  if (["scheduled", "playing"].includes(state) && startNs == null) {
    invalidState(`transport.startNs is required while transport.state is ${state}`);
  }
  return { state, startNs, baseFrame, pausedFrame, frameRateNum, frameRateDen };
}

function normalizePendingActions(value, lastSequence) {
  const actions = array(value, "pendingActions", { optional: true, max: 1_024 });
  const ids = new Set();
  const sequences = new Set();
  return actions.map((raw, index) => {
    const field = `pendingActions[${index}]`;
    const action = record(raw, field);
    const expectedKeys = ["createdAtNs", "effectiveAtNs", "id", "payload", "protocolVersion", "sequence", "type"];
    if (!isDeepStrictEqual(Object.keys(action).sort(), expectedKeys)) {
      invalidState(`${field} contains missing or unsupported command fields`);
    }
    if (action.protocolVersion !== PROTOCOL_VERSION) invalidState(`${field}.protocolVersion is invalid`);
    const id = boundedString(action.id, `${field}.id`, { max: 256 });
    const sequence = safeInteger(action.sequence, `${field}.sequence`);
    const type = boundedString(action.type, `${field}.type`, { max: 64 });
    if (![COMMAND.PAUSE_AT, COMMAND.SEEK_AT].includes(type)) {
      invalidState(`${field}.type is not a resumable scheduled transport action`);
    }
    const syntheticPause = sequence === 0 && id === "server-reconcile-pause" && type === COMMAND.PAUSE_AT;
    if ((!syntheticPause && sequence < 1) || sequence > lastSequence) {
      invalidState(`${field}.sequence is not bound to the durable command cursor`);
    }
    if (ids.has(id) || (sequence > 0 && sequences.has(sequence))) {
      invalidState(`${field} duplicates a retained scheduled action identity`);
    }
    ids.add(id);
    if (sequence > 0) sequences.add(sequence);
    const createdAtNs = integerString(action.createdAtNs, `${field}.createdAtNs`, { nullable: true });
    const effectiveAtNs = integerString(action.effectiveAtNs, `${field}.effectiveAtNs`);
    const payload = record(action.payload, `${field}.payload`);
    const expectedPayloadKeys = type === COMMAND.PAUSE_AT ? ["frame"] : ["frame", "resume"];
    if (!isDeepStrictEqual(Object.keys(payload).sort(), expectedPayloadKeys)) {
      invalidState(`${field}.payload contains missing or unsupported fields`);
    }
    const frame = integerString(payload.frame, `${field}.payload.frame`);
    if (type === COMMAND.SEEK_AT && typeof payload.resume !== "boolean") {
      invalidState(`${field}.payload.resume must be boolean`);
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      id,
      sequence,
      type,
      createdAtNs,
      effectiveAtNs,
      payload: type === COMMAND.PAUSE_AT ? { frame } : { frame, resume: payload.resume },
    };
  });
}

function isoTimestamp(value, field) {
  boundedString(value, field, { max: 64 });
  if (!Number.isFinite(Date.parse(value))) invalidState(`${field} must be an ISO timestamp`);
  return value;
}

function canonicalIsoTimestamp(value, field) {
  isoTimestamp(value, field);
  if (new Date(value).toISOString() !== value) {
    invalidState(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    invalidState(`${field} must be ${nullable ? "null or " : ""}a lowercase SHA-256 digest`);
  }
  return value;
}

/**
 * Return the exact regular camera-calibration object placed in heartbeat
 * telemetry. Plans and bundle routing are Node-local execution metadata and
 * have never been part of the Server terminal-report contract.
 */
export function canonicalCameraCalibrationReport(calibrationInput) {
  const calibration = jsonSafe(record(calibrationInput, "cameraCalibration"));
  const report = { ...calibration };
  delete report.plan;
  delete report.bundle;
  return report;
}

/**
 * Build the compact post-ACK state and its inseparable receipt. Callers must
 * durably commit both values in one Node-state rename before changing RAM.
 */
export function createCameraCalibrationAcknowledgement({
  calibration: calibrationInput,
  publishedReport: publishedReportInput,
  acknowledgedAt: acknowledgedAtInput,
}) {
  const calibration = jsonSafe(record(calibrationInput, "cameraCalibration"));
  const sessionId = boundedString(calibration.sessionId, "cameraCalibration.sessionId", { max: 256 });
  if (!TERMINAL_CAMERA_CALIBRATION_STATES.has(calibration.state)) {
    invalidState("Only a terminal camera calibration can be acknowledged");
  }
  const publishedReport = jsonSafe(record(publishedReportInput, "published cameraCalibration report"));
  const expectedReport = canonicalCameraCalibrationReport(calibration);
  if (!isDeepStrictEqual(publishedReport, expectedReport)) {
    invalidState("Camera-calibration acknowledgement does not match the exact published terminal report");
  }
  if (publishedReport.sessionId !== sessionId
    || !TERMINAL_CAMERA_CALIBRATION_STATES.has(publishedReport.state)) {
    invalidState("Published camera-calibration terminal identity is invalid");
  }
  const acknowledgedAt = isoTimestamp(acknowledgedAtInput, "cameraCalibrationAcknowledgementReceipt.acknowledgedAt");
  const projectPatchAcknowledged = publishedReport.projectPatch != null;
  const projectPatchSha256 = projectPatchAcknowledged
    ? sha256Json(publishedReport.projectPatch)
    : null;
  const calibrationAfterAcknowledgement = jsonSafe({
    ...calibration,
    projectPatch: null,
  });
  const receipt = {
    schemaVersion: 1,
    sessionId,
    terminalReportSha256: sha256Json(publishedReport),
    retainedCalibrationSha256: sha256Json(calibrationAfterAcknowledgement),
    projectPatchAcknowledged,
    projectPatchSha256,
    acknowledgedAt,
  };
  return { calibration: calibrationAfterAcknowledgement, receipt };
}

function expectedHostActionResultId(commandId, sequence, actionId) {
  const digest = createHash("sha256")
    .update(`${commandId}:${sequence}:${actionId || ""}`)
    .digest("hex")
    .slice(0, 24);
  return `host-result-${digest}`;
}

function normalizeHostActionResult(value, field, { lastSequence }) {
  const result = record(value, field);
  const success = ["dry-run", "succeeded"].includes(result.status);
  const failure = ["failed", "denied"].includes(result.status);
  if (!success && !failure) invalidState(`${field}.status is not terminal`);
  const expectedKeys = [
    "actionId", "actionType", "commandId", "completedAt", "resultId", "sequence", "startedAt", "status",
    success ? "result" : "error",
  ].sort();
  if (!isDeepStrictEqual(Object.keys(result).sort(), expectedKeys)) {
    invalidState(`${field} contains missing or unsupported result fields`);
  }
  const commandId = boundedString(result.commandId, `${field}.commandId`, { max: 256 });
  const sequence = safeInteger(result.sequence, `${field}.sequence`, { min: 1 });
  if (sequence > lastSequence + 1) invalidState(`${field}.sequence is ahead of the durable command boundary`);
  const actionId = boundedString(result.actionId, `${field}.actionId`, { max: 256 });
  const actionType = boundedString(result.actionType, `${field}.actionType`, { max: 128 });
  if (!Object.values(HOST_ACTION_TYPE).includes(actionType)) invalidState(`${field}.actionType is not allowlisted`);
  const resultId = boundedString(result.resultId, `${field}.resultId`, { max: 256 });
  if (resultId !== expectedHostActionResultId(commandId, sequence, actionId)) {
    invalidState(`${field}.resultId is not bound to its command identity`);
  }
  const startedAt = isoTimestamp(result.startedAt, `${field}.startedAt`);
  const completedAt = isoTimestamp(result.completedAt, `${field}.completedAt`);
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    invalidState(`${field}.completedAt precedes startedAt`);
  }
  if (success) record(result.result, `${field}.result`);
  if (failure) {
    const error = record(result.error, `${field}.error`);
    if (!isDeepStrictEqual(Object.keys(error).sort(), ["code", "details", "message"])) {
      invalidState(`${field}.error contains missing or unsupported fields`);
    }
    boundedString(error.code, `${field}.error.code`, { max: 128 });
    boundedString(error.message, `${field}.error.message`, { max: 4_096 });
    if (error.details != null && (typeof error.details !== "object" || Array.isArray(error.details))) {
      invalidState(`${field}.error.details must be null or an object`);
    }
  }
  return {
    resultId,
    commandId,
    sequence,
    actionId,
    actionType,
    status: result.status,
    startedAt,
    completedAt,
    ...(success ? { result: result.result } : { error: result.error }),
  };
}

function normalizeHostActionState(actionResultsInput, journalInput, lastSequence) {
  const journal = array(journalInput, "hostActionJournal", { optional: true, max: 256 });
  const commandIds = new Set();
  const sequences = new Set();
  let inFlightSequence = null;
  const normalizedJournal = journal.map((value, index) => {
    const field = `hostActionJournal[${index}]`;
    const entry = record(value, field);
    const status = boundedString(entry.status, `${field}.status`, { max: 32 });
    if (!["started", "completed"].includes(status)) invalidState(`${field}.status is invalid`);
    const expectedKeys = status === "started"
      ? ["actionId", "actionType", "commandId", "resultId", "sequence", "startedAt", "status"]
      : [
        "actionId", "actionType", "commandId", "completedAt", "result", "resultId", "sequence", "startedAt", "status",
      ];
    if (!isDeepStrictEqual(Object.keys(entry).sort(), expectedKeys.sort())) {
      invalidState(`${field} contains missing or unsupported journal fields`);
    }
    const commandId = boundedString(entry.commandId, `${field}.commandId`, { max: 256 });
    const sequence = safeInteger(entry.sequence, `${field}.sequence`, { min: 1 });
    if (sequence > lastSequence + 1) invalidState(`${field}.sequence is ahead of the durable command boundary`);
    if (sequence === lastSequence + 1) {
      if (inFlightSequence != null && inFlightSequence !== sequence) {
        invalidState("hostActionJournal retains more than one in-flight command");
      }
      inFlightSequence = sequence;
    }
    if (commandIds.has(commandId) || sequences.has(sequence)) invalidState(`${field} duplicates a command identity`);
    commandIds.add(commandId);
    sequences.add(sequence);
    const actionId = boundedString(entry.actionId, `${field}.actionId`, { max: 256 });
    const actionType = boundedString(entry.actionType, `${field}.actionType`, { max: 128 });
    if (!Object.values(HOST_ACTION_TYPE).includes(actionType)) invalidState(`${field}.actionType is not allowlisted`);
    const resultId = boundedString(entry.resultId, `${field}.resultId`, { max: 256 });
    if (resultId !== expectedHostActionResultId(commandId, sequence, actionId)) {
      invalidState(`${field}.resultId is not bound to its command identity`);
    }
    const startedAt = isoTimestamp(entry.startedAt, `${field}.startedAt`);
    if (status === "started") {
      return { commandId, sequence, actionId, actionType, resultId, status, startedAt };
    }
    const completedAt = isoTimestamp(entry.completedAt, `${field}.completedAt`);
    const result = normalizeHostActionResult(entry.result, `${field}.result`, { lastSequence });
    if (Date.parse(completedAt) < Date.parse(startedAt)
      || Date.parse(result.startedAt) < Date.parse(startedAt)
      || completedAt !== result.completedAt
      || commandId !== result.commandId
      || sequence !== result.sequence
      || actionId !== result.actionId
      || actionType !== result.actionType
      || resultId !== result.resultId) {
      invalidState(`${field}.result does not exactly match its journal identity and timestamps`);
    }
    return { commandId, sequence, actionId, actionType, resultId, status, startedAt, completedAt, result };
  });

  const byResultId = new Map(normalizedJournal
    .filter((entry) => entry.status === "completed")
    .map((entry) => [entry.resultId, entry]));
  const resultIds = new Set();
  const actionResults = array(actionResultsInput, "actionResults", {
    optional: true,
    max: MAX_PENDING_HOST_ACTION_RESULTS,
  })
    .map((value, index) => {
      const result = normalizeHostActionResult(value, `actionResults[${index}]`, { lastSequence });
      if (resultIds.has(result.resultId)) invalidState(`actionResults[${index}].resultId is duplicated`);
      resultIds.add(result.resultId);
      const retained = byResultId.get(result.resultId);
      if (!retained || !isDeepStrictEqual(retained.result, result)) {
        invalidState(`actionResults[${index}] is not bound to an exact completed host-action journal entry`);
      }
      return result;
    });
  return { actionResults, hostActionJournal: normalizedJournal };
}

function validateHostActionGeneration(primary, backup) {
  const current = new Map((primary.hostActionJournal || []).map((entry) => [entry.commandId, entry]));
  for (const retained of backup.hostActionJournal || []) {
    if (retained.status !== "started") continue;
    const candidate = current.get(retained.commandId);
    if (!candidate
      || candidate.sequence !== retained.sequence
      || candidate.actionId !== retained.actionId
      || candidate.actionType !== retained.actionType
      || candidate.resultId !== retained.resultId
      || !["started", "completed"].includes(candidate.status)) {
      invalidState(
        `Primary Node state removed or changed in-flight host action ${retained.commandId} from its LKG generation`,
      );
    }
  }
}

function commandIdentity(value, field) {
  const command = record(value, field);
  boundedString(command.id, `${field}.id`, { max: 256 });
  const sequence = safeInteger(command.sequence, `${field}.sequence`, { min: 1 });
  boundedString(command.type, `${field}.type`, { max: 128 });
  return { id: command.id, sequence, type: command.type };
}

function sameCommand(left, right) {
  return left.id === right.id && left.sequence === right.sequence && left.type === right.type;
}

export function normalizeServerFailClosedFence(value) {
  if (value == null) return null;
  const fence = record(value, "serverFailClosedFence");
  const expectedKeys = [
    "activatedAt", "deadLetterId", "effectiveAtNs", "generation", "sourceCommand", "status",
  ];
  if (!isDeepStrictEqual(Object.keys(fence).sort(), expectedKeys)) {
    invalidState("serverFailClosedFence contains missing or unsupported fields");
  }
  if (fence.status !== "active") invalidState("serverFailClosedFence.status must be active");
  const generation = safeInteger(fence.generation, "serverFailClosedFence.generation", { min: 1 });
  const deadLetterId = boundedString(fence.deadLetterId, "serverFailClosedFence.deadLetterId", { max: 96 });
  if (!/^command_dead_letter_[a-f0-9]{32}$/.test(deadLetterId)) {
    invalidState("serverFailClosedFence.deadLetterId is not canonical");
  }
  const activatedAt = canonicalIsoTimestamp(fence.activatedAt, "serverFailClosedFence.activatedAt");
  const effectiveAtNs = integerString(fence.effectiveAtNs, "serverFailClosedFence.effectiveAtNs");
  const activatedAtNs = BigInt(Date.parse(activatedAt)) * 1_000_000n;
  if (BigInt(effectiveAtNs) < activatedAtNs
    || BigInt(effectiveAtNs) > activatedAtNs + 6_000_000_000n) {
    invalidState("serverFailClosedFence.effectiveAtNs is outside its bounded lease drain window");
  }
  const source = record(fence.sourceCommand, "serverFailClosedFence.sourceCommand");
  if (!isDeepStrictEqual(Object.keys(source).sort(), ["id", "nodeId", "sequence", "type"])) {
    invalidState("serverFailClosedFence.sourceCommand contains missing or unsupported fields");
  }
  const nodeId = boundedString(source.nodeId, "serverFailClosedFence.sourceCommand.nodeId", { max: 128 });
  const id = boundedString(source.id, "serverFailClosedFence.sourceCommand.id", { max: 256 });
  const sequence = safeInteger(source.sequence, "serverFailClosedFence.sourceCommand.sequence", { min: 1 });
  const type = boundedString(source.type, "serverFailClosedFence.sourceCommand.type", { max: 128 });
  if (!Object.values(COMMAND).includes(type)) {
    invalidState("serverFailClosedFence.sourceCommand.type is invalid");
  }
  return {
    status: "active",
    generation,
    deadLetterId,
    activatedAt,
    effectiveAtNs,
    sourceCommand: { nodeId, id, sequence, type },
  };
}

function normalizeCommandDeadLetterReceipts(value, state, normalizedFailures) {
  const receipts = array(value, "commandDeadLetterReceipts", { optional: true, max: 32 });
  const ids = new Set();
  const sequences = new Set();
  let priorSequence = 0;
  return receipts.map((raw, index) => {
    const field = `commandDeadLetterReceipts[${index}]`;
    const receipt = record(raw, field);
    const expectedKeys = ["command", "deadLetterId", "schemaVersion", "serverReceivedAt", "status"];
    if (!isDeepStrictEqual(Object.keys(receipt).sort(), expectedKeys)) {
      invalidState(`${field} contains missing or unsupported fields`);
    }
    if (receipt.schemaVersion !== 1
      || receipt.status !== "server-accepted-awaiting-cursor-ack") {
      invalidState(`${field} has an unsupported schema or status`);
    }
    const deadLetterId = boundedString(receipt.deadLetterId, `${field}.deadLetterId`, { max: 256 });
    if (!/^command_dead_letter_[a-f0-9]{32}$/.test(deadLetterId)
      || ids.has(deadLetterId)) {
      invalidState(`${field}.deadLetterId is invalid or duplicated`);
    }
    const command = commandIdentity(receipt.command, `${field}.command`);
    if (sequences.has(command.sequence) || command.sequence <= priorSequence
      || command.sequence > state.lastSequence) {
      invalidState(`${field}.command.sequence is duplicated, reordered or ahead of lastSequence`);
    }
    const serverReceivedAt = canonicalIsoTimestamp(
      receipt.serverReceivedAt,
      `${field}.serverReceivedAt`,
    );
    const retained = normalizedFailures.get(command.sequence);
    if (!retained || !sameCommand(retained.command, command)
      || retained.failure.status !== "dead-lettered"
      || retained.failure.deadLetterId !== deadLetterId
      || retained.failure.serverAcknowledgedAt !== serverReceivedAt) {
      invalidState(`${field} is not bound to exact durable command-failure evidence`);
    }
    if (state.pendingCommandDeadLetters.some((item) => item.deadLetterId === deadLetterId)) {
      invalidState(`${field} cannot coexist with pending publication evidence`);
    }
    ids.add(deadLetterId);
    sequences.add(command.sequence);
    priorSequence = command.sequence;
    return {
      schemaVersion: 1,
      status: "server-accepted-awaiting-cursor-ack",
      deadLetterId,
      command,
      serverReceivedAt,
    };
  });
}

function validateCriticalCommandState(state) {
  const failures = state.commandFailures;
  const normalizedFailures = new Map();
  let retainedSafetyCriticalEvidence = false;
  if (Object.keys(failures).length > 128) invalidState("commandFailures exceeds 128 retained records");
  for (const [key, raw] of Object.entries(failures)) {
    const match = /^sequence:(\d+)$/.exec(key);
    if (!match) invalidState(`commandFailures contains invalid key ${key}`);
    const failure = record(raw, `commandFailures.${key}`);
    const command = commandIdentity(failure.command, `commandFailures.${key}.command`);
    if (command.sequence !== Number(match[1])) invalidState(`commandFailures.${key} identity does not match its key`);
    boundedString(failure.status, `commandFailures.${key}.status`, { max: 64 });
    if (!["retrying", "pending-server", "dead-lettered", "succeeded-after-retry"].includes(failure.status)) {
      invalidState(`commandFailures.${key}.status is invalid`);
    }
    if (typeof failure.safetyCritical !== "boolean") {
      invalidState(`commandFailures.${key}.safetyCritical must be boolean`);
    }
    retainedSafetyCriticalEvidence ||= failure.safetyCritical;
    if (failure.deadLetterId != null) boundedString(failure.deadLetterId, `commandFailures.${key}.deadLetterId`, { max: 256 });
    normalizedFailures.set(command.sequence, { failure, command });
  }

  const deadLetterIds = new Set();
  const deadLetterSequences = new Set();
  for (const [index, raw] of state.pendingCommandDeadLetters.entries()) {
    const field = `pendingCommandDeadLetters[${index}]`;
    const deadLetter = record(raw, field);
    if (deadLetter.schemaVersion !== 1) invalidState(`${field}.schemaVersion must be 1`);
    const deadLetterId = boundedString(deadLetter.deadLetterId, `${field}.deadLetterId`, { max: 256 });
    if (deadLetterIds.has(deadLetterId)) invalidState(`${field}.deadLetterId is duplicated`);
    deadLetterIds.add(deadLetterId);
    boundedString(deadLetter.nodeId, `${field}.nodeId`, { max: 128 });
    const command = commandIdentity(deadLetter.command, `${field}.command`);
    if (command.sequence <= state.lastSequence) {
      invalidState(`${field}.command.sequence must remain ahead of lastSequence until Server acknowledgement`);
    }
    if (deadLetterSequences.has(command.sequence)) invalidState(`${field}.command.sequence is duplicated`);
    deadLetterSequences.add(command.sequence);
    safeInteger(deadLetter.attempts, `${field}.attempts`, { min: 1 });
    safeInteger(deadLetter.retryBudget, `${field}.retryBudget`, { min: 1 });
    if (typeof deadLetter.safetyCritical !== "boolean") invalidState(`${field}.safetyCritical must be boolean`);
    retainedSafetyCriticalEvidence ||= deadLetter.safetyCritical;
    if (deadLetter.attempts < deadLetter.retryBudget) invalidState(`${field} has not exhausted its retry budget`);
    const retained = normalizedFailures.get(command.sequence);
    if (!retained || !sameCommand(retained.command, command)
      || retained.failure.status !== "pending-server"
      || retained.failure.deadLetterId !== deadLetterId) {
      invalidState(`${field} is not bound to the matching pending command-failure record`);
    }
  }

  for (const [sequence, { failure }] of normalizedFailures) {
    if (failure.status !== "pending-server") continue;
    if (!state.pendingCommandDeadLetters.some((item) => (
      item.command?.sequence === sequence && item.deadLetterId === failure.deadLetterId
    ))) {
      invalidState(`commandFailures.sequence:${sequence} is pending-server without retained publication evidence`);
    }
  }

  state.commandDeadLetterReceipts = normalizeCommandDeadLetterReceipts(
    state.commandDeadLetterReceipts,
    state,
    normalizedFailures,
  );

  const lock = state.commandFailureSafetyLock;
  if (lock == null) {
    if (retainedSafetyCriticalEvidence) {
      invalidState("Retained safety-critical command evidence requires an active commandFailureSafetyLock");
    }
    return;
  }
  if (lock.schemaVersion !== 1 || lock.status !== "active") {
    invalidState("commandFailureSafetyLock must be an active schema-1 lock");
  }
  const command = commandIdentity(lock.command, "commandFailureSafetyLock.command");
  const retained = normalizedFailures.get(command.sequence);
  if (!retained || !sameCommand(retained.command, command)) {
    invalidState("commandFailureSafetyLock is not bound to a retained command-failure record");
  }
  if (retained.failure.safetyCritical !== true) {
    invalidState("commandFailureSafetyLock must bind a safety-critical command-failure record");
  }
  if (lock.deadLetterId != null) {
    boundedString(lock.deadLetterId, "commandFailureSafetyLock.deadLetterId", { max: 256 });
    if (retained.failure.deadLetterId !== lock.deadLetterId) {
      invalidState("commandFailureSafetyLock.deadLetterId does not match its command-failure record");
    }
  }
  safeInteger(lock.attempts, "commandFailureSafetyLock.attempts", { min: 1 });
  if (typeof lock.blackApplied !== "boolean") invalidState("commandFailureSafetyLock.blackApplied must be boolean");
}

function validateServerFailClosedFenceGeneration(primary, backup) {
  const current = primary.serverFailClosedFence;
  const previous = backup.serverFailClosedFence;
  if (previous == null) return;
  if (current == null || current.generation < previous.generation) {
    invalidGeneration("Primary Node state removed or rolled back its Server fail-closed fence");
  }
  if (current.generation === previous.generation && !isDeepStrictEqual(current, previous)) {
    invalidGeneration("Primary Node state changed evidence for an existing Server fail-closed fence generation");
  }
}

function normalizeRecoverySafetyLock(value) {
  if (value == null) return null;
  const lock = record(value, "stateRecoverySafetyLock");
  if (lock.schemaVersion !== 1 || lock.status !== "active") {
    invalidState("stateRecoverySafetyLock must be an active schema-1 lock");
  }
  boundedString(lock.activatedAt, "stateRecoverySafetyLock.activatedAt", { max: 64 });
  if (!Number.isFinite(Date.parse(lock.activatedAt))) {
    invalidState("stateRecoverySafetyLock.activatedAt must be an ISO timestamp");
  }
  const reason = record(lock.reason, "stateRecoverySafetyLock.reason");
  boundedString(reason.code, "stateRecoverySafetyLock.reason.code", { max: 128 });
  boundedString(reason.message, "stateRecoverySafetyLock.reason.message", { max: 2_048 });
  if (typeof lock.blackApplied !== "boolean") invalidState("stateRecoverySafetyLock.blackApplied must be boolean");
  if (lock.lastEnforcedAt != null
    && (typeof lock.lastEnforcedAt !== "string" || !Number.isFinite(Date.parse(lock.lastEnforcedAt)))) {
    invalidState("stateRecoverySafetyLock.lastEnforcedAt must be null or an ISO timestamp");
  }
  if (lock.enforcementError != null) record(lock.enforcementError, "stateRecoverySafetyLock.enforcementError");
  return lock;
}

function withRecoverySafetyLock(state, primaryError) {
  const activatedAt = new Date().toISOString();
  return hydrate({
    ...state,
    stateRecoverySafetyLock: state.stateRecoverySafetyLock || {
      schemaVersion: 1,
      status: "active",
      activatedAt,
      reason: {
        code: "NODE_STATE_LKG_RECOVERY",
        message: `Authoritative Node state required last-known-good recovery: ${primaryError.message}`.slice(0, 2_048),
      },
      blackApplied: false,
      lastEnforcedAt: null,
      enforcementError: null,
    },
    updatedAt: activatedAt,
  });
}

function normalizeCameraCalibrationAcknowledgementState(calibrationInput, receiptInput) {
  const calibration = calibrationInput == null
    ? null
    : jsonSafe(record(calibrationInput, "cameraCalibration"));
  if (receiptInput == null) {
    if (calibration?.schemaVersion === 1
      && calibration.mode === "measured"
      && calibration.state === "complete"
      && calibration.manifest?.provenance === "measured"
      && calibration.manifest?.applicable === true
      && calibration.projectPatch == null) {
      invalidState(
        "Applicable measured COMPLETE cameraCalibration lost projectPatch without a durable acknowledgement receipt",
      );
    }
    return { calibration, receipt: null };
  }
  if (calibration == null) {
    invalidState("cameraCalibrationAcknowledgementReceipt requires a retained cameraCalibration");
  }
  const receipt = record(receiptInput, "cameraCalibrationAcknowledgementReceipt");
  const expectedKeys = [
    "acknowledgedAt",
    "projectPatchAcknowledged",
    "projectPatchSha256",
    "retainedCalibrationSha256",
    "schemaVersion",
    "sessionId",
    "terminalReportSha256",
  ].sort();
  if (!isDeepStrictEqual(Object.keys(receipt).sort(), expectedKeys)) {
    invalidState("cameraCalibrationAcknowledgementReceipt contains missing or unsupported fields");
  }
  if (receipt.schemaVersion !== 1) {
    invalidState("cameraCalibrationAcknowledgementReceipt.schemaVersion must be 1");
  }
  const sessionId = boundedString(
    receipt.sessionId,
    "cameraCalibrationAcknowledgementReceipt.sessionId",
    { max: 256 },
  );
  if (sessionId !== calibration.sessionId) {
    invalidState("cameraCalibrationAcknowledgementReceipt.sessionId does not match cameraCalibration");
  }
  if (!TERMINAL_CAMERA_CALIBRATION_STATES.has(calibration.state)) {
    invalidState("cameraCalibrationAcknowledgementReceipt requires a terminal cameraCalibration");
  }
  if (calibration.projectPatch !== null) {
    invalidState("An acknowledged cameraCalibration must compact projectPatch to null atomically with its receipt");
  }
  const terminalReportSha256 = sha256(
    receipt.terminalReportSha256,
    "cameraCalibrationAcknowledgementReceipt.terminalReportSha256",
  );
  const retainedCalibrationSha256 = sha256(
    receipt.retainedCalibrationSha256,
    "cameraCalibrationAcknowledgementReceipt.retainedCalibrationSha256",
  );
  if (retainedCalibrationSha256 !== sha256Json(calibration)) {
    invalidState("cameraCalibrationAcknowledgementReceipt does not bind the exact retained cameraCalibration");
  }
  if (typeof receipt.projectPatchAcknowledged !== "boolean") {
    invalidState("cameraCalibrationAcknowledgementReceipt.projectPatchAcknowledged must be boolean");
  }
  const projectPatchSha256 = sha256(
    receipt.projectPatchSha256,
    "cameraCalibrationAcknowledgementReceipt.projectPatchSha256",
    { nullable: true },
  );
  if (receipt.projectPatchAcknowledged !== (projectPatchSha256 != null)) {
    invalidState("cameraCalibrationAcknowledgementReceipt project-patch evidence is inconsistent");
  }
  if (receipt.projectPatchAcknowledged && calibration.state !== "complete") {
    invalidState("Only a COMPLETE camera-calibration report can acknowledge a projectPatch");
  }
  const acknowledgedAt = isoTimestamp(
    receipt.acknowledgedAt,
    "cameraCalibrationAcknowledgementReceipt.acknowledgedAt",
  );
  if (!receipt.projectPatchAcknowledged
    && terminalReportSha256 !== sha256Json(canonicalCameraCalibrationReport(calibration))) {
    invalidState("cameraCalibrationAcknowledgementReceipt does not bind its exact patch-free terminal report");
  }
  return {
    calibration,
    receipt: {
      schemaVersion: 1,
      sessionId,
      terminalReportSha256,
      retainedCalibrationSha256,
      projectPatchAcknowledged: receipt.projectPatchAcknowledged,
      projectPatchSha256,
      acknowledgedAt,
    },
  };
}

function validateCameraCalibrationAcknowledgementGeneration(primary, backup) {
  const primaryCalibration = primary.cameraCalibration;
  const primaryReceipt = primary.cameraCalibrationAcknowledgementReceipt;
  const backupCalibration = backup.cameraCalibration;
  const backupReceipt = backup.cameraCalibrationAcknowledgementReceipt;
  const sameSession = primaryCalibration != null
    && backupCalibration != null
    && primaryCalibration.sessionId === backupCalibration.sessionId;

  if (primaryReceipt == null) {
    if (!sameSession) return;
    if (backupReceipt != null) {
      invalidGeneration(
        "Primary Node state removed a durable camera-calibration acknowledgement receipt from its LKG generation",
      );
    }
    if (backupCalibration.projectPatch != null && primaryCalibration.projectPatch == null) {
      invalidGeneration(
        "Primary Node state removed an unacknowledged camera-calibration projectPatch from its LKG generation",
      );
    }
    return;
  }

  if (!sameSession) return;
  if (backupReceipt != null) {
    if (!isDeepStrictEqual(primaryReceipt, backupReceipt)
      || !isDeepStrictEqual(primaryCalibration, backupCalibration)) {
      invalidGeneration(
        "Primary Node state changed a durable camera-calibration acknowledgement or terminal calibration",
      );
    }
    return;
  }

  const backupReport = canonicalCameraCalibrationReport(backupCalibration);
  const backupHasProjectPatch = backupReport.projectPatch != null;
  const expectedCompactedCalibration = jsonSafe({
    ...backupCalibration,
    projectPatch: null,
  });
  if (primaryReceipt.terminalReportSha256 !== sha256Json(backupReport)
    || primaryReceipt.projectPatchAcknowledged !== backupHasProjectPatch
    || primaryReceipt.projectPatchSha256 !== (backupHasProjectPatch
      ? sha256Json(backupReport.projectPatch)
      : null)
    || !isDeepStrictEqual(primaryCalibration, expectedCompactedCalibration)) {
    invalidGeneration(
      "Camera-calibration acknowledgement receipt does not match the exact terminal report in its LKG generation",
    );
  }
}

function validateOpticalVerificationState(state) {
  if (typeof state.cameraOpticalVerificationFailClosed !== "boolean") {
    invalidState("cameraOpticalVerificationFailClosed must be boolean");
  }
  if (typeof state.cameraOpticalVerificationReportAcknowledged !== "boolean") {
    invalidState("cameraOpticalVerificationReportAcknowledged must be boolean");
  }
  const planInput = state.cameraOpticalVerificationPlan;
  const runtimeInput = state.cameraOpticalVerification;
  if ((planInput == null) !== (runtimeInput == null)) {
    invalidState("cameraOpticalVerificationPlan and cameraOpticalVerification must be retained together");
  }
  if (planInput == null) {
    if (state.cameraOpticalVerificationConfirmationReceipt != null
      || state.cameraOpticalVerificationRestoreReceipt != null) {
      invalidState("Optical-verification command receipts require a retained plan and runtime");
    }
    return;
  }
  let plan;
  let runtime;
  try {
    plan = normalizeCameraOpticalVerificationPlan(planInput);
    runtime = normalizeCameraOpticalVerificationState(runtimeInput, { plan });
  } catch (error) {
    invalidState(`Persisted optical verification is invalid: ${error.message}`, error);
  }
  if (!isDeepStrictEqual(jsonSafe(plan), planInput)
    || !isDeepStrictEqual(jsonSafe(runtime), runtimeInput)) {
    invalidState("Persisted optical verification is not in canonical form");
  }
  const stickyStates = new Set([
    CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
    CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
    CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
    CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
  ]);
  if (stickyStates.has(runtime.state) && state.cameraOpticalVerificationFailClosed !== true) {
    invalidState(`Optical-verification state ${runtime.state} requires retained fail-closed ownership`);
  }
  for (const [field, receipt] of [
    ["cameraOpticalVerificationConfirmationReceipt", state.cameraOpticalVerificationConfirmationReceipt],
    ["cameraOpticalVerificationRestoreReceipt", state.cameraOpticalVerificationRestoreReceipt],
  ]) {
    if (receipt == null) continue;
    const normalized = record(receipt, field);
    safeInteger(normalized.sequence, `${field}.sequence`, { min: 1 });
    boundedString(normalized.commandId, `${field}.commandId`, { max: 256 });
    record(normalized.payload, `${field}.payload`);
    if (normalized.sequence <= state.lastSequence) {
      invalidState(`${field}.sequence must remain ahead of lastSequence until consumed`);
    }
  }
}

function hydrate(input) {
  record(input, "Node state");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    invalidState(`Unsupported or missing Node state schema; expected ${SCHEMA_VERSION}`);
  }
  const lastSequence = safeInteger(input.lastSequence, "lastSequence");
  const preparedAssets = array(input.preparedAssets, "preparedAssets", { optional: true, max: 1_024 });
  const pendingActions = normalizePendingActions(input.pendingActions, lastSequence);
  const { actionResults, hostActionJournal } = normalizeHostActionState(
    input.actionResults,
    input.hostActionJournal,
    lastSequence,
  );
  const commandFailures = record(input.commandFailures, "commandFailures", { optional: true });
  const pendingCommandDeadLetters = array(
    input.pendingCommandDeadLetters,
    "pendingCommandDeadLetters",
    { optional: true, max: 32 },
  );
  const commandDeadLetterReceipts = array(
    input.commandDeadLetterReceipts,
    "commandDeadLetterReceipts",
    { optional: true, max: 32 },
  );
  const commandFailureSafetyLock = input.commandFailureSafetyLock == null
    ? null
    : record(input.commandFailureSafetyLock, "commandFailureSafetyLock");
  const stateRecoverySafetyLock = normalizeRecoverySafetyLock(input.stateRecoverySafetyLock);
  const serverFailClosedFence = normalizeServerFailClosedFence(input.serverFailClosedFence);
  const {
    calibration: cameraCalibration,
    receipt: cameraCalibrationAcknowledgementReceipt,
  } = normalizeCameraCalibrationAcknowledgementState(
    input.cameraCalibration,
    input.cameraCalibrationAcknowledgementReceipt,
  );
  const project = normalizePersistedProject(input.project);
  const transport = normalizePersistedTransport(input.transport);
  if (transport && ["scheduled", "playing"].includes(transport.state)) {
    if (!project
      || transport.frameRateNum !== project.canvas.frameRateNum
      || transport.frameRateDen !== project.canvas.frameRateDen) {
      invalidState("Active transport frame rate must match the persisted project canvas");
    }
  }
  if (input.updatedAt != null && (typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt)))) {
    invalidState("updatedAt must be null or an ISO timestamp");
  }
  const state = {
    ...defaults(),
    ...input,
    schemaVersion: SCHEMA_VERSION,
    lastSequence,
    project,
    transport,
    preparedAssets,
    pendingActions,
    actionResults,
    hostActionJournal,
    commandFailures,
    pendingCommandDeadLetters,
    commandDeadLetterReceipts,
    commandFailureSafetyLock,
    stateRecoverySafetyLock,
    serverFailClosedFence,
    cameraCalibration,
    cameraCalibrationAcknowledgementReceipt,
  };
  validateCriticalCommandState(state);
  validateOpticalVerificationState(state);
  return state;
}

export class NodeStateStore {
  constructor(pathname, operations = {}) {
    this.pathname = pathname;
    this.backupPathname = `${pathname}.last-known-good.json`;
    this.state = defaults();
    this.committedState = jsonSafe(this.state);
    this.writeChain = Promise.resolve();
    this.saveRequestId = 0;
    this.latestSaveRequestId = 0;
    this.file = {
      mkdir: operations.mkdir || mkdir,
      copyFile: operations.copyFile || copyFile,
      open: operations.open || open,
      readFile: operations.readFile || readFile,
      rename: operations.rename || rename,
      rm: operations.rm || rm,
      writeFile: operations.writeFile || writeFile,
      syncFile: operations.syncFile || null,
      syncDirectory: operations.syncDirectory || null,
    };
  }

  async initialize() {
    await this.file.mkdir(dirname(this.pathname), { recursive: true });
    try {
      this.state = await this.#readState(this.pathname);
      try {
        const backup = await this.#readState(this.backupPathname);
        validateHostActionGeneration(this.state, backup);
        validateCameraCalibrationAcknowledgementGeneration(this.state, backup);
        validateServerFailClosedFenceGeneration(this.state, backup);
      } catch (error) {
        if (error?.code === "NODE_STATE_GENERATION_INVALID") throw error;
        if (error?.code === "NODE_STATE_INVALID"
          && /removed or changed in-flight host action/.test(error.message)) throw error;
        // A valid primary remains authoritative when no usable prior
        // generation exists. The next durable save will rotate a fresh LKG.
      }
    } catch (primaryError) {
      if (primaryError?.code === "ENOENT") {
        try {
          const recovered = withRecoverySafetyLock(await this.#readState(this.backupPathname), primaryError);
          await this.#persist(recovered, { rotateBackup: false });
          this.state = recovered;
        } catch (backupError) {
          if (backupError?.code !== "ENOENT") {
            throw invalidRecovery(
              `Primary Node state is missing and its last-known-good backup is invalid: ${backupError.message}`,
              backupError,
            );
          }
          await this.#persist(this.state, { rotateBackup: false });
        }
      } else {
        let recovered;
        try {
          recovered = withRecoverySafetyLock(await this.#readState(this.backupPathname), primaryError);
        } catch (backupError) {
          throw invalidRecovery(
            `Node state is invalid and no valid last-known-good backup is available (${primaryError.message}; ${backupError.message})`,
            primaryError,
          );
        }
        const quarantinePath = `${this.pathname}.invalid-${Date.now()}`;
        try {
          await this.file.rename(this.pathname, quarantinePath);
          await this.#syncDirectory();
          await this.#persist(recovered, { rotateBackup: false });
          this.state = recovered;
        } catch (recoveryError) {
          throw invalidRecovery(`Last-known-good Node state could not be restored safely: ${recoveryError.message}`, recoveryError);
        }
      }
    }
    this.committedState = jsonSafe(this.state);
    return this.snapshot();
  }

  snapshot() {
    return jsonSafe(this.committedState);
  }

  save(nextState = this.state) {
    const candidate = hydrate(jsonSafe({
      ...nextState,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    }));
    const requestId = ++this.saveRequestId;
    this.latestSaveRequestId = requestId;
    const operation = this.writeChain.then(async () => {
      const temporary = `${this.pathname}.${process.pid}.${Date.now()}.${requestId}.tmp`;
      try {
        await this.#persist(candidate, { temporary, rotateBackup: true });
      } catch (error) {
        await this.file.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      this.committedState = jsonSafe(candidate);
      if (requestId === this.latestSaveRequestId) this.state = jsonSafe(candidate);
      return this.snapshot();
    }).catch((error) => {
      // Nothing becomes externally acknowledgeable until the atomic rename
      // succeeds. If the newest requested commit fails, discard its mutable
      // RAM draft so reconnect/heartbeat cannot advertise state absent on disk.
      if (requestId === this.latestSaveRequestId) this.state = jsonSafe(this.committedState);
      throw error;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async flush() {
    await this.writeChain;
  }

  async #readState(pathname) {
    let parsed;
    try {
      parsed = JSON.parse(await this.file.readFile(pathname, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") throw error;
      invalidState(`Cannot parse ${pathname}: ${error.message}`, error);
    }
    return hydrate(parsed);
  }

  async #syncFile(pathname) {
    if (this.file.syncFile) return this.file.syncFile(pathname);
    // Windows FlushFileBuffers requires a writable handle; r+ never truncates.
    const handle = await this.file.open(pathname, process.platform === "win32" ? "r+" : "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncDirectory() {
    if (this.file.syncDirectory) return this.file.syncDirectory(dirname(this.pathname));
    let handle;
    try {
      handle = await this.file.open(dirname(this.pathname), "r");
      await handle.sync();
    } catch (error) {
      if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #persist(state, { temporary = null, rotateBackup = true } = {}) {
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const tempPath = temporary || `${this.pathname}.${suffix}.tmp`;
    const backupTemporary = `${this.backupPathname}.${suffix}.tmp`;
    const document = `${JSON.stringify(state, null, 2)}\n`;
    try {
      await this.file.writeFile(tempPath, document, { encoding: "utf8", mode: 0o600 });
      await this.#syncFile(tempPath);
      if (rotateBackup) {
        try {
          await this.file.copyFile(this.pathname, backupTemporary);
          await this.#syncFile(backupTemporary);
          await this.file.rename(backupTemporary, this.backupPathname);
          await this.#syncDirectory();
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          await this.file.rm(backupTemporary, { force: true }).catch(() => {});
        }
      }
      await this.file.rename(tempPath, this.pathname);
      await this.#syncDirectory();
    } catch (error) {
      await this.file.rm(tempPath, { force: true }).catch(() => {});
      await this.file.rm(backupTemporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function invalidRecovery(message, cause) {
  const error = new Error(message, { cause });
  error.code = "NODE_STATE_RECOVERY_FAILED";
  return error;
}
