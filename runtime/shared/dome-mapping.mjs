// Dome (fisheye / domemaster) geometry for the existing final pipeline.
//
// Nothing here needs a new renderer feature. A dome output is expressed with
// the contracts FinalPipeline already enforces:
//   - sourceViewport = the whole square composition canvas;
//   - warp mesh = regular grid in physical projector pixels whose u,v are the
//     domemaster coordinates seen through that pixel;
//   - blend map  = r32_float partition of unity between projectors, computed
//     on the dome surface in physical projector pixels;
//   - mask map   = r32_float spring-line cut-off in physical projector pixels.
//
// World frame: metres, origin at the dome sphere centre on the spring-line
// plane, +Z up, +X = dome "front" (azimuth 0), +Y = left of a viewer facing
// front. Azimuth is measured from +X toward +Y. Elevation is measured up from
// the spring-line plane.
//
// The domemaster image is the standard "seen from inside, looking up" fisheye:
// front at the bottom edge, the viewer's right (-Y) on the right edge.

import { MAX_GRID_COLUMNS, MAX_GRID_ROWS, validateMesh } from "./mapping.mjs";

export const DOME_MAPPING_METHOD = "dome-fisheye-ray-v1";
export const DOME_MAX_PROJECTORS = 32;
const DEG = Math.PI / 180;
const PROJECTOR_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function fail(message) {
  throw new Error(message);
}

function finite(value, field, { min = -Infinity, max = Infinity, fallback } = {}) {
  const numeric = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    fail(`${field} must be a finite number within ${min}..${max}`);
  }
  return numeric;
}

function integer(value, field, options) {
  const numeric = finite(value, field, options);
  if (!Number.isInteger(numeric)) fail(`${field} must be an integer`);
  return numeric;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => scale(a, 1 / length(a));

function rotateAboutY(vector, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c * vector[0] + s * vector[2], vector[1], -s * vector[0] + c * vector[2]];
}

/** Dome-axis frame: undo the physical dome tilt (positive tilt leans the
 * zenith toward the front, as in planetarium-style tilted domes). */
function worldToDome(dome, vector) {
  return rotateAboutY(vector, -dome.tiltRad);
}

function domeToWorld(dome, vector) {
  return rotateAboutY(vector, dome.tiltRad);
}

