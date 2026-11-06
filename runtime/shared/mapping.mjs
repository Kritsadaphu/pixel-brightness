export const MAX_GRID_COLUMNS = 128;
export const MAX_GRID_ROWS = 128;
const OUTPUT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max, fallback = min) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function normalizedTriplet(value, fallback, min, max) {
  return [0, 1, 2].map((index) => clamp(value?.[index], min, max, fallback[index]));
}

export function createIdentityMesh(columns = 32, rows = 18) {
  const safeColumns = clamp(Math.round(columns), 2, MAX_GRID_COLUMNS);
  const safeRows = clamp(Math.round(rows), 2, MAX_GRID_ROWS);
  const points = [];
  for (let row = 0; row <= safeRows; row += 1) {
    for (let column = 0; column <= safeColumns; column += 1) {
      points.push({
        u: column / safeColumns,
        v: row / safeRows,
        x: column / safeColumns,
        y: row / safeRows,
      });
    }
  }
  return { columns: safeColumns, rows: safeRows, interpolation: "bicubic", points };
}

function meshCoordinate(point, key, minimum, maximum, index) {
  const numeric = Number(point?.[key]);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`warp.points[${index}].${key} must be finite and within ${minimum}..${maximum}`);
  }
  return numeric;
}

function triangleArea(a, b, c, source) {
  const xKey = source ? "u" : "x";
  const yKey = source ? "v" : "y";
  return (b[xKey] - a[xKey]) * (c[yKey] - a[yKey])
    - (b[yKey] - a[yKey]) * (c[xKey] - a[xKey]);
}

function assertUnfoldedMesh(points, columns, rows) {
  const minimumArea = 1e-8;
  const stride = columns + 1;
  const validTriangle = (a, b, c) => triangleArea(points[a], points[b], points[c], true) > minimumArea
    && triangleArea(points[a], points[b], points[c], false) > minimumArea;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      if (!validTriangle(topLeft, topRight, bottomLeft)
        || !validTriangle(topRight, bottomRight, bottomLeft)) {
        throw new Error(`warp mesh contains a folded or degenerate cell at ${column},${row}`);
      }
    }
  }
}

export function validateMesh(mesh) {
  const columns = clamp(Math.round(finiteNumber(mesh?.columns, 32)), 2, MAX_GRID_COLUMNS, 32);
  const rows = clamp(Math.round(finiteNumber(mesh?.rows, 18)), 2, MAX_GRID_ROWS, 18);
  const expected = (columns + 1) * (rows + 1);
  let points;
  if (mesh?.points == null) {
    points = createIdentityMesh(columns, rows).points;
  } else {
    if (!Array.isArray(mesh.points) || mesh.points.length !== expected) {
      throw new Error(`warp.points count must equal (columns+1)*(rows+1): expected ${expected}`);
    }
    points = mesh.points.map((point, index) => ({
      u: meshCoordinate(point, "u", 0, 1, index),
      v: meshCoordinate(point, "v", 0, 1, index),
      x: meshCoordinate(point, "x", -2, 3, index),
      y: meshCoordinate(point, "y", -2, 3, index),
    }));
  }
  const enabled = mesh?.enabled === true;
  if (enabled) assertUnfoldedMesh(points, columns, rows);
  return {
    enabled,
    columns,
    rows,
    interpolation: mesh?.interpolation === "bilinear" ? "bilinear" : "bicubic",
    points,
  };
}

export function sampleMesh(meshInput, uInput, vInput) {
  const mesh = validateMesh(meshInput);
  const u = clamp(uInput, 0, 1);
  const v = clamp(vInput, 0, 1);
  const gx = u * mesh.columns;
  const gy = v * mesh.rows;
  const column = Math.min(mesh.columns - 1, Math.floor(gx));
  const row = Math.min(mesh.rows - 1, Math.floor(gy));
  const tx = gx - column;
  const ty = gy - row;
  const stride = mesh.columns + 1;
  const p00 = mesh.points[row * stride + column];
  const p10 = mesh.points[row * stride + column + 1];
  const p01 = mesh.points[(row + 1) * stride + column];
  const p11 = mesh.points[(row + 1) * stride + column + 1];
  const mix = (a, b, amount) => a + (b - a) * amount;
  return {
    x: mix(mix(p00.x, p10.x, tx), mix(p01.x, p11.x, tx), ty),
    y: mix(mix(p00.y, p10.y, tx), mix(p01.y, p11.y, tx), ty),
  };
}

