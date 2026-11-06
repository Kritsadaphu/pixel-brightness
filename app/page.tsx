"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CameraCalibrationPanel } from "./components/camera-calibration-panel";
import { UvcGeometryPanel } from "./components/uvc-geometry-panel";
import { NdiVideoPanel } from "./components/ndi-video-panel";
import { FleetNodePanel } from "./components/fleet-node-panel";
import type { MarkerlessCalibrationSetup } from "./components/markerless-camera-setup";
import { ProjectorControlPanel } from "./components/projector-control-panel";
import { ShowSchedulePanel } from "./components/show-schedule-panel";
import { usePixelServer } from "./hooks/use-pixel-server";
import {
  catalogProjectSurfaces,
  createPhysicalSurface,
  exactOverlapVector,
  mergeAuthoritativeOutputs,
  rebuildPhysicalSurfaceSeams,
  renamePhysicalSurface,
  resolvePhysicalSurfaceLayout,
  setPhysicalSurfaceLayout,
  validatePhysicalSurfaceTopology,
} from "./lib/project-save.mjs";
import type {
  PixelCameraManualSettings,
  PixelNode,
  PixelOutput,
  PixelPhysicalSurface,
  PixelProject,
  PixelSurfaceLayout,
} from "./lib/pixel-server";

type NavKey = "map" | "inputs" | "calibrate" | "projectors" | "schedule" | "fleet";
type Corner = { x: number; y: number };
type MeshPoint = { u: number; v: number; x: number; y: number };
type MeshDrag = { index: number; anchor: MeshPoint; points: MeshPoint[] };
type RecordValue = Record<string, unknown>;
type SpatialSaveStatus = "idle" | "queued" | "live" | "not-live" | "draft";
type PhysicalSurface = PixelPhysicalSurface & { name: string };
type SurfaceLayoutDraft = PixelSurfaceLayout | "";
type OverlapVector = { left: number; right: number; top: number; bottom: number };

type CompositionSource = {
  type: "spout";
  senderName: string;
  width: number;
  height: number;
  frameRateNum: number;
  frameRateDen: number;
  acceptedFormats: string[];
  colorEncoding: "srgb" | "linear";
  alphaMode: "ignore";
  timeoutMs: number;
  startupGraceMs: number;
  onMissing: "black";
  onMismatch: "black";
  allowAutoSelect: false;
};

type UiOutput = {
  id: string;
  name: string;
  port: string;
  wall: string;
  status: string;
  temp: string;
  nodeId?: string;
  width: number;
  height: number;
  refresh: number;
  raw?: PixelOutput;
};

const fallbackOutputs = [
  { id: "A", name: "Projector A", port: "DXGI · UNBOUND", wall: "Main surface", status: "draft", temp: "—" },
  { id: "B", name: "Projector B", port: "DXGI · UNBOUND", wall: "Main surface", status: "draft", temp: "—" },
];

const defaultSurface: PhysicalSurface = { id: "surface-main", name: "Main surface", layout: "independent" };
const zeroOverlap: OverlapVector = { left: 0, right: 0, top: 0, bottom: 0 };

const defaultCorners: Corner[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

const defaultSource: CompositionSource = {
  type: "spout",
  senderName: "PB-COMPOSITION",
  width: 3600,
  height: 1080,
  frameRateNum: 60,
  frameRateDen: 1,
  acceptedFormats: [
    "DXGI_FORMAT_R16G16B16A16_FLOAT",
    "DXGI_FORMAT_R8G8B8A8_UNORM",
    "DXGI_FORMAT_B8G8R8A8_UNORM",
  ],
  colorEncoding: "srgb",
  alphaMode: "ignore",
  timeoutMs: 500,
  startupGraceMs: 10_000,
  onMissing: "black",
  onMismatch: "black",
  allowAutoSelect: false,
};

function values<T>(input: T[] | Record<string, T> | undefined): T[] {
  if (Array.isArray(input)) return input;
  return input ? Object.values(input) : [];
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compositionSourceIsConnected(value: unknown) {
  const source = record(value);
  const state = String(source.state ?? source.status ?? "").toLowerCase();
  return source.connected === true || state === "connected" || state === "receiving";
}

function rendererRuntimeIsLive(node: PixelNode, outputId?: string) {
  const nodeStatus = String(node.status ?? "").toLowerCase();
  if (["offline", "error", "degraded"].includes(nodeStatus)) return false;
  const renderer = record(node.telemetry?.renderer);
  if (renderer.connected !== true || renderer.ready !== true || !compositionSourceIsConnected(renderer.compositionSource)) return false;
  const outputTelemetry = Array.isArray(node.telemetry?.outputs) ? node.telemetry.outputs.map(record) : [];
  if (outputTelemetry.length === 0) return false;
  if (!outputId) {
    return outputTelemetry.every((output) => !["offline", "error", "degraded"].includes(String(output.state ?? "").toLowerCase()));
  }
  const output = outputTelemetry.find((candidate) => String(candidate.id) === outputId);
  return Boolean(output) && !["offline", "error", "degraded"].includes(String(output?.state ?? "").toLowerCase());
}

function formatClockNs(value: unknown) {
  if (value == null || value === "") return "—";
  const milliseconds = Number(value) / 1_000_000;
  if (!Number.isFinite(milliseconds)) return "—";
  return `${milliseconds >= 0 ? "+" : ""}${milliseconds.toFixed(2)} ms`;
}

function sourceFromProject(project: PixelProject | undefined): CompositionSource {
  const input = record(project?.compositionSource);
  if (input.type !== "spout") return defaultSource;
  return {
    ...defaultSource,
    ...input,
    type: "spout",
    senderName: String(input.senderName || defaultSource.senderName),
    width: Math.max(64, finiteNumber(input.width, defaultSource.width)),
    height: Math.max(64, finiteNumber(input.height, defaultSource.height)),
    frameRateNum: Math.max(1, finiteNumber(input.frameRateNum, defaultSource.frameRateNum)),
    frameRateDen: Math.max(1, finiteNumber(input.frameRateDen, defaultSource.frameRateDen)),
    acceptedFormats: Array.isArray(input.acceptedFormats) ? input.acceptedFormats.map(String) : defaultSource.acceptedFormats,
    colorEncoding: input.colorEncoding === "linear" ? "linear" : "srgb",
    alphaMode: "ignore",
    onMissing: "black",
    onMismatch: "black",
    allowAutoSelect: false,
  };
}

function gridDimensions(value: string) {
  const [columns, rows] = value.split("×").map((item) => Math.max(2, Math.min(128, Number.parseInt(item.trim(), 10) || 2)));
  return { columns, rows };
}

function meshFromCorners(corners: Corner[], columns: number, rows: number): MeshPoint[] {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  const points = [];
  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const topX = topLeft.x + (topRight.x - topLeft.x) * u;
      const topY = topLeft.y + (topRight.y - topLeft.y) * u;
      const bottomX = bottomLeft.x + (bottomRight.x - bottomLeft.x) * u;
      const bottomY = bottomLeft.y + (bottomRight.y - bottomLeft.y) * u;
      points.push({ u, v, x: (topX + (bottomX - topX) * v) / 100, y: (topY + (bottomY - topY) * v) / 100 });
    }
  }
  return points;
}

function sampleMeshPoint(points: MeshPoint[], columns: number, rows: number, u: number, v: number): MeshPoint {
  const gridX = Math.max(0, Math.min(columns, u * columns));
  const gridY = Math.max(0, Math.min(rows, v * rows));
  const left = Math.min(columns - 1, Math.floor(gridX));
  const top = Math.min(rows - 1, Math.floor(gridY));
  const right = Math.min(columns, left + 1);
  const bottom = Math.min(rows, top + 1);
  const tx = gridX - left;
  const ty = gridY - top;
  const at = (column: number, row: number) => points[row * (columns + 1) + column];
  const topLeft = at(left, top);
  const topRight = at(right, top);
  const bottomLeft = at(left, bottom);
  const bottomRight = at(right, bottom);
  const interpolate = (field: "x" | "y") => {
    const upper = topLeft[field] + (topRight[field] - topLeft[field]) * tx;
    const lower = bottomLeft[field] + (bottomRight[field] - bottomLeft[field]) * tx;
    return upper + (lower - upper) * ty;
  };
  return { u, v, x: interpolate("x"), y: interpolate("y") };
}

function resampleMesh(points: MeshPoint[], oldColumns: number, oldRows: number, columns: number, rows: number) {
  const expected = (oldColumns + 1) * (oldRows + 1);
  const source = points.length === expected ? points : meshFromCorners(defaultCorners, oldColumns, oldRows);
  const result: MeshPoint[] = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      result.push(sampleMeshPoint(source, oldColumns, oldRows, column / columns, row / rows));
    }
  }
  return result;
}

function sampledAxis(segments: number, maximumSegments = 8) {
  const samples = Math.min(segments, maximumSegments);
  return Array.from(new Set(Array.from({ length: samples + 1 }, (_, index) => Math.round(index * segments / samples))));
}

function meshBoundary(points: MeshPoint[], columns: number, rows: number) {
  if (points.length !== (columns + 1) * (rows + 1)) return "0% 0%, 100% 0%, 100% 100%, 0% 100%";
  const boundary: MeshPoint[] = [];
  for (let column = 0; column <= columns; column += 1) boundary.push(points[column]);
  for (let row = 1; row <= rows; row += 1) boundary.push(points[row * (columns + 1) + columns]);
  for (let column = columns - 1; column >= 0; column -= 1) boundary.push(points[rows * (columns + 1) + column]);
  for (let row = rows - 1; row > 0; row -= 1) boundary.push(points[row * (columns + 1)]);
  return boundary.map((point) => `${point.x * 100}% ${point.y * 100}%`).join(", ");
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)} aria-pressed={checked} aria-label={label}><span /></button>;
}

