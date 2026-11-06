import { normalizePlanarSurfaceSurveys } from "../../runtime/shared/camera-survey.mjs";

export const PLANAR_SURVEY_METHOD = "operator-four-corner-planar-v1" as const;
export const PLANAR_CORNER_LABELS = ["TL", "TR", "BR", "BL"] as const;

export type PlanarSurveyPoint = {
  x: number;
  y: number;
};

export type PlanarSurveyFrame = {
  width: number;
  height: number;
};

export type PlanarSurfaceSurveyEntry = {
  id: string;
  wallId: string;
  cameraViewId: string;
  frame: PlanarSurveyFrame;
  lensProfileSha256: string;
  boundary: [PlanarSurveyPoint, PlanarSurveyPoint, PlanarSurveyPoint, PlanarSurveyPoint];
  method: typeof PLANAR_SURVEY_METHOD;
};

export type PlanarSurveyMetadata = {
  id: string;
  wallId: string;
  cameraViewId: string;
  frame: PlanarSurveyFrame;
  lensProfileSha256: string;
};

export type PreviewRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type BoundaryInspection = {
  valid: boolean;
  reason: string | null;
  area: number;
};

function roundNormalized(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Convert a pointer position on the exact-aspect preview into frame-normalized coordinates. */
export function normalizePreviewPoint(
  clientX: number,
  clientY: number,
  rectangle: PreviewRectangle,
): PlanarSurveyPoint | null {
  if (![clientX, clientY, rectangle.left, rectangle.top, rectangle.width, rectangle.height]
    .every(Number.isFinite) || rectangle.width <= 0 || rectangle.height <= 0) {
    return null;
  }
  return {
    x: roundNormalized(clamp((clientX - rectangle.left) / rectangle.width, 0, 1)),
    y: roundNormalized(clamp((clientY - rectangle.top) / rectangle.height, 0, 1)),
  };
}

function cross(first: PlanarSurveyPoint, second: PlanarSurveyPoint, third: PlanarSurveyPoint) {
  return (second.x - first.x) * (third.y - second.y)
    - (second.y - first.y) * (third.x - second.x);
}

function signedArea(points: readonly PlanarSurveyPoint[]) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubled += current.x * next.y - current.y * next.x;
  }
  return doubled / 2;
}

/** Mirrors the runtime validator: TL, TR, BR, BL must form a useful clockwise-on-image quad. */
export function inspectPlanarBoundary(points: readonly PlanarSurveyPoint[]): BoundaryInspection {
  if (points.length !== PLANAR_CORNER_LABELS.length) {
    return { valid: false, reason: "Select all four corners in TL, TR, BR, BL order.", area: 0 };
  }
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    return { valid: false, reason: "Every corner must remain inside the preview frame.", area: 0 };
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  if (topLeft.x >= topRight.x || bottomLeft.x >= bottomRight.x
    || topLeft.y + topRight.y >= bottomLeft.y + bottomRight.y) {
    return {
      valid: false,
      reason: "The corners cross or fold, or do not begin at the top-left. Click TL, TR, BR, BL in order.",
      area: signedArea(points),
    };
  }
  const area = signedArea(points);
  const turns = points.map((point, index) => cross(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  if (area >= 0 && area < 0.005 && turns.every((turn) => turn > 1e-6)) {
    return {
      valid: false,
      reason: "The selected wall is too small in this frame. Move closer or use a clearer survey view.",
      area,
    };
  }
  if (area < 0.005 || turns.some((turn) => turn <= 1e-6)) {
    return {
      valid: false,
      reason: "The corners cross or fold. Click the visible wall in TL, TR, BR, BL order.",
      area,
    };
  }
  return { valid: true, reason: null, area };
}

export function metadataIssue(metadata: PlanarSurveyMetadata): string | null {
  const { frame } = metadata;
  if (!metadata.id.trim() || metadata.id.trim().length > 128) return "A valid survey ID is required.";
  if (!metadata.wallId.trim() || metadata.wallId.trim().length > 128) return "A valid planar wall ID is required.";
  if (!metadata.cameraViewId.trim() || metadata.cameraViewId.trim().length > 128) {
    return "A fixed camera-view ID is required for this survey session.";
  }
  if (!Number.isSafeInteger(frame.width) || frame.width < 32 || frame.width > 16_384
    || !Number.isSafeInteger(frame.height) || frame.height < 32 || frame.height > 16_384) {
    return "Frame width and height must be integer pixels between 32 and 16384.";
  }
  if (!/^[a-f0-9]{64}$/i.test(metadata.lensProfileSha256.trim())) {
    return "A validated SHA-256 lens-profile digest is required before selecting the wall.";
  }
  return null;
}

/** Build the exact normalized entry consumed by runtime/shared/camera-survey.mjs. */
export function buildPlanarSurfaceSurveyEntry(
  metadata: PlanarSurveyMetadata,
  points: readonly PlanarSurveyPoint[],
): PlanarSurfaceSurveyEntry {
  const issue = metadataIssue(metadata);
  if (issue) throw new Error(issue);
  const inspection = inspectPlanarBoundary(points);
  if (!inspection.valid) throw new Error(inspection.reason ?? "Invalid planar wall boundary.");
  const [normalized] = normalizePlanarSurfaceSurveys([{
    id: metadata.id,
    wallId: metadata.wallId,
    cameraViewId: metadata.cameraViewId,
    frame: metadata.frame,
    lensProfileSha256: metadata.lensProfileSha256,
    boundary: points,
  }]);
  return normalized as PlanarSurfaceSurveyEntry;
}
