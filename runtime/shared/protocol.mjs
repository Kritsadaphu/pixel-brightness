import { normalizeOutputConfig } from "./mapping.mjs";
import { defaultCompositionSource, normalizeCompositionSource } from "./composition-source.mjs";
import {
  normalizeSurfaceId,
  normalizeSurfaceTopology,
  resolveSurfaceMembership,
} from "./surface-model.mjs";

export const PROTOCOL_VERSION = 1;
// The wire protocol remains compatible, but an optical-verification plan is a
// versioned scientific contract. V3 adds a fail-closed rollback trigger that
// distinguishes conclusive gate failure from operator cancellation. Older
// peers must not treat cancellation as permission to release unverified
// correction content.
export const CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION = 3;
export const SOFTWARE_VERSION = "0.3.0";
export const MAX_OUTPUTS_PER_PROJECT = 256;
export const MAX_SURFACES_PER_PROJECT = 128;
// Compatibility export for peers that still name physical surfaces `walls`.
export const MAX_WALLS_PER_PROJECT = MAX_SURFACES_PER_PROJECT;
export const MAX_OUTPUTS_PER_RENDER_NODE = 32;
export const EXECUTION_LEASE_SCHEMA_VERSION = 1;
export const MAX_EXECUTION_LEASE_TTL_NS = 5_000_000_000n;
export const SERVER_STATE_RECOVERY_SCHEMA_VERSION = 1;

// Retained only as the unversioned-project compatibility fixture. Surface
// validation and membership semantics do not depend on this physical name.
const LEGACY_DEFAULT_SURFACE = Object.freeze({ id: "wall-north", name: "North wall" });

export const NODE_STATUS = Object.freeze({
  OFFLINE: "offline",
  CONNECTING: "connecting",
  IDLE: "idle",
  SYNCING: "syncing",
  PREROLLING: "prerolling",
  READY: "ready",
  PLAYING: "playing",
  PAUSED: "paused",
  DEGRADED: "degraded",
  ERROR: "error",
});

export const COMMAND = Object.freeze({
  SYNC_PROJECT: "sync-project",
  PREPARE: "prepare",
  PLAY_AT: "play-at",
  PAUSE_AT: "pause-at",
  SEEK_AT: "seek-at",
  STOP: "stop",
  APPLY_OUTPUT: "apply-output",
  IDENTIFY_OUTPUT: "identify-output",
  CALIBRATION_PATTERN: "calibration-pattern",
  CAPTURE_CAMERA_SURVEY_PREVIEW: "capture-camera-survey-preview",
  START_CAMERA_CALIBRATION: "start-camera-calibration",
  CONFIRM_CAMERA_CALIBRATION: "confirm-camera-calibration",
  CANCEL_CAMERA_CALIBRATION: "cancel-camera-calibration",
  START_CAMERA_OPTICAL_VERIFICATION: "start-camera-optical-verification",
  CONFIRM_CAMERA_OPTICAL_VERIFICATION: "confirm-camera-optical-verification",
  CANCEL_CAMERA_OPTICAL_VERIFICATION: "cancel-camera-optical-verification",
  RESTORE_AFTER_CAMERA_ROLLBACK: "restore-after-camera-rollback",
  RESTART_ENGINE: "restart-engine",
  HOST_ACTION: "HOST_ACTION",
});

const SAFETY_CRITICAL_COMMAND_TYPES = new Set([
  COMMAND.SYNC_PROJECT,
  COMMAND.PREPARE,
  COMMAND.PLAY_AT,
  COMMAND.PAUSE_AT,
  COMMAND.SEEK_AT,
  COMMAND.STOP,
  COMMAND.APPLY_OUTPUT,
  COMMAND.CALIBRATION_PATTERN,
  COMMAND.CAPTURE_CAMERA_SURVEY_PREVIEW,
  COMMAND.START_CAMERA_CALIBRATION,
  COMMAND.CONFIRM_CAMERA_CALIBRATION,
  COMMAND.CANCEL_CAMERA_CALIBRATION,
  COMMAND.START_CAMERA_OPTICAL_VERIFICATION,
  COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION,
  COMMAND.CANCEL_CAMERA_OPTICAL_VERIFICATION,
  COMMAND.RESTORE_AFTER_CAMERA_ROLLBACK,
]);

