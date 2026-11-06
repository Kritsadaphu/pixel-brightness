import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { DisplayConfigStore, createXrandrArgs, displayPlan, validateDisplayConfig } from "./display-config.mjs";
import { SafeCommandRunner } from "./safe-exec.mjs";
import {
  isAbsolutePlatformPath,
  joinPlatformPath,
  normalizePlatformServiceName,
  pathApiForPlatform,
  platformDefaults,
  resolvePlatformPath,
} from "./platform-contract.mjs";
import { HOST_ACTION_TYPE } from "../shared/protocol.mjs";

const HOST_ACTIONS = HOST_ACTION_TYPE;

const POWER_ACTIONS = new Set([HOST_ACTIONS.REBOOT_HOST, HOST_ACTIONS.SHUTDOWN_HOST]);
const DEFAULT_HOST_CONTROL = "/usr/local/sbin/pixel-brightness-hostctl";
const DEFAULT_XRANDR = "/usr/bin/xrandr";
const DEFAULT_JOURNALCTL = "/usr/bin/journalctl";

function cleanText(value, maximum = 4096) {
  let output = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    output += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return output.trim().slice(0, maximum);
}

function safePayload(input) {
  const value = input == null ? {} : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostActionError("Host action payload must be an object", "INVALID_ACTION");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 1024 * 1024) {
    throw new HostActionError("Host action payload exceeds 1 MiB", "INVALID_ACTION");
  }
  return value;
}

function secureTokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function resultIdentifier(commandId, sequence, actionId) {
  const digest = createHash("sha256").update(`${commandId}:${sequence}:${actionId || ""}`).digest("hex").slice(0, 24);
  return `host-result-${digest}`;
}

export function hostActionResultId(commandId, sequence, actionId) {
  return resultIdentifier(commandId, sequence, actionId);
}

export class HostActionError extends Error {
  constructor(message, code = "HOST_ACTION_FAILED", details = null) {
    super(message);
    this.name = "HostActionError";
    this.code = code;
    this.details = details;
  }
}

export class HostActionExecutor {
  constructor({
    nodeId,
    dataDir,
    displayConfigPath,
    diagnosticsDir,
    allowPowerActions = false,
    powerConfirmationToken = null,
    dryRun,
    allowXrandrFallback = false,
    hostControlCommand,
    xrandrCommand = DEFAULT_XRANDR,
    journalctlCommand = DEFAULT_JOURNALCTL,
    nodeService,
    displayEnvironment = {},
    platform = process.platform,
    runner,
    displayStore,
    restartRenderer,
    applyDisplayConfig,
    diagnosticsProvider,
    log = () => {},
  } = {}) {
    const defaults = platformDefaults({ platform, nodeId });
    hostControlCommand ||= defaults.hostControlCommand || DEFAULT_HOST_CONTROL;
    this.platform = platform;
    this.pathApi = pathApiForPlatform(platform);
    this.nodeId = String(nodeId || "pixel-node");
    this.dataDir = resolvePlatformPath(dataDir || process.cwd(), { platform });
    this.displayConfigPath = resolvePlatformPath(displayConfigPath || joinPlatformPath(platform, this.dataDir, "display-config.json"), { platform });
    this.diagnosticsDir = resolvePlatformPath(diagnosticsDir || joinPlatformPath(platform, this.dataDir, "diagnostics"), { platform });
    this.allowPowerActions = Boolean(allowPowerActions);
    this.powerConfirmationToken = powerConfirmationToken ? String(powerConfirmationToken) : null;
    this.dryRun = dryRun == null ? !["linux", "win32"].includes(platform) : Boolean(dryRun);
    this.allowXrandrFallback = Boolean(allowXrandrFallback);
    this.hostControlCommand = hostControlCommand;
    this.xrandrCommand = xrandrCommand;
    this.journalctlCommand = journalctlCommand;
    try {
      this.nodeService = normalizePlatformServiceName(nodeService, {
        platform,
        fallback: platform === "win32" ? "PixelBrightnessNode" : "pixel-brightness-node.service",
      });
    } catch (error) {
      throw new HostActionError(error.message, "INVALID_HOST_CONFIG");
    }
    this.displayEnvironment = displayEnvironment || {};
    const executables = [hostControlCommand, ...(platform === "linux" ? [xrandrCommand, journalctlCommand] : [])];
    for (const executable of executables) {
      if (!isAbsolutePlatformPath(executable, platform)) throw new HostActionError("Host executables must be absolute platform paths", "INVALID_HOST_CONFIG");
    }
    this.runner = runner || new SafeCommandRunner({
      allowedExecutables: executables,
      defaultTimeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
      platform,
    });
    this.displayStore = displayStore || new DisplayConfigStore(this.displayConfigPath, {
      defaultBackend: platform === "win32" ? "dxgi" : "kms",
      platform,
    });
    this.restartRenderer = restartRenderer;
    this.applyDisplayConfig = applyDisplayConfig;
    this.diagnosticsProvider = diagnosticsProvider;
    this.log = log;
  }

