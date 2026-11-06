import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import { sendPanasonicCommand } from "./panasonic-ntcontrol.mjs";

export const PROJECTOR_CONTROL_SCHEMA_VERSION = 1;
export const PANASONIC_PROJECTOR_MODEL = "PT-VMZ51";
export const DEFAULT_PROJECTOR_CONTROL_PORT = 1024;
export const MAX_PROJECTORS = 5;

const PROJECTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OUTPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INPUT_COMMANDS = Object.freeze({
  hdmi1: "IIS:HD1",
  hdmi2: "IIS:HD2",
  "digital-link": "IIS:DL1",
});
const ACTION_COMMANDS = Object.freeze({
  "power-on": "PON",
  standby: "POF",
  "shutter-open": "OSH:0",
  "shutter-close": "OSH:1",
  ...Object.fromEntries(Object.entries(INPUT_COMMANDS).map(([input, command]) => [`input-${input}`, command])),
});

const POWER_STATES = Object.freeze({ "000": "standby", "001": "on" });
const SHUTTER_STATES = Object.freeze({ "0": "open", "1": "closed" });
const LIGHT_STATES = Object.freeze({ "0": "standby", "1": "starting", "2": "on", "3": "stopping" });
const INPUT_STATES = Object.freeze({
  RG1: "computer-1",
  RG2: "computer-2",
  HD1: "hdmi1",
  HD2: "hdmi2",
  DL1: "digital-link",
  "DL1:PC1": "digital-link-computer-1",
  "DL1:PC2": "digital-link-computer-2",
  "DL1:VID": "digital-link-video",
  "DL1:HD1": "digital-link-hdmi1",
  "DL1:HD2": "digital-link-hdmi2",
  "DL1:SVD": "digital-link-s-video",
  MV1: "memory-viewer",
  NWP: "network",
});

