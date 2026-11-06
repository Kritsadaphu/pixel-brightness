import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { AssetCache } from "./asset-cache.mjs";
import { RenderEngine } from "./render-engine.mjs";
import { WindowsNativeRenderEngine } from "./windows-native-engine.mjs";
import { ServerClient } from "./server-client.mjs";
import {
  MAX_PENDING_HOST_ACTION_RESULTS,
  NodeStateStore,
  canonicalCameraCalibrationReport,
  createCameraCalibrationAcknowledgement,
  normalizeServerFailClosedFence,
} from "./state-store.mjs";
import {
  CameraCalibrationManifestArchiveStore,
  normalizeCameraCalibrationBundleArchiveBinding,
} from "./camera-calibration-manifest-archive.mjs";
import { HostTelemetryCollector } from "./host-telemetry.mjs";
import { HOST_ACTIONS, HostActionExecutor, hostActionResultId } from "./host-actions.mjs";
import {
  COMMAND,
  MAX_EXECUTION_LEASE_TTL_NS,
  NODE_STATUS,
  PROTOCOL_VERSION,
  assertProtocolVersion,
  createCommand,
  isSafetyCriticalCommand,
  jsonSafe,
  normalizeNativePatternCommand,
  normalizeExecutionLease,
  normalizeProject,
  normalizeServerStateRecovery,
} from "../shared/protocol.mjs";
import {
  ClockEstimator,
  FrameScheduler,
  SlewedClock,
  epochNowNs,
  msFromNs,
  timeForFrame,
} from "../shared/timecore.mjs";
import { normalizeOutputConfig } from "../shared/mapping.mjs";
import {
  CAMERA_CALIBRATION_EVENT,
  CameraCalibrationError,
  normalizeCameraCalibrationPlan,
} from "../shared/camera-calibration.mjs";
import {
  CameraCalibrationOrchestrator,
  CanonR50WindowsCameraAdapter,
  DeterministicPatternOverrideAdapter,
  DeterministicSimulatedCalibrationSolver,
  DeterministicSimulatedCameraAdapter,
  MeasuredCalibrationSolver,
  NativeRendererPatternOverrideAdapter,
  PatternOverrideAdapter,
  materializeMeasuredCalibrationProjectPatch,
} from "./camera-calibration.mjs";
import {
  CanonR50ExternalCameraHelperAdapter,
  ExternalCameraHelperAdapter,
} from "./external-camera-helper.mjs";
import {
  normalizeCameraSurveyPreviewCommand,
  normalizeCameraSurveyPreviewReport,
} from "../shared/camera-survey-preview.mjs";
import { encodeCameraSurveyPreviewPng } from "./camera-survey-preview.mjs";
import {
  CAMERA_OPTICAL_VERIFICATION_LIMITS,
  CAMERA_OPTICAL_ROLLBACK_TRIGGER,
  CAMERA_OPTICAL_VERIFICATION_STATE,
  CameraOpticalVerificationError,
  createCameraOpticalVerificationState,
  normalizeCameraOpticalVerificationConfirmation,
  normalizeCameraOpticalVerificationPlan,
  normalizeCameraOpticalVerificationState,
} from "../shared/camera-verification.mjs";
import {
  CameraOpticalVerificationRunner,
  MeasuredCameraOpticalVerificationSolver,
} from "./camera-verification.mjs";

const MAX_TIMER_MS = 1_000;
const MIN_FRAME_WAKE_MS = 0.1;
const MAX_COMMAND_FAILURE_RECORDS = 128;

function commandFailureKey(command) {
  return `sequence:${commandSequence(command)}`;
}

function commandIdentity(command) {
  return {
    id: String(command?.id ?? "").slice(0, 128),
    sequence: commandSequence(command),
    type: String(command?.type ?? "").slice(0, 128),
  };
}

function commandErrorEvidence(error, attempt, failedAt = new Date().toISOString()) {
  return {
    attempt,
    failedAt,
    name: String(error?.name || "Error").replaceAll("\0", "").slice(0, 128),
    code: error?.code == null ? null : String(error.code).replaceAll("\0", "").slice(0, 128),
    message: String(error?.message || error || "Command failed").replaceAll("\0", "").slice(0, 2_048),
  };
}

function commandDeadLetterId(nodeId, command) {
  const identity = `${nodeId}\0${commandSequence(command)}\0${String(command?.id ?? "")}\0${String(command?.type ?? "")}`;
  return `command_dead_letter_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function commandSequence(command) {
  const value = Number(command?.sequence ?? command?.seq ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid command sequence: ${command?.sequence}`);
  return value;
}

function commandRequiresExecutionLease(command) {
  if (command?.type === COMMAND.STOP) return false;
  if (command?.type === COMMAND.CALIBRATION_PATTERN) {
    const pattern = command.payload || {};
    return !(pattern.enabled !== false && pattern.type === "black");
  }
  return true;
}

function commandLeaseHorizonNs(command, nowNs) {
  if ([COMMAND.PLAY_AT, COMMAND.PAUSE_AT, COMMAND.SEEK_AT].includes(command?.type)) {
    const effectiveAtNs = command.effectiveAtNs ?? command.payload?.effectiveAtNs;
    if (effectiveAtNs != null) {
      try {
        return BigInt(effectiveAtNs);
      } catch {
        // Payload validation belongs to the ordered command handler so poison
        // evidence consumes its configured retry/dead-letter budget.
        return nowNs;
      }
    }
  }
  return nowNs;
}

function frameValue(value, fallback = 0n) {
  if (value == null || value === "") return BigInt(fallback);
  const frame = BigInt(value);
  if (frame < 0n) throw new Error("Frame cannot be negative");
  return frame;
}

function normalizeAssets(value) {
  if (!Array.isArray(value)) return [];
  return value.map((asset) => typeof asset === "string" ? { sha256: asset } : asset).filter(Boolean);
}

function transportSnapshot(scheduler) {
  const current = scheduler.snapshot();
  return jsonSafe({
    state: current.state,
    startNs: current.startNs,
    baseFrame: current.baseFrame,
    pausedFrame: scheduler.pausedFrame,
    frameRateNum: current.frameRateNum,
    frameRateDen: current.frameRateDen,
  });
}

function compactCameraSurveyPreviewReport(report) {
  if (!report) return null;
  return {
    ...report,
    ...(report.artifact == null ? {} : {
      artifact: Object.fromEntries(Object.entries(report.artifact).filter(([key]) => key !== "dataBase64")),
    }),
  };
}

function statusForScheduler(scheduler, fallback = NODE_STATUS.IDLE) {
  if (scheduler.state === "playing") return NODE_STATUS.PLAYING;
  if (scheduler.state === "scheduled" || scheduler.state === "ready") return NODE_STATUS.READY;
  if (scheduler.state === "paused") return NODE_STATUS.PAUSED;
  return fallback;
}

const TERMINAL_CAMERA_CALIBRATION_STATES = new Set(["complete", "failed", "cancelled"]);
const TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES = new Set([
  CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED,
  CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
  CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
  CAMERA_OPTICAL_VERIFICATION_STATE.SUPERSEDED,
  CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
]);

function exactPayloadKeys(input, expected, code) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CameraOpticalVerificationError(code, "Command payload must be an exact object");
  }
  const actual = Object.keys(input).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new CameraOpticalVerificationError(code, `Command payload must contain exactly: ${keys.join(", ")}`);
  }
  return input;
}

function orderedIso(currentValue, ...previousValues) {
  let timestamp = Date.parse(currentValue);
  if (!Number.isFinite(timestamp)) throw new Error("Current ordered timestamp is invalid");
  for (const value of previousValues) {
    if (value == null) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) timestamp = Math.max(timestamp, parsed);
  }
  return new Date(timestamp).toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactValueMatch(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sameProjectDefinition(left, right) {
  if (!left || !right) return false;
  const { updatedAt: leftUpdatedAt, ...leftDefinition } = left;
  const { updatedAt: rightUpdatedAt, ...rightDefinition } = right;
  void leftUpdatedAt;
  void rightUpdatedAt;
  return exactValueMatch(leftDefinition, rightDefinition);
}

const OPTICAL_CONFIRMATION_PAYLOAD_KEYS = [
  "schemaVersion", "verificationId", "calibrationSessionId", "nodeId", "projectRevision",
  "leaseToken", "stepId", "confirmationId", "confirmationLeaseId", "confirmedAt",
];
const OPTICAL_RESTORE_PAYLOAD_KEYS = [
  "verificationId", "leaseToken", "calibrationSessionId", "projectRevision",
];
const OPTICAL_ROLLBACK_TRANSITION_STATES = new Set([
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
]);
const OPTICAL_ROLLBACK_REPLAY_STATES = new Set([
  ...OPTICAL_ROLLBACK_TRANSITION_STATES,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
  CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
]);

function pendingCommandReceipt(input, { lastSequence, payloadKeys, code }) {
  if (input == null) return null;
  exactPayloadKeys(input, ["sequence", "commandId", "payload"], code);
  const sequence = Number(input.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new CameraOpticalVerificationError(code, "Persisted command receipt has an invalid sequence");
  }
  const commandId = String(input.commandId || "");
  if (!commandId || commandId.length > 128 || commandId.trim() !== commandId) {
    throw new CameraOpticalVerificationError(code, "Persisted command receipt has an invalid command id");
  }
  if (sequence <= lastSequence) return null;
  exactPayloadKeys(input.payload, payloadKeys, code);
  return { sequence, commandId, payload: structuredClone(input.payload) };
}

class UnavailableMeasuredPatternAdapter extends PatternOverrideAdapter {
  async beginCalibration() {
    throw new CameraCalibrationError(
      "CALIBRATION_PATTERN_ADAPTER_UNAVAILABLE",
      "The active renderer does not expose the required raw Gray-code calibration pattern contract",
    );
  }

  async failClosed() {
    return { mode: "black", failClosed: true };
  }
}

function normalizeQueuedCalibrationPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CameraCalibrationError("INVALID_CALIBRATION_CONTRACT", "Camera calibration plan is required");
  }
  return normalizeCameraCalibrationPlan(input);
}

export class PixelBrightnessNode {
  constructor(config, {
    log = () => {},
    adapterFactory,
    nativeRendererClient,
    renderEngineFactory,
    hostTelemetryCollector,
    hostActionExecutor,
    cameraCalibrationFactory,
    cameraOpticalVerificationFactory,
  } = {}) {
    this.config = { ...config };
    this.log = log;
    this.client = new ServerClient({
      baseUrl: config.serverUrl,
      nodeId: config.nodeId,
      requestTimeoutMs: config.requestTimeoutMs,
      nodeToken: config.nodeToken,
    });
    this.estimator = new ClockEstimator(24);
    this.clock = new SlewedClock({ source: epochNowNs, maxSlewPpm: 500 });
    this.scheduler = new FrameScheduler({ clock: () => this.clock.nowNs() });
    this.store = new NodeStateStore(join(config.dataDir, "state.json"));
    this.cameraCalibrationManifestArchive = new CameraCalibrationManifestArchiveStore(
      join(config.dataDir, "camera-calibration-manifests.json"),
      {
        maxEntries: config.cameraManifestArchiveMaxEntries,
        maxBytes: config.cameraManifestArchiveMaxBytes,
      },
    );
    this.cache = new AssetCache({
      root: join(config.dataDir, "cache"),
      client: this.client,
      maxAssetBytes: config.maxAssetBytes,
      maxCacheBytes: config.maxCacheBytes,
      log,
    });
    const nativeWindows = config.rendererBackend === "dxgi"
      || (config.rendererBackend === "auto" && (config.platform || process.platform) === "win32");
    this.engine = typeof renderEngineFactory === "function"
      ? renderEngineFactory({ config, log })
      : nativeWindows
        ? new WindowsNativeRenderEngine({
          nodeId: config.nodeId,
          physicalOutputs: config.outputs,
          compositionSource: config.compositionSource,
          rendererPipe: config.rendererPipe,
          rendererConfigPath: config.rendererConfigPath,
          rendererBootToken: config.rendererBootToken,
          rendererIpcTimeoutMs: config.rendererIpcTimeoutMs,
          adapterLuid: config.adapterLuid,
          platform: config.platform || process.platform,
          client: nativeRendererClient,
          log,
        })
        : new RenderEngine({
          nodeId: config.nodeId,
          physicalOutputs: config.outputs,
          log,
          adapterFactory,
        });
    // The engine owns the only required in-process copy. Never retain this
    // ephemeral release credential in general Node configuration/diagnostics.
    this.config.rendererBootToken = null;
    this.hostTelemetry = hostTelemetryCollector || new HostTelemetryCollector({
      dataDir: config.dataDir,
      serviceNames: [config.nodeService || "pixel-brightness-node.service"],
      platform: config.platform || process.platform,
      log,
    });
    this.hostActions = hostActionExecutor || new HostActionExecutor({
      nodeId: config.nodeId,
      dataDir: config.dataDir,
      displayConfigPath: config.displayConfigPath,
      diagnosticsDir: config.diagnosticsDir,
      allowPowerActions: config.allowPowerActions,
      powerConfirmationToken: config.powerConfirmationToken,
      dryRun: config.hostActionsDryRun ?? process.platform !== "linux",
      allowXrandrFallback: config.allowXrandrFallback,
      hostControlCommand: config.hostControlCommand,
      nodeService: config.nodeService,
      displayEnvironment: config.displayEnvironment,
      platform: config.platform || process.platform,
      applyDisplayConfig: async (displayConfig) => {
        if (typeof this.engine.applyDisplayConfig !== "function") {
          const error = new Error("Active renderer does not implement DXGI display configuration");
          error.code = "DXGI_CONTROL_UNAVAILABLE";
          throw error;
        }
        return this.engine.applyDisplayConfig(displayConfig);
      },
      restartRenderer: async () => {
        await this.engine.restart();
        return this.#rendererHostSnapshot();
      },
      diagnosticsProvider: async () => ({
        host: await this.#collectHostTelemetry(),
        node: this.diagnostics(),
      }),
      log,
    });
    this.status = NODE_STATUS.CONNECTING;
    this.connected = false;
    this.running = false;
    this.abortController = new AbortController();
    this.frameTimer = null;
    this.actionTimers = new Map();
    this.lastDispatchedFrame = null;
    this.lastError = null;
    this.rendererFailure = null;
    this.preparedAssetSha256 = null;
    // Persisted transport/status is not cache proof. This flag becomes true
    // only after this process hashes/downloads every required asset, prepares
    // the engine, and durably commits the resulting Node state.
    this.cacheReady = false;
    this.cacheReconciliationBlank = false;
    // Even a locally verified snapshot cannot prove that its command cursor or
    // output-scoped asset authority still matches the durable Server. Keep the
    // native one-shot latch held until the first authoritative registration,
    // project/cache reconciliation, and cursor check all succeed.
    this.bootBlackReleasePending = false;
    this.hostSnapshot = null;
    this.displayState = {
      configured: false,
      preferredBackend: null,
      applied: false,
      appliedBackend: null,
      status: "unconfigured",
      source: null,
      lastAttemptAt: null,
      connectorFaults: [],
      error: null,
    };
    this.metrics = {
      reconnects: 0,
      commandsProcessed: 0,
      commandFailures: 0,
      heartbeats: 0,
      heartbeatFailures: 0,
      clockSyncs: 0,
      clockSyncFailures: 0,
    };
    this.cameraCalibrationFactory = cameraCalibrationFactory || null;
    this.cameraCalibrationAbort = null;
    this.cameraCalibrationTask = null;
    this.cameraCalibration = null;
    this.cameraCalibrationAcknowledgementReceipt = null;
    this.cameraCalibrationAcknowledgementPending = null;
    this.cameraCalibrationPatchAcknowledged = false;
    this.cameraCalibrationReportAcknowledged = false;
    this.cameraCalibrationConfirmation = null;
    this.cameraSurveyPreviewReport = null;
    this.lastCameraSurveyPreview = null;
    this.cameraOpticalVerificationFactory = cameraOpticalVerificationFactory || null;
    this.cameraOpticalVerificationAbort = null;
    this.cameraOpticalVerificationTask = null;
    this.cameraOpticalVerification = null;
    this.cameraOpticalVerificationPlan = null;
    this.cameraOpticalVerificationConfirmation = null;
    this.cameraOpticalVerificationConfirmationReceipt = null;
    this.cameraOpticalVerificationRestoreReceipt = null;
    this.cameraOpticalVerificationPatternAdapter = null;
    this.cameraOpticalVerificationReportAcknowledged = false;
    this.cameraOpticalVerificationFailClosed = false;
    this.commandFailureSafetyLock = null;
    this.stateRecoverySafetyLock = null;
    this.displayConfigRecovery = null;
    this.serverStateRecovery = null;
    this.serverFailClosedFence = null;
    this.executionLease = null;
    this.executionLeaseAuthorityRequired = false;
    this.executionLeaseExpired = false;
    this.executionLeaseExpiryTask = null;
    this.executionAuthorityEpoch = 0;
    this.executionCommandAbortControllers = new Set();
    this.tasks = [];
  }

