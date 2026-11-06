function finiteInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value)));
}

export function requiredGrayBits(dimension) {
  const safeDimension = finiteInteger(dimension, 1, 1, 262_144);
  return Math.max(1, Math.ceil(Math.log2(safeDimension)));
}

export function binaryToGray(value) {
  const integer = Math.max(0, Math.trunc(Number(value)));
  return integer ^ (integer >> 1);
}

export function grayToBinary(value) {
  let gray = Math.max(0, Math.trunc(Number(value)));
  let binary = gray;
  while (gray > 0) {
    gray >>= 1;
    binary ^= gray;
  }
  return binary;
}

/**
 * Generates an 8-bit Gray-code calibration frame. Pair every normal frame with
 * its inverse so camera exposure and projector black leakage cancel during
 * decoding. Bit zero is the most-significant bit in the sequence.
 */
export function createGrayCodeFrame({ width, height, axis = "x", bit = 0, inverse = false }) {
  const safeWidth = finiteInteger(width, 1920, 1, 16_384);
  const safeHeight = finiteInteger(height, 1080, 1, 16_384);
  const dimension = axis === "y" ? safeHeight : safeWidth;
  const bits = requiredGrayBits(dimension);
  const safeBit = finiteInteger(bit, 0, 0, bits - 1);
  const shift = bits - safeBit - 1;
  const pixels = new Uint8Array(safeWidth * safeHeight);

  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const coordinate = axis === "y" ? y : x;
      const on = ((binaryToGray(coordinate) >> shift) & 1) === 1;
      pixels[y * safeWidth + x] = on !== Boolean(inverse) ? 255 : 0;
    }
  }
  return pixels;
}

/** Builds an RGBA projector test card with an exact, user-selectable cell size. */
export function createGridPattern({ width, height, cellSize = 32, lineWidth = 1 }) {
  const safeWidth = finiteInteger(width, 1920, 1, 16_384);
  const safeHeight = finiteInteger(height, 1080, 1, 16_384);
  const safeCell = finiteInteger(cellSize, 32, 2, 2_048);
  const safeLine = finiteInteger(lineWidth, 1, 1, Math.max(1, Math.floor(safeCell / 3)));
  const pixels = new Uint8Array(safeWidth * safeHeight * 4);
  const centerX = Math.floor(safeWidth / 2);
  const centerY = Math.floor(safeHeight / 2);

  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const offset = (y * safeWidth + x) * 4;
      const gridX = x % safeCell < safeLine;
      const gridY = y % safeCell < safeLine;
      const majorX = gridX && Math.floor(x / safeCell) % 4 === 0;
      const majorY = gridY && Math.floor(y / safeCell) % 4 === 0;
      const center = Math.abs(x - centerX) < safeLine || Math.abs(y - centerY) < safeLine;
      const checker = (Math.floor(x / safeCell) + Math.floor(y / safeCell)) % 2 === 0;
      const base = checker ? 18 : 5;
      pixels[offset] = center ? 255 : majorX || majorY ? 0 : gridX || gridY ? 210 : base;
      pixels[offset + 1] = center ? 48 : majorX || majorY ? 184 : gridX || gridY ? 225 : base;
      pixels[offset + 2] = center ? 184 : majorX || majorY ? 255 : gridX || gridY ? 240 : base;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/**
 * Decodes camera captures of Gray-code normal/inverse pairs. Input frames are
 * 8-bit luma arrays with equal size. Invalid/low-contrast camera pixels become
 * -1, while confidence records the weakest bit-pair contrast at each pixel.
 */
export function decodeGrayCodeFrames({ normalFrames, inverseFrames, width, height, threshold = 12 }) {
  const safeWidth = finiteInteger(width, 1, 1, 65_536);
  const safeHeight = finiteInteger(height, 1, 1, 65_536);
  const pixelCount = safeWidth * safeHeight;
  if (!Array.isArray(normalFrames) || normalFrames.length === 0 || normalFrames.length !== inverseFrames?.length) {
    throw new Error("Gray-code normal/inverse frame pairs are required");
  }
  if (normalFrames.length > 31) throw new Error("Gray-code decoder supports at most 31 bits");
  for (const frame of [...normalFrames, ...inverseFrames]) {
    if (!frame || frame.length !== pixelCount) throw new Error("Gray-code frame size mismatch");
  }

  const codes = new Int32Array(pixelCount).fill(-1);
  const confidence = new Float32Array(pixelCount);
  const safeThreshold = clamp(threshold, 0, 255);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    let gray = 0;
    let minimumContrast = 255;
    let valid = true;
    for (let bit = 0; bit < normalFrames.length; bit += 1) {
      const difference = Number(normalFrames[bit][pixel]) - Number(inverseFrames[bit][pixel]);
      const contrast = Math.abs(difference);
      minimumContrast = Math.min(minimumContrast, contrast);
      if (contrast < safeThreshold) {
        valid = false;
        break;
      }
      gray = (gray << 1) | (difference > 0 ? 1 : 0);
    }
    confidence[pixel] = minimumContrast / 255;
    if (valid) codes[pixel] = grayToBinary(gray);
  }
  return { codes, confidence };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("Calibration points are degenerate");
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = column; index <= size; index += 1) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index <= size; index += 1) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