export function normalizeDomeProfile(input) {
  if (!input || typeof input !== "object") fail("Dome profile must be an object");
  const domeInput = input.dome ?? {};
  const radius = finite(domeInput.radiusM, "dome.radiusM", { min: 0.5, max: 100 });
  const dome = {
    radiusM: radius,
    tiltDeg: finite(domeInput.tiltDeg, "dome.tiltDeg", { min: -90, max: 90, fallback: 0 }),
    springElevationDeg: finite(domeInput.springElevationDeg, "dome.springElevationDeg", { min: -30, max: 60, fallback: 0 }),
    eyepointM: [0, 1, 2].map((axis) => finite(domeInput.eyepointM?.[axis], `dome.eyepointM[${axis}]`,
      { min: -radius, max: radius, fallback: 0 })),
  };
  dome.tiltRad = dome.tiltDeg * DEG;
  if (length(dome.eyepointM) >= radius * 0.95) fail("dome.eyepointM must be well inside the dome sphere");

  const canvasInput = input.canvas ?? {};
  const width = integer(canvasInput.width, "canvas.width", { min: 256, max: 16384, fallback: 4096 });
  const height = integer(canvasInput.height, "canvas.height", { min: 256, max: 16384, fallback: width });
  const fisheyeInput = input.fisheye ?? {};
  const fisheye = {
    centerX: finite(fisheyeInput.centerX, "fisheye.centerX", { min: 0, max: width, fallback: width / 2 }),
    centerY: finite(fisheyeInput.centerY, "fisheye.centerY", { min: 0, max: height, fallback: height / 2 }),
    radiusPx: finite(fisheyeInput.radiusPx, "fisheye.radiusPx", { min: 64, max: 8192, fallback: Math.min(width, height) * 0.46875 }),
    fovDeg: finite(fisheyeInput.fovDeg, "fisheye.fovDeg", { min: 90, max: 360, fallback: 180 }),
    rotationDeg: finite(fisheyeInput.rotationDeg, "fisheye.rotationDeg", { min: -360, max: 360, fallback: 0 }),
  };
  // Rays outside the content circle are pushed smoothly into the black margin
  // between the circle and the canvas edge. This keeps every mesh cell
  // unfolded (the renderer rejects folded or collapsed triangles) while those
  // pixels sample black. A canvas equal to the circle leaves no margin.
  const marginPx = Math.min(fisheye.centerX, width - fisheye.centerX, fisheye.centerY, height - fisheye.centerY) - fisheye.radiusPx;
  if (marginPx < Math.max(8, fisheye.radiusPx * 0.01)) {
    fail(`The domemaster circle needs a black margin inside the canvas (have ${marginPx.toFixed(1)} px). `
      + "Use for example a 4096x4096 composition with the 3840 px domemaster centred (radiusPx 1920).");
  }
  fisheye.margin = (marginPx / fisheye.radiusPx) * 0.98;
  fisheye.halfFovRad = (fisheye.fovDeg / 2) * DEG;
  fisheye.rotationRad = fisheye.rotationDeg * DEG;

  const buildInput = input.build ?? {};
  const build = {
    meshColumns: integer(buildInput.meshColumns, "build.meshColumns", { min: 2, max: MAX_GRID_COLUMNS, fallback: 64 }),
    meshRows: integer(buildInput.meshRows, "build.meshRows", { min: 2, max: MAX_GRID_ROWS, fallback: 40 }),
    mapScale: finite(buildInput.mapScale, "build.mapScale", { min: 0.05, max: 1, fallback: 0.5 }),
    blendFeather: finite(buildInput.blendFeather, "build.blendFeather", { min: 0.001, max: 0.5, fallback: 0.12 }),
    blendPower: finite(buildInput.blendPower, "build.blendPower", { min: 0.5, max: 8, fallback: 2 }),
    maskSoftnessPx: finite(buildInput.maskSoftnessPx, "build.maskSoftnessPx", { min: 0, max: 256, fallback: 4 }),
  };

  if (!Array.isArray(input.projectors) || input.projectors.length < 1 || input.projectors.length > DOME_MAX_PROJECTORS) {
    fail(`projectors must contain 1..${DOME_MAX_PROJECTORS} entries`);
  }
  const ids = new Set();
  const projectors = input.projectors.map((projector, index) => {
    const field = `projectors[${index}]`;
    const id = String(projector?.id ?? "");
    if (!PROJECTOR_ID_PATTERN.test(id)) fail(`${field}.id must be 1-64 letters, numbers, dot, underscore or hyphen`);
    if (ids.has(id)) fail(`Duplicate projector id ${id}`);
    ids.add(id);
    const normalized = normalizeProjector(projector, field);
    if (length(normalized.positionM) >= radius) fail(`${field}.positionM must be inside the dome sphere`);
    return { ...normalized, id };
  });
  return { dome, canvas: { width, height }, fisheye, build, projectors };
}

