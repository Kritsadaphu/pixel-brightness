import { readFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ExternalCameraHelperAdapter } from "../runtime/node/external-camera-helper.mjs";
import { verifyManualCameraLock } from "../runtime/shared/camera-calibration.mjs";

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null) throw new Error(`Invalid argument: ${name || "(missing)"}`);
    const key = name.slice(2);
    if (!new Set(["authority", "timeout-ms"]).has(key) || Object.hasOwn(result, key)) {
      throw new Error(`Unsupported or duplicate argument: ${name}`);
    }
    result[key] = value;
  }
  if (!result.authority) throw new Error("--authority is required");
  return result;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly ${expected.join(", ")}`);
  }
  return value;
}

function canonicalText(value, label, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateAuthority(input) {
  const authority = exactObject(input, [
    "schemaVersion", "state", "backend", "profile", "generationRoot", "manifestPath",
    "manifestSha256", "helperPath", "helperSha256", "sdkEntryDllPath",
    "sdkEntryDllSha256", "cameraCaptureDir", "helperTimeoutMs", "configuredAt",
  ], "camera authority");
  if (authority.schemaVersion !== 1 || authority.state !== "configured" || authority.backend !== "canon-edsdk") {
    throw new Error("Canon camera authority is not configured");
  }
  exactObject(authority.profile, ["id", "camera", "lens"], "camera profile");
  exactObject(authority.profile.camera, ["vendor", "model", "serialNumber"], "camera identity");
  exactObject(authority.profile.lens, ["vendor", "model", "serialNumber", "mount", "focalLengthMm"], "lens identity");
  if (authority.profile.id !== "canon-eos-r50-rfs-10-18-v1"
    || authority.profile.camera.vendor !== "Canon"
    || authority.profile.camera.model !== "EOS R50"
    || authority.profile.lens.vendor !== "Canon"
    || authority.profile.lens.model !== "RF-S10-18mm F4.5-6.3 IS STM"
    || authority.profile.lens.mount !== "RF"
    || authority.profile.lens.focalLengthMm !== 10) {
    throw new Error("Camera authority is not the exact Canon EOS R50 + RF-S 10-18 profile");
  }
  canonicalText(authority.profile.camera.serialNumber, "camera serial number");
  canonicalText(authority.profile.lens.serialNumber, "lens serial number", { nullable: true });
  for (const [key, value] of Object.entries({
    manifestSha256: authority.manifestSha256,
    helperSha256: authority.helperSha256,
    sdkEntryDllSha256: authority.sdkEntryDllSha256,
  })) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${key} is invalid`);
  }
  for (const key of ["manifestPath", "helperPath", "sdkEntryDllPath", "cameraCaptureDir"]) {
    if (typeof authority[key] !== "string" || !authority[key]) throw new Error(`${key} is invalid`);
  }
  return authority;
}

function exactCamera(cameras, expected) {
  if (!Array.isArray(cameras) || cameras.length !== 1) {
    throw new Error(`Expected exactly one remotely available camera, found ${Array.isArray(cameras) ? cameras.length : 0}`);
  }
  const camera = cameras[0];
  if (camera?.vendor !== expected.vendor || camera?.model !== expected.model
    || camera?.serial !== expected.serialNumber || camera?.transport !== "usb"
    || camera?.backend !== "canon-edsdk") {
    throw new Error("Detected camera does not match the exact USB Canon EOS R50 authority");
  }
  for (const capability of ["manualExposure", "manualWhiteBalance", "manualFocus", "linearCapture", "rawDownload"]) {
    if (camera.capabilities?.[capability] !== true) throw new Error(`EOS R50 capability is unavailable: ${capability}`);
  }
  return camera;
}

