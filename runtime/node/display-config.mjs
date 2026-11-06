import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathApiForPlatform, resolvePlatformPath } from "./platform-contract.mjs";
import { normalizeCompositionSource } from "../shared/composition-source.mjs";
import { normalizeWindowsDisplaySelector } from "./windows-renderer-contract.mjs";

const CONNECTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:+-]{0,127}$/;
const OUTPUT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ROTATIONS = new Set(["normal", "left", "right", "inverted"]);
const BACKENDS = new Set(["kms", "xrandr", "dxgi", "auto"]);
const MAX_OUTPUTS = 128;
const DISPLAY_CONFIG_SCHEMA_VERSION = 2;
const DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function hasControlCharacters(value) {
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function integer(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new DisplayConfigError(`${field} must be a finite number`, "INVALID_DISPLAY_CONFIG");
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function boolean(value, fallback = false) {
  return value == null ? fallback : value === true || value === 1 || String(value).toLowerCase() === "true";
}

function dxgiConnector(input, display, fallback) {
  const value = String(input.connector || display.devicePath || display.gdiName
    || (display.adapterLuid ? `${display.adapterLuid}:${display.targetId}` : fallback));
  if (!value || value.length > 1024 || hasControlCharacters(value)) {
    throw new DisplayConfigError(`Invalid DXGI connector: ${value}`, "INVALID_DISPLAY_CONFIG");
  }
  return value;
}

function normalizeOutput(input, index, backend) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DisplayConfigError(`outputs[${index}] must be an object`, "INVALID_DISPLAY_CONFIG");
  }
  const id = String(input.id || `output-${index + 1}`);
  if (!OUTPUT_ID_PATTERN.test(id)) throw new DisplayConfigError(`Invalid output id: ${id}`, "INVALID_DISPLAY_CONFIG");
  let display = null;
  let connector;
  try {
    display = backend === "dxgi" || input.display != null
      ? normalizeWindowsDisplaySelector(input.display, { required: backend === "dxgi" })
      : null;
    connector = backend === "dxgi"
      ? dxgiConnector(input, display, `DISPLAY-${index + 1}`)
      : String(input.connector || "");
    if (backend !== "dxgi" && !CONNECTOR_PATTERN.test(connector)) {
      throw new DisplayConfigError(`Invalid connector: ${connector}`, "INVALID_DISPLAY_CONFIG");
    }
  } catch (error) {
    if (error instanceof DisplayConfigError) throw error;
    throw new DisplayConfigError(error.message, "INVALID_DISPLAY_CONFIG");
  }
  const resolution = input.resolution || input.mode || {};
  const width = integer(resolution.width, 1920, 64, 16_384, `${id}.resolution.width`);
  const height = integer(resolution.height, 1080, 64, 16_384, `${id}.resolution.height`);
  const refreshNum = integer(resolution.refreshNum ?? resolution.refreshRate ?? resolution.refreshHz, 60, 1, 240_000, `${id}.resolution.refreshNum`);
  const refreshDen = integer(resolution.refreshDen, 1, 1, 100_000, `${id}.resolution.refreshDen`);
  const rotation = String(input.rotation || "normal").toLowerCase();
  if (!ROTATIONS.has(rotation)) throw new DisplayConfigError(`Invalid rotation for ${id}`, "INVALID_DISPLAY_CONFIG");
  if (input.source != null) {
    throw new DisplayConfigError("Output source is not allowed; use top-level compositionSource", "INVALID_DISPLAY_CONFIG");
  }
  return {
    id,
    connector,
    enabled: boolean(input.enabled, true),
    primary: boolean(input.primary, false),
    x: integer(input.x ?? input.position?.x, 0, -262_144, 262_144, `${id}.x`),
    y: integer(input.y ?? input.position?.y, 0, -262_144, 262_144, `${id}.y`),
    resolution: { width, height, refreshNum, refreshDen },
    rotation,
    ...(display ? { display } : {}),
  };
}

export class DisplayConfigError extends Error {
  constructor(message, code = "DISPLAY_CONFIG_ERROR", details = null) {
    super(message);
    this.name = "DisplayConfigError";
    this.code = code;
    this.details = details;
  }
}