  async initialize() {
    await mkdir(this.diagnosticsDir, { recursive: true });
    await this.displayStore.initialize();
    return { displayConfig: this.displayStore.snapshot(), dryRun: this.dryRun };
  }

  async execute({ commandId, sequence = 0, action } = {}) {
    const startedAt = new Date().toISOString();
    const normalizedAction = action && typeof action === "object" ? action : {};
    const actionId = cleanText(normalizedAction.id || commandId || `sequence-${sequence}`, 256);
    const actionType = String(normalizedAction.type || "");
    const resultId = hostActionResultId(commandId || actionId, sequence, actionId);
    const base = {
      resultId,
      commandId: String(commandId || actionId),
      sequence: Number(sequence) || 0,
      actionId,
      actionType,
      startedAt,
    };
    try {
      if (!Object.values(HOST_ACTIONS).includes(actionType)) {
        throw new HostActionError(`Host action is not allowlisted: ${actionType || "(missing)"}`, "ACTION_NOT_ALLOWED");
      }
      const payload = safePayload(normalizedAction.payload);
      if (POWER_ACTIONS.has(actionType)) this.#authorizePowerAction(normalizedAction.confirmationToken);
      this.log("info", "host.action.started", { commandId: base.commandId, actionType, dryRun: this.dryRun });
      const result = await this.#dispatch(actionType, payload);
      const completed = {
        ...base,
        status: result?.dryRun ? "dry-run" : "succeeded",
        completedAt: new Date().toISOString(),
        result,
      };
      this.log("info", "host.action.completed", { commandId: base.commandId, actionType, status: completed.status });
      return completed;
    } catch (error) {
      const denied = ["POWER_ACTIONS_DISABLED", "CONFIRMATION_REQUIRED", "ACTION_NOT_ALLOWED"].includes(error.code);
      const failed = {
        ...base,
        status: denied ? "denied" : "failed",
        completedAt: new Date().toISOString(),
        error: {
          code: error.code || "HOST_ACTION_FAILED",
          message: cleanText(error.message),
          details: error.details || null,
        },
      };
      this.log("warn", "host.action.failed", { commandId: base.commandId, actionType, code: failed.error.code });
      return failed;
    }
  }