export function buildBlendWeights(length, feather = 0.78, gamma = 2.2, direction = "out") {
  const count = clamp(Math.round(length), 2, 16384);
  const safeFeather = clamp(feather, 0.01, 1, 0.78);
  const safeGamma = clamp(gamma, 0.1, 8, 2.2);
  return Array.from({ length: count }, (_value, index) => {
    const normalized = index / (count - 1);
    const shaped = Math.pow(clamp(normalized / safeFeather, 0, 1), safeGamma);
    return direction === "in" ? shaped : 1 - shaped;
  });
}

export function normalizeOutputConfig(output) {
  if (!output?.id) throw new Error("Output id is required");
  const id = String(output.id);
  if (!OUTPUT_ID_PATTERN.test(id)) {
    throw new Error("Output id must be 1-64 letters, numbers, dot, underscore, or hyphen");
  }
  const width = clamp(Math.round(finiteNumber(output.resolution?.width, 1920)), 64, 16384, 1920);
  const height = clamp(Math.round(finiteNumber(output.resolution?.height, 1080)), 64, 16384, 1080);
  const overlap = {
    left: clamp(Math.round(finiteNumber(output.overlap?.left, 0)), 0, width - 1),
    right: clamp(Math.round(finiteNumber(output.overlap?.right, 0)), 0, width - 1),
    top: clamp(Math.round(finiteNumber(output.overlap?.top, 0)), 0, height - 1),
    bottom: clamp(Math.round(finiteNumber(output.overlap?.bottom, 0)), 0, height - 1),
  };
  overlap.right = Math.min(overlap.right, width - overlap.left - 1);
  overlap.bottom = Math.min(overlap.bottom, height - overlap.top - 1);

  const maskPath = Array.isArray(output.mask?.path)
    ? output.mask.path.slice(0, 4096).map((point) => ({
      x: clamp(point?.x, -2, 3),
      y: clamp(point?.y, -2, 3),
    }))
    : null;
  const maskEnabled = output.mask?.enabled === true;
  if (maskEnabled && output.mask?.map == null && (!maskPath || maskPath.length < 3)) {
    throw new Error(`Output ${id} enabled mask requires a correction map or at least three polygon points`);
  }

  return {
    ...output,
    id,
    name: String(output.name || output.id),
    connector: String(output.connector || `DISPLAY-${output.id}`),
    nodeId: output.nodeId ? String(output.nodeId) : null,
    enabled: output.enabled !== false,
    resolution: {
      width,
      height,
      // Preserve DXGI's exact rational timing (for example 60000/1001).
      // Reducing the numerator to a display-Hz range changes the mode itself.
      refreshNum: clamp(Math.round(finiteNumber(output.resolution?.refreshNum, 60)), 1, 240_000, 60),
      refreshDen: clamp(Math.round(finiteNumber(output.resolution?.refreshDen, 1)), 1, 100_000, 1),
    },
    sourceViewport: {
      x: Math.round(finiteNumber(output.sourceViewport?.x, 0)),
      y: Math.round(finiteNumber(output.sourceViewport?.y, 0)),
      width: clamp(Math.round(finiteNumber(output.sourceViewport?.width, width)), 1, 65536, width),
      height: clamp(Math.round(finiteNumber(output.sourceViewport?.height, height)), 1, 65536, height),
    },
    overlap,
    warp: validateMesh(output.warp),
    blend: {
      enabled: output.blend?.enabled !== false,
      feather: clamp(output.blend?.feather, 0.01, 1, 0.78),
      gamma: clamp(output.blend?.gamma, 0.1, 8, 2.2),
      map: output.blend?.map ?? null,
    },
    blackUniformity: {
      enabled: output.blackUniformity?.enabled !== false,
      lift: clamp(output.blackUniformity?.lift, 0, 1, 0),
      map: output.blackUniformity?.map ?? null,
    },
    mask: {
      enabled: maskEnabled,
      map: output.mask?.map ?? null,
      path: maskPath,
      softness: clamp(output.mask?.softness, 0, 1, 0),
    },
    color: {
      gain: normalizedTriplet(output.color?.gain, [1, 1, 1], 0, 8),
      offset: normalizedTriplet(output.color?.offset, [0, 0, 0], -1, 1),
      gamma: normalizedTriplet(output.color?.gamma, [1, 1, 1], 0.1, 8),
      lut: output.color?.lut ?? null,
    },
  };
}