export function validateDisplayConfig(input, { defaultBackend = "kms" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DisplayConfigError("Display configuration must be an object", "INVALID_DISPLAY_CONFIG");
  }
  const backend = String(input.backend || defaultBackend).toLowerCase();
  if (!BACKENDS.has(backend)) throw new DisplayConfigError(`Unsupported display backend: ${backend}`, "INVALID_DISPLAY_CONFIG");
  if (!Array.isArray(input.outputs) || input.outputs.length < 1 || input.outputs.length > MAX_OUTPUTS) {
    throw new DisplayConfigError(`Display configuration requires 1-${MAX_OUTPUTS} outputs`, "INVALID_DISPLAY_CONFIG");
  }
  const outputs = input.outputs.map((output, index) => normalizeOutput(output, index, backend));
  let compositionSource = null;
  if (input.compositionSource != null) {
    try {
      compositionSource = normalizeCompositionSource(input.compositionSource);
    } catch (error) {
      throw new DisplayConfigError(error.message, "INVALID_DISPLAY_CONFIG");
    }
  }
  const ids = new Set();
  const connectors = new Set();
  let primaryCount = 0;
  for (const output of outputs) {
    if (ids.has(output.id)) throw new DisplayConfigError(`Duplicate output id: ${output.id}`, "INVALID_DISPLAY_CONFIG");
    if (connectors.has(output.connector)) throw new DisplayConfigError(`Duplicate connector: ${output.connector}`, "INVALID_DISPLAY_CONFIG");
    ids.add(output.id);
    connectors.add(output.connector);
    if (output.enabled && output.primary) primaryCount += 1;
  }
  if (primaryCount > 1) throw new DisplayConfigError("Only one enabled output may be primary", "INVALID_DISPLAY_CONFIG");
  return {
    schemaVersion: DISPLAY_CONFIG_SCHEMA_VERSION,
    backend,
    ...(compositionSource ? { compositionSource } : {}),
    outputs,
    updatedAt: new Date().toISOString(),
  };
}

function normalizePersistedDisplayConfig(input, { defaultBackend }) {
  const normalized = validateDisplayConfig(input, { defaultBackend });
  if (input?.schemaVersion !== DISPLAY_CONFIG_SCHEMA_VERSION) {
    throw new DisplayConfigError(
      `Persisted display configuration schemaVersion must be ${DISPLAY_CONFIG_SCHEMA_VERSION}`,
      "INVALID_DISPLAY_CONFIG",
    );
  }
  const updatedAt = String(input.updatedAt || "");
  if (!updatedAt || new Date(updatedAt).toISOString() !== updatedAt) {
    throw new DisplayConfigError(
      "Persisted display configuration updatedAt must be a canonical ISO timestamp",
      "INVALID_DISPLAY_CONFIG",
    );
  }
  normalized.updatedAt = updatedAt;
  if (!isDeepStrictEqual(input, normalized)) {
    throw new DisplayConfigError(
      "Persisted display configuration is not in canonical form",
      "INVALID_DISPLAY_CONFIG",
    );
  }
  return normalized;
}