function normalizeProjector(projector, field) {
  const pose = projector.pose ?? {};
  const lens = projector.lens ?? {};
  const resolution = projector.resolution ?? {};
  const result = {
    name: String(projector.name ?? projector.id ?? ""),
    resolution: {
      width: integer(resolution.width, `${field}.resolution.width`, { min: 64, max: 16384, fallback: 1920 }),
      height: integer(resolution.height, `${field}.resolution.height`, { min: 64, max: 16384, fallback: 1200 }),
    },
    positionM: [0, 1, 2].map((axis) => finite(pose.positionM?.[axis], `${field}.pose.positionM[${axis}]`, { min: -100, max: 100 })),
    yawDeg: finite(pose.yawDeg, `${field}.pose.yawDeg`, { min: -720, max: 720 }),
    pitchDeg: finite(pose.pitchDeg, `${field}.pose.pitchDeg`, { min: -90, max: 90 }),
    rollDeg: finite(pose.rollDeg, `${field}.pose.rollDeg`, { min: -360, max: 360, fallback: 0 }),
    throwRatio: finite(lens.throwRatio, `${field}.lens.throwRatio`, { min: 0.1, max: 10 }),
    // Fractions of image width/height, as projector menus express lens shift.
    shiftX: finite(lens.shiftX, `${field}.lens.shiftX`, { min: -2, max: 2, fallback: 0 }),
    shiftY: finite(lens.shiftY, `${field}.lens.shiftY`, { min: -2, max: 2, fallback: 0 }),
    calibrationPoints: normalizeCalibrationPoints(projector.calibrationPoints, field),
    solve: projector.solve ?? null,
    renderer: projector.renderer ?? null,
  };
  return result;
}

function normalizeCalibrationPoints(points, field) {
  if (points == null) return [];
  if (!Array.isArray(points) || points.length > 256) fail(`${field}.calibrationPoints must be an array of at most 256 points`);
  return points.map((point, index) => ({
    label: point?.label == null ? `P${index + 1}` : String(point.label).slice(0, 64),
    azimuthDeg: finite(point?.azimuthDeg, `${field}.calibrationPoints[${index}].azimuthDeg`, { min: -720, max: 720 }),
    elevationDeg: finite(point?.elevationDeg, `${field}.calibrationPoints[${index}].elevationDeg`, { min: -90, max: 90 }),
    x: finite(point?.x, `${field}.calibrationPoints[${index}].x`, { min: -16384, max: 32768 }),
    y: finite(point?.y, `${field}.calibrationPoints[${index}].y`, { min: -16384, max: 32768 }),
  }));
}

/** Optical basis of a projector. Yaw rotates the lens axis about +Z from +X
 * toward +Y, pitch raises it above horizontal, roll turns the image about the
 * lens axis (180 = ceiling/inverted mount). */
export function projectorBasis(projector) {
  const yaw = projector.yawDeg * DEG, pitch = projector.pitchDeg * DEG, roll = projector.rollDeg * DEG;
  const forward = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];
  const levelRight = [Math.sin(yaw), -Math.cos(yaw), 0];
  const levelUp = cross(levelRight, forward);
  const c = Math.cos(roll), s = Math.sin(roll);
  const right = add(scale(levelRight, c), scale(levelUp, s));
  const up = add(scale(levelUp, c), scale(levelRight, -s));
  return { forward, right, up };
}

function lensExtent(projector) {
  const width = 1 / projector.throwRatio;
  return { width, height: width * (projector.resolution.height / projector.resolution.width) };
}

/** Ray leaving a projector through normalized output pixel (x right, y down). */
export function projectorRay(projector, x, y, basis = projectorBasis(projector)) {
  const extent = lensExtent(projector);
  const sx = (x - 0.5 + projector.shiftX) * extent.width;
  const sy = (0.5 - y + projector.shiftY) * extent.height;
  return normalize(add(basis.forward, add(scale(basis.right, sx), scale(basis.up, sy))));
}

/** Normalized output pixel through which a projector reaches a world point. */
export function projectWorldPoint(projector, point, basis = projectorBasis(projector)) {
  const ray = sub(point, projector.positionM);
  const depth = dot(ray, basis.forward);
  if (!(depth > 1e-9)) return null;
  const extent = lensExtent(projector);
  const sx = dot(ray, basis.right) / depth, sy = dot(ray, basis.up) / depth;
  return {
    x: sx / extent.width + 0.5 - projector.shiftX,
    y: 0.5 + projector.shiftY - sy / extent.height,
  };
}