/**
 * Commands which can leave calibration light or unverified correction content
 * on a physical output must fail closed. Camera-driven project sync commands
 * carry a Server-authored reason, so an ordinary editorial sync is not
 * needlessly classified as a safety operation.
 */
export function isSafetyCriticalCommand(command) {
  const type = String(command?.type ?? "");
  if (SAFETY_CRITICAL_COMMAND_TYPES.has(type)) return true;
  return false;
}

export function normalizeExecutionLease(input, {
  nodeId: expectedNodeId = null,
  fenceGeneration: expectedFenceGeneration = null,
} = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Execution lease must be an object");
  }
  const expectedKeys = [
    "expiresAtNs", "fenceGeneration", "issuedAtNs", "leaseId", "nodeId", "schemaVersion",
  ];
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Execution lease contains missing or unsupported fields");
  }
  if (input.schemaVersion !== EXECUTION_LEASE_SCHEMA_VERSION) {
    throw new Error("Execution lease schema is unsupported");
  }
  const nodeId = String(input.nodeId || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(nodeId)
    || (expectedNodeId != null && nodeId !== expectedNodeId)) {
    throw new Error("Execution lease nodeId is invalid");
  }
  const leaseId = String(input.leaseId || "");
  if (!/^execution_lease_[a-f0-9]{32}$/.test(leaseId)) {
    throw new Error("Execution lease id is invalid");
  }
  const fenceGeneration = Number(input.fenceGeneration);
  if (!Number.isSafeInteger(fenceGeneration) || fenceGeneration < 0
    || (expectedFenceGeneration != null && fenceGeneration !== expectedFenceGeneration)) {
    throw new Error("Execution lease fence generation is invalid");
  }
  const canonicalInteger = (value, field) => {
    if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new Error(`Execution lease ${field} is not a canonical integer`);
    }
    return BigInt(value);
  };
  const issuedAtNs = canonicalInteger(input.issuedAtNs, "issuedAtNs");
  const expiresAtNs = canonicalInteger(input.expiresAtNs, "expiresAtNs");
  if (expiresAtNs <= issuedAtNs || expiresAtNs - issuedAtNs > MAX_EXECUTION_LEASE_TTL_NS) {
    throw new Error("Execution lease lifetime is invalid");
  }
  return {
    schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
    leaseId,
    nodeId,
    fenceGeneration,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: expiresAtNs.toString(),
  };
}

export function normalizeServerStateRecovery(input) {
  if (input == null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Server state-recovery marker must be an object");
  }
  const expectedKeys = [
    "detectedAt",
    "generation",
    "recoveredStateSha256",
    "recoveredStateUpdatedAt",
    "recoveryId",
    "reason",
    "schemaVersion",
    "status",
  ].sort();
  const keys = Object.keys(input).sort();
  if (keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Server state-recovery marker contains missing or unsupported fields");
  }
  if (input.schemaVersion !== SERVER_STATE_RECOVERY_SCHEMA_VERSION || input.status !== "active") {
    throw new Error("Server state-recovery marker schema or status is invalid");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("Server state-recovery generation is invalid");
  }
  const recoveryId = String(input.recoveryId || "");
  if (!/^server_state_recovery_[a-f0-9]{32}$/.test(recoveryId)) {
    throw new Error("Server state-recovery id is invalid");
  }
  const reason = String(input.reason || "");
  if (!["primary-missing-lkg-rollback", "primary-invalid-lkg-rollback"].includes(reason)) {
    throw new Error("Server state-recovery reason is invalid");
  }
  const canonicalTimestamp = (value, field) => {
    if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
      throw new Error(`Server state-recovery ${field} is invalid`);
    }
    return value;
  };
  const detectedAt = canonicalTimestamp(input.detectedAt, "detectedAt");
  const recoveredStateUpdatedAt = canonicalTimestamp(
    input.recoveredStateUpdatedAt,
    "recoveredStateUpdatedAt",
  );
  const recoveredStateSha256 = String(input.recoveredStateSha256 || "");
  if (!/^[a-f0-9]{64}$/.test(recoveredStateSha256)) {
    throw new Error("Server state-recovery state digest is invalid");
  }
  return {
    schemaVersion: SERVER_STATE_RECOVERY_SCHEMA_VERSION,
    status: "active",
    generation: input.generation,
    recoveryId,
    detectedAt,
    reason,
    recoveredStateUpdatedAt,
    recoveredStateSha256,
  };
}

