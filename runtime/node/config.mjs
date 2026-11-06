import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import {
  isAbsolutePlatformPath,
  joinPlatformPath,
  normalizePlatformServiceName,
  platformDefaults,
  resolvePlatformPath,
  sanitizePlatformNodeId,
} from "./platform-contract.mjs";
import { normalizeSpoutSource, normalizeWindowsDisplaySelector } from "./windows-renderer-contract.mjs";
import { SOFTWARE_VERSION } from "../shared/protocol.mjs";
import { nodeIdFromNodeCredential } from "../shared/node-auth.mjs";
import {
  CANON_R50_CAMERA_MODEL,
  CANON_RF_S_10_18_LENS_MODEL,
} from "./camera-helper-contract.mjs";

const ENV = Object.freeze({
  nodeId: "PIXEL_BRIGHTNESS_NODE_ID",
  name: "PIXEL_BRIGHTNESS_NODE_NAME",
  serverUrl: "PIXEL_BRIGHTNESS_SERVER_URL",
  dataDir: "PIXEL_BRIGHTNESS_DATA_DIR",
  outputs: "PIXEL_BRIGHTNESS_OUTPUTS",
  heartbeatMs: "PIXEL_BRIGHTNESS_HEARTBEAT_MS",
  clockSyncMs: "PIXEL_BRIGHTNESS_CLOCK_SYNC_MS",
  clockSyncRounds: "PIXEL_BRIGHTNESS_CLOCK_SYNC_ROUNDS",
  pollWaitMs: "PIXEL_BRIGHTNESS_POLL_WAIT_MS",
  commandRetryBudget: "PIXEL_BRIGHTNESS_COMMAND_RETRY_BUDGET",
  maxAssetBytes: "PIXEL_BRIGHTNESS_MAX_ASSET_BYTES",
  maxCacheBytes: "PIXEL_BRIGHTNESS_MAX_CACHE_BYTES",
  logLevel: "PIXEL_BRIGHTNESS_LOG_LEVEL",
  nodeToken: "PIXEL_BRIGHTNESS_NODE_TOKEN",
  hostTelemetryMs: "PIXEL_BRIGHTNESS_HOST_TELEMETRY_MS",
  allowPowerActions: "PIXEL_BRIGHTNESS_ALLOW_POWER_ACTIONS",
  powerConfirmationToken: "PIXEL_BRIGHTNESS_POWER_CONFIRMATION_TOKEN",
  hostActionsDryRun: "PIXEL_BRIGHTNESS_HOST_ACTIONS_DRY_RUN",
  allowXrandrFallback: "PIXEL_BRIGHTNESS_ALLOW_XRANDR_FALLBACK",
  hostControlCommand: "PIXEL_BRIGHTNESS_HOST_CONTROL_COMMAND",
  displayConfigPath: "PIXEL_BRIGHTNESS_DISPLAY_CONFIG",
  diagnosticsDir: "PIXEL_BRIGHTNESS_DIAGNOSTICS_DIR",
  nodeService: "PIXEL_BRIGHTNESS_NODE_SERVICE",
  displayEnvironment: "PIXEL_BRIGHTNESS_DISPLAY_ENV",
  displayBackend: "PIXEL_BRIGHTNESS_DISPLAY_BACKEND",
  rendererBackend: "PIXEL_BRIGHTNESS_RENDERER_BACKEND",
  rendererCommand: "PIXEL_BRIGHTNESS_RENDERER_COMMAND",
  rendererConfigPath: "PIXEL_BRIGHTNESS_RENDERER_CONFIG",
  rendererPipe: "PIXEL_BRIGHTNESS_RENDERER_PIPE",
  rendererBootToken: "PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN",
  rendererIpcTimeoutMs: "PIXEL_BRIGHTNESS_RENDERER_IPC_TIMEOUT_MS",
  adapterLuid: "PIXEL_BRIGHTNESS_RENDERER_ADAPTER_LUID",
  compositionSource: "PIXEL_BRIGHTNESS_COMPOSITION_SOURCE",
  canvas: "PIXEL_BRIGHTNESS_CANVAS",
  cameraBackend: "PIXEL_BRIGHTNESS_CAMERA_BACKEND",
  cameraHelperCommand: "PIXEL_BRIGHTNESS_CAMERA_HELPER_COMMAND",
  cameraHelperTimeoutMs: "PIXEL_BRIGHTNESS_CAMERA_HELPER_TIMEOUT_MS",
  cameraCaptureDir: "PIXEL_BRIGHTNESS_CAMERA_CAPTURE_DIR",
  cameraExpectedModel: "PIXEL_BRIGHTNESS_CAMERA_EXPECTED_MODEL",
  cameraExpectedSerial: "PIXEL_BRIGHTNESS_CAMERA_EXPECTED_SERIAL",
  cameraExpectedLensModel: "PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_MODEL",
  cameraExpectedLensSerial: "PIXEL_BRIGHTNESS_CAMERA_EXPECTED_LENS_SERIAL",
  cameraExpectedFocalLengthMm: "PIXEL_BRIGHTNESS_CAMERA_EXPECTED_FOCAL_LENGTH_MM",
  cameraRuntimeManifestPath: "PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST_PATH",
  cameraManifestArchiveMaxEntries: "PIXEL_BRIGHTNESS_CAMERA_MANIFEST_ARCHIVE_MAX_ENTRIES",
  cameraManifestArchiveMaxBytes: "PIXEL_BRIGHTNESS_CAMERA_MANIFEST_ARCHIVE_MAX_BYTES",
});

