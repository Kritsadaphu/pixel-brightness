import {
  mapPlanarWallPointsToRaw,
  normalizeCameraLensProfile,
} from "./camera-lens-profile.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;

export class CameraSurveyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CameraSurveyError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field} must be an object`);
  }
  return value;
}

function text(value, field, maximum = 256) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function finite(value, field, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field} must be between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function integer(value, field, minimum, maximum) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function normalizePoint(input, field) {
  const value = object(input, field);
  return {
    x: finite(value.x, `${field}.x`, 0, 1),
    y: finite(value.y, `${field}.y`, 0, 1),
  };
}

function cross(first, second, third) {
  return (second.x - first.x) * (third.y - second.y)
    - (second.y - first.y) * (third.x - second.x);
}

function polygonArea(points) {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubled += current.x * next.y - current.y * next.x;
  }
  return doubled / 2;
}

function normalizeBoundary(input, field) {
  if (!Array.isArray(input) || input.length !== 4) {
    throw new CameraSurveyError(
      "INVALID_SURFACE_BOUNDARY",
      `${field} must contain TL, TR, BR and BL in that order`,
    );
  }
  const points = input.map((point, index) => normalizePoint(point, `${field}[${index}]`));
  const turns = points.map((point, index) => cross(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  const area = polygonArea(points);
  if (area < 0.005 || turns.some((turn) => turn <= 1e-6)) {
    throw new CameraSurveyError(
      "INVALID_SURFACE_BOUNDARY",
      `${field} must be a non-folded clockwise-on-image quadrilateral with useful area`,
      { area, turns },
    );
  }
  return points;
}

function normalizeSurvey(input, index) {
  const field = `surveys[${index}]`;
  const value = object(input, field);
  const frame = object(value.frame, `${field}.frame`);
  const lensProfileSha256 = text(value.lensProfileSha256, `${field}.lensProfileSha256`, 64).toLowerCase();
  if (!SHA256.test(lensProfileSha256)) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field}.lensProfileSha256 must be a SHA-256 digest`);
  }
  return {
    id: text(value.id, `${field}.id`, 128),
    wallId: text(value.wallId, `${field}.wallId`, 128),
    cameraViewId: text(value.cameraViewId, `${field}.cameraViewId`, 128),
    frame: {
      width: integer(frame.width, `${field}.frame.width`, 32, 16_384),
      height: integer(frame.height, `${field}.frame.height`, 32, 16_384),
    },
    lensProfileSha256,
    boundary: normalizeBoundary(value.boundary, `${field}.boundary`),
    method: "operator-four-corner-planar-v1",
  };
}

export function normalizePlanarSurfaceSurveys(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", "surveys must contain 1-64 planar wall surveys");
  }
  const surveys = input.map(normalizeSurvey);
  for (const field of ["id", "wallId"]) {
    if (new Set(surveys.map((survey) => survey[field])).size !== surveys.length) {
      throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `Every survey ${field} must be unique`);
    }
  }
  return surveys;
}

function normalizeSurfaceTarget(input, index) {
  const field = `surfaceTargets[${index}]`;
  const value = object(input, field);
  const frame = object(value.frame, `${field}.frame`);
  const lensProfileSha256 = text(value.lensProfileSha256, `${field}.lensProfileSha256`, 64).toLowerCase();
  if (!SHA256.test(lensProfileSha256)) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", `${field}.lensProfileSha256 must be a SHA-256 digest`);
  }
  if (value.method !== "operator-four-corner-planar-v1") {
    throw new CameraSurveyError(
      "INVALID_SURFACE_SURVEY",
      `${field}.method must be operator-four-corner-planar-v1`,
    );
  }
  return {
    outputId: text(value.outputId, `${field}.outputId`, 128),
    wallId: text(value.wallId, `${field}.wallId`, 128),
    surveyId: text(value.surveyId, `${field}.surveyId`, 128),
    cameraViewId: text(value.cameraViewId, `${field}.cameraViewId`, 128),
    lensProfileSha256,
    frame: {
      width: integer(frame.width, `${field}.frame.width`, 32, 16_384),
      height: integer(frame.height, `${field}.frame.height`, 32, 16_384),
    },
    corners: normalizeBoundary(value.corners, `${field}.corners`),
    method: value.method,
  };
}

export function normalizePlanarSurfaceTargets(input, { requireSingleCameraView = true } = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 256) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", "surfaceTargets must contain 1-256 output targets");
  }
  const targets = input.map(normalizeSurfaceTarget);
  if (new Set(targets.map((target) => target.outputId)).size !== targets.length) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", "Every surface target outputId must be unique");
  }
  if (requireSingleCameraView) {
    const first = targets[0];
    const mismatched = targets.filter((target) => (
      target.cameraViewId !== first.cameraViewId
      || target.lensProfileSha256 !== first.lensProfileSha256
      || target.frame.width !== first.frame.width
      || target.frame.height !== first.frame.height
    ));
    if (mismatched.length) {
      throw new CameraSurveyError(
        "MULTIPLE_CAMERA_VIEWS_UNSUPPORTED",
        "One calibration session must use one fixed camera view, raster and lens profile",
        { outputIds: mismatched.map((target) => target.outputId) },
      );
    }
  }
  return targets;
}