export default function Home() {
  const server = usePixelServer();
  const [nav, setNav] = useState<NavKey>("map");
  const [projector, setProjector] = useState("A");
  const [overlap, setOverlap] = useState<OverlapVector>(zeroOverlap);
  const [feather, setFeather] = useState(78);
  const [blendGamma, setBlendGamma] = useState(2.2);
  const [blackLevel, setBlackLevel] = useState(0);
  const [grid, setGrid] = useState("32 × 18");
  const [mask, setMask] = useState(false);
  const [blend, setBlend] = useState(true);
  const [patternOutputId, setPatternOutputId] = useState<string | null>(null);
  const [bypass, setBypass] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SpatialSaveStatus>("idle");
  const [surfaceId, setSurfaceId] = useState(defaultSurface.id);
  const [surfaceCatalog, setSurfaceCatalog] = useState<PhysicalSurface[]>([defaultSurface]);
  const [committedSurfaceCatalog, setCommittedSurfaceCatalog] = useState<PhysicalSurface[]>([defaultSurface]);
  const [surfaceLayoutDraft, setSurfaceLayoutDraft] = useState<SurfaceLayoutDraft>("independent");
  const [surfaceNameDraft, setSurfaceNameDraft] = useState(defaultSurface.name);
  const [newSurfaceId, setNewSurfaceId] = useState("");
  const [newSurfaceName, setNewSurfaceName] = useState("");
  const [meshPoints, setMeshPoints] = useState<MeshPoint[]>(() => meshFromCorners(defaultCorners, 32, 18));
  const [meshBrush, setMeshBrush] = useState(12);
  const [dragging, setDragging] = useState<number | null>(null);
  const [sourceX, setSourceX] = useState(0);
  const [sourceY, setSourceY] = useState(0);
  const [sourceWidth, setSourceWidth] = useState(1920);
  const [sourceHeight, setSourceHeight] = useState(1080);
  const [gain, setGain] = useState([1, 1, 1]);
  const [gamma, setGamma] = useState([1, 1, 1]);
  const [senderName, setSenderName] = useState(defaultSource.senderName);
  const [compositionWidth, setCompositionWidth] = useState(defaultSource.width);
  const [compositionHeight, setCompositionHeight] = useState(defaultSource.height);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const hydratedOutput = useRef("");
  const hydratedSource = useRef("");
  const hydratedSurfaces = useRef("");
  const meshDrag = useRef<MeshDrag | null>(null);

  const liveNodes = useMemo(() => values(server.state?.nodes), [server.state?.nodes]);
  const liveOutputs = useMemo<UiOutput[]>(() => {
    const projectOutputs = server.state?.project?.outputs ?? [];
    const nodeOutputs = liveNodes.flatMap((node) => {
      const nodeId = node.nodeId ?? node.id ?? "node";
      return (node.outputs ?? node.capabilities?.outputs ?? []).map((output) => ({ output, node, nodeId }));
    });
    const source = projectOutputs.length > 0 ? projectOutputs.map((output) => {
      const expectedNodeId = output.nodeId ? String(output.nodeId) : undefined;
      // Output ids/connectors may repeat across render nodes. A project binding
      // that names a node must never be reassigned to the first matching port on
      // a different machine. Legacy unassigned outputs are accepted only when
      // the match is unique across the whole fleet.
      const candidates = expectedNodeId
        ? nodeOutputs.filter((candidate) => candidate.nodeId === expectedNodeId)
        : nodeOutputs;
      const idMatches = candidates.filter(({ output: candidate }) => String(candidate.id) === String(output.id));
      const connectorMatches = candidates.filter(({ output: candidate }) => (
        output.connector != null && String(candidate.connector) === String(output.connector)
      ));
      const matches = idMatches.length > 0 ? idMatches : connectorMatches;
      const assignment = matches.length === 1 ? matches[0] : undefined;
      const assignedNodeId = expectedNodeId ?? assignment?.nodeId;
      const assignedNode = assignment?.node ?? liveNodes.find((candidate) => (candidate.nodeId ?? candidate.id) === assignedNodeId);
      return { output: assignment ? { ...output, ...assignment.output } : output, node: assignedNode, nodeId: assignedNodeId };
    }).filter(({ nodeId, node }) => liveNodes.length === 0 || Boolean(nodeId) || Boolean(node)) : nodeOutputs;
    return source.map(({ output, node, nodeId }, index) => {
      const wallName = server.state?.project?.walls?.find((wall) => wall.id === output.wallId)?.name ?? output.wallId ?? "Unassigned";
      const refreshNum = finiteNumber(output.resolution?.refreshNum, 60);
      const refreshDen = Math.max(1, finiteNumber(output.resolution?.refreshDen, 1));
      const display = record(output.display);
      return {
        id: String(output.id ?? index + 1),
        name: output.name || `Projector ${output.id ?? index + 1}`,
        port: String(display.gdiName ?? display.devicePath ?? output.connector ?? `DISPLAY-${index + 1}`),
        wall: String(wallName),
        status: server.connected ? (node?.status ?? (node ? "online" : "unassigned")) : "offline",
        temp: node?.telemetry?.temperatureC == null ? "—" : `${Math.round(node.telemetry.temperatureC)}°`,
        nodeId,
        width: finiteNumber(output.resolution?.width, 1920),
        height: finiteNumber(output.resolution?.height, 1080),
        refresh: refreshNum / refreshDen,
        raw: output,
      };
    });
  }, [liveNodes, server.connected, server.state?.project]);

  const outputs = useMemo<UiOutput[]>(() => server.connected
    ? liveOutputs
    : fallbackOutputs.map((item) => ({ ...item, nodeId: "windows-preview", width: 1920, height: 1080, refresh: 60 })), [liveOutputs, server.connected]);
  const active = outputs.find((item) => item.id === projector) ?? outputs[0] ?? { ...fallbackOutputs[0], nodeId: "unassigned", width: 1920, height: 1080, refresh: 60 };
  const pattern = patternOutputId === active.id;
  const surfaceOptions = surfaceCatalog;
  const activeSurfaceName = surfaceCatalog.find((surface) => surface.id === surfaceId)?.name ?? surfaceId;
  const inferredSurfaceCount = surfaceCatalog.filter((surface) => !Object.prototype.hasOwnProperty.call(surface, "layout")).length;
  const authoritativeTopologyOutputs = useMemo<PixelOutput[]>(() => (server.state?.project?.outputs?.length ?? 0) > 0
    ? server.state?.project?.outputs ?? []
    : outputs.map((output, index) => output.raw ?? {
      id: output.id,
      name: output.name,
      connector: output.port,
      wallId: defaultSurface.id,
      resolution: { width: output.width, height: output.height, refreshNum: Math.round(output.refresh), refreshDen: 1 },
      sourceViewport: { x: index * 1680, y: 0, width: output.width, height: output.height },
      overlap: { ...zeroOverlap },
    }), [outputs, server.state?.project?.outputs]);
  const selectedSurface = surfaceCatalog.find((surface) => surface.id === surfaceId);
  const committedSelectedSurface = committedSurfaceCatalog.find((surface) => surface.id === surfaceId) ?? { id: surfaceId, name: surfaceId };
  const selectedCommittedLayout = selectedSurface
    ? resolvePhysicalSurfaceLayout(committedSelectedSurface, authoritativeTopologyOutputs).layout as PixelSurfaceLayout | null
    : null;
  const layoutModeChanged = Boolean(surfaceLayoutDraft && selectedCommittedLayout !== surfaceLayoutDraft);
  const candidateSurfaceCatalog = useMemo(() => {
    if (!surfaceLayoutDraft || !surfaceCatalog.some((surface) => surface.id === surfaceId)) return surfaceCatalog;
    return setPhysicalSurfaceLayout(surfaceCatalog, surfaceId, surfaceLayoutDraft) as PhysicalSurface[];
  }, [surfaceCatalog, surfaceId, surfaceLayoutDraft]);
  const draftTopology = useMemo(() => {
    const activeFallback: PixelOutput = active.raw ?? {
      id: active.id,
      name: active.name,
      connector: active.port,
      resolution: { width: active.width, height: active.height, refreshNum: Math.round(active.refresh), refreshDen: 1 },
      sourceViewport: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      overlap: { ...zeroOverlap },
    };
    const topology = authoritativeTopologyOutputs.some((output) => String(output.id) === active.id)
      ? authoritativeTopologyOutputs
      : [...authoritativeTopologyOutputs, activeFallback];
    const attemptedTopology = topology.map((output) => String(output.id) === active.id ? {
      ...output,
      wallId: surfaceId,
      sourceViewport: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      overlap: { ...zeroOverlap },
    } : output);
    if (!surfaceLayoutDraft) {
      return {
        outputs: attemptedTopology,
        validation: {
          valid: false,
          issues: [{ code: "layout-required", surfaceId, message: `${surfaceId} needs an explicit layout choice before Save/LIVE` }],
          surfaces: [],
        },
        error: `${surfaceId} needs an explicit layout choice`,
      };
    }
    try {
      const rebuilt = rebuildPhysicalSurfaceSeams(topology, {
        activeId: active.id,
        targetSurfaceId: surfaceId,
        targetLayout: surfaceLayoutDraft,
        // This must remain the authoritative pre-edit catalog so mode changes
        // atomically clear the old axis before candidate walls are persisted.
        surfaces: committedSurfaceCatalog,
        overlap,
        sourceViewport: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      }) as PixelOutput[];
      return {
        outputs: rebuilt,
        validation: validatePhysicalSurfaceTopology(candidateSurfaceCatalog, rebuilt),
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Surface topology could not be rebuilt safely";
      return {
        outputs: attemptedTopology,
        validation: {
          valid: false,
          issues: [{ code: "rebuild-rejected", surfaceId, message }],
          surfaces: [],
        },
        error: message,
      };
    }
  }, [active.id, active.name, active.port, active.raw, active.refresh, active.height, active.width, authoritativeTopologyOutputs, candidateSurfaceCatalog, committedSurfaceCatalog, overlap, sourceHeight, sourceWidth, sourceX, sourceY, surfaceId, surfaceLayoutDraft]);
  const activeDraftOutput = draftTopology.outputs.find((output) => String(output.id) === active.id);
  const activeDraftOverlap = exactOverlapVector(activeDraftOutput?.overlap) as OverlapVector;
  const displayedOverlap = layoutModeChanged ? activeDraftOverlap : overlap;
  const overlapEdgeState: Array<{ edge: keyof OverlapVector; active: boolean }> = [
    { edge: "left", active: surfaceLayoutDraft === "horizontal" },
    { edge: "right", active: surfaceLayoutDraft === "horizontal" },
    { edge: "top", active: surfaceLayoutDraft === "vertical" },
    { edge: "bottom", active: surfaceLayoutDraft === "vertical" },
  ];
  const topologyIsSafe = inferredSurfaceCount === 0 && draftTopology.validation.valid;
  const topologyIssueSummary = inferredSurfaceCount > 0
    ? `${inferredSurfaceCount} legacy surface layout(s) still need explicit operator confirmation`
    : draftTopology.validation.issues.slice(0, 3).map((issue) => issue.message).join(" · ");
  const surfaceOutputCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const output of draftTopology.outputs) {
      const assignedSurfaceId = String(output.wallId ?? "");
      if (assignedSurfaceId) counts.set(assignedSurfaceId, (counts.get(assignedSurfaceId) ?? 0) + 1);
    }
    if (!server.connected && !counts.has(surfaceId)) counts.set(surfaceId, 1);
    return counts;
  }, [draftTopology.outputs, server.connected, surfaceId]);
  const surfaceOverviewGroups = useMemo(() => candidateSurfaceCatalog.map((surface) => {
    const detail = draftTopology.validation.surfaces.find((item) => item.surfaceId === surface.id);
    const rawOutputs: PixelOutput[] = detail?.outputs ?? draftTopology.outputs.filter((output) => String(output.wallId ?? "") === surface.id);
    const groupedOutputs: UiOutput[] = rawOutputs.map((raw) => {
      const live = outputs.find((output) => output.id === String(raw.id));
      const refreshNum = finiteNumber(raw.resolution?.refreshNum, 60);
      const refreshDen = Math.max(1, finiteNumber(raw.resolution?.refreshDen, 1));
      return live ? { ...live, raw } : {
        id: String(raw.id),
        name: raw.name ?? `Output ${raw.id}`,
        port: String(raw.connector ?? "AUTHORITATIVE"),
        wall: surface.name,
        status: "authoritative",
        temp: "—",
        width: finiteNumber(raw.resolution?.width, 1920),
        height: finiteNumber(raw.resolution?.height, 1080),
        refresh: refreshNum / refreshDen,
        raw,
      };
    });
    const inferred = resolvePhysicalSurfaceLayout(surface, draftTopology.outputs);
    return {
      surface,
      layout: detail?.layout ?? inferred.layout,
      inferred: inferred.inferred,
      outputs: groupedOutputs,
      seams: detail?.seams ?? [],
      issues: detail?.issues ?? draftTopology.validation.issues.filter((issue) => issue.surfaceId === surface.id),
    };
  }).filter((group) => group.outputs.length > 0), [candidateSurfaceCatalog, draftTopology.outputs, draftTopology.validation.issues, draftTopology.validation.surfaces, outputs]);
  const composition = sourceFromProject(server.state?.project);
  const fps = finiteNumber(server.state?.project?.canvas?.frameRateNum ?? composition.frameRateNum, 60) / Math.max(1, finiteNumber(server.state?.project?.canvas?.frameRateDen ?? composition.frameRateDen, 1));
  const currentFrame = Math.max(0, ...liveNodes.map((node) => finiteNumber(node.telemetry?.currentFrame)));
  const droppedFrames = liveNodes.reduce((sum, node) => sum + finiteNumber(node.telemetry?.droppedFrames), 0);
  const clockOffsets = liveNodes.map((node) => node.telemetry?.clockOffsetNs).filter((value): value is string | number => value != null);
  const clockOffsetNs = clockOffsets.length ? clockOffsets.reduce<number>((sum, value) => sum + finiteNumber(value), 0) / clockOffsets.length : undefined;
  const sourceTelemetry = liveNodes.map((node) => record(record(node.telemetry?.renderer).compositionSource));
  const sourceConnected = sourceTelemetry.some(compositionSourceIsConnected);
  const activeOutputNodeId = String(active.nodeId ?? active.raw?.nodeId ?? "");
  const activeRuntimeLive = topologyIsSafe && liveNodes.some((node) => (node.nodeId ?? node.id) === activeOutputNodeId && rendererRuntimeIsLive(node, active.id));
  const runtimeOutputsLive = topologyIsSafe && liveNodes.length > 0 && liveNodes.every((node) => rendererRuntimeIsLive(node));
  const cameraReady = liveNodes.some((node) => { const camera = record(node.telemetry?.camera); return camera.connected === true && camera.remoteCapture === true; });
  const cameraCalibration = server.state?.cameraCalibration;
  const cameraCalibrationState = String(cameraCalibration?.state || "idle");
  const cameraCalibrationRunning = Boolean(cameraCalibration?.sessionId)
    && !["complete", "failed", "cancelled"].includes(cameraCalibrationState);
  const activeNodeIsLive = liveNodes.some((node) => (node.nodeId ?? node.id) === activeOutputNodeId);
  const calibrationNodeId = activeNodeIsLive
    ? activeOutputNodeId
    : liveNodes.length === 1 ? (liveNodes[0].nodeId ?? liveNodes[0].id) : undefined;
  const calibrationNode = liveNodes.find((node) => (node.nodeId ?? node.id) === calibrationNodeId);
  const calibrationCapabilityKeys = new Set((calibrationNode?.outputs ?? calibrationNode?.capabilities?.outputs ?? [])
    .flatMap((output) => [output.id, output.connector]).filter((value): value is string => Boolean(value)).map(String));
  const calibrationWallId = String(active.raw?.wallId ?? "");
  const calibrationOutputIds = calibrationNodeId
    ? outputs.filter((output) => {
      const assignedNodeId = output.nodeId ?? output.raw?.nodeId;
      const capabilityMatch = calibrationCapabilityKeys.has(output.id)
        || calibrationCapabilityKeys.has(String(output.raw?.connector ?? output.port));
      const sameCameraView = !calibrationWallId || String(output.raw?.wallId ?? "") === calibrationWallId;
      return capabilityMatch && sameCameraView && (!assignedNodeId || assignedNodeId === calibrationNodeId);
    }).map((output) => output.id)
    : [];
  const rawOutputWidth = outputs.reduce((sum, output) => sum + output.width, 0);
  const canvasWidth = finiteNumber(server.state?.project?.canvas?.width, compositionWidth);
  const canvasHeight = finiteNumber(server.state?.project?.canvas?.height, compositionHeight);
  const meshSize = useMemo(() => gridDimensions(grid), [grid]);
  const polygon = useMemo(
    () => meshBoundary(meshPoints, meshSize.columns, meshSize.rows),
    [meshPoints, meshSize.columns, meshSize.rows],
  );
  const meshDisplay = useMemo(() => {
    const columns = sampledAxis(meshSize.columns);
    const rows = sampledAxis(meshSize.rows);
    const at = (column: number, row: number) => meshPoints[row * (meshSize.columns + 1) + column];
    const rowLines = rows.map((row) => columns.map((column) => at(column, row)).filter(Boolean));
    const columnLines = columns.map((column) => rows.map((row) => at(column, row)).filter(Boolean));
    const handles = rows.flatMap((row) => columns.map((column) => ({
      point: at(column, row),
      index: row * (meshSize.columns + 1) + column,
      corner: (row === 0 || row === meshSize.rows) && (column === 0 || column === meshSize.columns),
    }))).filter((item) => item.point);
    return { rowLines, columnLines, handles };
  }, [meshPoints, meshSize.columns, meshSize.rows]);

  useEffect(() => {
    const cached = window.localStorage.getItem("pixel-brightness-spatial-config");
    if (!cached) return;
    try {
      const config = JSON.parse(cached);
      window.queueMicrotask(() => {
        if (config.overlap && typeof config.overlap === "object") {
          setOverlap(exactOverlapVector(config.overlap) as OverlapVector);
        } else if (typeof config.overlap === "number") {
          setOverlap({ left: config.overlap, right: config.overlap, top: 0, bottom: 0 });
        }
        if (typeof config.feather === "number") setFeather(config.feather);
        if (typeof config.blackLevel === "number") setBlackLevel(config.blackLevel);
        if (typeof config.senderName === "string") setSenderName(config.senderName);
        if (typeof config.bypass === "boolean") setBypass(config.bypass);
        if (typeof config.surfaceId === "string" && config.surfaceId.trim()) setSurfaceId(config.surfaceId);
        if (Array.isArray(config.surfaceCatalog)) {
          const cachedSurfaces = catalogProjectSurfaces(config.surfaceCatalog, [], defaultSurface) as PhysicalSurface[];
          setSurfaceCatalog(cachedSurfaces);
          setCommittedSurfaceCatalog(cachedSurfaces);
        }
        if (typeof config.grid === "string" && Array.isArray(config.meshPoints)) {
          const cachedSize = gridDimensions(config.grid);
          if (config.meshPoints.length === (cachedSize.columns + 1) * (cachedSize.rows + 1)) {
            setGrid(config.grid);
            setMeshPoints(config.meshPoints);
          }
        } else if (Array.isArray(config.corners) && config.corners.length === 4) {
          setMeshPoints(meshFromCorners(config.corners, 32, 18));
        }
      });
    } catch { /* Keep safe defaults. */ }
  }, []);

  useEffect(() => {
    const hydrationKey = `${server.state?.project?.revision ?? 0}:composition`;
    if (!server.connected || hydratedSource.current === hydrationKey) return;
    hydratedSource.current = hydrationKey;
    const source = sourceFromProject(server.state?.project);
    window.queueMicrotask(() => { setSenderName(source.senderName); setCompositionWidth(source.width); setCompositionHeight(source.height); });
  }, [server.connected, server.state?.project]);

  useEffect(() => {
    if (!server.connected) return;
    const hydrationKey = `${server.state?.project?.revision ?? 0}:surfaces`;
    if (hydratedSurfaces.current === hydrationKey) return;
    hydratedSurfaces.current = hydrationKey;
    const catalog = catalogProjectSurfaces(
      server.state?.project?.walls,
      server.state?.project?.outputs,
      defaultSurface,
    ) as PhysicalSurface[];
    window.queueMicrotask(() => {
      setSurfaceCatalog(catalog);
      setCommittedSurfaceCatalog(catalog);
    });
  }, [server.connected, server.state?.project?.outputs, server.state?.project?.revision, server.state?.project?.walls]);

  useEffect(() => {
    const surface = surfaceCatalog.find((candidate) => candidate.id === surfaceId);
    if (!surface) return;
    const resolved = resolvePhysicalSurfaceLayout(surface, server.state?.project?.outputs ?? []);
    window.queueMicrotask(() => {
      setSurfaceNameDraft(surface.name);
      setSurfaceLayoutDraft((resolved.layout ?? "") as SurfaceLayoutDraft);
    });
  }, [server.state?.project?.outputs, surfaceCatalog, surfaceId]);

  useEffect(() => {
    if (!server.connected || !active.raw) return;
    const hydrationKey = `${server.state?.project?.revision ?? 0}:${active.id}`;
    if (hydratedOutput.current === hydrationKey) return;
    hydratedOutput.current = hydrationKey;
    const output = active.raw;
    const columns = Math.max(2, finiteNumber(output.warp?.columns, 32));
    const rows = Math.max(2, finiteNumber(output.warp?.rows, 18));
    const points = Array.isArray(output.warp?.points) ? output.warp.points as Array<{ x?: number; y?: number }> : [];
    const stride = columns + 1;
    const indexes = [0, columns, rows * stride + columns, rows * stride];
    window.queueMicrotask(() => {
      setSurfaceId(String(output.wallId ?? defaultSurface.id));
      setGrid(`${columns} × ${rows}`);
      setOverlap(exactOverlapVector(output.overlap) as OverlapVector);
      setSourceX(finiteNumber(output.sourceViewport?.x)); setSourceY(finiteNumber(output.sourceViewport?.y));
      setSourceWidth(finiteNumber(output.sourceViewport?.width, output.resolution?.width ?? 1920)); setSourceHeight(finiteNumber(output.sourceViewport?.height, output.resolution?.height ?? 1080));
      if (typeof output.blend?.enabled === "boolean") setBlend(output.blend.enabled);
      if (typeof output.blend?.feather === "number") setFeather(Math.round(output.blend.feather * 100));
      if (typeof output.blend?.gamma === "number") setBlendGamma(output.blend.gamma);
      if (typeof output.blackUniformity?.lift === "number") setBlackLevel(Math.round(output.blackUniformity.lift * 100));
      if (typeof output.mask?.enabled === "boolean") setMask(output.mask.enabled);
      if (typeof output.processing?.bypass === "boolean") setBypass(output.processing.bypass);
      if (Array.isArray(output.color?.gain)) setGain(output.color.gain.map(Number).slice(0, 3));
      if (Array.isArray(output.color?.gamma)) setGamma(output.color.gamma.map(Number).slice(0, 3));
      if (points.length === (columns + 1) * (rows + 1) && indexes.every((index) => points[index])) {
        setMeshPoints(points.map((point, index) => ({
          u: finiteNumber((point as { u?: number }).u, (index % (columns + 1)) / columns),
          v: finiteNumber((point as { v?: number }).v, Math.floor(index / (columns + 1)) / rows),
          x: finiteNumber(point.x),
          y: finiteNumber(point.y),
        })));
      } else {
        setMeshPoints(meshFromCorners(defaultCorners, columns, rows));
      }
    });
  }, [active.id, active.raw, server.connected, server.state?.project?.revision]);

  function selectPhysicalSurface(nextSurfaceId: string) {
    if (!surfaceCatalog.some((surface) => surface.id === nextSurfaceId)) return;
    if (String(active.raw?.wallId ?? defaultSurface.id) !== nextSurfaceId) setOverlap({ ...zeroOverlap });
    setSurfaceId(nextSurfaceId);
    setSaveStatus("idle");
  }

  function createSurface() {
    try {
      const created = createPhysicalSurface(surfaceCatalog, {
        id: newSurfaceId,
        name: newSurfaceName,
      }) as { surface: PhysicalSurface; surfaces: PhysicalSurface[] };
      setSurfaceCatalog(created.surfaces);
      setSurfaceId(created.surface.id);
      setSurfaceNameDraft(created.surface.name);
      setSurfaceLayoutDraft("independent");
      setOverlap({ ...zeroOverlap });
      setNewSurfaceId("");
      setNewSurfaceName("");
      setSaveStatus("idle");
      setActionNote(`Created ${created.surface.name}; Save spatial output to persist it and assign Output ${active.id}`);
    } catch (error) {
      setActionNote(error instanceof Error ? `Surface was not created: ${error.message}` : "Surface was not created");
    }
  }

  function renameSurface() {
    try {
      const renamed = renamePhysicalSurface(surfaceCatalog, surfaceId, surfaceNameDraft) as PhysicalSurface[];
      setSurfaceCatalog(renamed);
      setSaveStatus("idle");
      setActionNote(`Renamed surface ${surfaceId}; Save spatial output to persist the display name`);
    } catch (error) {
      setActionNote(error instanceof Error ? `Surface was not renamed: ${error.message}` : "Surface was not renamed");
    }
  }

  function confirmInferredLayouts() {
    const unresolved: string[] = [];
    const confirmed = surfaceCatalog.map((surface) => {
      if (Object.prototype.hasOwnProperty.call(surface, "layout")) return surface;
      if (surface.id === surfaceId && surfaceLayoutDraft) return { ...surface, layout: surfaceLayoutDraft };
      const resolved = resolvePhysicalSurfaceLayout(surface, authoritativeTopologyOutputs);
      if (!resolved.layout) {
        unresolved.push(surface.id);
        return surface;
      }
      return { ...surface, layout: resolved.layout };
    }) as PhysicalSurface[];
    setSurfaceCatalog(confirmed);
    setSaveStatus("idle");
    setActionNote(unresolved.length > 0
      ? `Confirmed safe layouts; choose and confirm an explicit layout for ${unresolved.join(", ")}`
      : "Confirmed every legacy layout; review the draft topology, then Save spatial output");
  }

  function changeSurfaceLayout(layout: PixelSurfaceLayout) {
    setSurfaceLayoutDraft(layout);
    setOverlap((current) => layout === "horizontal"
      ? { left: current.left, right: current.right, top: 0, bottom: 0 }
      : layout === "vertical"
        ? { left: 0, right: 0, top: current.top, bottom: current.bottom }
        : { ...zeroOverlap });
    setSaveStatus("idle");
    setActionNote(layout === "independent"
      ? "Independent mode will atomically clear all four overlap edges on this surface"
      : `${layout === "horizontal" ? "Horizontal row" : "Vertical column"} mode will derive every seam from aligned source geometry`);
  }

  function setOverlapEdge(edge: keyof OverlapVector, value: number) {
    setOverlap((current) => ({ ...current, [edge]: Math.max(0, Math.round(value)) }));
    setSaveStatus("idle");
  }

  async function saveConfig() {
    if (server.connected && outputs.length === 0) {
      setSaveStatus("idle");
      setActionNote("No verified projector output is bound. Run the Windows display binder first.");
      return;
    }
    if (compositionWidth < 64 || compositionWidth > 16_384 || compositionHeight < 64 || compositionHeight > 16_384
      || sourceX < 0 || sourceY < 0 || sourceWidth < 1 || sourceHeight < 1
      || sourceX + sourceWidth > compositionWidth || sourceY + sourceHeight > compositionHeight) {
      setSaveStatus("idle");
      setActionNote("Spatial save rejected: source Area must stay completely inside the master composition.");
      return;
    }
    if (inferredSurfaceCount > 0) {
      setSaveStatus("not-live");
      setActionNote(`NOT LIVE · spatial save blocked: confirm ${inferredSurfaceCount} inferred legacy layout(s) first`);
      return;
    }
    const selectedSurface = surfaceCatalog.find((surface) => surface.id === surfaceId);
    if (!selectedSurface || !surfaceLayoutDraft) {
      setSaveStatus("idle");
      setActionNote("Spatial save rejected: select an existing physical surface and explicit layout first.");
      return;
    }
    const selectedSurfaceId = selectedSurface.id;
    const saveSurfaceCatalog = setPhysicalSurfaceLayout(
      surfaceCatalog,
      selectedSurfaceId,
      surfaceLayoutDraft,
    ) as PhysicalSurface[];
    const { columns, rows } = gridDimensions(grid);
    const baseProject: PixelProject = server.state?.project ?? {
      protocolVersion: 1, id: "project-default", revision: 0, name: "Pixel Brightness Spatial Room", compositionSource: defaultSource,
      canvas: { width: compositionWidth, height: compositionHeight, frameRateNum: 60, frameRateDen: 1 }, walls: [defaultSurface],
      outputs: outputs.map((output, index) => ({
        id: output.id,
        name: output.name,
        connector: output.port,
        wallId: defaultSurface.id,
        resolution: { width: output.width, height: output.height, refreshNum: Math.round(output.refresh), refreshDen: 1 },
        sourceViewport: { x: index * 1680, y: 0, width: output.width, height: output.height },
        overlap: { ...zeroOverlap },
      })),
      timeline: { cues: [] },
    };
    // A spatial save is not a display-topology reconciliation. Preserve every
    // authoritative output, including temporarily offline or unassigned ones.
    const existingOutputs = baseProject.outputs ?? [];
    const activeFallback: PixelOutput = active.raw ?? {
      id: active.id,
      name: active.name,
      connector: active.port,
      wallId: defaultSurface.id,
      resolution: { width: active.width, height: active.height, refreshNum: Math.round(active.refresh), refreshDen: 1 },
      sourceViewport: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      overlap: { ...zeroOverlap },
    };
    const topologyOutputs = existingOutputs.some((output) => output.id === active.id)
      ? existingOutputs
      : [...existingOutputs, activeFallback];
    let rebuiltTopology: PixelOutput[];
    try {
      rebuiltTopology = rebuildPhysicalSurfaceSeams(topologyOutputs, {
        activeId: active.id,
        targetSurfaceId: selectedSurfaceId,
        targetLayout: surfaceLayoutDraft,
        surfaces: committedSurfaceCatalog,
        overlap,
        sourceViewport: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
      }) as PixelOutput[];
    } catch (error) {
      setSaveStatus("not-live");
      setActionNote(error instanceof Error ? `NOT LIVE · spatial save blocked: ${error.message}` : "NOT LIVE · surface topology could not be rebuilt safely");
      return;
    }
    const topologyValidation = validatePhysicalSurfaceTopology(saveSurfaceCatalog, rebuiltTopology);
    if (!topologyValidation.valid) {
      setSaveStatus("not-live");
      const detail = topologyValidation.issues.slice(0, 3).map((issue) => issue.message).join(" · ");
      setActionNote(`NOT LIVE · spatial save blocked: ${detail || "surface topology is invalid"}`);
      return;
    }
    const savedActiveOverlap = exactOverlapVector(
      rebuiltTopology.find((output) => String(output.id) === active.id)?.overlap,
    ) as OverlapVector;
    window.localStorage.setItem("pixel-brightness-spatial-config", JSON.stringify({ overlap: savedActiveOverlap, feather, blackLevel, meshPoints, grid, mask, blend, bypass, senderName, surfaceId: selectedSurfaceId, surfaceCatalog: saveSurfaceCatalog }));
    const rebuiltById = new Map(rebuiltTopology.map((output) => [String(output.id), output]));
    const updateOutput = (output: PixelOutput): PixelOutput => output.id !== active.id
      ? rebuiltById.get(String(output.id)) ?? output
      : {
      ...(rebuiltById.get(String(output.id)) ?? output),
      warp: {
        ...output.warp,
        enabled: true,
        columns,
        rows,
        interpolation: "bicubic",
        points: meshPoints.length === (columns + 1) * (rows + 1)
          ? meshPoints
          : meshFromCorners(defaultCorners, columns, rows),
      }, blend: { ...output.blend, enabled: blend, feather: feather / 100, gamma: blendGamma },
      blackUniformity: { ...output.blackUniformity, enabled: true, lift: blackLevel / 100 },
      mask: {
        ...output.mask,
        enabled: mask,
        path: output.mask?.path ?? (mask ? [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] : null),
        softness: finiteNumber(output.mask?.softness),
      },
      color: { ...output.color, gain, gamma },
      processing: { ...record(output.processing), bypass, order: ["sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"] },
    };
    const project: PixelProject = {
      // Keep the revision we actually edited. The Server compares it through
      // If-Match and advances the authoritative revision atomically.
      ...baseProject, protocolVersion: 1, revision: finiteNumber(baseProject.revision), updatedAt: new Date().toISOString(),
      compositionSource: {
        ...defaultSource,
        senderName: senderName.trim() || defaultSource.senderName,
        width: compositionWidth,
        height: compositionHeight,
        // Preserve the exact display rational selected by the Windows binder.
        // 60000/1001 is not interchangeable with a rounded decimal fraction.
        frameRateNum: Math.max(1, Math.round(finiteNumber(baseProject.canvas?.frameRateNum ?? defaultSource.frameRateNum, 60))),
        frameRateDen: Math.max(1, Math.round(finiteNumber(baseProject.canvas?.frameRateDen ?? defaultSource.frameRateDen, 1))),
      },
      canvas: { ...baseProject.canvas, width: compositionWidth, height: compositionHeight },
      walls: saveSurfaceCatalog,
      outputs: mergeAuthoritativeOutputs(existingOutputs, active.id, updateOutput, activeFallback) as PixelOutput[],
    };
    try {
      if (server.connected) {
        setSaveStatus("queued");
        setActionNote("Project saved by Server; waiting for exact Node and native renderer acknowledgement…");
        const result = await server.saveProject(project, finiteNumber(baseProject.revision));
        setSurfaceCatalog(saveSurfaceCatalog);
        setCommittedSurfaceCatalog(saveSurfaceCatalog);
        setOverlap(savedActiveOverlap);
        if (result.syncStatus.live) {
          setSaveStatus("live");
          setActionNote(`Project revision ${result.project.revision ?? "accepted"} is LIVE on every renderer`);
        } else {
          const pending = result.syncStatus.pendingNodeIds.filter(Boolean);
          const detail = result.syncStatus.details
            .filter((item) => !item.ready)
            .map((item) => `${item.nodeId}: ${item.reasons.join(", ")}`)
            .join("; ");
          const targets = pending.length > 0 ? pending.join(", ") : result.syncStatus.reason ?? "no renderer target";
          setSaveStatus("not-live");
          setActionNote(`Project revision ${result.project.revision ?? "accepted"} saved, but NOT LIVE on ${targets}${detail ? ` · ${detail}` : ""}`);
        }
      } else {
        setSurfaceCatalog(saveSurfaceCatalog);
        setCommittedSurfaceCatalog(saveSurfaceCatalog);
        setOverlap(savedActiveOverlap);
        setSaveStatus("draft");
        setActionNote("Saved as an offline browser draft");
      }
    } catch (error) {
      setSaveStatus("idle");
      setActionNote(error instanceof Error ? `Spatial save rejected: ${error.message}` : "Spatial save rejected by the Server");
    }
    window.setTimeout(() => { setSaveStatus("idle"); setActionNote(null); }, 5000);
  }

  async function submitPair(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); if (!tokenDraft.trim()) return; await server.pairToken(tokenDraft); setTokenDraft(""); setPairOpen(false); }

  async function selectProjector(outputId: string) {
    if (outputId === active.id) return;
    if (server.busy === "pattern") {
      setActionNote("Wait for the identify-grid command to finish before changing outputs");
      return;
    }
    const previousPatternOutputId = patternOutputId;
    if (previousPatternOutputId && previousPatternOutputId !== outputId) {
      if (!server.connected) {
        setActionNote(`Server is offline; cannot prove the identify grid was cleared on ${previousPatternOutputId}`);
        return;
      }
      try {
        await server.pattern(previousPatternOutputId, false, "grid", 32);
        setPatternOutputId(null);
      } catch {
        setActionNote(`Could not clear the identify grid on ${previousPatternOutputId}; output selection was not changed`);
        window.setTimeout(() => setActionNote(null), 4000);
        return;
      }
    }
    setProjector(outputId);
  }

  async function togglePattern() {
    if (server.busy === "pattern") return;
    if (!server.connected) {
      setActionNote("Server is offline; identify grid was not changed");
      window.setTimeout(() => setActionNote(null), 2600);
      return;
    }
    const enabled = patternOutputId !== active.id;
    try {
      if (enabled && patternOutputId && patternOutputId !== active.id) {
        await server.pattern(patternOutputId, false, "grid", 32);
        setPatternOutputId(null);
      }
      await server.pattern(active.id, enabled, "grid", 32);
      setPatternOutputId(enabled ? active.id : null);
      setActionNote(enabled ? `32 px identify grid sent to ${active.name}` : `${active.name} returned to Arena composition`);
    } catch {
      setActionNote(`Could not change pattern on ${active.name}`);
    }
    window.setTimeout(() => setActionNote(null), 2600);
  }

  function requestAutoCalibration() {
    setNav("calibrate");
    setActionNote(cameraReady
      ? "The render node reports a measured-camera adapter ready; A7 IV settings still require physical readback"
      : "Start will run the measured-camera adapter check; unavailable hardware fails without changing projector output");
  }
  async function controlCameraCalibration(markerlessSetup: MarkerlessCalibrationSetup | null) {
    try {
      if (cameraCalibrationRunning && cameraCalibration?.sessionId) {
        await server.cancelCameraCalibration(cameraCalibration.sessionId);
        setActionNote("Camera calibration cancellation requested; outputs remain fail-closed until the node confirms it");
        return;
      }
      if (!calibrationNodeId || calibrationOutputIds.length === 0) {
        setActionNote("Connect one Windows render node and bind its projector outputs first");
        return;
      }
      if (!markerlessSetup) {
        setActionNote("Load the exact Lens Profile, capture its RAW survey frame, and accept the four wall corners first");
        return;
      }
      const [columns, rows] = grid.split("×").map((value) => Math.max(2, Number.parseInt(value.trim(), 10) || 2));
      const geometryCameraSettings: PixelCameraManualSettings = {
        exposureMode: "manual",
        iso: 100,
        apertureF: 5.6,
        shutterUs: 16_667,
        whiteBalance: { mode: "kelvin", kelvin: 5_600 },
        focusMode: "manual",
        captureFormat: "linear-rgb",
      };
      const radiometryCameraSettings: PixelCameraManualSettings = {
        ...geometryCameraSettings,
        shutterUs: 1_000_000,
      };
      const response = await server.startCameraCalibration({
        mode: "measured",
        nodeId: calibrationNodeId,
        outputIds: calibrationOutputIds,
        mesh: { columns, rows, minimumConfidence: 0.08 },
        settleFrames: 3,
        // 60× is the nominal expected exposure ratio, not an operator
        // brightness control. Paired optical bridge captures measure it and
        // fail the run if reality exceeds the declared tolerance. V2 exposure
        // profiles are mutually exclusive with legacy cameraSettings.
        exposureProfiles: [
          { id: "geometry-short", role: "geometry", normalizationScale: 1, settings: geometryCameraSettings },
          { id: "radiometry-long", role: "radiometry", normalizationScale: 60, settings: radiometryCameraSettings },
        ],
        repeatPolicy: { geometry: 1, radiometry: 5, nearBlack: 16, references: 16 },
        lensProfile: markerlessSetup.lensProfile,
        surfaceSurveys: markerlessSetup.surfaceSurveys,
      });
      setActionNote(`Two-pass measured calibration queued on ${calibrationNodeId} · confirm each requested sensor-dark, ambient, or projector-black physical state · ${response.calibration.sessionId}`);
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : "Camera calibration request failed");
    }
  }
  async function confirmCameraCalibration(stepId: string, confirmationId: string) {
    if (!cameraCalibration?.sessionId) {
      setActionNote("No active camera-calibration session is waiting for confirmation");
      return false;
    }
    try {
      await server.confirmCameraCalibration(cameraCalibration.sessionId, stepId, confirmationId);
      setActionNote(`Physical reference confirmation queued · ${stepId}`);
      return true;
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : "Camera reference confirmation failed");
      return false;
    }
  }
  async function startCameraOpticalVerification() {
    if (!cameraCalibration?.sessionId) {
      setActionNote("No committed measured calibration is available for optical verification");
      return false;
    }
    try {
      await server.startCameraOpticalVerification(cameraCalibration.sessionId);
      setActionNote("Post-apply RAW recapture queued; the result is not verified until every optical gate passes");
      return true;
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : "Could not start post-apply optical verification");
      return false;
    }
  }
  async function cancelCameraOpticalVerification() {
    if (!cameraCalibration?.sessionId) return false;
    try {
      await server.cancelCameraOpticalVerification(cameraCalibration.sessionId);
      setActionNote("Optical verification cancellation queued; wait for the Node safety state before resuming content");
      return true;
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : "Could not cancel optical verification");
      return false;
    }
  }
  async function confirmCameraOpticalVerification(stepId: string, confirmationId: string) {
    if (!cameraCalibration?.sessionId) return false;
    try {
      await server.confirmCameraOpticalVerification(cameraCalibration.sessionId, stepId, confirmationId);
      setActionNote(`Optical verification condition confirmed · ${stepId}`);
      return true;
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : "Optical verification confirmation failed");
      return false;
    }
  }
  function changeGrid(nextGrid: string) {
    const previous = gridDimensions(grid);
    const next = gridDimensions(nextGrid);
    setMeshPoints((current) => resampleMesh(current, previous.columns, previous.rows, next.columns, next.rows));
    setGrid(nextGrid);
    meshDrag.current = null;
    setDragging(null);
  }

  function resetMesh() {
    setMeshPoints(meshFromCorners(defaultCorners, meshSize.columns, meshSize.rows));
    meshDrag.current = null;
    setDragging(null);
  }

  function beginMeshDrag(index: number, event: React.PointerEvent<SVGCircleElement>) {
    const point = meshPoints[index];
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    meshDrag.current = { index, anchor: { ...point }, points: meshPoints.map((item) => ({ ...item })) };
    setDragging(index);
  }

  function moveMeshPoint(event: React.PointerEvent<HTMLDivElement>) {
    const drag = meshDrag.current;
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.max(-0.25, Math.min(1.25, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(-0.25, Math.min(1.25, (event.clientY - bounds.top) / bounds.height));
    const deltaX = x - drag.anchor.x;
    const deltaY = y - drag.anchor.y;
    const radius = meshBrush / 100;
    setMeshPoints(drag.points.map((point, index) => {
      if (radius <= 0 && index !== drag.index) return point;
      const distance = Math.hypot(point.u - drag.anchor.u, point.v - drag.anchor.v);
      const weight = index === drag.index ? 1 : Math.exp(-0.5 * (distance / Math.max(radius, 0.0001)) ** 2);
      if (weight < 0.001) return point;
      return {
        ...point,
        x: Math.max(-2, Math.min(3, point.x + deltaX * weight)),
        y: Math.max(-2, Math.min(3, point.y + deltaY * weight)),
      };
    }));
  }

  function endMeshDrag() {
    meshDrag.current = null;
    setDragging(null);
  }
  function setTriplet(channel: number, value: number, setter: React.Dispatch<React.SetStateAction<number[]>>) { setter((current) => current.map((item, index) => index === channel ? value : item)); }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span className="brand-signal" />PIXEL<span>BRIGHTNESS</span></div>
        <nav aria-label="Primary navigation">{([["map", "⌗", "Spatial Output"], ["inputs", "⇥", "Arena Input"], ["calibrate", "◎", "Auto Calibrate"], ["projectors", "◫", "Projector Control"], ["schedule", "◷", "Show Schedule"], ["fleet", "▥", "Windows Nodes"]] as [NavKey, string, string][]).map(([key, icon, label]) => <button key={key} className={nav === key ? "active" : ""} onClick={() => setNav(key)}><span>{icon}</span>{label}</button>)}</nav>
        <div className="sidebar-bottom"><button onClick={() => setNav("fleet")}><span>⚙</span>System</button><div className="version"><span className={server.connected ? "online-dot" : "offline-dot"} />{server.connected ? "Server connected" : "Offline preview"} <b>v{server.state?.version ?? server.state?.server?.version ?? "0.3"}</b></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar"><div><p className="eyebrow">WINDOWS · ARENA COMPOSITION → PIXEL BRIGHTNESS SPATIAL OUTPUT</p><h1>{nav === "map" ? "Spatial output & correction" : nav === "inputs" ? "Arena composition input" : nav === "fleet" ? "Windows render nodes" : nav === "projectors" ? "Projector Control" : nav === "schedule" ? "Weekly show schedule" : "Camera auto calibration"}</h1></div><div className="top-actions"><div className={`system-pill ${sourceConnected ? "connected" : "offline"}`}><span className={sourceConnected ? "online-dot" : "offline-dot"} />SPOUT {sourceConnected ? "RECEIVING" : "WAITING"} <b>{senderName}</b></div><button className={`play-button ${bypass ? "is-playing" : ""}`} onClick={() => setBypass((value) => !value)}>{bypass ? "BYPASS ON" : runtimeOutputsLive ? "CORRECTION LIVE" : "CORRECTION NOT LIVE"}</button></div></header>

        <section className={`server-ribbon ${server.connected ? "connected" : "offline"}`} aria-live="polite"><div><span className={server.connected ? "online-dot" : "offline-dot"} /><b>PIXEL SERVER</b><code>{server.baseUrl}</code></div><div className="server-metrics"><span>NODES <b>{liveNodes.length}</b></span><span>SOURCE <b>{sourceConnected ? "LOCKED" : "NO SIGNAL"}</b></span><span>OUTPUT <b>{runtimeOutputsLive ? "RUNTIME LIVE" : "NOT LIVE"}</b></span><span>FRAME <b>{Math.round(currentFrame)}</b></span><span>CLOCK <b>{formatClockNs(clockOffsetNs)}</b></span><span>DROPPED <b className={droppedFrames > 0 ? "warning" : ""}>{droppedFrames}</b></span></div>{server.error && <small title={server.error}>{server.error}</small>}{actionNote && <small className="action-note">{actionNote}</small>}{server.authRequired && <div className="auth-pair"><button type="button" className="needs-token" onClick={() => setPairOpen((open) => !open)}>{server.paired ? "CHANGE TOKEN" : "PAIR TOKEN"}</button>{(pairOpen || !server.paired) && <form onSubmit={(event) => void submitPair(event)}><label htmlFor="server-token">AUTHENTICATION REQUIRED · SERVER TOKEN</label><input id="server-token" type="password" autoComplete="off" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Paste token — never displayed again" /><button type="submit" disabled={!tokenDraft.trim()}>PAIR</button>{server.paired && <button type="button" onClick={() => void server.clearToken()}>FORGET</button>}</form>}</div>}</section>

        {server.connected && <section className="node-strip" aria-label="Windows render nodes">{liveNodes.length === 0 ? <span className="empty-node">No Windows render node registered</span> : liveNodes.map((node) => { const nodeId = node.nodeId ?? node.id ?? "node"; return <button className="node-chip" key={nodeId} onClick={() => setNav("fleet")}><span className={`node-state ${node.status ?? "idle"}`} /><b>{node.name ?? nodeId}</b><small>{nodeId} · {(node.outputs ?? node.capabilities?.outputs ?? []).length} outputs · {String(node.status ?? "idle").toUpperCase()}</small></button>; })}</section>}

        {nav === "map" && <>
          <section className="surface-manager panel" aria-labelledby="surface-manager-title">
            <div className="surface-manager-heading">
              <div>
                <p className="eyebrow">PHYSICAL SURFACE CATALOG</p>
                <h2 id="surface-manager-title">Assign Output {active.id} without camera</h2>
              </div>
              <div className="surface-confirmation"><small>IDs stay immutable. Every legacy inferred layout needs operator confirmation before Save/LIVE.</small>{inferredSurfaceCount > 0 && <button type="button" onClick={confirmInferredLayouts}>Confirm {inferredSurfaceCount} inferred layout(s)</button>}</div>
            </div>
            <div className="surface-catalog" aria-label="Existing physical surfaces">
              {surfaceCatalog.map((surface) => {
                const resolved = resolvePhysicalSurfaceLayout(surface, authoritativeTopologyOutputs);
                const displayedLayout = surface.id === surfaceId && surfaceLayoutDraft ? surfaceLayoutDraft : resolved.layout;
                const isDraftLayout = surface.id === surfaceId && Boolean(surfaceLayoutDraft) && surfaceLayoutDraft !== resolved.layout;
                const label = displayedLayout === "horizontal" ? "Horizontal row" : displayedLayout === "vertical" ? "Vertical column" : displayedLayout === "independent" ? "Independent" : "Needs choice";
                return <button
                  type="button"
                  key={surface.id}
                  className={surface.id === surfaceId ? "selected" : ""}
                  onClick={() => selectPhysicalSurface(surface.id)}
                >
                  <span><b>{surface.name}</b><code>{surface.id}</code><em className={!displayedLayout || resolved.inferred || isDraftLayout ? "inferred" : ""}>{isDraftLayout ? `DRAFT · ${label}` : resolved.inferred ? `INFERRED · ${label}` : label}</em></span>
                  <small>{surfaceOutputCounts.get(surface.id) ?? 0} output(s)</small>
                </button>;
              })}
            </div>
            <div className="surface-actions">
              <div className="surface-layout-editor">
                <label htmlFor="surface-layout">Safe surface layout</label>
                <div><select id="surface-layout" value={surfaceLayoutDraft} onChange={(event) => changeSurfaceLayout(event.target.value as PixelSurfaceLayout)}><option value="" disabled>Choose layout</option><option value="independent">Independent</option><option value="horizontal">Horizontal row</option><option value="vertical">Vertical column</option></select></div>
                <small>Independent clears every ramp. Rows use LEFT/RIGHT only. Columns use TOP/BOTTOM only.</small>
              </div>
              <div className="surface-rename">
                <label htmlFor="surface-name">Selected surface name</label>
                <div><input id="surface-name" value={surfaceNameDraft} maxLength={128} onChange={(event) => setSurfaceNameDraft(event.target.value)} /><button type="button" disabled={server.busy === "save"} onClick={renameSurface}>Rename safely</button></div>
                <small>Renaming keeps <code>{surfaceId}</code> and every output assignment unchanged.</small>
              </div>
              <div className="surface-create">
                <label htmlFor="new-surface-id">Create physical surface</label>
                <div><input id="new-surface-id" value={newSurfaceId} maxLength={64} onChange={(event) => setNewSurfaceId(event.target.value)} placeholder="surface-balcony" /><input aria-label="New surface name" value={newSurfaceName} maxLength={128} onChange={(event) => setNewSurfaceName(event.target.value)} placeholder="Balcony" /><button type="button" disabled={server.busy === "save"} onClick={createSurface}>Create</button></div>
                <small>Lowercase unique ID and unique display name. Save spatial output to persist.</small>
              </div>
            </div>
          </section>

          <section className="projector-strip" aria-label="Projector outputs">{outputs.map((item) => <button key={item.id} className={`projector-card ${active.id === item.id ? "selected" : ""}`} onClick={() => void selectProjector(item.id)}><span className={`projector-status ${["offline", "error", "unassigned", "degraded", "draft"].includes(item.status) ? "offline" : "online"}`} /><span className="projector-id">{item.id}</span><span><b>{item.name}</b><small>{item.wall} · {item.port}{item.nodeId ? ` · ${item.nodeId}` : ""}</small></span><span className="temp">{item.temp}</span></button>)}{outputs.length === 0 && <div className="no-outputs">No projector outputs are bound. Bind Windows displays by device path before going live.</div>}<button className="add-output" disabled title="Run the Windows display binder to add a verified physical output">＋<span>Bind in Windows</span></button></section>

          <section className="signal-flow panel" aria-label="Render pipeline"><div className="signal-step"><small>01 · SOURCE</small><b>ARENA</b><span>{senderName}</span></div><i>→</i><div className="signal-step"><small>02 · AREA</small><b>SOURCE VIEWPORT</b><span>{sourceWidth} × {sourceHeight} @ {sourceX},{sourceY}</span></div><i>→</i><div className="signal-step active"><small>03 · GEOMETRY</small><b>{grid} MESH</b><span>Curve · Keystone · Deflex</span></div><i>→</i><div className="signal-step active"><small>04 · OPTICAL</small><b>AUTO BLEND + BLACK</b><span>Mask · RGB · LUT</span></div><i>→</i><div className="signal-step"><small>05 · SCANOUT</small><b>DXGI</b><span>{active.width} × {active.height} · {active.refresh.toFixed(2)} Hz</span></div></section>

          <section className="room-overview panel">
            <div className="panel-heading"><div><p className="eyebrow">MASTER COMPOSITION AREA MAP</p><h2>{canvasWidth} × {canvasHeight}</h2></div><div className="canvas-metrics"><span>SURFACES <b>{surfaceOverviewGroups.length}</b></span><span>PROJECTORS <b>{outputs.length}</b></span><span>RAW OUTPUT <b>{rawOutputWidth || 3840} px</b></span></div></div>
            <div className="surface-overview">
              {surfaceOverviewGroups.map((group) => <div className="surface-track" key={group.surface.id}>
                <div className="surface-track-heading"><span><b>{group.surface.name}</b><code>{group.surface.id}</code></span><small>{group.layout === "horizontal" ? "HORIZONTAL ROW" : group.layout === "vertical" ? "VERTICAL COLUMN" : group.layout === "independent" ? "INDEPENDENT" : "LAYOUT REQUIRED"} · {group.outputs.length} output(s)</small></div>
                <div className={`wall-track ${group.layout ?? "invalid"}`}>
                  {group.outputs.map((output, index) => <button key={output.id} className={`wall-output out-${index + 1} ${active.id === output.id ? "selected" : ""}`} onClick={() => void selectProjector(output.id)}><span>{output.name}</span><small>AREA {finiteNumber(output.raw?.sourceViewport?.x)} , {finiteNumber(output.raw?.sourceViewport?.y)} · {finiteNumber(output.raw?.sourceViewport?.width, output.width)} × {finiteNumber(output.raw?.sourceViewport?.height, output.height)}</small></button>)}
                </div>
                <div className="seam-diagnostics">
                  {group.seams.map((seam) => <span key={seam.key} className={seam.valid ? "valid" : "mismatch"}><b>{seam.fromId} {String(seam.fromEdge).toUpperCase()} ↔ {seam.toId} {String(seam.toEdge).toUpperCase()}</b><small>{seam.fromPixels}/{seam.toPixels}px · expected {seam.expectedPixels ?? "INVALID"}px</small></span>)}
                  {group.layout === "independent" && group.issues.length === 0 && <span className="independent"><b>NO SEAMS</b><small>LEFT / RIGHT / TOP / BOTTOM = 0</small></span>}
                  {group.issues.slice(0, 4).map((issue, index) => <span key={`${issue.code}:${("outputId" in issue ? issue.outputId : null) ?? index}`} className="orphan"><b>{String(issue.code).replaceAll("-", " ").toUpperCase()}</b><small>{issue.message}</small></span>)}
                </div>
              </div>)}
            </div>
          </section>

          <section className="mapping-grid"><div className="mapping-editor panel"><div className="editor-title"><div><p className="eyebrow">PIXEL BRIGHTNESS SPATIAL ENGINE</p><h2>{active.name} · {activeSurfaceName}</h2></div><div className="segmented" aria-label="Spatial processing stages"><span>Area</span><span className="active">Geometry</span><span>Optical</span></div></div><div className="dual-preview"><div className="preview-block"><div className="preview-label"><span>ARENA MASTER COMPOSITION</span><b>{compositionWidth} × {compositionHeight}</b></div><div className="source-stage"><div className="source-art" /><div className="source-region" style={{ left: `${Math.max(0, sourceX / Math.max(1, compositionWidth) * 100)}%`, top: `${Math.max(0, sourceY / Math.max(1, compositionHeight) * 100)}%`, width: `${Math.min(100, sourceWidth / Math.max(1, compositionWidth) * 100)}%`, height: `${Math.min(100, sourceHeight / Math.max(1, compositionHeight) * 100)}%` }}><span>{active.id} SOURCE AREA</span></div></div></div><div className="flow-arrow">→</div><div className="preview-block"><div className="preview-label"><span>PHYSICAL PROJECTOR OUTPUT</span><b>{active.width} × {active.height}</b></div><div className={`output-stage ${pattern ? "show-pattern" : ""}`} onPointerMove={moveMeshPoint} onPointerUp={endMeshDrag} onPointerCancel={endMeshDrag}><div className="projected-image" style={{ clipPath: `polygon(${polygon})`, opacity: bypass ? 0.62 : 1 }}><div className="grid-lines" /></div><svg className="mesh-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`${grid} editable projector mesh`}>{meshDisplay.rowLines.map((line, index) => <polyline key={`row-${index}`} points={line.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />)}{meshDisplay.columnLines.map((line, index) => <polyline key={`column-${index}`} points={line.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />)}{meshDisplay.handles.map(({ point, index, corner }) => <circle key={index} className={`mesh-handle ${corner ? "corner" : ""} ${dragging === index ? "dragging" : ""}`} cx={point.x * 100} cy={point.y * 100} r={corner ? 1.25 : 0.85} onPointerDown={(event) => beginMeshDrag(index, event)} role="button" aria-label={`Mesh control point ${index + 1}`} />)}</svg>{mask && <div className="mask-label">FINAL MASK · ZERO SIGNAL OUTSIDE</div>}{blend && <><div className="blend-zone left" /><div className="blend-zone right" /></>}</div></div></div><div className="editor-toolbar"><button onClick={resetMesh}>↶ Reset identity mesh</button><button onClick={() => void togglePattern()} className={pattern ? "active" : ""}>▦ Identify grid · 32 px</button><button onClick={requestAutoCalibration}>◎ Camera Correspondence + Blend</button><button onClick={() => setMask(!mask)} className={mask ? "active" : ""}>◩ Final mask</button><span className="toolbar-note">Drag any visible mesh node. Smooth radius deforms the complete underlying grid up to 128 × 128.</span></div></div>

            <aside className="inspector panel"><div className="panel-heading compact"><div><p className="eyebrow">AREA · GEOMETRY · OPTICAL</p><h2>Output {active.id}</h2></div><span className="live-badge">{activeRuntimeLive ? "RUNTIME LIVE" : "NOT LIVE"}</span></div><div className="control-group"><label htmlFor="physical-surface">Physical surface</label><select id="physical-surface" value={surfaceId} onChange={(event) => selectPhysicalSurface(event.target.value)}>{surfaceOptions.map((surface) => <option key={surface.id} value={surface.id}>{surface.name} · {surface.id}</option>)}</select></div><div className="control-group"><label htmlFor="inspector-surface-layout">Surface layout</label><select id="inspector-surface-layout" value={surfaceLayoutDraft} onChange={(event) => changeSurfaceLayout(event.target.value as PixelSurfaceLayout)}><option value="" disabled>Choose layout</option><option value="independent">Independent</option><option value="horizontal">Horizontal row</option><option value="vertical">Vertical column</option></select></div><div className="control-group"><label htmlFor="warp-grid">Mesh density</label><select id="warp-grid" value={grid} onChange={(event) => changeGrid(event.target.value)}><option>4 × 4</option><option>8 × 8</option><option>16 × 9</option><option>32 × 18</option><option>32 × 32</option><option>64 × 36</option><option>128 × 128</option></select></div><div className="range-heading"><label htmlFor="mesh-brush">Smooth mesh brush</label><output>{meshBrush === 0 ? "POINT" : `${meshBrush}%`}</output></div><input id="mesh-brush" type="range" min="0" max="35" step="1" value={meshBrush} onChange={(event) => setMeshBrush(Number(event.target.value))} /><div className="viewport-controls"><label>X<input type="number" min="0" max={compositionWidth - 1} value={sourceX} onChange={(event) => setSourceX(finiteNumber(event.target.value))} /></label><label>Y<input type="number" min="0" max={compositionHeight - 1} value={sourceY} onChange={(event) => setSourceY(finiteNumber(event.target.value))} /></label><label>W<input type="number" min="1" max={compositionWidth} value={sourceWidth} onChange={(event) => setSourceWidth(finiteNumber(event.target.value, 1920))} /></label><label>H<input type="number" min="1" max={compositionHeight} value={sourceHeight} onChange={(event) => setSourceHeight(finiteNumber(event.target.value, 1080))} /></label></div><div className="divider" /><div className="range-heading"><span className="overlap-vector-title">Exact overlap vector</span><output>{surfaceLayoutDraft === "horizontal" ? "LEFT / RIGHT" : surfaceLayoutDraft === "vertical" ? "TOP / BOTTOM" : "ALL EDGES OFF"}</output></div><div className="overlap-vector" aria-label="Exact four-edge overlap vector">{overlapEdgeState.map(({ edge, active: edgeIsActive }) => <label key={edge} className={edgeIsActive ? "active" : "inactive"}><span>{edge.toUpperCase()}</span>{edgeIsActive ? <input type="number" min="0" max="8192" step="1" value={displayedOverlap[edge]} disabled={layoutModeChanged} onChange={(event) => setOverlapEdge(edge, finiteNumber(event.target.value))} /> : <output>0 px<small>INACTIVE</small></output>}</label>)}</div><small className="overlap-guidance">{layoutModeChanged ? "Layout change: exact seams are derived atomically from aligned source intersections." : surfaceLayoutDraft === "independent" ? "Independent guarantees LEFT / RIGHT / TOP / BOTTOM = 0." : "Each active edge must equal its reciprocal neighbour and the mapped source-crop intersection."}</small><div className={`topology-status ${topologyIsSafe ? "safe" : "unsafe"}`} aria-live="polite"><b>{topologyIsSafe ? "DRAFT TOPOLOGY SAFE" : "NOT LIVE · SAVE BLOCKED"}</b><small>{topologyIsSafe ? "Every surface layout, edge vector, scale and source intersection is consistent." : topologyIssueSummary || draftTopology.error}</small></div><div className="range-heading"><label htmlFor="blend-feather">Blend feather</label><output>{feather}%</output></div><input id="blend-feather" type="range" min="1" max="100" value={feather} onChange={(event) => setFeather(Number(event.target.value))} /><div className="range-heading"><label htmlFor="blend-gamma">Blend gamma</label><output>{blendGamma.toFixed(2)}</output></div><input id="blend-gamma" type="range" min="0.1" max="5" step="0.05" value={blendGamma} onChange={(event) => setBlendGamma(Number(event.target.value))} /><div className="range-heading"><label htmlFor="black-lift">Manual black lift</label><output>{blackLevel}%</output></div><input id="black-lift" type="range" min="0" max="60" value={blackLevel} onChange={(event) => setBlackLevel(Number(event.target.value))} /><div className="channel-grid"><b>RGB GAIN</b>{gain.map((value, index) => <label key={`gain-${index}`} className={`channel c${index}`}><span>{["R", "G", "B"][index]}</span><input type="number" min="0" max="4" step="0.01" value={value} onChange={(event) => setTriplet(index, finiteNumber(event.target.value, 1), setGain)} /></label>)}<b>RGB GAMMA</b>{gamma.map((value, index) => <label key={`gamma-${index}`} className={`channel c${index}`}><span>{["R", "G", "B"][index]}</span><input type="number" min="0.1" max="4" step="0.01" value={value} onChange={(event) => setTriplet(index, finiteNumber(event.target.value, 1), setGamma)} /></label>)}</div><div className="divider" /><div className="switch-row"><span><b>Auto edge blend map</b><small>Normalized in linear light</small></span><Toggle checked={blend} onChange={setBlend} label="Auto edge blend" /></div><div className="switch-row"><span><b>Final camera mask</b><small>Crop every pixel outside the measured surface</small></span><Toggle checked={mask} onChange={setMask} label="Final camera mask" /></div><button className="primary-wide" disabled={server.busy === "save" || outputs.length === 0 || !topologyIsSafe} onClick={() => void saveConfig()}>{!topologyIsSafe ? "⚠ Mapping invalid · NOT LIVE" : server.busy === "save" ? (saveStatus === "queued" ? "Waiting for renderers…" : "Distributing…") : saveStatus === "live" ? "✓ LIVE on all renderers" : saveStatus === "not-live" ? "⚠ Saved · NOT LIVE" : saveStatus === "draft" ? "Saved offline draft" : "Save spatial output"}</button></aside>
          </section>
        </>}

        {nav === "inputs" && <section className="input-layout"><div className="input-hero panel"><div><p className="eyebrow">ONE GPU TEXTURE · ALL PROJECTORS</p><h2>Arena master composition</h2><p>Arena plays media and positions layers only. Pixel Brightness receives one clean, unwarped composition and performs every projector crop, mesh, blend, mask and black correction itself.</p></div><div className={`source-lock ${sourceConnected ? "locked" : "waiting"}`}><span /><b>{sourceConnected ? "SPOUT LOCKED" : "WAITING FOR ARENA"}</b><small>Strict sender binding · fail to black</small></div></div><div className="source-config panel"><div className="panel-heading"><div><p className="eyebrow">MASTER SPOUT CONTRACT</p><h2>{senderName}</h2></div><span className="live-badge">{sourceConnected ? "RECEIVING" : "NO SIGNAL"}</span></div><div className="source-fields"><label>ARENA SENDER NAME<input value={senderName} maxLength={255} onChange={(event) => setSenderName(event.target.value)} /></label><label>COMPOSITION WIDTH<input type="number" min="64" max="16384" value={compositionWidth} onChange={(event) => setCompositionWidth(finiteNumber(event.target.value, 3840))} /></label><label>COMPOSITION HEIGHT<input type="number" min="64" max="16384" value={compositionHeight} onChange={(event) => setCompositionHeight(finiteNumber(event.target.value, 1080))} /></label><label>FRAME RATE<input value={`${fps.toFixed(3)} fps`} disabled /></label></div><div className="contract-grid"><span><b>COLOR</b>{composition.colorEncoding.toUpperCase()}</span><span><b>ALPHA</b>IGNORE</span><span><b>MISSING SOURCE</b>BLACK</span><span><b>SIZE MISMATCH</b>BLACK</span><span><b>AUTO SELECT</b>DISABLED</span><span><b>TIMEOUT</b>{composition.timeoutMs} ms</span></div><button className="primary-wide small" onClick={() => void saveConfig()}>Save Arena source contract</button></div><div className="arena-setup panel"><p className="eyebrow">ARENA SETUP</p><div><span>1</span><b>Build one master composition</b><small>Place and cue media in Arena at {compositionWidth} × {compositionHeight}.</small></div><div><span>2</span><b>Publish one Spout sender</b><small>Name it exactly <code>{senderName}</code>. Do not warp or edge-blend projector screens in Arena.</small></div><div><span>3</span><b>Leave projector displays to Pixel Brightness</b><small>Arena must not fullscreen directly to them. Pixel Brightness owns the final DXGI swapchains.</small></div></div></section>}

        {nav === "inputs" && <NdiVideoPanel baseUrl={server.baseUrl} connected={server.connected} revision={Number(server.state?.project?.revision || 0)} outputs={outputs} />}
        {nav === "calibrate" && <><UvcGeometryPanel baseUrl={server.baseUrl} connected={server.connected} outputs={outputs} revision={Number(server.state?.project?.revision || 0)} /><CameraCalibrationPanel
          outputs={outputs}
          selectedOutputIds={calibrationOutputIds}
          wallId={calibrationWallId}
          serverConnected={server.connected}
          nodeId={calibrationNodeId}
          cameraReady={cameraReady}
          calibration={cameraCalibration}
          running={cameraCalibrationRunning}
          busy={server.busy}
          onControl={controlCameraCalibration}
          onCaptureSurveyPreview={server.captureCameraSurveyPreview}
          onConfirm={confirmCameraCalibration}
          onStartVerification={startCameraOpticalVerification}
          onCancelVerification={cancelCameraOpticalVerification}
          onConfirmVerification={confirmCameraOpticalVerification}
        /></>}

        {nav === "projectors" && <ProjectorControlPanel
          control={server.state?.projectorControl}
          connected={server.connected}
          busy={server.busy}
          onConfigure={server.configureProjectors}
          onRefresh={server.refreshProjectors}
          onAction={server.projectorAction}
        />}

        {nav === "schedule" && <ShowSchedulePanel
          connected={server.connected}
          busy={server.busy}
          onLoad={server.loadShowSchedule}
          onSave={server.saveShowSchedule}
        />}

        {nav === "fleet" && <section className="fleet-layout"><div className="fleet-intro panel"><div><p className="eyebrow">WINDOWS 11 · D3D11 / DXGI NODE MANAGEMENT</p><h2>GPU, Spout, displays and interactive renderer</h2><p>The native renderer must run in the signed-in local Show session. Every projector is bound by Windows device path and EDID identity; screen numbers are never trusted after a reboot or hot-plug.</p></div><div><span>HOSTS <b>{liveNodes.length}</b></span><span>SOURCE <b>{sourceConnected ? "LOCKED" : "WAITING"}</b></span><span>SCANOUT <b>{runtimeOutputsLive ? "RUNTIME LIVE" : "NOT LIVE"}</b></span><span>POWER <b>{server.state?.fleet?.powerActionsEnabled ? "ENABLED" : "LOCKED"}</b></span></div></div>{!server.connected ? <div className="fleet-empty panel"><b>PIXEL SERVER OFFLINE</b><span>Start the Windows Server, Web and interactive Show tasks.</span></div> : liveNodes.length === 0 ? <div className="fleet-empty panel"><b>NO WINDOWS NODES REGISTERED</b><span>Sign in to the local Show account; the renderer cannot run from Session 0 or an RDP session.</span></div> : liveNodes.map((node) => <FleetNodePanel key={node.nodeId ?? node.id} node={node} busy={server.busy} onAction={server.nodeAction} />)}</section>}
      </section>
    </main>
  );
}
