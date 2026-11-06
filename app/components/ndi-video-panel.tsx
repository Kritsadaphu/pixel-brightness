"use client";
import { useEffect, useMemo, useState } from "react";
import { createPixelServerClient, type NdiVideoState } from "../lib/pixel-server";

export function NdiVideoPanel({ baseUrl, connected, revision, outputs }: {
  baseUrl: string; connected: boolean; revision: number; outputs: Array<{ id: string; name: string }>;
}) {
  const client = useMemo(() => createPixelServerClient(baseUrl), [baseUrl]);
  const [state, setState] = useState<NdiVideoState | null>(null);
  const [sources, setSources] = useState<Array<{ name: string; address: string }>>([]);
  const [sourceName, setSourceName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const job = state?.job;
  const active = Boolean(job && !["stopped", "failed"].includes(job.state));
  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await client.ndiVideo(abort.signal); if (!abort.signal.aborted) { setState(value); setStatusError(""); } }
      catch (e) { if (!abort.signal.aborted) { setState(null); setStatusError(e instanceof Error ? e.message : "อ่านสถานะไม่ได้"); } }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1500);
    }
    void poll(); return () => { abort.abort(); clearTimeout(timer); };
  }, [client, connected]);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError("");
    try { await run(); } catch (e) { setError(e instanceof Error ? e.message : "ทำรายการไม่สำเร็จ"); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-labelledby="ndi-video-heading">
    <div className="panel-heading"><div><p className="eyebrow">ARENA → PIXEL → NDI</p><h2 id="ndi-video-heading">ส่งภาพที่ปรับแล้วผ่าน NDI</h2></div><span className="live-badge">DEVELOPMENT PREVIEW</span></div>
    <p>ใช้ Area, Warp, Blend และสีจากโปรเจกต์ที่ Save แล้ว รุ่นทดสอบนี้ยังไม่โหลด measured maps/LUT และไม่สลับ Source ของกล่องรับให้เอง</p>
    {statusError && <p role="status">{statusError}</p>}
    <div className="control-group"><label htmlFor="ndi-video-source">Arena NDI Source (ขนาดและ FPS ต้องตรง Composition ที่บันทึก)</label>
      <select id="ndi-video-source" value={sourceName} disabled={active || busy} onChange={e => setSourceName(e.target.value)}>
        <option value="">เลือก Source</option>{sources.map(s => <option key={`${s.name}:${s.address}`} value={s.name}>{s.name}</option>)}
      </select>
      <button disabled={!connected || !state?.enabled || busy || active} onClick={() => void action(async () => {
        const value = await client.ndiSources(); setSources(value.sources);
        if (!value.sources.some(s => s.name === sourceName)) setSourceName("");
      })}>ค้นหา NDI</button>
    </div>
    <fieldset disabled={active || busy}><legend>Output ที่จะส่ง (1–5 ตัว)</legend>
      {outputs.map(o => <label key={o.id} style={{ display: "block", padding: "0.4rem 0" }}><input type="checkbox" checked={selected.includes(o.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, o.id] : ids.filter(id => id !== o.id))} /> {o.name}</label>)}
    </fieldset>
    <div className="editor-toolbar">
      <button disabled={!connected || !state?.enabled || busy || active || !sourceName || !selected.length || selected.length > 5 || !revision} onClick={() => void action(async () => {
        setState(await client.startNdiVideo({ expectedRevision: revision, sourceName, outputIds: selected }));
      })}>เริ่มด้วยภาพดำ · Saved revision {revision || "—"}</button>
      {active && job && <>
        <button disabled={busy || !connected || job.state === "revision-changed"} onClick={() => void action(async () => { setState(await client.blankNdiVideo(job.id, false)); })}>แสดงภาพ</button>
        <button disabled={busy || !connected} onClick={() => void action(async () => { setState(await client.blankNdiVideo(job.id, true)); })}>ส่งดำ</button>
        <button disabled={busy || !connected} onClick={() => void action(async () => { setState(await client.stopNdiVideo(job.id)); })}>หยุด NDI ทดสอบ</button>
      </>}
    </div>
    {job && <div aria-live="polite"><p>สถานะ: {job.state} · Revision {job.revision}</p>
      <ul>{job.sources.map(s => <li key={s.outputId}>{s.outputId}: <code>{s.name}</code></li>)}</ul>
      {job.telemetry && <><p>ต้นทาง: {job.telemetry.sourceValid ? "รับภาพตรงขนาด/FPS" : "ยังไม่มีภาพที่ตรงขนาด/FPS"} · {job.telemetry.black ? "กำลังส่งดำ" : "กำลังส่งภาพ"}</p>
        {job.telemetry.outputs.map(o => <p key={o.outputId}>{o.outputId}: ตัวรับ {o.connections} · ส่ง {o.sentFrames.toLocaleString()} เฟรม · Readback เต็ม {o.readbackBackpressure}
          {Number(job.telemetry?.elapsedSeconds) > 0 && <> · เฉลี่ยตั้งแต่เริ่ม {(o.sentFrames / Number(job.telemetry?.elapsedSeconds)).toFixed(1)} fps (ตั้งไว้ {job.expectedFps ?? "—"})</>}
        </p>)}</>}
      {job.state === "revision-changed" && <p>โปรเจกต์เปลี่ยนแล้ว จึงส่งดำ ให้หยุดและเริ่มใหม่เพื่อใช้ค่าที่ Save ล่าสุด</p>}
      {(job.error || job.cleanupError) && <p role="alert">{job.error} {job.cleanupError}</p>}
      <p>จำนวนตัวรับไม่ยืนยันภาพบนโปรเจคเตอร์ หลังทดสอบให้คืน Source เดิมของกล่อง NDI</p>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