export const HOST_ACTION_TYPE = Object.freeze({
  APPLY_DISPLAY_CONFIG: "APPLY_DISPLAY_CONFIG",
  RESTART_RENDERER: "RESTART_RENDERER",
  RESTART_NODE: "RESTART_NODE",
  REBOOT_HOST: "REBOOT_HOST",
  SHUTDOWN_HOST: "SHUTDOWN_HOST",
  COLLECT_DIAGNOSTICS: "COLLECT_DIAGNOSTICS",
});

export const NATIVE_PATTERN_TYPE = Object.freeze({
  CONTENT: "content",
  BLACK: "black",
  WHITE: "white",
  GRAY: "gray",
  RED: "red",
  GREEN: "green",
  BLUE: "blue",
  GRID: "grid",
  IDENTIFY: "identify",
  SOLID: "solid",
  GRAY_CODE: "gray-code",
});

const NATIVE_PATTERN_TYPES = new Set(Object.values(NATIVE_PATTERN_TYPE));

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Canonical cross-process pattern command. Corrected output is deliberately
 * restricted to an explicit linear-RGB solid: geometry/Gray-code/identify
 * patterns must remain raw so they cannot silently measure an old correction.
 */
export function normalizeNativePatternCommand(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Native pattern command must be an object");
  }
  const enabled = input.enabled !== false;
  const type = enabled
    ? String(input.type || NATIVE_PATTERN_TYPE.GRID).trim().toLowerCase()
    : NATIVE_PATTERN_TYPE.CONTENT;
  if (!NATIVE_PATTERN_TYPES.has(type)) {
    throw new Error(`Unsupported native pattern mode: ${type}`);
  }

  const outputId = input.outputId == null ? null : String(input.outputId).trim();
  if (outputId != null && (outputId.length < 1 || outputId.length > 64)) {
    throw new Error("Native pattern outputId must be 1-64 characters");
  }
  const result = {
    ...(outputId ? { outputId } : {}),
    enabled: type !== NATIVE_PATTERN_TYPE.CONTENT,
    type,
  };

  const hasCorrectionRequest = hasOwn(input, "applyCorrections");
  if (hasCorrectionRequest && type !== NATIVE_PATTERN_TYPE.SOLID) {
    throw new Error("applyCorrections is only valid for a solid native pattern");
  }
  if (hasCorrectionRequest && typeof input.applyCorrections !== "boolean") {
    throw new Error("applyCorrections must be boolean");
  }

  if (type === NATIVE_PATTERN_TYPE.SOLID) {
    if (!Array.isArray(input.rgb) || input.rgb.length !== 3) {
      throw new Error("Solid native pattern requires three linear RGB channels");
    }
    const rgb = input.rgb.map(Number);
    if (rgb.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
      throw new Error("Solid native pattern RGB channels must be finite and in the 0-1 range");
    }
    result.rgb = rgb;
    result.applyCorrections = input.applyCorrections === true;
  } else if (hasOwn(input, "rgb")) {
    throw new Error("rgb is only valid for a solid native pattern");
  }

  if (type === NATIVE_PATTERN_TYPE.GRAY_CODE) {
    if (input.axis !== "x" && input.axis !== "y") {
      throw new Error("Gray-code native pattern axis must be x or y");
    }
    const bit = Number(input.bit);
    if (!Number.isSafeInteger(bit) || bit < 0 || bit > 31) {
      throw new Error("Gray-code native pattern bit must be an integer from 0 to 31");
    }
    if (hasOwn(input, "inverse") && typeof input.inverse !== "boolean") {
      throw new Error("Gray-code native pattern inverse must be boolean");
    }
    result.axis = input.axis;
    result.bit = bit;
    result.inverse = input.inverse === true;
  } else if (hasOwn(input, "axis") || hasOwn(input, "bit") || hasOwn(input, "inverse")) {
    throw new Error("axis, bit and inverse are only valid for a Gray-code native pattern");
  }

  if ([NATIVE_PATTERN_TYPE.GRID, NATIVE_PATTERN_TYPE.IDENTIFY].includes(type)) {
    const numeric = Number(input.cellSize ?? 32);
    result.cellSize = Number.isFinite(numeric)
      ? Math.max(2, Math.min(1_024, Math.round(numeric)))
      : 32;
  }
  return result;
}

