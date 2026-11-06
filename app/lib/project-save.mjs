function finiteInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nodeValues(input) {
  if (Array.isArray(input)) return input;
  return input && typeof input === "object" ? Object.values(input) : [];
}

function nodeIdentifier(node) {
  return String(node?.nodeId ?? node?.id ?? "");
}

const SURFACE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SURFACE_LAYOUTS = new Set(["independent", "horizontal", "vertical"]);
const OVERLAP_EDGES = ["left", "right", "top", "bottom"];
const ZERO_OVERLAP = Object.freeze({ left: 0, right: 0, top: 0, bottom: 0 });

function canonicalSurfaceName(value) {
  const name = String(value ?? "");
  const hasControl = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!name || name.trim() !== name || name.length > 128 || hasControl) {
    throw new Error("Surface name must be 1-128 canonical characters without leading, trailing, or control characters");
  }
  return name;
}

function canonicalSurfaceId(value) {
  const id = String(value ?? "");
  if (!SURFACE_ID_PATTERN.test(id)) {
    throw new Error("Surface ID must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return id;
}

function canonicalSurfaceLayout(value) {
  if (!SURFACE_LAYOUTS.has(value)) {
    throw new Error("Surface layout must be independent, horizontal, or vertical");
  }
  return value;
}

export function exactOverlapVector(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(OVERLAP_EDGES.map((edge) => {
    const number = Number(source[edge] ?? 0);
    return [edge, Number.isFinite(number) ? number : 0];
  }));
}

function positiveOverlapAxes(outputs) {
  let horizontal = false;
  let vertical = false;
  for (const output of outputs) {
    const overlap = exactOverlapVector(output?.overlap);
    horizontal ||= overlap.left > 0 || overlap.right > 0;
    vertical ||= overlap.top > 0 || overlap.bottom > 0;
  }
  return { horizontal, vertical };
}

/** Resolve an explicit layout or safely infer an omitted legacy layout. */
export function resolvePhysicalSurfaceLayout(surface, outputs) {
  if (surface && Object.prototype.hasOwnProperty.call(surface, "layout")) {
    if (SURFACE_LAYOUTS.has(surface.layout)) {
      return { layout: surface.layout, inferred: false, issue: null };
    }
    return {
      layout: null,
      inferred: false,
      issue: `Surface ${surface?.id ?? "(missing)"} has an invalid explicit layout`,
    };
  }
  const assigned = (Array.isArray(outputs) ? outputs : [])
    .filter((output) => String(output?.wallId ?? "") === String(surface?.id ?? ""));
  const axes = positiveOverlapAxes(assigned);
  if (axes.horizontal && axes.vertical) {
    return {
      layout: null,
      inferred: true,
      issue: `Legacy surface ${surface?.id ?? "(missing)"} has overlap ramps on both axes; choose a layout`,
    };
  }
  if (axes.horizontal) return { layout: "horizontal", inferred: true, issue: null };
  if (axes.vertical) return { layout: "vertical", inferred: true, issue: null };
  return { layout: "independent", inferred: true, issue: null };
}

export function catalogProjectSurfaces(walls, outputs, fallback = { id: "surface-main", name: "Main surface" }) {
  const catalog = [];
  const seen = new Set();
  for (const wall of Array.isArray(walls) ? walls : []) {
    const id = String(wall?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    catalog.push({ ...wall, id, name: String(wall?.name ?? id) });
  }
  for (const output of Array.isArray(outputs) ? outputs : []) {
    const id = String(output?.wallId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    catalog.push({ id, name: id });
  }
  if (catalog.length === 0) catalog.push({ ...fallback });
  return catalog;
}

export function createPhysicalSurface(surfaces, input) {
  const catalog = Array.isArray(surfaces) ? surfaces : [];
  const surface = {
    id: canonicalSurfaceId(input?.id),
    name: canonicalSurfaceName(input?.name),
    layout: canonicalSurfaceLayout(input?.layout ?? "independent"),
  };
  if (catalog.some((candidate) => String(candidate?.id).toLowerCase() === surface.id.toLowerCase())) {
    throw new Error(`Surface ID ${surface.id} already exists`);
  }
  if (catalog.some((candidate) => String(candidate?.name).toLowerCase() === surface.name.toLowerCase())) {
    throw new Error(`Surface name ${surface.name} already exists`);
  }
  return { surface, surfaces: [...catalog, surface] };
}

export function renamePhysicalSurface(surfaces, surfaceId, nameInput) {
  const catalog = Array.isArray(surfaces) ? surfaces : [];
  const id = String(surfaceId ?? "");
  const index = catalog.findIndex((surface) => String(surface?.id) === id);
  if (index < 0) throw new Error(`Surface ${id || "(missing)"} does not exist`);
  const name = canonicalSurfaceName(nameInput);
  if (catalog.some((surface, candidateIndex) => (
    candidateIndex !== index && String(surface?.name).toLowerCase() === name.toLowerCase()
  ))) {
    throw new Error(`Surface name ${name} already exists`);
  }
  return catalog.map((surface, candidateIndex) => candidateIndex === index ? { ...surface, name } : surface);
}

export function setPhysicalSurfaceLayout(surfaces, surfaceId, layoutInput) {
  const catalog = Array.isArray(surfaces) ? surfaces : [];
  const id = String(surfaceId ?? "");
  const index = catalog.findIndex((surface) => String(surface?.id) === id);
  if (index < 0) throw new Error(`Surface ${id || "(missing)"} does not exist`);
  const layout = canonicalSurfaceLayout(layoutInput);
  return catalog.map((surface, candidateIndex) => candidateIndex === index ? { ...surface, layout } : surface);
}

function orderedSurfaceOutputs(outputs, surfaceId, layout) {
  const primary = layout === "vertical" ? "y" : "x";
  const secondary = layout === "vertical" ? "x" : "y";
  return outputs
    .map((output, index) => ({ output, index }))
    .filter(({ output }) => String(output?.wallId ?? "") === surfaceId)
    .sort((left, right) => (
      Number(left.output?.sourceViewport?.[primary] ?? 0) - Number(right.output?.sourceViewport?.[primary] ?? 0)
      || Number(left.output?.sourceViewport?.[secondary] ?? 0) - Number(right.output?.sourceViewport?.[secondary] ?? 0)
      || left.index - right.index
    ))
    .map(({ output }) => output);
}

function finitePixelInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function outputGeometry(output) {
  const viewport = output?.sourceViewport ?? {};
  const resolution = output?.resolution ?? {};
  return {
    id: String(output?.id ?? ""),
    x: finitePixelInteger(viewport.x),
    y: finitePixelInteger(viewport.y),
    width: finitePixelInteger(viewport.width),
    height: finitePixelInteger(viewport.height),
    outputWidth: finitePixelInteger(resolution.width),
    outputHeight: finitePixelInteger(resolution.height),
  };
}

function axisSurfaceAnalysis(surfaceId, layout, outputs) {
  const assigned = orderedSurfaceOutputs(outputs, surfaceId, layout);
  const issues = [];
  const geometry = new Map();
  for (const output of assigned) {
    const item = outputGeometry(output);
    geometry.set(String(output.id), item);
    if (item.x == null || item.y == null || item.x < 0 || item.y < 0
      || item.width == null || item.height == null || item.width < 1 || item.height < 1
      || item.outputWidth == null || item.outputHeight == null || item.outputWidth < 1 || item.outputHeight < 1) {
      issues.push({
        code: "invalid-viewport",
        surfaceId,
        outputId: item.id,
        message: `${item.id || "Output"} needs non-negative integer source coordinates and positive integer source/output dimensions`,
      });
    }
  }
  const validGeometry = assigned.map((output) => geometry.get(String(output.id)))
    .filter((item) => item && item.x != null && item.y != null && item.width > 0 && item.height > 0
      && item.outputWidth > 0 && item.outputHeight > 0);
  const reference = validGeometry[0];
  if (reference) {
    for (const item of validGeometry.slice(1)) {
      const aligned = layout === "horizontal"
        ? item.y === reference.y && item.height === reference.height
        : item.x === reference.x && item.width === reference.width;
      if (!aligned) {
        issues.push({
          code: "ambiguous-2d",
          surfaceId,
          outputId: item.id,
          message: `${surfaceId} is not one aligned ${layout === "horizontal" ? "horizontal row" : "vertical column"}; multi-row/2D adjacency is ambiguous`,
        });
      }
      const equalScaleX = item.width * reference.outputWidth === reference.width * item.outputWidth;
      const equalScaleY = item.height * reference.outputHeight === reference.height * item.outputHeight;
      if (!equalScaleX || !equalScaleY) {
        issues.push({
          code: "scale-mismatch",
          surfaceId,
          outputId: item.id,
          message: `${surfaceId} outputs must use equal source-to-output scale before overlap pixels can be compared safely`,
        });
      }
    }
  }
  const primaryStart = (item) => layout === "horizontal" ? item.x : item.y;
  const primarySize = (item) => layout === "horizontal" ? item.width : item.height;
  const outputPrimarySize = (item) => layout === "horizontal" ? item.outputWidth : item.outputHeight;
  for (let index = 1; index < assigned.length; index += 1) {
    const previous = geometry.get(String(assigned[index - 1].id));
    const current = geometry.get(String(assigned[index].id));
    if (previous && current && primaryStart(previous) === primaryStart(current)) {
      issues.push({
        code: "ambiguous-order",
        surfaceId,
        outputId: current.id,
        message: `${surfaceId} has two outputs at the same ${layout === "horizontal" ? "X" : "Y"}; adjacency is ambiguous`,
      });
    }
  }
  const seams = [];
  for (let index = 0; index < assigned.length - 1; index += 1) {
    const from = assigned[index];
    const to = assigned[index + 1];
    const fromGeometry = geometry.get(String(from.id));
    const toGeometry = geometry.get(String(to.id));
    let sourceIntersectionPixels = null;
    let expectedPixels = null;
    if (fromGeometry && toGeometry && primaryStart(fromGeometry) != null && primaryStart(toGeometry) != null
      && primarySize(fromGeometry) > 0 && primarySize(toGeometry) > 0 && outputPrimarySize(fromGeometry) > 0) {
      sourceIntersectionPixels = Math.max(0, Math.min(
        primaryStart(fromGeometry) + primarySize(fromGeometry),
        primaryStart(toGeometry) + primarySize(toGeometry),
      ) - Math.max(primaryStart(fromGeometry), primaryStart(toGeometry)));
      const nativePixels = sourceIntersectionPixels * outputPrimarySize(fromGeometry) / primarySize(fromGeometry);
      if (Number.isSafeInteger(nativePixels)) expectedPixels = nativePixels;
      else {
        issues.push({
          code: "fractional-overlap",
          surfaceId,
          outputId: String(from.id),
          message: `${from.id} ↔ ${to.id} source intersection does not map to a whole output pixel`,
        });
      }
    }
    const fromEdge = layout === "horizontal" ? "right" : "bottom";
    const toEdge = layout === "horizontal" ? "left" : "top";
    const fromPixels = exactOverlapVector(from.overlap)[fromEdge];
    const toPixels = exactOverlapVector(to.overlap)[toEdge];
    seams.push({
      key: `${from.id}:${to.id}`,
      fromId: String(from.id),
      toId: String(to.id),
      fromEdge,
      toEdge,
      fromPixels,
      toPixels,
      sourceIntersectionPixels,
      expectedPixels,
    });
  }
  for (let leftIndex = 0; leftIndex < assigned.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 2; rightIndex < assigned.length; rightIndex += 1) {
      const left = geometry.get(String(assigned[leftIndex].id));
      const right = geometry.get(String(assigned[rightIndex].id));
      if (!left || !right || primaryStart(left) == null || primaryStart(right) == null) continue;
      const intersection = Math.min(primaryStart(left) + primarySize(left), primaryStart(right) + primarySize(right))
        - Math.max(primaryStart(left), primaryStart(right));
      if (intersection > 0) {
        issues.push({
          code: "non-adjacent-overlap",
          surfaceId,
          outputId: String(assigned[rightIndex].id),
          message: `${assigned[leftIndex].id} and ${assigned[rightIndex].id} overlap past an immediate neighbour; adjacency is ambiguous`,
        });
      }
    }
  }
  return { assigned, seams, issues, geometry };
}

/** Validate every persisted surface and return named seam diagnostics for UI. */
export function validatePhysicalSurfaceTopology(surfaces, outputs, { requireExplicitLayouts = true } = {}) {
  const catalog = Array.isArray(surfaces) ? surfaces : [];
  const topology = Array.isArray(outputs) ? outputs : [];
  const issues = [];
  const details = [];
  const knownSurfaceIds = new Set(catalog.map((surface) => String(surface?.id ?? "")));
  for (const output of topology) {
    if (!knownSurfaceIds.has(String(output?.wallId ?? ""))) {
      issues.push({
        code: "unknown-surface",
        surfaceId: String(output?.wallId ?? ""),
        outputId: String(output?.id ?? ""),
        message: `${output?.id ?? "Output"} is assigned to a surface that is not in the project catalog`,
      });
    }
  }
  for (const surface of catalog) {
    const surfaceId = String(surface?.id ?? "");
    const assigned = topology.filter((output) => String(output?.wallId ?? "") === surfaceId);
    const resolved = resolvePhysicalSurfaceLayout(surface, topology);
    const surfaceIssues = [];
    if (!resolved.layout) {
      surfaceIssues.push({ code: "ambiguous-layout", surfaceId, message: resolved.issue });
      details.push({ surfaceId, layout: null, inferred: resolved.inferred, outputs: assigned, seams: [], issues: surfaceIssues });
      issues.push(...surfaceIssues);
      continue;
    }
    if (resolved.inferred && requireExplicitLayouts) {
      surfaceIssues.push({
        code: "layout-confirmation-required",
        surfaceId,
        message: `${surfaceId} safely infers ${resolved.layout}, but an operator must confirm and persist the layout before Save/LIVE`,
      });
    }
    for (const output of assigned) {
      const raw = output?.overlap && typeof output.overlap === "object" ? output.overlap : {};
      for (const edge of OVERLAP_EDGES) {
        if (raw[edge] == null) continue;
        const value = raw[edge];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          surfaceIssues.push({
            code: "invalid-overlap",
            surfaceId,
            outputId: String(output?.id ?? ""),
            message: `${output?.id ?? "Output"} ${edge} overlap must be a non-negative whole output pixel count`,
          });
        }
      }
    }
    if (resolved.layout === "independent") {
      for (const output of assigned) {
        const overlap = exactOverlapVector(output?.overlap);
        for (const edge of OVERLAP_EDGES) {
          if (overlap[edge] !== 0) {
            surfaceIssues.push({
              code: "independent-overlap",
              surfaceId,
              outputId: String(output?.id ?? ""),
              message: `${output?.id ?? "Output"} ${edge.toUpperCase()} is an orphan ramp; Independent surfaces require all four edges to be zero`,
            });
          }
        }
      }
      details.push({ surfaceId, layout: resolved.layout, inferred: resolved.inferred, outputs: assigned, seams: [], issues: surfaceIssues });
      issues.push(...surfaceIssues);
      continue;
    }
    const analysis = axisSurfaceAnalysis(surfaceId, resolved.layout, topology);
    surfaceIssues.push(...analysis.issues);
    const leadingEdge = resolved.layout === "horizontal" ? "left" : "top";
    const trailingEdge = resolved.layout === "horizontal" ? "right" : "bottom";
    const inactiveEdges = resolved.layout === "horizontal" ? ["top", "bottom"] : ["left", "right"];
    for (const output of assigned) {
      const overlap = exactOverlapVector(output?.overlap);
      for (const edge of inactiveEdges) {
        if (overlap[edge] !== 0) {
          surfaceIssues.push({
            code: "inactive-edge",
            surfaceId,
            outputId: String(output?.id ?? ""),
            message: `${output?.id ?? "Output"} ${edge.toUpperCase()} must be zero for a ${resolved.layout} surface`,
          });
        }
      }
      const geometry = analysis.geometry.get(String(output?.id));
      const outputAxisPixels = resolved.layout === "horizontal" ? geometry?.outputWidth : geometry?.outputHeight;
      if (outputAxisPixels > 0 && overlap[leadingEdge] + overlap[trailingEdge] >= outputAxisPixels) {
        surfaceIssues.push({
          code: "axis-sum",
          surfaceId,
          outputId: String(output?.id ?? ""),
          message: `${output?.id ?? "Output"} ${leadingEdge}+${trailingEdge} ramps must leave at least one unblended output pixel`,
        });
      }
    }
    const first = analysis.assigned[0];
    const last = analysis.assigned.at(-1);
    if (first && exactOverlapVector(first.overlap)[leadingEdge] > 0) {
      surfaceIssues.push({
        code: "orphan-leading-edge",
        surfaceId,
        outputId: String(first.id),
        message: `${first.id} ${leadingEdge.toUpperCase()} is an orphan ramp with no neighbour`,
      });
    }
    if (last && exactOverlapVector(last.overlap)[trailingEdge] > 0) {
      surfaceIssues.push({
        code: "orphan-trailing-edge",
        surfaceId,
        outputId: String(last.id),
        message: `${last.id} ${trailingEdge.toUpperCase()} is an orphan ramp with no neighbour`,
      });
    }
    for (const seam of analysis.seams) {
      if (seam.fromPixels !== seam.toPixels) {
        surfaceIssues.push({
          code: "reciprocal-mismatch",
          surfaceId,
          outputId: seam.fromId,
          message: `${seam.fromId} ${seam.fromEdge.toUpperCase()} ${seam.fromPixels}px does not match ${seam.toId} ${seam.toEdge.toUpperCase()} ${seam.toPixels}px`,
        });
      }
      if (seam.expectedPixels != null && (seam.fromPixels !== seam.expectedPixels || seam.toPixels !== seam.expectedPixels)) {
        const geometryLabel = seam.sourceIntersectionPixels > 0
          ? `${seam.sourceIntersectionPixels}px source intersection maps to ${seam.expectedPixels}px output ramp`
          : "the source crops have a gap or only touch";
        surfaceIssues.push({
          code: seam.expectedPixels === 0 ? "gap-ramp" : "intersection-mismatch",
          surfaceId,
          outputId: seam.fromId,
          message: `${seam.fromId} ↔ ${seam.toId}: ${geometryLabel}; both reciprocal ramps must be ${seam.expectedPixels}px`,
        });
      }
    }
    const seams = analysis.seams.map((seam) => ({
      ...seam,
      valid: seam.expectedPixels != null
        && seam.fromPixels === seam.toPixels
        && seam.fromPixels === seam.expectedPixels
        && analysis.issues.length === 0,
    }));
    details.push({ surfaceId, layout: resolved.layout, inferred: resolved.inferred, outputs: analysis.assigned, seams, issues: surfaceIssues });
    issues.push(...surfaceIssues);
  }
  return { valid: issues.length === 0, issues, surfaces: details };
}

function adjacentOutputIds(outputs, surfaceId, layout, activeId) {
  const ordered = orderedSurfaceOutputs(outputs, surfaceId, layout);
  const index = ordered.findIndex((output) => String(output?.id) === String(activeId));
  return {
    leading: index > 0 ? String(ordered[index - 1].id) : null,
    trailing: index >= 0 && index < ordered.length - 1 ? String(ordered[index + 1].id) : null,
  };
}

/**
 * Move the active output, clear only the seams that touched it on the old
 * surface, then rebuild its immediate left/right seams on the target surface.
 * Newly adjacent old neighbours remain at zero until an operator measures that
 * seam; inventing an overlap there could dim visible show content.
 */
export function rebuildPhysicalSurfaceSeams(outputs, {
  activeId,
  targetSurfaceId,
  targetLayout,
  surfaces,
  overlap,
  sourceViewport,
}) {
  const topology = Array.isArray(outputs) ? outputs : [];
  const activeIndex = topology.findIndex((output) => String(output?.id) === String(activeId));
  if (activeIndex < 0) throw new Error(`Active output ${activeId} is missing from the surface topology`);
  const targetId = String(targetSurfaceId ?? "");
  if (!targetId) throw new Error("Target surface ID is required");
  const nextLayout = canonicalSurfaceLayout(targetLayout);
  const requestedOverlap = exactOverlapVector(overlap);
  const active = topology[activeIndex];
  const originalSurfaceId = String(active?.wallId ?? targetId);
  const catalog = Array.isArray(surfaces) ? surfaces : [];
  const targetSurface = catalog.find((surface) => String(surface?.id) === targetId) ?? { id: targetId };
  const previousTargetLayout = resolvePhysicalSurfaceLayout(targetSurface, topology).layout;
  const layoutChanged = previousTargetLayout !== nextLayout;
  const selectedTopology = topology.map((output, index) => index === activeIndex ? {
    ...output,
    wallId: targetId,
    sourceViewport: { ...sourceViewport },
  } : output);
  const clearById = new Map(selectedTopology.map((output) => [String(output.id), exactOverlapVector(output.overlap)]));
  clearById.set(String(activeId), { ...ZERO_OVERLAP });

  // Clear only the reciprocal neighbours that touched the active output on its
  // old surface. Ambiguous legacy layouts are cleared on both possible axes.
  // Check both axes even when the committed mode says Independent or the wrong
  // axis. This is the cleanup boundary for stale/legacy edge vectors.
  for (const layout of ["horizontal", "vertical"]) {
    const oldNeighbours = adjacentOutputIds(topology, originalSurfaceId, layout, activeId);
    if (oldNeighbours.leading && clearById.has(oldNeighbours.leading)) {
      clearById.get(oldNeighbours.leading)[layout === "horizontal" ? "right" : "bottom"] = 0;
    }
    if (oldNeighbours.trailing && clearById.has(oldNeighbours.trailing)) {
      clearById.get(oldNeighbours.trailing)[layout === "horizontal" ? "left" : "top"] = 0;
    }
  }

  // A mode change is atomic. No edge from the old axis may survive. Independent
  // surfaces are always normalized completely to zero.
  if (layoutChanged || nextLayout === "independent") {
    for (const output of selectedTopology) {
      if (String(output?.wallId ?? "") === targetId) clearById.set(String(output.id), { ...ZERO_OVERLAP });
    }
  }
  if (nextLayout === "independent") {
    return selectedTopology.map((output) => ({ ...output, overlap: { ...clearById.get(String(output.id)) } }));
  }

  const leadingEdge = nextLayout === "horizontal" ? "left" : "top";
  const trailingEdge = nextLayout === "horizontal" ? "right" : "bottom";
  if (layoutChanged) {
    const analysis = axisSurfaceAnalysis(targetId, nextLayout, selectedTopology);
    if (analysis.assigned.length < 2) {
      throw new Error(`${targetId} needs at least two outputs for a ${nextLayout} layout`);
    }
    if (analysis.issues.length > 0) throw new Error(analysis.issues[0].message);
    for (const seam of analysis.seams) {
      if (seam.expectedPixels == null) throw new Error(`${seam.fromId} ↔ ${seam.toId} overlap cannot be represented safely`);
      clearById.get(seam.fromId)[seam.fromEdge] = seam.expectedPixels;
      clearById.get(seam.toId)[seam.toEdge] = seam.expectedPixels;
    }
  } else {
    const analysis = axisSurfaceAnalysis(targetId, nextLayout, selectedTopology);
    if (analysis.issues.length > 0) throw new Error(analysis.issues[0].message);
    const neighbours = adjacentOutputIds(selectedTopology, targetId, nextLayout, activeId);
    const activeOverlap = { ...ZERO_OVERLAP };
    activeOverlap[leadingEdge] = requestedOverlap[leadingEdge];
    activeOverlap[trailingEdge] = requestedOverlap[trailingEdge];
    clearById.set(String(activeId), activeOverlap);
    if (neighbours.leading) clearById.get(neighbours.leading)[trailingEdge] = requestedOverlap[leadingEdge];
    if (neighbours.trailing) clearById.get(neighbours.trailing)[leadingEdge] = requestedOverlap[trailingEdge];
  }
  return selectedTopology.map((output) => ({ ...output, overlap: { ...clearById.get(String(output.id)) } }));
}

/**
 * Spatial edits are mutations, never topology reconciliation. Keep every
 * authoritative output and update only the selected output plus intentional
 * seam neighbours. A capability-only output may still be appended explicitly.
 */
export function mergeAuthoritativeOutputs(outputs, activeId, updateOutput, activeFallback) {
  const authoritative = Array.isArray(outputs) ? outputs : [];
  if (authoritative.some((output) => String(output?.id) === String(activeId))) {
    return authoritative.map(updateOutput);
  }
  return [...authoritative, updateOutput(activeFallback)];
}

/**
 * Evaluate the complete receipt for a Server project save. A command ACK alone
 * is insufficient: the Node store and native renderer must both report the
 * exact revision, and the renderer must prove that its correction binding is
 * current before Web Control may call the mapping LIVE.
 */
export function projectSyncReadiness(state, syncTargets, projectRevision) {
  const targets = Array.isArray(syncTargets) ? syncTargets : [];
  const revision = finiteInteger(projectRevision);
  const nodes = nodeValues(state?.nodes);

  const details = targets.map((target) => {
    const nodeId = String(target?.nodeId ?? "");
    const requiredSequence = finiteInteger(target?.commandSequence);
    const node = nodes.find((candidate) => nodeIdentifier(candidate) === nodeId);
    const reasons = [];

    if (!node) {
      reasons.push("node is not registered");
      return { nodeId, ready: false, reasons };
    }

    const nodeStatus = String(node.status ?? "").toLowerCase();
    if (["offline", "error", "degraded"].includes(nodeStatus)) {
      reasons.push(`node status is ${nodeStatus || "unknown"}`);
    }
    const ackSequence = finiteInteger(node.ackSequence);
    if (requiredSequence == null || ackSequence == null || ackSequence < requiredSequence) {
      reasons.push(`command acknowledgement is ${ackSequence ?? "missing"}/${requiredSequence ?? "invalid"}`);
    }

    const telemetry = node.telemetry && typeof node.telemetry === "object" ? node.telemetry : {};
    const nodeRevision = finiteInteger(telemetry.projectRevision);
    if (revision == null || nodeRevision !== revision) {
      reasons.push(`Node revision is ${nodeRevision ?? "missing"}, expected ${revision ?? "invalid"}`);
    }

    const renderer = telemetry.renderer && typeof telemetry.renderer === "object" ? telemetry.renderer : {};
    const rendererRevision = finiteInteger(renderer.projectRevision);
    if (revision == null || rendererRevision !== revision) {
      reasons.push(`renderer revision is ${rendererRevision ?? "missing"}, expected ${revision ?? "invalid"}`);
    }
    if (renderer.connected !== true) reasons.push("renderer is not connected");
    if (renderer.ready !== true) reasons.push("renderer is not ready");
    if (renderer.correctionBindingMatches !== true) reasons.push("renderer correction binding is not verified");

    return { nodeId, ready: reasons.length === 0, reasons };
  });

  const pendingNodeIds = details.filter((detail) => !detail.ready).map((detail) => detail.nodeId);
  return {
    live: targets.length > 0 && pendingNodeIds.length === 0,
    pendingNodeIds,
    details,
    reason: targets.length === 0 ? "No renderer sync target was queued" : null,
  };
}