const ARG_ALIASES = Object.freeze({
  "--id": "nodeId",
  "--name": "name",
  "--server": "serverUrl",
  "--data-dir": "dataDir",
  "--outputs": "outputs",
  "--heartbeat-ms": "heartbeatMs",
  "--clock-sync-ms": "clockSyncMs",
  "--clock-sync-rounds": "clockSyncRounds",
  "--poll-wait-ms": "pollWaitMs",
  "--command-retry-budget": "commandRetryBudget",
  "--max-asset-bytes": "maxAssetBytes",
  "--max-cache-bytes": "maxCacheBytes",
  "--log-level": "logLevel",
  "--node-token": "nodeToken",
  "--auth-token": "legacyAuthToken",
  "--host-telemetry-ms": "hostTelemetryMs",
  "--power-confirmation-token": "powerConfirmationToken",
  "--host-control-command": "hostControlCommand",
  "--display-config": "displayConfigPath",
  "--diagnostics-dir": "diagnosticsDir",
  "--node-service": "nodeService",
  "--display-env": "displayEnvironment",
  "--display-backend": "displayBackend",
  "--renderer-backend": "rendererBackend",
  "--renderer-command": "rendererCommand",
  "--renderer-config": "rendererConfigPath",
  "--renderer-pipe": "rendererPipe",
  "--renderer-ipc-timeout-ms": "rendererIpcTimeoutMs",
  "--renderer-adapter-luid": "adapterLuid",
  "--composition-source": "compositionSource",
  "--canvas": "canvas",
  "--camera-backend": "cameraBackend",
  "--camera-helper-command": "cameraHelperCommand",
  "--camera-helper-timeout-ms": "cameraHelperTimeoutMs",
  "--camera-capture-dir": "cameraCaptureDir",
  "--camera-expected-model": "cameraExpectedModel",
  "--camera-expected-serial": "cameraExpectedSerial",
  "--camera-expected-lens-model": "cameraExpectedLensModel",
  "--camera-expected-lens-serial": "cameraExpectedLensSerial",
  "--camera-expected-focal-length-mm": "cameraExpectedFocalLengthMm",
  "--camera-runtime-manifest": "cameraRuntimeManifestPath",
  "--camera-manifest-archive-max-entries": "cameraManifestArchiveMaxEntries",
  "--camera-manifest-archive-max-bytes": "cameraManifestArchiveMaxBytes",
});

const BOOLEAN_ARGS = Object.freeze({
  "--allow-power-actions": ["allowPowerActions", true],
  "--no-power-actions": ["allowPowerActions", false],
  "--host-actions-dry-run": ["hostActionsDryRun", true],
  "--live-host-actions": ["hostActionsDryRun", false],
  "--allow-xrandr-fallback": ["allowXrandrFallback", true],
  "--no-xrandr-fallback": ["allowXrandrFallback", false],
});