export function makeId(prefix = "id") {
  const randomPart = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
}

export function createCommand(type, payload = {}, options = {}) {
  if (!Object.values(COMMAND).includes(type)) {
    throw new Error(`Unsupported command type: ${type}`);
  }

  const normalizedPayload = type === COMMAND.CALIBRATION_PATTERN
    ? normalizeNativePatternCommand(payload)
    : type === COMMAND.IDENTIFY_OUTPUT
      ? normalizeNativePatternCommand({ ...payload, enabled: true, type: NATIVE_PATTERN_TYPE.IDENTIFY })
      : type === COMMAND.START_CAMERA_OPTICAL_VERIFICATION
        ? normalizeCameraOpticalVerificationStartPayload(payload)
        : type === COMMAND.CONFIRM_CAMERA_OPTICAL_VERIFICATION
          ? normalizeCameraOpticalVerificationConfirmationPayload(payload)
          : payload;

  return {
    protocolVersion: PROTOCOL_VERSION,
    id: options.id ?? makeId("cmd"),
    sequence: options.sequence ?? 0,
    type,
    createdAtNs: options.createdAtNs ?? null,
    effectiveAtNs: options.effectiveAtNs ?? null,
    payload: normalizedPayload,
  };
}

function normalizeCameraOpticalVerificationStartPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.prototype.hasOwnProperty.call(input, "plan")
    || !input.plan || typeof input.plan !== "object" || Array.isArray(input.plan)) {
    throw new Error("Optical-verification start payload must contain exactly one plan");
  }
  if (input.plan.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION) {
    throw new Error(
      `Optical-verification plan schema mismatch. Expected ${CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION}`,
    );
  }
  return { plan: input.plan };
}

function normalizeCameraOpticalVerificationConfirmationPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || input.schemaVersion !== CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION) {
    throw new Error(
      `Optical-verification confirmation schema mismatch. Expected ${CAMERA_OPTICAL_VERIFICATION_PROTOCOL_SCHEMA_VERSION}`,
    );
  }
  return input;
}

export function defaultOutput(id, connector = `DISPLAY-${id}`) {
  return {
    id,
    name: `Projector ${id}`,
    connector,
    nodeId: null,
    enabled: true,
    wallId: LEGACY_DEFAULT_SURFACE.id,
    resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 },
    overlap: { left: 0, right: 240, top: 0, bottom: 0 },
    warp: { columns: 32, rows: 18, interpolation: "bicubic", points: null },
    blend: { enabled: true, feather: 0.78, gamma: 2.2 },
    blackUniformity: { enabled: true, lift: 0.12, map: null },
    mask: { enabled: false, map: null, path: null, softness: 0 },
    color: { gain: [1, 1, 1], offset: [0, 0, 0], gamma: [1, 1, 1], lut: null },
  };
}

