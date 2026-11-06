"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PixelShowScheduleConfig,
  PixelShowScheduleDayName,
  PixelShowScheduleSnapshot,
} from "../lib/pixel-server";
import { PixelServerError } from "../lib/pixel-server";

type Props = {
  connected: boolean;
  busy: string | null;
  onLoad: (signal?: AbortSignal) => Promise<PixelShowScheduleSnapshot>;
  onSave: (schedule: PixelShowScheduleConfig, expectedRevision: number) => Promise<PixelShowScheduleSnapshot>;
};

const DAY_META: Array<{ day: PixelShowScheduleDayName; short: string; label: string }> = [
  { day: "monday", short: "MON", label: "Monday" },
  { day: "tuesday", short: "TUE", label: "Tuesday" },
  { day: "wednesday", short: "WED", label: "Wednesday" },
  { day: "thursday", short: "THU", label: "Thursday" },
  { day: "friday", short: "FRI", label: "Friday" },
  { day: "saturday", short: "SAT", label: "Saturday" },
  { day: "sunday", short: "SUN", label: "Sunday" },
];

const EMPTY_CONFIG: PixelShowScheduleConfig = {
  schemaVersion: 1,
  enabled: false,
  nodeId: "",
  arenaExecutablePath: null,
  arenaCompositionPath: null,
  projectorStartupEnabled: true,
  projectorStandbyEnabled: true,
  projectorStaggerMs: 1_000,
  projectorWarmupSeconds: 60,
  days: DAY_META.map(({ day }) => ({ day, enabled: false, startTime: "09:00", shutdownTime: "20:00" })),
};

function configFromSnapshot(snapshot: PixelShowScheduleSnapshot): PixelShowScheduleConfig {
  return {
    schemaVersion: 1,
    enabled: Boolean(snapshot.enabled),
    nodeId: snapshot.nodeId ?? "",
    arenaExecutablePath: snapshot.arenaExecutablePath ?? null,
    arenaCompositionPath: snapshot.arenaCompositionPath ?? null,
    projectorStartupEnabled: Boolean(snapshot.projectorStartupEnabled),
    projectorStandbyEnabled: Boolean(snapshot.projectorStandbyEnabled),
    projectorStaggerMs: Number(snapshot.projectorStaggerMs) || 0,
    projectorWarmupSeconds: Number(snapshot.projectorWarmupSeconds) || 0,
    days: DAY_META.map(({ day }) => {
      const source = snapshot.days.find((item) => item.day === day);
      return source
        ? { day, enabled: Boolean(source.enabled), startTime: source.startTime, shutdownTime: source.shutdownTime }
        : { day, enabled: false, startTime: "09:00", shutdownTime: "20:00" };
    }),
  };
}

