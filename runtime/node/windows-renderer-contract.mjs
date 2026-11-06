import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { normalizeOutputConfig } from "../shared/mapping.mjs";
import { normalizeCompositionSource, SPOUT_DXGI_FORMATS } from "../shared/composition-source.mjs";
import { sanitizePlatformNodeId, windowsRendererPipeName } from "./platform-contract.mjs";

export const WINDOWS_RENDERER_SCHEMA_VERSION = 1;
// A 128 x 128-cell mesh contains 16,641 JSON control points per output. The
// bounded 64 MiB envelope carries 32 high-precision calibrated dense outputs;
// the native pipe server independently caps total queued wire data at 128 MiB.
export const WINDOWS_RENDERER_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export const WINDOWS_RENDERER_REQUEST_TYPES = Object.freeze([
  "hello",
  "get-status",
  "release-boot-black",
  "apply-config",
  "set-pattern",
  "blank",
  "shutdown",
]);

export const WINDOWS_RENDERER_RESPONSE_TYPES = Object.freeze(["result", "error", "event"]);

export { SPOUT_DXGI_FORMATS };

const REQUEST_TYPES = new Set(WINDOWS_RENDERER_REQUEST_TYPES);
const RESPONSE_TYPES = new Set(WINDOWS_RENDERER_RESPONSE_TYPES);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const GDI_NAME_PATTERN = /^\\\\\.\\DISPLAY[1-9][0-9]{0,3}$/i;
const DEVICE_PATH_PATTERN = /^\\\\\?\\DISPLAY#.{1,1000}$/i;
const ADAPTER_LUID_PATTERN = /^(?:[0-9a-f]{8}):(?:[0-9a-f]{8})$/i;

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number`);
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function finiteNumber(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return number;
}

function safeText(value, field, { maximum = 256, required = false } = {}) {
  const output = String(value ?? "").trim();
  let hasControl = false;
  for (const character of output) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      hasControl = true;
      break;
    }
  }
  if ((required && !output) || output.length > maximum || hasControl) {
    throw new Error(`${field} is invalid`);
  }
  return output || null;
}

function jsonPayload(value, field = "payload") {
  const payload = value == null ? {} : value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${field} must be an object`);
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new Error(`${field} must be JSON serializable: ${error.message}`);
  }
  if (Buffer.byteLength(serialized, "utf8") > WINDOWS_RENDERER_MAX_MESSAGE_BYTES - 1024) {
    throw new Error(`${field} exceeds the renderer IPC limit`);
  }
  return payload;
}

function nativeAssetPath(value, field) {
  const pathname = safeText(value, field, { maximum: 1024, required: true });
  return pathname;
}

function normalizeNativeTextureAsset(value, field, formats = ["r32_float"]) {
  if (value == null) return null;
  const asset = object(value, field);
  const allowedFormats = Array.isArray(formats) ? formats : [formats];
  const format = String(asset.format || "");
  if (!allowedFormats.includes(format)) {
    throw new Error(`${field}.format must be one of ${allowedFormats.join(", ")}`);
  }
  if (asset.width == null || asset.height == null) throw new Error(`${field} requires width and height`);
  return {
    path: nativeAssetPath(asset.path, `${field}.path`),
    width: boundedInteger(asset.width, 0, 1, 16_384, `${field}.width`),
    height: boundedInteger(asset.height, 0, 1, 16_384, `${field}.height`),
    format,
  };
}

function normalizeNativeLut(value) {
  if (value == null) return null;
  const asset = object(value, "color.lut");
  if (String(asset.format || "") !== "rgba32_float") throw new Error("color.lut.format must be rgba32_float");
  if (asset.size == null) throw new Error("color.lut.size is required");
  return {
    path: nativeAssetPath(asset.path, "color.lut.path"),
    size: boundedInteger(asset.size, 0, 2, 128, "color.lut.size"),
    format: "rgba32_float",
  };
}

