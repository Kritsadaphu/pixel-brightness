import { createHash } from "node:crypto";
import { copyFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { joinPlatformPath, pathApiForPlatform } from "./platform-contract.mjs";
import {
  WindowsRendererIpcClient,
  normalizeWindowsRendererConfig,
} from "./windows-renderer-contract.mjs";
import { normalizeOutputConfig } from "../shared/mapping.mjs";
import { normalizeNativePatternCommand } from "../shared/protocol.mjs";

const MERGED_FIELDS = [
  "resolution",
  "sourceViewport",
  "overlap",
  "warp",
  "blend",
  "blackUniformity",
  "mask",
  "color",
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ACTIVE_CORRECTION_BINDING_KEYS = [
  "algorithm",
  "configSha256",
  "fingerprint",
  "outputs",
  "schemaVersion",
];
const OUTPUT_CORRECTION_BINDING_KEYS = ["artifacts", "id", "processingBypass"];
const CORRECTION_ARTIFACT_KEYS = [
  "blackMapSha256",
  "blendMapSha256",
  "colorLutSha256",
  "maskSha256",
  "warpMeshSha256",
];

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function canonicalConfigSha256(config) {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

async function syncRegularFile(pathname) {
  // Windows FlushFileBuffers requires a writable handle; r+ never truncates.
  const handle = await open(pathname, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync through Node on every supported
    // runtime. File contents are still flushed, and the launcher retains a
    // separately flushed LKG. Unexpected I/O failures remain fatal.
    if (!["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function exactObject(value, field, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(field + " must contain exactly " + expected.join(", "));
  }
  return value;
}

function sha256Digest(value, field, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const digest = String(value || "").toLowerCase();
  if (!SHA256_PATTERN.test(digest)) throw new Error(field + " must be a lowercase SHA-256 digest");
  return digest;
}

function normalizeCorrectionArtifacts(value, field) {
  const artifacts = exactObject(value, field, CORRECTION_ARTIFACT_KEYS);
  return {
    warpMeshSha256: sha256Digest(artifacts.warpMeshSha256, field + ".warpMeshSha256"),
    blendMapSha256: sha256Digest(artifacts.blendMapSha256, field + ".blendMapSha256", { nullable: true }),
    blackMapSha256: sha256Digest(artifacts.blackMapSha256, field + ".blackMapSha256", { nullable: true }),
    maskSha256: sha256Digest(artifacts.maskSha256, field + ".maskSha256", { nullable: true }),
    colorLutSha256: sha256Digest(artifacts.colorLutSha256, field + ".colorLutSha256", { nullable: true }),
  };
}

export function normalizeActiveCorrectionBinding(value, field = "activeCorrectionBinding") {
  const binding = exactObject(value, field, ACTIVE_CORRECTION_BINDING_KEYS);
  if (binding.schemaVersion !== 1) throw new Error(field + ".schemaVersion must be 1");
  if (binding.algorithm !== "sha256") throw new Error(field + ".algorithm must be sha256");
  if (!Array.isArray(binding.outputs) || binding.outputs.length < 1 || binding.outputs.length > 32) {
    throw new Error(field + ".outputs must contain 1 to 32 active outputs");
  }
  const ids = new Set();
  const outputs = binding.outputs.map((candidate, index) => {
    const outputField = field + ".outputs[" + index + "]";
    const output = exactObject(candidate, outputField, OUTPUT_CORRECTION_BINDING_KEYS);
    const id = String(output.id || "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || ids.has(id)) {
      throw new Error(outputField + ".id must be a unique renderer output id");
    }
    ids.add(id);
    if (typeof output.processingBypass !== "boolean") {
      throw new Error(outputField + ".processingBypass must be boolean");
    }
    return {
      id,
      processingBypass: output.processingBypass,
      artifacts: normalizeCorrectionArtifacts(output.artifacts, outputField + ".artifacts"),
    };
  });
  const normalized = {
    schemaVersion: 1,
    algorithm: "sha256",
    configSha256: sha256Digest(binding.configSha256, field + ".configSha256"),
    fingerprint: sha256Digest(binding.fingerprint, field + ".fingerprint"),
    outputs,
  };
  const fingerprintPayload = { ...normalized };
  delete fingerprintPayload.fingerprint;
  const computed = createHash("sha256").update(canonicalJson(fingerprintPayload)).digest("hex");
  if (computed !== normalized.fingerprint) {
    throw new Error(field + ".fingerprint does not bind its config and observed artifact digests");
  }
  return normalized;
}

function correctionBindingsMatch(left, right) {
  return left != null && right != null && canonicalJson(left) === canonicalJson(right);
}

function requireBindingOutputIdentity(binding, config) {
  const expected = config.outputs
    .filter((output) => output.enabled !== false)
    .map((output) => ({ id: String(output.id), processingBypass: output.processing?.bypass === true }));
  if (binding.outputs.length !== expected.length || binding.outputs.some((output, index) => (
    output.id !== expected[index].id
      || output.processingBypass !== expected[index].processingBypass
  ))) {
    throw new Error("Native correction binding output identity does not match the applied config");
  }
}

function requireStatusBindingConsistency(binding, nativeOutputs) {
  if (!Array.isArray(nativeOutputs) || nativeOutputs.length !== binding.outputs.length) {
    throw new Error("Native output telemetry does not match the active correction binding");
  }
  const byId = new Map(nativeOutputs.map((output) => [String(output?.id || ""), output]));
  for (const bound of binding.outputs) {
    const output = byId.get(bound.id);
    if (!output || output.processingBypass !== bound.processingBypass) {
      throw new Error("Native output identity differs from the active correction binding");
    }
    const artifacts = normalizeCorrectionArtifacts(
      output.correctionBinding,
      "get-status.outputs[" + bound.id + "].correctionBinding",
    );
    if (canonicalJson(artifacts) !== canonicalJson(bound.artifacts)) {
      throw new Error("Native output artifact telemetry differs from the active correction binding");
    }
  }
}

function mergePhysicalAndMapped(physical, mapped) {
  const merged = { ...(physical || {}), ...(mapped || {}) };
  for (const key of MERGED_FIELDS) {
    merged[key] = { ...(physical?.[key] || {}), ...(mapped?.[key] || {}) };
  }
  merged.connector = physical?.connector || mapped?.connector;
  // The local binder owns the stable DXGI/EDID selector. A project may carry
  // an older selector from another host or a previous hot-plug and must never
  // override the physical node configuration.
  merged.display = physical?.display || mapped?.display;
  return merged;
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function optionalPositiveInteger(value, { maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= maximum ? number : null;
}

function optionalPositiveNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function nullableMetricSum(outputs, field) {
  const values = outputs.map((output) => output.metrics[field]);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

function nativeDisplayDiagnostics(native, resolution) {
  const submissions = native?.presentSubmissions && typeof native.presentSubmissions === "object"
    && !Array.isArray(native.presentSubmissions)
    ? native.presentSubmissions
    : {};
  const timing = native?.displayTiming && typeof native.displayTiming === "object"
    && !Array.isArray(native.displayTiming)
    ? native.displayTiming
    : {};
  const sampleAgeMilliseconds = optionalPositiveNumber(timing.sampleAgeMilliseconds);
  const presentCount = optionalPositiveInteger(timing.presentCount, { maximum: 0xffff_ffff });
  const presentRefreshCount = optionalPositiveInteger(timing.presentRefreshCount, { maximum: 0xffff_ffff });
  const syncRefreshCount = optionalPositiveInteger(timing.syncRefreshCount, { maximum: 0xffff_ffff });
  const syncQpcTime = optionalPositiveInteger(timing.syncQpcTime);
  const droppedPresents = optionalPositiveInteger(timing.droppedPresents);
  const repeatedRefreshes = optionalPositiveInteger(timing.repeatedRefreshes);
  const latePresentEvents = optionalPositiveInteger(timing.latePresentEvents);
  const maximumLatenessRefreshes = optionalPositiveInteger(timing.maximumLatenessRefreshes, {
    maximum: 0xffff_ffff,
  });
  const complete = timing.source === "IDXGISwapChain::GetFrameStatistics"
    && timing.syncInterval === 1
    && timing.cadenceMetricsApplicable === true
    && timing.phaseProof === false
    && timing.multiMonitorReliability === "platform-dependent"
    && timing.available === true
    && timing.status === "available"
    && native?.occluded === false
    && presentCount != null
    && presentRefreshCount != null
    && syncRefreshCount != null
    && syncQpcTime != null
    && sampleAgeMilliseconds != null
    && droppedPresents != null
    && repeatedRefreshes != null
    && latePresentEvents != null
    && maximumLatenessRefreshes != null;
  // Native writes at a one-second cadence by default. Older timing evidence is
  // not silently converted to zero physical faults in Node diagnostics.
  const fresh = complete && sampleAgeMilliseconds <= 1_000;
  const frameDurationNs = Number(resolution?.refreshNum) > 0
    ? (1_000_000_000 * Number(resolution?.refreshDen || 1)) / Number(resolution.refreshNum)
    : null;
  const maximumLatenessNs = fresh && Number.isFinite(frameDurationNs)
    ? String(Math.max(0, Math.round(maximumLatenessRefreshes * frameDurationNs)))
    : null;
  return {
    submissions: {
      attempted: optionalPositiveInteger(submissions.attempted),
      accepted: optionalPositiveInteger(submissions.accepted),
      occluded: optionalPositiveInteger(submissions.occluded),
      otherStatuses: optionalPositiveInteger(submissions.otherStatuses),
      failures: optionalPositiveInteger(submissions.failures),
      lastSubmittedPresentId: optionalPositiveInteger(submissions.lastSubmittedPresentId, {
        maximum: 0xffff_ffff,
      }),
      lastSubmissionQpc: optionalPositiveInteger(submissions.lastSubmissionQpc),
    },
    displayTiming: {
      source: timing.source == null ? null : String(timing.source),
      syncInterval: optionalPositiveInteger(timing.syncInterval, { maximum: 4 }),
      cadenceMetricsApplicable: timing.cadenceMetricsApplicable === true,
      phaseProof: timing.phaseProof === true,
      multiMonitorReliability: timing.multiMonitorReliability == null
        ? null
        : String(timing.multiMonitorReliability),
      occluded: native?.occluded === true,
      available: complete,
      fresh,
      status: timing.status == null ? "missing" : String(timing.status),
      sampleAgeMilliseconds,
      sampleSequence: optionalPositiveInteger(timing.sampleSequence),
      discontinuities: optionalPositiveInteger(timing.discontinuities),
      presentCount,
      presentRefreshCount,
      syncRefreshCount,
      syncQpcTime,
      droppedPresents: fresh ? droppedPresents : null,
      repeatedRefreshes: fresh ? repeatedRefreshes : null,
      latePresentEvents: fresh ? latePresentEvents : null,
      maximumLatenessRefreshes: fresh ? maximumLatenessRefreshes : null,
      maximumLatenessNs,
    },
  };
}

function normalizeAdapterLuid(value, field = "adapterLuid") {
  if (value == null || value === "") return null;
  const luid = String(value).trim();
  if (!/^[0-9a-f]{8}:[0-9a-f]{8}$/i.test(luid)) {
    throw new Error(`${field} must use 8-hex:8-hex form`);
  }
  return luid.toUpperCase();
}

function physicalAdapterLuid(outputs) {
  const luids = new Set(outputs.flatMap((output, index) => {
    const luid = output?.display?.adapterLuid;
    return luid ? [normalizeAdapterLuid(luid, `physicalOutputs[${index}].display.adapterLuid`)] : [];
  }));
  if (luids.size > 1) {
    throw new Error("Windows physical outputs must use one GPU adapter LUID");
  }
  return luids.values().next().value || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NativeOutputProxy {
  constructor(output) {
    this.output = output;
    this.mode = "content";
  }

  async apply(output) {
    this.output = output;
  }

  resetCadence() {}

  diagnostics(native = {}) {
    const display = nativeDisplayDiagnostics(native, this.output.resolution);
    return {
      id: this.output.id,
      name: this.output.name,
      connector: this.output.connector,
      enabled: this.output.enabled,
      backend: "windows-dxgi-native",
      mode: native.pattern || this.mode,
      blank: native.blank === true,
      active: native.active === true,
      occluded: native.occluded === true,
      resolution: this.output.resolution,
      mesh: {
        columns: this.output.warp.columns,
        rows: this.output.warp.rows,
        points: this.output.warp.points.length,
      },
      pipeline: {
        crop: this.output.sourceViewport,
        overlap: this.output.overlap,
        blend: this.output.blend,
        blackUniformity: {
          enabled: this.output.blackUniformity.enabled,
          lift: this.output.blackUniformity.lift,
          mapLoaded: Boolean(this.output.blackUniformity.map),
        },
        mask: {
          enabled: this.output.mask.enabled,
          mapLoaded: Boolean(this.output.mask.map),
          points: this.output.mask.path?.length || 0,
          softness: this.output.mask.softness,
        },
        color: {
          gain: this.output.color.gain,
          offset: this.output.color.offset,
          gamma: this.output.color.gamma,
          lutLoaded: Boolean(this.output.color.lut),
        },
      },
      metrics: {
        // framesRendered is retained as the generic engine counter, but for
        // this backend it is explicitly the accepted DXGI submission count.
        framesRendered: display.submissions.accepted,
        presentSubmissions: display.submissions.accepted,
        droppedFrames: display.displayTiming.droppedPresents,
        repeatedFrames: display.displayTiming.repeatedRefreshes,
        lateFrames: display.displayTiming.latePresentEvents,
        lastFrame: display.displayTiming.presentCount == null
          ? null
          : String(display.displayTiming.presentCount),
        lastSubmissionQpc: display.submissions.lastSubmissionQpc == null
          ? null
          : String(display.submissions.lastSubmissionQpc),
        lastSignature: null,
        maximumLatenessNs: display.displayTiming.maximumLatenessNs,
        renderTimeNs: native.renderMilliseconds == null
          ? null
          : String(Math.max(0, Math.round(Number(native.renderMilliseconds) * 1_000_000))),
      },
      presentSubmissions: display.submissions,
      displayTiming: display.displayTiming,
      native: native || null,
    };
  }
}

/**
 * One node-level bridge to the one native D3D11 renderer process. The native
 * process owns Spout reception, v-sync and all swapchain cadence; this class
 * never attempts to present a JavaScript frame.
 */
export class WindowsNativeRenderEngine {
  constructor({
    nodeId,
    physicalOutputs = [],
    compositionSource,
    rendererPipe,
    rendererConfigPath,
    rendererBootToken = null,
    rendererIpcTimeoutMs = 30_000,
    rendererStartupMs,
    rendererTelemetryPath,
    statusPollMs = 1_000,
    statusFreshnessMs = null,
    adapterLuid = null,
    platform = "win32",
    client,
    log = () => {},
  } = {}) {
    this.nodeId = String(nodeId || "pixel-node");
    this.physicalOutputs = physicalOutputs;
    this.compositionSource = compositionSource;
    this.rendererPipe = rendererPipe;
    this.rendererConfigPath = rendererConfigPath;
    this.rendererBootToken = rendererBootToken == null ? null : String(rendererBootToken);
    if (this.rendererBootToken != null
      && !/^[A-Za-z0-9_-]{43,128}$/.test(this.rendererBootToken)) {
      throw new Error("rendererBootToken must be 43-128 base64url characters");
    }
    this.rendererTelemetryPath = rendererTelemetryPath;
    this.rendererStartupMs = Math.max(500, Math.min(120_000, Number(rendererStartupMs
      ?? compositionSource?.startupGraceMs
      ?? 10_000) || 10_000));
    this.statusPollMs = Math.max(25, Math.min(30_000, Number(statusPollMs) || 1_000));
    this.statusFreshnessMs = Math.max(
      this.statusPollMs * 2,
      Math.min(120_000, Number(statusFreshnessMs) || Math.max(3_000, this.statusPollMs * 3)),
    );
    const configuredAdapterLuid = normalizeAdapterLuid(adapterLuid);
    const outputAdapterLuid = physicalAdapterLuid(physicalOutputs);
    if (configuredAdapterLuid && outputAdapterLuid && configuredAdapterLuid !== outputAdapterLuid) {
      throw new Error("adapterLuid does not match the physical output GPU adapter LUID");
    }
    this.adapterLuid = configuredAdapterLuid || outputAdapterLuid;
    this.platform = platform;
    this.pathApi = pathApiForPlatform(platform);
    this.client = client || new WindowsRendererIpcClient({
      nodeId: this.nodeId,
      pipeName: rendererPipe,
      timeoutMs: rendererIpcTimeoutMs,
    });
    this.log = log;
    this.adapters = new Map();
    this.project = null;
    this.preparedAssets = [];
    this.hello = null;
    this.nativeStatus = null;
    this.nativeStatusUpdatedAt = null;
    this.nativeRevision = 0;
    this.projectRevision = null;
    this.appliedCorrectionBinding = null;
    this.observedCorrectionBinding = null;
    this.correctionBindingMatches = null;
    this.configAuthorityValid = false;
    this.lastConfig = null;
    this.lastError = null;
    this.ready = false;
    this.connected = false;
    this.stopped = false;
    this.bootBlackReleased = false;
    this.bootBlackAuthorizationDiscarded = false;
    this.ignoredJsFrameRequests = 0;
    this.externalCadence = true;
    this.requestChain = Promise.resolve();
    this.statusTimer = null;
    this.statusPollInFlight = null;
  }

  #request(type, payload = {}, options = {}) {
    const operation = this.requestChain.then(() => this.client.request(type, payload, options));
    this.requestChain = operation.catch(() => {});
    return operation;
  }

  #authenticatedMutation(payloadField, payload) {
    if (this.rendererBootToken) {
      return {
        authorizationToken: this.rendererBootToken,
        [payloadField]: payload,
      };
    }
    if (this.hello?.bootBlackLock?.lifetimeMutationAuthentication === true) {
      throw new Error("Native renderer lifetime mutation authorization is unavailable");
    }
    // Compatibility for injected/legacy test clients that do not advertise
    // the production lifetime-authentication contract. The shipped renderer
    // advertises it and refuses every raw mutating request.
    return payload;
  }

  #startStatusMonitor() {
    if (this.statusTimer || this.stopped) return;
    this.statusTimer = setInterval(() => {
      void this.#pollNativeStatus();
    }, this.statusPollMs);
    this.statusTimer.unref?.();
  }

  #stopStatusMonitor() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  async #pollNativeStatus() {
    if (this.stopped || this.statusPollInFlight) return this.statusPollInFlight;
    const operation = (async () => {
      if (!this.hello) {
        const hello = await this.#request("hello");
        this.hello = hello.payload;
      }
      return this.refreshStatus();
    })();
    this.statusPollInFlight = operation;
    try {
      return await operation;
    } catch {
      return null;
    } finally {
      if (this.statusPollInFlight === operation) this.statusPollInFlight = null;
    }
  }

  async initialize() {
    this.connected = false;
    this.ready = false;
    const deadline = Date.now() + this.rendererStartupMs;
    let lastError;
    do {
      try {
        const hello = await this.#request("hello");
        this.hello = hello.payload;
        await this.refreshStatus({ expectedCorrectionBinding: null });
        this.connected = true;
        this.stopped = false;
        this.lastError = null;
        this.#startStatusMonitor();
        this.log("info", "render.native.connected", {
          backend: "windows-dxgi-native",
          pipe: this.rendererPipe,
          revision: this.nativeRevision,
        });
        return this.diagnostics();
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
      }
    } while (Date.now() < deadline);
    this.hello = null;
    this.connected = false;
    this.ready = false;
    this.nativeStatus = null;
    this.nativeStatusUpdatedAt = null;
    this.observedCorrectionBinding = null;
    this.correctionBindingMatches = null;
    this.lastError = lastError?.message || "Native renderer did not become ready";
    throw lastError || new Error(this.lastError);
  }

  resolveOutputs(project) {
    const projectOutputs = project?.outputs || [];
    const consumed = new Set();
    const resolved = [];
    for (const physical of this.physicalOutputs) {
      const mapped = projectOutputs.find((output) => output.id === physical.id)
        || projectOutputs.find((output) => output.connector === physical.connector);
      if (mapped && mapped.nodeId && mapped.nodeId !== this.nodeId) continue;
      if (mapped) consumed.add(mapped.id);
      resolved.push(normalizeOutputConfig(mergePhysicalAndMapped(physical, mapped || { id: physical.id })));
    }
    for (const mapped of projectOutputs) {
      if (mapped.nodeId === this.nodeId && !consumed.has(mapped.id)) {
        resolved.push(normalizeOutputConfig(mapped));
      }
    }
    return resolved;
  }

  #nextRevision(projectRevision) {
    return Math.max(1, positiveInteger(projectRevision, 1), this.nativeRevision + 1);
  }

  async #persistConfig(config) {
    if (!this.rendererConfigPath) return;
    const directory = this.pathApi.dirname(this.rendererConfigPath);
    await mkdir(directory, { recursive: true });
    const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const temporary = `${this.rendererConfigPath}.${suffix}.tmp`;
    const backupPath = `${this.rendererConfigPath}.last-known-good.json`;
    const backupTemporary = `${backupPath}.${suffix}.tmp`;
    const document = `${JSON.stringify(config, null, 2)}\n`;
    try {
      await writeFile(temporary, document, { encoding: "utf8", mode: 0o600 });
      await syncRegularFile(temporary);
      try {
        await copyFile(this.rendererConfigPath, backupTemporary);
        await syncRegularFile(backupTemporary);
        await rename(backupTemporary, backupPath);
        await syncDirectory(directory);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await rm(backupTemporary, { force: true }).catch(() => {});
      }
      await rename(temporary, this.rendererConfigPath);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(backupTemporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  createNativeConfig(project, { revision = this.#nextRevision(project?.revision) } = {}) {
    const outputs = this.resolveOutputs(project);
    const telemetryPath = this.rendererTelemetryPath
      || (this.rendererConfigPath
        ? joinPlatformPath(this.platform, this.pathApi.dirname(this.rendererConfigPath), "renderer-status.json")
        : null);
    return normalizeWindowsRendererConfig({
      revision,
      nodeId: this.nodeId,
      adapterLuid: this.adapterLuid,
      pipeName: this.rendererPipe,
      vsync: true,
      topmost: true,
      telemetry: {
        ...(telemetryPath ? { path: telemetryPath } : {}),
        intervalMs: 1_000,
      },
      canvas: project.canvas,
      compositionSource: project.compositionSource || this.compositionSource,
      outputs,
    });
  }

  #applyConfigPayload(config) {
    if (this.rendererBootToken) {
      if (this.nativeStatus?.bootBlackLocked === true
        && this.bootBlackAuthorizationDiscarded) {
        throw new Error("Native boot-black configuration authorization is unavailable");
      }
      if (!this.bootBlackReleased && this.nativeStatus?.bootBlackLocked !== true) {
        throw new Error("Native renderer did not prove a fresh locked boot-black state before config");
      }
      return {
        authorizationToken: this.rendererBootToken,
        config,
      };
    }
    if (this.nativeStatus?.bootBlackLocked === true
      || this.hello?.bootBlackLock?.lifetimeMutationAuthentication === true) {
      throw new Error("Native renderer lifetime mutation authorization is unavailable");
    }
    return config;
  }

  async #failClosedAfterConfigApply(error) {
    this.configAuthorityValid = false;
    this.ready = false;
    let enforcementError = null;
    try {
      const blank = await this.#request(
        "blank",
        this.#authenticatedMutation("blank", { enabled: true }),
      );
      if (blank.payload?.blank !== true) {
        throw new Error("Native renderer did not acknowledge global black after config failure");
      }
      await this.refreshStatus({ expectedCorrectionBinding: null });
      const outputs = this.nativeStatus?.outputs;
      if (!Array.isArray(outputs) || outputs.length < 1
        || outputs.some((output) => output?.blank !== true)) {
        throw new Error("Native renderer telemetry did not prove every output black after config failure");
      }
      for (const adapter of this.adapters.values()) adapter.mode = "black";
    } catch (blankError) {
      enforcementError = blankError;
      // A renderer whose black state cannot be freshly proven is no longer a
      // controllable show process. Ask it to terminate so the supervisor can
      // restart the entire Show stack behind a new boot-black latch.
      if (this.rendererBootToken) {
        await this.#request("shutdown", {
          authorizationToken: this.rendererBootToken,
        }).catch(() => {});
      }
      this.hello = null;
      this.connected = false;
      this.nativeStatus = null;
      this.nativeStatusUpdatedAt = null;
    }
    this.projectRevision = null;
    this.project = null;
    this.lastConfig = null;
    this.appliedCorrectionBinding = null;
    this.observedCorrectionBinding = null;
    this.correctionBindingMatches = false;
    this.ready = false;
    const originalMessage = error?.message || "Native correction binding could not be verified";
    this.lastError = enforcementError
      ? `${originalMessage}; fail-closed black could not be proven: ${enforcementError.message}`
      : originalMessage;
    if (!enforcementError) return error;
    const failure = new Error(this.lastError, { cause: error });
    failure.code = "NATIVE_CONFIG_FAIL_CLOSED_UNPROVEN";
    return failure;
  }

  async configure(project) {
    if (!this.hello) await this.initialize();
    // Do not advertise the preceding revision while an apply may have changed
    // native state. Authority becomes valid again only after receipt, fresh
    // status and renderer-config durability all complete.
    this.configAuthorityValid = false;
    this.ready = false;
    let config = this.createNativeConfig(project);
    let response;
    try {
      response = await this.#request("apply-config", this.#applyConfigPayload(config));
    } catch (firstError) {
      // A renderer may have advanced its revision while the Node was offline.
      // Refresh once and retry with a strictly newer native revision.
      try {
        await this.refreshStatus().catch(() => {});
        config = this.createNativeConfig(project, { revision: this.#nextRevision(project?.revision) });
        response = await this.#request("apply-config", this.#applyConfigPayload(config));
      } catch (retryError) {
        throw await this.#failClosedAfterConfigApply(retryError || firstError);
      }
    }
    let candidateBinding;
    try {
      const responseRevision = positiveInteger(response.payload?.revision);
      if (responseRevision !== config.revision) {
        throw new Error("Native renderer acknowledged a different config revision");
      }
      candidateBinding = normalizeActiveCorrectionBinding(
        response.payload?.activeCorrectionBinding,
        "apply-config.activeCorrectionBinding",
      );
      const expectedConfigSha256 = canonicalConfigSha256(config);
      if (candidateBinding.configSha256 !== expectedConfigSha256) {
        throw new Error("Native correction binding config digest does not match the exact normalized config sent");
      }
      requireBindingOutputIdentity(candidateBinding, config);
      await this.refreshStatus({ expectedCorrectionBinding: candidateBinding });
      if (positiveInteger(this.nativeStatus?.revision) !== responseRevision) {
        throw new Error("Native renderer telemetry revision does not match apply-config");
      }
      this.nativeRevision = responseRevision;
      await this.#persistConfig(config);
    } catch (error) {
      // Once apply-config returned success, a missing or inconsistent receipt
      // means the native process may have changed while Node cannot prove what
      // is active. Prove global black immediately or terminate the renderer;
      // only then discard every project claim and stay non-ready.
      throw await this.#failClosedAfterConfigApply(error);
    }
    this.appliedCorrectionBinding = candidateBinding;
    this.correctionBindingMatches = true;
    this.projectRevision = positiveInteger(project.revision, 1);
    this.project = project;
    this.lastConfig = config;
    this.lastError = null;
    const wanted = new Set(config.outputs.map((output) => output.id));
    for (const id of this.adapters.keys()) if (!wanted.has(id)) this.adapters.delete(id);
    const resolved = this.resolveOutputs(project);
    for (const output of resolved) {
      const existing = this.adapters.get(output.id);
      if (existing) await existing.apply(output);
      else this.adapters.set(output.id, new NativeOutputProxy(output));
    }
    this.configAuthorityValid = true;
    const nativeState = String(this.nativeStatus?.state || "").toLowerCase();
    const sourceState = String(this.nativeStatus?.compositionSource?.state || "").toLowerCase();
    this.ready = this.correctionBindingMatches === true
      && nativeState === "running"
      && sourceState === "connected"
      && this.nativeStatus?.bootBlackLocked === false;
    this.log("info", "render.native.configured", {
      projectRevision: this.projectRevision,
      nativeRevision: this.nativeRevision,
      activeCorrectionFingerprint: candidateBinding.fingerprint,
      outputs: config.outputs.map((output) => output.id),
    });
    return this.diagnostics();
  }

  async prepare({ assets = [] } = {}) {
    this.preparedAssets = assets.map((asset) => asset.sha256).filter(Boolean);
    return this.diagnostics();
  }

  // Deliberate no-op: the D3D11 renderer owns the present loop and v-sync.
  renderFrame() {
    this.ignoredJsFrameRequests += 1;
    return [];
  }

  async applyOutput(output) {
    if (!output?.id) throw new Error("Output id is required");
    if (!this.project) throw new Error("A project must be configured before applying an output");
    const id = String(output.id);
    const existing = this.project.outputs.find((candidate) => candidate.id === id)
      || this.physicalOutputs.find((candidate) => candidate.id === id)
      || { id };
    const normalized = normalizeOutputConfig(mergePhysicalAndMapped(existing, output));
    const outputs = [...this.project.outputs];
    const index = outputs.findIndex((candidate) => candidate.id === id);
    if (index >= 0) outputs[index] = normalized;
    else outputs.push(normalized);
    return this.configure({ ...this.project, revision: positiveInteger(this.project.revision, 1), outputs });
  }

  async applyDisplayConfig(displayConfig) {
    const byId = new Map((displayConfig?.outputs || []).map((output) => [String(output.id), output]));
    this.physicalOutputs = this.physicalOutputs.map((physical) => {
      const update = byId.get(String(physical.id));
      return update ? mergePhysicalAndMapped(physical, update) : physical;
    });
    if (this.project) await this.configure(this.project);
    return { applied: true, nativeRevision: this.nativeRevision, outputs: this.physicalOutputs.length };
  }

  async setPattern(input = {}) {
    const pattern = normalizeNativePatternCommand(input);
    const { type: mode, outputId = null } = pattern;
    if (pattern.applyCorrections === true) {
      const supported = this.calibrationPatternCapabilities()?.applyCorrectionsModes;
      if (!Array.isArray(supported) || !supported.map(String).includes("solid")) {
        throw new Error("Native renderer does not advertise corrected solid-pattern support");
      }
    }
    const payload = { mode, ...(outputId ? { outputId } : {}) };
    if (mode === "solid") {
      payload.rgb = pattern.rgb;
      payload.applyCorrections = pattern.applyCorrections;
    } else if (mode === "gray-code") {
      payload.axis = pattern.axis;
      payload.bit = pattern.bit;
      payload.inverse = pattern.inverse;
    } else if (pattern.cellSize != null) {
      payload.cellSize = pattern.cellSize;
    }
    const response = await this.#request(
      "set-pattern",
      this.#authenticatedMutation("pattern", payload),
    );
    for (const [id, adapter] of this.adapters) {
      if (!outputId || mode === "content") adapter.mode = mode;
      else adapter.mode = id === String(outputId) ? mode : "black";
    }
    return response.payload;
  }

  calibrationPatternCapabilities() {
    const patterns = this.hello?.patterns;
    return patterns && typeof patterns === "object" && !Array.isArray(patterns) ? patterns : null;
  }

  async clearPattern(outputId = null) {
    return this.setPattern({ outputId, type: "content" });
  }

  async blank(enabled = true, outputId = null) {
    const payload = {
      enabled: Boolean(enabled),
      ...(outputId ? { outputId: String(outputId) } : {}),
    };
    const response = await this.#request(
      "blank",
      this.#authenticatedMutation("blank", payload),
    );
    return response.payload;
  }

  async releaseBootBlack() {
    if (this.bootBlackReleased) return this.diagnostics();
    if (this.bootBlackAuthorizationDiscarded) {
      throw new Error("Native boot-black release authorization was discarded by fail-closed startup");
    }
    if (!this.rendererBootToken) {
      throw new Error("Native boot-black release authorization is unavailable");
    }
    if (!this.hello || !this.nativeStatus) await this.initialize();
    if (this.nativeStatus?.bootBlackLocked !== true
      || Number(this.nativeStatus?.bootBlackReleaseCount) !== 0) {
      throw new Error("Native renderer did not prove a fresh locked boot-black state");
    }
    let response;
    try {
      response = await this.#request("release-boot-black", {
        authorizationToken: this.rendererBootToken,
      });
      if (response.payload?.bootBlackLocked !== false
        || Number(response.payload?.bootBlackReleaseCount) !== 1
        || (response.payload?.released !== true && response.payload?.alreadyReleased !== true)) {
        throw new Error("Native renderer returned an invalid boot-black release receipt");
      }
      await this.refreshStatus();
      if (this.nativeStatus?.bootBlackLocked !== false
        || Number(this.nativeStatus?.bootBlackReleaseCount) !== 1) {
        throw new Error("Native renderer did not retain the authorized boot-black release");
      }
    } catch (error) {
      // If a response was lost after the native transition, reassert ordinary
      // black immediately. The supervisor will then restart the whole Show
      // stack while the next renderer process starts behind a fresh boot latch.
      await this.blank(true).catch(() => {});
      this.ready = false;
      this.lastError = error?.message || "Native boot-black release failed";
      throw error;
    }
    this.bootBlackReleased = true;
    this.lastError = null;
    this.log("info", "render.native.boot-black-released", {
      pipe: this.rendererPipe,
      releaseCount: 1,
    });
    return this.diagnostics();
  }

  discardBootBlackAuthorization() {
    // Keep the lifetime control credential so this process can continue to
    // reinforce authenticated black. The independent boolean permanently
    // destroys only its authority to release the process-start latch.
    this.bootBlackAuthorizationDiscarded = true;
  }

  async refreshStatus(options = {}) {
    const expectedCorrectionBinding = Object.hasOwn(options, "expectedCorrectionBinding")
      ? options.expectedCorrectionBinding
      : this.appliedCorrectionBinding;
    let response;
    try {
      response = await this.#request("get-status");
    } catch (error) {
      // Never retain a stale READY snapshot after the named pipe disappears.
      // Clearing hello also forces the next configure/restart path through a
      // fresh handshake instead of assuming the previous renderer survived.
      this.hello = null;
      this.connected = false;
      this.ready = false;
      this.nativeStatus = null;
      this.nativeStatusUpdatedAt = null;
      this.observedCorrectionBinding = null;
      this.correctionBindingMatches = expectedCorrectionBinding == null ? null : false;
      this.lastError = error?.message || "Native renderer status is unavailable";
      throw error;
    }
    this.nativeStatus = response.payload || {};
    this.nativeRevision = Math.max(this.nativeRevision, positiveInteger(this.nativeStatus.revision));
    this.connected = true;
    this.nativeStatusUpdatedAt = Date.now();
    this.observedCorrectionBinding = null;
    try {
      this.observedCorrectionBinding = normalizeActiveCorrectionBinding(
        this.nativeStatus.activeCorrectionBinding,
        "get-status.activeCorrectionBinding",
      );
      requireStatusBindingConsistency(
        this.observedCorrectionBinding,
        this.nativeStatus.outputs,
      );
      this.correctionBindingMatches = expectedCorrectionBinding == null
        ? null
        : correctionBindingsMatch(expectedCorrectionBinding, this.observedCorrectionBinding);
      if (expectedCorrectionBinding != null && !this.correctionBindingMatches) {
        throw new Error("Native renderer telemetry correction binding differs from the applied receipt");
      }
      const nativeState = String(this.nativeStatus.state || "").toLowerCase();
      const sourceState = String(this.nativeStatus.compositionSource?.state || "").toLowerCase();
      this.ready = this.configAuthorityValid
        && expectedCorrectionBinding != null
        && this.correctionBindingMatches === true
        && nativeState === "running"
        && sourceState === "connected"
        && this.nativeStatus.bootBlackLocked === false;
      if (this.configAuthorityValid) this.lastError = null;
      return this.nativeStatus;
    } catch (error) {
      // The pipe is alive, but unbound or internally inconsistent telemetry
      // must never retain READY or an active correction fingerprint.
      this.ready = false;
      this.correctionBindingMatches = expectedCorrectionBinding == null ? null : false;
      this.lastError = error?.message || "Native renderer correction binding is invalid";
      throw error;
    }
  }

  async restart() {
    this.hello = null;
    await this.initialize();
    if (this.project) await this.configure(this.project);
    return this.diagnostics();
  }

  async stop() {
    this.#stopStatusMonitor();
    try {
      await this.blank(true);
    } catch (error) {
      this.lastError = error.message;
    }
    this.ready = false;
    this.connected = false;
    this.hello = null;
    this.nativeStatusUpdatedAt = null;
    this.observedCorrectionBinding = null;
    this.correctionBindingMatches = this.appliedCorrectionBinding == null ? null : false;
    this.stopped = true;
  }

  diagnostics() {
    const statusAgeMs = this.nativeStatusUpdatedAt == null
      ? null
      : Math.max(0, Date.now() - this.nativeStatusUpdatedAt);
    const statusFresh = statusAgeMs != null && statusAgeMs <= this.statusFreshnessMs;
    const correctionBindingCurrent = this.configAuthorityValid
      && statusFresh
      && this.correctionBindingMatches === true;
    const nativeOutputs = new Map((this.nativeStatus?.outputs || []).map((output) => [String(output.id), output]));
    const outputs = [...this.adapters.values()].map((adapter) => adapter.diagnostics(nativeOutputs.get(adapter.output.id)));
    return {
      backend: "windows-dxgi-native",
      externalCadence: true,
      ready: this.ready && statusFresh,
      connected: this.connected && !this.stopped && statusFresh,
      shaderHash: null,
      projectRevision: this.projectRevision,
      nativeRevision: this.nativeRevision,
      bootBlackLocked: this.nativeStatus?.bootBlackLocked !== false,
      bootBlackReleaseCount: Number(this.nativeStatus?.bootBlackReleaseCount) || 0,
      bootBlackReleasedByNode: this.bootBlackReleased,
      bootBlackAuthorizationDiscarded: this.bootBlackAuthorizationDiscarded,
      configAuthorityValid: this.configAuthorityValid,
      activeCorrectionFingerprint: correctionBindingCurrent
        ? this.observedCorrectionBinding?.fingerprint || null
        : null,
      activeCorrectionBinding: correctionBindingCurrent ? this.observedCorrectionBinding : null,
      observedCorrectionBinding: this.observedCorrectionBinding,
      appliedCorrectionBinding: this.appliedCorrectionBinding,
      correctionBindingMatches: correctionBindingCurrent,
      preparedAssetSha256: [...this.preparedAssets],
      outputs,
      framesRendered: nullableMetricSum(outputs, "framesRendered"),
      presentSubmissions: nullableMetricSum(outputs, "presentSubmissions"),
      droppedFrames: nullableMetricSum(outputs, "droppedFrames"),
      repeatedFrames: nullableMetricSum(outputs, "repeatedFrames"),
      lateFrames: nullableMetricSum(outputs, "lateFrames"),
      displayTimingAvailable: outputs.length > 0
        && outputs.every((output) => output.displayTiming.available && output.displayTiming.fresh),
      ignoredJsFrameRequests: this.ignoredJsFrameRequests,
      compositionSource: this.nativeStatus?.compositionSource || null,
      hello: this.hello,
      nativeStatus: this.nativeStatus,
      nativeStatusUpdatedAt: this.nativeStatusUpdatedAt == null
        ? null
        : new Date(this.nativeStatusUpdatedAt).toISOString(),
      nativeStatusAgeMs: statusAgeMs,
      nativeStatusFresh: statusFresh,
      error: this.lastError || (!statusFresh && this.nativeStatus
        ? `Native renderer status is older than ${this.statusFreshnessMs} ms`
        : null),
    };
  }
}