export class ProjectorControlError extends Error {
  constructor(code, message, { status = 400, cause = null, details = undefined } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProjectorControlError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanText(value, field, { fallback = "", maximum = 128 } = {}) {
  const text = value == null ? fallback : String(value).trim();
  const containsControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (text.length > maximum || containsControl) {
    throw new ProjectorControlError("invalid_projector_configuration", `${field} is invalid`);
  }
  return text;
}

function normalizePort(value) {
  const port = value == null || value === "" ? DEFAULT_PROJECTOR_CONTROL_PORT : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ProjectorControlError("invalid_projector_configuration", "Projector command port must be 1-65535");
  }
  return port;
}

function normalizeProjector(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProjectorControlError("invalid_projector_configuration", `projectors[${index}] must be an object`);
  }
  const allowed = new Set(["id", "name", "outputId", "host", "port", "enabled", "model"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ProjectorControlError(
      "invalid_projector_configuration",
      `projectors[${index}] contains unsupported fields: ${unknown.join(", ")}`,
    );
  }
  if (input.enabled != null && typeof input.enabled !== "boolean") {
    throw new ProjectorControlError(
      "invalid_projector_configuration",
      `projectors[${index}].enabled must be a boolean`,
    );
  }
  const id = cleanText(input.id, `projectors[${index}].id`, { fallback: `projector-${index + 1}`, maximum: 64 });
  const outputId = cleanText(input.outputId, `projectors[${index}].outputId`, {
    fallback: String.fromCharCode(65 + index), maximum: 64,
  });
  const host = cleanText(input.host, `projectors[${index}].host`, { maximum: 64 });
  if (!PROJECTOR_ID_PATTERN.test(id)) {
    throw new ProjectorControlError("invalid_projector_configuration", `projectors[${index}].id is invalid`);
  }
  if (!OUTPUT_ID_PATTERN.test(outputId)) {
    throw new ProjectorControlError("invalid_projector_configuration", `projectors[${index}].outputId is invalid`);
  }
  if (host && isIP(host) === 0) {
    throw new ProjectorControlError(
      "invalid_projector_configuration",
      `projectors[${index}].host must be a literal IPv4 or IPv6 address`,
    );
  }
  const model = cleanText(input.model, `projectors[${index}].model`, {
    fallback: PANASONIC_PROJECTOR_MODEL,
    maximum: 64,
  }).toUpperCase();
  if (model !== PANASONIC_PROJECTOR_MODEL) {
    throw new ProjectorControlError(
      "invalid_projector_configuration",
      `Only ${PANASONIC_PROJECTOR_MODEL} is supported by this LAN adapter`,
    );
  }
  return {
    id,
    name: cleanText(input.name, `projectors[${index}].name`, { fallback: `Projector ${index + 1}`, maximum: 128 }),
    outputId,
    host,
    port: normalizePort(input.port),
    enabled: input.enabled == null ? Boolean(host) : input.enabled && Boolean(host),
    model,
  };
}

export function defaultPanasonicProjectors(count = MAX_PROJECTORS) {
  return Array.from({ length: Math.max(1, Math.min(MAX_PROJECTORS, Number(count) || MAX_PROJECTORS)) }, (_, index) => ({
    id: `projector-${index + 1}`,
    name: `Projector ${index + 1}`,
    outputId: String.fromCharCode(65 + index),
    host: "",
    port: DEFAULT_PROJECTOR_CONTROL_PORT,
    enabled: false,
    model: PANASONIC_PROJECTOR_MODEL,
  }));
}

export function normalizeProjectorConfiguration(input = {}) {
  if (!Array.isArray(input)) {
    if (!input || typeof input !== "object") {
      throw new ProjectorControlError("invalid_projector_configuration", "Projector configuration must be an object");
    }
    const unknown = Object.keys(input).filter((key) => key !== "projectors");
    if (unknown.length > 0) {
      throw new ProjectorControlError(
        "invalid_projector_configuration",
        `Projector configuration contains unsupported fields: ${unknown.join(", ")}`,
      );
    }
  }
  const raw = Array.isArray(input) ? input : input.projectors;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PROJECTORS) {
    throw new ProjectorControlError(
      "invalid_projector_configuration",
      `projectors must contain 1-${MAX_PROJECTORS} Panasonic projector rows`,
    );
  }
  const projectors = raw.map(normalizeProjector);
  const duplicate = (field) => {
    const seen = new Set();
    return projectors.find((projector) => {
      const key = projector[field];
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
  };
  if (duplicate("id")) {
    throw new ProjectorControlError("invalid_projector_configuration", "Projector ids must be unique");
  }
  if (duplicate("outputId")) {
    throw new ProjectorControlError("invalid_projector_configuration", "Projector output bindings must be unique");
  }
  const endpoints = new Set();
  for (const projector of projectors.filter((item) => item.enabled)) {
    const endpoint = `${projector.host}:${projector.port}`;
    if (endpoints.has(endpoint)) {
      throw new ProjectorControlError("invalid_projector_configuration", "Enabled projector IP/port pairs must be unique");
    }
    endpoints.add(endpoint);
  }
  return projectors;
}

function webControlUrl(host) {
  if (!host) return null;
  return `http://${isIP(host) === 6 ? `[${host}]` : host}/`;
}

function publicError(error) {
  if (error instanceof ProjectorControlError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details?.outcomeUnknown ? { outcomeUnknown: true } : {}),
    };
  }
  const code = String(error?.code || "projector_unreachable").toLowerCase();
  if (code.startsWith("panasonic_")) {
    return {
      code,
      message: String(error?.message || "Panasonic projector command failed"),
      ...(error?.outcomeUnknown === true ? { outcomeUnknown: true } : {}),
    };
  }
  return {
    code,
    message: code === "econnrefused"
      ? "Projector refused the LAN Command Control connection"
      : code === "etimedout"
        ? "Projector LAN Command Control timed out"
        : "Projector LAN Command Control failed",
  };
}

async function durableJsonWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