export function normalizeWindowsDisplaySelector(input, { required = true } = {}) {
  const value = input == null ? {} : object(input, "display");
  const devicePath = value.devicePath == null ? null : safeText(value.devicePath, "display.devicePath", { maximum: 1024, required: true });
  const gdiName = value.gdiName == null ? null : safeText(value.gdiName, "display.gdiName", { maximum: 32, required: true });
  const adapterLuid = value.adapterLuid == null ? null : safeText(value.adapterLuid, "display.adapterLuid", { maximum: 32, required: true });
  const targetId = value.targetId == null
    ? null
    : boundedInteger(value.targetId, 0, 0, 0xffff_ffff, "display.targetId");
  if (devicePath && !DEVICE_PATH_PATTERN.test(devicePath)) throw new Error("display.devicePath must be a Windows monitor device path");
  if (gdiName && !GDI_NAME_PATTERN.test(gdiName)) throw new Error("display.gdiName must look like \\\\.\\DISPLAY1");
  if (adapterLuid && !ADAPTER_LUID_PATTERN.test(adapterLuid)) {
    throw new Error("display.adapterLuid must use 8-hex:8-hex form");
  }
  if ((adapterLuid == null) !== (targetId == null)) {
    throw new Error("display.adapterLuid and display.targetId must be provided together");
  }
  if (required && !devicePath && !gdiName && !adapterLuid) {
    throw new Error("display requires devicePath, gdiName, or adapterLuid with targetId");
  }
  return {
    ...(devicePath ? { devicePath } : {}),
    ...(gdiName ? { gdiName: gdiName.toUpperCase() } : {}),
    ...(adapterLuid ? { adapterLuid: adapterLuid.toUpperCase(), targetId } : {}),
  };
}

export function normalizeSpoutSource(input, {
  width = 1920,
  height = 1080,
  frameRateNum = 60,
  frameRateDen = 1,
  required = true,
  requireCanvasMatch = false,
} = {}) {
  return normalizeCompositionSource(input, { width, height, frameRateNum, frameRateDen, required, requireCanvasMatch });
}