export function defaultProject() {
  const canvas = { width: 5280, height: 1080, frameRateNum: 60, frameRateDen: 1 };
  return {
    protocolVersion: PROTOCOL_VERSION,
    id: "project-default",
    revision: 1,
    name: "Pixel Brightness Room",
    canvas,
    compositionSource: defaultCompositionSource(canvas),
    walls: [{ ...LEGACY_DEFAULT_SURFACE }],
    outputs: [
      { ...defaultOutput("A", "DP-1"), sourceViewport: { x: 0, y: 0, width: 1920, height: 1080 } },
      { ...defaultOutput("B", "DP-2"), sourceViewport: { x: 1680, y: 0, width: 1920, height: 1080 }, overlap: { left: 240, right: 240, top: 0, bottom: 0 } },
      { ...defaultOutput("C", "DP-3"), sourceViewport: { x: 3360, y: 0, width: 1920, height: 1080 }, overlap: { left: 240, right: 0, top: 0, bottom: 0 } },
    ],
    timeline: { cues: [] },
    updatedAt: new Date().toISOString(),
  };
}

export function assertProtocolVersion(value) {
  if (value !== PROTOCOL_VERSION) {
    throw new Error(`Protocol version mismatch. Expected ${PROTOCOL_VERSION}, received ${value}`);
  }
}

function registrationText(value, field, { fallback = null, maximum = 128, nullable = false } = {}) {
  const candidate = value == null ? fallback : value;
  if (candidate == null && nullable) return null;
  const hasControl = typeof candidate === "string" && [...candidate].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > maximum
    || candidate.trim() !== candidate || hasControl) {
    throw new Error(`${field} must be canonical text no longer than ${maximum} characters`);
  }
  return candidate;
}

function normalizeRegistrationOutput(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`capabilities.outputs[${index}] must be an object`);
  }
  const allowed = new Set(["id", "name", "connector", "resolution"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`capabilities.outputs[${index}] contains unknown fields: ${unknown.join(", ")}`);
  const id = registrationText(input.id, `capabilities.outputs[${index}].id`, { maximum: 64 });
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`capabilities.outputs[${index}].id is invalid`);
  let resolution = null;
  if (input.resolution != null) {
    const value = input.resolution;
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "height,refreshDen,refreshNum,width") {
      throw new Error(`capabilities.outputs[${index}].resolution must be canonical`);
    }
    const fields = {
      width: [1, 16_384], height: [1, 16_384], refreshNum: [1, 240_000], refreshDen: [1, 100_000],
    };
    for (const [key, [minimum, maximum]] of Object.entries(fields)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) {
        throw new Error(`capabilities.outputs[${index}].resolution.${key} is invalid`);
      }
    }
    resolution = { width: value.width, height: value.height, refreshNum: value.refreshNum, refreshDen: value.refreshDen };
  }
  return {
    id,
    name: registrationText(input.name, `capabilities.outputs[${index}].name`, { fallback: id, maximum: 128 }),
    connector: registrationText(input.connector, `capabilities.outputs[${index}].connector`, {
      fallback: `DISPLAY-${id}`,
      maximum: 128,
    }),
    resolution,
  };
}

