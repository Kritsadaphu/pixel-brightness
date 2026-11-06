"use client";

import { useMemo, useState } from "react";
import type {
  PixelHostDisplay,
  PixelHostGpu,
  PixelHostService,
  PixelNode,
  PixelNodeActionResult,
  PixelNodeActionType,
  PixelOutput,
} from "../lib/pixel-server";

type RecordValue = Record<string, unknown>;

type DisplayDraft = {
  id: string;
  connector: string;
  width: number;
  height: number;
  refresh: number;
  refreshNum: number;
  refreshDen: number;
  x: number;
  y: number;
  enabled: boolean;
  primary: boolean;
  connected?: boolean;
  edid: string;
  link: string;
};

type FleetNodePanelProps = {
  node: PixelNode;
  busy: string | null;
  onAction: (
    nodeId: string,
    type: PixelNodeActionType,
    payload?: Record<string, unknown>,
    confirmationPhrase?: string,
  ) => Promise<PixelNodeActionResult>;
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function numberValue(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function textValue(value: unknown, fallback = "—") {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power >= 3 ? 1 : 0)} ${units[power]}`;
}

function formatUptime(secondsInput: unknown) {
  const seconds = Math.max(0, numberValue(secondsInput));
  if (!seconds) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`;
}

function modeRecord(display: PixelHostDisplay | PixelOutput) {
  if (display.resolution) return record(display.resolution);
  if (typeof (display as PixelHostDisplay).currentMode === "object") return record((display as PixelHostDisplay).currentMode);
  if (typeof (display as PixelHostDisplay).mode === "object") return record((display as PixelHostDisplay).mode);
  return {};
}

function parseModeString(value: unknown) {
  if (typeof value !== "string") return null;
  const match = /(\d+)\s*[x×]\s*(\d+)(?:\s*[@x]\s*([\d.]+))?/i.exec(value);
  return match ? { width: Number(match[1]), height: Number(match[2]), refresh: Number(match[3] || 60) } : null;
}

function describeEdid(value: PixelHostDisplay["edid"]): string {
  if (typeof value === "string") return value || "Not reported";
  if (!value) return "Not reported";
  const identity = [value.manufacturer, value.model ?? value.monitorName, value.serial ?? value.serialNumber]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  return identity || textValue(value.hash ?? value.sha256, "Detected");
}

function describeLink(value: PixelHostDisplay["link"], connected: boolean | undefined) {
  if (typeof value === "string") return value || (connected ? "Connected" : "Unknown");
  if (!value) return connected ? "Connected · details pending" : "Not reported";
  return [value.status, value.rate, value.lanes ? `${value.lanes} lanes` : null, value.bandwidth].filter(Boolean).join(" · ") || "Detected";
}

function normalizeDisplays(node: PixelNode): DisplayDraft[] {
  const host = node.host;
  const hostDisplays = host?.displays ?? host?.connectors ?? host?.drm?.connectors;
  const source: Array<PixelHostDisplay | PixelOutput> = hostDisplays?.length
    ? hostDisplays
    : node.outputs ?? node.capabilities?.outputs ?? [];
  return source.map((display, index) => {
    const mode = modeRecord(display);
    const displayHost = display as PixelHostDisplay;
    const firstMode = displayHost.modes?.[0];
    const edid = record(displayHost.edid);
    const preferredMode = record(edid.preferredMode);
    const parsed = parseModeString(displayHost.currentMode) ?? parseModeString(displayHost.mode) ?? parseModeString(firstMode);
    const refreshNum = numberValue(mode.refreshNum ?? mode.refresh ?? mode.refreshHz, parsed?.refresh ?? 60);
    const refreshDen = Math.max(1, numberValue(mode.refreshDen, 1));
    const position = record(displayHost.position);
    const connector = textValue(display.connector ?? display.name, `DISPLAY-${index + 1}`);
    const connected = displayHost.connected ?? (typeof displayHost.status === "string" ? displayHost.status === "connected" : undefined);
    const enabled = displayHost.enabled === false || ["disabled", "off"].includes(String(displayHost.enabled).toLowerCase()) ? false : true;
    return {
      id: textValue(display.id, connector),
      connector,
      width: Math.max(64, Math.round(numberValue(mode.width ?? preferredMode.width, parsed?.width ?? 1920))),
      height: Math.max(64, Math.round(numberValue(mode.height ?? preferredMode.height, parsed?.height ?? 1080))),
      refresh: Math.max(1, refreshNum / refreshDen),
      refreshNum: Math.max(1, Math.round(refreshNum)),
      refreshDen: Math.max(1, Math.round(refreshDen)),
      x: Math.round(numberValue((display as PixelHostDisplay).x ?? position.x)),
      y: Math.round(numberValue((display as PixelHostDisplay).y ?? position.y)),
      enabled,
      primary: Boolean(displayHost.primary),
      connected,
      edid: describeEdid(displayHost.edid),
      link: displayHost.link ? describeLink(displayHost.link, connected) : [displayHost.status, displayHost.dpms, displayHost.driver].filter(Boolean).join(" · ") || describeLink(undefined, connected),
    };
  });
}

