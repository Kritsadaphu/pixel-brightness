import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

import { CameraCalibrationError } from "../shared/camera-calibration.mjs";
import { CAMERA_SURVEY_PREVIEW_MAX_ARTIFACT_BYTES } from "../shared/camera-survey-preview.mjs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const kind = Buffer.from(type, "ascii");
  const body = Buffer.from(data);
  const output = Buffer.allocUnsafe(12 + body.length);
  output.writeUInt32BE(body.length, 0);
  kind.copy(output, 4);
  body.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + body.length)), 8 + body.length);
  return output;
}

function displayLuma(red, green, blue) {
  const linear = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const bounded = Math.max(0, Math.min(1, linear));
  const encoded = bounded <= 0.0031308
    ? bounded * 12.92
    : 1.055 * Math.pow(bounded, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(encoded * 255)));
}

/**
 * Produce a lossless browser-safe view of the exact uncorrected RAW raster.
 * The only sample transform is linear Rec.709 luma -> sRGB for visibility;
 * there is deliberately no resize, crop, demosaic geometry, lens correction,
 * interpolation or JPEG encode at this boundary.
 */
export function encodeCameraSurveyPreviewPng(capture, {
  maxArtifactBytes = CAMERA_SURVEY_PREVIEW_MAX_ARTIFACT_BYTES,
} = {}) {
  const width = Math.round(Number(capture?.width));
  const height = Math.round(Number(capture?.height));
  const pixels = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2
    || capture?.pixelFormat !== "linear-rgb-f32"
    || !(capture?.data instanceof Float32Array)
    || capture.data.length !== pixels * 3) {
    throw new CameraCalibrationError(
      "INVALID_CAMERA_SURVEY_PREVIEW_FRAME",
      "Survey-preview encoder requires one complete linear-rgb-f32 raster",
    );
  }
  const scanlines = Buffer.allocUnsafe(pixels + height);
  let target = 0;
  for (let y = 0; y < height; y += 1) {
    scanlines[target] = 0;
    target += 1;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 3;
      const red = Number(capture.data[source]);
      const green = Number(capture.data[source + 1]);
      const blue = Number(capture.data[source + 2]);
      if (![red, green, blue].every(Number.isFinite)) {
        throw new CameraCalibrationError(
          "INVALID_CAMERA_SURVEY_PREVIEW_FRAME",
          "Survey-preview source contains a non-finite linear sample",
        );
      }
      scanlines[target] = displayLuma(red, green, blue);
      target += 1;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  if (bytes.byteLength > maxArtifactBytes) {
    throw new CameraCalibrationError(
      "CAMERA_SURVEY_PREVIEW_ARTIFACT_TOO_LARGE",
      `Survey-preview PNG exceeds the ${maxArtifactBytes}-byte artifact limit`,
      { byteLength: bytes.byteLength, maxArtifactBytes },
    );
  }
  return {
    mimeType: "image/png",
    encoding: "base64",
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    dataBase64: bytes.toString("base64"),
  };
}