function safeNodeId(value) {
  return sanitizePlatformNodeId(value);
}

function positiveInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function booleanValue(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (value === true || value === 1 || /^(true|yes|on|1)$/i.test(String(value))) return true;
  if (value === false || value === 0 || /^(false|no|off|0)$/i.test(String(value))) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function optionalBindingText(value, field, { maximum = 256 } = {}) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const hasControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!text || text.length > maximum || hasControl) {
    throw new Error(`${field} is invalid`);
  }
  return text;
}

function normalizeAdapterLuid(value, field = "adapterLuid") {
  if (value == null || value === "") return null;
  const luid = String(value).trim();
  if (!/^[0-9a-f]{8}:[0-9a-f]{8}$/i.test(luid)) {
    throw new Error(`${field} must use 8-hex:8-hex form`);
  }
  return luid.toUpperCase();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message}`);
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }
    if (token === "--config") {
      if (!argv[index + 1]) throw new Error("--config requires a file path");
      result.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (BOOLEAN_ARGS[token]) {
      const [key, value] = BOOLEAN_ARGS[token];
      result[key] = value;
      continue;
    }
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    const inline = equals < 0 ? undefined : token.slice(equals + 1);
    const key = ARG_ALIASES[flag];
    if (!key) throw new Error(`Unknown option: ${token}`);
    const value = inline ?? argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    result[key] = value;
    if (inline === undefined) index += 1;
  }
  return result;
}

function normalizeDisplayEnvironment(value) {
  const input = typeof value === "string" ? parseJson(value, "display environment") : value;
  if (input == null) return {};
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("displayEnvironment must be an object");
  const allowed = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS"];
  return Object.fromEntries(allowed.flatMap((key) => {
    const item = input[key];
    if (item == null || item === "") return [];
    const text = String(item);
    if (text.includes("\0") || text.length > 4096) throw new Error(`Invalid display environment field: ${key}`);
    return [[key, text]];
  }));
}

async function readConfigFile(pathname, { platform = process.platform, cwd = process.cwd() } = {}) {
  if (!pathname) return {};
  const absolute = resolvePlatformPath(pathname, { platform, cwd });
  const text = await readFile(absolute, "utf8");
  const parsed = parseJson(text, absolute);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`Node config ${absolute} must be a JSON object`);
  }
  return parsed;
}

function environmentConfig(env) {
  const config = {};
  for (const [key, name] of Object.entries(ENV)) {
    if (env[name] !== undefined && env[name] !== "") config[key] = env[name];
  }
  return config;
}

function normalizeOutputs(value, { platform = process.platform } = {}) {
  const input = typeof value === "string" ? parseJson(value, "outputs") : value;
  const outputs = Array.isArray(input) && input.length > 0 ? input : [
    {
      id: "A",
      name: "Projector A",
      connector: platform === "win32" ? "\\\\.\\DISPLAY1" : "VIRTUAL-1",
      ...(platform === "win32" ? {
        display: { gdiName: "\\\\.\\DISPLAY1" },
      } : {}),
      enabled: true,
      resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 },
    },
  ];
  const seen = new Set();
  return outputs.map((output, index) => {
    if (!output || typeof output !== "object") throw new Error(`outputs[${index}] must be an object`);
    const id = String(output.id || `output-${index + 1}`);
    if (seen.has(id)) throw new Error(`Duplicate output id: ${id}`);
    seen.add(id);
    let display;
    if (platform === "win32") {
      display = normalizeWindowsDisplaySelector(output.display || {
        gdiName: output.connector || `\\\\.\\DISPLAY${index + 1}`,
      });
    }
    return {
      ...output,
      id,
      name: String(output.name || id),
      connector: String(output.connector || display?.devicePath || display?.gdiName || `VIRTUAL-${index + 1}`),
      enabled: output.enabled !== false,
      ...(display ? { display } : {}),
    };
  });
}

export function nodeHelp() {
  return `Pixel Brightness Render Node V3

Usage:
  node runtime/node/index.mjs [options]

