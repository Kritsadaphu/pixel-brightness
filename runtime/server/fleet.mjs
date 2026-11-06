import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { COMMAND, HOST_ACTION_TYPE } from "../shared/protocol.mjs";
import { badRequest } from "./errors.mjs";

export const HOST_ACTION_TYPES = new Set(Object.values(HOST_ACTION_TYPE));
export const POWER_ACTION_TYPES = new Set([
  HOST_ACTION_TYPE.REBOOT_HOST,
  HOST_ACTION_TYPE.SHUTDOWN_HOST,
]);

export const ACTION_RESULT_STATUS = new Set([
  "succeeded",
  "failed",
  "denied",
  "dry-run",
]);

function safeString(value, maxLength = 8_192) {
  return String(value ?? "")
    .replaceAll(String.fromCharCode(0), "")
    .replaceAll(String.fromCharCode(127), "")
    .slice(0, maxLength);
}

function sanitizeValue(value, depth, limits, counters) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    counters.strings += value.length;
    if (counters.strings > limits.maxStringCharacters) {
      throw badRequest(`${limits.label} contains too much text`, `${limits.code}_too_large`);
    }
    return safeString(value, limits.maxStringLength);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (depth >= limits.maxDepth) return "[depth-limit]";
  if (Array.isArray(value)) {
    return value.slice(0, limits.maxArrayLength)
      .map((item) => sanitizeValue(item, depth + 1, limits, counters));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [keyInput, item] of Object.entries(value).slice(0, limits.maxObjectKeys)) {
      const key = safeString(keyInput, 128);
      if (!key || key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (/(?:authorization|password|secret|token)$/i.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = sanitizeValue(item, depth + 1, limits, counters);
    }
    return output;
  }
  return null;
}

export function boundedJson(value, {
  label = "Value",
  code = "value",
  maxBytes = 512 * 1024,
  maxDepth = 8,
  maxArrayLength = 512,
  maxObjectKeys = 512,
  maxStringLength = 64 * 1024,
  maxStringCharacters = maxBytes,
  requireObject = false,
} = {}) {
  if (requireObject && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw badRequest(`${label} must be an object`, `invalid_${code}`);
  }
  const sanitized = sanitizeValue(value, 0, {
    label,
    code,
    maxDepth,
    maxArrayLength,
    maxObjectKeys,
    maxStringLength,
    maxStringCharacters,
  }, { strings: 0 });
  if (Buffer.byteLength(JSON.stringify(sanitized)) > maxBytes) {
    throw badRequest(`${label} exceeds ${maxBytes} bytes`, `${code}_too_large`);
  }
  return sanitized;
}

function validTimestamp(value, fallback = null) {
  if (value == null) return fallback;
  const timestamp = safeString(value, 64);
  return Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : fallback;
}

export function normalizeHostSnapshot(input, receivedAt = new Date().toISOString()) {
  const host = boundedJson(input, {
    label: "Host snapshot",
    code: "host_snapshot",
    maxBytes: 768 * 1024,
    maxDepth: 10,
    maxArrayLength: 512,
    maxObjectKeys: 512,
    maxStringLength: 32 * 1024,
    requireObject: true,
  });
  return {
    ...host,
    capturedAt: validTimestamp(host.capturedAt ?? host.collectedAt, receivedAt),
    receivedAt,
  };
}

export function normalizeActionRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw badRequest("Action request must be an object", "invalid_action_request");
  }
  const type = safeString(input.type, 64);
  if (!HOST_ACTION_TYPES.has(type)) {
    throw badRequest("Unsupported host action type", "unsupported_host_action", {
      allowed: Array.from(HOST_ACTION_TYPES),
    });
  }
  const payload = input.payload == null ? {} : boundedJson(input.payload, {
    label: "Action payload",
    code: "action_payload",
    maxBytes: 128 * 1024,
    maxDepth: 8,
    maxArrayLength: 256,
    maxObjectKeys: 256,
    maxStringLength: 16 * 1024,
    requireObject: true,
  });
  return {
    type,
    payload,
    confirmationPhrase: input.confirmationPhrase == null ? null : safeString(input.confirmationPhrase, 256),
  };
}