  #opticalNowIso(...previousValues) {
    const milliseconds = this.clock.nowNs() / 1_000_000n;
    return orderedIso(new Date(Number(milliseconds)).toISOString(), ...previousValues);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await mkdir(this.config.dataDir, { recursive: true });
    let saved;
    let authoritativeStartupReconciliationRequired = false;
    try {
      saved = await this.store.initialize();
      // Recovery evidence is needed before optional display reconciliation.
      // The remaining persisted subsystems are hydrated below after all local
      // stores initialize, but this monotonic lock must never be replaced by a
      // later display-recovery reason.
      this.stateRecoverySafetyLock = saved.stateRecoverySafetyLock || null;
    } catch (error) {
      // A state-recovery failure must not leave a separately running native
      // renderer presenting its previous content. Connect only far enough to
      // force black, then abort startup for operator recovery.
      try {
        await this.engine.initialize();
        await this.engine.blank(true);
      } catch (blankError) {
        this.log("error", "node.state-recovery.fail-closed-enforcement-failed", {
          error: blankError.message,
          stateError: error.message,
        });
      }
      this.engine.discardBootBlackAuthorization?.();
      this.running = false;
      throw error;
    }
    try {
      await this.cameraCalibrationManifestArchive.initialize();
      await this.cache.initialize();
      await this.engine.initialize();
      await this.hostActions.initialize();
      this.displayConfigRecovery = this.hostActions.displayStore?.recoverySnapshot?.() || null;
      if (this.displayConfigRecovery?.status === "active") {
        await this.#activateStateRecoverySafetyLock(
          "DISPLAY_CONFIG_RECOVERY_REQUIRED",
          `Display configuration recovered without proof of the latest committed intent (${this.displayConfigRecovery.reason})`,
          { preserveUnloadedState: true },
        );
        const recovered = this.hostActions.displayStore?.snapshot?.() || null;
        this.displayState = {
          ...this.displayState,
          configured: recovered != null,
          preferredBackend: recovered?.backend || this.displayState.preferredBackend,
          applied: false,
          appliedBackend: null,
          status: "recovery-required",
          source: "lkg-recovery",
          lastAttemptAt: this.displayConfigRecovery.detectedAt,
          error: {
            code: "DISPLAY_CONFIG_RECOVERY_REQUIRED",
            message: "Recovered display bytes are not authoritative enough to release boot black",
          },
        };
      } else {
        await this.#reconcilePersistedDisplayConfig();
      }
    this.cameraCalibrationAcknowledgementReceipt = saved.cameraCalibrationAcknowledgementReceipt || null;
    this.cameraCalibrationPatchAcknowledged = this.cameraCalibrationAcknowledgementReceipt
      ?.projectPatchAcknowledged === true;
    this.cameraCalibrationReportAcknowledged = this.cameraCalibrationAcknowledgementReceipt != null;
    if (saved.cameraCalibration) {
      this.cameraCalibration = saved.cameraCalibration;
      if (!TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state)) {
        this.cameraCalibrationAcknowledgementReceipt = null;
        this.cameraCalibrationPatchAcknowledged = false;
        this.cameraCalibrationReportAcknowledged = false;
        this.cameraCalibration = {
          ...this.cameraCalibration,
          state: "failed",
          failure: {
            code: "CALIBRATION_INTERRUPTED",
            message: "Camera calibration was interrupted by a render-node restart",
          },
          projectPatch: null,
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
    }
    this.cameraSurveyPreviewReport = saved.cameraSurveyPreviewReport || null;
    this.lastCameraSurveyPreview = saved.lastCameraSurveyPreview || null;
    this.cameraOpticalVerificationReportAcknowledged = saved.cameraOpticalVerificationReportAcknowledged === true;
    this.cameraOpticalVerificationFailClosed = saved.cameraOpticalVerificationFailClosed === true;
    this.commandFailureSafetyLock = saved.commandFailureSafetyLock || null;
    this.stateRecoverySafetyLock = this.stateRecoverySafetyLock || saved.stateRecoverySafetyLock || null;
    this.serverFailClosedFence = saved.serverFailClosedFence || null;
    this.cameraOpticalVerificationConfirmationReceipt = null;
    this.cameraOpticalVerificationRestoreReceipt = null;
    if (saved.cameraOpticalVerificationPlan && saved.cameraOpticalVerification) {
      try {
        this.cameraOpticalVerificationPlan = normalizeCameraOpticalVerificationPlan(saved.cameraOpticalVerificationPlan);
        this.cameraOpticalVerification = normalizeCameraOpticalVerificationState(saved.cameraOpticalVerification, {
          plan: this.cameraOpticalVerificationPlan,
        });
        const confirmationReceipt = pendingCommandReceipt(saved.cameraOpticalVerificationConfirmationReceipt, {
          lastSequence: saved.lastSequence,
          payloadKeys: OPTICAL_CONFIRMATION_PAYLOAD_KEYS,
          code: "INVALID_OPTICAL_VERIFICATION_CONFIRMATION_RECEIPT",
        });
        if (confirmationReceipt) {
          const prompt = this.cameraOpticalVerification.operatorPrompt;
          if (this.cameraOpticalVerification.state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
            || prompt?.state !== "confirmation-queued"
            || prompt.confirmedAt !== confirmationReceipt.payload.confirmedAt) {
            throw new CameraOpticalVerificationError(
              "INVALID_OPTICAL_VERIFICATION_CONFIRMATION_RECEIPT",
              "Pending confirmation receipt does not match the persisted consumed prompt",
            );
          }
          const waitingState = normalizeCameraOpticalVerificationState({
            ...this.cameraOpticalVerification,
            updatedAt: prompt.requestedAt,
            operatorPrompt: {
              ...prompt,
              state: "waiting",
              confirmedAt: null,
            },
          }, { plan: this.cameraOpticalVerificationPlan });
          const normalizedReceipt = normalizeCameraOpticalVerificationConfirmation(
            confirmationReceipt.payload,
            { plan: this.cameraOpticalVerificationPlan, state: waitingState },
          );
          this.cameraOpticalVerificationConfirmationReceipt = {
            sequence: confirmationReceipt.sequence,
            commandId: confirmationReceipt.commandId,
            payload: normalizedReceipt,
          };
        }
        const restoreReceipt = pendingCommandReceipt(saved.cameraOpticalVerificationRestoreReceipt, {
          lastSequence: saved.lastSequence,
          payloadKeys: OPTICAL_RESTORE_PAYLOAD_KEYS,
          code: "INVALID_OPTICAL_VERIFICATION_RESTORE_RECEIPT",
        });
        if (restoreReceipt) {
          const restore = restoreReceipt.payload;
          if (!OPTICAL_ROLLBACK_REPLAY_STATES.has(this.cameraOpticalVerification.state)
            || restore.verificationId !== this.cameraOpticalVerification.verificationId
            || restore.leaseToken !== this.cameraOpticalVerification.leaseToken
            || restore.calibrationSessionId !== this.cameraOpticalVerification.calibrationSessionId
            || restore.projectRevision !== this.cameraOpticalVerificationPlan.project.appliedRevision + 1) {
            throw new CameraOpticalVerificationError(
              "INVALID_OPTICAL_VERIFICATION_RESTORE_RECEIPT",
              "Pending rollback receipt does not match the retained verification transition",
            );
          }
          this.cameraOpticalVerificationRestoreReceipt = restoreReceipt;
        }
        const resumeRollback = OPTICAL_ROLLBACK_TRANSITION_STATES.has(this.cameraOpticalVerification.state)
          && this.cameraOpticalVerificationRestoreReceipt != null;
        if (!TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state)
          && !resumeRollback) {
          const interruptedAt = this.#opticalNowIso(
            this.cameraOpticalVerification.updatedAt,
            this.cameraOpticalVerification.startedAt,
          );
          this.cameraOpticalVerification = normalizeCameraOpticalVerificationState({
            ...this.cameraOpticalVerification,
            state: CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
            progress: {
              ...this.cameraOpticalVerification.progress,
              currentStepId: null,
              currentStepIndex: null,
            },
            startedAt: this.cameraOpticalVerification.startedAt || interruptedAt,
            updatedAt: interruptedAt,
            completedAt: interruptedAt,
            failure: {
              code: "OPTICAL_VERIFICATION_INTERRUPTED",
              message: "Optical verification was interrupted by a render-node restart",
              details: null,
            },
            report: null,
            rollback: null,
            operatorPrompt: null,
          }, { plan: this.cameraOpticalVerificationPlan });
          this.cameraOpticalVerificationReportAcknowledged = false;
          this.cameraOpticalVerificationFailClosed = true;
        }
      } catch (error) {
        this.cameraOpticalVerification = null;
        this.cameraOpticalVerificationPlan = null;
        this.cameraOpticalVerificationConfirmationReceipt = null;
        this.cameraOpticalVerificationRestoreReceipt = null;
        this.cameraOpticalVerificationReportAcknowledged = false;
        this.cameraOpticalVerificationFailClosed = true;
        this.lastError = `Persisted optical verification is invalid: ${error.message}`;
      }
    }
      const retainedStartupSafetyLock = this.cameraOpticalVerificationFailClosed
        || this.commandFailureSafetyLock?.status === "active"
        || this.stateRecoverySafetyLock?.status === "active"
        || this.serverFailClosedFence?.status === "active";
      if (this.stateRecoverySafetyLock?.status === "active") {
        await this.#enforceStateRecoverySafetyLock();
        await this.#persist();
      }
      let project = null;
      if (saved.project && this.stateRecoverySafetyLock?.status !== "active") {
        project = normalizeProject(saved.project);
        this.store.state.project = project;
        await this.engine.configure(project);
      }
      if (retainedStartupSafetyLock) {
        await this.#enforceFailClosedSafetyLocks();
        await this.#persist();
      } else {
        // A persisted READY/transport label is not proof that its cache
        // survived this boot. Re-hash or download every retained dependency,
        // prepare the engine, restore transport only afterward, and durably
        // commit that reconciliation before the renderer can leave black.
        try {
          await this.#reconcilePersistedPreparedState(saved, project);
        } catch (error) {
          if (error?.status !== 403 || !project) throw error;
          // A node-scoped credential can legitimately lose access to a stale
          // local cue after the Server reassigns that output. Keep the native
          // latch held and let registration supply the new scoped project;
          // never broaden the old asset grant or treat the 403 as readiness.
          this.cacheReady = false;
          authoritativeStartupReconciliationRequired = true;
          await this.engine.blank(true);
          this.lastError = "Local startup assets require authoritative Server reconciliation";
          this.log("warn", "node.boot-cache.awaiting-authoritative-project", {
            projectId: project.id,
            projectRevision: project.revision,
            status: 403,
          });
        }
      }
      await this.#collectHostTelemetry().catch((error) => {
        this.log("warn", "host.telemetry.initial.failed", { error: error.message });
      });

      // Native Renderer owns an independent boot-black latch. Only this one
      // fully hydrated, cache-verified and durable branch may authorize its
      // release. Retained locks permanently destroy only release authority;
      // the lifetime credential remains available to reinforce black.
      if (retainedStartupSafetyLock) {
        this.engine.discardBootBlackAuthorization?.();
      } else {
        if (!this.cacheReady && !authoritativeStartupReconciliationRequired) {
          throw new Error("Startup cache reconciliation did not produce durable readiness");
        }
        this.bootBlackReleasePending = true;
      }
    } catch (error) {
      this.cacheReady = false;
      try {
        await this.engine.blank(true);
      } catch (blankError) {
        this.log("error", "node.boot-reconciliation.fail-closed-enforcement-failed", {
          error: blankError.message,
          startupError: error.message,
        });
      }
      this.engine.discardBootBlackAuthorization?.();
      this.running = false;
      throw error;
    }

    this.tasks = [
      this.#connectionLoop(),
      this.#heartbeatLoop(),
      this.#executionLeaseWatchdogLoop(),
      this.#clockLoop(),
      this.#hostTelemetryLoop(),
    ];
    this.log("info", "node.started", {
      nodeId: this.config.nodeId,
      serverUrl: this.config.serverUrl,
      dataDir: this.config.dataDir,
      outputs: this.config.outputs.length,
    });
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.abortController.abort();
    this.cameraCalibrationAbort?.abort();
    this.cameraOpticalVerificationAbort?.abort();
    this.#rejectCameraConfirmation(new CameraCalibrationError(
      "CALIBRATION_CANCELLED",
      "Camera calibration stopped before operator confirmation",
    ));
    this.#rejectCameraOpticalVerificationConfirmation(new CameraOpticalVerificationError(
      "OPTICAL_VERIFICATION_CANCELLED",
      "Optical verification stopped before operator confirmation",
    ));
    this.client.abort();
    clearTimeout(this.frameTimer);
    for (const timer of this.actionTimers.values()) clearTimeout(timer);
    this.actionTimers.clear();
    await this.#persist();
    await Promise.allSettled(this.tasks);
    if (this.cameraCalibrationTask) await Promise.allSettled([this.cameraCalibrationTask]);
    if (this.cameraOpticalVerificationTask) await Promise.allSettled([this.cameraOpticalVerificationTask]);
    await this.engine.stop();
    await this.hostActions.displayStore?.flush?.();
    await this.store.flush();
    await this.cameraCalibrationManifestArchive.flush();
    this.connected = false;
    this.status = NODE_STATUS.OFFLINE;
    this.log("info", "node.stopped", { nodeId: this.config.nodeId });
  }

  async #activateStateRecoverySafetyLock(code, message, { preserveUnloadedState = false } = {}) {
    const activatedAt = new Date().toISOString();
    if (this.stateRecoverySafetyLock?.status !== "active") {
      this.stateRecoverySafetyLock = {
        schemaVersion: 1,
        status: "active",
        activatedAt,
        reason: {
          code: String(code).slice(0, 128),
          message: String(message).slice(0, 2_048),
        },
        blackApplied: false,
        lastEnforcedAt: null,
        enforcementError: null,
      };
    }
    this.store.state.stateRecoverySafetyLock = this.stateRecoverySafetyLock;
    this.cacheReady = false;
    this.bootBlackReleasePending = false;
    await this.#enforceStateRecoverySafetyLock();
    this.engine.discardBootBlackAuthorization?.();
    if (preserveUnloadedState) {
      await this.store.save({
        ...this.store.state,
        stateRecoverySafetyLock: this.stateRecoverySafetyLock,
      });
    } else {
      await this.#persist();
    }
  }

  async #validateRegistrationCursor(registration) {
    const localSequence = this.store.state.lastSequence;
    const serverAckSequence = registration?.node?.ackSequence;
    const nodeHasCommandSequence = registration?.node != null
      && Object.prototype.hasOwnProperty.call(registration.node, "commandSequence");
    const nodeCommandSequence = registration?.node?.commandSequence;
    const responseCommandSequence = registration?.commandSequence;
    // node.commandSequence is the Server's durable latest cursor. Older Server
    // responses used the top-level field for this proof, so retain that command
    // cursor fallback while still requiring the durable acknowledgement. A
    // response that omits either proof can never authorize boot-black release.
    const serverCommandSequence = nodeHasCommandSequence
      ? nodeCommandSequence
      : responseCommandSequence;
    if (!Number.isSafeInteger(serverAckSequence) || serverAckSequence < 0
      || !Number.isSafeInteger(serverCommandSequence) || serverCommandSequence < 0) {
      const message = "Server registration omitted a valid durable acknowledgement or command cursor";
      await this.#activateStateRecoverySafetyLock("SERVER_COMMAND_CURSOR_INVALID", message);
      const error = new Error(message);
      error.code = "SERVER_COMMAND_CURSOR_INVALID";
      throw error;
    }
    if (serverAckSequence > serverCommandSequence) {
      const message = `Server acknowledgement ${serverAckSequence} exceeds command cursor ${serverCommandSequence}`;
      await this.#activateStateRecoverySafetyLock("SERVER_COMMAND_CURSOR_INVALID", message);
      const error = new Error(message);
      error.code = "SERVER_COMMAND_CURSOR_INVALID";
      throw error;
    }
    if (localSequence < serverAckSequence) {
      const message = `Local command cursor ${localSequence} is behind durable Server acknowledgement ${serverAckSequence}`;
      await this.#activateStateRecoverySafetyLock("NODE_COMMAND_CURSOR_ROLLBACK", message);
      const error = new Error(message);
      error.code = "NODE_COMMAND_CURSOR_ROLLBACK";
      throw error;
    }
    if (serverCommandSequence < localSequence) {
      const message = `Server command cursor ${serverCommandSequence} is behind durable local cursor ${localSequence}`;
      await this.#activateStateRecoverySafetyLock("SERVER_COMMAND_CURSOR_ROLLBACK", message);
      const error = new Error(message);
      error.code = "SERVER_COMMAND_CURSOR_ROLLBACK";
      throw error;
    }
    if (localSequence > serverAckSequence) {
      const receipts = this.store.snapshot().commandDeadLetterReceipts || [];
      const proofs = Array.isArray(registration?.commandDeadLetters)
        ? registration.commandDeadLetters
        : [];
      const proofById = new Map(proofs.map((proof) => [String(proof?.deadLetterId || ""), proof]));
      const unacknowledged = receipts.filter((receipt) => receipt.command.sequence > serverAckSequence);
      const exactDurableHandoff = unacknowledged.length > 0
        && unacknowledged.at(-1).command.sequence === localSequence
        && unacknowledged.every((receipt) => {
          const proof = proofById.get(receipt.deadLetterId);
          return proof?.receivedAt === receipt.serverReceivedAt
            && exactValueMatch(proof?.command, receipt.command);
        });
      if (exactDurableHandoff) return;
      const message = `Local command cursor ${localSequence} is ahead of durable Server acknowledgement ${serverAckSequence}`;
      await this.#activateStateRecoverySafetyLock("NODE_COMMAND_CURSOR_UNACKNOWLEDGED", message);
      const error = new Error(message);
      error.code = "NODE_COMMAND_CURSOR_UNACKNOWLEDGED";
      throw error;
    }
  }

  async #completeAuthoritativeBootRelease() {
    if (!this.bootBlackReleasePending) return;
    if (this.cameraOpticalVerificationFailClosed
      || this.commandFailureSafetyLock?.status === "active"
      || this.stateRecoverySafetyLock?.status === "active"
      || this.serverFailClosedFence?.status === "active") {
      this.bootBlackReleasePending = false;
      this.engine.discardBootBlackAuthorization?.();
      return;
    }
    if (!this.cacheReady) {
      const error = new Error("Authoritative project assets are not verified and durably prepared");
      error.code = "AUTHORITATIVE_CACHE_NOT_READY";
      throw error;
    }
    if (this.executionLeaseAuthorityRequired && !this.#executionLeaseIsFresh()) {
      const error = new Error("Authoritative execution lease expired before boot-black release");
      error.code = "EXECUTION_LEASE_EXPIRED";
      throw error;
    }
    if (typeof this.engine.releaseBootBlack === "function") {
      try {
        await this.engine.releaseBootBlack();
      } catch (error) {
        // A lost release response is ambiguous because the native latch may
        // already have transitioned. Never retry inside the same process pair;
        // terminate this Node so the Show supervisor creates a fresh renderer
        // behind a fresh latch/token pair.
        this.bootBlackReleasePending = false;
        this.engine.discardBootBlackAuthorization?.();
        this.running = false;
        this.client.abort();
        throw error;
      }
    }
    this.bootBlackReleasePending = false;
  }

  async #connectionLoop() {
    let backoffMs = 500;
    while (this.running) {
      try {
        this.status = NODE_STATUS.CONNECTING;
        const transportActive = this.scheduler.state === "playing" || this.scheduler.state === "scheduled";
        await this.syncClock({ allowStep: !transportActive });
        const registration = await this.client.register(this.#registration());
        assertProtocolVersion(registration?.protocolVersion ?? PROTOCOL_VERSION);
        const serverStateRecoveryActive = await this.#acceptServerStateRecovery(
          registration?.serverStateRecovery,
        );
        await this.#acceptServerFailClosedFence(registration?.node?.failClosedFence, {
          serverStateRecoveryActive,
        });
        // Presence on the authoritative registration negotiates the lease
        // contract for this Server generation. Once negotiated, omission from
        // any later response is fail-closed; legacy protocol-v1 test/dev peers
        // which never advertise a lease remain wire-compatible.
        await this.#acceptExecutionLease(registration?.executionLease, { required: false });
        await this.#validateRegistrationCursor(registration);
        // A dead-letter is a two-party durable hand-off. Finish any retained
        // Server publication before applying registration state or polling
        // later commands; the Node must never advance solely on a lost HTTP
        // response or an in-memory acknowledgement.
        await this.#deliverPendingCommandDeadLetters();
        await this.#settleCommandDeadLetterReceipts(registration?.node?.ackSequence);
        if (registration.project && !serverStateRecoveryActive
          && this.serverFailClosedFence?.status !== "active") {
          await this.#syncProject(registration.project);
        }
        // Required media reconciliation is part of connection readiness. Let
        // failure enter the reconnect/backoff path with cacheReady false; never
        // continue polling commands behind an advisory warning.
        if (!serverStateRecoveryActive && this.serverFailClosedFence?.status !== "active") {
          await this.#reconcileServerState();
        }
        await this.#completeAuthoritativeBootRelease();
        this.connected = true;
        this.lastError = null;
        const displayFault = this.displayState.configured && !this.displayState.applied
          && !["dry-run", "unconfigured"].includes(this.displayState.status);
        if (displayFault) this.lastError = this.displayState.error?.message || "Persisted display configuration is not applied";
        this.status = statusForScheduler(this.scheduler, displayFault ? NODE_STATUS.DEGRADED : NODE_STATUS.IDLE);
        this.log("info", "node.connected", { serverUrl: this.config.serverUrl });
        backoffMs = 500;
        await this.#pollUntilFailure();
      } catch (error) {
        if (!this.running) break;
        this.connected = false;
        this.lastError = error.message;
        this.status = NODE_STATUS.DEGRADED;
        this.metrics.reconnects += 1;
        this.log("warn", "node.connection.retry", { error: error.message, retryMs: backoffMs });
        await delay(backoffMs, this.abortController.signal);
        backoffMs = Math.min(15_000, Math.round(backoffMs * 1.8));
      }
    }
  }

  async #pollUntilFailure() {
    while (this.running && this.connected) {
      const response = await this.client.pollCommands(this.store.state.lastSequence, this.config.pollWaitMs);
      if (response?.protocolVersion != null) assertProtocolVersion(response.protocolVersion);
      this.#acceptServerTime(response?.serverTimeNs);
      const serverStateRecoveryActive = await this.#acceptServerStateRecovery(
        response?.serverStateRecovery,
      );
      await this.#acceptServerFailClosedFence(response?.failClosedFence, {
        serverStateRecoveryActive,
      });
      await this.#acceptExecutionLease(response?.executionLease, {
        required: this.executionLeaseAuthorityRequired,
      });
      const polledCommandSequence = Number(response?.commandSequence);
      if (Number.isSafeInteger(polledCommandSequence) && polledCommandSequence >= 0
        && polledCommandSequence < this.store.state.lastSequence) {
        const message = `Polled Server command cursor ${polledCommandSequence} is behind durable local cursor ${this.store.state.lastSequence}`;
        await this.#activateStateRecoverySafetyLock("SERVER_COMMAND_CURSOR_ROLLBACK", message);
        const error = new Error(message);
        error.code = "SERVER_COMMAND_CURSOR_ROLLBACK";
        throw error;
      }
      if (response?.resetRequired) {
        const earliest = Number(response.earliestSequence);
        const message = Number.isSafeInteger(earliest) && earliest > 0
          ? `Server cannot replay the complete command history after local cursor ${this.store.state.lastSequence}; earliest retained sequence is ${earliest}`
          : `Server requires command-history reset after local cursor ${this.store.state.lastSequence}`;
        await this.#activateStateRecoverySafetyLock("SERVER_COMMAND_HISTORY_GAP", message);
        const error = new Error(message);
        error.code = "SERVER_COMMAND_HISTORY_GAP";
        throw error;
      }
      const commands = Array.isArray(response) ? response : response?.commands || [];
      commands.sort((left, right) => commandSequence(left) - commandSequence(right));
      for (const command of commands) {
        const sequence = commandSequence(command);
        if (sequence <= this.store.state.lastSequence) continue;
        if (this.serverFailClosedFence?.status === "active") {
          await this.#enforceServerFailClosedFence();
          await delay(Math.min(this.config.heartbeatMs, 100), this.abortController.signal);
          break;
        }
        if (this.#hostActionResultOutboxIsFullFor(command)) {
          // HOST_ACTION is an ordered, exactly-once mutation. Keep the command
          // pending without entering command-failure accounting until a
          // heartbeat durably publishes at least one retained result. Dropping
          // an older result or executing this mutation without outbox capacity
          // would make Server authority unrecoverable after a lost heartbeat.
          this.log("warn", "host.action.backpressure", {
            sequence,
            capacity: MAX_PENDING_HOST_ACTION_RESULTS,
          });
          await delay(Math.min(this.config.heartbeatMs, 100), this.abortController.signal);
          break;
        }
        if (this.executionLeaseAuthorityRequired && commandRequiresExecutionLease(command)) {
          try {
            await this.#renewExecutionLease(commandLeaseHorizonNs(command, this.clock.nowNs()));
          } catch (error) {
            if ([
              "EXECUTION_LEASE_HORIZON_PENDING",
              "EXECUTION_LEASE_UNAVAILABLE",
              "SERVER_FAIL_CLOSED_FENCE_ACTIVE",
              "SERVER_FAIL_CLOSED_FENCE_ROLLBACK",
            ].includes(error?.code)) {
              await delay(Math.min(this.config.heartbeatMs, 100), this.abortController.signal);
              break;
            }
            throw error;
          }
        }
        try {
          await this.#handleCommand(command);
          await this.#enforceCommandFailureSafetyLock();
          this.#resolveCommandFailure(command);
          this.store.state.lastSequence = sequence;
          this.metrics.commandsProcessed += 1;
          await this.#persist();
        } catch (error) {
          if ([
            "SERVER_FAIL_CLOSED_FENCE_ACTIVE",
            "EXECUTION_LEASE_EXPIRED",
            "EXECUTION_LEASE_UNAVAILABLE",
          ].includes(error?.code)) {
            await this.#enforceServerFailClosedFence();
            await delay(Math.min(this.config.heartbeatMs, 100), this.abortController.signal);
            break;
          }
          this.metrics.commandFailures += 1;
          this.lastError = `Command ${sequence} (${command.type}) failed: ${error.message}`;
          this.status = NODE_STATUS.ERROR;
          this.log("error", "command.failed", { sequence, type: command.type, error: error.message });
          const failure = await this.#recordCommandFailure(command, error);
          if (failure.status === "pending-server") {
            await this.#deliverPendingCommandDeadLetters();
            // The Server may atomically replace later commands with
            // fail-closed compensation after accepting the dead letter. Never
            // execute the remainder of the stale long-poll response; repoll
            // from the newly durable cursor and authoritative queue instead.
            break;
          }
          // Reconnect between attempts. Registration is itself a durable Server
          // operation and gives transient renderer/asset dependencies time to
          // recover, while the unchanged lastSequence guarantees exact replay.
          throw error;
        }
      }
    }
  }

  async #heartbeatLoop() {
    while (this.running) {
      if (this.connected) {
        try {
          if ((this.store.snapshot().pendingCommandDeadLetters || []).length > 0) {
            await this.#deliverPendingCommandDeadLetters();
          } else {
            const publicationPayload = this.#heartbeatPayload();
            const response = await this.client.heartbeat(publicationPayload);
            await this.#consumeHeartbeatResponse(response, {
              publishedCameraCalibration: publicationPayload.telemetry?.cameraCalibration || null,
            });
          }
          this.metrics.heartbeats += 1;
        } catch (error) {
          if (this.executionLeaseAuthorityRequired
            && this.serverFailClosedFence?.status !== "active") {
            await this.#expireExecutionLease(`Execution lease heartbeat renewal failed: ${error.message}`)
              .catch((enforcementError) => {
                this.log("error", "execution-lease.expiry-enforcement-failed", {
                  error: enforcementError.message,
                });
              });
          }
          this.metrics.heartbeatFailures += 1;
          this.lastError = error.message;
          this.log("warn", "heartbeat.failed", { error: error.message });
        }
      }
      await delay(this.config.heartbeatMs, this.abortController.signal);
    }
  }

  async #executionLeaseWatchdogLoop() {
    const intervalMs = Math.max(10, Math.min(100, Math.trunc(this.config.heartbeatMs / 4) || 10));
    while (this.running) {
      await delay(intervalMs, this.abortController.signal);
      if (!this.running || this.executionLease == null) continue;
      if (!this.#executionLeaseIsFresh()) {
        await this.#expireExecutionLease("Execution lease expired before Server renewal");
      }
    }
  }

  async #clockLoop() {
    while (this.running) {
      await delay(this.config.clockSyncMs, this.abortController.signal);
      if (!this.running || !this.connected) continue;
      try {
        const active = this.scheduler.state === "playing" || this.scheduler.state === "scheduled";
        await this.syncClock({ allowStep: !active });
      } catch (error) {
        this.metrics.clockSyncFailures += 1;
        this.log("warn", "clock.sync.failed", { error: error.message });
      }
    }
  }

  async #hostTelemetryLoop() {
    while (this.running) {
      await delay(this.config.hostTelemetryMs || 5_000, this.abortController.signal);
      if (!this.running) break;
      try {
        await this.#collectHostTelemetry();
      } catch (error) {
        this.log("warn", "host.telemetry.failed", { error: error.message });
      }
    }
  }

  async syncClock({ allowStep = false } = {}) {
    let successful = 0;
    for (let round = 0; round < this.config.clockSyncRounds; round += 1) {
      const localSendNs = epochNowNs();
      try {
        const response = await this.client.time();
        const localReceiveNs = epochNowNs();
        const serverNs = response?.serverTimeNs ?? response?.timeNs ?? response?.nowNs;
        if (serverNs == null) throw new Error("Time response omitted serverTimeNs");
        this.estimator.addSample({ localSendNs, localReceiveNs, serverNs });
        successful += 1;
      } catch (error) {
        // A completely unreachable server should enter reconnect backoff after
        // one timeout, not after clockSyncRounds consecutive timeouts.
        if (successful === 0) throw error;
      }
    }
    if (successful === 0) throw new Error("No valid server clock samples");
    const estimate = this.estimator.snapshot();
    this.clock.setTargetOffset(estimate.offsetNs, { step: allowStep });
    this.metrics.clockSyncs += 1;
    this.log("debug", "clock.synced", jsonSafe({ ...estimate, ...this.clock.snapshot(), step: allowStep }));
    return { ...estimate, ...this.clock.snapshot() };
  }

  #acceptServerTime(serverTimeNs) {
    // Heartbeat/poll timestamps lack a local-send marker, so they are useful for
    // detecting gross faults only. ClockEstimator samples exclusively /v1/time.
    if (serverTimeNs == null) return;
    const difference = BigInt(serverTimeNs) - this.clock.nowNs();
    if (difference > 5_000_000_000n || difference < -5_000_000_000n) {
      this.log("warn", "clock.large-divergence", { differenceNs: difference.toString() });
    }
  }

  #registration() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      nodeId: this.config.nodeId,
      name: this.config.name,
      version: this.config.version,
      capabilities: {
        outputs: this.config.outputs.map((output) => ({
          id: output.id,
          name: output.name,
          connector: output.connector,
          resolution: output.resolution,
        })),
        codecs: ["application/x-pixel-brightness-procedural-v1", ...(this.config.compositionSource ? ["video/x-spout"] : [])],
        spout: Boolean(this.config.compositionSource),
        compositionSource: this.config.compositionSource || null,
        ndi: false,
        hardwareTimestamping: false,
        frameLock: false,
        camera: {
          backend: this.config.cameraBackend || "canon-edsdk",
          expectedModel: this.config.cameraExpectedModel || null,
          expectedSerial: this.config.cameraExpectedSerial || null,
          expectedLensModel: this.config.cameraExpectedLensModel || null,
          expectedLensSerial: this.config.cameraExpectedLensSerial || null,
          helperConfigured: Boolean(this.config.cameraHelperCommand),
          processIsolated: Boolean(this.config.cameraHelperCommand),
          linearRawCapture: Boolean(this.config.cameraHelperCommand),
        },
        rendererBackend: this.config.rendererBackend,
        gpu: this.config.rendererBackend === "dxgi"
          || (this.config.rendererBackend === "auto" && this.hostActions.platform === "win32")
          ? "windows-dxgi-native"
          : "deterministic-simulator",
        hardwareBlackGuarantee: false,
        maxWarpGrid: { columns: 128, rows: 128 },
        shaderPipeline: true,
        hostControl: {
          actions: Object.values(HOST_ACTIONS),
          dryRun: this.hostActions.dryRun,
          powerActions: this.hostActions.allowPowerActions,
          displayBackends: this.hostActions.platform === "win32"
            ? ["dxgi"]
            : ["kms", ...(this.hostActions.allowXrandrFallback ? ["xrandr"] : [])],
        },
      },
    };
  }

  #heartbeatPayload() {
    const render = this.engine.diagnostics();
    const scheduler = this.scheduler.snapshot();
    const clock = this.estimator.snapshot();
    const slewed = this.clock.snapshot();
    const persisted = this.store.snapshot();
    const currentFrame = scheduler.currentFrame.toString();
    return {
      status: this.status,
      ackSequence: persisted.lastSequence,
      host: this.hostSnapshot,
      actionResults: persisted.actionResults || [],
      commandDeadLetters: persisted.pendingCommandDeadLetters || [],
      cameraOpticalVerification: this.cameraOpticalVerificationReportAcknowledged
        ? null
        : this.#cameraOpticalVerificationTelemetry(),
      telemetry: {
        currentFrame,
        clockOffsetNs: slewed.appliedOffsetNs.toString(),
        bestRttNs: clock.bestRttNs?.toString() ?? null,
        droppedFrames: render.droppedFrames,
        projectRevision: persisted.project?.revision ?? null,
        preparedAssetSha256: this.preparedAssetSha256,
        cacheReady: this.cacheReady === true,
        engine: render.backend,
        error: this.lastError,
        cameraOpticalVerificationFailClosed: this.cameraOpticalVerificationFailClosed,
        commandFailureSafetyLock: persisted.commandFailureSafetyLock || null,
        stateRecoverySafetyLock: persisted.stateRecoverySafetyLock || null,
        serverFailClosedFence: this.serverFailClosedFence,
        executionLease: this.executionLease == null ? null : {
          leaseId: this.executionLease.leaseId,
          fenceGeneration: this.executionLease.fenceGeneration,
          expiresAtNs: this.executionLease.expiresAtNs,
          fresh: this.#executionLeaseIsFresh(),
        },
        renderer: {
          backend: render.backend,
          ready: render.ready,
          connected: render.connected,
          projectRevision: render.projectRevision ?? null,
          nativeRevision: render.nativeRevision ?? null,
          compositionSource: render.compositionSource ?? null,
          activeCorrectionFingerprint: render.activeCorrectionFingerprint ?? null,
          activeCorrectionBinding: render.activeCorrectionBinding ?? null,
          correctionBindingMatches: render.correctionBindingMatches ?? null,
        },
        camera: this.cameraCalibration?.camera
          ? {
            ...this.cameraCalibration.camera,
            connected: !TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state),
            remoteCapture: this.cameraCalibration.mode === "simulation" || Boolean(this.config.cameraHelperCommand),
          }
          : {
            backend: this.config.cameraBackend || "canon-edsdk",
            model: this.config.cameraExpectedModel || null,
            connected: false,
            remoteCapture: false,
            implemented: Boolean(this.config.cameraHelperCommand),
            processIsolated: Boolean(this.config.cameraHelperCommand),
          },
        cameraCalibration: this.cameraCalibrationReportAcknowledged
          ? null
          : this.#cameraCalibrationTelemetry({ durableTerminalOnly: true }),
        outputs: render.outputs.map((output) => ({
          id: output.id,
          connector: output.connector,
          state: this.status,
          currentFrame,
          droppedFrames: output.metrics.droppedFrames,
        })),
      },
      diagnostics: jsonSafe({
        clock: { ...clock, ...slewed },
        render,
        cache: this.cache.snapshot(),
        cameraCalibrationManifestArchive: this.cameraCalibrationManifestArchive.summary(),
        metrics: this.metrics,
      }),
    };
  }

  async #handleCommand(command) {
    if (command.protocolVersion != null) assertProtocolVersion(command.protocolVersion);
    const payload = command.payload || {};
    this.log("info", "command.received", { sequence: command.sequence, type: command.type });
    await this.#enforceFailClosedSafetyLocks();
    let commandAuthorityEpoch = null;
    let commandAbort = null;
    let commandError = null;
    try {
      if (this.serverFailClosedFence?.status === "active") {
        const error = new Error(
          `Command ${command.sequence} (${command.type}) is blocked by Server fail-closed fence generation ${this.serverFailClosedFence.generation}`,
        );
        error.code = "SERVER_FAIL_CLOSED_FENCE_ACTIVE";
        throw error;
      }
      if (this.executionLeaseAuthorityRequired
        && commandRequiresExecutionLease(command) && !this.#executionLeaseIsFresh(
        commandLeaseHorizonNs(command, this.clock.nowNs()),
      )) {
        const error = new Error(`Command ${command.sequence} (${command.type}) lost its execution lease`);
        error.code = "EXECUTION_LEASE_EXPIRED";
        throw error;
      }
      if (this.executionLeaseAuthorityRequired && commandRequiresExecutionLease(command)) {
        commandAuthorityEpoch = this.executionAuthorityEpoch;
        commandAbort = new AbortController();
        this.executionCommandAbortControllers.add(commandAbort);
      }
      if (this.stateRecoverySafetyLock?.status === "active") {
        const error = new Error(
          `Command ${command.sequence} (${command.type}) is blocked by unreconciled Node state recovery`,
        );
        error.code = "NODE_STATE_RECOVERY_SAFETY_LOCK_ACTIVE";
        throw error;
      }
      const retainedOpticalConfirmationReplay =
        command.type === COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION
        && this.cameraOpticalVerificationConfirmationReceipt?.sequence === command.sequence
        && this.cameraOpticalVerificationConfirmationReceipt?.commandId === command.id
        && exactValueMatch(this.cameraOpticalVerificationConfirmationReceipt.payload, payload);
      if (this.cameraOpticalVerificationFailClosed
        && ![COMMAND.SYNC_PROJECT, COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK].includes(command.type)
        && !retainedOpticalConfirmationReplay) {
        const error = new Error(
          `Command ${command.sequence} (${command.type}) is blocked by retained optical-verification sticky black`,
        );
        error.code = "OPTICAL_VERIFICATION_FAIL_CLOSED_ACTIVE";
        throw error;
      }
      if (this.commandFailureSafetyLock?.status === "active" && isSafetyCriticalCommand(command)) {
        const error = new Error(
          `Safety command ${command.sequence} (${command.type}) is blocked by retained sticky-black failure ${this.commandFailureSafetyLock.command?.sequence ?? "unknown"}`,
        );
        error.code = "COMMAND_FAILURE_SAFETY_LOCK_ACTIVE";
        throw error;
      }
      switch (command.type) {
      case COMMAND.SYNC_PROJECT:
        await this.#syncProject(payload.project || payload);
        break;
      case COMMAND.PREPARE:
        await this.#prepare(payload);
        break;
      case COMMAND.PLAY_AT:
        await this.#playAt(command.effectiveAtNs || payload.effectiveAtNs, payload);
        break;
      case COMMAND.PAUSE_AT:
        await this.#scheduleTransportAction(command, async () => this.#pause(payload.frame));
        break;
      case COMMAND.SEEK_AT:
        await this.#scheduleTransportAction(command, async () => this.#seek(payload.frame, payload.resume, command.effectiveAtNs));
        break;
      case COMMAND.STOP:
        await this.#stopTransport();
        break;
      case COMMAND.APPLY_OUTPUT:
        await this.#applyOutput(payload.output || payload);
        this.#renderCurrentFrame();
        break;
      case COMMAND.IDENTIFY_OUTPUT:
        await this.engine.setPattern(normalizeNativePatternCommand({
          outputId: payload.outputId,
          type: "identify",
          cellSize: payload.cellSize || 32,
          ...(Object.prototype.hasOwnProperty.call(payload, "applyCorrections")
            ? { applyCorrections: payload.applyCorrections }
            : {}),
        }));
        this.#renderCurrentFrame();
        break;
      case COMMAND.CALIBRATION_PATTERN: {
        const pattern = normalizeNativePatternCommand(payload);
        if (pattern.type === "content") await this.engine.clearPattern(pattern.outputId);
        else await this.engine.setPattern(pattern);
        this.#renderCurrentFrame();
        break;
      }
      case COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW:
        await this.#captureCameraSurveyPreview(payload, commandAbort?.signal);
        break;
      case COMMAND.START_CAMERA_CALIBRATION:
        await this.#startCameraCalibration(payload);
        break;
      case COMMAND.CONFIRM_CAMERA_CALIBRATION:
        await this.#confirmCameraCalibration(payload);
        break;
      case COMMAND.CANCEL_CAMERA_CALIBRATION:
        await this.#cancelCameraCalibration(payload.sessionId);
        break;
      case COMMAND.START_CAMERA_OPTICAL_VERIFICATION:
        await this.#startCameraOpticalVerification(payload);
        break;
      case COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION:
        await this.#confirmCameraOpticalVerification(payload, command);
        break;
      case COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION:
        await this.#cancelCameraOpticalVerification(payload);
        break;
      case COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK:
        await this.#restoreAfterCameraRollback(payload, command);
        break;
      case COMMAND.RESTART_ENGINE:
        await this.engine.restart();
        break;
      case COMMAND.HOST_ACTION:
        await this.#handleHostAction(command);
        break;
      default:
        throw new Error(`Unsupported command type: ${command.type}`);
      }
    } catch (error) {
      commandError = error;
    } finally {
      if (commandAbort != null) this.executionCommandAbortControllers.delete(commandAbort);
      // Commands such as calibration and project sync can manipulate pattern
      // or output state. Reassert any retained lock after every transition so
      // an asynchronous or newly configured output cannot escape black.
      await this.#enforceFailClosedSafetyLocks();
      if (commandAuthorityEpoch != null
        && (commandAuthorityEpoch !== this.executionAuthorityEpoch
          || this.executionLeaseExpired
          || !this.#executionLeaseIsFresh())) {
        await this.#expireExecutionLease(
          `Execution lease changed while command ${command.sequence} (${command.type}) was in flight`,
        );
        // An unabortable renderer/helper call may have completed after the
        // watchdog first established black. Reassert black last and never ACK
        // the command, so delayed completion cannot become durable authority.
        await this.#enforceServerFailClosedFence().catch(() => {});
        await this.engine.blank(true);
        const error = new Error(
          `Execution lease changed while command ${command.sequence} (${command.type}) was in flight`,
        );
        error.code = "EXECUTION_LEASE_EXPIRED";
        commandError = error;
      }
    }
    if (commandError) throw commandError;
  }

  async #syncProject(input) {
    await this.#enforceFailClosedSafetyLocks();
    if (this.stateRecoverySafetyLock?.status === "active") {
      const error = new Error("Project sync is blocked by unreconciled Node state recovery");
      error.code = "NODE_STATE_RECOVERY_SAFETY_LOCK_ACTIVE";
      throw error;
    }
    const project = normalizeProject(input);
    const projectChanged = !sameProjectDefinition(this.store.state.project, project);
    const previousStatus = this.status;
    this.status = NODE_STATUS.SYNCING;
    if (projectChanged) {
      this.cacheReady = false;
      const bootBlackLocked = this.engine.diagnostics?.().bootBlackLocked === true;
      if (!bootBlackLocked) {
        await this.engine.blank(true);
        this.cacheReconciliationBlank = true;
      }
    }
    await this.engine.configure(project);
    this.store.state.project = project;
    if (projectChanged) {
      this.preparedAssetSha256 = null;
      this.store.state.preparedAssetSha256 = null;
      this.store.state.preparedAssets = [];
    }
    this.status = statusForScheduler(this.scheduler, previousStatus === NODE_STATUS.CONNECTING ? NODE_STATUS.IDLE : previousStatus);
    await this.#enforceFailClosedSafetyLocks();
    await this.#persist();
  }

  async #applyOutput(input) {
    await this.engine.applyOutput(input);
    const adapter = this.engine.adapters.get(String(input.id));
    if (!adapter || !this.store.state.project) return;
    const output = { ...adapter.output };
    delete output.masterCanvas;
    const normalized = normalizeOutputConfig(output);
    const project = this.store.state.project;
    const index = project.outputs.findIndex((candidate) => candidate.id === normalized.id);
    const outputs = [...project.outputs];
    if (index >= 0) outputs[index] = normalized;
    else outputs.push(normalized);
    this.store.state.project = normalizeProject({ ...project, outputs });
  }

  #cameraCalibrationTelemetry({ durableTerminalOnly = false } = {}) {
    if (!this.cameraCalibration) return null;
    if (durableTerminalOnly && TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state)) {
      const persisted = this.store.snapshot().cameraCalibration;
      if (!persisted
        || persisted.sessionId !== this.cameraCalibration.sessionId
        || persisted.state !== this.cameraCalibration.state) return null;
      const manifest = this.cameraCalibration.manifest;
      if (manifest?.provenance === "measured" && manifest?.applicable === true) {
        let archived;
        try {
          archived = this.cameraCalibrationManifestArchive.get(manifest.sessionId, {
            nodeId: this.config.nodeId,
          });
        } catch {
          return null;
        }
        const currentManifestSha256 = createHash("sha256").update(canonicalJson(manifest)).digest("hex");
        const persistedManifestSha256 = persisted.manifest == null
          ? null
          : createHash("sha256").update(canonicalJson(persisted.manifest)).digest("hex");
        if (archived.manifestSha256 !== currentManifestSha256
          || archived.manifestSha256 !== persistedManifestSha256) return null;
      }
    }
    const report = canonicalCameraCalibrationReport(this.cameraCalibration);
    if (this.cameraCalibrationPatchAcknowledged) delete report.projectPatch;
    return report;
  }

  #cameraOpticalVerificationTelemetry() {
    const state = this.cameraOpticalVerification;
    if (!state) return null;
    if (state.state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR) return state;
    const pending = this.cameraOpticalVerificationConfirmation;
    const prompt = state.operatorPrompt;
    const pendingPrompt = pending?.state?.operatorPrompt;
    // Runner state becomes WAITING_OPERATOR before it calls the daemon's
    // confirmation transport. Do not advertise that prompt during this small
    // asynchronous gap: an eager Server could otherwise queue an exact-looking
    // CONFIRM before the Node owns its lease, making it stale and activating
    // the poison-command safety lock. Publication starts only after the exact
    // pending lease is registered locally.
    if (!pending
      || pending.plan?.verificationId !== state.verificationId
      || pending.step?.id !== prompt?.stepId
      || pendingPrompt?.confirmationId !== prompt?.confirmationId
      || pendingPrompt?.confirmationLeaseId !== prompt?.confirmationLeaseId) return null;
    return state;
  }

  #externalRawCameraAdapter({
    expectedModel = null,
    expectedSerial = null,
    expectedLensModel = null,
    expectedLensSerial = null,
    maxCaptureBytes = 512 * 1024 * 1024,
  } = {}) {
    const common = {
      command: this.config.cameraHelperCommand,
      captureRoot: this.config.cameraCaptureDir || join(this.config.dataDir, "camera-captures"),
      timeoutMs: this.config.cameraHelperTimeoutMs,
      maxCaptureBytes,
      log: this.log,
    };
    if (this.config.cameraBackend === "canon-edsdk") {
      return new CanonR50ExternalCameraHelperAdapter({
        ...common,
        expectedSerial: this.config.cameraExpectedSerial || expectedSerial || null,
        expectedLensModel: this.config.cameraExpectedLensModel || expectedLensModel || undefined,
        expectedLensSerial: this.config.cameraExpectedLensSerial || expectedLensSerial || null,
        expectedFocalLengthMm: this.config.cameraExpectedFocalLengthMm,
        runtimeManifestPath: this.config.cameraRuntimeManifestPath,
      });
    }
    return new ExternalCameraHelperAdapter({
      ...common,
      backend: "sony-camera-remote-sdk",
      expectedModel: this.config.cameraExpectedModel || expectedModel || "ILCE-7M4",
      expectedSerial: this.config.cameraExpectedSerial || expectedSerial || null,
      expectedLensModel: this.config.cameraExpectedLensModel || expectedLensModel || null,
      expectedLensSerial: this.config.cameraExpectedLensSerial || expectedLensSerial || null,
      requiredBitDepth: 14,
    });
  }

  #cameraSurveyPreviewAdapter(request) {
    if (!new Set(["sony-sdk", "canon-edsdk"]).has(this.config.cameraBackend)
      || !this.config.cameraHelperCommand) {
      throw new CameraCalibrationError(
        "CAMERA_HELPER_UNAVAILABLE",
        "Markerless survey preview requires a configured process-isolated Sony or Canon RAW helper",
      );
    }
    return this.#externalRawCameraAdapter({
      expectedModel: request.lensProfile.camera.model,
      expectedSerial: request.lensProfile.camera.serialNumber,
      expectedLensModel: request.lensProfile.lens.model,
      expectedLensSerial: request.lensProfile.lens.serialNumber,
      maxCaptureBytes: request.limits.maxRawBytes,
    });
  }

  async #captureCameraSurveyPreview(payload, signal = this.abortController.signal) {
    const request = normalizeCameraSurveyPreviewCommand(payload);
    const executionAuthority = this.#captureBackgroundExecutionAuthority();
    const assertExecutionAuthority = (message) => this.#assertBackgroundExecutionAuthority(
      executionAuthority,
      CameraCalibrationError,
      message,
    );
    if (this.cameraCalibrationTask || (this.cameraCalibration
      && !TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state))) {
      throw new CameraCalibrationError(
        "CAMERA_CALIBRATION_BUSY",
        "Markerless survey preview cannot share a camera with an active calibration",
      );
    }
    if (this.cameraOpticalVerificationTask || (this.cameraOpticalVerification
      && !TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state))) {
      throw new CameraCalibrationError(
        "CAMERA_OPTICAL_VERIFICATION_BUSY",
        "Markerless survey preview cannot share a camera with active optical verification",
      );
    }

    let report = null;
    if (this.cameraSurveyPreviewReport?.requestId === request.requestId) {
      try {
        report = normalizeCameraSurveyPreviewReport(this.cameraSurveyPreviewReport, request);
      } catch {
        this.cameraSurveyPreviewReport = null;
      }
    }
    if (!report) {
      let adapter;
      try {
        adapter = this.#cameraSurveyPreviewAdapter(request);
        const capture = await adapter.captureSurveyPreview(request, { signal });
        assertExecutionAuthority(
          "Execution authority expired while the markerless survey preview helper was capturing",
        );
        const artifact = encodeCameraSurveyPreviewPng(capture);
        const decoder = capture.provenance?.decoder;
        report = normalizeCameraSurveyPreviewReport({
          schemaVersion: 1,
          requestId: request.requestId,
          nodeId: request.nodeId,
          cameraViewId: request.cameraViewId,
          lensProfileSha256: request.lensProfile.sha256,
          status: "complete",
          capturedAt: capture.capturedAt,
          completedAt: new Date().toISOString(),
          frame: {
            width: capture.width,
            height: capture.height,
            pixelFormat: capture.pixelFormat,
          },
          camera: capture.cameraDevice,
          lens: capture.lens,
          pipeline: capture.pipeline,
          source: {
            kind: capture.rawSourceKind,
            rawFormat: capture.provenance?.rawFormat,
            sourceBitDepth: capture.sourceBitDepth,
            sourceSha256: capture.provenance?.sourceSha256,
            rasterSha256: capture.rasterSha256,
            decoder: decoder && typeof decoder === "object" ? {
              name: String(decoder.name || "unknown").slice(0, 128),
              version: String(decoder.version || "unknown").slice(0, 128),
            } : null,
          },
          artifact,
        }, request);
      } catch (error) {
        if (error?.code === "EXECUTION_LEASE_EXPIRED") throw error;
        report = normalizeCameraSurveyPreviewReport({
          schemaVersion: 1,
          requestId: request.requestId,
          nodeId: request.nodeId,
          cameraViewId: request.cameraViewId,
          lensProfileSha256: request.lensProfile.sha256,
          status: "failed",
          completedAt: new Date().toISOString(),
          error: {
            code: String(error?.code || "CAMERA_SURVEY_PREVIEW_FAILED").slice(0, 128),
            message: String(error?.message || "Camera survey preview failed").slice(0, 2_048),
          },
        }, request);
        this.log("warn", "camera-survey-preview.failed", {
          requestId: request.requestId,
          code: report.error.code,
          error: report.error.message,
        });
      } finally {
        await adapter?.close().catch((error) => {
          this.log("warn", "camera-survey-preview.helper-close-failed", {
            requestId: request.requestId,
            error: error.message,
          });
        });
      }
      assertExecutionAuthority(
        "Execution authority expired before the markerless survey preview terminal report was persisted",
      );
      this.cameraSurveyPreviewReport = report;
      await this.#persist();
    }

    assertExecutionAuthority(
      "Execution authority expired before the markerless survey preview terminal report was submitted",
    );
    const response = await this.client.submitCameraSurveyPreview(request.requestId, report);
    assertExecutionAuthority(
      "Execution authority expired while the markerless survey preview terminal report was submitted",
    );
    if (String(response?.acknowledgedCameraSurveyPreviewId || "") !== request.requestId) {
      throw new CameraCalibrationError(
        "CAMERA_SURVEY_PREVIEW_NOT_ACKNOWLEDGED",
        "Server did not acknowledge the markerless survey-preview report",
      );
    }
    this.lastCameraSurveyPreview = compactCameraSurveyPreviewReport(report);
    // Retain the single bounded terminal report until the next request. If the
    // process stops after Server acknowledgement but before command-sequence
    // persistence, replay resubmits identical bytes instead of taking a second
    // physical exposure.
    this.cameraSurveyPreviewReport = report;
    await this.#persist();
  }

  async #calibrationAdapters(mode, plan) {
    if (this.cameraCalibrationFactory) {
      const adapters = await this.cameraCalibrationFactory({
        mode,
        plan,
        project: this.store.state.project,
        engine: this.engine,
        node: this,
      });
      if (!adapters?.cameraAdapter || !adapters?.patternAdapter || !adapters?.solver) {
        throw new CameraCalibrationError(
          "CALIBRATION_ADAPTER_REQUIRED",
          "The camera calibration factory must provide camera, pattern and solver adapters",
        );
      }
      return adapters;
    }
    if (mode === "simulation") {
      return {
        cameraAdapter: new DeterministicSimulatedCameraAdapter({ width: 64, height: 36 }),
        patternAdapter: new DeterministicPatternOverrideAdapter(),
        solver: new DeterministicSimulatedCalibrationSolver(),
      };
    }
    const artifactRoot = join(this.config.dataDir, "calibrations");
    const cameraAdapter = new Set(["sony-sdk", "canon-edsdk"]).has(this.config.cameraBackend)
      && this.config.cameraHelperCommand
      ? this.#externalRawCameraAdapter({
        expectedModel: plan.lensProfile?.camera.model || null,
        expectedSerial: plan.lensProfile?.camera.serialNumber || null,
        expectedLensModel: plan.lensProfile?.lens.model || null,
        expectedLensSerial: plan.lensProfile?.lens.serialNumber || null,
      })
      : this.config.cameraBackend === "canon-edsdk" || !this.config.cameraBackend
        ? new CanonR50WindowsCameraAdapter()
        : new ExternalCameraHelperAdapter({
          command: null,
          captureRoot: this.config.cameraCaptureDir || join(this.config.dataDir, "camera-captures"),
          backend: "disabled",
          expectedModel: null,
          log: this.log,
        });
    return {
      cameraAdapter,
      patternAdapter: typeof this.engine.refreshStatus === "function" && typeof this.engine.blank === "function"
        ? new NativeRendererPatternOverrideAdapter({ engine: this.engine })
        : new UnavailableMeasuredPatternAdapter(),
      solver: new MeasuredCalibrationSolver({ artifactRoot }),
      artifactRoot,
    };
  }

  async #startCameraCalibration(payload) {
    const mode = String(payload?.mode || "measured").toLowerCase();
    if (!new Set(["measured", "simulation"]).has(mode)) {
      throw new CameraCalibrationError("INVALID_CALIBRATION_MODE", "Camera calibration mode must be measured or simulation");
    }
    const plan = normalizeQueuedCalibrationPlan(payload?.plan);
    const bundle = normalizeCameraCalibrationBundleArchiveBinding(payload?.bundle, { plan });
    const project = this.store.state.project;
    if (!project || plan.project.id !== project.id || plan.project.revision !== project.revision) {
      throw new CameraCalibrationError(
        "CALIBRATION_PROJECT_REVISION_MISMATCH",
        "Render node project changed before camera calibration started",
      );
    }
    if (this.cameraOpticalVerificationTask || (this.cameraOpticalVerification
      && !TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state))) {
      throw new CameraCalibrationError(
        "CAMERA_OPTICAL_VERIFICATION_BUSY",
        "Optical verification is already using the camera and renderer on this node",
      );
    }
    if (this.cameraCalibrationTask || (this.cameraCalibration
      && !TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state))) {
      throw new CameraCalibrationError("CAMERA_CALIBRATION_BUSY", "A camera calibration is already running on this node");
    }

    const createdAt = new Date().toISOString();
    this.cameraCalibrationAcknowledgementReceipt = null;
    this.cameraCalibrationPatchAcknowledged = false;
    this.cameraCalibrationReportAcknowledged = false;
    this.cameraCalibrationConfirmation = null;
    this.cameraCalibrationAbort = new AbortController();
    this.cameraCalibration = {
      schemaVersion: 1,
      sessionId: plan.sessionId,
      mode,
      plan,
      state: "queued",
      stepIndex: -1,
      completedSteps: 0,
      totalSteps: plan.steps.length,
      camera: null,
      manifest: null,
      projectPatch: null,
      failure: null,
      startedAt: null,
      completedAt: null,
      updatedAt: createdAt,
      bundle,
    };
    await this.#persist();
    const executionAuthority = this.#captureBackgroundExecutionAuthority();

    const task = (async () => {
      try {
        const adapters = await this.#calibrationAdapters(mode, plan);
        const orchestrator = new CameraCalibrationOrchestrator({
          cameraAdapter: adapters.cameraAdapter,
          patternAdapter: adapters.patternAdapter,
          solver: adapters.solver,
          log: this.log,
          onTransition: (session, event) => {
            const completedPrompt = event?.type === CAMERA_CALIBRATION_EVENT.STEP_COMPLETE
              && event?.stepId === this.cameraCalibration?.currentStepId;
            this.cameraCalibration = {
              ...this.cameraCalibration,
              state: session.state,
              stepIndex: session.stepIndex,
              completedSteps: session.completedStepIds?.length || 0,
              camera: session.camera ?? this.cameraCalibration?.camera ?? null,
              failure: session.failure ?? null,
              startedAt: session.startedAt ?? this.cameraCalibration?.startedAt ?? null,
              completedAt: session.completedAt ?? null,
              ...(completedPrompt ? {
                currentStepId: null,
                currentPassId: null,
                currentReferenceKind: null,
                operatorPrompt: null,
              } : {}),
              updatedAt: session.updatedAt ?? new Date().toISOString(),
            };
          },
          requestOperatorConfirmation: ({ plan: activePlan, step, signal }) => mode === "simulation"
            ? Promise.resolve({
              confirmed: true,
              stepId: step.id,
              confirmationId: `simulation:${step.confirmationLeaseId || step.id}`,
              confirmedAt: new Date().toISOString(),
              conditionVerification: {
                projectorState: step.captureConditions?.projectorState,
                opticalPath: step.captureConditions?.opticalPath,
                otherProjectors: step.captureConditions?.otherProjectors,
                method: "deterministic-simulation",
                verifiedAt: new Date().toISOString(),
                confirmationLeaseId: step.confirmationLeaseId || null,
                confirmationId: `simulation:${step.confirmationLeaseId || step.id}`,
              },
            })
            : this.#requestCameraOperatorConfirmation({ plan: activePlan, step, signal }),
        });
        const result = await orchestrator.run(plan, { signal: this.cameraCalibrationAbort.signal });
        this.#assertBackgroundExecutionAuthority(
          executionAuthority,
          CameraCalibrationError,
          "Camera calibration completed after its execution authority expired",
        );
        let projectPatch = null;
        if (result.manifest.applicable === true && result.manifest.provenance === "measured") {
          projectPatch = typeof adapters.buildProjectPatch === "function"
            ? await adapters.buildProjectPatch({ manifest: result.manifest, project })
            : await materializeMeasuredCalibrationProjectPatch({
              manifest: result.manifest,
              project,
              artifactRoot: adapters.artifactRoot || null,
            });
          this.#assertBackgroundExecutionAuthority(
            executionAuthority,
            CameraCalibrationError,
            "Camera calibration project materialization crossed its execution authority boundary",
          );
          await this.cameraCalibrationManifestArchive.append({
            nodeId: this.config.nodeId,
            state: result.session.state,
            plan,
            manifest: result.manifest,
            bundle,
            archivedAt: new Date(Math.max(
              Date.now(),
              Date.parse(result.manifest.completedAt),
            )).toISOString(),
          });
          this.#assertBackgroundExecutionAuthority(
            executionAuthority,
            CameraCalibrationError,
            "Camera calibration archive publication crossed its execution authority boundary",
          );
        }
        this.#assertBackgroundExecutionAuthority(
          executionAuthority,
          CameraCalibrationError,
          "Camera calibration terminal publication lost its execution authority",
        );
        this.cameraCalibration = {
          ...this.cameraCalibration,
          state: result.session.state,
          stepIndex: result.session.stepIndex,
          completedSteps: result.session.completedStepIds.length,
          camera: result.session.camera,
          manifest: result.manifest,
          projectPatch,
          failure: null,
          startedAt: result.session.startedAt,
          completedAt: result.session.completedAt,
          captureCount: result.captureCount,
          updatedAt: result.session.updatedAt,
        };
      } catch (error) {
        const session = error?.session;
        this.cameraCalibration = {
          ...this.cameraCalibration,
          state: session?.state || (error?.code === "CALIBRATION_CANCELLED" ? "cancelled" : "failed"),
          stepIndex: session?.stepIndex ?? this.cameraCalibration?.stepIndex ?? -1,
          completedSteps: session?.completedStepIds?.length ?? this.cameraCalibration?.completedSteps ?? 0,
          camera: session?.camera ?? this.cameraCalibration?.camera ?? null,
          manifest: null,
          projectPatch: null,
          failure: session?.failure || {
            code: String(error?.code || "CALIBRATION_FAILED"),
            message: error?.message || "Camera calibration failed",
            details: error?.details ?? null,
          },
          startedAt: session?.startedAt ?? this.cameraCalibration?.startedAt ?? null,
          completedAt: new Date().toISOString(),
          updatedAt: session?.updatedAt ?? new Date().toISOString(),
        };
        this.log("warn", "camera-calibration.failed", {
          sessionId: plan.sessionId,
          code: this.cameraCalibration.failure?.code,
          error: this.cameraCalibration.failure?.message,
        });
      } finally {
        this.#rejectCameraConfirmation(new CameraCalibrationError(
          "CALIBRATION_CONFIRMATION_CLOSED",
          "Camera calibration ended before operator confirmation completed",
        ));
        this.cameraCalibrationAbort = null;
        // A runner adapter may be unabortable (for example a native IPC call
        // already executing when its lease expires). Its completion must be
        // followed by black, never become the final physical mutation.
        await this.#enforceFailClosedSafetyLocks();
        await this.#persist();
      }
    })();
    this.cameraCalibrationTask = task.finally(() => {
      this.cameraCalibrationTask = null;
    });
  }

  async #cancelCameraCalibration(sessionIdInput) {
    const sessionId = String(sessionIdInput || "");
    if (!this.cameraCalibration || this.cameraCalibration.sessionId !== sessionId) {
      throw new CameraCalibrationError("CAMERA_CALIBRATION_NOT_FOUND", `Camera calibration ${sessionId} is not active on this node`);
    }
    if (TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state)) return;
    this.cameraCalibration.cancelRequestedAt = new Date().toISOString();
    this.cameraCalibration.updatedAt = this.cameraCalibration.cancelRequestedAt;
    this.cameraCalibrationAbort?.abort();
    this.#rejectCameraConfirmation(new CameraCalibrationError(
      "CALIBRATION_CANCELLED",
      "Camera calibration was cancelled while waiting for operator confirmation",
    ));
    await this.#persist();
  }

  #rejectCameraConfirmation(error) {
    const pending = this.cameraCalibrationConfirmation;
    if (!pending) return;
    this.cameraCalibrationConfirmation = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.reject(error);
  }

  async #requestCameraOperatorConfirmation({ plan, step, signal }) {
    if (this.cameraCalibrationConfirmation) {
      throw new CameraCalibrationError(
        "CALIBRATION_CONFIRMATION_BUSY",
        "Another camera capture condition is already waiting for confirmation",
      );
    }
    const confirmationId = randomUUID();
    const requestedAt = new Date().toISOString();
    const captureConditions = step.captureConditions || {};
    const prompt = {
      state: "waiting",
      stepId: step.id,
      passId: step.passId || null,
      referenceKind: step.referenceKind || null,
      confirmationId,
      confirmationLeaseId: step.confirmationLeaseId || null,
      title: step.referenceKind === "sensor-dark"
        ? "Block the lens and switch projector emitters off"
        : step.referenceKind === "projector-black"
          ? "Open the lens; switch emitters on and set every output to digital black"
          : "Open the lens and switch projector emitters off",
      instructions: String(captureConditions.operatorPrompt || "Verify the physical capture conditions, then confirm."),
      conditions: [
        `projectorState:${captureConditions.projectorState || "unknown"}`,
        `opticalPath:${captureConditions.opticalPath || "unknown"}`,
        `otherProjectors:${captureConditions.otherProjectors || "unknown"}`,
      ],
      requestedAt,
      confirmedAt: null,
    };
    this.cameraCalibration = {
      ...this.cameraCalibration,
      stepIndex: step.sequence,
      currentStepId: step.id,
      currentPassId: step.passId || null,
      currentReferenceKind: step.referenceKind || null,
      operatorPrompt: prompt,
      updatedAt: requestedAt,
    };
    const confirmationPromise = new Promise((resolvePromise, reject) => {
      const onAbort = () => this.#rejectCameraConfirmation(new CameraCalibrationError(
        "CALIBRATION_CANCELLED",
        "Camera calibration was cancelled while waiting for operator confirmation",
      ));
      const timer = setTimeout(() => this.#rejectCameraConfirmation(new CameraCalibrationError(
        "CALIBRATION_OPERATOR_CONFIRMATION_TIMEOUT",
        `Operator did not confirm ${step.id} within 15 minutes`,
        { stepId: step.id },
      )), 15 * 60 * 1_000);
      this.cameraCalibrationConfirmation = {
        planSessionId: plan.sessionId,
        step,
        confirmationId,
        signal,
        onAbort,
        timer,
        resolve: resolvePromise,
        reject,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await this.#persist();
    } catch (error) {
      const pending = this.cameraCalibrationConfirmation;
      this.cameraCalibrationConfirmation = null;
      clearTimeout(pending?.timer);
      pending?.signal?.removeEventListener("abort", pending?.onAbort);
      throw error;
    }
    return confirmationPromise;
  }

  async #confirmCameraCalibration(payload = {}) {
    const pending = this.cameraCalibrationConfirmation;
    const sessionId = String(payload.sessionId || "");
    const stepId = String(payload.stepId || "");
    const confirmationId = String(payload.confirmationId || "");
    if (!pending || sessionId !== pending.planSessionId || stepId !== pending.step.id
      || confirmationId !== pending.confirmationId) {
      throw new CameraCalibrationError(
        "CALIBRATION_CONFIRMATION_MISMATCH",
        "Operator confirmation is stale or does not match the active capture step",
      );
    }
    const confirmedAt = String(payload.confirmedAt || new Date().toISOString());
    const conditions = pending.step.captureConditions || {};
    this.cameraCalibration = {
      ...this.cameraCalibration,
      operatorPrompt: {
        ...this.cameraCalibration.operatorPrompt,
        state: "confirmed",
        confirmedAt,
      },
      updatedAt: confirmedAt,
    };
    await this.#persist();
    this.cameraCalibrationConfirmation = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.resolve({
      confirmed: true,
      stepId,
      confirmationId,
      confirmedAt,
      conditionVerification: {
        projectorState: conditions.projectorState,
        opticalPath: conditions.opticalPath,
        otherProjectors: conditions.otherProjectors,
        method: "explicit-operator-confirmation",
        verifiedAt: confirmedAt,
        confirmationLeaseId: pending.step.confirmationLeaseId || null,
        confirmationId,
      },
    });
  }

  async #cameraOpticalVerificationAdapters(plan, baselineManifest) {
    if (this.cameraOpticalVerificationFactory) {
      const adapters = await this.cameraOpticalVerificationFactory({
        plan,
        baselineManifest,
        project: this.store.state.project,
        engine: this.engine,
        node: this,
      });
      if (!adapters?.cameraAdapter || !adapters?.patternAdapter || !adapters?.solver) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_ADAPTER_REQUIRED",
          "The optical verification factory must provide camera, pattern and measured solver adapters",
        );
      }
      return adapters;
    }
    if (!new Set(["sony-sdk", "canon-edsdk"]).has(this.config.cameraBackend)
      || !this.config.cameraHelperCommand) {
      throw new CameraOpticalVerificationError(
        "CAMERA_HELPER_UNAVAILABLE",
        "Measured optical verification requires a configured process-isolated Sony or Canon RAW helper",
      );
    }
    const artifactRoot = join(this.config.dataDir, "calibrations");
    return {
      cameraAdapter: this.#externalRawCameraAdapter({
        expectedModel: plan.camera.model,
        expectedSerial: plan.camera.serial,
        expectedLensModel: plan.lensProfile?.lens.model || null,
        expectedLensSerial: plan.lensProfile?.lens.serialNumber || null,
        maxCaptureBytes: 512 * 1024 * 1024,
      }),
      patternAdapter: new NativeRendererPatternOverrideAdapter({ engine: this.engine }),
      solver: new MeasuredCameraOpticalVerificationSolver({ artifactRoot }),
    };
  }

  async #setCameraOpticalVerificationState(input) {
    this.cameraOpticalVerification = normalizeCameraOpticalVerificationState(input, {
      plan: this.cameraOpticalVerificationPlan,
    });
    await this.#persist();
    return this.cameraOpticalVerification;
  }

  async #startCameraOpticalVerification(payload) {
    exactPayloadKeys(payload, ["plan"], "INVALID_OPTICAL_VERIFICATION_COMMAND");
    const plan = normalizeCameraOpticalVerificationPlan(payload.plan);
    const project = this.store.state.project;
    if (plan.nodeId !== this.config.nodeId
      || !project
      || plan.project.id !== project.id
      || plan.project.appliedRevision !== project.revision) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_REVISION_MISMATCH",
        "Optical verification lease does not match this node and its exact local project revision",
      );
    }
    if (this.cameraCalibrationTask || (this.cameraCalibration
      && !TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state))) {
      throw new CameraOpticalVerificationError(
        "CAMERA_CALIBRATION_BUSY",
        "Camera calibration is already running on this node",
      );
    }
    if (this.cameraOpticalVerificationTask || (this.cameraOpticalVerification
      && !TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state))) {
      throw new CameraOpticalVerificationError(
        "CAMERA_OPTICAL_VERIFICATION_BUSY",
        "Optical verification is already running on this node",
      );
    }
    let baselineManifest = null;
    try {
      const cameraViewIds = [...new Set(plan.outputs
        .map((output) => output.surfaceTarget?.cameraViewId)
        .filter(Boolean))];
      baselineManifest = this.cameraCalibrationManifestArchive.get(plan.calibrationSessionId, {
        nodeId: this.config.nodeId,
        project: { id: plan.project.id, revision: plan.project.baseRevision },
        outputIds: plan.outputs.map((output) => output.id),
        ...(cameraViewIds.length === 1 ? { cameraViewId: cameraViewIds[0] } : {}),
      }).manifest;
    } catch (error) {
      if (error?.code !== "CAMERA_CALIBRATION_MANIFEST_ARCHIVE_NOT_FOUND") {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_BASELINE_INVALID",
          `The exact durable calibration archive binding is invalid: ${error.message}`,
          { archiveCode: error?.code ?? null },
        );
      }
      // Compatibility for one pre-archive local session. This is still an
      // exact session-id match, never a fallback to whichever session is latest.
      if (this.cameraCalibration?.sessionId === plan.calibrationSessionId) {
        baselineManifest = this.cameraCalibration.manifest;
      }
    }
    if (!baselineManifest || baselineManifest.sessionId !== plan.calibrationSessionId) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_BASELINE_INVALID",
        "The exact local measured calibration manifest is unavailable for optical verification",
      );
    }

    const queuedAt = this.#opticalNowIso(plan.rendererAcknowledgedAt);
    this.cameraOpticalVerificationPlan = plan;
    this.cameraOpticalVerificationReportAcknowledged = false;
    this.cameraOpticalVerificationFailClosed = false;
    this.cameraOpticalVerificationConfirmation = null;
    this.cameraOpticalVerificationConfirmationReceipt = null;
    this.cameraOpticalVerificationRestoreReceipt = null;
    this.cameraOpticalVerificationPatternAdapter = null;
    this.cameraOpticalVerificationAbort = new AbortController();
    this.cameraOpticalVerification = normalizeCameraOpticalVerificationState({
      ...createCameraOpticalVerificationState(plan, { at: queuedAt }),
      state: CAMERA_OPTICAL_VERIFICATION_STATE.QUEUED,
    }, { plan });
    await this.#persist();
    const executionAuthority = this.#captureBackgroundExecutionAuthority();

    const task = (async () => {
      try {
        const adapters = await this.#cameraOpticalVerificationAdapters(plan, baselineManifest);
        this.cameraOpticalVerificationPatternAdapter = adapters.patternAdapter;
        const runner = new CameraOpticalVerificationRunner({
          cameraAdapter: adapters.cameraAdapter,
          patternAdapter: adapters.patternAdapter,
          solver: adapters.solver,
          now: adapters.now || (() => this.#opticalNowIso()),
          runDeadlineMs: adapters.runDeadlineMs,
          maxCaptureBytes: adapters.maxCaptureBytes,
          log: this.log,
          onTransition: async (state) => {
            if (state.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
              this.#assertBackgroundExecutionAuthority(
                executionAuthority,
                CameraOpticalVerificationError,
                "Optical verification reached VERIFIED after its execution authority expired",
              );
            }
            this.cameraOpticalVerification = state;
            if ([
              CAMERA_OPTICAL_VERIFICATION_STATE.FAILED,
              CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED,
            ].includes(state.state)) {
              this.cameraOpticalVerificationFailClosed = true;
            } else if (state.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
              this.cameraOpticalVerificationFailClosed = false;
            }
            await this.#persist();
            if (state.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
              this.#assertBackgroundExecutionAuthority(
                executionAuthority,
                CameraOpticalVerificationError,
                "Optical VERIFIED publication crossed its execution authority boundary",
              );
            }
          },
          requestOperatorConfirmation: (request) => this.#requestCameraOpticalVerificationConfirmation(request),
        });
        const result = await runner.run(plan, {
          signal: this.cameraOpticalVerificationAbort.signal,
          baselineManifest,
          nodeProjectRevision: project.revision,
        });
        if (result.state.state === CAMERA_OPTICAL_VERIFICATION_STATE.VERIFIED) {
          this.#assertBackgroundExecutionAuthority(
            executionAuthority,
            CameraOpticalVerificationError,
            "Optical verification result lost its execution authority",
          );
        }
        this.cameraOpticalVerification = result.state;
        this.cameraOpticalVerificationFailClosed = result.failClosed === true;
      } catch (error) {
        const completedAt = this.#opticalNowIso(
          this.cameraOpticalVerification?.updatedAt,
          this.cameraOpticalVerification?.startedAt,
        );
        let failure = {
          code: String(error?.code || "OPTICAL_VERIFICATION_BLOCKED").slice(0, 128),
          message: String(error?.message || "Optical verification was blocked").slice(0, 2_048),
          details: error?.details ?? null,
        };
        this.cameraOpticalVerificationFailClosed = true;
        try {
          await this.engine.blank(true);
        } catch (blankError) {
          failure = {
            code: "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED",
            message: "Optical verification preflight failed and the renderer could not confirm sticky black",
            details: {
              cause: failure,
              blankError: blankError?.message || String(blankError),
            },
          };
        }
        this.cameraOpticalVerification = normalizeCameraOpticalVerificationState({
          ...this.cameraOpticalVerification,
          state: CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED,
          progress: {
            ...this.cameraOpticalVerification.progress,
            currentStepId: null,
            currentStepIndex: null,
          },
          startedAt: this.cameraOpticalVerification.startedAt || completedAt,
          updatedAt: completedAt,
          completedAt,
          failure,
          report: null,
          rollback: null,
          operatorPrompt: null,
        }, { plan });
        this.log("warn", "camera-optical-verification.failed", {
          verificationId: plan.verificationId,
          code: failure.code,
          error: failure.message,
        });
      } finally {
        this.#rejectCameraOpticalVerificationConfirmation(new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_CONFIRMATION_CLOSED",
          "Optical verification ended before operator confirmation completed",
        ));
        this.cameraOpticalVerificationAbort = null;
        // See the calibration runner above: if an adapter returns after its
        // authority expired, reassert black after that delayed completion.
        await this.#enforceFailClosedSafetyLocks();
        await this.#persist();
      }
    })();
    this.cameraOpticalVerificationTask = task.finally(() => {
      this.cameraOpticalVerificationTask = null;
    });
  }

  #rejectCameraOpticalVerificationConfirmation(error) {
    const pending = this.cameraOpticalVerificationConfirmation;
    if (!pending) return;
    this.cameraOpticalVerificationConfirmation = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.reject(error);
  }

  async #requestCameraOpticalVerificationConfirmation({ plan, step, state, signal }) {
    if (this.cameraOpticalVerificationConfirmation) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_CONFIRMATION_BUSY",
        "Another optical condition is already waiting for operator confirmation",
      );
    }
    const normalized = normalizeCameraOpticalVerificationState(state, { plan });
    if (normalized.state !== CAMERA_OPTICAL_VERIFICATION_STATE.WAITING_OPERATOR
      || normalized.operatorPrompt?.stepId !== step.id
      || normalized.verificationId !== this.cameraOpticalVerification?.verificationId) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_CONFIRMATION_STALE",
        "Optical confirmation prompt is not the current strict node state",
      );
    }
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => this.#rejectCameraOpticalVerificationConfirmation(new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_CANCELLED",
        "Optical verification was cancelled while waiting for operator confirmation",
      ));
      const timeoutMs = CAMERA_OPTICAL_VERIFICATION_LIMITS.operatorConfirmationTimeoutMs;
      const timer = setTimeout(() => this.#rejectCameraOpticalVerificationConfirmation(new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_CONFIRMATION_TIMEOUT",
        `Operator did not confirm ${step.id} within ${timeoutMs} ms`,
        { stepId: step.id },
      )), timeoutMs);
      this.cameraOpticalVerificationConfirmation = {
        plan,
        step,
        state: normalized,
        signal,
        onAbort,
        timer,
        resolve: resolvePromise,
        reject,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #confirmCameraOpticalVerification(payload, command) {
    const sequence = commandSequence(command);
    const commandId = String(command.id || "");
    if (!commandId || commandId.length > 128 || commandId.trim() !== commandId) {
      throw new CameraOpticalVerificationError(
        "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
        "Confirmation command must carry a bounded Server command id",
      );
    }
    const pending = this.cameraOpticalVerificationConfirmation;
    if (!pending) {
      exactPayloadKeys(
        payload,
        OPTICAL_CONFIRMATION_PAYLOAD_KEYS,
        "INVALID_OPTICAL_VERIFICATION_CONFIRMATION",
      );
      const receipt = this.cameraOpticalVerificationConfirmationReceipt;
      if (receipt?.sequence === sequence && receipt.commandId === commandId
        && exactValueMatch(receipt.payload, payload)) return;
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_CONFIRMATION_STALE",
        "No optical verification confirmation is currently expected",
      );
    }
    const confirmation = normalizeCameraOpticalVerificationConfirmation(payload, {
      plan: pending.plan,
      state: pending.state,
    });
    this.cameraOpticalVerificationConfirmationReceipt = {
      sequence,
      commandId,
      payload: structuredClone(confirmation),
    };
    this.cameraOpticalVerification = normalizeCameraOpticalVerificationState({
      ...this.cameraOpticalVerification,
      operatorPrompt: {
        ...this.cameraOpticalVerification.operatorPrompt,
        state: "confirmation-queued",
        confirmedAt: confirmation.confirmedAt,
      },
      updatedAt: confirmation.confirmedAt,
    }, { plan: pending.plan });
    await this.#persist();
    this.cameraOpticalVerificationConfirmation = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.resolve({
      confirmation,
      serverCommandId: commandId,
      serverCommandSequence: sequence,
    });
  }

  async #cancelCameraOpticalVerification(payload) {
    exactPayloadKeys(
      payload,
      ["verificationId", "leaseToken"],
      "INVALID_OPTICAL_VERIFICATION_COMMAND",
    );
    if (!this.cameraOpticalVerification
      || payload.verificationId !== this.cameraOpticalVerification.verificationId
      || payload.leaseToken !== this.cameraOpticalVerification.leaseToken) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_LEASE_MISMATCH",
        "Cancellation does not match the active optical verification lease",
      );
    }
    if (TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state)) return;
    this.cameraOpticalVerificationAbort?.abort();
    this.#rejectCameraOpticalVerificationConfirmation(new CameraOpticalVerificationError(
      "OPTICAL_VERIFICATION_CANCELLED",
      "Optical verification was cancelled by the operator",
    ));
  }

  async #restoreAfterCameraRollback(payload, command) {
    const sequence = commandSequence(command);
    const commandId = String(command.id || "");
    if (!commandId || commandId.length > 128 || commandId.trim() !== commandId) {
      throw new CameraOpticalVerificationError(
        "INVALID_OPTICAL_VERIFICATION_COMMAND",
        "Rollback command must carry a bounded Server command id",
      );
    }
    exactPayloadKeys(payload, OPTICAL_RESTORE_PAYLOAD_KEYS, "INVALID_OPTICAL_VERIFICATION_COMMAND");
    const state = this.cameraOpticalVerification;
    const plan = this.cameraOpticalVerificationPlan;
    if (!state || !plan
      || payload.verificationId !== state.verificationId
      || payload.leaseToken !== state.leaseToken
      || payload.calibrationSessionId !== state.calibrationSessionId) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_LEASE_MISMATCH",
        "Rollback restore does not match the retained optical verification lease",
      );
    }
    const targetRevision = payload.projectRevision;
    if (!Number.isSafeInteger(targetRevision)
      || targetRevision !== plan.project.appliedRevision + 1) {
      throw new CameraOpticalVerificationError(
        "OPTICAL_VERIFICATION_REVISION_MISMATCH",
        "Rollback target must be the exact next authoritative project revision",
      );
    }

    const replay = OPTICAL_ROLLBACK_REPLAY_STATES.has(state.state);
    const blockedCancellationSource = state.state === CAMERA_OPTICAL_VERIFICATION_STATE.BLOCKED
      && state.report == null
      && state.failure?.code === "OPTICAL_VERIFICATION_FAIL_CLOSED_FAILED";
    const rollbackTrigger = replay
      ? state.rollback?.trigger
      : state.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED || blockedCancellationSource
        ? CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
        : CAMERA_OPTICAL_ROLLBACK_TRIGGER.FAILED;
    const rollbackReason = rollbackTrigger === CAMERA_OPTICAL_ROLLBACK_TRIGGER.CANCELLED
      ? "Authoritative Server rollback requested after operator cancellation"
      : "Authoritative Server rollback requested after failed optical gates";
    if (replay) {
      const receipt = this.cameraOpticalVerificationRestoreReceipt;
      if (receipt?.sequence !== sequence || receipt.commandId !== commandId
        || !exactValueMatch(receipt.payload, payload)) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_LEASE_MISMATCH",
          "Rollback replay does not exactly match its persisted command receipt",
        );
      }
      if (state.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK
        || state.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED) return;
    } else {
      const failedSource = state.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED
        && state.report?.state === CAMERA_OPTICAL_VERIFICATION_STATE.FAILED;
      const cancelledSource = state.state === CAMERA_OPTICAL_VERIFICATION_STATE.CANCELLED
        && state.report == null
        && state.failure?.code === "OPTICAL_VERIFICATION_CANCELLED";
      if (!failedSource && !cancelledSource && !blockedCancellationSource) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_LEASE_MISMATCH",
          "Rollback restore requires one retained failed or fail-closed cancelled verification",
        );
      }
      if (this.cameraOpticalVerificationRestoreReceipt != null) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_LEASE_MISMATCH",
          "A different rollback command is already retained for this verification",
        );
      }
      this.cameraOpticalVerificationRestoreReceipt = {
        sequence,
        commandId,
        payload: structuredClone(payload),
      };
      this.cameraOpticalVerificationReportAcknowledged = false;
      const requestedAt = this.#opticalNowIso(state.updatedAt, state.completedAt);
      await this.#setCameraOpticalVerificationState({
        ...state,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK,
        updatedAt: requestedAt,
        rollback: {
          state: "pending",
          trigger: rollbackTrigger,
          sourceRevision: plan.project.appliedRevision,
          targetRevision: null,
          reason: rollbackReason,
          rendererAcknowledgedAt: null,
          restoredAt: null,
        },
        operatorPrompt: null,
      });
    }

    let rendererAcknowledgedAt = this.cameraOpticalVerification.rollback?.rendererAcknowledgedAt || null;
    try {
      const project = this.store.state.project;
      if (!project || project.id !== plan.project.id || project.revision !== targetRevision) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_REVISION_MISMATCH",
          "Local project has not reached the exact rollback target revision",
        );
      }
      await this.engine.refreshStatus?.();
      const render = this.engine.diagnostics();
      if (render.connected !== true || render.ready !== true
        || Number(render.projectRevision) !== targetRevision) {
        throw new CameraOpticalVerificationError(
          "OPTICAL_VERIFICATION_REVISION_MISMATCH",
          "Native renderer has not acknowledged the exact rollback target revision",
          {
            expectedRevision: targetRevision,
            rendererRevision: render.projectRevision ?? null,
            connected: render.connected === true,
            ready: render.ready === true,
          },
        );
      }
      if (this.cameraOpticalVerification.state === CAMERA_OPTICAL_VERIFICATION_STATE.ROLLING_BACK) {
        rendererAcknowledgedAt = this.#opticalNowIso(this.cameraOpticalVerification.updatedAt);
        await this.#setCameraOpticalVerificationState({
          ...this.cameraOpticalVerification,
          state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK,
          updatedAt: rendererAcknowledgedAt,
          rollback: {
            state: "renderer-ack",
            trigger: rollbackTrigger,
            sourceRevision: plan.project.appliedRevision,
            targetRevision,
            reason: rollbackReason,
            rendererAcknowledgedAt,
            restoredAt: null,
          },
        });
      }
      if (this.cameraOpticalVerification.state !== CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_RENDERER_ACK
        || rendererAcknowledgedAt == null) {
        throw new CameraOpticalVerificationError(
          "INVALID_OPTICAL_VERIFICATION_RESTORE_RECEIPT",
          "Rollback replay did not retain renderer acknowledgement evidence",
        );
      }
      const patternAdapter = this.cameraOpticalVerificationPatternAdapter
        || new NativeRendererPatternOverrideAdapter({ engine: this.engine });
      const restored = await patternAdapter.restoreAfterRollback({ projectRevision: targetRevision });
      if (restored?.restored !== true || restored?.mode !== "content"
        || restored.projectRevision !== targetRevision) {
        throw new CameraOpticalVerificationError(
          "CONTENT_RESTORE_FAILED",
          "Renderer did not return exact content-mode rollback evidence",
        );
      }
      const restoredAt = this.#opticalNowIso(this.cameraOpticalVerification.updatedAt, rendererAcknowledgedAt);
      this.cameraOpticalVerificationFailClosed = false;
      await this.#setCameraOpticalVerificationState({
        ...this.cameraOpticalVerification,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLED_BACK,
        updatedAt: restoredAt,
        rollback: {
          state: "restored",
          trigger: rollbackTrigger,
          sourceRevision: plan.project.appliedRevision,
          targetRevision,
          reason: rollbackReason,
          rendererAcknowledgedAt,
          restoredAt,
        },
      });
    } catch (error) {
      await this.engine.blank(true).catch(() => {});
      this.cameraOpticalVerificationFailClosed = true;
      const blockedAt = this.#opticalNowIso(this.cameraOpticalVerification.updatedAt, rendererAcknowledgedAt);
      await this.#setCameraOpticalVerificationState({
        ...this.cameraOpticalVerification,
        state: CAMERA_OPTICAL_VERIFICATION_STATE.ROLLBACK_BLOCKED,
        updatedAt: blockedAt,
        rollback: {
          state: "blocked",
          trigger: rollbackTrigger,
          sourceRevision: plan.project.appliedRevision,
          // The authoritative RESTORE command already fixes this revision even
          // when the local renderer fails before acknowledging it. Retain the
          // target so Server ownership can mirror the blocked transition.
          targetRevision,
          reason: String(error?.message || "Rollback content restoration was blocked").slice(0, 2_048),
          rendererAcknowledgedAt,
          restoredAt: null,
        },
      });
    }
  }

  async #handleHostAction(command) {
    const commandId = String(command.id || `host-command-${command.sequence}`);
    const sequence = commandSequence(command);
    const action = command.action || command.payload?.action || command.payload || {};
    const actionId = String(action.id || commandId);
    const resultId = hostActionResultId(commandId, sequence, actionId);
    const journal = this.store.state.hostActionJournal || [];
    const previous = journal.find((entry) => entry.commandId === commandId);
    if (previous?.status === "completed" && previous.result) {
      this.#recordHostActionResult(previous.result);
      return;
    }
    if (previous?.status === "started") {
      const interrupted = {
        resultId: previous.resultId || resultId,
        commandId,
        sequence,
        actionId,
        actionType: String(action.type || previous.actionType || ""),
        status: "failed",
        startedAt: previous.startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: "HOST_ACTION_INTERRUPTED",
          message: "A prior execution was interrupted; the node did not repeat the host mutation",
          details: null,
        },
      };
      this.#recordHostActionResult(interrupted);
      this.store.state.hostActionJournal = journal.map((entry) => entry.commandId === commandId
        ? { ...entry, status: "completed", completedAt: interrupted.completedAt, result: interrupted }
        : entry);
      await this.#persist();
      return;
    }

    const startedAt = new Date().toISOString();
    this.store.state.hostActionJournal = [
      ...journal.filter((entry) => entry.commandId !== commandId),
      {
        commandId,
        sequence,
        actionId,
        actionType: String(action.type || ""),
        resultId,
        status: "started",
        startedAt,
      },
    ].slice(-256);
    // Persist intent before invoking a host mutation. After a crash, a queued
    // reboot/shutdown is reported interrupted instead of being executed twice.
    await this.#persist();
    const result = await this.hostActions.execute({ commandId, sequence, action });
    this.#recordHostActionResult(result);
    this.store.state.hostActionJournal = this.store.state.hostActionJournal.map((entry) => entry.commandId === commandId
      ? { ...entry, status: "completed", completedAt: result.completedAt, result }
      : entry);
    if (result.actionType === HOST_ACTIONS.APPLY_DISPLAY_CONFIG) {
      this.#updateDisplayState(result, this.hostActions.displayStore?.snapshot?.(), "remote-action");
    }
    await this.#persist();
    if (result.status === "failed" || result.status === "denied") {
      this.log("warn", "host.action.result", {
        resultId: result.resultId,
        actionType: result.actionType,
        status: result.status,
        code: result.error?.code,
      });
    }
  }

  #hostActionResultOutboxIsFullFor(command) {
    if (command?.type !== COMMAND.HOST_ACTION) return false;
    const commandId = String(command.id || `host-command-${command.sequence}`);
    const sequence = commandSequence(command);
    const action = command.action || command.payload?.action || command.payload || {};
    const actionId = String(action.id || commandId);
    const resultId = hostActionResultId(commandId, sequence, actionId);
    const retained = this.store.state.actionResults || [];
    return retained.length >= MAX_PENDING_HOST_ACTION_RESULTS
      && !retained.some((result) => result.resultId === resultId);
  }

  #recordHostActionResult(result) {
    const existing = this.store.state.actionResults || [];
    const prior = existing.find((item) => item.resultId === result.resultId);
    if (prior != null && !exactValueMatch(prior, result)) {
      throw new Error(`Host-action result ${result.resultId} changed before Server acknowledgement`);
    }
    if (prior == null && existing.length >= MAX_PENDING_HOST_ACTION_RESULTS) {
      // The ordered poll loop must reserve capacity before executing the host
      // mutation. Treat a violation as an invariant failure; never evict an
      // unacknowledged terminal result to make room.
      throw new Error(`Host-action result outbox reached its ${MAX_PENDING_HOST_ACTION_RESULTS} entry limit`);
    }
    this.store.state.actionResults = [
      ...existing.filter((item) => item.resultId !== result.resultId),
      result,
    ];
  }

  async #reconcilePersistedPreparedState(saved, project) {
    this.cacheReady = false;
    const transportRequiresPreparation = ["ready", "scheduled", "playing", "paused"]
      .includes(saved.transport?.state);
    const retainedPreparedState = saved.preparedAssetSha256 != null
      || (Array.isArray(saved.preparedAssets) && saved.preparedAssets.length > 0);
    if ((transportRequiresPreparation || retainedPreparedState) && !project) {
      throw new Error("Persisted prepared transport has no project to reconcile");
    }

    const requiredSha256 = new Set();
    if (saved.preparedAssetSha256) requiredSha256.add(String(saved.preparedAssetSha256));
    // Every current project cue is part of the releasable renderer state even
    // when persisted transport is idle. Otherwise a reboot could release black
    // first and discover a missing/corrupt cue only at the next PLAY command.
    for (const cue of project?.timeline?.cues || []) {
      if (cue.assetSha256) requiredSha256.add(String(cue.assetSha256));
    }
    // Put fallbacks first so a retained descriptor with URL/size metadata wins
    // AssetCache.ensureAll's SHA-keyed de-duplication.
    const assets = [
      ...Array.from(requiredSha256, (sha256) => ({ sha256 })),
      ...normalizeAssets(saved.preparedAssets),
    ];
    const cached = await this.cache.ensureAll(assets);
    await this.engine.prepare({ assets: cached });
    this.preparedAssetSha256 = saved.preparedAssetSha256 || null;
    this.store.state.preparedAssets = cached;
    this.store.state.preparedAssetSha256 = this.preparedAssetSha256;
    this.#restoreTransport(saved.transport);
    await this.#persist();
    this.cacheReady = true;
  }

  async #prepare(payload, { readinessOnly = false } = {}) {
    this.cacheReady = false;
    const previousStatus = this.status;
    if (!readinessOnly) this.status = NODE_STATUS.PREROLLING;
    if (payload.project) await this.#syncProject(payload.project);
    const assets = normalizeAssets(payload.assets);
    const cached = await this.cache.ensureAll(assets);
    const project = this.store.state.project;
    const frameRateNum = Number(payload.frameRateNum || project?.canvas?.frameRateNum || 60);
    const frameRateDen = Number(payload.frameRateDen || project?.canvas?.frameRateDen || 1);
    const baseFrame = frameValue(payload.baseFrame, 0n);
    if (!readinessOnly) {
      this.scheduler.prepare({ frameRateNum, frameRateDen });
      this.scheduler.seek(baseFrame);
    }
    await this.engine.prepare({ assets: cached });
    if (!readinessOnly) this.#renderCurrentFrame();
    this.preparedAssetSha256 = payload.assetSha256 || null;
    this.store.state.preparedAssets = cached;
    this.store.state.preparedAssetSha256 = this.preparedAssetSha256;
    this.status = readinessOnly ? previousStatus : NODE_STATUS.READY;
    await this.#persist();
    if (this.cacheReconciliationBlank
      && !this.cameraOpticalVerificationFailClosed
      && this.commandFailureSafetyLock?.status !== "active"
      && this.stateRecoverySafetyLock?.status !== "active") {
      await this.engine.clearPattern();
      await this.engine.blank(false);
      this.cacheReconciliationBlank = false;
    }
    this.cacheReady = true;
  }

  async #playAt(effectiveAtNs, payload = {}) {
    if (!this.cacheReady) {
      const error = new Error("Playback is blocked until project assets are verified and prepared");
      error.code = "NODE_CACHE_NOT_VERIFIED";
      throw error;
    }
    const startNs = effectiveAtNs == null ? this.clock.nowNs() : BigInt(effectiveAtNs);
    const project = this.store.state.project;
    const frameRateNum = Number(payload.frameRateNum || project?.canvas?.frameRateNum || 60);
    const frameRateDen = Number(payload.frameRateDen || project?.canvas?.frameRateDen || 1);
    if (this.scheduler.frameRateNum !== frameRateNum || this.scheduler.frameRateDen !== frameRateDen) {
      this.scheduler.prepare({ frameRateNum, frameRateDen });
    }
    this.scheduler.playAt(startNs, frameValue(payload.baseFrame, this.scheduler.pausedFrame));
    this.lastDispatchedFrame = null;
    for (const adapter of this.engine.adapters.values()) adapter.resetCadence?.();
    this.status = startNs > this.clock.nowNs() ? NODE_STATUS.READY : NODE_STATUS.PLAYING;
    this.#armFrameWake(startNs);
    await this.#persist();
  }

  async #pause(frame) {
    clearTimeout(this.frameTimer);
    const pausedFrame = frameValue(frame, this.scheduler.currentFrame());
    this.scheduler.pause(pausedFrame);
    if (!this.engine.externalCadence && this.lastDispatchedFrame !== pausedFrame) {
      const nowNs = this.clock.nowNs();
      this.engine.renderFrame(pausedFrame, { nowNs, deadlineNs: nowNs });
      this.lastDispatchedFrame = pausedFrame;
    }
    this.status = NODE_STATUS.PAUSED;
    await this.#persist();
  }

  async #seek(frame, resume = false, effectiveAtNs = null) {
    const target = frameValue(frame, 0n);
    if (resume) {
      if (!this.cacheReady) {
        const error = new Error("Resumed seek is blocked until project assets are verified and prepared");
        error.code = "NODE_CACHE_NOT_VERIFIED";
        throw error;
      }
      const atNs = effectiveAtNs == null ? this.clock.nowNs() : BigInt(effectiveAtNs);
      this.scheduler.playAt(atNs, target);
      this.lastDispatchedFrame = null;
      for (const adapter of this.engine.adapters.values()) adapter.resetCadence?.();
      this.status = atNs > this.clock.nowNs() ? NODE_STATUS.READY : NODE_STATUS.PLAYING;
      this.#armFrameWake(atNs);
    } else {
      await this.#pause(target);
    }
    await this.#persist();
  }

  async #stopTransport() {
    clearTimeout(this.frameTimer);
    for (const [id, timer] of this.actionTimers) {
      clearTimeout(timer);
      this.actionTimers.delete(id);
    }
    this.store.state.pendingActions = [];
    this.scheduler.pause(0n);
    this.scheduler.state = "idle";
    this.scheduler.startNs = null;
    this.lastDispatchedFrame = null;
    // The native process-start latch rejects pattern mutations by design. Its
    // black frame already supersedes any retained pattern, so defer clearing
    // until after release instead of turning an authoritative idle reconcile
    // into a startup failure.
    if (this.engine.diagnostics?.().bootBlackLocked !== true) {
      await this.engine.clearPattern();
    }
    this.status = NODE_STATUS.IDLE;
    await this.#persist();
  }

  #armFrameWake(deadlineNs) {
    clearTimeout(this.frameTimer);
    if (!this.running || !["scheduled", "playing"].includes(this.scheduler.state)) return;
    const nowNs = this.clock.nowNs();
    const remainingMs = msFromNs(BigInt(deadlineNs) - nowNs);
    const waitMs = Math.min(MAX_TIMER_MS, Math.max(MIN_FRAME_WAKE_MS, remainingMs));
    this.frameTimer = setTimeout(() => this.#onFrameWake(BigInt(deadlineNs)), waitMs);
  }

  #renderCurrentFrame() {
    const nowNs = this.clock.nowNs();
    const frame = this.scheduler.currentFrame(nowNs);
    if (!this.engine.externalCadence) {
      this.engine.renderFrame(frame, { nowNs, deadlineNs: nowNs, baseFrame: this.scheduler.baseFrame });
    }
    this.lastDispatchedFrame = frame;
    return frame;
  }

  #onFrameWake(expectedDeadlineNs) {
    if (!this.running || !["scheduled", "playing"].includes(this.scheduler.state)) return;
    if (this.executionLeaseAuthorityRequired && !this.#executionLeaseIsFresh()) {
      void this.#expireExecutionLease("Execution lease expired before scheduled frame presentation")
        .catch((error) => this.log("error", "execution-lease.frame-enforcement-failed", { error: error.message }));
      return;
    }
    const nowNs = this.clock.nowNs();
    // Timers may wake early. Rechecking the absolute server-time deadline keeps
    // the frame phase authoritative and prevents cumulative setInterval drift.
    if (nowNs < expectedDeadlineNs) {
      this.#armFrameWake(expectedDeadlineNs);
      return;
    }
    if (this.engine.externalCadence) {
      this.lastDispatchedFrame = this.scheduler.currentFrame(nowNs);
      this.status = NODE_STATUS.PLAYING;
      return;
    }
    const frame = this.scheduler.currentFrame(nowNs);
    if (this.lastDispatchedFrame === null || frame !== this.lastDispatchedFrame) {
      const frameOffset = frame - this.scheduler.baseFrame;
      const deadlineNs = timeForFrame(
        frameOffset,
        this.scheduler.startNs,
        this.scheduler.frameRateNum,
        this.scheduler.frameRateDen,
      );
      this.engine.renderFrame(frame, { nowNs, deadlineNs, baseFrame: this.scheduler.baseFrame });
      this.lastDispatchedFrame = frame;
    }
    this.status = NODE_STATUS.PLAYING;
    const nextFrame = frame + 1n;
    const nextDeadlineNs = timeForFrame(
      nextFrame - this.scheduler.baseFrame,
      this.scheduler.startNs,
      this.scheduler.frameRateNum,
      this.scheduler.frameRateDen,
    );
    this.#armFrameWake(nextDeadlineNs);
  }

  #scheduleTransportAction(command, action) {
    const effectiveAtNs = BigInt(command.effectiveAtNs || this.clock.nowNs());
    const saved = jsonSafe(command);
    if (!this.store.state.pendingActions.some((item) => item.id === saved.id)) {
      this.store.state.pendingActions.push(saved);
    }
    return this.#armPendingAction(saved, action, effectiveAtNs);
  }

  #armPendingAction(command, suppliedAction = null, suppliedAtNs = null) {
    const id = command.id || `sequence-${command.sequence}`;
    clearTimeout(this.actionTimers.get(id));
    const effectiveAtNs = suppliedAtNs ?? BigInt(command.effectiveAtNs || this.clock.nowNs());
    const action = suppliedAction || (command.type === COMMAND.PAUSE_AT
      ? () => this.#pause(command.payload?.frame)
      : command.type === COMMAND.SEEK_AT
        ? () => this.#seek(command.payload?.frame, command.payload?.resume, command.effectiveAtNs)
        : null);
    if (!action) return Promise.resolve();
    const arm = () => {
      const remainingMs = msFromNs(effectiveAtNs - this.clock.nowNs());
      if (remainingMs > 0) {
        const timer = setTimeout(arm, Math.min(MAX_TIMER_MS, Math.max(MIN_FRAME_WAKE_MS, remainingMs)));
        this.actionTimers.set(id, timer);
        return Promise.resolve();
      }
      this.actionTimers.delete(id);
      if (this.executionLeaseAuthorityRequired && !this.#executionLeaseIsFresh(effectiveAtNs)) {
        return this.#expireExecutionLease(`Execution lease expired before scheduled ${command.type}`)
          .catch((error) => {
            this.lastError = `Scheduled ${command.type} fail-closed enforcement failed: ${error.message}`;
            this.status = NODE_STATUS.ERROR;
          });
      }
      return Promise.resolve(action()).then(async () => {
        this.store.state.pendingActions = this.store.state.pendingActions.filter((item) => item.id !== id);
        await this.#persist();
      }).catch((error) => {
        this.lastError = `Scheduled ${command.type} failed: ${error.message}`;
        this.status = NODE_STATUS.ERROR;
        this.log("error", "transport.action.failed", { id, type: command.type, error: error.message });
      });
    };
    return arm();
  }

  #restoreTransport(saved) {
    if (!saved) return;
    this.scheduler.prepare({
      frameRateNum: Number(saved.frameRateNum || 60),
      frameRateDen: Number(saved.frameRateDen || 1),
    });
    if (["scheduled", "playing"].includes(saved.state) && saved.startNs != null) {
      this.scheduler.playAt(saved.startNs, frameValue(saved.baseFrame, 0n));
      this.lastDispatchedFrame = null;
      this.#armFrameWake(BigInt(saved.startNs));
    } else if (saved.state === "paused") {
      this.scheduler.pause(frameValue(saved.pausedFrame, saved.baseFrame || 0n));
      this.status = NODE_STATUS.PAUSED;
    }
  }

  async #reconcileServerState() {
    // Registration and sync-project commands carry the node-scoped project.
    // Reconciliation needs timeline/media only; fetching the global dense
    // project here would defeat per-node sharding and resend every wall to
    // every render host after each reconnect.
    const state = await this.client.state({ includeProject: false });
    const timeline = state?.timeline;
    if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
      const error = new Error("Authoritative Server state omitted its timeline");
      error.code = "AUTHORITATIVE_TIMELINE_MISSING";
      throw error;
    }
    // Locally retained PAUSE/SEEK timers may describe a command the Server has
    // since superseded. Cancel them only after a valid authoritative timeline
    // arrives; the pause-scheduled branch below reconstructs the one current
    // Server timer. Never arm the persisted local copies after boot release.
    const hadRetainedActions = this.actionTimers.size > 0
      || (this.store.state.pendingActions || []).length > 0;
    for (const timer of this.actionTimers.values()) clearTimeout(timer);
    this.actionTimers.clear();
    this.store.state.pendingActions = [];
    if (hadRetainedActions) await this.#persist();
    const targetedByTransport = !Array.isArray(timeline.targetNodeIds)
      || timeline.targetNodeIds.length === 0
      || timeline.targetNodeIds.includes(this.config.nodeId);
    const media = Array.isArray(state.media) ? state.media : [];
    const preparedSha = timeline.preparedAssetSha256 || null;
    const cueSha256 = this.store.state.project?.timeline?.cues
      ?.map((cue) => cue.assetSha256)
      .filter(Boolean) || [];
    const requiredSha256 = Array.from(new Set([
      ...(targetedByTransport && preparedSha ? [preparedSha] : []),
      ...cueSha256,
    ]));
    const shouldPrepare = targetedByTransport
      && ["prepared", "playing", "scheduled", "pause-scheduled", "paused"].includes(timeline.status);
    // A registration can introduce a new project after the process boot latch
    // was released (for example, a first connection with no locally persisted
    // project). #syncProject deliberately re-engages black and clears
    // cacheReady. Reconcile every cue even for an idle Server timeline before
    // clearing that black; missing metadata must not silently omit a cue.
    if (shouldPrepare || this.cacheReady !== true) {
      const assets = requiredSha256.map((sha256) => (
        media.find((item) => item.sha256 === sha256) || { sha256 }
      ));
      await this.#prepare({
        assetSha256: shouldPrepare ? preparedSha : null,
        assets,
        baseFrame: timeline.baseFrame,
        frameRateNum: timeline.frameRateNum,
        frameRateDen: timeline.frameRateDen,
      }, { readinessOnly: !shouldPrepare });
    }
    // A locally restored ready/paused/playing state is not authoritative. The
    // Server's idle timeline, or a timeline targeting other nodes, must become
    // durable locally before the process-start latch can release.
    if (!targetedByTransport || timeline.status === "idle") {
      if (this.scheduler.state !== "idle") await this.#stopTransport();
      return;
    }
    if (["playing", "scheduled", "pause-scheduled"].includes(timeline.status)) {
      await this.#playAt(timeline.playAtNs, timeline);
      if (timeline.pauseAtNs) {
        const synthetic = createCommand(
          COMMAND.PAUSE_AT,
          { frame: timeline.pauseFrame || timeline.currentFrame },
          {
            id: "server-reconcile-pause",
            sequence: 0,
            createdAtNs: null,
            effectiveAtNs: timeline.pauseAtNs,
          },
        );
        await this.#scheduleTransportAction(synthetic, () => this.#pause(synthetic.payload.frame));
        await this.#persist();
      }
    } else if (timeline.status === "paused") {
      await this.#pause(timeline.currentFrame || timeline.pauseFrame || timeline.baseFrame);
    }
  }

  #rendererHostSnapshot() {
    const render = this.engine.diagnostics();
    return {
      status: this.status,
      backend: render.backend,
      ready: render.ready,
      connected: render.connected,
      error: render.error || this.rendererFailure,
      shaderHash: render.shaderHash,
      framesRendered: render.framesRendered,
      droppedFrames: render.droppedFrames,
      outputs: render.outputs.map((output) => ({
        id: output.id,
        connector: output.connector,
        enabled: output.enabled,
        mode: output.mode,
        resolution: output.resolution,
      })),
    };
  }

  async #reconcilePersistedDisplayConfig() {
    const saved = this.hostActions.displayStore?.snapshot?.() || null;
    if (!saved) return;
    this.displayState = {
      ...this.displayState,
      configured: true,
      preferredBackend: saved.backend || (this.hostActions.platform === "win32" ? "dxgi" : "kms"),
      status: this.hostActions.dryRun ? "dry-run" : "pending",
      source: "startup",
      lastAttemptAt: new Date().toISOString(),
    };
    if (this.hostActions.dryRun || !["linux", "win32"].includes(this.hostActions.platform)) return;
    const result = await this.hostActions.execute({
      commandId: `startup-display-reconcile:${saved.updatedAt || "saved"}`,
      sequence: 0,
      action: {
        id: "startup-display-reconcile",
        type: HOST_ACTIONS.APPLY_DISPLAY_CONFIG,
        payload: saved,
      },
    });
    this.#updateDisplayState(result, saved, "startup");
    if (!this.displayState.applied) {
      this.lastError = this.displayState.error?.message || "Persisted display configuration could not be applied";
      this.log("warn", "display.reconcile.failed", {
        status: this.displayState.status,
        code: this.displayState.error?.code || null,
      });
    }
  }

  #updateDisplayState(result, config, source) {
    const succeeded = result?.status === "succeeded";
    this.displayState = {
      ...this.displayState,
      configured: Boolean(config),
      preferredBackend: config?.backend || this.displayState.preferredBackend || (this.hostActions.platform === "win32" ? "dxgi" : "kms"),
      applied: succeeded,
      appliedBackend: succeeded ? result.result?.backend || this.displayState.appliedBackend : null,
      status: result?.status || "failed",
      source,
      lastAttemptAt: result?.completedAt || new Date().toISOString(),
      connectorFaults: succeeded ? [] : this.displayState.connectorFaults,
      error: result?.error || null,
    };
    if (!succeeded && !["dry-run", "denied"].includes(result?.status)) {
      this.status = statusForScheduler(this.scheduler, NODE_STATUS.DEGRADED);
    }
  }

  #displayHostSnapshot() {
    const config = this.hostActions.displayStore?.snapshot?.() || null;
    const faults = this.displayState.configured && !this.displayState.applied
      && !["dry-run", "pending", "unconfigured"].includes(this.displayState.status)
      ? [{
        code: this.displayState.error?.code || "DISPLAY_CONFIG_UNAPPLIED",
        severity: "error",
        subsystem: "display",
        message: this.displayState.error?.message || "Persisted display configuration is not applied",
      }]
      : [];
    return jsonSafe({
      ...this.displayState,
      faults,
      config: config ? {
        schemaVersion: config.schemaVersion,
        backend: config.backend,
        updatedAt: config.updatedAt,
        outputs: config.outputs.map((output) => ({
          id: output.id,
          connector: output.connector,
          enabled: output.enabled,
          primary: output.primary,
          resolution: output.resolution,
          x: output.x,
          y: output.y,
          rotation: output.rotation,
        })),
      } : null,
    });
  }

  #evaluateDisplayHealth(snapshot) {
    const config = this.hostActions.displayStore?.snapshot?.();
    if (!config) return;
    let faults;
    if ((config.backend === "dxgi" || (config.backend === "auto" && this.hostActions.platform === "win32"))
      && snapshot?.dxgi?.available) {
      const selectors = new Set(snapshot.dxgi.outputs.flatMap((output) => [output.devicePath, output.gdiName])
        .filter(Boolean).map((value) => String(value).toLowerCase()));
      faults = config.outputs.filter((output) => output.enabled).flatMap((output) => {
        const candidates = [output.display?.devicePath, output.display?.gdiName, output.connector]
          .filter(Boolean).map((value) => String(value).toLowerCase());
        return candidates.some((value) => selectors.has(value))
          ? []
          : [{ connector: output.connector, reason: "missing" }];
      });
    } else if (snapshot?.drm?.available) {
      const connectors = new Map(snapshot.drm.connectors.map((connector) => [connector.connector, connector]));
      faults = config.outputs.filter((output) => output.enabled).flatMap((output) => {
        const actual = connectors.get(output.connector);
        if (!actual) return [{ connector: output.connector, reason: "missing" }];
        if (actual.status !== "connected") return [{ connector: output.connector, reason: actual.status || "disconnected" }];
        return [];
      });
    } else {
      return;
    }
    this.displayState.connectorFaults = faults;
    if (faults.length > 0) {
      this.displayState.applied = false;
      this.displayState.appliedBackend = null;
      this.displayState.status = "connector-fault";
      this.displayState.error = {
        code: "DISPLAY_CONNECTOR_FAULT",
        message: `${faults.length} configured display connector(s) are missing or disconnected`,
        details: faults,
      };
    }
  }

  async #collectHostTelemetry() {
    try {
      await this.engine.refreshStatus?.();
      if (this.rendererFailure) {
        const recoveredFailure = this.rendererFailure;
        this.rendererFailure = null;
        if (this.lastError === recoveredFailure) this.lastError = null;
        const displayFault = this.displayState.configured && !this.displayState.applied
          && !["dry-run", "unconfigured"].includes(this.displayState.status);
        if (this.connected && !displayFault && this.status === NODE_STATUS.DEGRADED) {
          this.status = statusForScheduler(this.scheduler, NODE_STATUS.IDLE);
        }
      }
    } catch (error) {
      const message = `Native renderer unavailable: ${error.message}`;
      this.rendererFailure = message;
      this.lastError = message;
      this.status = NODE_STATUS.DEGRADED;
      this.log("warn", "render.native.status.failed", { error: error.message });
    }
    const collected = await this.hostTelemetry.collect({
      renderer: this.#rendererHostSnapshot(),
    });
    this.#evaluateDisplayHealth(collected);
    this.hostSnapshot = jsonSafe({
      ...collected,
      display: this.#displayHostSnapshot(),
    });
    return this.hostSnapshot;
  }

  #resolveCommandFailure(command) {
    const key = commandFailureKey(command);
    const previous = this.store.state.commandFailures?.[key];
    if (!previous || previous.status !== "retrying") return;
    const resolvedAt = new Date().toISOString();
    this.store.state.commandFailures[key] = {
      ...previous,
      status: "succeeded-after-retry",
      resolvedAt,
      updatedAt: resolvedAt,
    };
  }

  async #recordCommandFailure(command, error) {
    const identity = commandIdentity(command);
    const key = commandFailureKey(command);
    const failures = this.store.state.commandFailures || {};
    const prior = failures[key];
    const sameCommand = prior?.command?.id === identity.id
      && prior?.command?.sequence === identity.sequence
      && prior?.command?.type === identity.type;
    const attempts = sameCommand ? Number(prior.attempts || 0) + 1 : 1;
    const failedAt = new Date().toISOString();
    const evidence = commandErrorEvidence(error, attempts, failedAt);
    const budget = Math.max(1, Math.min(20, Number(this.config.commandRetryBudget) || 3));
    const safetyCritical = isSafetyCriticalCommand(command);
    const deadLettered = attempts >= budget;
    const deadLetterId = deadLettered ? commandDeadLetterId(this.config.nodeId, command) : null;
    const pendingDeadLetters = this.store.state.pendingCommandDeadLetters || [];
    if (deadLettered
      && !pendingDeadLetters.some((item) => item.deadLetterId === deadLetterId)
      && pendingDeadLetters.length >= 32) {
      const capacityError = new Error("Command dead-letter publication outbox is full");
      capacityError.code = "COMMAND_DEAD_LETTER_OUTBOX_FULL";
      throw capacityError;
    }
    const entry = {
      schemaVersion: 1,
      command: identity,
      attempts,
      retryBudget: budget,
      safetyCritical,
      status: deadLettered ? "pending-server" : "retrying",
      firstFailedAt: sameCommand ? prior.firstFailedAt : failedAt,
      lastFailedAt: failedAt,
      updatedAt: failedAt,
      resolvedAt: null,
      serverAcknowledgedAt: null,
      deadLetterId,
      errors: [...(sameCommand && Array.isArray(prior.errors) ? prior.errors : []), evidence].slice(-20),
    };
    this.store.state.commandFailures = { ...failures, [key]: entry };

    const orderedKeys = Object.entries(this.store.state.commandFailures)
      .sort(([, left], [, right]) => Number(left?.command?.sequence || 0) - Number(right?.command?.sequence || 0))
      .map(([recordKey]) => recordKey);
    while (orderedKeys.length > MAX_COMMAND_FAILURE_RECORDS) {
      delete this.store.state.commandFailures[orderedKeys.shift()];
    }

    if (safetyCritical) {
      this.commandFailureSafetyLock = {
        schemaVersion: 1,
        status: "active",
        activatedAt: this.commandFailureSafetyLock?.activatedAt || failedAt,
        updatedAt: failedAt,
        command: identity,
        deadLetterId,
        attempts,
        reason: evidence,
        blackApplied: false,
        lastEnforcedAt: null,
        enforcementError: null,
      };
      await this.#enforceCommandFailureSafetyLock();
    }

    if (deadLettered) {
      const deadLetter = {
        schemaVersion: 1,
        deadLetterId,
        nodeId: this.config.nodeId,
        command: identity,
        attempts,
        retryBudget: budget,
        safetyCritical,
        firstFailedAt: entry.firstFailedAt,
        lastFailedAt: failedAt,
        deadLetteredAt: failedAt,
        errors: entry.errors,
        failClosed: safetyCritical ? {
          active: true,
          blackApplied: this.commandFailureSafetyLock?.blackApplied === true,
          enforcementError: this.commandFailureSafetyLock?.enforcementError || null,
        } : null,
      };
      const pending = this.store.state.pendingCommandDeadLetters || [];
      this.store.state.pendingCommandDeadLetters = [
        ...pending.filter((item) => item.deadLetterId !== deadLetterId),
        deadLetter,
      ];
      if (this.commandFailureSafetyLock?.status === "active") {
        this.commandFailureSafetyLock.deadLetterId = deadLetterId;
      }
    }
    await this.#persist();
    return entry;
  }

  async #enforceCommandFailureSafetyLock() {
    if (this.commandFailureSafetyLock?.status !== "active") return;
    const enforcedAt = new Date().toISOString();
    this.status = NODE_STATUS.ERROR;
    try {
      await this.engine.blank(true);
      this.commandFailureSafetyLock = {
        ...this.commandFailureSafetyLock,
        updatedAt: enforcedAt,
        lastEnforcedAt: enforcedAt,
        blackApplied: true,
        enforcementError: null,
      };
    } catch (error) {
      const evidence = commandErrorEvidence(error, this.commandFailureSafetyLock.attempts || 1, enforcedAt);
      this.commandFailureSafetyLock = {
        ...this.commandFailureSafetyLock,
        updatedAt: enforcedAt,
        lastEnforcedAt: enforcedAt,
        blackApplied: false,
        enforcementError: evidence,
      };
      this.status = NODE_STATUS.ERROR;
      this.lastError = `Sticky-black enforcement failed: ${evidence.message}`;
      this.log("error", "command-dead-letter.fail-closed-enforcement-failed", evidence);
    }
  }

  async #enforceStateRecoverySafetyLock() {
    if (this.stateRecoverySafetyLock?.status !== "active") return;
    const enforcedAt = new Date().toISOString();
    this.status = NODE_STATUS.ERROR;
    try {
      await this.engine.blank(true);
      this.stateRecoverySafetyLock = {
        ...this.stateRecoverySafetyLock,
        blackApplied: true,
        lastEnforcedAt: enforcedAt,
        enforcementError: null,
      };
    } catch (error) {
      const evidence = commandErrorEvidence(error, 1, enforcedAt);
      this.stateRecoverySafetyLock = {
        ...this.stateRecoverySafetyLock,
        blackApplied: false,
        lastEnforcedAt: enforcedAt,
        enforcementError: evidence,
      };
      this.status = NODE_STATUS.ERROR;
      this.lastError = `State-recovery sticky-black enforcement failed: ${evidence.message}`;
      this.log("error", "node.state-recovery.fail-closed-enforcement-failed", evidence);
    }
  }

  async #enforceFailClosedSafetyLocks() {
    if (this.executionLeaseExpired) {
      this.status = NODE_STATUS.ERROR;
      await this.engine.blank(true);
    }
    if (this.cameraOpticalVerificationFailClosed) {
      this.status = NODE_STATUS.ERROR;
      try {
        await this.engine.blank(true);
      } catch (error) {
        this.lastError = `Optical-verification sticky-black enforcement failed: ${error.message}`;
        this.log("error", "optical-verification.fail-closed-enforcement-failed", { error: error.message });
      }
    }
    await this.#enforceCommandFailureSafetyLock();
    await this.#enforceStateRecoverySafetyLock();
    await this.#enforceServerFailClosedFence();
  }

  async #enforceServerFailClosedFence() {
    if (this.serverFailClosedFence?.status !== "active") return;
    this.status = NODE_STATUS.ERROR;
    this.cacheReady = false;
    this.bootBlackReleasePending = false;
    this.engine.discardBootBlackAuthorization?.();
    try {
      await this.engine.blank(true);
      this.lastError = `Server fail-closed fence generation ${this.serverFailClosedFence.generation} is active`;
    } catch (error) {
      this.lastError = `Server fail-closed fence black enforcement failed: ${error.message}`;
      this.log("error", "server.fail-closed-fence.enforcement-failed", {
        generation: this.serverFailClosedFence.generation,
        error: error.message,
      });
      this.connected = false;
      this.running = false;
      this.client.abort();
      const fatal = new Error(this.lastError, { cause: error });
      fatal.code = "SERVER_FAIL_CLOSED_FENCE_ENFORCEMENT_FAILED";
      throw fatal;
    }
  }

  async #acceptServerStateRecovery(input) {
    if (input == null) {
      if (this.serverStateRecovery == null) return false;
      await this.#enforceStateRecoverySafetyLock();
      return true;
    }
    const incoming = normalizeServerStateRecovery(input);
    const current = this.serverStateRecovery;
    if (current != null && (incoming.generation < current.generation
      || (incoming.generation === current.generation && !exactValueMatch(incoming, current)))) {
      await this.#enforceStateRecoverySafetyLock();
      const error = new Error("Server response rolled back or changed state-recovery authority");
      error.code = "SERVER_STATE_RECOVERY_ROLLBACK";
      throw error;
    }
    if (current != null && incoming.generation === current.generation) {
      await this.#enforceStateRecoverySafetyLock();
      return true;
    }
    this.serverStateRecovery = incoming;
    await this.#expireExecutionLease(
      `Server recovered an older state generation (${incoming.recoveryId})`,
    );
    await this.#activateStateRecoverySafetyLock(
      "SERVER_STATE_RECOVERY_REQUIRED",
      `Server recovered an older state generation ${incoming.generation} (${incoming.recoveryId}); operator reconciliation is required`,
    );
    return true;
  }

  async #acceptServerFailClosedFence(input, { serverStateRecoveryActive = false } = {}) {
    const current = this.serverFailClosedFence;
    if (input == null) {
      if (serverStateRecoveryActive) {
        if (current?.status === "active") await this.#enforceServerFailClosedFence();
        return;
      }
      if (current?.status !== "active") return;
      await this.#enforceServerFailClosedFence();
      const error = new Error("Server response removed the durable fail-closed fence");
      error.code = "SERVER_FAIL_CLOSED_FENCE_ROLLBACK";
      throw error;
    }
    const incoming = normalizeServerFailClosedFence(input);
    if (current != null) {
      if (incoming.generation < current.generation
        || (incoming.generation === current.generation && !exactValueMatch(incoming, current))) {
        if (serverStateRecoveryActive) {
          await this.#enforceServerFailClosedFence();
          return;
        }
        await this.#enforceServerFailClosedFence();
        const error = new Error("Server response rolled back or changed fail-closed fence evidence");
        error.code = "SERVER_FAIL_CLOSED_FENCE_ROLLBACK";
        throw error;
      }
      if (incoming.generation === current.generation) {
        await this.#enforceServerFailClosedFence();
        return;
      }
    }
    // Publish the authenticated intent into RAM immediately so a concurrently
    // iterating stale long-poll batch cannot enter another mutation while the
    // durable rename is in flight. The fence is persisted before this response
    // can authorize any command cursor or result acknowledgement.
    this.serverFailClosedFence = incoming;
    this.executionAuthorityEpoch += 1;
    this.store.state.serverFailClosedFence = incoming;
    this.cacheReady = false;
    this.bootBlackReleasePending = false;
    this.engine.discardBootBlackAuthorization?.();
    this.#abortInFlightCameraWork("An authenticated Server fail-closed fence superseded camera work");
    // Black is established before the first filesystem write: an injected
    // fsync/rename failure must never leave stale content visible while this
    // authenticated fence is only in RAM.
    await this.#enforceServerFailClosedFence();
    try {
      await this.#persist();
    } catch (error) {
      try {
        await this.#activateStateRecoverySafetyLock(
          "SERVER_FAIL_CLOSED_FENCE_PERSIST_FAILED",
          `Authenticated fail-closed fence could not be persisted: ${error.message}`,
        );
      } catch (recoveryError) {
        this.connected = false;
        this.running = false;
        this.client.abort();
        throw recoveryError;
      }
      throw error;
    }
  }

  #executionLeaseIsFresh(throughNs = this.clock.nowNs()) {
    if (this.executionLeaseExpired || this.executionLease == null
      || this.serverFailClosedFence?.status === "active") return false;
    return BigInt(this.executionLease.expiresAtNs) > BigInt(throughNs);
  }

  #captureBackgroundExecutionAuthority() {
    return {
      required: this.executionLeaseAuthorityRequired,
      epoch: this.executionAuthorityEpoch,
    };
  }

  #assertBackgroundExecutionAuthority(authority, ErrorType, message) {
    // Legacy tokenless protocol-v1 development peers never negotiated this
    // contract. Production Servers always do so during registration.
    if (authority?.required !== true) return;
    if (authority.epoch === this.executionAuthorityEpoch
      && this.#executionLeaseIsFresh()
      && this.serverFailClosedFence?.status !== "active") return;
    throw new ErrorType("EXECUTION_LEASE_EXPIRED", message);
  }

  async #acceptExecutionLease(input, { required = false } = {}) {
    if (this.serverStateRecovery?.status === "active") {
      this.executionLease = null;
      this.executionLeaseAuthorityRequired = true;
      if (input != null) {
        const error = new Error("Server issued an execution lease while state recovery is unresolved");
        error.code = "EXECUTION_LEASE_SERVER_RECOVERY_MISMATCH";
        throw error;
      }
      return;
    }
    if (this.serverFailClosedFence?.status === "active") {
      this.executionLease = null;
      if (input != null) {
        const error = new Error("Server issued an execution lease while a fail-closed fence is active");
        error.code = "EXECUTION_LEASE_FENCE_MISMATCH";
        throw error;
      }
      return;
    }
    if (input == null) {
      if (!required) return;
      await this.#expireExecutionLease("Server response omitted the required execution lease");
      const error = new Error("Server response omitted the required execution lease");
      error.code = "EXECUTION_LEASE_UNAVAILABLE";
      throw error;
    }
    let incoming;
    try {
      incoming = normalizeExecutionLease(input, {
        nodeId: this.config.nodeId,
        fenceGeneration: Number(this.serverFailClosedFence?.generation ?? 0),
      });
    } catch (cause) {
      await this.#expireExecutionLease(`Server execution lease is invalid: ${cause.message}`);
      const error = new Error(`Server execution lease is invalid: ${cause.message}`, { cause });
      error.code = "EXECUTION_LEASE_UNAVAILABLE";
      throw error;
    }
    const issuedAtNs = BigInt(incoming.issuedAtNs);
    const expiresAtNs = BigInt(incoming.expiresAtNs);
    if (expiresAtNs - issuedAtNs > MAX_EXECUTION_LEASE_TTL_NS
      || expiresAtNs <= this.clock.nowNs()) {
      await this.#expireExecutionLease("Server execution lease arrived expired");
      const error = new Error("Server execution lease arrived expired");
      error.code = "EXECUTION_LEASE_UNAVAILABLE";
      throw error;
    }
    if (this.executionLease != null) {
      const currentIssuedAtNs = BigInt(this.executionLease.issuedAtNs);
      if (issuedAtNs < currentIssuedAtNs) return;
      if (issuedAtNs === currentIssuedAtNs
        && !exactValueMatch(incoming, this.executionLease)) {
        await this.#expireExecutionLease("Server changed an issued execution lease");
        const error = new Error("Server changed an issued execution lease");
        error.code = "EXECUTION_LEASE_UNAVAILABLE";
        throw error;
      }
    }
    // Lease loss is a process-lifetime safety latch. A fresh response can
    // prove Server liveness again, but it cannot prove that an unabortable
    // renderer/helper mutation which crossed the old boundary has finished.
    // Keep the Show process black until its supervisor starts a fresh process.
    if (this.executionLeaseExpired) {
      this.executionLease = null;
      this.executionLeaseAuthorityRequired = true;
      return;
    }
    this.executionLease = incoming;
    if (!this.executionLeaseAuthorityRequired) this.executionLeaseExpired = false;
    this.executionLeaseAuthorityRequired = true;
  }

  async #expireExecutionLease(reason) {
    if (this.executionLeaseExpiryTask) return this.executionLeaseExpiryTask;
    if (this.executionLeaseExpired) {
      this.executionLease = null;
      await this.engine.blank(true);
      return;
    }
    const task = (async () => {
      this.executionAuthorityEpoch += 1;
      this.executionLease = null;
      this.executionLeaseAuthorityRequired = true;
      this.executionLeaseExpired = true;
      this.status = NODE_STATUS.ERROR;
      this.lastError = String(reason).slice(0, 2_048);
      this.#abortInFlightCameraWork(this.lastError);
      try {
        // Establish black before cursor/transport persistence. A failed write
        // or concurrent stale command therefore cannot leave content visible.
        await this.engine.blank(true);
      } catch (cause) {
        this.connected = false;
        this.running = false;
        this.client.abort();
        const error = new Error(`Execution lease expired and black could not be enforced: ${cause.message}`, { cause });
        error.code = "EXECUTION_LEASE_BLACK_ENFORCEMENT_FAILED";
        throw error;
      }
      clearTimeout(this.frameTimer);
      for (const [id, timer] of this.actionTimers) {
        clearTimeout(timer);
        this.actionTimers.delete(id);
      }
      this.store.state.pendingActions = [];
      this.scheduler.pause(0n);
      this.scheduler.state = "idle";
      this.scheduler.startNs = null;
      this.lastDispatchedFrame = null;
      await this.#persist();
    })();
    this.executionLeaseExpiryTask = task;
    try {
      await task;
    } finally {
      if (this.executionLeaseExpiryTask === task) this.executionLeaseExpiryTask = null;
    }
  }

  #abortInFlightCameraWork(reason) {
    const calibrationError = new CameraCalibrationError(
      "EXECUTION_LEASE_EXPIRED",
      String(reason).slice(0, 2_048),
    );
    const opticalError = new CameraOpticalVerificationError(
      "EXECUTION_LEASE_EXPIRED",
      String(reason).slice(0, 2_048),
    );
    this.cameraCalibrationAbort?.abort(calibrationError);
    this.cameraOpticalVerificationAbort?.abort(opticalError);
    for (const controller of this.executionCommandAbortControllers) {
      controller.abort(calibrationError);
    }
    this.#rejectCameraConfirmation(calibrationError);
    this.#rejectCameraOpticalVerificationConfirmation(opticalError);
  }

  async #renewExecutionLease(throughNs = this.clock.nowNs()) {
    const publicationPayload = this.#heartbeatPayload();
    try {
      const response = await this.client.heartbeat(publicationPayload);
      await this.#consumeHeartbeatResponse(response, {
        publishedCameraCalibration: publicationPayload.telemetry?.cameraCalibration || null,
      });
    } catch (cause) {
      if (this.serverFailClosedFence?.status !== "active") {
        await this.#expireExecutionLease(`Execution lease renewal failed: ${cause.message}`);
      }
      const error = new Error(`Execution lease renewal failed: ${cause.message}`, { cause });
      error.code = this.serverFailClosedFence?.status === "active"
        ? "SERVER_FAIL_CLOSED_FENCE_ACTIVE"
        : "EXECUTION_LEASE_UNAVAILABLE";
      throw error;
    }
    if (!this.#executionLeaseIsFresh()) {
      await this.#expireExecutionLease("Execution lease renewal did not produce a fresh lease");
      const error = new Error("Execution lease renewal did not produce a fresh lease");
      error.code = "EXECUTION_LEASE_UNAVAILABLE";
      throw error;
    }
    if (!this.#executionLeaseIsFresh(throughNs)) {
      const error = new Error("Scheduled command lies beyond the current execution lease horizon");
      error.code = "EXECUTION_LEASE_HORIZON_PENDING";
      throw error;
    }
    return this.executionLease;
  }

  async #deliverPendingCommandDeadLetters() {
    const pending = this.store.snapshot().pendingCommandDeadLetters || [];
    if (pending.length === 0) return;
    const publicationPayload = this.#heartbeatPayload();
    publicationPayload.actionResults = [];
    publicationPayload.cameraOpticalVerification = null;
    publicationPayload.telemetry.cameraCalibration = null;
    const response = await this.client.heartbeat(publicationPayload);
    this.#acceptServerTime(response?.serverTimeNs);
    const acknowledged = Array.isArray(response?.acknowledgedCommandDeadLetters)
      ? response.acknowledgedCommandDeadLetters
      : (response?.acknowledgedCommandDeadLetterIds || []).map((deadLetterId) => ({ deadLetterId }));
    const byId = new Map(acknowledged.map((item) => [String(item?.deadLetterId || item), item]));
    const missing = pending.filter((item) => !byId.has(item.deadLetterId));
    if (missing.length > 0) {
      throw new Error(`Server did not durably acknowledge command dead-letter ${missing[0].deadLetterId}`);
    }

    const current = this.store.state.pendingCommandDeadLetters || [];
    const acknowledgedIds = new Set(pending.map((item) => item.deadLetterId));
    const receiptCandidates = current
      .filter((item) => acknowledgedIds.has(item.deadLetterId))
      .map((deadLetter) => {
        const serverEvidence = byId.get(deadLetter.deadLetterId);
        return {
          schemaVersion: 1,
          status: "server-accepted-awaiting-cursor-ack",
          deadLetterId: deadLetter.deadLetterId,
          command: deadLetter.command,
          serverReceivedAt: String(serverEvidence?.receivedAt || ""),
        };
      });
    const retainedReceipts = this.store.state.commandDeadLetterReceipts || [];
    const receiptById = new Map(retainedReceipts.map((receipt) => [receipt.deadLetterId, receipt]));
    for (const receipt of receiptCandidates) {
      const previous = receiptById.get(receipt.deadLetterId);
      if (previous != null && !exactValueMatch(previous, receipt)) {
        throw new Error(`Server changed command dead-letter receipt ${receipt.deadLetterId}`);
      }
      receiptById.set(receipt.deadLetterId, receipt);
    }
    const nextReceipts = [...receiptById.values()]
      .sort((left, right) => left.command.sequence - right.command.sequence);
    if (nextReceipts.length > 32) {
      throw new Error("Command dead-letter receipt outbox exceeds its durable capacity");
    }
    for (const deadLetter of current.filter((item) => acknowledgedIds.has(item.deadLetterId))) {
      const serverEvidence = byId.get(deadLetter.deadLetterId);
      const key = `sequence:${deadLetter.command.sequence}`;
      const failure = this.store.state.commandFailures?.[key];
      if (failure?.deadLetterId === deadLetter.deadLetterId) {
        this.store.state.commandFailures[key] = {
          ...failure,
          status: "dead-lettered",
          serverAcknowledgedAt: String(serverEvidence?.receivedAt || new Date().toISOString()),
          updatedAt: new Date().toISOString(),
        };
      }
      this.store.state.lastSequence = Math.max(
        this.store.state.lastSequence,
        Number(deadLetter.command.sequence),
      );
    }
    this.store.state.commandDeadLetterReceipts = nextReceipts;
    this.store.state.pendingCommandDeadLetters = current
      .filter((item) => !acknowledgedIds.has(item.deadLetterId));
    // This atomic local commit is deliberately after the durable Server ack.
    // If rename/disk flush fails, the old pending evidence is replayed and the
    // Server responds idempotently without reintroducing the poisoned command.
    await this.#persist();
    await this.#consumeHeartbeatResponse(response, {
      commandDeadLettersAlreadyApplied: true,
      // This publication deliberately withheld camera-calibration evidence;
      // never consume a stray/stale calibration ACK from it.
      publishedCameraCalibration: null,
    });
  }

  async #consumeHeartbeatResponse(response, {
    commandDeadLettersAlreadyApplied = false,
    publishedCameraCalibration = null,
  } = {}) {
    this.#acceptServerTime(response?.serverTimeNs);
    const serverStateRecoveryActive = await this.#acceptServerStateRecovery(
      response?.serverStateRecovery,
    );
    await this.#acceptServerFailClosedFence(response?.failClosedFence, {
      serverStateRecoveryActive,
    });
    await this.#acceptExecutionLease(response?.executionLease, {
      required: this.executionLeaseAuthorityRequired,
    });
    if (!commandDeadLettersAlreadyApplied && (this.store.snapshot().pendingCommandDeadLetters || []).length > 0) {
      // A generic heartbeat must not use an acknowledgement to advance the
      // ordered cursor. Publication always flows through the atomic hand-off
      // above, which verifies every retained id first.
      return;
    }
    await this.#acknowledgeCommandDeadLetterReceipts(response?.ackSequence);
    await this.#acknowledgeActionResults(response?.acknowledgedActionResultIds);
    await this.#acknowledgeCameraCalibration(
      response?.acknowledgedCameraCalibrationId,
      publishedCameraCalibration,
    );
    await this.#acknowledgeCameraOpticalVerification(response?.acknowledgedCameraOpticalVerificationId);
  }

  async #acknowledgeCommandDeadLetterReceipts(ackSequenceInput) {
    const ackSequence = Number(ackSequenceInput);
    if (!Number.isSafeInteger(ackSequence) || ackSequence < 0) return;
    const previous = this.store.state.commandDeadLetterReceipts || [];
    const remaining = previous.filter((receipt) => receipt.command.sequence > ackSequence);
    if (remaining.length === previous.length) return;
    this.store.state.commandDeadLetterReceipts = remaining;
    await this.#persist();
  }

  async #settleCommandDeadLetterReceipts(serverAckSequenceInput) {
    await this.#acknowledgeCommandDeadLetterReceipts(serverAckSequenceInput);
    const retained = this.store.snapshot().commandDeadLetterReceipts || [];
    if (retained.length === 0) return;
    const publicationPayload = this.#heartbeatPayload();
    publicationPayload.commandDeadLetters = [];
    const response = await this.client.heartbeat(publicationPayload);
    await this.#consumeHeartbeatResponse(response, {
      publishedCameraCalibration: publicationPayload.telemetry?.cameraCalibration || null,
    });
    const maxSequence = retained.at(-1).command.sequence;
    if (Number(response?.ackSequence) < maxSequence
      || (this.store.snapshot().commandDeadLetterReceipts || []).length > 0) {
      const error = new Error(
        `Server did not durably advance its acknowledgement across accepted command dead-letter ${retained.at(-1).deadLetterId}`,
      );
      error.code = "COMMAND_DEAD_LETTER_CURSOR_HANDOFF_INCOMPLETE";
      throw error;
    }
  }

  async #acknowledgeActionResults(input) {
    if (!Array.isArray(input) || input.length === 0) return;
    const acknowledged = new Set(input.slice(0, 256).map(String));
    const previous = this.store.state.actionResults || [];
    const remaining = previous.filter((result) => !acknowledged.has(String(result.resultId)));
    if (remaining.length === previous.length) return;
    this.store.state.actionResults = remaining;
    await this.#persist();
  }

  async #acknowledgeCameraCalibration(sessionIdInput, publishedReportInput) {
    const sessionId = sessionIdInput == null ? "" : String(sessionIdInput);
    if (!sessionId || this.cameraCalibration?.sessionId !== sessionId
      || !TERMINAL_CAMERA_CALIBRATION_STATES.has(this.cameraCalibration.state)
      || this.cameraCalibrationReportAcknowledged) return;
    if (!publishedReportInput || publishedReportInput.sessionId !== sessionId) return;

    const calibrationBeforeAcknowledgement = this.cameraCalibration;
    const expectedPublishedReport = canonicalCameraCalibrationReport(calibrationBeforeAcknowledgement);
    const publishedReport = jsonSafe(publishedReportInput);
    if (!exactValueMatch(publishedReport, expectedPublishedReport)) {
      // An ACK is meaningful only for the exact canonical report included in
      // this HTTP request. A stale response must never compact newer evidence.
      return;
    }
    const acknowledgement = createCameraCalibrationAcknowledgement({
      calibration: calibrationBeforeAcknowledgement,
      publishedReport,
      acknowledgedAt: new Date().toISOString(),
    });

    // Commit the compact calibration and exact receipt together. Runtime flags
    // remain unchanged until fsync + atomic rename succeed, so a failed/lost
    // local commit continues publishing the original full report and patch.
    this.cameraCalibrationAcknowledgementPending = acknowledgement;
    try {
      try {
        await this.#persist({
          cameraCalibration: acknowledgement.calibration,
          cameraCalibrationAcknowledgementReceipt: acknowledgement.receipt,
        });
      } catch (error) {
        // Another in-scope state commit may have carried the same pending
        // receipt after this particular write failed. Wait for the store queue
        // and accept that path only when both compact state and receipt match.
        await this.store.flush().catch(() => {});
        const durable = this.store.snapshot();
        if (!exactValueMatch(durable.cameraCalibration, acknowledgement.calibration)
          || !exactValueMatch(
            durable.cameraCalibrationAcknowledgementReceipt,
            acknowledgement.receipt,
          )) throw error;
      }
      if (this.cameraCalibration === calibrationBeforeAcknowledgement
        || exactValueMatch(this.cameraCalibration, calibrationBeforeAcknowledgement)) {
        this.cameraCalibration = acknowledgement.calibration;
        this.cameraCalibrationAcknowledgementReceipt = acknowledgement.receipt;
        this.cameraCalibrationPatchAcknowledged = acknowledgement.receipt.projectPatchAcknowledged;
        this.cameraCalibrationReportAcknowledged = true;
      }
    } finally {
      if (this.cameraCalibrationAcknowledgementPending === acknowledgement) {
        this.cameraCalibrationAcknowledgementPending = null;
      }
    }
  }

  async #acknowledgeCameraOpticalVerification(verificationIdInput) {
    const verificationId = verificationIdInput == null ? "" : String(verificationIdInput);
    if (!verificationId
      || this.cameraOpticalVerification?.verificationId !== verificationId
      || !TERMINAL_CAMERA_OPTICAL_VERIFICATION_STATES.has(this.cameraOpticalVerification.state)
      || this.cameraOpticalVerificationReportAcknowledged) return;
    // Only retransmission is acknowledged. The strict state, report, plan and
    // sticky-black ownership survive because a later RESTORE command is bound
    // to this exact lease and must emit a fresh rolled-back terminal state.
    this.cameraOpticalVerificationReportAcknowledged = true;
    await this.#persist();
  }

  async #persist(overrides = {}) {
    const hasCalibrationOverride = Object.prototype.hasOwnProperty.call(overrides, "cameraCalibration");
    const hasReceiptOverride = Object.prototype.hasOwnProperty.call(
      overrides,
      "cameraCalibrationAcknowledgementReceipt",
    );
    if (this.cameraOpticalVerificationConfirmationReceipt?.sequence <= this.store.state.lastSequence) {
      this.cameraOpticalVerificationConfirmationReceipt = null;
    }
    if (this.cameraOpticalVerificationRestoreReceipt?.sequence <= this.store.state.lastSequence) {
      this.cameraOpticalVerificationRestoreReceipt = null;
    }
    let cameraCalibration = hasCalibrationOverride
      ? overrides.cameraCalibration
      : this.cameraCalibration;
    let cameraCalibrationAcknowledgementReceipt = hasReceiptOverride
      ? overrides.cameraCalibrationAcknowledgementReceipt
      : this.cameraCalibrationAcknowledgementReceipt;

    // A concurrent save that begins after the Server ACK carries the same
    // pending compact state. NodeStateStore's latest-request rule then prevents
    // an older commit completion from erasing that concurrent caller's draft.
    const pending = this.cameraCalibrationAcknowledgementPending;
    if (!hasCalibrationOverride && !hasReceiptOverride
      && pending != null
      && cameraCalibration?.sessionId === pending.calibration.sessionId) {
      cameraCalibration = pending.calibration;
      cameraCalibrationAcknowledgementReceipt = pending.receipt;
    }
    const durable = this.store.snapshot();
    const durableReceipt = durable.cameraCalibrationAcknowledgementReceipt;
    if (!hasCalibrationOverride && !hasReceiptOverride
      && cameraCalibrationAcknowledgementReceipt == null
      && durableReceipt != null
      && durable.cameraCalibration?.sessionId === cameraCalibration?.sessionId) {
      cameraCalibration = durable.cameraCalibration;
      cameraCalibrationAcknowledgementReceipt = durableReceipt;
    }
    await this.store.save({
      ...this.store.state,
      transport: transportSnapshot(this.scheduler),
      preparedAssetSha256: this.preparedAssetSha256,
      cameraCalibration,
      cameraCalibrationAcknowledgementReceipt,
      cameraSurveyPreviewReport: this.cameraSurveyPreviewReport,
      lastCameraSurveyPreview: this.lastCameraSurveyPreview,
      cameraOpticalVerification: this.cameraOpticalVerification,
      cameraOpticalVerificationPlan: this.cameraOpticalVerificationPlan,
      cameraOpticalVerificationConfirmationReceipt: this.cameraOpticalVerificationConfirmationReceipt,
      cameraOpticalVerificationRestoreReceipt: this.cameraOpticalVerificationRestoreReceipt,
      cameraOpticalVerificationReportAcknowledged: this.cameraOpticalVerificationReportAcknowledged,
      cameraOpticalVerificationFailClosed: this.cameraOpticalVerificationFailClosed,
      commandFailureSafetyLock: this.commandFailureSafetyLock,
      stateRecoverySafetyLock: this.stateRecoverySafetyLock,
      serverFailClosedFence: this.serverFailClosedFence,
    });
  }

  diagnostics() {
    return jsonSafe({
      nodeId: this.config.nodeId,
      name: this.config.name,
      status: this.status,
      connected: this.connected,
      serverUrl: this.config.serverUrl,
      ackSequence: this.store.state.lastSequence,
      projectRevision: this.store.state.project?.revision || null,
      cacheReady: this.cacheReady === true,
      bootBlackReleasePending: this.bootBlackReleasePending === true,
      transport: this.scheduler.snapshot(),
      clock: { ...this.estimator.snapshot(), ...this.clock.snapshot() },
      cache: this.cache.snapshot(),
      cameraCalibrationManifestArchive: this.cameraCalibrationManifestArchive.summary(),
      render: this.engine.diagnostics(),
      host: this.hostSnapshot,
      displayConfig: this.hostActions.displayStore?.snapshot?.() || null,
      displayConfigRecovery: this.displayConfigRecovery,
      display: this.#displayHostSnapshot(),
      actionResults: this.store.state.actionResults || [],
      commandFailures: this.store.state.commandFailures || {},
      pendingCommandDeadLetters: this.store.state.pendingCommandDeadLetters || [],
      commandDeadLetterReceipts: this.store.state.commandDeadLetterReceipts || [],
      commandFailureSafetyLock: this.commandFailureSafetyLock,
      stateRecoverySafetyLock: this.stateRecoverySafetyLock,
      serverFailClosedFence: this.serverFailClosedFence,
      cameraCalibration: this.#cameraCalibrationTelemetry(),
      cameraOpticalVerification: this.cameraOpticalVerification,
      cameraOpticalVerificationReportAcknowledged: this.cameraOpticalVerificationReportAcknowledged,
      cameraOpticalVerificationFailClosed: this.cameraOpticalVerificationFailClosed,
      cameraSurveyPreview: this.cameraSurveyPreviewReport
        ? compactCameraSurveyPreviewReport(this.cameraSurveyPreviewReport)
        : this.lastCameraSurveyPreview,
      hostControl: {
        dryRun: this.hostActions.dryRun,
        powerActions: this.hostActions.allowPowerActions,
        xrandrFallback: this.hostActions.allowXrandrFallback,
      },
      metrics: this.metrics,
      error: this.lastError,
    });
  }
}