/** First intersection of a ray starting inside the dome sphere. */
export function intersectDome(dome, origin, direction) {
  const b = dot(origin, direction);
  const c = dot(origin, origin) - dome.radiusM * dome.radiusM;
  const t = -b + Math.sqrt(Math.max(0, b * b - c));
  return add(origin, scale(direction, t));
}

export function domePointFromAngles(dome, azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG, el = elevationDeg * DEG;
  return domeToWorld(dome, scale([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)], dome.radiusM));
}

export function domeElevationDeg(dome, worldPoint) {
  const local = worldToDome(dome, worldPoint);
  return Math.asin(Math.max(-1, Math.min(1, local[2] / length(local)))) / DEG;
}

/** Canvas pixel of the domemaster seen in a world direction from the eyepoint.
 * `radius` is 1 on the content circle; values above 1 are compressed into
 * the black margin. */
export function domemasterPixel(profile, worldPoint) {
  const { dome, fisheye } = profile;
  const direction = worldToDome(dome, normalize(sub(worldPoint, dome.eyepointM)));
  const theta = Math.acos(Math.max(-1, Math.min(1, direction[2])));
  const phi = Math.atan2(direction[1], direction[0]) + fisheye.rotationRad;
  const linear = theta / fisheye.halfFovRad;
  const m = fisheye.margin;
  const radius = linear <= 1 ? linear : 1 + m * (1 - Math.exp(-(linear - 1) / m));
  return {
    x: fisheye.centerX - fisheye.radiusPx * radius * Math.sin(phi),
    y: fisheye.centerY + fisheye.radiusPx * radius * Math.cos(phi),
    radius: linear,
  };
}

function hitForPixel(profile, projector, basis, x, y) {
  return intersectDome(profile.dome, projector.positionM, projectorRay(projector, x, y, basis));
}

/** Regular physical-pixel mesh whose u,v sample the domemaster canvas. */
export function buildDomeWarpMesh(profile, projector) {
  const { meshColumns: columns, meshRows: rows } = profile.build;
  const basis = projectorBasis(projector);
  const points = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const x = column / columns, y = row / rows;
      const pixel = domemasterPixel(profile, hitForPixel(profile, projector, basis, x, y));
      points.push({
        u: Math.max(0, Math.min(1, pixel.x / profile.canvas.width)),
        v: Math.max(0, Math.min(1, pixel.y / profile.canvas.height)),
        x,
        y,
      });
    }
  }
  const candidate = { enabled: true, columns, rows, interpolation: "bilinear", points };
  try {
    return validateMesh(candidate);
  } catch (error) {
    throw new Error(`Projector ${projector.id}: ${error.message}. Check pose/lens values; a mirrored or folded `
      + "view usually means yaw/roll is wrong or the lens sees the dome from outside.");
  }
}

function edgeDistance(pixel) {
  return Math.min(pixel.x, 1 - pixel.x, pixel.y, 1 - pixel.y);
}

/** Edge weight of one projector at a dome point: 0 at its frame edge, 1 once
 * `feather` (fraction of frame) inside it. Normalizing these weights gives a
 * partition of unity on the dome surface. */
function coverageWeight(profile, projector, basis, worldPoint) {
  const pixel = projectWorldPoint(projector, worldPoint, basis);
  if (!pixel) return 0;
  const distance = edgeDistance(pixel);
  if (distance <= 0) return 0;
  const t = Math.min(1, distance / profile.build.blendFeather);
  return Math.pow(t * t * (3 - 2 * t), profile.build.blendPower);
}

export function mapDimensions(profile, projector) {
  return {
    width: Math.max(16, Math.round(projector.resolution.width * profile.build.mapScale)),
    height: Math.max(16, Math.round(projector.resolution.height * profile.build.mapScale)),
  };
}