function localDateTime(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleString([], {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nextEventLabel(snapshot: PixelShowScheduleSnapshot | null) {
  const event = snapshot?.nextEvent;
  if (!event) return "NO EVENT SCHEDULED";
  return `${event.type.toUpperCase()} · ${event.day.slice(0, 3).toUpperCase()} ${event.localTime}`;
}

function validationMessage(draft: PixelShowScheduleConfig) {
  const nodeId = draft.nodeId.trim();
  const arenaExecutablePath = draft.arenaExecutablePath?.trim() ?? "";
  const arenaCompositionPath = draft.arenaCompositionPath?.trim() ?? "";
  const absoluteWindowsPath = (value: string) => /^[A-Za-z]:\\/.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value);
  if (nodeId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) return "Windows node ID contains unsupported characters.";
  if (arenaExecutablePath && (!absoluteWindowsPath(arenaExecutablePath) || !arenaExecutablePath.toLowerCase().endsWith(".exe"))) return "Enter the exact absolute Resolume Arena .exe path.";
  if (arenaCompositionPath && (!absoluteWindowsPath(arenaCompositionPath) || !arenaCompositionPath.toLowerCase().endsWith(".avc"))) return "Enter the exact absolute Arena composition .avc path.";
  if (draft.days.some((day) => !day.startTime || !day.shutdownTime || day.startTime >= day.shutdownTime)) {
    return "Every day must start before shutdown on the same day.";
  }
  if (!draft.enabled) return null;
  if (!nodeId) return "Choose the Windows render node before enabling automation.";
  if (!arenaExecutablePath) return "Enter the exact absolute Resolume Arena .exe path.";
  if (!arenaCompositionPath) return "Enter the exact absolute Arena composition .avc path.";
  if (!draft.days.some((day) => day.enabled)) return "Enable at least one operating day.";
  return null;
}

function ScheduleSwitch({ checked, label, onChange }: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return <button
    type="button"
    className={`schedule-switch ${checked ? "is-on" : ""}`}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
  ><span /></button>;
}

export function ShowSchedulePanel({ connected, busy, onLoad, onSave }: Props) {
  const [snapshot, setSnapshot] = useState<PixelShowScheduleSnapshot | null>(null);
  const [draft, setDraft] = useState<PixelShowScheduleConfig>(EMPTY_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [heartbeatNow, setHeartbeatNow] = useState(0);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const draftRevisionRef = useRef<number | null>(null);
  const editGenerationRef = useRef(0);

  const activeDays = useMemo(() => draft.days.filter((day) => day.enabled).length, [draft.days]);
  const validation = validationMessage(draft);
  const saving = busy === "show-schedule:save";
  const workerUpdatePending = Boolean(
    snapshot?.updatedAt && snapshot.runtime?.scheduleUpdatedAt !== snapshot.updatedAt,
  );
  const runtimeUpdatedAt = snapshot?.runtime?.updatedAt ? Date.parse(snapshot.runtime.updatedAt) : Number.NaN;
  const workerStale = Boolean(snapshot?.runtime) && (
    !Number.isFinite(runtimeUpdatedAt) || (heartbeatNow > 0 && heartbeatNow - runtimeUpdatedAt > 45_000)
  );
  const workerOffline = Boolean(snapshot?.enabled) && (!snapshot?.runtime || workerStale);
  const workerLabel = workerOffline
    ? "WORKER OFFLINE"
    : workerUpdatePending
    ? "UPDATE PENDING"
    : snapshot?.runtime?.state?.toUpperCase() ?? "NO RESULT";

  useEffect(() => {
    const updateClock = () => setHeartbeatNow(Date.now());
    window.queueMicrotask(updateClock);
    const timer = window.setInterval(updateClock, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected) {
      window.queueMicrotask(() => setLoading(false));
      return;
    }
    const controller = new AbortController();
    let alive = true;
    async function refreshSchedule(initial = false) {
      if (savingRef.current) return;
      const requestGeneration = ++requestGenerationRef.current;
      if (initial) setLoading(true);
      try {
        const next = await onLoad(controller.signal);
        if (!alive || savingRef.current || requestGeneration !== requestGenerationRef.current) return;
        setSnapshot(next);
        if (draftRevisionRef.current == null) draftRevisionRef.current = next.revision;
        if (!dirtyRef.current) {
          setDraft(configFromSnapshot(next));
          draftRevisionRef.current = next.revision;
          setNote(null);
        }
      } catch (error) {
        if (!alive || (error instanceof DOMException && error.name === "AbortError")) return;
        setNote(error instanceof Error ? error.message : "Show schedule is unavailable");
      } finally {
        if (alive && initial) setLoading(false);
      }
    }
    window.queueMicrotask(() => void refreshSchedule(true));
    const timer = window.setInterval(() => void refreshSchedule(), 30_000);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [connected, onLoad]);

  function markDirty() {
    editGenerationRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setNote(null);
  }

  function patchDraft(patch: Partial<PixelShowScheduleConfig>) {
    setDraft((current) => ({ ...current, ...patch }));
    markDirty();
  }

  function patchDay(day: PixelShowScheduleDayName, patch: Partial<PixelShowScheduleConfig["days"][number]>) {
    setDraft((current) => ({
      ...current,
      days: current.days.map((item) => item.day === day ? { ...item, ...patch, day } : item),
    }));
    markDirty();
  }

  function applyPreset(name: "all" | "weekdays" | "weekend" | "off") {
    const enabled = new Set<PixelShowScheduleDayName>(
      name === "all" ? DAY_META.map((item) => item.day)
        : name === "weekdays" ? DAY_META.slice(0, 5).map((item) => item.day)
          : name === "weekend" ? DAY_META.slice(5).map((item) => item.day)
            : [],
    );
    setDraft((current) => ({
      ...current,
      days: current.days.map((item) => ({ ...item, enabled: enabled.has(item.day) })),
    }));
    markDirty();
  }

  async function save() {
    if (savingRef.current) return;
    if (validation) {
      setNote(validation);
      return;
    }
    const payload: PixelShowScheduleConfig = {
      ...draft,
      schemaVersion: 1,
      nodeId: draft.nodeId.trim(),
      arenaExecutablePath: draft.arenaExecutablePath?.trim() || null,
      arenaCompositionPath: draft.arenaCompositionPath?.trim() || null,
      projectorStaggerMs: Math.max(0, Math.min(2_000, Math.round(draft.projectorStaggerMs))),
      projectorWarmupSeconds: Math.max(0, Math.min(600, Math.round(draft.projectorWarmupSeconds))),
      days: DAY_META.map(({ day }) => {
        const item = draft.days.find((candidate) => candidate.day === day);
        return item
          ? { day, enabled: Boolean(item.enabled), startTime: item.startTime, shutdownTime: item.shutdownTime }
          : { day, enabled: false, startTime: "09:00", shutdownTime: "20:00" };
      }),
    };
    const expectedRevision = draftRevisionRef.current;
    if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
      setNote("Reload the current weekly schedule before saving.");
      return;
    }
    const requestGeneration = ++requestGenerationRef.current;
    const editGeneration = editGenerationRef.current;
    savingRef.current = true;
    try {
      const saved = await onSave(payload, Number(expectedRevision));
      if (requestGeneration !== requestGenerationRef.current) return;
      setSnapshot(saved);
      draftRevisionRef.current = saved.revision;
      if (editGeneration === editGenerationRef.current) {
        dirtyRef.current = false;
        setDirty(false);
        setDraft(configFromSnapshot(saved));
        setNote("Weekly show schedule saved on Pixel Server.");
      } else {
        setNote("The clicked revision was saved; newer edits remain unsaved.");
      }
    } catch (error) {
      if (error instanceof PixelServerError && error.status === 412) {
        try {
          const latest = await onLoad();
          setSnapshot(latest);
          draftRevisionRef.current = latest.revision;
          setNote("This schedule changed elsewhere. The latest revision was loaded for comparison; your draft is preserved. Review it, then save again to confirm.");
        } catch (reloadError) {
          setNote(reloadError instanceof Error ? reloadError.message : "The latest weekly schedule could not be reloaded");
        }
        return;
      }
      setNote(error instanceof Error ? error.message : "Weekly show schedule was not saved");
    } finally {
      savingRef.current = false;
    }
  }

  const lastEvent = snapshot?.runtime?.lastAction ?? null;

  return <section className="schedule-control-layout">
    <div className="schedule-hero panel">
      <div>
        <p className="eyebrow">WINDOWS LOCAL TIME · WEEKLY SHOW AUTOMATION</p>
        <h2>Open the room ready for the customer</h2>
        <p>After Windows starts, the worker opens the exact Arena composition, powers the projector group and leaves the system ready for the scheduled show.</p>
      </div>
      <div className="schedule-summary" aria-label="Schedule status summary">
        <span>AUTOMATION <b className={snapshot?.enabled ? "good" : "muted"}>{snapshot?.enabled ? "ENABLED" : "DISABLED"}</b></span>
        <span>ACTIVE DAYS <b>{activeDays}/7</b></span>
        <span>NEXT EVENT <b>{nextEventLabel(snapshot)}</b></span>
        <span>WINDOWS WORKER <b className={workerOffline || ["error", "shutdown-blocked"].includes(snapshot?.runtime?.state ?? "") ? "bad" : workerUpdatePending ? "muted" : ""}>{workerLabel}</b></span>
      </div>
    </div>

    <div className="schedule-prerequisites panel">
      <div><span>01</span><b>BIOS / UEFI CONTROLS PHYSICAL WAKE</b><small>Configure RTC wake on the same active weekdays. This schedule cannot switch on a physically powered-off computer.</small></div>
      <div><span>02</span><b>WINDOWS AUTO-LOGON REQUIRED</b><small>Use the dedicated local Show account. Arena is interactive and cannot run from Windows Session 0.</small></div>
      <div><span>03</span><b>SAFE DAILY SHUTDOWN</b><small>SAVE ARENA → CLOSE ARENA → PROJECTORS STANDBY → WINDOWS SHUTDOWN. There is no immediate shutdown control on this page.</small></div>
    </div>

    <div className="schedule-week panel">
      <div className="schedule-section-heading">
        <div><p className="eyebrow">OPERATING WEEK</p><h2>Active days and local times</h2></div>
        <div className="schedule-master"><span><b>{draft.enabled ? "AUTOMATION ON" : "AUTOMATION OFF"}</b><small>Master weekly schedule</small></span><ScheduleSwitch checked={draft.enabled} label="Enable weekly show automation" onChange={(enabled) => patchDraft({ enabled })} /></div>
      </div>
      <div className="schedule-presets" aria-label="Day presets">
        <button type="button" onClick={() => applyPreset("all")}>ALL 7 DAYS</button>
        <button type="button" onClick={() => applyPreset("weekdays")}>MON–FRI · WEEKEND OFF</button>
        <button type="button" onClick={() => applyPreset("weekend")}>WEEKEND ONLY</button>
        <button type="button" onClick={() => applyPreset("off")}>WEEK OFF</button>
      </div>
      <p className="schedule-preset-note">Presets only edit this draft. Nothing starts or stops until its scheduled time.</p>
      <div className="schedule-table-scroll">
        <table className="schedule-table">
          <thead><tr><th>DAY</th><th>ACTIVE</th><th>START</th><th>SHUTDOWN</th></tr></thead>
          <tbody>{DAY_META.map((meta) => {
            const day = draft.days.find((item) => item.day === meta.day) ?? EMPTY_CONFIG.days[0];
            return <tr key={meta.day} className={day.enabled ? "active" : "closed"}>
              <th scope="row"><span>{meta.short}</span><b>{meta.label}</b></th>
              <td><ScheduleSwitch checked={day.enabled} label={`Enable ${meta.label}`} onChange={(enabled) => patchDay(meta.day, { enabled })} /></td>
              <td><label><span className="sr-only">{meta.label} start time</span><input type="time" step="60" value={day.startTime} disabled={!day.enabled} onChange={(event) => patchDay(meta.day, { startTime: event.target.value })} /></label></td>
              <td><label><span className="sr-only">{meta.label} shutdown time</span><input type="time" step="60" value={day.shutdownTime} disabled={!day.enabled} onChange={(event) => patchDay(meta.day, { shutdownTime: event.target.value })} /></label></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </div>

    <div className="schedule-side-stack">
      <div className="schedule-paths panel">
        <div className="schedule-section-heading"><div><p className="eyebrow">EXACT WINDOWS TARGET</p><h2>Arena startup</h2></div></div>
        <label>WINDOWS NODE ID<input value={draft.nodeId} maxLength={128} placeholder="windows-render-01" onChange={(event) => patchDraft({ nodeId: event.target.value })} /></label>
        <label>RESOLUME ARENA .EXE<input value={draft.arenaExecutablePath ?? ""} maxLength={2_048} spellCheck={false} placeholder="C:\Program Files\Resolume Arena\Arena.exe" onChange={(event) => patchDraft({ arenaExecutablePath: event.target.value || null })} /></label>
        <label>ARENA COMPOSITION .AVC<input value={draft.arenaCompositionPath ?? ""} maxLength={2_048} spellCheck={false} placeholder="C:\Shows\Main Show.avc" onChange={(event) => patchDraft({ arenaCompositionPath: event.target.value || null })} /></label>
        <small>Use complete Windows paths. The worker never searches for a similarly named program or composition.</small>
      </div>

      <div className="schedule-projectors panel">
        <div className="schedule-section-heading"><div><p className="eyebrow">PROJECTOR SEQUENCE</p><h2>Startup and standby</h2></div></div>
        <div className="schedule-option"><span><b>POWER ON AT START</b><small>Use the saved Projector Control group</small></span><ScheduleSwitch checked={draft.projectorStartupEnabled} label="Power on projectors at scheduled start" onChange={(projectorStartupEnabled) => patchDraft({ projectorStartupEnabled })} /></div>
        <div className="schedule-option"><span><b>STANDBY AT SHUTDOWN</b><small>Send standby during the safe close sequence</small></span><ScheduleSwitch checked={draft.projectorStandbyEnabled} label="Put projectors in standby at scheduled shutdown" onChange={(projectorStandbyEnabled) => patchDraft({ projectorStandbyEnabled })} /></div>
        <div className="schedule-number-grid">
          <label>WARMUP · SECONDS<input type="number" min="0" max="600" step="5" value={draft.projectorWarmupSeconds} onChange={(event) => patchDraft({ projectorWarmupSeconds: Number(event.target.value) || 0 })} /></label>
          <label>STAGGER · MILLISECONDS<input type="number" min="0" max="2000" step="250" value={draft.projectorStaggerMs} onChange={(event) => patchDraft({ projectorStaggerMs: Number(event.target.value) || 0 })} /></label>
        </div>
      </div>

      <div className={`schedule-runtime panel ${workerOffline ? "offline" : workerUpdatePending ? "pending" : snapshot?.runtime?.state ?? "idle"}`}>
        <div className="schedule-section-heading"><div><p className="eyebrow">LAST WINDOWS WORKER RESULT</p><h2>{workerOffline ? "Worker offline or stale" : workerUpdatePending ? "Schedule update pending" : snapshot?.runtime?.state?.toUpperCase() ?? "No run recorded"}</h2></div><span className="schedule-runtime-dot" /></div>
        {snapshot?.runtime ? <dl>
          <div><dt>CURRENT PHASE</dt><dd>{snapshot.runtime.phase.replaceAll("-", " ")}</dd></div>
          <div><dt>UPDATED</dt><dd>{localDateTime(snapshot.runtime.updatedAt)}</dd></div>
          <div><dt>LAST ACTION</dt><dd>{lastEvent ? `${lastEvent.type.toUpperCase()} · ${lastEvent.status.toUpperCase()}` : "—"}</dd></div>
          <div><dt>COMPLETED</dt><dd>{localDateTime(lastEvent?.completedAt)}</dd></div>
        </dl> : <p>No scheduler result has been reported by the Windows worker yet.</p>}
        {(snapshot?.runtime?.workerMessage || lastEvent?.message) && <p className={`schedule-runtime-message ${lastEvent?.status === "failed" || workerOffline ? "failed" : ""}`}>{snapshot?.runtime?.workerMessage || lastEvent?.message}</p>}
      </div>
    </div>

    <div className="schedule-save panel">
      <div><b>{validation ?? (dirty ? "Schedule changes are ready to save." : loading ? "Loading the weekly schedule…" : "Weekly schedule is saved.")}</b><span>Saving never triggers an immediate action. Changes saved after today’s start time wait for the next active day; a running show keeps its original shutdown plan.</span></div>
      <button type="button" disabled={!connected || !snapshot || loading || saving || !dirty || Boolean(validation)} onClick={() => void save()}>{saving ? "SAVING…" : dirty ? "SAVE WEEKLY SCHEDULE" : "SCHEDULE SAVED"}</button>
      {note && <p className={validation ? "warning" : ""} aria-live="polite">{note}</p>}
    </div>
  </section>;
}
