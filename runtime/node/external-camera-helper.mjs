import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { CameraAdapter } from "./camera-calibration.mjs";
import {
  CameraCalibrationError,
  normalizeCameraDescriptor,
  normalizeManualCameraSettings,
  normalizeRawDecodeMetadata,
  normalizeRawDecoderProvenance,
  verifyManualCameraLock,
} from "../shared/camera-calibration.mjs";
import { normalizeCameraSurveyPreviewCommand } from "../shared/camera-survey-preview.mjs";
import {
  CAMERA_HELPER_PROTOCOL_VERSION,
  CANON_R50_CAMERA_MODEL,
  CANON_RF_S_10_18_LENS_MODEL,
  SINGLE_SHOT_RAW_SOURCE_POLICY,
} from "./camera-helper-contract.mjs";
import { loadCanonCameraRuntimeManifest } from "./camera-runtime-manifest.mjs";
import {
  normalizeCameraSpatialTransform,
  normalizeCanonCaptureEvidence,
} from "../shared/canon-camera-evidence.mjs";

const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const LINEAR_RGB_F32_LE = "linear-rgb-f32-le";
const LINEAR_LUMA_F32_LE = "linear-luma-f32-le";

export { CANON_R50_CAMERA_MODEL, CANON_RF_S_10_18_LENS_MODEL };

function inside(root, target) {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function helperError(code, message, details = null) {
  return new CameraCalibrationError(code, message, details == null ? undefined : details);
}

function exactDescriptor(input, field, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw helperError("CAMERA_RAW_PROVENANCE_INVALID", `${field} must be an exact object`);
  }
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw helperError(
      "CAMERA_RAW_PROVENANCE_INVALID",
      `${field} must contain exactly: ${expected.join(", ")}`,
    );
  }
  return input;
}

function hasExactKeys(input, keys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactText(value, field, { required = false, maximum = 256 } = {}) {
  if (value == null || value === "") {
    if (required) throw helperError("CAMERA_BINDING_INVALID", `${field} is required`);
    return null;
  }
  const text = String(value).trim();
  const hasControl = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!text || text.length > maximum || hasControl) {
    throw helperError("CAMERA_BINDING_INVALID", `${field} is invalid`);
  }
  return text;
}

function exactSourcePolicy(value, expected, field = "cameraHelper.sourcePolicy") {
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw helperError(
      "CAMERA_RAW_SOURCE_POLICY_MISMATCH",
      `${field} must prove one original single-shot RAW download with no JPEG, live-view or spatial substitution`,
    );
  }
  return structuredClone(expected);
}

function cancelled(signal) {
  if (signal?.aborted) {
    throw helperError("CALIBRATION_CANCELLED", "Camera calibration was cancelled");
  }
}