export function normalizeWindowsRendererConfig(input) {
  const value = object(input, "renderer config");
  const nodeId = sanitizePlatformNodeId(value.nodeId).slice(0, 64);
  const pipeName = String(value.pipeName || windowsRendererPipeName(nodeId));
  if (!/^\\\\\.\\pipe\\pixel-brightness-renderer-[a-z0-9_.-]+$/i.test(pipeName)) {
    throw new Error("renderer config pipeName is invalid");
  }
  const adapterLuid = value.adapterLuid == null
    ? null
    : safeText(value.adapterLuid, "adapterLuid", { maximum: 32, required: true });
  if (adapterLuid && !ADAPTER_LUID_PATTERN.test(adapterLuid)) {
    throw new Error("adapterLuid must use 8-hex:8-hex form");
  }
  const canvasInput = value.canvas || {};
  const canvas = {
    width: boundedInteger(canvasInput.width, 1920, 64, 16_384, "canvas.width"),
    height: boundedInteger(canvasInput.height, 1080, 64, 16_384, "canvas.height"),
    frameRateNum: boundedInteger(canvasInput.frameRateNum, 60, 1, 240_000, "canvas.frameRateNum"),
    frameRateDen: boundedInteger(canvasInput.frameRateDen, 1, 1, 100_000, "canvas.frameRateDen"),
  };
  const legacySources = Array.isArray(value.outputs)
    ? value.outputs.map((output) => output?.source).filter(Boolean)
    : [];
  const compositionSource = normalizeSpoutSource(value.compositionSource || value.source || legacySources[0], {
    width: canvas.width,
    height: canvas.height,
    frameRateNum: canvas.frameRateNum,
    frameRateDen: canvas.frameRateDen,
    requireCanvasMatch: true,
  });
  if (legacySources.some((candidate) => String(candidate?.senderName || "") !== compositionSource.senderName)) {
    throw new Error("All legacy output sources must reference the one composition Spout sender");
  }
  if (compositionSource.timeoutMs < 100 || compositionSource.timeoutMs > 60_000) {
    throw new Error("compositionSource.timeoutMs must be 100-60000 for the native renderer");
  }
  if (!Array.isArray(value.outputs) || value.outputs.length < 1 || value.outputs.length > 32) {
    throw new Error("renderer config requires 1-32 outputs");
  }
  const ids = new Set();
  const outputs = value.outputs.map((inputOutput) => {
    const mapped = normalizeOutputConfig(inputOutput);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(mapped.id)) throw new Error(`Invalid native renderer output id: ${mapped.id}`);
    if (ids.has(mapped.id)) throw new Error(`Duplicate renderer output id: ${mapped.id}`);
    ids.add(mapped.id);
    const display = normalizeWindowsDisplaySelector(inputOutput.display);
    const blendMap = normalizeNativeTextureAsset(inputOutput.blend?.map, "blend.map");
    const blackMap = normalizeNativeTextureAsset(
      inputOutput.blackUniformity?.map,
      "blackUniformity.map",
      ["r32_float", "rgba32_float"],
    );
    const maskMap = normalizeNativeTextureAsset(inputOutput.mask?.map, "mask.map");
    const maskEnabled = inputOutput.mask?.enabled === true;
    const maskPath = Array.isArray(mapped.mask.path) && mapped.mask.path.length >= 3
      ? mapped.mask.path.map((point) => ({ x: point.x, y: point.y }))
      : null;
    if (maskEnabled && !maskMap && !maskPath) {
      throw new Error(`Output ${mapped.id} enabled mask requires an r32_float map or polygon path`);
    }
    const rawResolution = inputOutput.resolution || {};
    const resolution = {
      width: boundedInteger(rawResolution.width, mapped.resolution.width, 64, 16_384, `${mapped.id}.resolution.width`),
      height: boundedInteger(rawResolution.height, mapped.resolution.height, 64, 16_384, `${mapped.id}.resolution.height`),
      refreshNum: boundedInteger(rawResolution.refreshNum, mapped.resolution.refreshNum, 1, 240_000, `${mapped.id}.resolution.refreshNum`),
      refreshDen: boundedInteger(rawResolution.refreshDen, mapped.resolution.refreshDen, 1, 100_000, `${mapped.id}.resolution.refreshDen`),
    };
    const rawViewport = inputOutput.sourceViewport || mapped.sourceViewport;
    const sourceViewport = {
      x: finiteNumber(rawViewport.x, 0, 0, canvas.width, `${mapped.id}.sourceViewport.x`),
      y: finiteNumber(rawViewport.y, 0, 0, canvas.height, `${mapped.id}.sourceViewport.y`),
      width: finiteNumber(rawViewport.width, resolution.width, 0.001, canvas.width, `${mapped.id}.sourceViewport.width`),
      height: finiteNumber(rawViewport.height, resolution.height, 0.001, canvas.height, `${mapped.id}.sourceViewport.height`),
    };
    if (sourceViewport.x + sourceViewport.width > canvas.width
      || sourceViewport.y + sourceViewport.height > canvas.height) {
      throw new Error(`Output ${mapped.id} sourceViewport exceeds the master canvas`);
    }
    return {
      id: mapped.id,
      enabled: mapped.enabled,
      display,
      resolution,
      sourceViewport,
      processing: {
        bypass: inputOutput.processing?.bypass === true,
        order: ["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"],
      },
      overlap: mapped.overlap,
      warp: {
        enabled: inputOutput.warp?.enabled !== false,
        columns: mapped.warp.columns,
        rows: mapped.warp.rows,
        interpolation: mapped.warp.interpolation,
        points: mapped.warp.points.map((point) => ({ u: point.u, v: point.v, x: point.x, y: point.y })),
      },
      blend: {
        enabled: mapped.blend.enabled,
        feather: mapped.blend.feather,
        gamma: mapped.blend.gamma,
        map: blendMap,
      },
      blackUniformity: {
        enabled: mapped.blackUniformity.enabled,
        lift: mapped.blackUniformity.lift,
        map: blackMap,
      },
      color: {
        gain: mapped.color.gain,
        offset: mapped.color.offset,
        gamma: mapped.color.gamma,
        lut: normalizeNativeLut(inputOutput.color?.lut),
      },
      mask: {
        enabled: maskEnabled,
        map: maskMap,
        ...(maskPath ? { path: maskPath } : {}),
        softness: mapped.mask.softness,
      },
    };
  });
  const telemetryInput = value.telemetry && typeof value.telemetry === "object" && !Array.isArray(value.telemetry)
    ? value.telemetry
    : {};
  return {
    schemaVersion: WINDOWS_RENDERER_SCHEMA_VERSION,
    revision: boundedInteger(value.revision, 1, 1, Number.MAX_SAFE_INTEGER, "revision"),
    nodeId,
    ...(adapterLuid ? { adapterLuid: adapterLuid.toUpperCase() } : {}),
    pipeName,
    vsync: value.vsync !== false,
    topmost: value.topmost !== false,
    telemetry: {
      ...(telemetryInput.path == null ? {} : {
        path: safeText(telemetryInput.path, "telemetry.path", { maximum: 1024, required: true }),
      }),
      intervalMs: boundedInteger(telemetryInput.intervalMs, 1_000, 100, 60_000, "telemetry.intervalMs"),
    },
    canvas,
    compositionSource,
    outputs,
  };
}

export function normalizeWindowsRendererEnvelope(input, { direction = "request" } = {}) {
  const value = object(input, "renderer IPC envelope");
  if (Number(value.schemaVersion) !== WINDOWS_RENDERER_SCHEMA_VERSION) {
    throw new Error(`renderer IPC schemaVersion must be ${WINDOWS_RENDERER_SCHEMA_VERSION}`);
  }
  const types = direction === "response" ? RESPONSE_TYPES : REQUEST_TYPES;
  const type = String(value.type || "");
  if (!types.has(type)) throw new Error(`Unsupported renderer IPC ${direction} type: ${type || "(missing)"}`);
  const requestId = safeText(value.requestId, "requestId", { maximum: 128, required: type !== "event" });
  if (requestId && !REQUEST_ID_PATTERN.test(requestId)) throw new Error("renderer IPC requestId is invalid");
  const normalized = {
    schemaVersion: WINDOWS_RENDERER_SCHEMA_VERSION,
    ...(requestId ? { requestId } : {}),
    type,
    ...(direction === "response" ? { ok: value.ok === true } : {}),
    payload: jsonPayload(value.payload),
  };
  if (direction === "response" && value.error != null) {
    const error = object(value.error, "error");
    normalized.error = {
      code: safeText(error.code || "RENDERER_ERROR", "error.code", { maximum: 128, required: true }),
      message: safeText(error.message || "Renderer request failed", "error.message", { maximum: 4096, required: true }),
      ...(error.details == null ? {} : { details: error.details }),
    };
  }
  return normalized;
}

