#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

const captureRootIndex = process.argv.indexOf("--capture-root");
const captureRoot = captureRootIndex >= 0 ? process.argv[captureRootIndex + 1] : process.cwd();
const runtimeManifestIndex = process.argv.indexOf("--runtime-manifest");
const runtimeManifestPath = runtimeManifestIndex >= 0 ? process.argv[runtimeManifestIndex + 1] : null;
if (!runtimeManifestPath || !isAbsolute(runtimeManifestPath)) {
  process.stderr.write("fixture requires one absolute --runtime-manifest path\n");
  process.exit(2);
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

const camera = Object.freeze({
  id: "canon-r50-fixture",
  vendor: "Canon",
  model: "EOS R50",
  serial: "R50-FIXTURE-0001",
  transport: "usb",
  backend: "canon-edsdk",
  capabilities: {
    manualExposure: true,
    manualWhiteBalance: true,
    manualFocus: true,
    linearCapture: true,
  },
});

const lensIdentity = Object.freeze({
  id: "canon-rfs-10-18-fixture",
  vendor: "Canon",
  model: "RF-S10-18mm F4.5-6.3 IS STM",
  serial: "RFS1018-FIXTURE-0001",
  mount: "RF",
});

const sourcePolicy = Object.freeze({
  kind: "single-shot-linear-raw-decode-v1",
  processedJpeg: false,
  liveView: false,
  spatialTransform: "none",
});

let lockedSettings = null;

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, id, ok: true, result })}\n`);
}

function lens(settings = lockedSettings, override = {}) {
  return {
    ...lensIdentity,
    focalLengthMm: 10,
    apertureF: settings?.apertureF ?? 5.6,
    focusDistanceM: 4,
    focusLocked: true,
    zoomLocked: true,
    stabilization: "off",
    ...override,
  };
}

function manualLock(settings) {
  return {
    confirmed: true,
    applied: settings,
    lockedFields: [
      "exposureMode",
      "iso",
      "apertureF",
      "shutterUs",
      "whiteBalance.mode",
      "whiteBalance.kelvin",
      "focusMode",
      "captureFormat",
    ],
  };
}

async function captureResult(request, { preview = false } = {}) {
  const step = request.params.step || {};
  const delayMs = Math.max(0, Math.min(5_000, Number(step.fixtureDelayMs) || 0));
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const frame = preview ? request.params.lensProfileBinding.frame : { width: 2, height: 2 };
  const values = new Float32Array(frame.width * frame.height * 3);
  for (let index = 0; index < values.length; index += 1) values[index] = (index + 1) / values.length;
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const rasterPath = join(captureRoot, `${request.id}.f32`);
  const sourcePath = join(captureRoot, `${request.id}.cr3`);
  const sourceBytes = Buffer.concat([
    Buffer.from(`PIXEL-BRIGHTNESS-FIXTURE-CR3:${request.id}:`, "utf8"),
    bytes,
  ]);
  const rasterSha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  await Promise.all([writeFile(rasterPath, bytes), writeFile(sourcePath, sourceBytes)]);
  const settings = request.params.exposureSettings || request.params.cameraSettings || lockedSettings;
  const effectiveSourcePolicy = {
    ...sourcePolicy,
    ...(step.fixtureSourcePolicyOverride || {}),
  };
  const rawFormat = step.fixtureRawFormat || "CR3";
  return {
    id: request.id,
    capturedAt: "2026-08-25T00:00:00.000Z",
    linearized: true,
    sourceBitDepth: 14,
    sourceSha256,
    source: {
      path: sourcePath,
      byteLength: sourceBytes.byteLength,
      sha256: sourceSha256,
      mediaType: step.fixtureSourceMediaType || "image/x-canon-cr3",
      acquisition: step.fixtureAcquisition || "single-shot-download",
    },
    rawFormat,
    rawSourceKind: step.fixtureRawSourceKind || sourcePolicy.kind,
    sourcePolicy: effectiveSourcePolicy,
    lensProfileSha256: preview ? request.params.lensProfileBinding.sha256 : undefined,
    manualLock: manualLock(settings),
    helperVersion: "canon-fixture-1",
    decoder: {
      name: "fixture-libraw",
      version: "0.21.4-fixture",
      binarySha256: createHash("sha256").update("fixture-libraw-binary").digest("hex"),
    },
    rawDecode: {
      rawFormat,
      sensorWidth: frame.width,
      sensorHeight: frame.height,
      cfaPattern: "RGGB",
      blackLevels: [256, 257, 258, 259],
      whiteLevels: [16383, 16380, 16382, 16381],
    },
    camera: { ...camera, ...(step.fixtureCameraOverride || {}) },
    lens: lens(settings, step.fixtureLensOverride || {}),
    settings,
    pipeline: {
      captureMode: "single-shot",
      shutterMode: "efcs",
      rawEncoding: "lossless-compressed",
      sourcePixelFormat: `${rawFormat}-14`,
      blackLevelSubtracted: false,
      whiteBalanceApplied: false,
      toneCurveApplied: false,
      noiseReductionApplied: false,
      lensCorrectionsApplied: false,
      ...(step.fixturePipelineOverride || {}),
    },
    conditionVerification: {
      projectorState: step.captureConditions?.projectorState || "room-view",
      opticalPath: step.captureConditions?.opticalPath || "open",
      otherProjectors: step.captureConditions?.otherProjectors || "unchanged",
      method: "fixture",
      verifiedAt: "2026-08-25T00:00:00.000Z",
    },
    exposure: { normalizationScale: 1, settings },
    raster: {
      path: rasterPath,
      width: frame.width,
      height: frame.height,
      pixelFormat: "linear-rgb-f32-le",
      byteLength: bytes.byteLength,
      sha256: rasterSha256,
    },
  };
}

for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "detect") {
    respond(request.id, {
      protocolVersion: 1,
      helperVersion: "canon-fixture-1",
      cameras: [{ ...camera, lens: lensIdentity }],
    });
  } else if (request.method === "open") {
    respond(request.id, { opened: true, camera, lens: lens() });
  } else if (request.method === "lock-manual-settings") {
    lockedSettings = request.params.settings;
    respond(request.id, {
      ...manualLock(lockedSettings),
      camera,
      lens: lens(),
      sourcePolicy,
    });
  } else if (request.method === "capture") {
    respond(request.id, await captureResult(request));
  } else if (request.method === "capture-survey-preview") {
    respond(request.id, await captureResult(request, { preview: true }));
  } else if (request.method === "close") {
    respond(request.id, { closed: true });
    lines.close();
  } else {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      id: request.id,
      ok: false,
      error: { code: "UNSUPPORTED", message: request.method },
    })}\n`);
  }
}
