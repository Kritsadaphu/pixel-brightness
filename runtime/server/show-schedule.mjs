import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const SHOW_SCHEDULE_SCHEMA_VERSION = 1;
export const SHOW_SCHEDULE_DAYS = Object.freeze([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

const CONFIG_FIELDS = new Set([
  "schemaVersion",
  "enabled",
  "nodeId",
  "arenaExecutablePath",
  "arenaCompositionPath",
  "projectorStartupEnabled",
  "projectorStandbyEnabled",
  "projectorStaggerMs",
  "projectorWarmupSeconds",
  "days",
]);
const RUNTIME_STATES = new Set([
  "disabled",
  "idle",
  "waiting-for-login",
  "starting",
  "running",
  "stopping",
  "shutdown-blocked",
  "error",
]);
const RUNTIME_PHASES = new Set([
  "disabled",
  "off-day",
  "before-start",
  "deferred",
  "awaiting-login",
  "starting-show",
  "starting-arena",
  "waiting-source",
  "powering-projectors",
  "warming-projectors",
  "ready",
  "saving-arena",
  "closing-arena",
  "projector-standby",
  "stopping-show",
  "requesting-windows-shutdown",
  "failed",
]);
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RUNTIME_BYTES = 16 * 1024;
const ACTION_STATUSES = new Set(["not-attempted", "running", "succeeded", "failed"]);
const STARTUP_STAGE_ORDER = Object.freeze([
  "created",
  "show-start-requested",
  "show-running",
  "arena-start-requested",
  "arena-running",
  "source-ready",
  "projectors-power-requested",
  "ready",
]);
const STARTUP_STAGES = new Set(STARTUP_STAGE_ORDER);
const SHUTDOWN_STAGE_ORDER = Object.freeze([
  "pending",
  "arena-save-requested",
  "arena-closed",
  "projectors-standby-requested",
  "projectors-standby-confirmed",
  "show-stop-requested",
  "show-stopped",
  "shutdown-requested",
]);
const SHUTDOWN_STAGES = new Set(SHUTDOWN_STAGE_ORDER);

export class ShowScheduleError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ShowScheduleError";
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  throw new ShowScheduleError("invalid_show_schedule", message);
}

function containsControl(value) {
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) invalid(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function booleanValue(value, field) {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function windowsPath(value, field, extension) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048 || containsControl(value)) {
    invalid(`${field} is invalid`);
  }
  const normalized = value.trim();
  if (normalized !== value || /["<>|?*]/.test(normalized)
      || normalized.startsWith("\\\\?\\") || normalized.startsWith("\\\\.\\")) {
    invalid(`${field} contains unsupported Windows path syntax`);
  }
  const drivePath = /^[A-Za-z]:\\/.test(normalized);
  const uncPath = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
  if (!normalized || (!drivePath && !uncPath) || !path.win32.isAbsolute(normalized)) {
    invalid(`${field} must be an absolute Windows drive or UNC path`);
  }
  if (path.win32.extname(normalized).toLowerCase() !== extension) {
    invalid(`${field} must end with ${extension}`);
  }
  const relative = drivePath
    ? normalized.slice(3)
    : normalized.split("\\").slice(4).join("\\");
  if (relative.split("\\").some((segment) => !segment || segment === "." || segment === ".."
      || /[:]/.test(segment) || /[ .]$/.test(segment))) {
    invalid(`${field} contains an invalid Windows path segment`);
  }
  return normalized;
}

function timeMinutes(value, field) {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    invalid(`${field} must use zero-padded 24-hour HH:MM time`);
  }
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeDay(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`days[${index}] must be an object`);
  }
  exactKeys(value, new Set(["day", "enabled", "startTime", "shutdownTime"]), `days[${index}]`);
  if (value.day !== SHOW_SCHEDULE_DAYS[index]) {
    invalid(`days must contain Monday through Sunday in canonical order`);
  }
  const startMinutes = timeMinutes(value.startTime, `days[${index}].startTime`);
  const shutdownMinutes = timeMinutes(value.shutdownTime, `days[${index}].shutdownTime`);
  if (startMinutes >= shutdownMinutes) {
    invalid(`days[${index}] must start before shutdown on the same day`);
  }
  return {
    day: value.day,
    enabled: booleanValue(value.enabled, `days[${index}].enabled`),
    startTime: value.startTime,
    shutdownTime: value.shutdownTime,
  };
}