Options:
  --config <file>              JSON configuration file
  --id <node-id>               Stable node identifier
  --name <display-name>        Name shown in Web Control
  --server <url>               Control server (default http://127.0.0.1:4100)
  --data-dir <path>            State and asset cache directory
  --outputs <json>             JSON array of physical/virtual outputs
  --heartbeat-ms <ms>          Heartbeat interval (500-30000)
  --clock-sync-ms <ms>         Clock re-sync interval (5000-3600000)
  --clock-sync-rounds <count>  Samples per clock sync (3-32)
  --poll-wait-ms <ms>          Server long-poll duration (1000-30000)
  --command-retry-budget <n>   Durable attempts before dead-lettering (1-20)
  --max-asset-bytes <bytes>    Per-asset payload ceiling (default 50 GiB)
  --max-cache-bytes <bytes>    Aggregate cache payload ceiling (default 100 GiB)
  --log-level <level>          debug, info, warn, or error
  --node-token <token>         Credential bound to this exact Render Node id
  --host-telemetry-ms <ms>     Host snapshot interval
  --display-config <path>      Persistent KMS/DXGI display configuration
  --display-backend <name>     kms, xrandr, dxgi, or auto
  --renderer-backend <name>    simulator, dxgi, or auto
  --renderer-command <path>    Native renderer executable (Windows)
  --renderer-config <path>     Native renderer JSON configuration
  --renderer-pipe <name>       Native renderer named pipe
  --renderer-adapter-luid <id> Bound renderer GPU LUID (8-hex:8-hex)
  --composition-source <json>  One master Spout composition source
  --canvas <json>              Master canvas dimensions and frame rate
  --camera-backend <name>      sony-sdk, canon-edsdk, or disabled
  --camera-helper-command <p>  Isolated vendor camera helper executable
  --camera-helper-timeout-ms   Per-command camera SDK deadline
  --camera-capture-dir <path>  Confined helper raster exchange directory
  --camera-expected-model <id> Exact camera model (default ILCE-7M4 for Sony)
  --camera-expected-serial <id>
                               Optional exact camera body serial binding
  --camera-expected-lens-model <id>
                               Optional exact lens model (Canon R50 defaults to RF-S 10-18)
  --camera-expected-lens-serial <id>
                               Optional exact physical lens serial binding
  --camera-expected-focal-length-mm <mm>
                               Exact focal-length readback binding
  --camera-runtime-manifest <path>
                               Absolute measured Canon EDSDK manifest
  --camera-manifest-archive-max-entries <n>
                               Durable measured-manifest entry ceiling (default 32)
  --camera-manifest-archive-max-bytes <bytes>
                               Durable measured-manifest byte ceiling (default 128 MiB)
  --host-control-command <p>   Fixed privileged helper executable
  --allow-xrandr-fallback      Permit explicit X11 fallback for backend=auto
  --host-actions-dry-run       Validate and report host actions without mutation
  --live-host-actions          Enable host mutations (Linux/Windows)
  --allow-power-actions        Permit reboot/shutdown with confirmation token
  --power-confirmation-token   Node-local reboot/shutdown confirmation secret
  -h, --help                   Show this help

Environment variables use the PIXEL_BRIGHTNESS_* prefix. CLI values override
environment values, and environment values override the JSON config file.`;
}

export async function loadNodeConfig({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  platform = process.platform,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };
  const configPath = args.configPath || env.PIXEL_BRIGHTNESS_CONFIG;
  const fileConfig = await readConfigFile(configPath, { platform, cwd });
  if (fileConfig.rendererBootToken != null) {
    throw new Error(
      "rendererBootToken is an ephemeral launcher credential and must not be stored in Node config",
    );
  }
  if (fileConfig.authToken || args.legacyAuthToken
      || env.PIXEL_BRIGHTNESS_AUTH_TOKEN || env.PIXEL_AUTH_TOKEN) {
    throw new Error(
      "Legacy shared auth tokens are not accepted by Render Node; configure PIXEL_BRIGHTNESS_NODE_TOKEN and rotate the Server control token",
    );
  }
  const merged = { ...fileConfig, ...environmentConfig(env), ...args };
  const nodeId = safeNodeId(merged.nodeId || hostname());
  const defaults = platformDefaults({ platform, env, cwd, nodeId });
  let serverUrl;
  try {
    serverUrl = new URL(merged.serverUrl || "http://127.0.0.1:4100").toString().replace(/\/$/, "");
  } catch {
    throw new Error(`Invalid server URL: ${merged.serverUrl}`);
  }
  const allowedLevels = new Set(["debug", "info", "warn", "error"]);
  const logLevel = String(merged.logLevel || "info").toLowerCase();
  if (!allowedLevels.has(logLevel)) throw new Error(`Invalid log level: ${logLevel}`);
  const nodeToken = merged.nodeToken || null;
  if (nodeToken && nodeIdFromNodeCredential(nodeToken) !== nodeId) {
    throw new Error("Render Node credential is malformed or bound to a different nodeId");
  }
  const dataDir = merged.dataDir
    ? resolvePlatformPath(merged.dataDir, { cwd, platform })
    : defaults.dataDir;
  const hostActionsDryRun = booleanValue(merged.hostActionsDryRun, !["linux", "win32"].includes(platform));
  const displayBackend = String(merged.displayBackend || defaults.displayBackend).toLowerCase();
  if (!["kms", "xrandr", "dxgi", "auto"].includes(displayBackend)) throw new Error(`Invalid display backend: ${displayBackend}`);
  const rendererBackend = String(merged.rendererBackend || defaults.rendererBackend).toLowerCase();
  if (!["simulator", "dxgi", "auto"].includes(rendererBackend)) throw new Error(`Invalid renderer backend: ${rendererBackend}`);
  const hostControlCommand = String(merged.hostControlCommand || defaults.hostControlCommand);
  if (!isAbsolutePlatformPath(hostControlCommand, platform)) throw new Error("hostControlCommand must be an absolute platform path");
  const rendererCommand = merged.rendererCommand || defaults.rendererCommand;
  if (rendererCommand && !isAbsolutePlatformPath(String(rendererCommand), platform)) {
    throw new Error("rendererCommand must be an absolute platform path");
  }
  const cameraBackend = String(merged.cameraBackend || (platform === "win32" ? "sony-sdk" : "canon-edsdk")).toLowerCase();
  if (!["sony-sdk", "canon-edsdk", "disabled"].includes(cameraBackend)) {
    throw new Error(`Invalid camera backend: ${cameraBackend}`);
  }
  const cameraHelperCommand = merged.cameraHelperCommand == null || merged.cameraHelperCommand === ""
    ? null
    : resolvePlatformPath(String(merged.cameraHelperCommand), { cwd, platform });
  if (cameraHelperCommand && !isAbsolutePlatformPath(cameraHelperCommand, platform)) {
    throw new Error("cameraHelperCommand must be an absolute platform path");
  }
  const cameraRuntimeManifestValue = merged.cameraRuntimeManifestPath == null
    || merged.cameraRuntimeManifestPath === ""
    ? null
    : String(merged.cameraRuntimeManifestPath);
  if (cameraRuntimeManifestValue && !isAbsolutePlatformPath(cameraRuntimeManifestValue, platform)) {
    throw new Error("cameraRuntimeManifestPath must be an absolute platform path");
  }
  const cameraRuntimeManifestPath = cameraRuntimeManifestValue
    ? resolvePlatformPath(cameraRuntimeManifestValue, { cwd, platform })
    : null;
  const cameraExpectedFocalLengthMm = merged.cameraExpectedFocalLengthMm == null
    || merged.cameraExpectedFocalLengthMm === ""
    ? null
    : Number(merged.cameraExpectedFocalLengthMm);
  if (cameraExpectedFocalLengthMm != null
    && (!Number.isFinite(cameraExpectedFocalLengthMm)
      || cameraExpectedFocalLengthMm < 1 || cameraExpectedFocalLengthMm > 2_000)) {
    throw new Error("cameraExpectedFocalLengthMm must be a finite number from 1 to 2000");
  }
  if (cameraBackend === "canon-edsdk" && cameraHelperCommand
    && (!cameraRuntimeManifestPath || cameraExpectedFocalLengthMm == null)) {
    throw new Error(
      "canon-edsdk helper requires cameraRuntimeManifestPath and cameraExpectedFocalLengthMm",
    );
  }
  const cameraExpectedModel = optionalBindingText(
    merged.cameraExpectedModel || (cameraBackend === "sony-sdk" ? "ILCE-7M4" : CANON_R50_CAMERA_MODEL),
    "cameraExpectedModel",
  );
  if (cameraBackend === "canon-edsdk" && cameraExpectedModel !== CANON_R50_CAMERA_MODEL) {
    throw new Error(`canon-edsdk supports exact camera model ${CANON_R50_CAMERA_MODEL}`);
  }
  const cameraExpectedSerial = optionalBindingText(merged.cameraExpectedSerial, "cameraExpectedSerial");
  const cameraExpectedLensModel = optionalBindingText(
    merged.cameraExpectedLensModel
      || (cameraBackend === "canon-edsdk" ? CANON_RF_S_10_18_LENS_MODEL : null),
    "cameraExpectedLensModel",
  );
  const cameraExpectedLensSerial = optionalBindingText(
    merged.cameraExpectedLensSerial,
    "cameraExpectedLensSerial",
  );
  const rendererPipe = merged.rendererPipe || defaults.rendererPipe || null;
  if (rendererPipe && !/^\\\\\.\\pipe\\pixel-brightness-renderer-[a-z0-9_.-]+$/i.test(String(rendererPipe))) {
    throw new Error("rendererPipe must use the Pixel Brightness named-pipe namespace");
  }
  const rendererBootToken = merged.rendererBootToken == null
    ? null
    : String(merged.rendererBootToken);
  if (rendererBootToken != null && !/^[A-Za-z0-9_-]{43,128}$/.test(rendererBootToken)) {
    throw new Error("PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN must be 43-128 base64url characters");
  }
  if (env === process.env) delete process.env[ENV.rendererBootToken];
  const compositionInput = typeof merged.compositionSource === "string"
    ? parseJson(merged.compositionSource, "composition source")
    : merged.compositionSource;
  const canvasInput = typeof merged.canvas === "string" ? parseJson(merged.canvas, "canvas") : merged.canvas;
  if (canvasInput != null && (!canvasInput || typeof canvasInput !== "object" || Array.isArray(canvasInput))) {
    throw new Error("canvas must be an object");
  }
  const canvas = {
    width: positiveInteger(canvasInput?.width, 5_280, 64, 262_144),
    height: positiveInteger(canvasInput?.height, 1_080, 64, 65_536),
    frameRateNum: positiveInteger(canvasInput?.frameRateNum, 60, 1, 240_000),
    frameRateDen: positiveInteger(canvasInput?.frameRateDen, 1, 1, 100_000),
  };
  const compositionSource = platform === "win32" || compositionInput
    ? normalizeSpoutSource(compositionInput || { type: "spout", senderName: "PB-COMPOSITION" }, {
      ...canvas,
      requireCanvasMatch: true,
    })
    : null;
  const displayConfigPath = resolvePlatformPath(
    merged.displayConfigPath || joinPlatformPath(platform, dataDir, "display-config.json"),
    { cwd, platform },
  );
  const diagnosticsDir = resolvePlatformPath(
    merged.diagnosticsDir || joinPlatformPath(platform, dataDir, "diagnostics"),
    { cwd, platform },
  );
  const rendererConfigPath = resolvePlatformPath(
    merged.rendererConfigPath || joinPlatformPath(platform, dataDir, "renderer-config.json"),
    { cwd, platform },
  );
  const cameraCaptureDir = resolvePlatformPath(
    merged.cameraCaptureDir || joinPlatformPath(platform, dataDir, "camera-captures"),
    { cwd, platform },
  );
  const nodeService = normalizePlatformServiceName(merged.nodeService, {
    platform,
    fallback: defaults.nodeService,
  });
  const outputs = normalizeOutputs(merged.outputs, { platform, nodeId });
  const outputAdapterLuids = new Set(outputs.flatMap((output) => {
    const luid = output.display?.adapterLuid;
    return luid ? [normalizeAdapterLuid(luid, `outputs[${output.id}].display.adapterLuid`)] : [];
  }));
  if (outputAdapterLuids.size > 1) {
    throw new Error("Windows physical outputs must use one GPU adapter LUID");
  }
  const configuredAdapterLuid = normalizeAdapterLuid(merged.adapterLuid);
  const outputAdapterLuid = outputAdapterLuids.values().next().value || null;
  if (configuredAdapterLuid && outputAdapterLuid && configuredAdapterLuid !== outputAdapterLuid) {
    throw new Error("adapterLuid does not match the physical output GPU adapter LUID");
  }
  const adapterLuid = configuredAdapterLuid || outputAdapterLuid;

  return {
    protocolVersion: 1,
    nodeId,
    name: String(merged.name || nodeId),
    version: SOFTWARE_VERSION,
    platform,
    serverUrl,
    dataDir,
    outputs,
    adapterLuid,
    canvas,
    compositionSource,
    heartbeatMs: positiveInteger(merged.heartbeatMs, 2_000, 500, 30_000),
    clockSyncMs: positiveInteger(merged.clockSyncMs, 60_000, 5_000, 3_600_000),
    clockSyncRounds: positiveInteger(merged.clockSyncRounds, 8, 3, 32),
    pollWaitMs: positiveInteger(merged.pollWaitMs, 20_000, 1_000, 30_000),
    commandRetryBudget: positiveInteger(merged.commandRetryBudget, 3, 1, 20),
    requestTimeoutMs: positiveInteger(merged.requestTimeoutMs, 10_000, 1_000, 120_000),
    maxAssetBytes: positiveInteger(merged.maxAssetBytes, 50 * 1024 * 1024 * 1024, 1_048_576, Number.MAX_SAFE_INTEGER),
    maxCacheBytes: positiveInteger(merged.maxCacheBytes, 100 * 1024 * 1024 * 1024, 1_048_576, Number.MAX_SAFE_INTEGER),
    logLevel,
    nodeToken: nodeToken ? String(nodeToken) : null,
    hostTelemetryMs: positiveInteger(merged.hostTelemetryMs, 5_000, 1_000, 300_000),
    allowPowerActions: booleanValue(merged.allowPowerActions, false),
    powerConfirmationToken: merged.powerConfirmationToken ? String(merged.powerConfirmationToken) : null,
    hostActionsDryRun,
    allowXrandrFallback: booleanValue(merged.allowXrandrFallback, false),
    hostControlCommand,
    displayBackend,
    displayConfigPath,
    diagnosticsDir,
    nodeService,
    displayEnvironment: platform === "linux" ? normalizeDisplayEnvironment(merged.displayEnvironment) : {},
    rendererBackend,
    rendererCommand: rendererCommand ? String(rendererCommand) : null,
    rendererConfigPath,
    rendererPipe: rendererPipe ? String(rendererPipe) : null,
    rendererBootToken,
    rendererIpcTimeoutMs: positiveInteger(merged.rendererIpcTimeoutMs, 30_000, 100, 120_000),
    cameraBackend,
    cameraHelperCommand,
    cameraHelperTimeoutMs: positiveInteger(merged.cameraHelperTimeoutMs, 30_000, 1_000, 300_000),
    cameraCaptureDir,
    cameraExpectedModel,
    cameraExpectedSerial,
    cameraExpectedLensModel,
    cameraExpectedLensSerial,
    cameraExpectedFocalLengthMm,
    cameraRuntimeManifestPath,
    cameraManifestArchiveMaxEntries: positiveInteger(
      merged.cameraManifestArchiveMaxEntries,
      32,
      1,
      1_024,
    ),
    cameraManifestArchiveMaxBytes: positiveInteger(
      merged.cameraManifestArchiveMaxBytes,
      128 * 1024 * 1024,
      1_048_576,
      Number.MAX_SAFE_INTEGER,
    ),
    renderer: {
      backend: rendererBackend,
      command: rendererCommand ? String(rendererCommand) : null,
      configPath: rendererConfigPath,
      pipe: rendererPipe ? String(rendererPipe) : null,
      bootTokenConfigured: rendererBootToken != null,
      ipcTimeoutMs: positiveInteger(merged.rendererIpcTimeoutMs, 30_000, 100, 120_000),
      adapterLuid,
    },
    configPath: configPath ? resolvePlatformPath(configPath, { cwd, platform }) : null,
  };
}