export function expectedHostActionResultId(commandId, sequence, actionId) {
  const digest = createHash("sha256")
    .update(`${commandId}:${sequence}:${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `host-result-${digest}`;
}

function canonicalActionResultTimestamp(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) {
    throw badRequest(`${field} must be a canonical UTC timestamp`, "invalid_action_result_timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw badRequest(`${field} must be a canonical UTC timestamp`, "invalid_action_result_timestamp");
  }
  return value;
}

export function normalizeActionResults(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw badRequest("actionResults must be an array", "invalid_action_results");
  if (input.length > 128) throw badRequest("actionResults exceeds 128 records", "action_results_too_large");
  const resultIds = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw badRequest(`actionResults[${index}] must be an object`, "invalid_action_result");
    }
    const status = typeof item.status === "string" ? item.status : "";
    const success = status === "succeeded" || status === "dry-run";
    const failure = status === "failed" || status === "denied";
    if (!success && !failure) {
      throw badRequest(`actionResults[${index}] must be terminal`, "invalid_action_result_status");
    }
    const expectedKeys = [
      "resultId", "commandId", "sequence", "actionId", "actionType", "status",
      "startedAt", "completedAt", success ? "result" : "error",
    ].sort();
    if (!isDeepStrictEqual(Object.keys(item).sort(), expectedKeys)) {
      throw badRequest(
        `actionResults[${index}] contains missing or unsupported fields`,
        "invalid_action_result",
      );
    }
    const commandId = safeString(item.commandId, 256);
    const actionId = safeString(item.actionId, 256);
    if (!commandId || commandId !== item.commandId || !actionId || actionId !== item.actionId) {
      throw badRequest(`actionResults[${index}] has invalid command/action identity`, "invalid_action_result_identity");
    }
    const sequence = Number(item.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence !== item.sequence) {
      throw badRequest(`actionResults[${index}] has an invalid sequence`, "invalid_action_result_sequence");
    }
    const actionType = safeString(item.actionType, 64);
    if (!HOST_ACTION_TYPES.has(actionType)) {
      throw badRequest(`actionResults[${index}] has an unsupported actionType`, "invalid_action_result_type");
    }
    const resultId = expectedHostActionResultId(commandId, sequence, actionId);
    if (item.resultId !== resultId || resultIds.has(resultId)) {
      throw badRequest(
        `actionResults[${index}] has a forged or duplicate deterministic resultId`,
        "invalid_action_result_id",
      );
    }
    resultIds.add(resultId);
    const startedAt = canonicalActionResultTimestamp(item.startedAt, `actionResults[${index}].startedAt`);
    const completedAt = canonicalActionResultTimestamp(item.completedAt, `actionResults[${index}].completedAt`);
    if (Date.parse(completedAt) < Date.parse(startedAt)) {
      throw badRequest(
        `actionResults[${index}].completedAt precedes startedAt`,
        "invalid_action_result_timestamp",
      );
    }
    const result = success ? boundedJson(item.result, {
      label: "Action result",
      code: "action_result",
      maxBytes: 512 * 1024,
      maxDepth: 10,
      maxArrayLength: 512,
      maxObjectKeys: 512,
      maxStringLength: 64 * 1024,
      requireObject: true,
    }) : null;
    const error = failure ? boundedJson(item.error, {
      label: "Action error",
      code: "action_error",
      maxBytes: 64 * 1024,
      maxDepth: 6,
      maxArrayLength: 64,
      maxObjectKeys: 128,
      maxStringLength: 16 * 1024,
      requireObject: true,
    }) : null;
    if (success && !isDeepStrictEqual(result, item.result)) {
      throw badRequest(`actionResults[${index}].result is not canonical`, "invalid_action_result");
    }
    if (failure) {
      const expectedErrorKeys = ["code", "details", "message"];
      if (!isDeepStrictEqual(Object.keys(error).sort(), expectedErrorKeys)) {
        throw badRequest(`actionResults[${index}].error is not canonical`, "invalid_action_result");
      }
      const code = safeString(error.code, 128);
      const message = safeString(error.message, 4_096);
      if (!code || code !== error.code || !message || message !== error.message
        || (error.details != null && (!error.details || typeof error.details !== "object" || Array.isArray(error.details)))) {
        throw badRequest(`actionResults[${index}].error is invalid`, "invalid_action_result");
      }
      if (!isDeepStrictEqual(error, item.error)) {
        throw badRequest(`actionResults[${index}].error is not canonical`, "invalid_action_result");
      }
    }
    return {
      resultId,
      commandId,
      sequence,
      actionId,
      actionType,
      status,
      startedAt,
      completedAt,
      ...(success ? { result } : { error }),
    };
  });
}

export function actionResultSummary(result) {
  return {
    resultId: result.resultId,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    result: result.result == null ? null : boundedJson(result.result, {
      label: "Action audit result",
      code: "action_audit_result",
      maxBytes: 96 * 1024,
      maxDepth: 7,
      maxArrayLength: 128,
      maxObjectKeys: 256,
      maxStringLength: 16 * 1024,
    }),
    error: result.error ?? null,
  };
}

export function normalizeCommandDeadLetters(input, expectedNodeId) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw badRequest("commandDeadLetters must be an array", "invalid_command_dead_letters");
  if (input.length > 32) throw badRequest("commandDeadLetters exceeds 32 records", "command_dead_letters_too_large");
  const seen = new Set();
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.schemaVersion !== 1) {
      throw badRequest(`commandDeadLetters[${index}] is invalid`, "invalid_command_dead_letter");
    }
    const deadLetterId = safeString(item.deadLetterId, 96);
    if (!/^command_dead_letter_[a-f0-9]{32}$/.test(deadLetterId) || seen.has(deadLetterId)) {
      throw badRequest(`commandDeadLetters[${index}] has an invalid or duplicate id`, "invalid_command_dead_letter_id");
    }
    seen.add(deadLetterId);
    const nodeId = safeString(item.nodeId, 128);
    if (nodeId !== expectedNodeId) {
      throw badRequest(`commandDeadLetters[${index}] belongs to another node`, "command_dead_letter_node_mismatch");
    }
    const command = item.command;
    const commandId = safeString(command?.id, 128);
    const sequence = Number(command?.sequence);
    const type = safeString(command?.type, 128);
    if (!commandId || !Number.isSafeInteger(sequence) || sequence < 1 || !Object.values(COMMAND).includes(type)) {
      throw badRequest(`commandDeadLetters[${index}] has an invalid command identity`, "invalid_command_dead_letter_command");
    }
    const attempts = Number(item.attempts);
    const retryBudget = Number(item.retryBudget);
    if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(retryBudget)
      || retryBudget < 1 || retryBudget > 20 || attempts < retryBudget || attempts > 1_000) {
      throw badRequest(`commandDeadLetters[${index}] has invalid retry evidence`, "invalid_command_dead_letter_attempts");
    }
    const firstFailedAt = validTimestamp(item.firstFailedAt);
    const lastFailedAt = validTimestamp(item.lastFailedAt);
    const deadLetteredAt = validTimestamp(item.deadLetteredAt);
    if (!firstFailedAt || !lastFailedAt || !deadLetteredAt
      || Date.parse(firstFailedAt) > Date.parse(lastFailedAt)
      || Date.parse(lastFailedAt) > Date.parse(deadLetteredAt)) {
      throw badRequest(`commandDeadLetters[${index}] has invalid timestamps`, "invalid_command_dead_letter_timestamp");
    }
    if (!Array.isArray(item.errors) || item.errors.length < 1 || item.errors.length > 20) {
      throw badRequest(`commandDeadLetters[${index}] has invalid error evidence`, "invalid_command_dead_letter_errors");
    }
    const errors = item.errors.map((error, errorIndex) => {
      const attempt = Number(error?.attempt);
      const failedAt = validTimestamp(error?.failedAt);
      const message = safeString(error?.message, 2_048);
      if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > attempts || !failedAt || !message) {
        throw badRequest(
          `commandDeadLetters[${index}].errors[${errorIndex}] is invalid`,
          "invalid_command_dead_letter_error",
        );
      }
      return {
        attempt,
        failedAt,
        name: safeString(error?.name || "Error", 128),
        code: error?.code == null ? null : safeString(error.code, 128),
        message,
      };
    });
    if (errors.at(-1).attempt !== attempts || errors.at(-1).failedAt !== lastFailedAt) {
      throw badRequest(`commandDeadLetters[${index}] latest error is inconsistent`, "invalid_command_dead_letter_error");
    }
    const safetyCritical = item.safetyCritical === true;
    let failClosed = null;
    if (safetyCritical) {
      if (item.failClosed?.active !== true || typeof item.failClosed?.blackApplied !== "boolean") {
        throw badRequest(`commandDeadLetters[${index}] lacks fail-closed evidence`, "invalid_command_dead_letter_fail_closed");
      }
      failClosed = {
        active: true,
        blackApplied: item.failClosed.blackApplied,
        enforcementError: item.failClosed.enforcementError == null ? null : boundedJson(item.failClosed.enforcementError, {
          label: "Fail-closed enforcement error",
          code: "command_dead_letter_fail_closed",
          maxBytes: 16 * 1024,
          maxDepth: 4,
          maxArrayLength: 16,
          maxObjectKeys: 32,
          maxStringLength: 2_048,
        }),
      };
    } else if (item.failClosed != null) {
      throw badRequest(`commandDeadLetters[${index}] has unexpected fail-closed evidence`, "invalid_command_dead_letter_fail_closed");
    }
    return {
      schemaVersion: 1,
      deadLetterId,
      nodeId,
      command: { id: commandId, sequence, type },
      attempts,
      retryBudget,
      safetyCritical,
      firstFailedAt,
      lastFailedAt,
      deadLetteredAt,
      errors,
      failClosed,
    };
  });
}

function normalizeFault(input, subsystem = "host", index = 0) {
  if (typeof input === "string") {
    return {
      code: `${subsystem.toUpperCase()}_FAULT_${index + 1}`,
      severity: "error",
      subsystem,
      message: safeString(input, 1_024),
    };
  }
  if (!input || typeof input !== "object") return null;
  const severityInput = safeString(input.severity ?? input.level ?? "error", 16).toLowerCase();
  const severity = severityInput === "critical" ? "critical"
    : severityInput === "error" || severityInput === "fatal" ? "error"
      : severityInput === "info" ? "info" : "warning";
  return {
    code: safeString(input.code || `${subsystem.toUpperCase()}_FAULT_${index + 1}`, 128),
    severity,
    subsystem: safeString(input.subsystem || subsystem, 64).toLowerCase(),
    message: safeString(input.message || input.error || input.code || "Host fault", 1_024),
    ...(input.connector == null ? {} : { connector: safeString(input.connector, 128) }),
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function statusFault(status) {
  return /^(error|failed|fault|missing|unhealthy|degraded)$/i.test(String(status ?? ""));
}

function connectorList(host) {
  return [
    ...asArray(host?.displays),
    ...asArray(host?.connectors),
    ...asArray(host?.drm?.connectors),
    ...asArray(host?.display?.connectors),
  ];
}

export function deriveHostFaults(host, { node = null, project = null } = {}) {
  if (!host || typeof host !== "object") return [];
  const faults = [];
  const addList = (values, subsystem) => {
    asArray(values).forEach((value, index) => {
      const fault = normalizeFault(value, subsystem, index);
      if (fault) faults.push(fault);
    });
  };
  addList(host.faults, "host");
  addList(host.driver?.faults, "driver");
  addList(host.display?.faults, "display");
  addList(host.renderer?.faults, "renderer");

  const connectors = connectorList(host);

  const driverStatuses = [
    host.driver?.status,
    host.gpu?.driverStatus,
    host.nvidia?.driverStatus,
    ...asArray(host.gpus).map((gpu) => gpu?.driverStatus ?? gpu?.driver?.status),
  ];
  driverStatuses.forEach((status, index) => {
    if (statusFault(status)) faults.push({
      code: `DRIVER_STATUS_${index + 1}`,
      severity: "error",
      subsystem: "driver",
      message: `Graphics driver reports ${safeString(status, 64)}`,
    });
  });
  const expectedGpu = String(node?.capabilities?.gpu ?? "");
  const expectsNvidia = /nvidia/i.test(expectedGpu)
    || connectors.some((connector) => /nvidia/i.test(String(connector?.driver ?? "")));
  if (expectsNvidia && host.gpu?.supported === true && host.gpu?.available === false) {
    faults.push({
      code: "DRIVER_NVIDIA_UNAVAILABLE",
      severity: "error",
      subsystem: "driver",
      message: `NVIDIA telemetry is unavailable (${safeString(host.gpu?.reason ?? "nvidia-smi failed", 256)})`,
    });
  }

  for (const connector of connectors) {
    const status = connector?.status ?? connector?.state;
    if (statusFault(status)) faults.push({
      code: "DISPLAY_CONNECTOR_FAULT",
      severity: "error",
      subsystem: "display",
      message: `${safeString(connector?.name ?? connector?.connector ?? connector?.id ?? "Display", 128)} reports ${safeString(status, 64)}`,
      connector: safeString(connector?.name ?? connector?.connector ?? connector?.id ?? "unknown", 128),
    });
    if (connector?.error) faults.push({
      code: "DISPLAY_CONNECTOR_ERROR",
      severity: "error",
      subsystem: "display",
      message: safeString(connector.error, 1_024),
      connector: safeString(connector?.name ?? connector?.connector ?? connector?.id ?? "unknown", 128),
    });
  }

  const renderer = host.services?.renderer ?? host.renderer ?? host.service?.renderer;
  if (renderer && (renderer.active === false || statusFault(renderer.status ?? renderer.state))) faults.push({
    code: "RENDERER_SERVICE_FAULT",
    severity: "error",
    subsystem: "renderer",
    message: `Renderer service reports ${safeString(renderer.status ?? renderer.state ?? "inactive", 64)}`,
  });

  const configuredConnectors = new Set();
  for (const output of asArray(project?.outputs)) {
    if (output.enabled !== false && output.nodeId === node?.nodeId && output.connector) {
      configuredConnectors.add(String(output.connector));
    }
  }
  for (const service of asArray(host.services)) {
    if (!/(?:pixel-brightness|renderer)/i.test(String(service?.name ?? ""))) continue;
    const serviceState = service?.activeState ?? service?.status ?? service?.state;
    if ((service?.supported !== false && service?.available === false)
      || statusFault(serviceState)
      || /^(inactive|dead)$/i.test(String(serviceState ?? ""))) {
      faults.push({
        code: "RENDERER_SERVICE_FAULT",
        severity: "error",
        subsystem: "renderer",
        message: `${safeString(service?.name ?? "Renderer service", 128)} reports ${safeString(serviceState ?? service?.error ?? "unavailable", 128)}`,
      });
    }
  }
  for (const output of asArray(node?.capabilities?.outputs)) {
    if (output?.connector) configuredConnectors.add(String(output.connector));
  }
  if (connectors.length > 0) {
    const reported = new Map(connectors.map((connector) => [
      String(connector?.name ?? connector?.connector ?? connector?.id ?? ""),
      connector,
    ]));
    for (const expected of configuredConnectors) {
      const connector = reported.get(expected);
      const status = connector?.status ?? connector?.state;
      if (!connector) faults.push({
        code: "DISPLAY_CONNECTOR_MISSING",
        severity: "error",
        subsystem: "display",
        message: `Configured connector ${safeString(expected, 128)} is missing from the host snapshot`,
        connector: safeString(expected, 128),
      });
      else if (/^(disconnected|disabled)$/i.test(String(status ?? ""))) faults.push({
        code: "DISPLAY_CONNECTOR_DISCONNECTED",
        severity: "error",
        subsystem: "display",
        message: `Configured connector ${safeString(expected, 128)} is ${safeString(status, 64)}`,
        connector: safeString(expected, 128),
      });
    }
  }

  const deduped = new Map();
  for (const fault of faults) {
    const key = `${fault.code}:${fault.connector ?? ""}:${fault.message}`;
    if (!deduped.has(key)) deduped.set(key, fault);
  }
  return Array.from(deduped.values()).slice(0, 256);
}

export function expectedConfirmationPhrase(type, nodeId) {
  if (type === HOST_ACTION_TYPE.REBOOT_HOST) return `REBOOT ${nodeId}`;
  if (type === HOST_ACTION_TYPE.SHUTDOWN_HOST) return `SHUTDOWN ${nodeId}`;
  return null;
}