function assertCaptureIdentity(capture, authority) {
  const camera = capture.cameraDevice || {};
  const lens = capture.lens || {};
  if (camera.vendor !== authority.profile.camera.vendor
    || camera.model !== authority.profile.camera.model
    || camera.serial !== authority.profile.camera.serialNumber) {
    throw new Error("RAW capture came from a different camera body");
  }
  if (lens.vendor !== authority.profile.lens.vendor || lens.model !== authority.profile.lens.model
    || lens.mount !== authority.profile.lens.mount) {
    throw new Error("RAW capture used a different lens");
  }
  if (authority.profile.lens.serialNumber != null && lens.serial !== authority.profile.lens.serialNumber) {
    throw new Error("RAW capture used a different lens serial number");
  }
  if (!Number.isFinite(lens.focalLengthMm)
    || Math.abs(lens.focalLengthMm - authority.profile.lens.focalLengthMm) > 0.05
    || lens.focusLocked !== true || lens.zoomLocked !== true || lens.stabilization !== "off") {
    throw new Error("RF-S 10-18 focal/focus/zoom/stabilisation lock was not read back exactly");
  }
  if (capture.sourceBitDepth !== 14 || capture.provenance?.rawFormat !== "CR3"
    || !["mechanical", "efcs"].includes(capture.pipeline?.shutterMode)
    || !["uncompressed", "lossless-compressed"].includes(capture.pipeline?.rawEncoding)) {
    throw new Error("EOS R50 capture is not an accepted 14-bit CR3 mechanical/EFCS RAW acquisition");
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const authorityPath = resolve(args.authority);
  const authority = validateAuthority(JSON.parse(await readFile(authorityPath, "utf8")));
  const timeoutMs = args["timeout-ms"] == null ? authority.helperTimeoutMs : Number(args["timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("Probe timeout is outside 1-300 seconds");
  }
  await mkdir(authority.cameraCaptureDir, { recursive: true });
  const captureRoot = await mkdtemp(join(authority.cameraCaptureDir, "acceptance-"));
  process.env.PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST_PATH = authority.manifestPath;
  const adapter = new ExternalCameraHelperAdapter({
    command: authority.helperPath,
    runtimeManifestPath: authority.manifestPath,
    captureRoot,
    backend: "canon-edsdk",
    expectedModel: authority.profile.camera.model,
    requiredBitDepth: 14,
    timeoutMs,
    maxCaptureBytes: 512 * 1024 * 1024,
  });
  try {
    const detection = await adapter.detect();
    if (detection.adapter?.available !== true) {
      throw new Error(detection.error?.message || "Canon helper did not report an available camera");
    }
    const camera = exactCamera(detection.cameras, authority.profile.camera);
    const opened = await adapter.open(camera.id);
    if (opened?.opened !== true || opened?.exclusive !== true || opened?.sdkInitialized !== true) {
      throw new Error("EDSDK did not grant one exclusive initialized EOS R50 session");
    }
    const settings = {
      exposureMode: "manual",
      iso: 100,
      apertureF: 5.6,
      shutterUs: 16_667,
      whiteBalance: { mode: "kelvin", kelvin: 5_600 },
      focusMode: "manual",
      captureFormat: "linear-rgb",
    };
    const manualLock = await adapter.lockManualSettings(settings);
    verifyManualCameraLock(settings, manualLock);
    const capture = await adapter.capture({
      step: {
        id: "canon-r50-usb-acceptance",
        outputId: null,
        passId: "hardware-readiness",
        referenceKind: "diagnostic",
        captureConditions: {
          projectorState: "unchanged",
          opticalPath: "open",
          otherProjectors: "unchanged",
        },
      },
      repeat: 0,
      maxPixels: 40_000_000,
      maxWidth: 10_000,
      maxHeight: 10_000,
      maxRawBytes: 512 * 1024 * 1024,
      preferredPixelFormat: "linear-rgb-f32",
      exposureProfileId: "hardware-readiness",
      exposureSettings: settings,
    });
    assertCaptureIdentity(capture, authority);
    await adapter.close();
    const leftovers = await readdir(captureRoot);
    if (leftovers.length !== 0) throw new Error(`Camera helper left ${leftovers.length} exchange file(s)`);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      configured: true,
      physicallyAccepted: true,
      backend: "canon-edsdk",
      model: authority.profile.camera.model,
      lens: authority.profile.lens.model,
      transport: "usb",
      rawFormat: "CR3",
      sourceBitDepth: 14,
      helperVersion: detection.adapter.helperVersion || null,
    })}\n`);
  } finally {
    await adapter.close().catch(() => {});
    await rm(captureRoot, { recursive: true, force: true });
    delete process.env.PIXEL_BRIGHTNESS_CAMERA_RUNTIME_MANIFEST_PATH;
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    configured: true,
    physicallyAccepted: false,
    error: { code: error?.code || "CANON_CAMERA_ACCEPTANCE_FAILED", message: error?.message || String(error) },
  })}\n`);
  process.exitCode = 1;
});
