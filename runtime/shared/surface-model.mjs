export const SURFACE_ID_MAXIMUM = 128;
export const SURFACE_NAME_MAXIMUM = 256;
export const SURFACE_LAYOUT_MODES = Object.freeze(["independent", "horizontal", "vertical"]);

// `:` remains valid for historical persisted surface ids. The current Windows
// binder derives new ids from the narrower node-auth grammar and does not emit it.
const SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNSAFE_DISPLAY_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const SURFACE_LAYOUT_MODE_SET = new Set(SURFACE_LAYOUT_MODES);

export function normalizeSurfaceId(value, field = "Surface id") {
  if (typeof value !== "string" || !SURFACE_ID_PATTERN.test(value)) {
    throw new Error(
      `${field} must be 1-${SURFACE_ID_MAXIMUM} letters, numbers, dot, colon, underscore, or hyphen, and start with a letter or number`,
    );
  }
  return value;
}

export function normalizeSurfaceName(value, fallback, field = "Surface name") {
  const candidate = value == null ? fallback : value;
  if (typeof candidate !== "string"
    || candidate.length < 1
    || candidate.length > SURFACE_NAME_MAXIMUM
    || candidate.trim() !== candidate
    || UNSAFE_DISPLAY_CHARACTER_PATTERN.test(candidate)) {
    throw new Error(
      `${field} must be canonical display text no longer than ${SURFACE_NAME_MAXIMUM} characters`,
    );
  }
  return candidate;
}

export function normalizeSurfaceLayout(value, {
  present,
  field = "Surface layout",
} = {}) {
  if (!present) return undefined;
  if (typeof value !== "string" || !SURFACE_LAYOUT_MODE_SET.has(value)) {
    throw new Error(`${field} must be independent, horizontal, or vertical`);
  }
  return value;
}

function comparableSurfaceName(name) {
  return name.normalize("NFKC").toLowerCase();
}

/**
 * Normalize the legacy `walls` wire field as an arbitrary physical-surface
 * topology. The wire key stays unchanged until a versioned protocol migration.
 */
export function normalizeSurfaceTopology(rawSurfaces, {
  present,
  maximum,
  fallbackSurface,
  inferredSurfaceIds = [],
} = {}) {
  let candidates;
  if (present) {
    if (!Array.isArray(rawSurfaces) || rawSurfaces.length < 1) {
      throw new Error("Project surface topology must be a non-empty array");
    }
    candidates = rawSurfaces;
  } else {
    const inferredIds = [...new Set(inferredSurfaceIds)];
    candidates = inferredIds.length > 0
      ? inferredIds.map((id) => ({ id, name: id }))
      : [fallbackSurface];
  }
  if (candidates.length > maximum) {
    throw new Error(`Project supports at most ${maximum} surfaces`);
  }

  const surfaceIds = new Set();
  const surfaceNames = new Set();
  const surfaces = candidates.map((surface, index) => {
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) {
      throw new Error(`Project surface topology entry ${index + 1} must be an object`);
    }
    const id = normalizeSurfaceId(surface.id, `Project surface topology entry ${index + 1} id`);
    const name = normalizeSurfaceName(
      surface.name,
      id,
      `Project surface topology entry ${index + 1} name`,
    );
    const layout = normalizeSurfaceLayout(surface.layout, {
      present: Object.prototype.hasOwnProperty.call(surface, "layout"),
      field: `Project surface topology entry ${index + 1} layout`,
    });
    if (surfaceIds.has(id)) throw new Error(`Duplicate surface id: ${id}`);
    const comparableName = comparableSurfaceName(name);
    if (surfaceNames.has(comparableName)) {
      throw new Error(`Duplicate surface name (case-insensitive): ${name}`);
    }
    surfaceIds.add(id);
    surfaceNames.add(comparableName);
    return {
      id,
      name,
      // Missing layout is a deliberate legacy state. Do not silently assign a
      // direction that could change overlap semantics for a valid old project.
      ...(layout === undefined ? {} : { layout }),
    };
  });

  return { surfaces, surfaceIds };
}

export function resolveSurfaceMembership(value, {
  present,
  surfaceIds,
  fallbackId,
  field,
} = {}) {
  if (!present) return fallbackId;
  const id = normalizeSurfaceId(value, field);
  if (!surfaceIds.has(id)) throw new Error(`${field} references unknown surface id: ${id}`);
  return id;
}