/** Blend and mask rasters for one projector, row-major top-to-bottom, in the
 * physical-pixel space the shader samples with SV_Position. */
export function buildDomeCorrectionMaps(profile, index) {
  const projector = profile.projectors[index];
  const bases = profile.projectors.map((entry) => projectorBasis(entry));
  const { width, height } = mapDimensions(profile, projector);
  const blend = new Float32Array(width * height);
  const mask = new Float32Array(width * height);
  const softnessDeg = Math.max(1e-6, profile.build.maskSoftnessPx * pixelAngleDeg(projector));
  let coveredPixels = 0, overlapPixels = 0;
  for (let row = 0; row < height; row += 1) {
    const y = (row + 0.5) / height;
    for (let column = 0; column < width; column += 1) {
      const x = (column + 0.5) / width;
      const hit = hitForPixel(profile, projector, bases[index], x, y);
      const aboveSpring = domeElevationDeg(profile.dome, hit) - profile.dome.springElevationDeg;
      const offset = row * width + column;
      if (aboveSpring <= 0) continue;
      const maskValue = profile.build.maskSoftnessPx > 0 ? Math.min(1, aboveSpring / softnessDeg) : 1;
      let own = 0, total = 0, contributors = 0;
      for (let other = 0; other < profile.projectors.length; other += 1) {
        const weight = coverageWeight(profile, profile.projectors[other], bases[other], hit);
        if (weight > 0) contributors += 1;
        total += weight;
        if (other === index) own = weight;
      }
      // The own frame always covers its own pixel centres, but its feathered
      // edge weight is 0 exactly at the border. Keep full light there when
      // no neighbour can take over, instead of printing a dark frame line.
      blend[offset] = total > 0 ? own / total : 1;
      mask[offset] = maskValue;
      coveredPixels += 1;
      if (contributors > 1) overlapPixels += 1;
    }
  }
  return { width, height, blend, mask, coveredPixels, overlapPixels };
}

function pixelAngleDeg(projector) {
  return (Math.atan(lensExtent(projector).width) / DEG) / projector.resolution.width;
}

/** Samples the dome above the spring line uniformly in solid angle and counts
 * how many projector frames reach each sample. */
export function analyzeDomeCoverage(profile, { samples = 20000 } = {}) {
  const bases = profile.projectors.map((entry) => projectorBasis(entry));
  const springSin = Math.sin(profile.dome.springElevationDeg * DEG);
  const counts = [];
  const perProjector = profile.projectors.map(() => 0);
  const uncoveredExamples = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < samples; index += 1) {
    // Fibonacci cap: uniform in solid angle between spring line and zenith.
    const z = springSin + (1 - springSin) * ((index + 0.5) / samples);
    const ring = Math.sqrt(Math.max(0, 1 - z * z));
    const az = index * golden;
    const point = domeToWorld(profile.dome, scale([ring * Math.cos(az), ring * Math.sin(az), z], profile.dome.radiusM));
    let count = 0;
    for (let projector = 0; projector < profile.projectors.length; projector += 1) {
      const pixel = projectWorldPoint(profile.projectors[projector], point, bases[projector]);
      if (pixel && edgeDistance(pixel) > 0) {
        count += 1;
        perProjector[projector] += 1;
      }
    }
    counts.push(count);
    if (count === 0 && uncoveredExamples.length < 12) {
      uncoveredExamples.push({
        azimuthDeg: Number((((az / DEG) % 360 + 360) % 360).toFixed(1)),
        elevationDeg: Number((Math.asin(z) / DEG).toFixed(1)),
      });
    }
  }
  const histogram = {};
  for (const count of counts) histogram[count] = (histogram[count] ?? 0) + 1;
  const uncovered = histogram[0] ?? 0;
  return {
    samples,
    coveredFraction: 1 - uncovered / samples,
    uncoveredFraction: uncovered / samples,
    projectorCountHistogram: histogram,
    perProjectorFraction: Object.fromEntries(profile.projectors.map((p, i) => [p.id, perProjector[i] / samples])),
    uncoveredExamples,
  };
}

