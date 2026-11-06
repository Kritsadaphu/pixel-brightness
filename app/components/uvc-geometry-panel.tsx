"use client";

import { useEffect, useMemo, useState } from "react";
import { createPixelServerClient, type UvcGeometryState } from "../lib/pixel-server";

const terminal = new Set(["failed", "cancelled", "candidate-not-applied", "applied-to-project", "restored-to-project"]);
const labels: Record<string, string> = {
  preflight: "กำลังตรวจกล้อง", "awaiting-routing": "รอเชื่อม Source ทดสอบ",
  capturing: "กำลังฉายแพตเทิร์นและรับภาพ", cancelling: "กำลังหยุดงาน",
  cancelled: "ยกเลิกแล้ว", failed: "ทดสอบไม่ผ่าน", "candidate-not-applied": "บันทึกผล Geometry แล้ว — ยังไม่ปรับภาพจริง",
  "applied-to-project": "บันทึก Warp เข้าชุดค่าจริงแล้ว — ยังต้องตรวจภาพ Output",
  "restored-to-project": "คืนชุดค่าก่อนวัดแล้ว",
  "building-blend": "กำลังสร้างแผนที่น้ำหนักรอยต่อจาก Warp",
  "routing-receivers": "กำลังสลับ Source และตรวจการเชื่อมต่อ NDI",
  finalizing: "กำลังบันทึกผลการวัด",
};
type Output = { id: string; name: string; width: number; height: number };
export function UvcGeometryPanel({ baseUrl, connected, outputs, revision }: { baseUrl: string; connected: boolean; outputs: Output[]; revision: number }) {
  const client = useMemo(() => createPixelServerClient(baseUrl), [baseUrl]);
  const [state, setState] = useState<UvcGeometryState | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [devices, setDevices] = useState<Array<{ id: string; name: string }>>([]);
  const [deviceId, setDeviceId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [applyTarget, setApplyTarget] = useState(false);
  const [autoBlend, setAutoBlend] = useState(false);
  const [autoRoute, setAutoRoute] = useState(false);
  const [autoPhotometry, setAutoPhotometry] = useState(false);
  const [targetArea, setTargetArea] = useState({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  const job = state?.job;
  const running = Boolean(job && !terminal.has(job.state));
  const selectedOutputs = outputs.filter(o => selected.includes(o.id));
  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const value = await client.uvcGeometry(abort.signal); if (!abort.signal.aborted) { setState(value); setStatusError(""); } }
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
  return <section className="panel" aria-labelledby="uvc-geometry-heading">
    <div className="panel-heading"><div><p className="eyebrow">R50 USB · NDI · GEOMETRY</p>
      <h2 id="uvc-geometry-heading">วัดตำแหน่งด้วยกล้อง USB</h2>
      <p>วัดตำแหน่งและสร้าง Blend จาก Warp พร้อมโหมดทดลองวัดระดับเทา RGB เพื่อประมาณ Black lift ความสว่าง และสมดุลสี ต้องตรวจผลบนพื้นที่ฉายจริงก่อนใช้งาน</p>
    </div><span className="live-badge">GEOMETRY DEVELOPMENT</span></div>
    {!connected ? <p role="status">ยังไม่เชื่อมต่อ Pixel Server</p> : statusError ? <p role="status">{statusError}</p> : null}
    <div className="control-group">
      <label htmlFor="uvc-camera-device">กล้องที่ต่อกับ Windows เครื่องเซิร์ฟเวอร์</label>
      <select id="uvc-camera-device" value={deviceId} disabled={busy || running} onChange={e => setDeviceId(e.target.value)}>
        <option value="">เลือกกล้อง USB</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button disabled={!connected || !state?.enabled || busy || running} onClick={() => void action(async () => {
        const value = await client.uvcDevices(); setDevices(value.devices);
        if (!value.devices.some(d => d.id === deviceId)) setDeviceId("");
        if (!value.devices.length) setError("ไม่พบกล้อง USB ตรวจแบตและโหมด USB streaming ของ R50");
      })}>ค้นหากล้อง</button>
      <p>NDI Webcam เป็นกล้องเสมือน เลือกตัว R50/Canon ที่เชื่อม USB โดยตรงสำหรับขั้นตอนนี้</p>
    </div>
    <fieldset disabled={busy || running}><legend>Output ที่จะวัด (ไม่เกิน 5 ตัว)</legend>
      {outputs.map(o => <label key={o.id} style={{ display: "block", padding: "0.4rem 0" }}>
        <input type="checkbox" checked={selected.includes(o.id)} onChange={e => setSelected(current => e.target.checked ? [...current, o.id] : current.filter(id => id !== o.id))} />
        {" "}{o.name} · {o.width} × {o.height}
      </label>)}
    </fieldset>
    <fieldset disabled={busy || running}><legend>พื้นที่เป้าหมายของ Composition ในภาพกล้อง</legend>
      <label><input type="checkbox" checked={applyTarget} onChange={e => { setApplyTarget(e.target.checked); if (!e.target.checked) { setAutoBlend(false); setAutoPhotometry(false); } }} /> คำนวณ Warp สำหรับพื้นที่นี้</label>
      <p>พิกัด 0–1: จุดซ้ายบนคือ 0,0 ต้องเลือกพื้นที่ที่กล้องมองเห็นและแพตเทิร์นครอบคลุม ระบบใช้ Source viewport ที่บันทึกไว้แบ่งพื้นที่ให้แต่ละ Output</p>
      {applyTarget && (Object.keys(targetArea) as Array<keyof typeof targetArea>).map(key => <label key={key} style={{ display: "inline-block", margin: "0.5rem" }}>{key}
        <input aria-label={`Target ${key}`} type="number" min="0" max="1" step="0.01" value={targetArea[key]} onChange={e => setTargetArea(a => ({ ...a, [key]: Number(e.target.value) }))} />
      </label>)}
      {applyTarget && <div><label><input type="checkbox" checked={autoBlend} onChange={e => { setAutoBlend(e.target.checked); if (!e.target.checked) setAutoPhotometry(false); }} /> สร้าง Blend จากพื้นที่ซ้อนทับด้วย</label>
        <p>ต้องเลือกทุก Output ที่เปิดใช้บนพื้นผิวเดียวกัน เมื่อ Apply จะแทนที่แผนที่ Blend เดิมโดยสำรองไว้ก่อน ส่วน Black และสีคงเดิม ค่านี้ยังไม่ชดเชยความสว่างหรือสีที่ต่างกันของแต่ละเครื่อง</p></div>}
      {applyTarget && autoBlend && <div><label><input type="checkbox" checked={autoPhotometry} onChange={e => setAutoPhotometry(e.target.checked)} /> ทดลองประมาณ Black / ความสว่าง / สมดุล RGB จาก USB</label>
        <p>เลือกได้เมื่อคุณล็อก Exposure, White Balance และ Focus แล้ว และใช้ภาพ SDR ปิด HDR/ฟิลเตอร์ โหมดนี้สมมติการตอบสนองกล้องเป็น sRGB ไม่ใช่ RAW หรือการวัดสีมาตรฐาน หากค่าเปลี่ยน ภาพล้น หรือวัดไม่ครบ ระบบจะไม่ให้ Apply</p>
        <p>การเลือกช่องนี้ยืนยันการล็อกค่ากล้องและยอมรับสมมติฐานข้างต้น เมื่อ Apply จะแทนที่ Black map, RGB gain/gamma/offset และ LUT เดิมพร้อมสำรองค่าไว้ Black lift ทำให้ส่วนมืดสว่างขึ้นเพื่อให้เสมอกัน ไม่ได้ทำให้โปรเจคเตอร์ดำสนิทขึ้น</p></div>}
    </fieldset>
    <div className="editor-toolbar">
      <label><input type="checkbox" checked={autoRoute} disabled={!state?.routing?.enabled || busy || running}
        onChange={e => setAutoRoute(e.target.checked)} /> สลับและคืน Source กล่อง NDI อัตโนมัติ</label>
      {!state?.routing?.enabled && <p>ยังไม่ได้ตั้งโปรไฟล์กล่อง NDI และสิทธิ์ API บน Windows — การสลับ Source ยังเป็นแบบทำเอง</p>}
      {state?.routing?.pendingRecovery && <p role="alert">มีการคืน Source ค้างอยู่ ต้องคืนก่อนเริ่มการวัดใหม่</p>}
      {state?.routing?.pendingRecovery && state.routing.jobId && !running && <button disabled={busy} onClick={() => void action(async () => {
        setState(await client.restoreUvcRouting(state.routing!.jobId!));
      })}>ตรวจและคืน Source ที่ค้าง</button>}
      <button disabled={!state?.enabled || !connected || busy || running || !deviceId || !selectedOutputs.length || selectedOutputs.length > 5}
        onClick={() => void action(async () => {
          const result = await client.startUvcGeometry({
            deviceId,
            autoRoute,
            ...(applyTarget ? { expectedRevision: revision, targetArea, autoBlend,
              ...(autoPhotometry ? { autoPhotometry: true, cameraResponse: 'srgb-assumed' as const, cameraSettingsLocked: true } : {}) } : {}),
            outputs: selectedOutputs.map(({ id, width, height }) => ({ id, width, height })),
          });
          setState(result);
        })}>
        สร้าง Source ทดสอบ
      </button>
      {running && job && <button disabled={busy} onClick={() => void action(async () => setState(await client.cancelUvcGeometry(job.id)))}>ยกเลิกการวัด</button>}
    </div>
    {job && <div aria-live="polite"><h3>{labels[job.state] || job.state}</h3><p>รับภาพแล้ว {job.completedCaptures} เฟรม</p>
      {job.state === "awaiting-routing" && <>
        <p>เลือก Source ด้านล่างให้ตรง Output ในกล่อง NDI และจด Source เดิมไว้ก่อน จากนั้นยืนยันเพื่อเริ่มวัด</p>
        <ul>{job.sources.map(s => <li key={s.outputId}><strong>{s.outputId}</strong>: <code>{s.name}</code></li>)}</ul>
        <button disabled={busy} onClick={() => void action(async () => setState(await client.confirmUvcRouting(job.id)))}>เชื่อม Source ตรงจอแล้ว — เริ่มวัด</button>
      </>}
      {job.error && <p role="alert">{job.error}</p>}
      {job.applyAvailable && <button disabled={busy || revision !== job.baseRevision} onClick={() => void action(async () => {
        setState(await client.applyUvcGeometry(job.id, job.baseRevision!));
      })}>{job.photometryGenerated ? "สำรองค่าเดิมและใช้ Warp + Blend + USB Black/RGB (ทดลอง)" : job.blendGenerated ? "สำรองค่าเดิมและใช้ Warp + Blend" : "สำรองค่าเดิมและใช้ Warp ที่วัดได้"}</button>}
      {job.blendGenerated && <p>สร้าง Blend ครบ {job.blendOutputsCompleted} Output แล้ว{!job.photometryGenerated && " — ยังไม่ใช่ผลวัด Black Level หรือสี"}</p>}
      {job.photometryGenerated && <p>สร้าง Black map และ neutral RGB LUT ครบ {job.photometryOutputsCompleted} Output จากสมมติฐาน sRGB — ยังไม่ยืนยันผลก่อน/หลังบนผนังจริง</p>}
      {job.state === "applied-to-project" && <p>บันทึก revision {job.appliedRevision} แล้ว เปิด NDI preview ด้วยค่าที่บันทึกใหม่นี้เพื่อตรวจภาพ</p>}
      {job.state === "restored-to-project" && <p>คืนชุดค่าก่อนวัดเป็น revision {job.restoredRevision} แล้ว</p>}
      {job.state === "applied-to-project" && <button disabled={busy || revision !== job.appliedRevision} onClick={() => void action(async () => {
        setState(await client.restoreUvcGeometry(job.id, job.appliedRevision!));
      })}>คืนชุดค่าก่อนวัด</button>}
      {job.receiptError && <p role="alert">บันทึกชุดค่าแล้ว แต่บันทึกใบรับผลไม่สำเร็จ: {job.receiptError}</p>}
      {job.outputs?.map(o => <p key={o.outputId}>{o.outputId}: ถอดตำแหน่งได้ {o.validPixels.toLocaleString()} / {o.sampledPixels.toLocaleString()} จุด</p>)}
      {job.restorationRequired && <p><strong>คืน Source ของกล่อง NDI กลับเป็น Arena เดิมด้วยครับ</strong> ระบบนี้ยังไม่ได้คืนการเชื่อมต่อปลายทางอัตโนมัติ</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