async function sha256File(pathname, signal = null) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) {
    cancelled(signal);
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Process-isolated camera SDK boundary.
 *
 * Proprietary vendor SDKs never load into the render-node process. The helper
 * speaks bounded NDJSON on stdio and writes large decoded rasters beneath one
 * caller-owned capture root. Every raster is path-confined, size checked and
 * SHA-256 verified before it becomes a Float32Array.
 */
export class ExternalCameraHelperAdapter extends CameraAdapter {
  constructor({
    command,
    captureRoot,
    backend = "sony-camera-remote-sdk",
    expectedModel = "ILCE-7M4",
    expectedVendor = null,
    expectedSerial = null,
    expectedTransport = null,
    expectedLensVendor = null,
    expectedLensModel = null,
    expectedLensSerial = null,
    requiredRawFormat = null,
    requiredSourceMediaType = null,
    sourcePolicy = SINGLE_SHOT_RAW_SOURCE_POLICY,
    sourceContractForLimits = null,
    runtimeManifestPath = null,
    expectedFocalLengthMm = null,
    strictSession = false,
    requiredBitDepth = 14,
    timeoutMs = 30_000,
    maxCaptureBytes = 256 * 1024 * 1024,
    log = () => {},
  } = {}) {
    super();
    this.command = command ? resolve(String(command)) : null;
    this.captureRoot = captureRoot ? resolve(String(captureRoot)) : null;
    this.backend = String(backend || "external-camera-helper");
    this.expectedModel = exactText(expectedModel, "expectedModel");
    this.expectedVendor = exactText(expectedVendor, "expectedVendor");
    this.expectedSerial = exactText(expectedSerial, "expectedSerial");
    this.expectedTransport = exactText(expectedTransport, "expectedTransport", { maximum: 64 });
    this.expectedLensVendor = exactText(expectedLensVendor, "expectedLensVendor");
    this.expectedLensModel = exactText(expectedLensModel, "expectedLensModel");
    this.expectedLensSerial = exactText(expectedLensSerial, "expectedLensSerial");
    this.requiredRawFormat = exactText(requiredRawFormat, "requiredRawFormat", { maximum: 32 });
    this.requiredSourceMediaType = exactText(requiredSourceMediaType, "requiredSourceMediaType", { maximum: 128 });
    this.sourcePolicy = structuredClone(sourcePolicy);
    this.sourceContractForLimits = typeof sourceContractForLimits === "function"
      ? sourceContractForLimits
      : null;
    this.runtimeManifestPath = runtimeManifestPath ? resolve(String(runtimeManifestPath)) : null;
    this.expectedFocalLengthMm = expectedFocalLengthMm == null ? null : Number(expectedFocalLengthMm);
    if (this.expectedFocalLengthMm != null
      && (!Number.isFinite(this.expectedFocalLengthMm)
        || this.expectedFocalLengthMm < 1 || this.expectedFocalLengthMm > 2_000)) {
      throw helperError("CAMERA_BINDING_INVALID", "expectedFocalLengthMm is invalid");
    }
    this.strictSession = strictSession === true;
    this.requiredBitDepth = Math.max(8, Math.min(32, Math.round(Number(requiredBitDepth) || 14)));
    this.timeoutMs = Math.max(1_000, Math.min(300_000, Math.round(Number(timeoutMs) || 30_000)));
    this.maxCaptureBytes = Math.max(1_048_576, Math.min(512 * 1024 * 1024, Math.round(Number(maxCaptureBytes) || 0)));
    this.log = log;
    this.child = null;
    this.stdout = "";
    this.stderr = "";
    this.sequence = 0;
    this.pending = new Map();
    this.rootRealPath = null;
    this.closing = false;
    this.detected = new Map();
    this.openedCamera = null;
    this.openedLens = null;
    this.manualLock = null;
    this.captureBusy = false;
    this.runtimeBinding = null;
    this.captureEvidence = null;
  }

  #invalidateSession() {
    this.detected.clear();
    this.openedCamera = null;
    this.openedLens = null;
    this.manualLock = null;
    this.captureEvidence = null;
  }

  #bindingRequest() {
    return {
      camera: {
        vendor: this.expectedVendor,
        model: this.expectedModel,
        serial: this.expectedSerial,
        transport: this.expectedTransport,
      },
      lens: {
        vendor: this.expectedLensVendor,
        model: this.expectedLensModel,
        serial: this.expectedLensSerial,
      },
      capture: {
        rawFormat: this.requiredRawFormat,
        sourceBitDepth: this.requiredBitDepth,
        sourcePolicy: this.sourcePolicy,
      },
    };
  }

  #captureSourceContract(limits) {
    if (!this.sourceContractForLimits) {
      return { sourcePolicy: structuredClone(this.sourcePolicy), spatialTransform: null };
    }
    const contract = this.sourceContractForLimits(limits);
    if (!contract?.sourcePolicy || !contract?.spatialTransform) {
      throw helperError(
        "CAMERA_CAPTURE_LIMIT_UNSATISFIABLE",
        "No exact full-frame Canon area-bin fits the requested capture limits",
      );
    }
    return {
      sourcePolicy: structuredClone(contract.sourcePolicy),
      spatialTransform: normalizeCameraSpatialTransform(contract.spatialTransform),
    };
  }

  #boundCamera(input, field = "cameraHelper.camera") {
    let camera;
    try {
      camera = normalizeCameraDescriptor(input);
    } catch (error) {
      throw helperError("CAMERA_BINDING_INVALID", `${field} is invalid: ${error.message}`);
    }
    const mismatch = (expected, actual) => expected != null && actual !== expected;
    const modelMismatch = this.expectedModel != null && (this.strictSession
      ? camera.model !== this.expectedModel
      : camera.model.toUpperCase() !== this.expectedModel.toUpperCase());
    if (mismatch(this.expectedVendor, camera.vendor)
      || modelMismatch
      || mismatch(this.expectedSerial, camera.serial)
      || mismatch(this.expectedTransport, camera.transport)
      || (this.strictSession && (!camera.serial || camera.backend !== this.backend))) {
      throw helperError(
        "CAMERA_BINDING_MISMATCH",
        `${field} did not match the configured camera vendor, model, serial, transport and backend`,
      );
    }
    if (this.strictSession) {
      const missing = ["manualExposure", "manualWhiteBalance", "manualFocus", "linearCapture"]
        .filter((key) => camera.capabilities[key] !== true);
      if (missing.length > 0) {
        throw helperError("CAMERA_CAPABILITY_MISSING", `${field} omitted required controls`, { missing });
      }
    }
    return camera;
  }

  #sameLensBinding(left, right) {
    return left != null && right != null
      && left.vendor === right.vendor
      && left.model === right.model
      && left.serial === right.serial;
  }

  #boundLens(input, field = "cameraHelper.lens", { requireFocalLength = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw helperError("CAMERA_LENS_BINDING_MISMATCH", `${field} must be an object`);
    }
    const lens = {
      ...input,
      vendor: exactText(input.vendor, `${field}.vendor`, { required: true, maximum: 128 }),
      model: exactText(input.model, `${field}.model`, { required: true }),
      serial: exactText(input.serial, `${field}.serial`),
    };
    const mismatch = (expected, actual) => expected != null && actual !== expected;
    if (mismatch(this.expectedLensVendor, lens.vendor)
      || mismatch(this.expectedLensModel, lens.model)
      || mismatch(this.expectedLensSerial, lens.serial)) {
      throw helperError(
        "CAMERA_LENS_BINDING_MISMATCH",
        `${field} did not match the configured lens vendor, model and serial`,
      );
    }
    if (requireFocalLength && (this.expectedFocalLengthMm == null
      || !Number.isFinite(Number(lens.focalLengthMm))
      || Math.abs(Number(lens.focalLengthMm) - this.expectedFocalLengthMm) > 0.05)) {
      throw helperError(
        "CAMERA_LENS_BINDING_MISMATCH",
        `${field} did not prove the configured focal length within 0.05 mm`,
      );
    }
    return lens;
  }

  async #start() {
    if (this.child) return;
    if (!this.command || !isAbsolute(this.command) || !this.captureRoot) {
      throw helperError(
        "CAMERA_HELPER_UNAVAILABLE",
        `${this.backend} requires an absolute helper command and capture root`,
        { backend: this.backend },
      );
    }
    await mkdir(this.captureRoot, { recursive: true });
    this.rootRealPath = await realpath(this.captureRoot);
    if (this.strictSession) {
      this.runtimeBinding = await loadCanonCameraRuntimeManifest(this.runtimeManifestPath);
    }
    this.closing = false;
    this.stdout = "";
    this.stderr = "";
    const child = spawn(this.command, [
      "--stdio",
      "--capture-root", this.rootRealPath,
      ...(this.runtimeBinding ? ["--runtime-manifest", this.runtimeBinding.path] : []),
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        WINDIR: process.env.WINDIR || "",
        TEMP: process.env.TEMP || "",
        TMP: process.env.TMP || "",
      },
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      if (this.child === child) this.child = null;
      this.#invalidateSession();
      this.#terminatePending(
        helperError("CAMERA_HELPER_START_FAILED", `Camera helper could not start: ${error.message}`),
      );
    });
    child.once("exit", (code, signal) => {
      const expected = this.closing;
      this.child = null;
      this.#invalidateSession();
      this.#terminatePending(helperError(
        expected ? "CAMERA_HELPER_CLOSED" : "CAMERA_HELPER_EXITED",
        `Camera helper exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
        { code, signal, stderr: this.stderr || null },
      ));
    });
  }

  #terminatePending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #abortHelper(error) {
    const child = this.child;
    this.child = null;
    this.closing = true;
    this.#invalidateSession();
    child?.kill();
    this.#terminatePending(error);
  }

  #consumeStdout(chunk) {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout, "utf8") > MAX_PROTOCOL_LINE_BYTES && !this.stdout.includes("\n")) {
      this.#abortHelper(helperError("CAMERA_HELPER_PROTOCOL_ERROR", "Camera helper emitted an oversized protocol record"));
      return;
    }
    for (;;) {
      const lineEnd = this.stdout.indexOf("\n");
      if (lineEnd < 0) break;
      const line = this.stdout.slice(0, lineEnd).trim();
      this.stdout = this.stdout.slice(lineEnd + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        this.#abortHelper(helperError("CAMERA_HELPER_PROTOCOL_ERROR", "Camera helper emitted an oversized protocol record"));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#abortHelper(helperError("CAMERA_HELPER_PROTOCOL_ERROR", "Camera helper emitted invalid JSON"));
        return;
      }
      if (this.strictSession) {
        const validSuccess = message?.ok === true
          && message.schemaVersion === CAMERA_HELPER_PROTOCOL_VERSION
          && hasExactKeys(message, ["schemaVersion", "id", "ok", "result"])
          && message.result && typeof message.result === "object" && !Array.isArray(message.result);
        const validErrorBody = hasExactKeys(message?.error, ["code", "message"])
          || hasExactKeys(message?.error, ["code", "message", "details"]);
        const validError = message?.ok === false
          && message.schemaVersion === CAMERA_HELPER_PROTOCOL_VERSION
          && hasExactKeys(message, ["schemaVersion", "id", "ok", "error"])
          && validErrorBody;
        if (!validSuccess && !validError) {
          this.#abortHelper(helperError(
            "CAMERA_HELPER_PROTOCOL_ERROR",
            "Canon helper response envelope must use schemaVersion 1 and exact success/error keys",
          ));
          return;
        }
      }
      const id = String(message?.id || "");
      const pending = this.pending.get(id);
      if (!pending) {
        this.#abortHelper(helperError("CAMERA_HELPER_PROTOCOL_ERROR", `Camera helper returned an unknown request id: ${id || "(missing)"}`));
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      if (message.ok !== true) {
        pending.reject(helperError(
          String(message?.error?.code || "CAMERA_HELPER_REQUEST_FAILED"),
          String(message?.error?.message || "Camera helper request failed"),
          message?.error?.details ?? null,
        ));
      } else {
        pending.resolve(message.result ?? null);
      }
    }
  }

  async #request(method, params = {}, { signal = null, timeoutMs = this.timeoutMs } = {}) {
    await this.#start();
    if (signal?.aborted) throw helperError("CALIBRATION_CANCELLED", "Camera calibration was cancelled");
    const id = `camera-${++this.sequence}`;
    const child = this.child;
    return new Promise((resolvePromise, reject) => {
      const onAbort = () => this.#abortHelper(helperError("CALIBRATION_CANCELLED", "Camera calibration was cancelled"));
      const timer = setTimeout(() => {
        this.#abortHelper(helperError(
          "CAMERA_HELPER_TIMEOUT",
          `Camera helper ${method} exceeded ${timeoutMs} ms`,
          { method, timeoutMs },
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, signal, onAbort });
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({
        schemaVersion: CAMERA_HELPER_PROTOCOL_VERSION,
        id,
        method,
        params,
      })}\n`, (error) => {
        if (!error) return;
        this.#abortHelper(helperError("CAMERA_HELPER_WRITE_FAILED", `Camera helper request failed: ${error.message}`));
      });
    });
  }

  async detect({ signal = null } = {}) {
    if (this.strictSession) this.#invalidateSession();
    try {
      const result = await this.#request("detect", {
        backend: this.backend,
        expectedModel: this.expectedModel,
        binding: this.#bindingRequest(),
      }, { signal });
      if (!Number.isSafeInteger(result?.protocolVersion)
        || result.protocolVersion !== CAMERA_HELPER_PROTOCOL_VERSION) {
        throw helperError(
          "CAMERA_HELPER_PROTOCOL_ERROR",
          "Camera helper must report exact supported protocolVersion 1",
        );
      }
      const cameras = Array.isArray(result?.cameras) ? result.cameras : [];
      const matching = [];
      this.detected.clear();
      for (const candidate of cameras) {
        let camera;
        try {
          camera = this.#boundCamera(candidate, "cameraHelper.detect.camera");
          const lens = this.strictSession
            ? this.#boundLens(candidate?.lens, "cameraHelper.detect.camera.lens")
            : null;
          matching.push(camera);
          this.detected.set(camera.id, { camera, lens });
        } catch (error) {
          if (!(error instanceof CameraCalibrationError)) throw error;
        }
      }
      return {
        adapter: {
          backend: this.backend,
          platform: process.platform,
          implemented: true,
          available: matching.length > 0,
          protocolVersion: result.protocolVersion,
          helperVersion: result?.helperVersion == null ? null : String(result.helperVersion),
        },
        cameras: matching,
        error: matching.length > 0 ? null : {
          code: "CAMERA_NOT_FOUND",
          message: this.expectedModel
            ? `Camera helper did not detect required model ${this.expectedModel}`
            : "Camera helper did not detect a compatible camera",
        },
      };
    } catch (error) {
      return {
        adapter: { backend: this.backend, platform: process.platform, implemented: true, available: false },
        cameras: [],
        error: { code: error.code || "CAMERA_HELPER_UNAVAILABLE", message: error.message },
      };
    }
  }

  async open(cameraId, { signal = null } = {}) {
    const id = String(cameraId);
    if (this.strictSession && !this.detected.has(id)) {
      throw helperError("CAMERA_NOT_FOUND", "Camera must match a fresh helper detection before it can be opened");
    }
    if (this.strictSession) {
      this.openedCamera = null;
      this.openedLens = null;
      this.manualLock = null;
    }
    try {
      const result = await this.#request("open", {
        cameraId: id,
        binding: this.#bindingRequest(),
      }, { signal });
      if (!this.strictSession) return result;
      if (result?.opened !== true) {
        throw helperError("CAMERA_OPEN_NOT_CONFIRMED", "Camera helper did not confirm the selected camera was opened");
      }
      const camera = this.#boundCamera(result.camera, "cameraHelper.open.camera");
      const lens = this.#boundLens(result.lens, "cameraHelper.open.lens");
      if (camera.id !== id
        || canonicalJson(camera) !== canonicalJson(this.detected.get(id)?.camera)
        || !this.#sameLensBinding(lens, this.detected.get(id)?.lens)) {
        throw helperError(
          "CAMERA_BINDING_CHANGED",
          "Camera or lens binding changed between detection and open",
        );
      }
      this.openedCamera = camera;
      this.openedLens = lens;
      return camera;
    } catch (error) {
      if (this.strictSession && this.child) this.#abortHelper(error);
      throw error;
    }
  }

  async lockManualSettings(settings, { signal = null } = {}) {
    if (this.strictSession && !this.openedCamera) {
      throw helperError("CAMERA_NOT_OPEN", "Camera must be opened before manual settings are locked");
    }
    this.manualLock = null;
    const requested = this.strictSession ? normalizeManualCameraSettings(settings) : settings;
    try {
      const result = await this.#request("lock-manual-settings", {
        settings: requested,
        binding: this.#bindingRequest(),
        sourcePolicy: this.sourcePolicy,
      }, { signal });
      if (!this.strictSession) return result;
      const lock = verifyManualCameraLock(requested, result);
      const camera = this.#boundCamera(result.camera, "cameraHelper.lock.camera");
      const lens = this.#boundLens(result.lens, "cameraHelper.lock.lens", { requireFocalLength: true });
      exactSourcePolicy(result.sourcePolicy, this.sourcePolicy, "cameraHelper.lock.sourcePolicy");
      if (canonicalJson(camera) !== canonicalJson(this.openedCamera)
        || !this.#sameLensBinding(lens, this.openedLens)) {
        throw helperError(
          "CAMERA_BINDING_CHANGED",
          "Camera or lens binding changed while manual settings were locked",
        );
      }
      this.manualLock = lock;
      return lock;
    } catch (error) {
      if (this.strictSession && this.child) this.#abortHelper(error);
      throw error;
    }
  }

  async #materializeCapture(result, {
    step = null,
    repeat = 0,
    limits = {},
    signal = null,
    expectedSettings = null,
    expectedSourcePolicy = this.sourcePolicy,
    expectedSpatialTransform = null,
  } = {}) {
    cancelled(signal);
    const cleanupCandidates = new Set();
    for (const value of [result?.raster?.path, result?.source?.path]) {
      if (typeof value !== "string" || !value) continue;
      const candidate = resolve(value);
      if (inside(this.rootRealPath, candidate)) cleanupCandidates.add(candidate);
    }
    try {
    const raster = result?.raster;
    const width = Math.round(Number(raster?.width));
    const height = Math.round(Number(raster?.height));
    const format = String(raster?.pixelFormat || "");
    const channels = format === LINEAR_RGB_F32_LE ? 3 : format === LINEAR_LUMA_F32_LE ? 1 : 0;
    const byteLength = Math.round(Number(raster?.byteLength));
    const sourceBitDepth = Math.round(Number(result?.sourceBitDepth));
    const linearized = result?.linearized === true;
    const pipelineInput = result?.pipeline;
    const lensInput = result?.lens;
    const cameraModel = String(result?.camera?.model || "");
    const pixels = width * height;
    const maxPixels = Math.round(Number(limits.maxPixels ?? Number.MAX_SAFE_INTEGER));
    const maxWidth = Math.round(Number(limits.maxWidth ?? Number.MAX_SAFE_INTEGER));
    const maxHeight = Math.round(Number(limits.maxHeight ?? Number.MAX_SAFE_INTEGER));
    const maxRawBytes = Math.min(
      this.maxCaptureBytes,
      Math.round(Number(limits.maxRawBytes ?? this.maxCaptureBytes)),
    );
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2
      || channels === 0 || !Number.isSafeInteger(pixels) || pixels < 4
      || !Number.isSafeInteger(maxPixels) || !Number.isSafeInteger(maxWidth) || !Number.isSafeInteger(maxHeight)
      || !Number.isSafeInteger(maxRawBytes) || maxPixels < 4 || maxWidth < 2 || maxHeight < 2 || maxRawBytes < 1
      || pixels > maxPixels || width > maxWidth || height > maxHeight
      || byteLength !== pixels * channels * Float32Array.BYTES_PER_ELEMENT
      || byteLength > maxRawBytes) {
      throw helperError("INVALID_CAMERA_FRAME", "Camera helper returned an invalid or oversized raster descriptor");
    }
    if (sourceBitDepth !== this.requiredBitDepth || !linearized
      || !pipelineInput || typeof pipelineInput !== "object"
      || pipelineInput.captureMode !== "single-shot"
      || !["mechanical", "efcs"].includes(pipelineInput.shutterMode)
      || !["uncompressed", "lossless-compressed"].includes(pipelineInput.rawEncoding)
      || pipelineInput.blackLevelSubtracted !== false
      || pipelineInput.whiteBalanceApplied !== false
      || pipelineInput.toneCurveApplied !== false
      || pipelineInput.noiseReductionApplied !== false
      || pipelineInput.lensCorrectionsApplied !== false
      || !lensInput || typeof lensInput !== "object"
      || lensInput.focusLocked !== true
      || lensInput.zoomLocked !== true
      || lensInput.stabilization !== "off") {
      throw helperError(
        "CAMERA_CAPTURE_PIPELINE_MISMATCH",
        `Camera helper must return locked single-shot mechanical/EFCS, lossless linear ${this.requiredBitDepth}-bit RAW provenance with sensor black retained`,
      );
    }
    if (this.expectedModel && cameraModel.toUpperCase() !== this.expectedModel.toUpperCase()) {
      throw helperError(
        "CAMERA_MODEL_MISMATCH",
        `Camera helper captured from ${cameraModel || "an unknown body"}; expected ${this.expectedModel}`,
      );
    }
    const capturedCamera = this.#boundCamera(result?.camera, "cameraHelper.capture.camera");
    const capturedLens = this.#boundLens(result?.lens, "cameraHelper.capture.lens", {
      requireFocalLength: this.strictSession,
    });
    let capturedLock = null;
    let sourcePolicy = null;
    if (this.strictSession) {
      if (!this.openedCamera || !this.manualLock) {
        throw helperError("CAMERA_NOT_LOCKED", "Camera must be opened and manually locked before capture");
      }
      if (canonicalJson(capturedCamera) !== canonicalJson(this.openedCamera)
        || !this.#sameLensBinding(capturedLens, this.openedLens)) {
        throw helperError(
          "CAMERA_BINDING_CHANGED",
          "Camera or lens binding changed before the RAW capture completed",
        );
      }
      const requestedSettings = normalizeManualCameraSettings(expectedSettings || this.manualLock.applied);
      if (canonicalJson(requestedSettings) !== canonicalJson(this.manualLock.applied)) {
        throw helperError(
          "CAMERA_SETTINGS_NOT_LOCKED",
          "Capture settings do not match the active verified manual lock",
        );
      }
      capturedLock = verifyManualCameraLock(requestedSettings, result?.manualLock);
      sourcePolicy = exactSourcePolicy(result?.sourcePolicy, expectedSourcePolicy);
      if (String(result?.rawSourceKind || "") !== expectedSourcePolicy.kind) {
        throw helperError(
          "CAMERA_RAW_SOURCE_POLICY_MISMATCH",
          "Camera helper did not prove the raster came from the original single-shot RAW download",
        );
      }
    }
    let decoder;
    let rawDecode;
    try {
      decoder = normalizeRawDecoderProvenance(result?.decoder, "cameraHelper.decoder");
      rawDecode = normalizeRawDecodeMetadata(result?.rawDecode, {
        field: "cameraHelper.rawDecode",
        bitDepth: sourceBitDepth,
      });
    } catch (error) {
      throw helperError(
        "CAMERA_RAW_PROVENANCE_INVALID",
        `Camera helper returned invalid bounded RAW decoder provenance: ${error?.message || "unknown error"}`,
      );
    }
    const sourceSha256 = String(result?.sourceSha256 || "");
    const source = exactDescriptor(result?.source, "cameraHelper.source", this.strictSession
      ? ["path", "byteLength", "sha256", "mediaType", "acquisition"]
      : ["path", "byteLength", "sha256"]);
    const sourceByteLength = Math.round(Number(source.byteLength));
    if (!/^[a-f0-9]{64}$/.test(sourceSha256)
      || source.sha256 !== sourceSha256
      || !Number.isSafeInteger(sourceByteLength)
      || sourceByteLength < 1
      || sourceByteLength > this.maxCaptureBytes
      || String(result?.rawFormat || "") !== rawDecode.rawFormat) {
      throw helperError(
        "CAMERA_RAW_PROVENANCE_INVALID",
        "Camera helper must bind one bounded RAW source file, lowercase digest and matching canonical RAW format to its decode",
      );
    }
    if ((this.requiredRawFormat && rawDecode.rawFormat !== this.requiredRawFormat)
      || (this.strictSession && source.acquisition !== "single-shot-download")
      || (this.requiredSourceMediaType && source.mediaType !== this.requiredSourceMediaType)) {
      throw helperError(
        "CAMERA_RAW_SOURCE_POLICY_MISMATCH",
        "Camera helper RAW format, media type or acquisition origin did not match the configured source policy",
      );
    }
    let spatialTransform = null;
    let captureEvidence = null;
    if (expectedSpatialTransform != null) {
      spatialTransform = normalizeCameraSpatialTransform(result?.spatialTransform);
      if (canonicalJson(spatialTransform) !== canonicalJson(expectedSpatialTransform)
        || width !== spatialTransform.retainedFrame.width
        || height !== spatialTransform.retainedFrame.height
        || rawDecode.sensorWidth !== spatialTransform.sourceFrame.width
        || rawDecode.sensorHeight !== spatialTransform.sourceFrame.height) {
        throw helperError(
          "CAMERA_SPATIAL_TRANSFORM_MISMATCH",
          "Canon helper raster or RAW sensor frame did not match the requested deterministic area bin",
        );
      }
      try {
        captureEvidence = normalizeCanonCaptureEvidence(result?.evidence, {
          runtimeBinding: this.runtimeBinding,
          lens: capturedLens,
          expectedFocalLengthMm: this.expectedFocalLengthMm,
          spatialTransform,
        });
      } catch (error) {
        throw helperError(
          error?.code || "CANON_CAPTURE_EVIDENCE_INVALID",
          error?.message || "Canon capture evidence is invalid",
        );
      }
      if (this.captureEvidence && canonicalJson(this.captureEvidence) !== canonicalJson(captureEvidence)) {
        throw helperError(
          "CANON_CAPTURE_EVIDENCE_CHANGED",
          "Canon SDK, lens or spatial-transform evidence changed during the locked session",
        );
      }
      this.captureEvidence = captureEvidence;
    }
    const requestedPath = resolve(String(raster.path || ""));
    const requestedSourcePath = resolve(String(source.path || ""));
    if (!inside(this.rootRealPath, requestedPath)) {
      throw helperError("CAMERA_CAPTURE_OUTSIDE_ROOT", "Camera helper raster escaped its assigned capture root");
    }
    if (!inside(this.rootRealPath, requestedSourcePath)) {
      throw helperError("CAMERA_CAPTURE_OUTSIDE_ROOT", "Camera helper RAW source escaped its assigned capture root");
    }
    if (this.strictSession && (dirname(requestedPath) !== this.rootRealPath
      || dirname(requestedSourcePath) !== this.rootRealPath
      || extname(requestedSourcePath).toUpperCase() !== `.${this.requiredRawFormat}`)) {
      throw helperError(
        "CAMERA_RAW_SOURCE_POLICY_MISMATCH",
        "Canon exchange files must be direct capture-root children and the original source must use the .CR3 extension",
      );
    }
    try {
      const [information, sourceInformation] = await Promise.all([
        lstat(requestedPath),
        lstat(requestedSourcePath),
      ]);
      if (!information.isFile() || information.isSymbolicLink() || information.size !== byteLength) {
        throw helperError("CAMERA_CAPTURE_FILE_INVALID", "Camera helper raster is not a regular file with the declared size");
      }
      if (!sourceInformation.isFile() || sourceInformation.isSymbolicLink()
        || sourceInformation.size !== sourceByteLength) {
        throw helperError(
          "CAMERA_RAW_SOURCE_FILE_INVALID",
          "Camera helper RAW source is not a regular file with the declared bounded size",
        );
      }
      const [actualPath, actualSourcePath] = await Promise.all([
        realpath(requestedPath),
        realpath(requestedSourcePath),
      ]);
      if (!inside(this.rootRealPath, actualPath) || !inside(this.rootRealPath, actualSourcePath)) {
        throw helperError("CAMERA_CAPTURE_OUTSIDE_ROOT", "Camera helper capture file escaped its assigned capture root");
      }
      const sameCaptureFile = process.platform === "win32"
        ? actualPath.toLowerCase() === actualSourcePath.toLowerCase()
        : actualPath === actualSourcePath;
      if (sameCaptureFile) {
        throw helperError(
          "CAMERA_RAW_SOURCE_FILE_INVALID",
          "Camera helper RAW source and decoded raster must be distinct files",
        );
      }
      const actualSourceSha256 = await sha256File(actualSourcePath, signal);
      if (actualSourceSha256 !== sourceSha256) {
        throw helperError(
          "CAMERA_RAW_SOURCE_HASH_MISMATCH",
          "Camera helper RAW source failed independent SHA-256 verification",
        );
      }
      cancelled(signal);
      const bytes = await readFile(actualPath, signal ? { signal } : undefined);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!/^[0-9a-f]{64}$/i.test(String(raster.sha256 || "")) || digest !== String(raster.sha256).toLowerCase()) {
        throw helperError("CAMERA_CAPTURE_HASH_MISMATCH", "Camera helper raster failed SHA-256 verification");
      }
      if (bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw helperError("INVALID_CAMERA_FRAME", "Camera helper raster storage is not float-aligned");
      }
      const data = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      for (let index = 0; index < data.length; index += 1) {
        if ((index & 0xfffff) === 0) cancelled(signal);
        const sample = data[index];
        if (!Number.isFinite(sample) || sample < -1 || sample > 16) {
          throw helperError("INVALID_CAMERA_FRAME", "Camera helper raster contains an invalid linear sample");
        }
      }
      const capturedAt = String(result?.capturedAt || (this.strictSession ? "" : new Date().toISOString()));
      if (!Number.isFinite(Date.parse(capturedAt))) {
        throw helperError("CAMERA_RAW_PROVENANCE_INVALID", "Camera helper capturedAt must be an ISO timestamp");
      }
      return {
        id: String(result?.id || `${step?.id || "capture"}#${repeat}`),
        stepId: String(step?.id || result?.stepId || ""),
        outputId: step?.outputId == null ? null : String(step.outputId),
        repeat,
        capturedAt,
        width,
        height,
        pixelFormat: channels === 3 ? "linear-rgb-f32" : "linear-luma-f32",
        data,
        rasterSha256: digest,
        exposureProfileId: step?.exposureProfileId ?? result?.exposureProfileId ?? null,
        passId: step?.passId ?? result?.passId ?? null,
        referenceKind: step?.referenceKind ?? result?.referenceKind ?? null,
        exposure: result?.exposure ?? null,
        conditionVerification: result?.conditionVerification ?? null,
        bitDepth: sourceBitDepth,
        sourceBitDepth,
        linearized,
        cameraDevice: capturedCamera,
        lens: capturedLens,
        pipeline: {
          captureMode: pipelineInput.captureMode,
          shutterMode: pipelineInput.shutterMode,
          rawEncoding: pipelineInput.rawEncoding,
          sourcePixelFormat: String(pipelineInput.sourcePixelFormat || `${result?.rawFormat || "RAW"}-${sourceBitDepth}`),
          retainedPixelFormat: channels === 3 ? "linear-rgb-f32" : "linear-luma-f32",
          bitDepth: sourceBitDepth,
          linearized,
          blackLevelSubtracted: false,
          whiteBalanceApplied: false,
          toneCurveApplied: false,
          noiseReductionApplied: false,
          lensCorrectionsApplied: false,
          ...(spatialTransform == null ? {} : { spatialTransform }),
        },
        provenance: {
          backend: this.backend,
          helperVersion: result?.helperVersion ?? null,
          camera: capturedCamera,
          decoder,
          rawDecode,
          rawFormat: rawDecode.rawFormat,
          rawEncoding: pipelineInput.rawEncoding,
          sourceBitDepth,
          linearized,
          lens: capturedLens,
          settings: capturedLock?.applied ?? result?.settings ?? null,
          ...(this.strictSession ? {
            manualLock: capturedLock,
            sourcePolicy,
            spatialTransform,
            evidence: captureEvidence,
            source: {
              byteLength: sourceByteLength,
              sha256: sourceSha256,
              mediaType: source.mediaType,
              acquisition: source.acquisition,
            },
          } : {}),
          sourceSha256,
          rasterSha256: digest,
        },
        ...(spatialTransform == null ? {} : { spatialTransform }),
      };
    } finally {
      await Promise.allSettled([
        rm(requestedPath, { force: true }),
        rm(requestedSourcePath, { force: true }),
      ]);
    }
    } finally {
      await Promise.allSettled(
        [...cleanupCandidates].map((pathname) => rm(pathname, { force: true })),
      );
    }
  }

  async capture({
    step,
    repeat = 0,
    signal = null,
    maxPixels,
    maxWidth,
    maxHeight,
    maxRawBytes,
    preferredPixelFormat,
    exposureProfileId = null,
    exposureSettings = null,
  } = {}) {
    if (this.strictSession && (!this.openedCamera || !this.manualLock)) {
      throw helperError("CAMERA_NOT_LOCKED", "Camera must be opened and manually locked before capture");
    }
    if (this.strictSession && this.captureBusy) {
      throw helperError("CAMERA_HELPER_BUSY", "Canon helper already has a capture in flight");
    }
    const settings = this.strictSession
      ? normalizeManualCameraSettings(exposureSettings || this.manualLock.applied)
      : exposureSettings;
    const limits = { maxPixels, maxWidth, maxHeight, maxRawBytes, preferredPixelFormat };
    const sourceContract = this.#captureSourceContract(limits);
    this.captureBusy = this.strictSession;
    try {
      const result = await this.#request("capture", {
        step,
        repeat,
        exposureProfileId,
        exposureSettings: settings,
        binding: this.#bindingRequest(),
        sourcePolicy: sourceContract.sourcePolicy,
        limits,
      }, { signal });
      return await this.#materializeCapture(result, {
        step,
        repeat,
        limits,
        signal,
        expectedSettings: settings,
        expectedSourcePolicy: sourceContract.sourcePolicy,
        expectedSpatialTransform: sourceContract.spatialTransform,
      });
    } catch (error) {
      if (this.strictSession && this.child) this.#abortHelper(error);
      throw error;
    } finally {
      this.captureBusy = false;
    }
  }

  async captureSurveyPreview(input = {}, { signal = null } = {}) {
    const request = normalizeCameraSurveyPreviewCommand(input);
    if (this.strictSession) {
      const detection = await this.detect({ signal });
      const camera = detection.cameras.find((candidate) => candidate.id === request.cameraId);
      if (detection.adapter.available !== true || !camera) {
        throw helperError(
          detection.error?.code || "CAMERA_NOT_FOUND",
          detection.error?.message || "The requested bound camera was not detected",
        );
      }
      await this.open(camera.id, { signal });
      await this.lockManualSettings(request.cameraSettings, { signal });
    }
    const result = await this.#request("capture-survey-preview", {
      requestId: request.requestId,
      cameraId: request.cameraId,
      cameraViewId: request.cameraViewId,
      cameraSettings: request.cameraSettings,
      lensProfileBinding: {
        sha256: request.lensProfile.sha256,
        camera: request.lensProfile.camera,
        lens: request.lensProfile.lens,
        frame: request.lensProfile.frame,
        capture: request.lensProfile.capture,
      },
      limits: request.limits,
      sourcePolicy: {
        ...SINGLE_SHOT_RAW_SOURCE_POLICY,
      },
      binding: this.#bindingRequest(),
    }, { signal });
    verifyManualCameraLock(request.cameraSettings, result?.manualLock);
    const capture = await this.#materializeCapture(result, {
      step: { id: request.requestId },
      repeat: 0,
      limits: request.limits,
      signal,
      expectedSettings: request.cameraSettings,
    });
    const profile = request.lensProfile;
    const camera = capture.cameraDevice || {};
    const lens = capture.lens || {};
    const sourceSha256 = String(capture.provenance?.sourceSha256 || "").toLowerCase();
    const cameraMatches = String(camera.vendor || "") === profile.camera.manufacturer
      && String(camera.model || "") === profile.camera.model
      && String(camera.serial || "") === profile.camera.serialNumber;
    const closeEnough = (actual, expected, absolute, relative = 0) => Number.isFinite(Number(actual))
      && Math.abs(Number(actual) - Number(expected)) <= Math.max(absolute, Math.abs(Number(expected)) * relative);
    const lensMatches = String(lens.vendor || "") === profile.lens.manufacturer
      && String(lens.model || "") === profile.lens.model
      && String(lens.serial || "") === profile.lens.serialNumber
      && closeEnough(lens.focalLengthMm, profile.capture.focalLengthMm, 0.05)
      && closeEnough(lens.apertureF, profile.capture.apertureFNumber, 0.05)
      && closeEnough(lens.focusDistanceM, profile.capture.focusDistanceM, 0.02, 0.02);
    const frameMatches = capture.width === profile.frame.width && capture.height === profile.frame.height;
    if (result?.rawSourceKind !== "single-shot-linear-raw-decode-v1"
      || String(result?.lensProfileSha256 || "").toLowerCase() !== profile.sha256
      || !/^[a-f0-9]{64}$/.test(sourceSha256)
      || capture.pixelFormat !== "linear-rgb-f32"
      || !cameraMatches || !lensMatches || !frameMatches) {
      throw helperError(
        "CAMERA_SURVEY_PREVIEW_PROFILE_MISMATCH",
        "Camera helper preview did not match the requested RAW source, body, lens, lock, raster and lens profile",
        { cameraMatches, lensMatches, frameMatches, profileSha256: profile.sha256 },
      );
    }
    return {
      ...capture,
      requestId: request.requestId,
      cameraViewId: request.cameraViewId,
      lensProfileSha256: profile.sha256,
      rawSourceKind: "single-shot-linear-raw-decode-v1",
    };
  }

  async close() {
    this.#invalidateSession();
    if (!this.child) return;
    try {
      await this.#request("close", {}, { timeoutMs: Math.min(this.timeoutMs, 5_000) });
    } finally {
      this.closing = true;
      this.child?.kill();
      this.child = null;
    }
  }
}

/**
 * Process-isolated Canon EOS R50 boundary. This adapter contains no EDSDK
 * binary: an explicitly configured helper owns the proprietary SDK and must
 * prove the exact body/lens binding and one original CR3 source per raster.
 */
export class CanonR50ExternalCameraHelperAdapter extends ExternalCameraHelperAdapter {
  constructor({
    expectedSerial = null,
    expectedLensModel = CANON_RF_S_10_18_LENS_MODEL,
    expectedLensSerial = null,
    ...options
  } = {}) {
    super({
      ...options,
      backend: "canon-edsdk",
      expectedVendor: "Canon",
      expectedModel: CANON_R50_CAMERA_MODEL,
      expectedSerial,
      expectedTransport: "usb",
      expectedLensVendor: "Canon",
      expectedLensModel,
      expectedLensSerial,
      requiredRawFormat: "CR3",
      requiredSourceMediaType: "image/x-canon-cr3",
      requiredBitDepth: 14,
      strictSession: true,
    });
  }
}