export function normalizeRegistration(input) {
  assertProtocolVersion(input?.protocolVersion);
  const nodeId = registrationText(input?.nodeId, "nodeId", { maximum: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(nodeId)) throw new Error("nodeId is invalid");
  const rawOutputs = input.capabilities?.outputs ?? [];
  if (!Array.isArray(rawOutputs) || rawOutputs.length > MAX_OUTPUTS_PER_RENDER_NODE) {
    throw new Error(`capabilities.outputs must contain at most ${MAX_OUTPUTS_PER_RENDER_NODE} outputs`);
  }
  const outputs = rawOutputs.map(normalizeRegistrationOutput);
  if (new Set(outputs.map((output) => output.id)).size !== outputs.length
    || new Set(outputs.map((output) => output.connector)).size !== outputs.length) {
    throw new Error("capabilities.outputs ids and connectors must be unique");
  }
  const rawCodecs = input.capabilities?.codecs ?? [];
  if (!Array.isArray(rawCodecs) || rawCodecs.length > 32) {
    throw new Error("capabilities.codecs must contain at most 32 entries");
  }
  const codecs = rawCodecs.map((codec, index) => registrationText(
    codec,
    `capabilities.codecs[${index}]`,
    { maximum: 128 },
  ));
  if (new Set(codecs).size !== codecs.length) throw new Error("capabilities.codecs must be unique");
  const rawActions = input.capabilities?.hostControl?.actions ?? [];
  if (!Array.isArray(rawActions) || rawActions.length > Object.keys(HOST_ACTION_TYPE).length) {
    throw new Error("capabilities.hostControl.actions is invalid");
  }
  const actions = rawActions.map(String);
  if (actions.some((action) => !Object.values(HOST_ACTION_TYPE).includes(action))
    || new Set(actions).size !== actions.length) {
    throw new Error("capabilities.hostControl.actions must be unique supported actions");
  }
  const rawDisplayBackends = input.capabilities?.hostControl?.displayBackends ?? [];
  if (!Array.isArray(rawDisplayBackends) || rawDisplayBackends.length > 16) {
    throw new Error("capabilities.hostControl.displayBackends is invalid");
  }
  const displayBackends = rawDisplayBackends.map((backend) => registrationText(
    backend,
    "capabilities.hostControl.displayBackends[]",
    { maximum: 16 },
  ).toLowerCase());
  if (displayBackends.some((backend) => !["kms", "xrandr", "dxgi", "auto"].includes(backend))
    || new Set(displayBackends).size !== displayBackends.length) {
    throw new Error("capabilities.hostControl.displayBackends must be unique supported backends");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    nodeId,
    name: registrationText(input.name, "name", { fallback: nodeId, maximum: 128 }),
    version: registrationText(input.version, "version", { fallback: SOFTWARE_VERSION, maximum: 64 }),
    address: registrationText(input.address, "address", { nullable: true, maximum: 256 }),
    capabilities: {
      outputs,
      codecs,
      ndi: Boolean(input.capabilities?.ndi),
      spout: Boolean(input.capabilities?.spout),
      compositionSource: input.capabilities?.compositionSource
        ? normalizeCompositionSource(input.capabilities.compositionSource)
        : null,
      hardwareTimestamping: Boolean(input.capabilities?.hardwareTimestamping),
      frameLock: Boolean(input.capabilities?.frameLock),
      gpu: registrationText(input.capabilities?.gpu, "capabilities.gpu", { fallback: "unknown", maximum: 256 }),
      maxWarpGrid: {
        columns: Math.max(2, Math.min(128, Math.round(Number(input.capabilities?.maxWarpGrid?.columns ?? 32) || 32))),
        rows: Math.max(2, Math.min(128, Math.round(Number(input.capabilities?.maxWarpGrid?.rows ?? 18) || 18))),
      },
      shaderPipeline: Boolean(input.capabilities?.shaderPipeline),
      hostControl: {
        actions,
        dryRun: Boolean(input.capabilities?.hostControl?.dryRun),
        powerActions: Boolean(input.capabilities?.hostControl?.powerActions),
        displayBackends,
      },
    },
  };
}

function finiteInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function assertSourceViewportWithinCanvas(output, canvas) {
  const viewport = output.sourceViewport;
  if (viewport.x < 0 || viewport.y < 0
    || viewport.width < 1 || viewport.height < 1
    || viewport.x + viewport.width > canvas.width
    || viewport.y + viewport.height > canvas.height) {
    throw new Error(
      `Output ${output.id} sourceViewport must stay inside the ${canvas.width}x${canvas.height} master canvas`,
    );
  }
}

export function normalizeProject(input = defaultProject()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Project must be an object");
  }
  if (input.protocolVersion != null) assertProtocolVersion(input.protocolVersion);

  const canvas = {
    // The current final processor is a single D3D11/Spout texture. Keep the
    // control-plane contract inside the same DXGI texture limit enforced by
    // the Windows renderer so a project accepted here can actually apply.
    width: finiteInteger(input.canvas?.width, 5_280, 64, 16_384),
    height: finiteInteger(input.canvas?.height, 1_080, 64, 16_384),
    frameRateNum: finiteInteger(input.canvas?.frameRateNum, 60, 1, 240_000),
    frameRateDen: finiteInteger(input.canvas?.frameRateDen, 1, 1, 100_000),
  };
  const compositionSource = normalizeCompositionSource(
    input.compositionSource || defaultCompositionSource(canvas),
    { ...canvas, requireCanvasMatch: true },
  );
  const rawOutputs = Array.isArray(input.outputs) ? input.outputs : [];
  if (rawOutputs.length > MAX_OUTPUTS_PER_PROJECT) {
    throw new Error(`Project supports at most ${MAX_OUTPUTS_PER_PROJECT} outputs`);
  }
  const hasExplicitSurfaceTopology = Object.prototype.hasOwnProperty.call(input, "walls");
  const inferredSurfaceIds = hasExplicitSurfaceTopology
    ? []
    : rawOutputs.flatMap((output, index) => {
      if (!output || typeof output !== "object" || Array.isArray(output)
        || !Object.prototype.hasOwnProperty.call(output, "wallId")) return [];
      return [normalizeSurfaceId(output.wallId, `outputs[${index}].wallId`)];
    });
  const { surfaces: walls, surfaceIds: wallIds } = normalizeSurfaceTopology(input.walls, {
    present: hasExplicitSurfaceTopology,
    maximum: MAX_SURFACES_PER_PROJECT,
    fallbackSurface: LEGACY_DEFAULT_SURFACE,
    inferredSurfaceIds,
  });

  const outputIds = new Set();
  const outputsPerNode = new Map();
  const outputs = rawOutputs
    .map((output) => {
      const normalized = normalizeOutputConfig(output);
      assertSourceViewportWithinCanvas(normalized, canvas);
      const hasExplicitWallId = Object.prototype.hasOwnProperty.call(output, "wallId");
      const wallId = resolveSurfaceMembership(output.wallId, {
        present: hasExplicitWallId,
        surfaceIds: wallIds,
        fallbackId: walls[0].id,
        field: `Output ${normalized.id} wallId`,
      });
      if (normalized.nodeId) {
        const count = (outputsPerNode.get(normalized.nodeId) ?? 0) + 1;
        if (count > MAX_OUTPUTS_PER_RENDER_NODE) {
          throw new Error(
            `Render node ${normalized.nodeId} supports at most ${MAX_OUTPUTS_PER_RENDER_NODE} outputs`,
          );
        }
        outputsPerNode.set(normalized.nodeId, count);
      }
      return {
        ...normalized,
        // Legacy projects may omit wallId entirely. Keep their established
        // first-wall fallback, but fail closed for every explicit assignment.
        wallId,
      };
    })
    .filter((output) => {
      if (outputIds.has(output.id)) throw new Error(`Duplicate output id: ${output.id}`);
      outputIds.add(output.id);
      return true;
    });

  const cues = (Array.isArray(input.timeline?.cues) ? input.timeline.cues : [])
    .slice(0, 10_000)
    .map((cue, index) => {
      const assetSha256 = cue?.assetSha256 ? String(cue.assetSha256).toLowerCase() : null;
      if (assetSha256 != null && !/^[a-f0-9]{64}$/.test(assetSha256)) {
        throw new Error(`Cue ${index + 1} assetSha256 must be a canonical SHA-256 digest`);
      }
      return {
        id: String(cue?.id || `cue-${index + 1}`).slice(0, 128),
        assetSha256,
        startFrame: Math.max(0, finiteInteger(cue?.startFrame, 0, 0, Number.MAX_SAFE_INTEGER)),
        durationFrames: Math.max(1, finiteInteger(cue?.durationFrames, 1, 1, Number.MAX_SAFE_INTEGER)),
        loop: Boolean(cue?.loop),
        outputIds: Array.isArray(cue?.outputIds)
          ? cue.outputIds.map(String).filter((id) => outputIds.has(id)).slice(0, MAX_OUTPUTS_PER_PROJECT)
          : [],
      };
    });

  return {
    protocolVersion: PROTOCOL_VERSION,
    id: String(input.id || "project-default").slice(0, 128),
    revision: finiteInteger(input.revision, 1, 1, Number.MAX_SAFE_INTEGER),
    name: String(input.name || "Pixel Brightness Room").slice(0, 256),
    canvas,
    compositionSource,
    walls,
    outputs,
    timeline: { cues },
    updatedAt: new Date().toISOString(),
  };
}

export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
