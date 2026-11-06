"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PixelProjector,
  PixelProjectorAction,
  PixelProjectorControlState,
} from "../lib/pixel-server";

type Props = {
  control?: PixelProjectorControlState;
  connected: boolean;
  busy: string | null;
  onConfigure: (projectors: PixelProjector[]) => Promise<PixelProjectorControlState>;
  onRefresh: (projectorIds?: string[]) => Promise<PixelProjectorControlState>;
  onAction: (
    action: PixelProjectorAction,
    projectorIds?: string[],
    staggerMs?: number,
  ) => Promise<PixelProjectorControlState>;
};

const DEFAULT_PORT = 1024;

function defaultRows(): PixelProjector[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `projector-${index + 1}`,
    name: `Projector ${index + 1}`,
    outputId: String.fromCharCode(65 + index),
    host: "",
    port: DEFAULT_PORT,
    enabled: false,
    model: "PT-VMZ51",
  }));
}

function stateLabel(projector: PixelProjector) {
  const status = projector.status;
  if (!projector.enabled || !projector.host) return "NOT CONFIGURED";
  if (status?.online === false && status?.state === "error") return "LAN ERROR";
  if (status?.state === "outcome-unknown") return "VERIFY PHYSICAL STATE";
  if (status?.state === "control-error") return "PROJECTOR REJECTED COMMAND";
  if (status?.state === "command-accepted") return "COMMAND SENT";
  if (status?.state === "starting") return "ON · STARTING";
  if (status?.state === "stopping") return "ON · STOPPING";
  if (status?.state === "status-partial") return "ON · STATUS PARTIAL";
  if (status?.power === "on") return status.shutter === "closed" ? "ON · SHUTTER CLOSED" : "ON · LIVE";
  if (status?.power === "standby") return "STANDBY";
  return "NOT CHECKED";
}

function stateClass(projector: PixelProjector) {
  if (!projector.enabled || !projector.host) return "unconfigured";
  if (projector.status?.online === false) return "offline";
  if (["starting", "stopping", "status-partial"].includes(projector.status?.state ?? "")) return "pending";
  if (projector.status?.power === "on") return projector.status?.shutter === "closed" ? "muted" : "online";
  if (projector.status?.power === "standby") return "standby";
  return "pending";
}