function gpuList(node: PixelNode): PixelHostGpu[] {
  const host = node.host;
  if (host?.gpus?.length) return host.gpus;
  if (host?.nvidia?.gpus?.length) return host.nvidia.gpus;
  if (Array.isArray(host?.gpu)) return host.gpu;
  if (host?.gpu && "gpus" in host.gpu && Array.isArray(host.gpu.gpus)) return host.gpu.gpus;
  return host?.gpu ? [host.gpu] : [];
}

function serviceList(node: PixelNode): Array<PixelHostService & { label: string }> {
  const host = node.host;
  const raw = host?.services;
  const items = Array.isArray(raw)
    ? raw
    : raw ? Object.entries(raw).map(([name, service]) => ({ ...service, name: service.name ?? name })) : [];
  const withKnown = [
    ...(host?.nodeService ? [{ ...host.nodeService, name: host.nodeService.name ?? "pixel-brightness-node" }] : []),
    ...(host?.rendererService ? [{ ...host.rendererService, name: host.rendererService.name ?? "pixel-brightness-renderer" }] : []),
    ...items,
  ];
  const unique = new Map<string, PixelHostService>();
  withKnown.forEach((service, index) => unique.set(service.name ?? service.unit ?? `service-${index}`, service));
  return [...unique.entries()].map(([label, service]) => ({ ...service, label }));
}

function serviceState(service: PixelHostService) {
  if (service.active === true) return "active";
  if (service.active === false) return "inactive";
  return textValue(service.state ?? service.status ?? service.activeState ?? service.subState, service.available === false ? "unavailable" : "unknown").toLowerCase();
}

function warningList(node: PixelNode) {
  const host = node.host;
  const faults = Array.isArray(host?.faults) ? host.faults : [];
  return [...(host?.warnings ?? []), ...faults, ...(node.readiness?.faults ?? [])].map((warning) => {
    if (typeof warning === "string") return warning;
    const item = record(warning);
    return textValue(item.message ?? item.code, "Unknown host warning");
  });
}

function compositionSourceIsConnected(value: unknown) {
  const source = record(value);
  const state = String(source.state ?? source.status ?? "").toLowerCase();
  return source.connected === true || state === "connected" || state === "receiving";
}