/** Returns a 3×3 projective transform from four source/destination pairs. */
export function solveHomography(sourcePoints, destinationPoints) {
  if (sourcePoints?.length !== 4 || destinationPoints?.length !== 4) {
    throw new Error("Exactly four source and four destination points are required");
  }
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const x = Number(sourcePoints[index].x);
    const y = Number(sourcePoints[index].y);
    const u = Number(destinationPoints[index].x);
    const v = Number(destinationPoints[index].y);
    if (![x, y, u, v].every(Number.isFinite)) throw new Error("Calibration points must be finite");
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    vector.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    vector.push(v);
  }
  const values = solveLinearSystem(matrix, vector);
  return [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], 1];
}

export function applyHomography(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 9) throw new Error("Homography must contain nine values");
  const x = Number(point?.x);
  const y = Number(point?.y);
  const denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (![x, y, denominator].every(Number.isFinite) || Math.abs(denominator) < 1e-12) {
    throw new Error("Point cannot be projected by this homography");
  }
  return {
    x: (matrix[0] * x + matrix[1] * y + matrix[2]) / denominator,
    y: (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator,
  };
}

/**
 * Samples a camera-space target quadrilateral into the same regular control
 * grid used by the projector warp mesh. Corners are TL, TR, BR, BL and are
 * normalized to the camera image. A dense grid preserves curved geometry once
 * it is converted through the measured camera/projector correspondence below.
 */
export function createCameraTargetMesh({ columns = 32, rows = 18, corners }) {
  const safeColumns = finiteInteger(columns, 32, 2, 128);
  const safeRows = finiteInteger(rows, 18, 2, 128);
  if (!Array.isArray(corners) || corners.length !== 4) throw new Error("Camera target requires TL, TR, BR and BL corners");
  const source = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const destination = corners.map((point) => ({ x: clamp(point?.x), y: clamp(point?.y) }));
  const transform = solveHomography(source, destination);
  const points = [];
  for (let row = 0; row <= safeRows; row += 1) {
    const v = row / safeRows;
    for (let column = 0; column <= safeColumns; column += 1) {
      const u = column / safeColumns;
      const point = applyHomography(transform, { x: u, y: v });
      points.push({ u, v, cameraX: clamp(point.x), cameraY: clamp(point.y) });
    }
  }
  return { columns: safeColumns, rows: safeRows, points };
}

