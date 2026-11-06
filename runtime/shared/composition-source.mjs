export const SPOUT_DXGI_FORMATS = Object.freeze([
  "DXGI_FORMAT_R16G16B16A16_FLOAT",
  "DXGI_FORMAT_R8G8B8A8_UNORM",
  "DXGI_FORMAT_B8G8R8A8_UNORM",
]);

const DXGI_FORMATS = new Set(SPOUT_DXGI_FORMATS);

function boundedInteger(value, fallback, minimum, maximum, field) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number`);
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function senderName(value) {
  const name = String(value ?? "").trim();
  let hasControl = false;
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      hasControl = true;
      break;
    }
  }
  if (!name || name.length > 255 || hasControl) {
    throw new Error("compositionSource.senderName is invalid");
  }
  return name;
}

export function normalizeCompositionSource(input, {
  width = 5_280,
  height = 1_080,
  frameRateNum = 60,
  frameRateDen = 1,
  required = true,
  requireCanvasMatch = false,
} = {}) {
  if (input == null && !required) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("compositionSource must be an object");
  }
  if (String(input.type || "").toLowerCase() !== "spout") throw new Error("compositionSource.type must be spout");
  const acceptedInput = input.acceptedFormats == null ? SPOUT_DXGI_FORMATS : input.acceptedFormats;
  if (!Array.isArray(acceptedInput) || acceptedInput.length < 1 || acceptedInput.length > SPOUT_DXGI_FORMATS.length) {
    throw new Error("compositionSource.acceptedFormats must contain 1-3 supported DXGI formats");
  }
  const acceptedFormats = Array.from(new Set(acceptedInput.map(String)));
  if (acceptedFormats.some((format) => !DXGI_FORMATS.has(format))) {
    throw new Error("compositionSource.acceptedFormats contains an unsupported format");
  }
  const colorEncoding = String(input.colorEncoding || "srgb").toLowerCase();
  if (!new Set(["srgb", "linear"]).has(colorEncoding)) throw new Error("compositionSource.colorEncoding must be srgb or linear");
  if (String(input.alphaMode || "ignore").toLowerCase() !== "ignore") {
    throw new Error("compositionSource.alphaMode must be ignore");
  }
  if (String(input.onMissing || "black").toLowerCase() !== "black"
    || String(input.onMismatch || "black").toLowerCase() !== "black") {
    throw new Error("Composition failure policy must be black");
  }
  if (input.allowAutoSelect === true) {
    throw new Error("compositionSource.allowAutoSelect must be false for deterministic sender binding");
  }
  const normalizedWidth = boundedInteger(input.width, width, 64, 16_384, "compositionSource.width");
  const normalizedHeight = boundedInteger(input.height, height, 64, 16_384, "compositionSource.height");
  const normalizedFrameRateNum = boundedInteger(input.frameRateNum, frameRateNum, 1, 240_000, "compositionSource.frameRateNum");
  const normalizedFrameRateDen = boundedInteger(input.frameRateDen, frameRateDen, 1, 100_000, "compositionSource.frameRateDen");
  if (requireCanvasMatch && (normalizedWidth !== width || normalizedHeight !== height
    || normalizedFrameRateNum * frameRateDen !== frameRateNum * normalizedFrameRateDen)) {
    throw new Error("compositionSource dimensions and frame rate must match the project canvas");
  }
  return {
    type: "spout",
    senderName: senderName(input.senderName),
    width: normalizedWidth,
    height: normalizedHeight,
    frameRateNum: normalizedFrameRateNum,
    frameRateDen: normalizedFrameRateDen,
    acceptedFormats,
    colorEncoding,
    alphaMode: "ignore",
    timeoutMs: boundedInteger(input.timeoutMs, 500, 50, 30_000, "compositionSource.timeoutMs"),
    startupGraceMs: boundedInteger(input.startupGraceMs, 10_000, 0, 120_000, "compositionSource.startupGraceMs"),
    onMissing: "black",
    onMismatch: "black",
    allowAutoSelect: false,
  };
}

export function defaultCompositionSource(canvas = {}) {
  return normalizeCompositionSource({
    type: "spout",
    senderName: "PB-COMPOSITION",
    width: canvas.width ?? 5_280,
    height: canvas.height ?? 1_080,
    frameRateNum: canvas.frameRateNum ?? 60,
    frameRateDen: canvas.frameRateDen ?? 1,
  });
}