function timeLabel(value?: string | null) {
  if (!value) return "Never checked";
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "Unknown time";
  return time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function commandSummary(result: PixelProjectorControlState, action: string) {
  const rows = result.results ?? [];
  const failed = rows.filter((row) => row.ok === false);
  if (failed.length > 0) {
    const ids = failed.map((row) => row.projectorId).filter(Boolean).join(", ");
    const verify = failed.some((row) => row.error?.outcomeUnknown) ? " · REFRESH BEFORE RETRY" : "";
    return `${action}: ${rows.length - failed.length}/${rows.length} accepted · failed ${ids}${verify}`;
  }
  return `${action}: ${rows.length}/${rows.length} accepted`;
}

export function ProjectorControlPanel({ control, connected, busy, onConfigure, onRefresh, onAction }: Props) {
  const [drafts, setDrafts] = useState<PixelProjector[]>(defaultRows);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const hydrated = useRef("");
  const initialRefresh = useRef(false);
  const projectors = useMemo(() => control?.projectors ?? [], [control?.projectors]);
  const enabledIds = useMemo(
    () => projectors.filter((projector) => projector.enabled && projector.host).map((projector) => projector.id),
    [projectors],
  );
  const projectorSlots = Math.max(drafts.length, projectors.length);
  const commandBusy = Boolean(busy?.startsWith("projectors:"));

  useEffect(() => {
    const key = `${control?.updatedAt ?? "default"}:${projectors.map((item) => item.id).join(",")}`;
    if (dirty || hydrated.current === key) return;
    hydrated.current = key;
    const next = projectors.length > 0 ? projectors : defaultRows();
    window.queueMicrotask(() => setDrafts(next.map((projector) => ({ ...projector }))));
  }, [control?.updatedAt, dirty, projectors]);

  useEffect(() => {
    if (!connected || initialRefresh.current || enabledIds.length === 0) return;
    initialRefresh.current = true;
    window.queueMicrotask(() => void onRefresh().catch(() => undefined));
  }, [connected, enabledIds.length, onRefresh]);

  function updateRow(id: string, patch: Partial<PixelProjector>) {
    setDrafts((current) => current.map((projector) => (
      projector.id === id ? { ...projector, ...patch } : projector
    )));
    setDirty(true);
    setNote(null);
  }

  async function save() {
    try {
      const result = await onConfigure(drafts.map((projector) => ({
        id: projector.id,
        name: projector.name,
        outputId: projector.outputId,
        host: projector.host.trim(),
        port: Number(projector.port) || DEFAULT_PORT,
        enabled: Boolean(projector.host.trim()),
        model: "PT-VMZ51",
      })));
      hydrated.current = `${result.updatedAt ?? "saved"}:${(result.projectors ?? []).map((item) => item.id).join(",")}`;
      setDrafts((result.projectors ?? drafts).map((projector) => ({ ...projector })));
      setDirty(false);
      setNote("Saved projector IP bindings on Pixel Server");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Projector configuration was not saved");
    }
  }

  async function refresh(projectorIds?: string[]) {
    try {
      const result = await onRefresh(projectorIds);
      const rows = result.results ?? [];
      const failed = rows.filter((row) => row.ok === false).length;
      setNote(failed > 0 ? `Status: ${rows.length - failed}/${rows.length} reachable` : `Status: ${rows.length}/${rows.length} reachable`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Projector status refresh failed");
    }
  }

  async function action(actionName: PixelProjectorAction, ids?: string[], staggerMs = 0) {
    try {
      const result = await onAction(actionName, ids, staggerMs);
      setNote(commandSummary(result, actionName.toUpperCase().replaceAll("-", " ")));
      const targets = ids ?? enabledIds;
      const verifyAfterMs = actionName === "power-on" ? 60_000 : 1_500;
      window.setTimeout(() => void onRefresh(targets).catch(() => undefined), verifyAfterMs);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Projector command failed");
    }
  }

  return <section className="projector-control-layout">
    <div className="projector-control-hero panel">
      <div>
        <p className="eyebrow">LOCAL NETWORK CONTROL</p>
        <h2>Projector Control</h2>
        <p>Pixel Server talks directly to each configured projector over the local LAN. Video transport stays independent from power, shutter and input control.</p>
      </div>
      <div className="projector-control-summary">
        <span>CONFIGURED <b>{enabledIds.length}/{projectorSlots}</b></span>
        <span>REACHABLE <b>{projectors.filter((item) => item.status?.online).length}/{projectorSlots}</b></span>
        <span>POWER ON <b>{projectors.filter((item) => item.status?.power === "on").length}/{projectorSlots}</b></span>
        <span>SHUTTER OPEN <b>{projectors.filter((item) => item.status?.shutter === "open").length}/{projectorSlots}</b></span>
      </div>
    </div>

    <div className="projector-setup-strip panel">
      <div><b>ACTIVE DRIVER · PANASONIC NTCONTROL · PT-VMZ51</b><span>ADMIN ACCOUNT SET</span><span>COMMAND CONTROL ON</span><span>WEB CONTROL ON</span><span>COMMAND PORT 1024</span><span>COMMAND PROTECT OFF FOR OFFLINE LAN</span><span>STANDBY MODE NORMAL</span><span>PJLINK MAY STAY OFF</span></div>
      <div className={control?.credential?.configured ? "credential-ready" : "credential-optional"}>
        <b>SERVER CREDENTIAL</b>
        <span>{control?.credential?.configured ? "PASSWORD LOADED" : "NOT NEEDED IN UNPROTECTED MODE"}</span>
        <small>{control?.credential?.configured
          ? "Administrator credential stays on Pixel Server and is never sent to this page"
          : "For this isolated LAN, leave Command Protect off; Web Control login remains separate"}</small>
      </div>
    </div>

    <div className="projector-master panel">
      <div className="panel-heading">
        <div><p className="eyebrow">PROJECTOR GROUP</p><h2>Group commands</h2></div>
        <span className={enabledIds.length > 0 ? "live-badge" : "projector-none"}>{enabledIds.length > 0 ? `${enabledIds.length} READY TO ADDRESS` : "SET IP ADDRESSES FIRST"}</span>
      </div>
      <div className="projector-master-actions">
        <button disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void action("power-on", enabledIds, 1_000)}>POWER ALL ON</button>
        <button disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void action("input-hdmi1", enabledIds, 500)}>ALL HDMI 1</button>
        <button disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void action("shutter-open", enabledIds, 500)}>OPEN ALL SHUTTERS</button>
        <button className="shutter" disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void action("shutter-close", enabledIds, 250)}>CLOSE ALL SHUTTERS</button>
        <button className="standby" disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void action("standby", enabledIds, 1_000)}>ALL STANDBY</button>
        <button disabled={!connected || commandBusy || enabledIds.length === 0} onClick={() => void refresh()}>REFRESH STATUS</button>
      </div>
      {note && <p className="projector-action-note" aria-live="polite">{note}</p>}
    </div>

    <div className="projector-card-grid">
      {drafts.map((draft, index) => {
        const live = projectors.find((item) => item.id === draft.id) ?? draft;
        const configured = Boolean(live.enabled && live.host);
        const disabled = !connected || commandBusy || !configured;
        return <article className={`projector-control-card panel ${stateClass(live)}`} key={draft.id}>
          <header>
            <span className="projector-number">{index + 1}</span>
            <div><b>{draft.name || `Projector ${index + 1}`}</b><small>OUTPUT {draft.outputId} · {live.model || control?.model || "CONFIGURED MODEL"}</small></div>
            <strong>{stateLabel(live)}</strong>
          </header>
          <div className="projector-address-fields">
            <label>NAME<input value={draft.name} maxLength={128} onChange={(event) => updateRow(draft.id, { name: event.target.value })} /></label>
            <label>OUTPUT ID<input value={draft.outputId} maxLength={64} onChange={(event) => updateRow(draft.id, { outputId: event.target.value })} /></label>
            <label className="projector-ip">FIXED IP ADDRESS<input inputMode="decimal" placeholder={`192.168.50.${101 + index}`} value={draft.host} maxLength={64} onChange={(event) => updateRow(draft.id, { host: event.target.value, enabled: Boolean(event.target.value.trim()) })} /></label>
            <label>PORT<input type="number" min="1" max="65535" value={draft.port} onChange={(event) => updateRow(draft.id, { port: Number(event.target.value) || DEFAULT_PORT })} /></label>
          </div>
          <dl className="projector-live-state">
            <div><dt>POWER</dt><dd>{live.status?.power ?? "—"}</dd></div>
            <div><dt>LIGHT</dt><dd>{live.status?.light ?? "—"}</dd></div>
            <div><dt>SHUTTER</dt><dd>{live.status?.shutter ?? "—"}</dd></div>
            <div><dt>INPUT</dt><dd>{live.status?.input ?? "—"}</dd></div>
            <div><dt>LIGHT SOURCE RUNTIME</dt><dd>{live.status?.lightHours ?? "—"}</dd></div>
            <div><dt>CHECKED</dt><dd>{timeLabel(live.status?.checkedAt)}</dd></div>
          </dl>
          {live.status?.error?.message && <p className="projector-error">{live.status.error.message}</p>}
          <div className="projector-device-actions">
            <button disabled={disabled} onClick={() => void action("power-on", [draft.id])}>POWER ON</button>
            <button disabled={disabled} onClick={() => void action("standby", [draft.id])}>STANDBY</button>
            <button disabled={disabled} onClick={() => void action("shutter-open", [draft.id])}>SHUTTER OPEN</button>
            <button disabled={disabled} onClick={() => void action("shutter-close", [draft.id])}>SHUTTER CLOSE</button>
            <select aria-label={`${draft.name} input`} disabled={disabled} defaultValue="" onChange={(event) => {
              if (event.target.value) void action(event.target.value as PixelProjectorAction, [draft.id]);
              event.target.value = "";
            }}>
              <option value="">SELECT INPUT…</option>
              <option value="input-hdmi1">HDMI 1</option>
              <option value="input-hdmi2">HDMI 2</option>
              <option value="input-digital-link">DIGITAL LINK</option>
            </select>
            <button disabled={disabled} onClick={() => void refresh([draft.id])}>REFRESH</button>
          </div>
          {live.webControlUrl && <a className="projector-web-link" href={live.webControlUrl} target="_blank" rel="noreferrer">OPEN DEVICE WEB CONTROL ↗</a>}
        </article>;
      })}
    </div>

    <div className="projector-save panel">
      <div><b>IP inventory is stored on Pixel Server</b><span>Each projector is explicitly bound to an output ID. Shutter closes picture/audio but does not power off the light source.</span></div>
      <button disabled={!connected || commandBusy || !dirty} onClick={() => void save()}>{busy === "projectors:configure" ? "SAVING…" : dirty ? "SAVE PROJECTOR IPs" : "PROJECTOR IPs SAVED"}</button>
    </div>
  </section>;
}
