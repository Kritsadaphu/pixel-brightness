#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const rootIndex = process.argv.indexOf("--capture-root");
const captureRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}

async function captureResult(request, { preview = false } = {}) {
  const frame = preview ? request.params.lensProfileBinding.frame : { width: 2, height: 2 };
  const values = new Float32Array(frame.width * frame.height * 3);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = (y * frame.width + x) * 3;
      values[offset] = 0.01 + 0.69 * x / Math.max(1, frame.width - 1);
      values[offset + 1] = 0.02 + 0.78 * y / Math.max(1, frame.height - 1);
      values[offset + 2] = 0.03 + 0.87 * (x + y) / Math.max(1, frame.width + frame.height - 2);
    }
  }
  const pipelineOverride = request.params.step?.fixturePipelineOverride || {};
  const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  const pathname = join(captureRoot, `${request.id}.f32`);
  const sourcePathname = join(captureRoot, `${request.id}.arw`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sourceBytes = Buffer.concat([
    Buffer.from(`PIXEL-BRIGHTNESS-FIXTURE-ARW:${request.id}:`, "utf8"),
    bytes,
  ]);
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const omitSource = request.params.step?.fixtureSourceOverride === null;
  await Promise.all([
    writeFile(pathname, bytes),
    ...(omitSource ? [] : [writeFile(sourcePathname, sourceBytes)]),
  ]);
  return {
    id: request.id,
    capturedAt: "2026-08-24T00:00:00.000Z",
    linearized: true,
    sourceBitDepth: 14,
    sourceSha256: sourceDigest,
    source: omitSource
      ? null
      : {
        path: sourcePathname,
        byteLength: sourceBytes.byteLength,
        sha256: sourceDigest,
        ...(request.params.step?.fixtureSourceOverride || {}),
      },
    rawFormat: "ARW",
    rawSourceKind: preview ? "single-shot-linear-raw-decode-v1" : undefined,
    lensProfileSha256: preview ? request.params.lensProfileBinding.sha256 : undefined,
    manualLock: preview ? {
      confirmed: true,
      applied: request.params.cameraSettings,
      lockedFields: [
        "exposureMode", "iso", "apertureF", "shutterUs", "whiteBalance.mode",
        "whiteBalance.kelvin", "focusMode", "captureFormat",
      ],
    } : undefined,
    helperVersion: "fixture-1",
    decoder: {
      name: "fixture-raw-decoder",
      version: "1.0.0",
      binarySha256: createHash("sha256").update("fixture-raw-decoder-binary-v1").digest("hex"),
      ...(request.params.step?.fixtureDecoderOverride || {}),
    },
    rawDecode: {
      rawFormat: "ARW",
      sensorWidth: frame.width,
      sensorHeight: frame.height,
      cfaPattern: "RGGB",
      blackLevels: [512, 512, 512, 512],
      whiteLevels: [16383, 16383, 16383, 16383],
      ...(request.params.step?.fixtureRawDecodeOverride || {}),
    },
    camera: { id: "sony-a7iv-fixture", vendor: "Sony", model: "ILCE-7M4", serial: "FIXTURE-001" },
    lens: {
      id: "fixture-lens",
      vendor: "Sony",
      model: "FE 16-35mm F2.8 GM II",
      serial: "FIXTURE-LENS-001",
      mount: "E",
      focalLengthMm: 16,
      apertureF: 5.6,
      focusDistanceM: 5,
      focusLocked: true,
      zoomLocked: true,
      stabilization: "off",
    },
    pipeline: {
      captureMode: "single-shot",
      shutterMode: "efcs",
      rawEncoding: "lossless-compressed",
      sourcePixelFormat: "ARW-14",
      blackLevelSubtracted: false,
      whiteBalanceApplied: false,
      toneCurveApplied: false,
      noiseReductionApplied: false,
      lensCorrectionsApplied: false,
      ...pipelineOverride,
    },
    conditionVerification: {
      projectorState: request.params.step?.captureConditions?.projectorState || "room-view",
      opticalPath: request.params.step?.captureConditions?.opticalPath || "open",
      otherProjectors: request.params.step?.captureConditions?.otherProjectors || "unchanged",
      method: "fixture",
      verifiedAt: "2026-08-24T00:00:00.000Z",
    },
    exposure: { normalizationScale: 1 },
    raster: {
      path: pathname,
      width: frame.width,
      height: frame.height,
      pixelFormat: "linear-rgb-f32-le",
      byteLength: bytes.byteLength,
      sha256: digest,
    },
  };
}

for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "detect") {
    respond(request.id, {
      protocolVersion: 1,
      helperVersion: "fixture-1",
      cameras: [{
        id: "sony-a7iv-fixture",
        vendor: "Sony",
        model: "ILCE-7M4",
        serial: "FIXTURE-001",
        transport: "usb",
        backend: "sony-camera-remote-sdk",
        capabilities: {
          manualExposure: true,
          manualWhiteBalance: true,
          manualFocus: true,
          linearCapture: true,
        },
      }],
    });
  } else if (request.method === "open") {
    respond(request.id, { opened: true });
  } else if (request.method === "lock-manual-settings") {
    respond(request.id, {
      confirmed: true,
      applied: request.params.settings,
      lockedFields: [
        "exposureMode", "iso", "apertureF", "shutterUs", "whiteBalance.mode",
        "whiteBalance.kelvin", "focusMode", "captureFormat",
      ],
    });
  } else if (request.method === "capture") {
    respond(request.id, await captureResult(request));
  } else if (request.method === "capture-survey-preview") {
    const delayMs = Math.max(0, Math.min(5_000, Number(process.env.PB_FIXTURE_SURVEY_DELAY_MS) || 0));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    respond(request.id, await captureResult(request, { preview: true }));
  } else if (request.method === "close") {
    respond(request.id, { closed: true });
    lines.close();
  } else {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: "UNSUPPORTED", message: request.method },
    })}\n`);
  }
}