function nearestDecodedPixel({
  targetX,
  targetY,
  width,
  height,
  projectorX,
  projectorY,
  confidence,
  minimumConfidence,
  maxSearchRadius,
  projectorWidth,
  projectorHeight,
}) {
  const centerX = Math.round(clamp(targetX) * (width - 1));
  const centerY = Math.round(clamp(targetY) * (height - 1));
  const valid = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const index = y * width + x;
    const px = Number(projectorX[index]);
    const py = Number(projectorY[index]);
    const score = confidence ? Number(confidence[index]) : 1;
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0
      || px >= projectorWidth || py >= projectorHeight || score < minimumConfidence) return null;
    return { index, x, y, projectorX: px, projectorY: py, confidence: score };
  };
  for (let radius = 0; radius <= maxSearchRadius; radius += 1) {
    let best = null;
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius; x <= centerX + radius; x += 1) {
        if (radius > 0 && x !== centerX - radius && x !== centerX + radius
          && y !== centerY - radius && y !== centerY + radius) continue;
        const candidate = valid(x, y);
        if (!candidate) continue;
        const distance = (x - centerX) ** 2 + (y - centerY) ** 2;
        if (!best || distance < best.distance
          || (distance === best.distance && candidate.confidence > best.confidence)) {
          best = { ...candidate, distance };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Converts a decoded Gray-code camera map into a dense projector warp mesh.
 * Each desired camera-space target point is looked up in the measured
 * camera->projector correspondence. This captures keystone and non-linear
 * surface curvature; no four-corner assumption is made after target sampling.
 */
export function buildWarpMeshFromCameraMap({
  cameraWidth,
  cameraHeight,
  projectorWidth,
  projectorHeight,
  projectorX,
  projectorY,
  confidence = null,
  targetMesh,
  minimumConfidence = 0.08,
  maxSearchRadius = 24,
  allowHoles = false,
}) {
  const width = finiteInteger(cameraWidth, 1, 1, 65_536);
  const height = finiteInteger(cameraHeight, 1, 1, 65_536);
  const outputWidth = finiteInteger(projectorWidth, 1, 2, 16_384);
  const outputHeight = finiteInteger(projectorHeight, 1, 2, 16_384);
  const count = width * height;
  if (projectorX?.length !== count || projectorY?.length !== count || (confidence && confidence.length !== count)) {
    throw new Error("Camera/projector correspondence arrays must match the camera dimensions");
  }
  const columns = finiteInteger(targetMesh?.columns, 32, 2, 128);
  const rows = finiteInteger(targetMesh?.rows, 18, 2, 128);
  const expected = (columns + 1) * (rows + 1);
  if (!Array.isArray(targetMesh?.points) || targetMesh.points.length !== expected) {
    throw new Error("Target mesh point count does not match its rows and columns");
  }
  const safeConfidence = clamp(minimumConfidence, 0, 1);
  const safeSearchRadius = finiteInteger(maxSearchRadius, 24, 0, Math.max(width, height));
  let confidenceTotal = 0;
  let holes = 0;
  const searchDistances = [];
  const points = targetMesh.points.map((target, index) => {
    const row = Math.floor(index / (columns + 1));
    const column = index % (columns + 1);
    const match = nearestDecodedPixel({
      targetX: target.cameraX,
      targetY: target.cameraY,
      width,
      height,
      projectorX,
      projectorY,
      confidence,
      minimumConfidence: safeConfidence,
      maxSearchRadius: safeSearchRadius,
      projectorWidth: outputWidth,
      projectorHeight: outputHeight,
    });
    if (!match) {
      holes += 1;
      if (!allowHoles) throw new Error(`No valid Gray-code correspondence near mesh point ${column},${row}`);
      return { u: column / columns, v: row / rows, x: column / columns, y: row / rows, confidence: 0 };
    }
    confidenceTotal += match.confidence;
    searchDistances.push(Math.sqrt(match.distance));
    return {
      u: column / columns,
      v: row / rows,
      x: match.projectorX / (outputWidth - 1),
      y: match.projectorY / (outputHeight - 1),
      confidence: match.confidence,
    };
  });
  searchDistances.sort((first, second) => first - second);
  const distanceAt = (ratio) => {
    if (!searchDistances.length) return null;
    return searchDistances[Math.min(searchDistances.length - 1, Math.floor(ratio * (searchDistances.length - 1)))];
  };
  return {
    columns,
    rows,
    interpolation: "bicubic",
    points,
    confidence: confidenceTotal / Math.max(1, points.length - holes),
    holes,
    searchDistancePx: {
      median: distanceAt(0.5),
      p95: distanceAt(0.95),
      max: searchDistances.length ? searchDistances.at(-1) : null,
    },
  };
}

/** Produces a smooth inside-edge feather field from a camera/surface mask. */
export function buildDistanceFeatherMap(mask, { width, height, power = 1, maximumDistance = null } = {}) {
  const safeWidth = finiteInteger(width, 1, 1, 65_536);
  const safeHeight = finiteInteger(height, 1, 1, 65_536);
  const count = safeWidth * safeHeight;
  if (!mask || mask.length !== count) throw new Error("Feather mask size mismatch");
  const distance = new Float32Array(count);
  const infinity = safeWidth + safeHeight + 1;
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const index = y * safeWidth + x;
      const inside = Number(mask[index]) > 0;
      distance[index] = !inside ? 0 : (x === 0 || y === 0 || x === safeWidth - 1 || y === safeHeight - 1 ? 1 : infinity);
    }
  }
  for (let y = 0; y < safeHeight; y += 1) {
    for (let x = 0; x < safeWidth; x += 1) {
      const index = y * safeWidth + x;
      if (distance[index] === 0) continue;
      if (x > 0) distance[index] = Math.min(distance[index], distance[index - 1] + 1);
      if (y > 0) distance[index] = Math.min(distance[index], distance[index - safeWidth] + 1);
    }
  }
  for (let y = safeHeight - 1; y >= 0; y -= 1) {
    for (let x = safeWidth - 1; x >= 0; x -= 1) {
      const index = y * safeWidth + x;
      if (distance[index] === 0) continue;
      if (x + 1 < safeWidth) distance[index] = Math.min(distance[index], distance[index + 1] + 1);
      if (y + 1 < safeHeight) distance[index] = Math.min(distance[index], distance[index + safeWidth] + 1);
    }
  }
  const measuredMaximum = distance.reduce((maximum, value) => value < infinity ? Math.max(maximum, value) : maximum, 0);
  const divisor = Math.max(1, finiteInteger(maximumDistance, measuredMaximum, 1, infinity));
  const exponent = Math.max(0.05, Math.min(8, Number(power) || 1));
  return Float32Array.from(distance, (value) => value <= 0 ? 0 : Math.pow(clamp(value / divisor), exponent));
}