export function defaultShowSchedule() {
  return {
    schemaVersion: SHOW_SCHEDULE_SCHEMA_VERSION,
    enabled: false,
    nodeId: "",
    arenaExecutablePath: null,
    arenaCompositionPath: null,
    projectorStartupEnabled: true,
    projectorStandbyEnabled: true,
    projectorStaggerMs: 1_000,
    projectorWarmupSeconds: 60,
    days: SHOW_SCHEDULE_DAYS.map((day) => ({
      day,
      enabled: false,
      startTime: "09:00",
      shutdownTime: "20:00",
    })),
  };
}

export function normalizeShowSchedule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("Show schedule must be an object");
  }
  exactKeys(input, CONFIG_FIELDS, "Show schedule");
  if (input.schemaVersion !== SHOW_SCHEDULE_SCHEMA_VERSION) {
    invalid("Show schedule schemaVersion must be 1");
  }
  const enabled = booleanValue(input.enabled, "enabled");
  if (typeof input.nodeId !== "string" || input.nodeId.length > 128 || containsControl(input.nodeId)) {
    invalid("nodeId is invalid");
  }
  const nodeId = input.nodeId.trim();
  if (nodeId && !NODE_ID_PATTERN.test(nodeId)) invalid("nodeId is invalid");
  const arenaExecutablePath = windowsPath(input.arenaExecutablePath, "arenaExecutablePath", ".exe");
  const arenaCompositionPath = windowsPath(input.arenaCompositionPath, "arenaCompositionPath", ".avc");
  if (!Array.isArray(input.days) || input.days.length !== SHOW_SCHEDULE_DAYS.length) {
    invalid("days must contain exactly seven rows");
  }
  const days = input.days.map(normalizeDay);
  if (enabled && !NODE_ID_PATTERN.test(nodeId)) invalid("An enabled schedule requires a valid nodeId");
  if (enabled && (!arenaExecutablePath || !arenaCompositionPath)) {
    invalid("An enabled schedule requires absolute Arena executable and composition paths");
  }
  if (enabled && !days.some((day) => day.enabled)) {
    invalid("An enabled schedule requires at least one enabled weekday");
  }
  return {
    schemaVersion: SHOW_SCHEDULE_SCHEMA_VERSION,
    enabled,
    nodeId,
    arenaExecutablePath,
    arenaCompositionPath,
    projectorStartupEnabled: booleanValue(input.projectorStartupEnabled, "projectorStartupEnabled"),
    projectorStandbyEnabled: booleanValue(input.projectorStandbyEnabled, "projectorStandbyEnabled"),
    projectorStaggerMs: boundedInteger(input.projectorStaggerMs, "projectorStaggerMs", 0, 2_000),
    projectorWarmupSeconds: boundedInteger(input.projectorWarmupSeconds, "projectorWarmupSeconds", 0, 600),
    days,
  };
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !value || !Number.isFinite(new Date(value).getTime())) return null;
  return value;
}

function realLocalDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? value
    : null;
}

function runtimeMessage(value) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 500 || containsControl(value)) return null;
  return value;
}

function runtimeWindowsPath(value, field, extension) {
  try {
    return windowsPath(value, field, extension);
  } catch {
    return null;
  }
}

function normalizeRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== SHOW_SCHEDULE_SCHEMA_VERSION
      || !RUNTIME_STATES.has(value.state)
      || !RUNTIME_PHASES.has(value.phase)
      || !realLocalDate(value.localDate)
      || !isoTimestamp(value.updatedAt)) return null;
  const arenaProcessId = value.arenaProcessId == null ? null : value.arenaProcessId;
  if (arenaProcessId != null && (!Number.isSafeInteger(arenaProcessId) || arenaProcessId < 1)) return null;
  const scheduleUpdatedAt = value.scheduleUpdatedAt == null ? null : isoTimestamp(value.scheduleUpdatedAt);
  if (value.scheduleUpdatedAt != null && scheduleUpdatedAt == null) return null;
  let lastAction = null;
  if (value.lastAction != null) {
    const action = value.lastAction;
    if (!action || typeof action !== "object" || Array.isArray(action)
        || !["start", "shutdown"].includes(action.type)
        || !realLocalDate(action.scheduleDate)
        || !["running", "succeeded", "failed"].includes(action.status)
        || !isoTimestamp(action.startedAt)) return null;
    const completedAt = action.completedAt == null ? null : isoTimestamp(action.completedAt);
    const message = runtimeMessage(action.message);
    if ((action.completedAt != null && completedAt == null)
        || (action.message != null && message == null)) return null;
    lastAction = {
      type: action.type,
      scheduleDate: action.scheduleDate,
      status: action.status,
      startedAt: action.startedAt,
      completedAt,
      message,
    };
  }
  let dailyLedger = null;
  if (value.dailyLedger != null) {
    const ledger = value.dailyLedger;
    if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)
        || !realLocalDate(ledger.scheduleDate)
        || !ACTION_STATUSES.has(ledger.startStatus)
        || !ACTION_STATUSES.has(ledger.shutdownStatus)) return null;
    dailyLedger = {
      scheduleDate: ledger.scheduleDate,
      startStatus: ledger.startStatus,
      shutdownStatus: ledger.shutdownStatus,
    };
  }
  let activeRun = null;
  if (value.activeRun != null) {
    const run = value.activeRun;
    const projectorIds = Array.isArray(run?.projectorIds) ? run.projectorIds : null;
    const runProcessId = run?.arenaProcessId == null ? null : run.arenaProcessId;
    const runProcessStart = run?.arenaProcessStartTimeUtc == null ? null : isoTimestamp(run.arenaProcessStartTimeUtc);
    const runBootId = run?.runBootId == null ? null : isoTimestamp(run.runBootId);
    const shutdownRequestBootId = run?.shutdownRequestBootId == null ? null : isoTimestamp(run.shutdownRequestBootId);
    const projectorConfigurationRevision = run?.projectorConfigurationRevision == null
      ? 0
      : run.projectorConfigurationRevision;
    const startupIndex = STARTUP_STAGE_ORDER.indexOf(run?.startupStage);
    const shutdownIndex = SHUTDOWN_STAGE_ORDER.indexOf(run?.shutdownStage);
    const arenaRunningIndex = STARTUP_STAGE_ORDER.indexOf("arena-running");
    const arenaClosedIndex = SHUTDOWN_STAGE_ORDER.indexOf("arena-closed");
    if (!run || typeof run !== "object" || Array.isArray(run)
        || !realLocalDate(run.scheduleDate)
        || !TIME_PATTERN.test(run.shutdownTime)
        || typeof run.nodeId !== "string" || !NODE_ID_PATTERN.test(run.nodeId)
        || !STARTUP_STAGES.has(run.startupStage)
        || !SHUTDOWN_STAGES.has(run.shutdownStage)
        || !Number.isSafeInteger(run.scheduleRevision) || run.scheduleRevision < 1
        || !isoTimestamp(run.scheduleUpdatedAt)
        || !runtimeWindowsPath(run.arenaExecutablePath, "activeRun.arenaExecutablePath", ".exe")
        || !runtimeWindowsPath(run.arenaCompositionPath, "activeRun.arenaCompositionPath", ".avc")
        || typeof run.projectorStartupEnabled !== "boolean"
        || typeof run.projectorStandbyEnabled !== "boolean"
        || !Number.isSafeInteger(projectorConfigurationRevision) || projectorConfigurationRevision < 0
        || !Number.isSafeInteger(run.projectorStaggerMs) || run.projectorStaggerMs < 0 || run.projectorStaggerMs > 2_000
        || !Number.isSafeInteger(run.projectorWarmupSeconds) || run.projectorWarmupSeconds < 0 || run.projectorWarmupSeconds > 600
        || !projectorIds || ![0, 5].includes(projectorIds.length)
        || ((run.projectorStartupEnabled || run.projectorStandbyEnabled) && projectorIds.length !== 5)
        || ((run.projectorStartupEnabled || run.projectorStandbyEnabled) && projectorConfigurationRevision < 1)
        || (!run.projectorStartupEnabled && !run.projectorStandbyEnabled && projectorIds.length !== 0)
        || (!run.projectorStartupEnabled && !run.projectorStandbyEnabled && projectorConfigurationRevision !== 0)
        || new Set(projectorIds).size !== projectorIds.length
        || projectorIds.some((id) => typeof id !== "string" || !NODE_ID_PATTERN.test(id))
        || (runProcessId != null && (!Number.isSafeInteger(runProcessId) || runProcessId < 1 || !runProcessStart))
        || (runProcessId == null && run.arenaProcessStartTimeUtc != null)
        || (run.runBootId != null && !runBootId)
        || (run.shutdownRequestBootId != null && !shutdownRequestBootId)
        || (shutdownRequestBootId && run.shutdownStage !== "shutdown-requested")
        || (runBootId && shutdownRequestBootId
          && new Date(runBootId).getTime() !== new Date(shutdownRequestBootId).getTime())
        || (startupIndex < arenaRunningIndex && runProcessId != null)
        || (startupIndex >= arenaRunningIndex && shutdownIndex < arenaClosedIndex && runProcessId == null)
        || (shutdownIndex >= arenaClosedIndex && runProcessId != null)
        || runProcessId !== arenaProcessId) return null;
    activeRun = {
      scheduleDate: run.scheduleDate,
      shutdownTime: run.shutdownTime,
      nodeId: typeof run.nodeId === "string" ? run.nodeId : "",
      scheduleRevision: run.scheduleRevision,
      scheduleUpdatedAt: run.scheduleUpdatedAt,
      startupStage: run.startupStage,
      shutdownStage: run.shutdownStage,
      projectorConfigurationRevision,
      runBootId,
      shutdownRequestBootId,
      projectorIds: [...projectorIds],
    };
  } else if (arenaProcessId != null) {
    return null;
  }
  const workerMessage = runtimeMessage(value.workerMessage);
  if (value.workerMessage != null && workerMessage == null) return null;
  return {
    schemaVersion: SHOW_SCHEDULE_SCHEMA_VERSION,
    state: value.state,
    phase: value.phase,
    localDate: value.localDate,
    lastAction,
    dailyLedger,
    activeRun,
    arenaProcessId,
    workerMessage,
    updatedAt: value.updatedAt,
    scheduleUpdatedAt,
  };
}

function localDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function weekday(value) {
  return SHOW_SCHEDULE_DAYS[(value.getDay() + 6) % 7];
}

function eventAt(date, time) {
  const [hour, minute] = time.split(":").map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function nextScheduleEvent(schedule, now, updatedAt, runtime) {
  if (runtime?.activeRun) {
    const [year, month, day] = runtime.activeRun.scheduleDate.split("-").map(Number);
    const pinnedDate = new Date(year, month - 1, day);
    const scheduled = eventAt(pinnedDate, runtime.activeRun.shutdownTime);
    return {
      type: "shutdown",
      day: weekday(scheduled),
      localDate: runtime.activeRun.scheduleDate,
      localTime: runtime.activeRun.shutdownTime,
      scheduledAt: scheduled.toISOString(),
      nodeId: runtime.activeRun.nodeId || schedule.nodeId,
      pinned: true,
    };
  }
  if (!schedule.enabled) return null;
  const savedAt = updatedAt ? new Date(updatedAt) : null;
  const currentDate = localDate(now);
  const currentDayAttempted = runtime?.dailyLedger?.scheduleDate === currentDate
    && (runtime.dailyLedger.startStatus !== "not-attempted"
      || runtime.dailyLedger.shutdownStatus !== "not-attempted");
  const candidates = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const row = schedule.days.find((day) => day.day === weekday(date));
    if (!row?.enabled) continue;
    if (offset === 0 && currentDayAttempted) continue;
    const start = eventAt(date, row.startTime);
    // A revision saved after that day's Start boundary is deliberately not a
    // catch-up instruction. It becomes eligible on the next enabled day.
    if (savedAt && savedAt.getTime() > start.getTime()) continue;
    for (const [type, localTime] of [["start", row.startTime], ["shutdown", row.shutdownTime]]) {
      const scheduled = eventAt(date, localTime);
      if (scheduled.getTime() < now.getTime()) continue;
      candidates.push({
        type,
        day: row.day,
        localDate: localDate(scheduled),
        localTime,
        scheduledAt: scheduled.toISOString(),
        nodeId: schedule.nodeId,
        timestamp: scheduled.getTime(),
      });
    }
  }
  candidates.sort((left, right) => left.timestamp - right.timestamp || left.type.localeCompare(right.type));
  if (candidates.length === 0) return null;
  const first = candidates[0];
  return {
    type: first.type,
    day: first.day,
    localDate: first.localDate,
    localTime: first.localTime,
    scheduledAt: first.scheduledAt,
    nodeId: first.nodeId,
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

export class ShowScheduleControl {
  constructor({ dataDir, clock = () => new Date() } = {}) {
    if (!dataDir) throw new Error("ShowScheduleControl requires dataDir");
    if (typeof clock !== "function") throw new Error("ShowScheduleControl clock must be a function");
    this.configPath = path.join(path.resolve(dataDir), "show-schedule.json");
    this.runtimePath = path.join(path.resolve(dataDir), "show-schedule-runtime.json");
    this.schedule = defaultShowSchedule();
    this.updatedAt = null;
    this.revision = 0;
    this.clock = clock;
    this.configuring = false;
  }

  async init() {
    try {
      const bytes = await readFile(this.configPath);
      if (bytes.byteLength > 64 * 1024) invalid("Persisted show schedule is too large");
      const parsed = JSON.parse(bytes.toString("utf8"));
      const allowed = new Set([...CONFIG_FIELDS, "updatedAt", "revision"]);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("Persisted show schedule is invalid");
      exactKeys(parsed, allowed, "Persisted show schedule");
      const updatedAt = isoTimestamp(parsed.updatedAt);
      if (!updatedAt) invalid("Persisted show schedule updatedAt is invalid");
      const configuration = { ...parsed };
      delete configuration.updatedAt;
      delete configuration.revision;
      this.schedule = normalizeShowSchedule(configuration);
      this.updatedAt = updatedAt;
      const revision = parsed.revision == null ? 1 : parsed.revision;
      if (!Number.isSafeInteger(revision) || revision < 1) invalid("Persisted show schedule revision is invalid");
      this.revision = revision;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        if (error instanceof ShowScheduleError) throw error;
        throw new ShowScheduleError("invalid_show_schedule", "Persisted show schedule cannot be loaded", {
          status: 500,
          cause: error,
        });
      }
    }
    return this.snapshot();
  }

  async runtimeSnapshot() {
    try {
      const bytes = await readFile(this.runtimePath);
      if (bytes.byteLength > MAX_RUNTIME_BYTES) return null;
      return normalizeRuntime(JSON.parse(bytes.toString("utf8")));
    } catch {
      return null;
    }
  }

  async snapshot() {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ShowScheduleError("show_schedule_clock_invalid", "Show schedule clock is invalid", { status: 500 });
    }
    const runtime = await this.runtimeSnapshot();
    return {
      ...this.schedule,
      revision: this.revision,
      updatedAt: this.updatedAt,
      nextEvent: nextScheduleEvent(this.schedule, now, this.updatedAt, runtime),
      runtime,
    };
  }

  async configure(input, { ifMatchRevision } = {}) {
    if (this.configuring) {
      throw new ShowScheduleError("show_schedule_busy", "Wait for the current schedule save to finish", { status: 409 });
    }
    this.configuring = true;
    try {
      if (!Number.isSafeInteger(ifMatchRevision) || ifMatchRevision < 0) {
        throw new ShowScheduleError(
          "show_schedule_revision_precondition_required",
          "Weekly schedule updates require If-Match with the exact current schedule revision",
          { status: 428 },
        );
      }
      if (ifMatchRevision !== this.revision) {
        throw new ShowScheduleError(
          "show_schedule_revision_mismatch",
          `Weekly schedule revision ${ifMatchRevision} is stale; current revision is ${this.revision}`,
          { status: 412 },
        );
      }
      const schedule = normalizeShowSchedule(input);
      const updatedAt = this.clock().toISOString();
      const revision = this.revision + 1;
      await durableJsonWrite(this.configPath, { ...schedule, revision, updatedAt });
      this.schedule = schedule;
      this.updatedAt = updatedAt;
      this.revision = revision;
      return await this.snapshot();
    } finally {
      this.configuring = false;
    }
  }
}