function parseState(value, mapping, label) {
  if (!Object.prototype.hasOwnProperty.call(mapping, value)) {
    throw new ProjectorControlError(
      "panasonic_protocol_error",
      `${label} query returned an unsupported value`,
      { status: 502 },
    );
  }
  return mapping[value];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PanasonicProjectorControl {
  constructor({
    dataDir,
    username = "dispadmin",
    password = "",
    sendCommand = sendPanasonicCommand,
    commandTimeoutMs = 3_000,
    commandGapMs = 500,
  } = {}) {
    if (!dataDir) throw new Error("PanasonicProjectorControl requires dataDir");
    this.configPath = path.join(path.resolve(dataDir), "projector-control.json");
    this.projectors = defaultPanasonicProjectors();
    this.statuses = new Map();
    this.username = cleanText(username, "projector username", { fallback: "dispadmin", maximum: 128 });
    this.password = String(password ?? "");
    this.sendCommand = sendCommand;
    this.commandTimeoutMs = Math.max(500, Math.min(15_000, Number(commandTimeoutMs) || 3_000));
    this.commandGapMs = Math.max(0, Math.min(2_000, Number(commandGapMs) || 0));
    this.revision = 0;
    this.updatedAt = null;
    this.lastBatch = null;
    this.deviceQueues = new Map();
    this.lastCommandCompletedAt = new Map();
    this.activeOperations = 0;
    this.configuring = false;
    this.actionInProgress = false;
  }

  async init() {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8"));
      if (parsed.schemaVersion !== PROJECTOR_CONTROL_SCHEMA_VERSION) {
        throw new ProjectorControlError("invalid_projector_configuration", "Projector configuration schema is unsupported");
      }
      this.projectors = normalizeProjectorConfiguration(parsed.projectors);
      const revision = parsed.revision == null ? 1 : parsed.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ProjectorControlError("invalid_projector_configuration", "Projector configuration revision is invalid");
      }
      this.revision = revision;
      this.updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      schemaVersion: PROJECTOR_CONTROL_SCHEMA_VERSION,
      adapter: "panasonic-ntcontrol-lan",
      model: PANASONIC_PROJECTOR_MODEL,
      commandPortDefault: DEFAULT_PROJECTOR_CONTROL_PORT,
      credential: { configured: Boolean(this.password) },
      revision: this.revision,
      updatedAt: this.updatedAt,
      projectors: this.projectors.map((projector) => ({
        ...projector,
        webControlUrl: webControlUrl(projector.host),
        status: this.statuses.get(projector.id) ?? {
          online: false,
          state: projector.enabled ? "not-checked" : "not-configured",
          checkedAt: null,
        },
      })),
      lastBatch: this.lastBatch,
    };
  }

  async configure(input = {}) {
    if (this.configuring || this.activeOperations > 0) {
      throw new ProjectorControlError(
        "projector_control_busy",
        "Wait for the current projector operation to finish before changing IP bindings",
        { status: 409 },
      );
    }
    this.configuring = true;
    try {
      const projectors = normalizeProjectorConfiguration(input);
      const updatedAt = new Date().toISOString();
      const revision = this.revision + 1;
      await durableJsonWrite(this.configPath, {
        schemaVersion: PROJECTOR_CONTROL_SCHEMA_VERSION,
        revision,
        updatedAt,
        projectors,
      });
      this.projectors = projectors;
      this.revision = revision;
      this.updatedAt = updatedAt;
      // A status belongs to an endpoint, not merely to its human-facing id.
      // Clear it after every committed inventory edit so a rebound row can
      // never display the previous projector's health.
      this.statuses.clear();
      this.lastCommandCompletedAt.clear();
      return this.snapshot();
    } finally {
      this.configuring = false;
    }
  }

  beginOperation(expectedRevision = null) {
    if (this.configuring) {
      throw new ProjectorControlError(
        "projector_control_busy",
        "Projector IP bindings are being updated; retry the command",
        { status: 409 },
      );
    }
    if (expectedRevision != null && expectedRevision !== this.revision) {
      throw new ProjectorControlError(
        "projector_configuration_revision_mismatch",
        `Projector configuration revision ${expectedRevision} is stale; current revision is ${this.revision}`,
        { status: 412 },
      );
    }
    this.activeOperations += 1;
  }

  endOperation() {
    this.activeOperations = Math.max(0, this.activeOperations - 1);
  }

  configuredProjector(id) {
    const projector = this.projectors.find((candidate) => candidate.id === id);
    if (!projector) {
      throw new ProjectorControlError("projector_not_found", "Projector is not configured", { status: 404 });
    }
    if (!projector.enabled || !projector.host) {
      throw new ProjectorControlError("projector_not_configured", "Projector IP is not enabled", { status: 409 });
    }
    return projector;
  }

  async command(projector, command) {
    try {
      const elapsed = Date.now() - (this.lastCommandCompletedAt.get(projector.id) ?? 0);
      if (this.commandGapMs > 0 && elapsed < this.commandGapMs) {
        await delay(this.commandGapMs - elapsed);
      }
      return await this.sendCommand({
        host: projector.host,
        port: projector.port,
        username: this.username,
        password: this.password,
        command,
        timeoutMs: this.commandTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ProjectorControlError) throw error;
      throw new ProjectorControlError(
        String(error?.code || "projector_command_failed").toLowerCase(),
        publicError(error).message,
        {
          status: ["ERRA", "PANASONIC_AUTH_FAILED", "PANASONIC_CREDENTIALS_REQUIRED"].includes(String(error?.code)) ? 401 : 502,
          cause: error,
          details: {
            phase: typeof error?.phase === "string" ? error.phase : null,
            retryable: error?.retryable === true,
            outcomeUnknown: error?.outcomeUnknown === true,
          },
        },
      );
    } finally {
      this.lastCommandCompletedAt.set(projector.id, Date.now());
    }
  }

  async status(id) {
    this.beginOperation();
    try {
      const projector = this.configuredProjector(id);
      return await this.enqueue(projector.id, () => this.readStatus(projector));
    } finally {
      this.endOperation();
    }
  }

  enqueue(projectorId, operation) {
    const predecessor = this.deviceQueues.get(projectorId) ?? Promise.resolve();
    const current = predecessor.catch(() => undefined).then(operation);
    let tracked;
    tracked = current.finally(() => {
      if (this.deviceQueues.get(projectorId) === tracked) this.deviceQueues.delete(projectorId);
    });
    this.deviceQueues.set(projectorId, tracked);
    return tracked;
  }

  async readStatus(projector) {
    const id = projector.id;
    const checkedAt = new Date().toISOString();
    let status = null;
    let controlChannelReached = false;
    try {
      const powerReply = await this.command(projector, "QPW");
      controlChannelReached = true;
      const power = parseState(String(powerReply.response), POWER_STATES, "Power");
      status = {
        online: true,
        state: power,
        power,
        shutter: null,
        input: null,
        light: power === "standby" ? "standby" : null,
        lightHours: null,
        checkedAt,
        error: null,
      };
      if (power === "on") {
        const lightReply = await this.command(projector, "Q$S");
        status.light = parseState(String(lightReply.response), LIGHT_STATES, "Light");
        status.state = status.light === "on" ? "on" : status.light;
        // During laser startup/cooldown the projector can reject unrelated
        // commands for up to a minute. QPW + Q$S is enough to show an honest
        // transition without falsely declaring a LAN failure.
        if (status.light !== "on") {
          this.statuses.set(id, status);
          return { projectorId: id, ok: true, status };
        }
        for (const [nextCommand, field, mapping, label] of [
          ["QSH", "shutter", SHUTTER_STATES, "Shutter"],
          ["QIN", "input", INPUT_STATES, "Input"],
        ]) {
          const reply = await this.command(projector, nextCommand);
          status[field] = parseState(String(reply.response), mapping, label);
        }
        const hours = String((await this.command(projector, "Q$L")).response);
        if (!/^\d{1,5}$/.test(hours)) {
          throw new ProjectorControlError("panasonic_protocol_error", "Light-hours query returned an unsupported value", { status: 502 });
        }
        status.lightHours = Number(hours);
      }
      this.statuses.set(id, status);
      return { projectorId: id, ok: true, status };
    } catch (error) {
      const failure = publicError(error);
      const phase = error instanceof ProjectorControlError ? error.details?.phase : null;
      controlChannelReached ||= ["greeting", "authentication", "response"].includes(String(phase));
      if (status?.online || controlChannelReached) {
        const partial = {
          ...(status ?? {}),
          online: true,
          state: ["panasonic_projector_busy", "panasonic_projector_timeout"].includes(failure.code)
            ? "starting"
            : "status-partial",
          checkedAt,
          error: failure,
        };
        this.statuses.set(id, partial);
        return { projectorId: id, ok: true, status: partial, warning: failure };
      }
      const failedStatus = { online: false, state: "error", checkedAt, error: failure };
      this.statuses.set(id, failedStatus);
      return { projectorId: id, ok: false, status: failedStatus, error: failure };
    }
  }

  async refresh(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ProjectorControlError("invalid_projector_request", "Projector refresh request must be an object");
    }
    const unknown = Object.keys(input).filter((key) => !["projectorIds", "expectedRevision"].includes(key));
    if (unknown.length > 0) {
      throw new ProjectorControlError(
        "invalid_projector_request",
        `Projector refresh contains unsupported fields: ${unknown.join(", ")}`,
      );
    }
    if (Object.hasOwn(input, "projectorIds") && !Array.isArray(input.projectorIds)) {
      throw new ProjectorControlError("invalid_projector_request", "projectorIds must be an array");
    }
    if (Object.hasOwn(input, "expectedRevision")
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw new ProjectorControlError("invalid_projector_request", "expectedRevision must be a positive integer");
    }
    const requested = input.projectorIds ?? null;
    if (requested?.some((id) => typeof id !== "string" || !PROJECTOR_ID_PATTERN.test(id))) {
      throw new ProjectorControlError("invalid_projector_request", "projectorIds must contain valid projector ids");
    }
    const selectedIds = requested == null
      ? this.projectors.filter((projector) => projector.enabled).map((projector) => projector.id)
      : requested;
    if (new Set(selectedIds).size !== selectedIds.length || selectedIds.length > MAX_PROJECTORS) {
      throw new ProjectorControlError(
        "invalid_projector_request",
        `projectorIds must be a unique list of at most ${MAX_PROJECTORS} ids`,
      );
    }
    this.beginOperation(input.expectedRevision ?? null);
    try {
      const selected = selectedIds.map((id) => this.configuredProjector(id));
      const results = await Promise.all(selected.map((projector) => (
        this.enqueue(projector.id, () => this.readStatus(projector))
      )));
      return { ...this.snapshot(), results };
    } finally {
      this.endOperation();
    }
  }

  async action(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ProjectorControlError("invalid_projector_request", "Projector action request must be an object");
    }
    const allowed = new Set(["projectorIds", "action", "staggerMs", "expectedRevision"]);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length > 0) {
      throw new ProjectorControlError(
        "invalid_projector_request",
        `Projector action contains unsupported fields: ${unknown.join(", ")}`,
      );
    }
    const action = String(input.action || "");
    const command = ACTION_COMMANDS[action];
    if (!command) {
      throw new ProjectorControlError("invalid_projector_action", "Unsupported projector action");
    }
    if (!Array.isArray(input.projectorIds)) {
      throw new ProjectorControlError(
        "invalid_projector_request",
        "projectorIds must explicitly select the projector rows for every action",
      );
    }
    if (input.projectorIds?.some((id) => typeof id !== "string" || !PROJECTOR_ID_PATTERN.test(id))) {
      throw new ProjectorControlError("invalid_projector_request", "projectorIds must contain valid projector ids");
    }
    const projectorIds = input.projectorIds;
    if (projectorIds.length < 1
      || projectorIds.length > MAX_PROJECTORS
      || new Set(projectorIds).size !== projectorIds.length) {
      throw new ProjectorControlError(
        "invalid_projector_request",
        `Select 1-${MAX_PROJECTORS} unique configured projectors`,
      );
    }
    if (input.staggerMs != null
      && (!Number.isSafeInteger(input.staggerMs) || input.staggerMs < 0 || input.staggerMs > 2_000)) {
      throw new ProjectorControlError("invalid_projector_request", "staggerMs must be an integer from 0 to 2000");
    }
    if (Object.hasOwn(input, "expectedRevision")
        && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
      throw new ProjectorControlError("invalid_projector_request", "expectedRevision must be a positive integer");
    }
    const staggerMs = input.staggerMs ?? 0;
    if (this.actionInProgress) {
      throw new ProjectorControlError(
        "projector_control_busy",
        "Wait for the current projector group action to finish",
        { status: 409 },
      );
    }
    this.beginOperation(input.expectedRevision ?? null);
    this.actionInProgress = true;
    try {
      const selected = projectorIds.map((id) => this.configuredProjector(id));
      const results = await Promise.all(selected.map(async (projector, index) => {
        if (index > 0 && staggerMs > 0) await delay(index * staggerMs);
        const sentAt = new Date().toISOString();
        try {
          const reply = await this.enqueue(projector.id, async () => {
            const accepted = await this.command(projector, command);
            const status = {
              ...(this.statuses.get(projector.id) ?? {}),
              online: true,
              state: "command-accepted",
              checkedAt: sentAt,
              lastAction: action,
              error: null,
            };
            this.statuses.set(projector.id, status);
            return accepted;
          });
          return { projectorId: projector.id, ok: true, response: reply.response, sentAt };
        } catch (error) {
          const failure = publicError(error);
          const phase = error instanceof ProjectorControlError ? error.details?.phase : null;
          const controlChannelReached = ["greeting", "authentication", "response"].includes(String(phase));
          this.statuses.set(projector.id, {
            online: controlChannelReached,
            state: failure.outcomeUnknown
              ? "outcome-unknown"
              : controlChannelReached ? "control-error" : "error",
            checkedAt: sentAt,
            lastAction: action,
            error: failure,
          });
          return { projectorId: projector.id, ok: false, error: failure, sentAt };
        }
      }));
      this.lastBatch = {
        action,
        completedAt: new Date().toISOString(),
        requested: selected.length,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      };
      return { ...this.snapshot(), results };
    } finally {
      this.endOperation();
      this.actionInProgress = false;
    }
  }
}