export function FleetNodePanel({ node, busy, onAction }: FleetNodePanelProps) {
  const nodeId = node.nodeId ?? node.id ?? "unknown-node";
  const [displays, setDisplays] = useState<DisplayDraft[]>(() => normalizeDisplays(node));
  const [lastResult, setLastResult] = useState<PixelNodeActionResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const host = node.host;
  const machine = record(host?.host);
  const os = record(host?.os ?? machine.os);
  const kernel = record(host?.kernel);
  const gpus = useMemo(() => gpuList(node), [node]);
  const services = useMemo(() => serviceList(node), [node]);
  const warnings = warningList(node);
  const renderer = record(host?.renderer);
  const telemetryRenderer = record(node.telemetry?.renderer);
  const rendererBackend = textValue(renderer.backend ?? renderer.mode ?? telemetryRenderer.backend ?? node.telemetry?.engine, "Renderer not reported");
  const windowsRenderer = /\b(dxgi|d3d11|windows)\b/i.test(rendererBackend)
    || String(record(host?.host).platform ?? host?.osName ?? "").toLowerCase().includes("win");
  const nativeScanout = windowsRenderer || renderer.directKms === true || /\b(drm|kms)\b/i.test(rendererBackend);
  const runtimeOutputs = Array.isArray(node.telemetry?.outputs) ? node.telemetry.outputs.map(record) : [];
  const runtimeStatus = String(node.status ?? "").toLowerCase();
  const runtimeLive = nativeScanout
    && telemetryRenderer.connected === true
    && telemetryRenderer.ready === true
    && compositionSourceIsConnected(telemetryRenderer.compositionSource)
    && runtimeOutputs.length > 0
    && !["offline", "error", "degraded"].includes(runtimeStatus)
    && runtimeOutputs.every((output) => !["offline", "error", "degraded"].includes(String(output.state ?? "").toLowerCase()));
  const gpuContainer = record(host?.gpu);
  const nvidiaVersion = textValue(host?.nvidiaDriverVersion ?? host?.nvidia?.driverVersion ?? gpuContainer.driverVersion ?? gpus[0]?.driverVersion, "Not detected");
  const actionBusy = busy?.startsWith(`node-action:${nodeId}:`) ?? false;

  function updateDisplay(id: string, patch: Partial<DisplayDraft>) {
    setDisplays((current) => current.map((display) => {
      if (display.id !== id) return patch.primary ? { ...display, primary: false } : display;
      return { ...display, ...patch };
    }));
  }

  async function dispatch(type: PixelNodeActionType, payload: Record<string, unknown> = {}, phrase?: string) {
    setActionError(null);
    setLastResult(null);
    try {
      const result = await onAction(nodeId, type, payload, phrase);
      setLastResult(result);
      if (type === "REBOOT_HOST" || type === "SHUTDOWN_HOST") setConfirmation("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : `${type} was rejected`);
    }
  }

  function applyDisplays() {
    if (windowsRenderer) {
      setActionError("Windows projector identity must be committed locally with Bind-PixelBrightnessDisplays.ps1; Web Control will not guess a DXGI target.");
      return;
    }
    const outputs = displays.map((display) => ({
      id: display.id,
      connector: display.connector,
      enabled: display.enabled,
      primary: display.primary,
      x: display.x,
      y: display.y,
      refresh: display.refresh,
      resolution: {
        width: display.width,
        height: display.height,
        refreshNum: display.refreshNum,
        refreshDen: display.refreshDen,
      },
    }));
    void dispatch("APPLY_DISPLAY_CONFIG", { outputs });
  }

  return (
    <article className="fleet-node panel">
      <header className="fleet-node-head">
        <div className={`fleet-health ${node.status ?? "offline"}`}><span /><div><p className="eyebrow">{windowsRenderer ? "WINDOWS INTERACTIVE RENDER HOST" : "RENDER HOST"}</p><h2>{node.name ?? nodeId}</h2><small>{nodeId} · {textValue(host?.hostname ?? machine.hostname ?? node.address, "address unavailable")}</small></div></div>
        <div className="fleet-head-metrics"><span>NODE <b>{String(node.status ?? "unknown").toUpperCase()}</b></span><span>READINESS <b className={node.readiness?.ready === false ? "warning" : ""}>{node.readiness?.ready == null ? "V1" : node.readiness.ready ? "READY" : "BLOCKED"}</b></span><span>LAST SEEN <b>{node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleTimeString() : "—"}</b></span><span>RTT <b>{node.telemetry?.bestRttNs == null ? "—" : `${(numberValue(node.telemetry.bestRttNs) / 1_000_000).toFixed(2)} ms`}</b></span></div>
      </header>

      <div className={`kms-verification ${runtimeLive ? "runtime-live" : "pending"}`}>
        <b>{`${windowsRenderer ? "DXGI" : "NATIVE SCANOUT"} · ${runtimeLive ? "RUNTIME LIVE" : "RUNTIME NOT LIVE"}`}</b>
        <span>{runtimeLive ? `${rendererBackend} reports a connected renderer, live composition source and registered runtime outputs.` : `${rendererBackend} does not currently report the complete live renderer/source/output contract.`} PHYSICAL ACCEPTANCE NOT RECORDED IN WEB CONTROL · run Test-PixelBrightness.ps1 -Full and the site camera gate.</span>
      </div>

      <div className="fleet-facts">
        <section><p className="eyebrow">OPERATING SYSTEM</p><dl><div><dt>OS</dt><dd>{textValue(host?.osName ?? os.prettyName ?? os.name, host ? "Host detected" : "Telemetry unavailable")}</dd></div><div><dt>VERSION</dt><dd>{textValue(host?.osVersion ?? os.version ?? os.versionId)}</dd></div><div><dt>BUILD</dt><dd>{textValue(host?.kernelVersion ?? machine.kernelRelease ?? kernel.release ?? (typeof host?.kernel === "string" ? host.kernel : undefined))}</dd></div><div><dt>UPTIME</dt><dd>{formatUptime(host?.uptimeSeconds ?? host?.uptimeSec ?? machine.uptimeSeconds)}</dd></div><div><dt>ARCH</dt><dd>{textValue(host?.architecture ?? machine.architecture)}</dd></div></dl></section>
        <section><p className="eyebrow">NVIDIA / GPU</p><dl><div><dt>DRIVER</dt><dd>{nvidiaVersion}</dd></div>{gpus.length === 0 ? <div><dt>GPU</dt><dd>Not reported</dd></div> : gpus.slice(0, 2).map((gpu, index) => { const total = numberValue(gpu.vramTotalBytes, numberValue(gpu.memoryTotalMiB) * 1024 ** 2); const used = numberValue(gpu.vramUsedBytes, numberValue(gpu.memoryUsedMiB) * 1024 ** 2); return <div key={gpu.uuid ?? `${gpu.name}-${index}`}><dt>GPU {index}</dt><dd>{gpu.name ?? gpu.model ?? "NVIDIA GPU"}</dd><dt>TEMP / VRAM</dt><dd>{gpu.temperatureC ?? gpu.tempC ?? "—"}°C · {formatBytes(used)} / {formatBytes(total)}</dd></div>; })}</dl></section>
        <section><p className="eyebrow">SYSTEM SERVICES</p><div className="service-stack">{services.length === 0 ? <span className="unknown-service">Service telemetry pending</span> : services.slice(0, 5).map((service) => { const state = serviceState(service); const pid = service.pid ?? service.mainPid; return <div key={service.label}><span className={`service-dot ${state}`} /><b>{service.label}</b><small>{state.toUpperCase()}{pid ? ` · PID ${pid}` : ""}{service.restarts ? ` · ${service.restarts} restarts` : ""}</small></div>; })}</div></section>
      </div>

      <section className="display-config">
        <div className="display-config-head"><div><p className="eyebrow">{windowsRenderer ? "WINDOWS DISPLAYCONFIG / DXGI" : "DISPLAY CONFIGURATION"}</p><h3>Stable display identities and exact scanout modes</h3></div><button className="apply-display" disabled={windowsRenderer || actionBusy || displays.length === 0} onClick={applyDisplays}>{windowsRenderer ? "USE LOCAL DISPLAY BINDER" : busy?.endsWith("APPLY_DISPLAY_CONFIG") ? "APPLYING…" : "VALIDATE & APPLY DISPLAYS"}</button></div>
        {windowsRenderer && <div className="display-empty">For safety, Windows DXGI targets are bound at the render PC with <code>Bind-PixelBrightnessDisplays.ps1</code>. A browser cannot supply the required devicePath, adapter LUID and target ID.</div>}
        {displays.length === 0 ? <div className="display-empty">No physical display telemetry. The interactive Windows renderer must enumerate the local console session before outputs can be bound.</div> : <div className="display-list">{displays.map((display) => <div className="display-editor" key={display.id}>
          <div className="display-identity"><span className={`link-led ${display.connected === false ? "down" : "up"}`} /><div><b>{display.id}</b><small>{display.edid}</small><small>{display.link}</small></div></div>
          <label>CONNECTOR<input value={display.connector} onChange={(event) => updateDisplay(display.id, { connector: event.target.value })} /></label>
          <label>WIDTH<input type="number" min="64" max="16384" value={display.width} onChange={(event) => updateDisplay(display.id, { width: numberValue(event.target.value, 1920) })} /></label>
          <label>HEIGHT<input type="number" min="64" max="16384" value={display.height} onChange={(event) => updateDisplay(display.id, { height: numberValue(event.target.value, 1080) })} /></label>
          <label>REFRESH<input type="number" min="1" max="240" step="0.001" value={display.refresh} onChange={(event) => { const refresh = numberValue(event.target.value, 60); updateDisplay(display.id, { refresh, refreshNum: Math.max(1, Math.round(refresh * 1000)), refreshDen: 1000 }); }} /></label>
          <label>X<input type="number" min="-32768" max="32768" value={display.x} onChange={(event) => updateDisplay(display.id, { x: numberValue(event.target.value) })} /></label>
          <label>Y<input type="number" min="-32768" max="32768" value={display.y} onChange={(event) => updateDisplay(display.id, { y: numberValue(event.target.value) })} /></label>
          <label className="display-check"><input type="checkbox" checked={display.enabled} onChange={(event) => updateDisplay(display.id, { enabled: event.target.checked })} /> ENABLED</label>
          <label className="display-check"><input type="checkbox" checked={display.primary} onChange={(event) => updateDisplay(display.id, { primary: event.target.checked })} /> PRIMARY</label>
        </div>)}</div>}
      </section>

      <section className="host-operations">
        <div><p className="eyebrow">HOST OPERATIONS</p><div className="operation-buttons"><button disabled={actionBusy} onClick={() => void dispatch("COLLECT_DIAGNOSTICS")}>Collect diagnostics</button><button disabled={actionBusy} onClick={() => void dispatch("RESTART_RENDERER")}>Restart interactive renderer</button><button disabled={actionBusy} onClick={() => void dispatch("RESTART_NODE")}>Restart node agent</button></div></div>
        <details className="power-guard"><summary>Guarded power controls</summary><p>The Server must explicitly allow power actions. Type the exact phrase before a command can be sent.</p><label>CONFIRM PHRASE<input type="text" autoComplete="off" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`REBOOT ${nodeId}`} /></label><div><button className="danger" disabled={actionBusy || confirmation !== `REBOOT ${nodeId}`} onClick={() => void dispatch("REBOOT_HOST", {}, confirmation)}>Reboot host</button><button className="danger" disabled={actionBusy || confirmation !== `SHUTDOWN ${nodeId}`} onClick={() => void dispatch("SHUTDOWN_HOST", {}, confirmation)}>Shutdown host</button></div></details>
      </section>

      {warnings.length > 0 && <section className="host-warnings"><b>HOST WARNINGS</b>{warnings.map((warning, index) => <span key={`${warning}-${index}`}>△ {warning}</span>)}</section>}
      {actionError && <div className="action-response rejected"><b>SERVER REJECTED ACTION</b><span>{actionError}</span></div>}
      {lastResult && <details className="action-response accepted"><summary>ACTION ACCEPTED · {lastResult.status ?? "queued"}</summary><pre>{JSON.stringify(lastResult, null, 2)}</pre></details>}
    </article>
  );
}