function displayConfigSha256(config) {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

function normalizeCommitMarker(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DisplayConfigError("Display configuration commit marker must be an object", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  const allowedKeys = input.status === "recovery-required"
    ? ["schemaVersion", "status", "configSha256", "intendedConfigSha256", "updatedAt", "reason", "detectedAt"]
    : ["schemaVersion", "status", "configSha256", "previousConfigSha256", "updatedAt"];
  if (Object.keys(input).sort().join("\0") !== [...allowedKeys].sort().join("\0")) {
    throw new DisplayConfigError("Display configuration commit marker has unexpected fields", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  if (input.schemaVersion !== DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION) {
    throw new DisplayConfigError(
      `Display configuration commit marker schemaVersion must be ${DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION}`,
      "INVALID_DISPLAY_CONFIG_COMMIT",
    );
  }
  if (!["pending", "committed", "recovery-required"].includes(input.status)) {
    throw new DisplayConfigError("Display configuration commit marker status is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  if (!SHA256_PATTERN.test(input.configSha256)) {
    throw new DisplayConfigError("Display configuration commit marker digest is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  const updatedAt = String(input.updatedAt || "");
  if (!updatedAt || new Date(updatedAt).toISOString() !== updatedAt) {
    throw new DisplayConfigError("Display configuration commit marker updatedAt is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  if (input.status === "recovery-required") {
    if (input.intendedConfigSha256 !== null && !SHA256_PATTERN.test(input.intendedConfigSha256)) {
      throw new DisplayConfigError("Display configuration recovery intent digest is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
    }
    if (![
      "commit-marker-invalid",
      "commit-marker-missing",
      "commit-pending",
      "primary-digest-mismatch",
      "primary-restored-from-lkg",
    ].includes(input.reason)) {
      throw new DisplayConfigError("Display configuration recovery reason is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
    }
    const detectedAt = String(input.detectedAt || "");
    if (!detectedAt || new Date(detectedAt).toISOString() !== detectedAt) {
      throw new DisplayConfigError("Display configuration recovery detectedAt is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
    }
    return { ...input };
  }
  if (input.previousConfigSha256 !== null && !SHA256_PATTERN.test(input.previousConfigSha256)) {
    throw new DisplayConfigError("Display configuration previous digest is invalid", "INVALID_DISPLAY_CONFIG_COMMIT");
  }
  return { ...input };
}

async function syncDirectory(pathname) {
  let handle;
  try {
    handle = await open(pathname, "r");
    await handle.sync();
  } catch (error) {
    // Node cannot open directory handles on every supported Windows runtime.
    // Both primary and LKG regular files are still flushed before publication.
    if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishDurable(pathname, document, pathApi) {
  const directory = pathApi.dirname(pathname);
  const temporary = `${pathname}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(document, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, pathname);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function refreshDecimal(resolution) {
  return Math.round(resolution.refreshNum / resolution.refreshDen * 1000) / 1000;
}

/** Builds xrandr argv only; callers must use execFile, never a shell. */
export function createXrandrArgs(configInput) {
  const config = validateDisplayConfig(configInput, { defaultBackend: "xrandr" });
  const args = [];
  for (const output of config.outputs) {
    args.push("--output", output.connector);
    if (!output.enabled) {
      args.push("--off");
      continue;
    }
    args.push(
      "--mode", `${output.resolution.width}x${output.resolution.height}`,
      "--rate", String(refreshDecimal(output.resolution)),
      "--pos", `${output.x}x${output.y}`,
      "--rotate", output.rotation,
    );
    if (output.primary) args.push("--primary");
  }
  return args;
}

export function displayPlan(configInput, { platform = process.platform, allowXrandrFallback = false } = {}) {
  const config = validateDisplayConfig(configInput);
  const preferred = config.backend === "auto"
    ? platform === "win32" ? "dxgi" : "kms"
    : config.backend;
  return {
    preferredBackend: preferred,
    fallbackBackend: config.backend === "auto" && platform === "linux" && allowXrandrFallback ? "xrandr" : null,
    platform,
    requiresDrmMaster: preferred === "kms",
    requiresInteractiveSession: preferred === "dxgi",
    requiresNativeRenderer: preferred === "dxgi",
    platformSupported: preferred === "dxgi" ? platform === "win32" : platform === "linux",
    xrandrIsFallback: preferred !== "xrandr",
    outputs: config.outputs.map((output) => ({
      id: output.id,
      connector: output.connector,
      enabled: output.enabled,
      mode: `${output.resolution.width}x${output.resolution.height}@${refreshDecimal(output.resolution)}`,
      position: { x: output.x, y: output.y },
      ...(output.display ? { display: output.display } : {}),
    })),
  };
}

export class DisplayConfigStore {
  constructor(pathname, {
    defaultBackend = "kms",
    platform = process.platform,
    faultInjector = null,
  } = {}) {
    if (!pathname) throw new DisplayConfigError("Display configuration path is required");
    this.platform = platform;
    this.pathApi = pathApiForPlatform(platform);
    this.pathname = resolvePlatformPath(pathname, { platform });
    this.backupPathname = `${this.pathname}.last-known-good.json`;
    this.commitPathname = `${this.pathname}.commit.json`;
    this.defaultBackend = defaultBackend;
    this.faultInjector = typeof faultInjector === "function" ? faultInjector : null;
    this.current = null;
    this.recovery = null;
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    const directory = this.pathApi.dirname(this.pathname);
    await mkdir(directory, { recursive: true });
    let marker = null;
    let markerError = null;
    try {
      marker = normalizeCommitMarker(JSON.parse(await readFile(this.commitPathname, "utf8")));
    } catch (error) {
      markerError = error;
    }
    let primaryError = null;
    try {
      this.current = normalizePersistedDisplayConfig(JSON.parse(await readFile(this.pathname, "utf8")), {
        defaultBackend: this.defaultBackend,
      });
    } catch (error) {
      primaryError = error;
    }

    if (primaryError) {
      let recovered;
      try {
        recovered = normalizePersistedDisplayConfig(
          JSON.parse(await readFile(this.backupPathname, "utf8")),
          { defaultBackend: this.defaultBackend },
        );
      } catch (backupError) {
        if (primaryError?.code === "ENOENT" && backupError?.code === "ENOENT" && markerError?.code === "ENOENT") {
          this.current = null;
          this.recovery = null;
          return null;
        }
        throw new DisplayConfigError(
          `Display configuration recovery failed: primary=${primaryError?.message || "unavailable"}; LKG=${backupError?.message || "unavailable"}`,
          "DISPLAY_CONFIG_RECOVERY_FAILED",
        );
      }

      // Publish the fail-closed recovery boundary before quarantining or
      // restoring the primary. If this process stops at any later boundary,
      // the next boot must not mistake the restored LKG for an uninterrupted
      // latest-intent commit—even when the LKG bytes happen to match the prior
      // committed marker (for example after the first save).
      const recoveredSha256 = displayConfigSha256(recovered);
      const recoveryMarker = {
        schemaVersion: DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION,
        status: "recovery-required",
        configSha256: recoveredSha256,
        intendedConfigSha256: marker?.status === "recovery-required"
          ? marker.intendedConfigSha256
          : marker?.configSha256 || null,
        updatedAt: recovered.updatedAt,
        reason: marker?.status === "recovery-required"
          ? marker.reason
          : "primary-restored-from-lkg",
        detectedAt: marker?.status === "recovery-required"
          ? marker.detectedAt
          : new Date().toISOString(),
      };
      await publishDurable(
        this.commitPathname,
        `${JSON.stringify(recoveryMarker, null, 2)}\n`,
        this.pathApi,
      );
      await this.faultInjector?.("after-recovery-marker");
      marker = recoveryMarker;
      markerError = null;

      if (primaryError?.code !== "ENOENT") {
        const quarantine = `${this.pathname}.corrupt-${Date.now()}-${process.pid}`;
        await rename(this.pathname, quarantine);
        await syncDirectory(directory);
      }
      const document = `${JSON.stringify(recovered, null, 2)}\n`;
      await publishDurable(this.pathname, document, this.pathApi);
      this.current = recovered;
    }

    const currentSha256 = displayConfigSha256(this.current);
    let recoveryReason = null;
    let intendedConfigSha256 = marker?.configSha256 || null;
    if (marker?.status === "recovery-required") recoveryReason = marker.reason;
    else if (primaryError) recoveryReason = "primary-restored-from-lkg";
    else if (markerError) recoveryReason = markerError.code === "ENOENT" ? "commit-marker-missing" : "commit-marker-invalid";
    else if (marker.status === "pending") recoveryReason = "commit-pending";
    else if (marker.configSha256 !== currentSha256 || marker.updatedAt !== this.current.updatedAt) {
      recoveryReason = "primary-digest-mismatch";
    }

    if (recoveryReason) {
      const detectedAt = marker?.status === "recovery-required"
        ? marker.detectedAt
        : new Date().toISOString();
      intendedConfigSha256 = marker?.status === "recovery-required"
        ? marker.intendedConfigSha256
        : intendedConfigSha256;
      const recoveryMarker = {
        schemaVersion: DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION,
        status: "recovery-required",
        configSha256: currentSha256,
        intendedConfigSha256,
        updatedAt: this.current.updatedAt,
        reason: recoveryReason,
        detectedAt,
      };
      await publishDurable(
        this.commitPathname,
        `${JSON.stringify(recoveryMarker, null, 2)}\n`,
        this.pathApi,
      );
      this.recovery = {
        status: "active",
        code: "DISPLAY_CONFIG_RECOVERY_REQUIRED",
        reason: recoveryReason,
        recoveredConfigSha256: currentSha256,
        intendedConfigSha256,
        detectedAt,
      };
    } else {
      this.recovery = null;
    }
    return this.snapshot();
  }

  async save(input) {
    const normalized = validateDisplayConfig(input, { defaultBackend: this.defaultBackend });
    const document = `${JSON.stringify(normalized, null, 2)}\n`;
    const operation = this.writeChain.then(async () => {
      const configSha256 = displayConfigSha256(normalized);
      // The LKG is published first. On the initial commit it contains the same
      // authorized intent; later commits retain the exact previous durable
      // configuration. No success is exposed until the primary publication
      // also completes.
      const prior = this.current || normalized;
      const previousConfigSha256 = this.current ? displayConfigSha256(this.current) : null;
      await publishDurable(
        this.commitPathname,
        `${JSON.stringify({
          schemaVersion: DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION,
          status: "pending",
          configSha256,
          previousConfigSha256,
          updatedAt: normalized.updatedAt,
        }, null, 2)}\n`,
        this.pathApi,
      );
      await publishDurable(
        this.backupPathname,
        `${JSON.stringify(prior, null, 2)}\n`,
        this.pathApi,
      );
      await publishDurable(this.pathname, document, this.pathApi);
      await publishDurable(
        this.commitPathname,
        `${JSON.stringify({
          schemaVersion: DISPLAY_CONFIG_COMMIT_SCHEMA_VERSION,
          status: "committed",
          configSha256,
          previousConfigSha256,
          updatedAt: normalized.updatedAt,
        }, null, 2)}\n`,
        this.pathApi,
      );
      this.current = normalized;
      this.recovery = null;
      return this.snapshot();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  snapshot() {
    return this.current ? JSON.parse(JSON.stringify(this.current)) : null;
  }

  recoverySnapshot() {
    return this.recovery ? JSON.parse(JSON.stringify(this.recovery)) : null;
  }

  async flush() {
    await this.writeChain;
  }
}

export const DISPLAY_LIMITS = Object.freeze({ maxOutputs: MAX_OUTPUTS, backends: [...BACKENDS] });