  #authorizePowerAction(actualToken) {
    if (!this.allowPowerActions) {
      throw new HostActionError("Power actions are disabled on this node", "POWER_ACTIONS_DISABLED");
    }
    if (!secureTokenMatches(actualToken, this.powerConfirmationToken)) {
      throw new HostActionError("A valid node-local confirmation token is required", "CONFIRMATION_REQUIRED");
    }
  }

  async #dispatch(type, payload) {
    switch (type) {
      case HOST_ACTIONS.APPLY_DISPLAY_CONFIG:
        return this.#applyDisplayConfig(payload);
      case HOST_ACTIONS.RESTART_RENDERER:
        return this.#restartRenderer();
      case HOST_ACTIONS.RESTART_NODE:
        return this.#hostControl("restart-node", ["--service", this.nodeService, "--delay-ms", "3000"]);
      case HOST_ACTIONS.REBOOT_HOST:
        return this.#hostControl("reboot", ["--delay-ms", "3000"]);
      case HOST_ACTIONS.SHUTDOWN_HOST:
        return this.#hostControl("shutdown", ["--delay-ms", "3000"]);
      case HOST_ACTIONS.COLLECT_DIAGNOSTICS:
        return this.#collectDiagnostics(payload);
      default:
        throw new HostActionError("Host action is not allowlisted", "ACTION_NOT_ALLOWED");
    }
  }

  async #hostControl(action, args) {
    const invocation = { executable: this.hostControlCommand, args: [action, ...args] };
    if (this.dryRun) return { dryRun: true, scheduled: false, invocation };
    const output = await this.runner.run(invocation.executable, invocation.args, { timeoutMs: 15_000 });
    return {
      scheduled: true,
      invocation,
      stdout: cleanText(output.stdout),
      durationMs: output.durationMs,
    };
  }

  async #restartRenderer() {
    if (this.dryRun) return { dryRun: true, internal: true, operation: "restart-renderer" };
    if (typeof this.restartRenderer !== "function") {
      throw new HostActionError("Internal renderer restart callback is unavailable", "RENDERER_CONTROL_UNAVAILABLE");
    }
    const diagnostics = await this.restartRenderer();
    return { internal: true, restarted: true, renderer: diagnostics || null };
  }

  async #applyDisplayConfig(payload) {
    const normalized = validateDisplayConfig(payload, {
      defaultBackend: this.platform === "win32" ? "dxgi" : "kms",
    });
    const plan = displayPlan(normalized, {
      platform: this.platform,
      allowXrandrFallback: this.allowXrandrFallback,
    });
    if (this.dryRun) return { dryRun: true, persisted: false, plan };
    await this.displayStore.save(normalized);
    if (plan.preferredBackend === "dxgi") {
      if (this.platform !== "win32") {
        throw new HostActionError("DXGI display application is Windows-only", "DXGI_UNAVAILABLE");
      }
      if (typeof this.applyDisplayConfig !== "function") {
        throw new HostActionError("Native DXGI renderer control is unavailable", "DXGI_CONTROL_UNAVAILABLE", {
          path: this.displayConfigPath,
        });
      }
      const applied = await this.applyDisplayConfig(normalized);
      return {
        persisted: true,
        path: this.displayConfigPath,
        backend: "dxgi",
        plan,
        applied: applied || null,
      };
    }
    if (plan.preferredBackend === "xrandr") {
      const applied = await this.#applyXrandr(normalized);
      return { persisted: true, path: this.displayConfigPath, backend: "xrandr", plan, applied };
    }
    try {
      const output = await this.runner.run(this.hostControlCommand, [
        "apply-display-config",
        "--backend", "kms",
        "--config", this.displayConfigPath,
      ], { timeoutMs: 30_000 });
      return {
        persisted: true,
        path: this.displayConfigPath,
        backend: "kms",
        plan,
        stdout: cleanText(output.stdout),
        durationMs: output.durationMs,
      };
    } catch (error) {
      if (normalized.backend !== "auto" || !this.allowXrandrFallback) {
        throw new HostActionError("KMS display application failed after configuration was persisted", "KMS_APPLY_FAILED", {
          path: this.displayConfigPath,
          cause: error.code || "EXEC_FAILED",
          xrandrFallback: false,
        });
      }
      const applied = await this.#applyXrandr(normalized);
      return {
        persisted: true,
        path: this.displayConfigPath,
        backend: "xrandr",
        fallbackFrom: "kms",
        plan,
        applied,
      };
    }
  }

  async #applyXrandr(config) {
    if (this.platform !== "linux") throw new HostActionError("Xrandr application is Linux-only", "XRANDR_UNAVAILABLE");
    const args = createXrandrArgs(config);
    const output = await this.runner.run(this.xrandrCommand, args, {
      timeoutMs: 20_000,
      env: this.displayEnvironment,
    });
    return { args, stdout: cleanText(output.stdout), durationMs: output.durationMs };
  }

  async #collectDiagnostics(payload) {
    const providerData = typeof this.diagnosticsProvider === "function"
      ? await this.diagnosticsProvider(payload)
      : {};
    let journal = null;
    try {
      if (this.platform !== "linux") throw Object.assign(new Error("journalctl is Linux-only"), { code: "PLATFORM_UNAVAILABLE" });
      const output = await this.runner.run(this.journalctlCommand, [
        "--unit", this.nodeService,
        "--no-pager",
        "--lines", "500",
        "--output", "short-iso",
      ], { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 });
      journal = output.stdout.slice(0, 2 * 1024 * 1024);
    } catch (error) {
      journal = { unavailable: true, code: error.code || "JOURNAL_UNAVAILABLE" };
    }
    const collectedAt = new Date().toISOString();
    const bundle = {
      schemaVersion: 2,
      nodeId: this.nodeId,
      collectedAt,
      host: providerData,
      displayConfig: this.displayStore.snapshot(),
      journal,
    };
    const document = `${JSON.stringify(bundle, null, 2)}\n`;
    const digest = createHash("sha256").update(document).digest("hex");
    const pathname = joinPlatformPath(this.platform, this.diagnosticsDir, `diagnostics-${Date.now()}-${digest.slice(0, 12)}.json`);
    await mkdir(this.pathApi.dirname(pathname), { recursive: true });
    const temporary = `${pathname}.${process.pid}.tmp`;
    await writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, pathname);
    return { path: pathname, sha256: digest, bytes: Buffer.byteLength(document), collectedAt };
  }
}

export { HOST_ACTIONS, POWER_ACTIONS };