const POSE_KEYS = ["px", "py", "pz", "yawDeg", "pitchDeg", "rollDeg", "throwRatio", "shiftX", "shiftY"];

function poseVector(projector) {
  return [...projector.positionM, projector.yawDeg, projector.pitchDeg, projector.rollDeg,
    projector.throwRatio, projector.shiftX, projector.shiftY];
}

function withPose(projector, vector) {
  return {
    ...projector,
    positionM: vector.slice(0, 3),
    yawDeg: vector[3],
    pitchDeg: vector[4],
    rollDeg: vector[5],
    throwRatio: Math.max(0.1, vector[6]),
    shiftX: vector[7],
    shiftY: vector[8],
  };
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-14) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k <= n; k += 1) a[row][k] -= factor * a[column][k];
    }
  }
  return a.map((row, index) => row[n] / row[index]);
}

/** Camera-free pose recovery. The operator places the projector cursor on
 * physical dome marks with known azimuth/elevation and records the projector
 * pixel. Levenberg-Marquardt then fits position, orientation and, when there
 * are enough points, throw ratio and lens shift. Measured values are the
 * starting point, so tape-measure accuracy is enough to converge. */
export function solveProjectorPose(profile, projector, {
  points = projector.calibrationPoints,
  free = ["px", "py", "pz", "yawDeg", "pitchDeg", "rollDeg"],
  iterations = 200,
} = {}) {
  const freeIndices = free.map((key) => {
    const index = POSE_KEYS.indexOf(key);
    if (index < 0) fail(`Unknown pose parameter ${key}`);
    return index;
  });
  if (points.length * 2 < freeIndices.length + 2) {
    fail(`Projector ${projector.id}: ${freeIndices.length} free parameters need at least `
      + `${Math.ceil((freeIndices.length + 2) / 2)} calibration points (have ${points.length})`);
  }
  const { width, height } = projector.resolution;
  const targets = points.map((point) => domePointFromAngles(profile.dome, point.azimuthDeg, point.elevationDeg));
  const residuals = (vector) => {
    const candidate = withPose(projector, vector);
    const basis = projectorBasis(candidate);
    const values = [];
    targets.forEach((target, index) => {
      const pixel = projectWorldPoint(candidate, target, basis);
      if (!pixel) {
        values.push(1e4, 1e4);
        return;
      }
      values.push(pixel.x * width - points[index].x, pixel.y * height - points[index].y);
    });
    return values;
  };
  const cost = (values) => values.reduce((sum, value) => sum + value * value, 0);
  let vector = poseVector(projector);
  let current = residuals(vector);
  let lambda = 1e-3;
  const steps = [1e-4, 1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-5, 1e-5, 1e-5];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const jacobian = freeIndices.map((parameter) => {
      const shifted = [...vector];
      shifted[parameter] += steps[parameter];
      return residuals(shifted).map((value, index) => (value - current[index]) / steps[parameter]);
    });
    const n = freeIndices.length;
    const normal = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      let sum = 0;
      for (let k = 0; k < current.length; k += 1) sum += jacobian[i][k] * jacobian[j][k];
      return sum;
    }));
    const gradient = Array.from({ length: n }, (_, i) => {
      let sum = 0;
      for (let k = 0; k < current.length; k += 1) sum -= jacobian[i][k] * current[k];
      return sum;
    });
    let improved = false;
    while (lambda < 1e12) {
      const damped = normal.map((row, i) => row.map((value, j) => (i === j ? value * (1 + lambda) + 1e-12 : value)));
      const delta = solveLinear(damped, gradient);
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const next = [...vector];
      freeIndices.forEach((parameter, i) => { next[parameter] += delta[i]; });
      const nextResiduals = residuals(next);
      if (cost(nextResiduals) < cost(current)) {
        const gain = cost(current) - cost(nextResiduals);
        vector = next;
        current = nextResiduals;
        lambda = Math.max(1e-9, lambda / 3);
        improved = gain > 1e-12;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  const solved = withPose(projector, vector);
  const perPoint = points.map((point, index) => ({
    label: point.label,
    errorPx: Math.hypot(current[index * 2], current[index * 2 + 1]),
  }));
  const rmsPx = Math.sqrt(cost(current) / Math.max(1, points.length));
  if (length(solved.positionM) >= profile.dome.radiusM) {
    fail(`Projector ${projector.id}: solved position is outside the dome; check the point labels and pixels`);
  }
  return { projector: solved, rmsPx, maxErrorPx: Math.max(0, ...perPoint.map((p) => p.errorPx)), perPoint, free };
}

/** Canvas pixel seen through the centre of a projector frame. */
export function projectorCenter(profile, projector) {
  return domemasterPixel(profile, hitForPixel(profile, projector, projectorBasis(projector), 0.5, 0.5));
}

/** Footprint outline of a projector frame in canvas pixels, for previews. */
export function projectorFootprint(profile, projector, samplesPerEdge = 48) {
  const basis = projectorBasis(projector);
  const outline = [];
  const edges = [
    (t) => [t, 0], (t) => [1, t], (t) => [1 - t, 1], (t) => [0, 1 - t],
  ];
  for (const edge of edges) {
    for (let index = 0; index < samplesPerEdge; index += 1) {
      const [x, y] = edge(index / samplesPerEdge);
      const pixel = domemasterPixel(profile, hitForPixel(profile, projector, basis, x, y));
      outline.push({ x: pixel.x, y: pixel.y });
    }
  }
  return outline;
}

/** RGB grid domemaster for alignment checks: elevation rings every 10 deg,
 * azimuth spokes every 15 deg, cardinal spokes coloured (front red, left
 * green, back blue, right yellow). */
export function renderDomeGrid(profile, size = profile.canvas.width) {
  const { fisheye, canvas } = profile;
  const scaleFactor = size / canvas.width;
  const height = Math.round(canvas.height * scaleFactor);
  const rgb = new Uint8Array(size * height * 3);
  const line = Math.max(1.5, size / 1024);
  const radiusPx = fisheye.radiusPx * scaleFactor;
  const halfFovDeg = fisheye.fovDeg / 2;
  const cardinal = { 0: [255, 40, 40], 90: [40, 230, 60], 180: [60, 110, 255], 270: [255, 220, 30] };
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const dx = (column + 0.5) - fisheye.centerX * scaleFactor;
      const dy = (row + 0.5) - fisheye.centerY * scaleFactor;
      const rPx = Math.hypot(dx, dy);
      if (rPx > radiusPx) continue;
      const offset = (row * size + column) * 3;
      const zenithDeg = (rPx / radiusPx) * halfFovDeg;
      const elevation = 90 - zenithDeg;
      let azimuth = (Math.atan2(-dx, dy) - fisheye.rotationRad) / DEG;
      azimuth = ((azimuth % 360) + 360) % 360;
      const degPerPx = halfFovDeg / radiusPx;
      const ringPhase = ((elevation % 10) + 10) % 10;
      const ringDistancePx = Math.min(ringPhase, 10 - ringPhase) / degPerPx;
      const nearestSpoke = Math.round(azimuth / 15) * 15;
      const spokeDistancePx = Math.abs(azimuth - nearestSpoke) * DEG * rPx;
      let color = [18, 20, 26];
      if (ringDistancePx < line) color = elevation < 5 ? [255, 120, 0] : [235, 235, 235];
      if (spokeDistancePx < line && zenithDeg > 3) color = cardinal[nearestSpoke % 360] ?? [200, 200, 200];
      if (rPx < line * 4) color = [255, 255, 255];
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }
  }
  return { width: size, height, rgb };
}