/** Builds camera-space blend maps whose active projector weights sum to one. */
export function buildAutomaticBlendMaps(masks, { width, height, power = 1, maximumDistance = null } = {}) {
  if (!Array.isArray(masks) || masks.length < 1) throw new Error("Projector visibility masks are required");
  const featherMaps = masks.map((mask) => buildDistanceFeatherMap(mask, { width, height, power, maximumDistance }));
  return normalizeBlendContributions(featherMaps, { zeroWhenEmpty: true });
}

function percentile(values, amount) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(amount, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/**
 * LCD projectors cannot emit "negative black". This map raises darker pixels
 * toward the measured worst black floor, making seams uniform without claiming
 * to remove optical leakage. Values are linear-light additions for the shader.
 */
export function buildBlackUniformityMap(measuredBlack, { targetPercentile = 0.98, maxLift = 0.35 } = {}) {
  if (!measuredBlack?.length) throw new Error("Measured black samples are required");
  const measurements = Array.from(measuredBlack, (value) => clamp(value, 0, 1));
  const target = percentile(measurements, targetPercentile);
  const limit = clamp(maxLift, 0, 1);
  const lift = Float32Array.from(measurements, (value) => Math.min(limit, Math.max(0, target - value)));
  return { target, lift };
}

/** Normalizes arbitrary overlap weights so all contributing outputs sum to 1. */
export function normalizeBlendContributions(weightMaps, { zeroWhenEmpty = false } = {}) {
  if (!Array.isArray(weightMaps) || weightMaps.length === 0) throw new Error("Blend weight maps are required");
  const length = weightMaps[0]?.length ?? 0;
  if (length === 0 || weightMaps.some((map) => map?.length !== length)) {
    throw new Error("Blend weight maps must have equal non-zero lengths");
  }
  const normalized = weightMaps.map(() => new Float32Array(length));
  for (let pixel = 0; pixel < length; pixel += 1) {
    const values = weightMaps.map((map) => Math.max(0, Number(map[pixel]) || 0));
    const sum = values.reduce((total, value) => total + value, 0);
    const fallback = sum <= 1e-12 && !zeroWhenEmpty ? 1 / values.length : 0;
    for (let output = 0; output < values.length; output += 1) {
      normalized[output][pixel] = sum <= 1e-12 ? fallback : values[output] / sum;
    }
  }
  return normalized;
}