export function encodeWindowsRendererMessage(input, options) {
  const normalized = normalizeWindowsRendererEnvelope(input, options);
  const message = `${JSON.stringify(normalized)}\n`;
  if (Buffer.byteLength(message, "utf8") > WINDOWS_RENDERER_MAX_MESSAGE_BYTES) {
    throw new Error("renderer IPC message exceeds 64 MiB");
  }
  return message;
}

export function decodeWindowsRendererMessage(input, options = { direction: "response" }) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buffer.byteLength > WINDOWS_RENDERER_MAX_MESSAGE_BYTES) throw new Error("renderer IPC message exceeds 64 MiB");
  const line = buffer.toString("utf8").replace(/\r?\n$/, "");
  if (line.includes("\n") || line.includes("\r")) throw new Error("renderer IPC expects exactly one NDJSON record");
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`renderer IPC returned invalid JSON: ${error.message}`);
  }
  return normalizeWindowsRendererEnvelope(parsed, options);
}

export function rendererLaunchArgs({ configPath, pipeName, nodeId }) {
  if (!configPath || String(configPath).includes("\0")) throw new Error("renderer configPath is required");
  const pipe = pipeName || windowsRendererPipeName(nodeId);
  if (!/^\\\\\.\\pipe\\pixel-brightness-renderer-[a-z0-9_.-]+$/i.test(pipe)) throw new Error("renderer pipe name is invalid");
  return ["--config", String(configPath), "--pipe", pipe, "--node-id", sanitizePlatformNodeId(nodeId)];
}

export class WindowsRendererIpcClient {
  constructor({
    nodeId,
    pipeName = windowsRendererPipeName(nodeId),
    timeoutMs = 30_000,
    createConnectionImpl = createConnection,
    onEvent = () => {},
  } = {}) {
    if (!/^\\\\\.\\pipe\\pixel-brightness-renderer-[a-z0-9_.-]+$/i.test(pipeName)) throw new Error("renderer pipe name is invalid");
    this.pipeName = pipeName;
    this.timeoutMs = boundedInteger(timeoutMs, 30_000, 100, 120_000, "timeoutMs");
    this.createConnectionImpl = createConnectionImpl;
    this.onEvent = onEvent;
  }

  request(type, payload = {}, { requestId = `req-${randomUUID()}`, timeoutMs = this.timeoutMs } = {}) {
    const request = { schemaVersion: WINDOWS_RENDERER_SCHEMA_VERSION, requestId, type, payload };
    const message = encodeWindowsRendererMessage(request, { direction: "request" });
    return new Promise((resolve, reject) => {
      let complete = false;
      let bytes = 0;
      let pending = Buffer.alloc(0);
      const socket = this.createConnectionImpl(this.pipeName);
      const finish = (error, result) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        socket.destroy?.();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("renderer IPC request timed out")), boundedInteger(timeoutMs, this.timeoutMs, 100, 120_000, "timeoutMs"));
      socket.once("connect", () => socket.write(message));
      socket.on("data", (chunk) => {
        const data = Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > WINDOWS_RENDERER_MAX_MESSAGE_BYTES) return finish(new Error("renderer IPC response exceeds 64 MiB"));
        pending = Buffer.concat([pending, data]);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0 && !complete) {
          const line = pending.subarray(0, newline + 1);
          pending = pending.subarray(newline + 1);
          try {
            const response = decodeWindowsRendererMessage(line, { direction: "response" });
            if (response.type === "event") {
              this.onEvent(response.payload);
              newline = pending.indexOf(0x0a);
              continue;
            }
            if (response.requestId !== requestId) throw new Error("renderer IPC response requestId does not match");
            if (!response.ok || response.type === "error") {
              const error = new Error(response.error?.message || "Renderer request failed");
              error.code = response.error?.code || "RENDERER_ERROR";
              error.details = response.error?.details || null;
              return finish(error);
            }
            finish(null, response);
          } catch (error) {
            finish(error);
          }
          newline = pending.indexOf(0x0a);
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("end", () => {
        if (!complete) finish(new Error("renderer IPC connection ended before a response"));
      });
    });
  }
}