function normalizeViewport(input, field) {
  const value = object(input, field);
  return {
    x: finite(value.x, `${field}.x`, 0, 1e9),
    y: finite(value.y, `${field}.y`, 0, 1e9),
    width: finite(value.width, `${field}.width`, 1e-6, 1e9),
    height: finite(value.height, `${field}.height`, 1e-6, 1e9),
  };
}

function normalizeOutput(input, index) {
  const field = `outputs[${index}]`;
  const value = object(input, field);
  return {
    id: text(value.id, `${field}.id`, 128),
    wallId: text(value.wallId, `${field}.wallId`, 128),
    sourceViewport: normalizeViewport(value.sourceViewport, `${field}.sourceViewport`),
  };
}

/**
 * Convert one operator-selected wall quadrilateral into an intended target
 * quadrilateral for every projector assigned to that wall. Source viewport
 * overlap is preserved: overlapping composition coordinates map to the same
 * physical wall coordinates.
 */
export function derivePlanarOutputTargets({ surveys: surveyInput, outputs: outputInput, lensProfile: lensProfileInput }) {
  const surveys = normalizePlanarSurfaceSurveys(surveyInput);
  if (lensProfileInput == null) {
    throw new CameraSurveyError(
      "CAMERA_LENS_PROFILE_REQUIRED",
      "Deriving planar output targets requires the complete validated lens profile",
    );
  }
  let lensProfile;
  try {
    lensProfile = normalizeCameraLensProfile(lensProfileInput);
  } catch (error) {
    throw new CameraSurveyError(
      error?.code || "INVALID_SURFACE_SURVEY",
      error?.message || "Camera lens profile is invalid",
      error?.details,
    );
  }
  const profileMismatch = surveys.find((survey) => (
    survey.lensProfileSha256 !== lensProfile.sha256
    || survey.frame.width !== lensProfile.frame.width
    || survey.frame.height !== lensProfile.frame.height
  ));
  if (profileMismatch) {
    throw new CameraSurveyError(
      "CAMERA_LENS_PROFILE_MISMATCH",
      `Survey ${profileMismatch.id} does not match the supplied lens profile and retained raster`,
    );
  }
  if (!Array.isArray(outputInput) || outputInput.length < 1 || outputInput.length > 256) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", "outputs must contain 1-256 project outputs");
  }
  const outputs = outputInput.map(normalizeOutput);
  if (new Set(outputs.map((output) => output.id)).size !== outputs.length) {
    throw new CameraSurveyError("INVALID_SURFACE_SURVEY", "Output ids must be unique");
  }
  const surveysByWall = new Map(surveys.map((survey) => [survey.wallId, survey]));
  const missingWalls = [...new Set(outputs.filter((output) => !surveysByWall.has(output.wallId)).map((output) => output.wallId))];
  if (missingWalls.length) {
    throw new CameraSurveyError(
      "MISSING_SURFACE_SURVEY",
      "Every calibrated output requires a survey for its assigned wall",
      { wallIds: missingWalls },
    );
  }

  const wallBounds = new Map();
  for (const output of outputs) {
    const viewport = output.sourceViewport;
    const current = wallBounds.get(output.wallId) || {
      left: viewport.x,
      top: viewport.y,
      right: viewport.x + viewport.width,
      bottom: viewport.y + viewport.height,
    };
    current.left = Math.min(current.left, viewport.x);
    current.top = Math.min(current.top, viewport.y);
    current.right = Math.max(current.right, viewport.x + viewport.width);
    current.bottom = Math.max(current.bottom, viewport.y + viewport.height);
    wallBounds.set(output.wallId, current);
  }

  const targets = outputs.map((output) => {
    const survey = surveysByWall.get(output.wallId);
    const bounds = wallBounds.get(output.wallId);
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    const viewport = output.sourceViewport;
    const left = (viewport.x - bounds.left) / width;
    const top = (viewport.y - bounds.top) / height;
    const right = (viewport.x + viewport.width - bounds.left) / width;
    const bottom = (viewport.y + viewport.height - bounds.top) / height;
    let mapped;
    try {
      mapped = mapPlanarWallPointsToRaw({
        profile: lensProfile,
        boundary: survey.boundary,
        points: [
          { u: left, v: top },
          { u: right, v: top },
          { u: right, v: bottom },
          { u: left, v: bottom },
        ],
      });
    } catch (error) {
      throw new CameraSurveyError(
        error?.code || "INVALID_SURFACE_SURVEY",
        error?.message || `Could not derive planar target for ${output.id}`,
        error?.details,
      );
    }
    const corners = mapped.points.map(({ x, y }) => ({ x, y }));
    return {
      outputId: output.id,
      wallId: output.wallId,
      surveyId: survey.id,
      cameraViewId: survey.cameraViewId,
      lensProfileSha256: survey.lensProfileSha256,
      frame: structuredClone(survey.frame),
      corners,
      method: survey.method,
    };
  });
  return normalizePlanarSurfaceTargets(targets, { requireSingleCameraView: false });
}
