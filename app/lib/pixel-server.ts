export type PixelOutput = {
  id: string;
  name?: string;
  connector?: string;
  wallId?: string;
  enabled?: boolean;
  resolution?: {
    width?: number;
    height?: number;
    refreshNum?: number;
    refreshDen?: number;
  };
  display?: {
    devicePath?: string;
    gdiName?: string;
    adapterLuid?: string;
    targetId?: number;
    edidHash?: string;
    [key: string]: unknown;
  };
  sourceViewport?: { x?: number; y?: number; width?: number; height?: number };
  overlap?: { left?: number; right?: number; top?: number; bottom?: number };
  warp?: Record<string, unknown>;
  blend?: Record<string, unknown>;
  blackUniformity?: Record<string, unknown>;
  mask?: Record<string, unknown>;
  color?: {
    gain?: number[];
    offset?: number[];
    gamma?: number[];
    lut?: string | null;
    [key: string]: unknown;
  };
  processing?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PixelHostDisplay = {
  id?: string;
  connector?: string;
  name?: string;
  connected?: boolean;
  enabled?: boolean;
  primary?: boolean;
  x?: number;
  y?: number;
  position?: { x?: number; y?: number };
  resolution?: PixelOutput["resolution"];
  mode?: string | PixelOutput["resolution"];
  currentMode?: string | PixelOutput["resolution"];
  modes?: Array<string | PixelOutput["resolution"]>;
  edid?: string | {
    manufacturer?: string;
    model?: string;
    monitorName?: string;
    serial?: string;
    serialNumber?: string;
    hash?: string;
    sha256?: string;
    preferredMode?: PixelOutput["resolution"];
    [key: string]: unknown;
  };
  link?: string | {
    status?: string;
    rate?: string;
    lanes?: number;
    bandwidth?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type PixelHostGpu = {
  name?: string;
  model?: string;
  uuid?: string;
  driverVersion?: string;
  temperatureC?: number;
  tempC?: number;
  vramUsedBytes?: number;
  vramTotalBytes?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
  utilizationPercent?: number;
  [key: string]: unknown;
};

export type PixelHostService = {
  name?: string;
  unit?: string;
  state?: string;
  status?: string;
  active?: boolean;
  pid?: number;
  restarts?: number;
  activeState?: string;
  subState?: string;
  mainPid?: number;
  available?: boolean;
  [key: string]: unknown;
};

export type PixelHost = {
  schemaVersion?: number;
  capturedAt?: string;
  hostname?: string;
  architecture?: string;
  os?: string | {
    name?: string;
    version?: string;
    prettyName?: string;
    id?: string;
    [key: string]: unknown;
  };
  osName?: string;
  osVersion?: string;
  kernel?: string | { release?: string; version?: string; [key: string]: unknown };
  kernelVersion?: string;
  uptimeSeconds?: number;
  uptimeSec?: number;
  nvidiaDriverVersion?: string;
  nvidia?: {
    driverVersion?: string;
    gpus?: PixelHostGpu[];
    [key: string]: unknown;
  };
  gpu?: PixelHostGpu | PixelHostGpu[] | {
    available?: boolean;
    driverVersion?: string;
    gpus?: PixelHostGpu[];
    reason?: string;
    [key: string]: unknown;
  };
  gpus?: PixelHostGpu[];
  displays?: PixelHostDisplay[];
  connectors?: PixelHostDisplay[];
  drm?: { connectors?: PixelHostDisplay[]; [key: string]: unknown };
  host?: {
    hostname?: string;
    platform?: string;
    architecture?: string;
    kernelRelease?: string;
    os?: PixelHost["os"];
    uptimeSeconds?: number;
    [key: string]: unknown;
  };
  memory?: {
    totalBytes?: string | number;
    usedBytes?: string | number;
    freeBytes?: string | number;
    usedPercent?: number;
    [key: string]: unknown;
  };
  services?: PixelHostService[] | Record<string, PixelHostService>;
  nodeService?: PixelHostService;
  rendererService?: PixelHostService;
  renderer?: {
    backend?: string;
    mode?: string;
    status?: string;
    directKms?: boolean;
    interactiveSession?: boolean;
    compositionSource?: {
      connected?: boolean;
      state?: string;
      status?: string;
      senderName?: string;
      width?: number;
      height?: number;
      format?: string;
      frameAgeMs?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  warnings?: Array<string | { code?: string; message?: string; severity?: string; [key: string]: unknown }>;
  faults?: Array<string | { code?: string; message?: string; severity?: string; [key: string]: unknown }>;
  collectedAt?: string;
  [key: string]: unknown;
};

export type PixelNode = {
  id?: string;
  nodeId?: string;
  name?: string;
  status?: string;
  version?: string;
  address?: string;
  lastSeenAt?: string | number;
  lastSeenAtNs?: string;
  ackSequence?: number;
  commandSequence?: number;
  capabilities?: { outputs?: PixelOutput[]; [key: string]: unknown };
  outputs?: PixelOutput[];
  host?: PixelHost;
  readiness?: {
    ready?: boolean;
    active?: boolean;
    blockingFaults?: number;
    driverFaults?: number;
    displayFaults?: number;
    faults?: Array<string | { code?: string; message?: string; severity?: string; subsystem?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  telemetry?: {
    currentFrame?: string | number;
    droppedFrames?: number;
    clockOffsetNs?: string | number;
    clockRttNs?: string | number;
    bestRttNs?: string | number;
    temperatureC?: number;
    projectRevision?: number | null;
    renderer?: {
      backend?: string;
      ready?: boolean;
      connected?: boolean;
      projectRevision?: number | null;
      nativeRevision?: number | null;
      correctionBindingMatches?: boolean | null;
      activeCorrectionFingerprint?: string | null;
      activeCorrectionBinding?: Record<string, unknown> | null;
      compositionSource?: Record<string, unknown> | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type PixelNodeActionType =
  | "APPLY_DISPLAY_CONFIG"
  | "COLLECT_DIAGNOSTICS"
  | "RESTART_RENDERER"
  | "RESTART_NODE"
  | "REBOOT_HOST"
  | "SHUTDOWN_HOST";

export type PixelNodeActionResult = {
  ok?: boolean;
  actionId?: string;
  type?: PixelNodeActionType;
  status?: string;
  accepted?: boolean;
  result?: unknown;
  warning?: string;
  [key: string]: unknown;
};

export type PixelTimeline = {
  state?: string;
  status?: string;
  playing?: boolean;
  currentFrame?: string | number;
  baseFrame?: string | number;
  frameRateNum?: number;
  frameRateDen?: number;
  startNs?: string | null;
  effectiveAtNs?: string | null;
  readiness?: {
    required?: number;
    ready?: number;
    allReady?: boolean;
    warning?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type PixelMedia = {
  id?: string;
  sha256?: string;
  name?: string;
  fileName?: string;
  filename?: string;
  type?: string;
  mimeType?: string;
  size?: number | string;
  sizeBytes?: number;
  duration?: string | number;
  ready?: boolean;
  [key: string]: unknown;
};

export type PixelProjectorAction =
  | "power-on"
  | "standby"
  | "shutter-open"
  | "shutter-close"
  | "input-hdmi1"
  | "input-hdmi2"
  | "input-digital-link";

export type PixelProjectorStatus = {
  online?: boolean;
  state?: string;
  power?: "on" | "standby" | string | null;
  shutter?: "open" | "closed" | string | null;
  input?: string | null;
  light?: string | null;
  lightHours?: number | null;
  checkedAt?: string | null;
  lastAction?: PixelProjectorAction | string;
  error?: { code?: string; message?: string; outcomeUnknown?: boolean } | null;
};

export type PixelProjector = {
  id: string;
  name: string;
  outputId: string;
  host: string;
  port: number;
  enabled: boolean;
  model: "PT-VMZ51" | string;
  webControlUrl?: string | null;
  status?: PixelProjectorStatus;
};

export type PixelProjectorControlState = {
  schemaVersion?: number;
  adapter?: string;
  model?: string;
  commandPortDefault?: number;
  credential?: { configured?: boolean };
  revision: number;
  updatedAt?: string | null;
  projectors?: PixelProjector[];
  lastBatch?: {
    action?: PixelProjectorAction | string;
    completedAt?: string;
    requested?: number;
    succeeded?: number;
    failed?: number;
  } | null;
  results?: Array<{
    projectorId?: string;
    ok?: boolean;
    error?: { code?: string; message?: string; outcomeUnknown?: boolean };
  }>;
};

export type PixelShowScheduleDayName =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type PixelShowScheduleDay = {
  day: PixelShowScheduleDayName;
  enabled: boolean;
  startTime: string;
  shutdownTime: string;
};

export type PixelShowScheduleConfig = {
  schemaVersion: 1;
  enabled: boolean;
  nodeId: string;
  arenaExecutablePath: string | null;
  arenaCompositionPath: string | null;
  projectorStartupEnabled: boolean;
  projectorStandbyEnabled: boolean;
  projectorStaggerMs: number;
  projectorWarmupSeconds: number;
  days: PixelShowScheduleDay[];
};

export type PixelShowScheduleNextEvent = {
  type: "start" | "shutdown";
  day: PixelShowScheduleDayName;
  localDate: string;
  localTime: string;
  scheduledAt: string;
  nodeId: string;
  pinned?: boolean;
};

export type PixelShowScheduleRuntime = {
  schemaVersion: 1;
  state: "disabled" | "idle" | "waiting-for-login" | "starting" | "running"
    | "stopping" | "shutdown-blocked" | "error";
  phase: "disabled" | "off-day" | "before-start" | "deferred" | "awaiting-login" | "starting-show"
    | "starting-arena" | "waiting-source" | "powering-projectors" | "warming-projectors"
    | "ready" | "saving-arena" | "closing-arena" | "projector-standby" | "stopping-show"
    | "requesting-windows-shutdown" | "failed";
  localDate: string;
  lastAction: null | {
    type: "start" | "shutdown";
    scheduleDate: string;
    status: "running" | "succeeded" | "failed";
    startedAt: string;
    completedAt: string | null;
    message: string | null;
  };
  dailyLedger?: null | {
    scheduleDate: string;
    startStatus: "not-attempted" | "running" | "succeeded" | "failed";
    shutdownStatus: "not-attempted" | "running" | "succeeded" | "failed";
  };
  activeRun?: null | {
    scheduleDate: string;
    shutdownTime: string;
    nodeId: string;
    scheduleRevision: number;
    scheduleUpdatedAt: string;
    startupStage: string;
    shutdownStage: string;
    projectorConfigurationRevision: number;
    runBootId?: string | null;
    shutdownRequestBootId?: string | null;
    projectorIds: string[];
  };
  arenaProcessId: number | null;
  workerMessage?: string | null;
  scheduleUpdatedAt?: string | null;
  updatedAt: string;
};

export type PixelShowScheduleSnapshot = PixelShowScheduleConfig & {
  revision: number;
  updatedAt: string | null;
  nextEvent: PixelShowScheduleNextEvent | null;
  runtime: PixelShowScheduleRuntime | null;
};

export type PixelSurfaceLayout = "independent" | "horizontal" | "vertical";

export type PixelPhysicalSurface = {
  id: string;
  name?: string;
  layout?: PixelSurfaceLayout;
  [key: string]: unknown;
};

export type PixelProject = {
  protocolVersion?: number;
  id?: string;
  revision?: number;
  name?: string;
  canvas?: {
    width?: number;
    height?: number;
    frameRateNum?: number;
    frameRateDen?: number;
  };
  compositionSource?: {
    type?: "spout";
    senderName?: string;
    width?: number;
    height?: number;
    frameRateNum?: number;
    frameRateDen?: number;
    acceptedFormats?: string[];
    colorEncoding?: "srgb" | "linear";
    alphaMode?: "ignore";
    timeoutMs?: number;
    startupGraceMs?: number;
    onMissing?: "black";
    onMismatch?: "black";
    allowAutoSelect?: false;
    [key: string]: unknown;
  };
  walls?: PixelPhysicalSurface[];
  outputs?: PixelOutput[];
  timeline?: Record<string, unknown>;
  [key: string]: unknown;
};

export type PixelProjectSaveResult = {
  protocolVersion: number;
  project: PixelProject;
  commandSequence: number;
  syncTargets: PixelProjectSyncTarget[];
};

export type PixelProjectSyncTarget = {
  nodeId: string;
  commandSequence: number;
};

export type PixelProjectSyncDetail = {
  nodeId: string;
  ready: boolean;
  reasons: string[];
};

export type PixelProjectSyncStatus = {
  live: boolean;
  pendingNodeIds: string[];
  details: PixelProjectSyncDetail[];
  reason: string | null;
  timedOut: boolean;
  pollError: string | null;
};

export type PixelProjectApplyResult = PixelProjectSaveResult & {
  syncStatus: PixelProjectSyncStatus;
};

export type PixelServerState = {
  service?: string;
  version?: string;
  server?: {
    version?: string;
    service?: string;
    serverTimeNs?: string;
    authRequired?: boolean;
    accessMode?: "trusted-local" | "token" | "open" | string;
    [key: string]: unknown;
  };
  serverTimeNs?: string;
  project?: PixelProject;
  projectRevision?: number | null;
  nodes?: PixelNode[] | Record<string, PixelNode>;
  media?: PixelMedia[] | Record<string, PixelMedia>;
  timeline?: PixelTimeline;
  fleet?: {
    powerActionsEnabled?: boolean;
    actionAuditCount?: number;
    warnings?: unknown[];
    [key: string]: unknown;
  };
  cameraCalibration?: PixelCameraCalibration | null;
  projectorControl?: PixelProjectorControlState;
  showSchedule?: PixelShowScheduleSnapshot;
  [key: string]: unknown;
};

export type PixelCameraOpticalVerification = {
  state?: "pending-apply" | "pending-renderer-ack" | "pending-optical-capture"
    | "queued" | "preflight" | "waiting-operator" | "capturing" | "evaluating"
    | "verified" | "failed" | "blocked" | "rolling-back" | "rollback-renderer-ack"
    | "rolled-back" | "rollback-blocked" | "superseded" | "cancelled"
    | "not-applicable" | string;
  verificationId?: string;
  appliedRevision?: number;
  progress?: {
    completedSteps?: number;
    totalSteps?: number;
    currentStepId?: string | null;
    currentStepIndex?: number | null;
  } | null;
  operatorPrompt?: {
    state?: "waiting" | "confirmation-queued" | string;
    stepId?: string;
    confirmationId?: string;
    confirmationLeaseId?: string;
    title?: string;
    instructions?: string;
    conditions?: Record<string, unknown>;
    requestedAt?: string | null;
    confirmedAt?: string | null;
  } | null;
  failure?: { code?: string; message?: string; details?: unknown } | null;
  rollback?: {
    state?: "pending" | "renderer-ack" | "restored" | "blocked" | string;
    sourceRevision?: number;
    targetRevision?: number | null;
    reason?: string | null;
    rendererAcknowledgedAt?: string | null;
    restoredAt?: string | null;
  } | null;
  report?: Record<string, unknown> | null;
  runtime?: Record<string, unknown> | null;
  reason?: string | null;
  verifiedAt?: string | null;
  supersededAt?: string | null;
  supersededByRevision?: number | null;
  [key: string]: unknown;
};

export type PixelCameraCalibration = {
  schemaVersion?: number;
  sessionId: string;
  nodeId?: string;
  mode?: "measured" | "simulation" | string;
  state?: string;
  progress?: {
    completedSteps?: number;
    totalSteps?: number;
    completedCaptures?: number;
    totalCaptures?: number;
    stepIndex?: number;
    currentStepIndex?: number;
    stepId?: string;
    currentStepId?: string;
    passId?: string;
    currentPassId?: string;
    phase?: string;
    referenceKind?: string;
    requiresOperatorConfirmation?: boolean;
    operatorPrompt?: string;
    [key: string]: unknown;
  };
  outputIds?: string[];
  camera?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  failure?: { code?: string; message?: string; details?: unknown } | null;
  projectApplied?: boolean;
  projectCommitted?: boolean;
  rendererAcknowledged?: boolean;
  rendererAcknowledgedAt?: string | null;
  operatorPrompt?: {
    state?: "waiting" | "confirmation-queued" | "confirmed" | string;
    stepId?: string;
    confirmationId?: string;
    title?: string;
    instructions?: string;
    conditions?: string[];
    requestedAt?: string | null;
    confirmedAt?: string | null;
    [key: string]: unknown;
  } | null;
  opticalVerification?: PixelCameraOpticalVerification | null;
  appliedRevision?: number | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  [key: string]: unknown;
};

export type PixelCameraManualSettings = {
  exposureMode: "manual";
  iso: number;
  apertureF: number;
  shutterUs: number;
  whiteBalance: { mode: "kelvin"; kelvin: number };
  focusMode: "manual";
  captureFormat: "linear-rgb";
};

export type PixelCameraExposureProfile = {
  id: string;
  role: "geometry" | "radiometry";
  normalizationScale: number;
  settings: PixelCameraManualSettings;
};

export type PixelCameraRepeatPolicy = {
  geometry?: number;
  radiometry?: number;
  nearBlack?: number;
  references?: number;
};

export type PixelPlanarSurfaceSurvey = {
  id: string;
  wallId: string;
  cameraViewId: string;
  frame: { width: number; height: number };
  lensProfileSha256: string;
  boundary: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  method: "operator-four-corner-planar-v1";
};

export type PixelCameraLensProfile = {
  schema: "pixel-brightness.camera-lens-profile.v1";
  sha256: string;
  camera: { manufacturer: string; model: string; serialNumber: string };
  lens: { manufacturer: string; model: string; serialNumber: string };
  frame: { width: number; height: number };
  capture: { focalLengthMm: number; focusDistanceM: number; apertureFNumber: number };
  intrinsics: { fx: number; fy: number; cx: number; cy: number };
  distortion: {
    model: "brown-conrady-v1";
    k1: number;
    k2: number;
    k3: number;
    p1: number;
    p2: number;
  };
  calibration: {
    method: "opencv-charuco-brown-conrady-v1";
    calibratedAt: string;
    rmsResidualPx: number;
    maxResidualPx: number;
    imageCount: number;
  };
};

export type PixelCameraCalibrationRequest = {
  nodeId?: string;
  outputIds?: string[];
  cameraId?: string;
  mode?: "measured" | "simulation";
  mesh?: { columns?: number; rows?: number; minimumConfidence?: number };
  settleFrames?: number;
  repeats?: number;
  cameraSettings?: Record<string, unknown>;
  exposureProfiles?: PixelCameraExposureProfile[];
  repeatPolicy?: PixelCameraRepeatPolicy;
  surfaceSurveys?: PixelPlanarSurfaceSurvey[];
  lensProfile?: PixelCameraLensProfile;
};

export type PixelCameraSurveyPreview = {
  schemaVersion: 1;
  requestId: string;
  nodeId: string;
  cameraViewId: string;
  lensProfileSha256: string;
  frame: { width: number; height: number };
  status: "queued" | "capturing" | "complete" | "failed" | string;
  report?: {
    status?: "complete" | "failed" | string;
    capturedAt?: string;
    completedAt?: string;
    frame?: { width: number; height: number; pixelFormat?: string };
    camera?: Record<string, unknown>;
    lens?: Record<string, unknown>;
    pipeline?: Record<string, unknown>;
    source?: Record<string, unknown>;
    artifact?: { mimeType?: string; byteLength?: number; sha256?: string };
    error?: { code?: string; message?: string };
    [key: string]: unknown;
  } | null;
  failure?: { code?: string; message?: string } | null;
  artifactUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type PixelCameraSurveyPreviewRequest = {
  nodeId: string;
  cameraId: string;
  cameraViewId: string;
  lensProfile: PixelCameraLensProfile;
  cameraSettings: PixelCameraManualSettings;
};

export type PixelCameraSurveyPreviewCapture = {
  preview: PixelCameraSurveyPreview;
  artifact: Blob;
};

export class PixelServerError extends Error {
  status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PixelServerError";
    this.status = status;
  }
}

export const PIXEL_SERVER_TOKEN_KEY = "pixel-brightness-server-token";

export function storedPixelServerToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(PIXEL_SERVER_TOKEN_KEY)?.trim() ?? "";
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function pixelServerUrl() {
  if (typeof window === "undefined") return initialPixelServerUrl();
  return `${window.location.protocol}//${window.location.hostname}:${pixelServerPort}`;
}

declare const __PIXEL_SERVER_PORT__: number;
const pixelServerPort = typeof __PIXEL_SERVER_PORT__ === "number" ? __PIXEL_SERVER_PORT__ : 4100;
export function initialPixelServerUrl() {
  return `http://localhost:${pixelServerPort}`;
}

async function pixelServerResponseError(response: Response) {
  const message = await response.text().catch(() => "");
  let readable = message;
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } | string; message?: string };
    readable = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? message;
  } catch { /* Keep non-JSON server errors intact. */ }
  return new PixelServerError(readable || `Pixel Server returned HTTP ${response.status}`, response.status);
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit, token = ""): Promise<T> {
  const response = await fetch(`${trimSlash(baseUrl)}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof Blob) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await pixelServerResponseError(response);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function requestBlob(baseUrl: string, path: string, token = "") {
  const response = await fetch(`${trimSlash(baseUrl)}${path}`, {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw await pixelServerResponseError(response);
  return response.blob();
}

export type NdiVideoState = {
  enabled: boolean; mode: string; productionAutoReady: boolean;
  job: null | { id: string; state: string; revision: number; expectedFps?: number; error?: string; cleanupError?: string;
    restorationRequired?: boolean; sources: Array<{ outputId: string; name: string }>;
    telemetry?: { sourceValid: boolean; black: boolean; receivedFrames: number; rejectedFrames: number; elapsedSeconds?: number;
      outputs: Array<{ outputId: string; connections: number; sentFrames: number; readbackBackpressure: number }> } };
};
export type UvcGeometryState = {
  enabled: boolean;
  productionAutoReady: boolean;
  routing?: { enabled: boolean; outputIds: string[]; pendingRecovery: boolean; jobId?: string | null; state?: string };
  job: null | {
    id: string; state: string; completedCaptures: number; error?: string; errors?: string[];
    restorationRequired?: boolean;
    blendGenerated?: boolean; blendOutputsCompleted?: number;
    photometryGenerated?: boolean; photometryOutputsCompleted?: number;
    applyAvailable?: boolean; baseRevision?: number; appliedRevision?: number; restoredRevision?: number; receiptError?: string;
    sources: Array<{ outputId: string; name: string; address: string }>;
    outputs?: Array<{ outputId: string; validPixels: number; sampledPixels: number; referenceDrift: number }>;
  };
};

export function createPixelServerClient(baseUrl = pixelServerUrl(), getToken: () => string = storedPixelServerToken) {
  const call = <T,>(path: string, init?: RequestInit) => request<T>(baseUrl, path, init, getToken());
  return {
    baseUrl,
    ndiVideo(signal?: AbortSignal) { return call<NdiVideoState>("/v1/outputs/ndi-preview", { signal }); },
    ndiSources() { return call<{ sources: Array<{ name: string; address: string }> }>("/v1/outputs/ndi-preview/sources"); },
    startNdiVideo(plan: { expectedRevision: number; sourceName: string; outputIds: string[] }) {
      return call<NdiVideoState>("/v1/outputs/ndi-preview", { method: "POST", body: JSON.stringify(plan) });
    },
    blankNdiVideo(id: string, blank: boolean) {
      return call<NdiVideoState>("/v1/outputs/ndi-preview/blank", { method: "POST", body: JSON.stringify({ id, blank }) });
    },
    stopNdiVideo(id: string) { return call<NdiVideoState>("/v1/outputs/ndi-preview/stop", { method: "POST", body: JSON.stringify({ id }) }); },
    uvcGeometry(signal?: AbortSignal) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry", { signal });
    },
    uvcDevices() {
      return call<{ devices: Array<{ id: string; name: string }> }>("/v1/calibrations/uvc-geometry/devices");
    },
    startUvcGeometry(plan: { deviceId: string; outputs: Array<{ id: string; width: number; height: number }>; expectedRevision?: number; autoBlend?: boolean; autoRoute?: boolean; autoPhotometry?: boolean; cameraResponse?: 'srgb-assumed'; cameraSettingsLocked?: boolean; targetArea?: { x: number; y: number; width: number; height: number } }) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry", { method: "POST", body: JSON.stringify(plan) });
    },
    confirmUvcRouting(id: string) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry/confirm-routing", { method: "POST", body: JSON.stringify({ id }) });
    },
    cancelUvcGeometry(id: string) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry/cancel", { method: "POST", body: JSON.stringify({ id }) });
    },
    applyUvcGeometry(id: string, expectedRevision: number) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry/apply", { method: "POST", body: JSON.stringify({ id, expectedRevision }) });
    },
    restoreUvcGeometry(id: string, expectedRevision: number) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry/restore", { method: "POST", body: JSON.stringify({ id, expectedRevision }) });
    },
    restoreUvcRouting(id: string) {
      return call<UvcGeometryState>("/v1/calibrations/uvc-geometry/restore-routing", { method: "POST", body: JSON.stringify({ id }) });
    },
    state(signal?: AbortSignal) {
      return call<PixelServerState>("/v1/state", { signal });
    },
    stateSummary(signal?: AbortSignal) {
      return call<PixelServerState>("/v1/state?includeProject=0", { signal });
    },
    project(signal?: AbortSignal) {
      return call<{ protocolVersion: number; project: PixelProject }>("/v1/projects/default", { signal });
    },
    prepare() {
      return call<PixelServerState>("/v1/timeline/prepare", {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    play(options: { delayMs?: number; baseFrame?: number } = {}) {
      return call<PixelServerState>("/v1/timeline/play", {
        method: "POST",
        body: JSON.stringify(options),
      });
    },
    pause() {
      return call<PixelServerState>("/v1/timeline/pause", {
        method: "POST",
        body: JSON.stringify({}),
      });
    },
    seek(frame: number) {
      return call<PixelServerState>("/v1/timeline/seek", {
        method: "POST",
        body: JSON.stringify({ frame: Math.max(0, Math.round(frame)) }),
      });
    },
    pattern(outputId: string, enabled: boolean, options: { type?: "grid" | "identify"; cellSize?: number } = {}) {
      return call<Record<string, unknown>>(`/v1/outputs/${encodeURIComponent(outputId)}/pattern`, {
        method: "POST",
        body: JSON.stringify({
          enabled,
          type: enabled ? options.type ?? "grid" : "content",
          cellSize: Math.max(2, Math.round(options.cellSize ?? 32)),
        }),
      });
    },
    projectors() {
      return call<PixelProjectorControlState>("/v1/projectors");
    },
    configureProjectors(projectors: PixelProjector[]) {
      return call<PixelProjectorControlState>("/v1/projectors", {
        method: "PUT",
        body: JSON.stringify({
          projectors: projectors.map(({ id, name, outputId, host, port, enabled, model }) => ({
            id, name, outputId, host, port, enabled, model,
          })),
        }),
      });
    },
    refreshProjectors(projectorIds?: string[]) {
      return call<PixelProjectorControlState>("/v1/projectors/refresh", {
        method: "POST",
        body: JSON.stringify(projectorIds ? { projectorIds } : {}),
      });
    },
    projectorAction(action: PixelProjectorAction, projectorIds?: string[], staggerMs = 0) {
      return call<PixelProjectorControlState>("/v1/projectors/actions", {
        method: "POST",
        body: JSON.stringify({ action, ...(projectorIds ? { projectorIds } : {}), staggerMs }),
      });
    },
    showSchedule(signal?: AbortSignal) {
      return call<PixelShowScheduleSnapshot>("/v1/show-schedule", { signal });
    },
    configureShowSchedule(schedule: PixelShowScheduleConfig, expectedRevision: number) {
      return call<PixelShowScheduleSnapshot>("/v1/show-schedule", {
        method: "PUT",
        headers: { "if-match": String(expectedRevision) },
        body: JSON.stringify({
          schemaVersion: 1,
          enabled: schedule.enabled,
          nodeId: schedule.nodeId,
          arenaExecutablePath: schedule.arenaExecutablePath,
          arenaCompositionPath: schedule.arenaCompositionPath,
          projectorStartupEnabled: schedule.projectorStartupEnabled,
          projectorStandbyEnabled: schedule.projectorStandbyEnabled,
          projectorStaggerMs: schedule.projectorStaggerMs,
          projectorWarmupSeconds: schedule.projectorWarmupSeconds,
          days: schedule.days.map(({ day, enabled, startTime, shutdownTime }) => ({
            day, enabled, startTime, shutdownTime,
          })),
        }),
      });
    },
    startCameraCalibration(options: PixelCameraCalibrationRequest = {}) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>("/v1/calibrations/camera", {
        method: "POST",
        body: JSON.stringify({ mode: "measured", ...options }),
      });
    },
    cameraCalibration(sessionId = "latest") {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}`,
      );
    },
    cancelCameraCalibration(sessionId: string) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/cancel`,
        { method: "POST" },
      );
    },
    confirmCameraCalibration(sessionId: string, stepId: string, confirmationId: string) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ confirmed: true, stepId, confirmationId }),
        },
      );
    },
    startCameraOpticalVerification(sessionId: string) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/verification`,
        { method: "POST" },
      );
    },
    cancelCameraOpticalVerification(sessionId: string) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/verification/cancel`,
        { method: "POST" },
      );
    },
    confirmCameraOpticalVerification(sessionId: string, stepId: string, confirmationId: string) {
      return call<{ protocolVersion: number; calibration: PixelCameraCalibration }>(
        `/v1/calibrations/camera/${encodeURIComponent(sessionId)}/verification/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ confirmed: true, stepId, confirmationId }),
        },
      );
    },
    requestCameraSurveyPreview(options: PixelCameraSurveyPreviewRequest) {
      return call<{ protocolVersion: number; preview: PixelCameraSurveyPreview }>(
        "/v1/calibrations/camera/survey-previews",
        { method: "POST", body: JSON.stringify(options) },
      );
    },
    cameraSurveyPreview(requestId: string) {
      return call<{ protocolVersion: number; preview: PixelCameraSurveyPreview }>(
        `/v1/calibrations/camera/survey-previews/${encodeURIComponent(requestId)}`,
      );
    },
    cameraSurveyPreviewArtifact(requestId: string) {
      return requestBlob(
        baseUrl,
        `/v1/calibrations/camera/survey-previews/${encodeURIComponent(requestId)}/artifact`,
        getToken(),
      );
    },
    nodeAction(nodeId: string, type: PixelNodeActionType, payload: Record<string, unknown> = {}, confirmationPhrase?: string) {
      return call<PixelNodeActionResult>(`/v1/nodes/${encodeURIComponent(nodeId)}/actions`, {
        method: "POST",
        body: JSON.stringify({ type, payload, ...(confirmationPhrase ? { confirmationPhrase } : {}) }),
      });
    },
    saveProject(project: PixelProject, expectedRevision: number) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new PixelServerError("Cannot save without a valid authoritative project revision", 409);
      }
      return call<PixelProjectSaveResult>("/v1/projects/default", {
        method: "POST",
        headers: { "if-match": String(expectedRevision) },
        body: JSON.stringify(project),
      });
    },
    async uploadMedia(file: File) {
      const response = await call<{ protocolVersion: number; media: PixelMedia }>("/v1/media/upload", {
        method: "POST",
        body: file,
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
      });
      return response.media;
    },
  };
}

export type PixelServerClient = ReturnType<typeof createPixelServerClient>;
