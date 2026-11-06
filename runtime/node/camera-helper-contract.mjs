export const CAMERA_HELPER_PROTOCOL_VERSION = 1;

export const CANON_R50_CAMERA_MODEL = "EOS R50";
export const CANON_RF_S_10_18_LENS_MODEL = "RF-S10-18mm F4.5-6.3 IS STM";

export const SINGLE_SHOT_RAW_SOURCE_POLICY = Object.freeze({
  kind: "single-shot-linear-raw-decode-v1",
  processedJpeg: false,
  liveView: false,
  spatialTransform: "none",
});

export const CANON_R50_SOURCE_FRAME = Object.freeze({ width: 6_000, height: 4_000 });

export const CANON_R50_RAW_SOURCE_POLICY = Object.freeze({
  kind: "single-shot-linear-raw-decode-v1",
  processedJpeg: false,
  liveView: false,
  spatialTransform: "full-frame-area-bin-v1",
  sourceFrame: CANON_R50_SOURCE_FRAME,
  selection: "smallest-square-integer-divisor-within-request-limits-v1",
});

export function canonR50SourceContractForLimits(limits = {}) {
  const maxPixels = Math.round(Number(limits.maxPixels));
  const maxWidth = Math.round(Number(limits.maxWidth));
  const maxHeight = Math.round(Number(limits.maxHeight));
  const maxRawBytes = Math.round(Number(limits.maxRawBytes));
  if (![maxPixels, maxWidth, maxHeight, maxRawBytes].every(Number.isSafeInteger)
    || maxPixels < 4 || maxWidth < 2 || maxHeight < 2 || maxRawBytes < 48) {
    return null;
  }
  for (let bin = 2; bin <= 64; bin += 1) {
    if (CANON_R50_SOURCE_FRAME.width % bin !== 0 || CANON_R50_SOURCE_FRAME.height % bin !== 0) continue;
    const width = CANON_R50_SOURCE_FRAME.width / bin;
    const height = CANON_R50_SOURCE_FRAME.height / bin;
    const pixels = width * height;
    if (width < 2 || height < 2 || width > maxWidth || height > maxHeight
      || pixels > maxPixels || pixels * 3 * Float32Array.BYTES_PER_ELEMENT > maxRawBytes) continue;
    const retainedFrame = Object.freeze({ width, height });
    const sourcePolicy = Object.freeze({
      ...CANON_R50_RAW_SOURCE_POLICY,
      retainedFrame,
      binX: bin,
      binY: bin,
    });
    const spatialTransform = Object.freeze({
      kind: "full-frame-area-bin-v1",
      sourceFrame: Object.freeze({ ...CANON_R50_SOURCE_FRAME, pixelFormat: "linear-rgb-f32" }),
      retainedFrame: Object.freeze({ ...retainedFrame, pixelFormat: "linear-rgb-f32" }),
      binX: bin,
      binY: bin,
      crop: Object.freeze({ x: 0, y: 0, ...CANON_R50_SOURCE_FRAME }),
    });
    return { sourcePolicy, spatialTransform };
  }
  return null;
}
