import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NdiVideoControl, projectNdiVideoPlan } from '../runtime/server/ndi-video-control.mjs';
import { createPixelBrightnessServer } from '../runtime/server/server.mjs';
const source = { name: 'fixture (Arena)', address: '127.0.0.1:5961' };
const request = { expectedRevision: 3, sourceName: source.name, outputIds: ['left'] };
function fixture({ endFails = false, inspectSource } = {}) {
  const project = { revision: 3, canvas: { width: 1920, height: 1080, frameRateNum: 60, frameRateDen: 1 },
    outputs: [{ id: 'left', enabled: true, resolution: { width: 1920, height: 1080, refreshNum: 60, refreshDen: 1 } }] };
  const calls = [];
  const transport = {
    async begin(plan) { calls.push(['begin', plan]); return { sources: [{ outputId: 'left', name: 'PB-VIDEO-fixture-left' }] }; },
    async status() { calls.push(['status']); return { sourceValid: true, outputs: [] }; },
    async setBlank(blank) { calls.push(['blank', blank]); return { blank }; },
    async end() { calls.push(['end']); if (endFails) throw new Error('cleanup failed'); return { blackSubmitted: true, physicalBlackVerified: false }; },
  };
  const control = new NdiVideoControl({ getProject: () => project, discover: async () => [source], inspectSource, transportFactory: () => transport, pollMs: 10 });
  return { control, project, calls, transport };
}
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); } throw new Error('timed out'); }
test('NDI source cadence mismatch is rejected before creating senders', async()=>{
  const f=fixture({inspectSource:async()=>({sourceName:source.name,sourceAddress:source.address,receivedFrames:100,
    formats:[{width:1920,height:1080,fpsNumerator:30,fpsDenominator:1}]})});
  try{await assert.rejects(f.control.start(request),/Match the settings/);assert.deepEqual(f.calls,[]);}
  finally{await f.control.close();}
});
test('NDI source preflight rejects a changed project and a different source identity',async()=>{
  for(const mismatch of ['revision','identity']){
    let f;
    f=fixture({inspectSource:async()=>{
      if(mismatch==='revision')f.project.revision++;
      return {sourceName:source.name,sourceAddress:mismatch==='identity'?'wrong':source.address,receivedFrames:100,
        formats:[{width:1920,height:1080,fpsNumerator:60,fpsDenominator:1}]};
    }});
    try{await assert.rejects(f.control.start(request));assert.deepEqual(f.calls,[]);}finally{await f.control.close();}
  }
});
test('project NDI conversion preserves manual corrections and refuses unresolved assets, stale revision and process fields', () => {
  const f = fixture(); const plan = projectNdiVideoPlan(f.project, request, source);
  assert.equal(plan.outputs[0].display, undefined); assert.equal(plan.outputs[0].mask.path, null);
  assert.equal(plan.outputs[0].warp.points.length, 33 * 19);
  assert.throws(() => projectNdiVideoPlan(f.project, { ...request, command: 'bad' }, source));
  assert.throws(() => projectNdiVideoPlan(f.project, { ...request, expectedRevision: 2 }, source));
  assert.throws(() => projectNdiVideoPlan(f.project, { ...request, outputIds: ['left', 'left'] }, source));
  f.project.outputs[0].blend = { map: { sha256: 'existing-map' } };
  assert.throws(() => projectNdiVideoPlan(f.project, request, source), /not be silently discarded/);
});
test('NDI main control starts black, unblanks explicitly, invalidates changed revision and stops', async () => {
  const f = fixture();
  try {
    const { job } = await f.control.start(request); assert.equal(job.state, 'black');
    await assert.rejects(f.control.start(request));
    await f.control.blank(job.id, false); assert.equal(f.control.snapshot().job.state, 'sending');
    f.project.revision++;
    await until(() => f.control.snapshot().job.state === 'revision-changed');
    await until(() => !f.control.snapshot().job.updatedAt || f.calls.some(c => c[0] === 'status'));
    await assert.rejects(f.control.blank(job.id, false));
    // Polling owns short exclusive intervals; wait for an operator slot.
    for (let i = 0; i < 20; i++) { try { await f.control.stop(job.id); break; } catch (e) { if (e.code !== 'ndi_busy') throw e; await delay(2); } }
    assert.equal(f.control.snapshot().job.state, 'stopped');
    assert.equal(f.control.snapshot().job.restorationRequired, true);
  } finally { await f.control.close(); }
});
test('server closes HTTP even if a native preview cleanup reports failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-ndi-close-')); const f = fixture({ endFails: true });
  const server = await createPixelBrightnessServer({ dataDir: root, ndiVideoControl: f.control });
  try {
    const address = await server.listen({ port: 0 });
    await f.control.start(request);
    await assert.rejects(server.close(), AggregateError);
    await assert.rejects(fetch(`http://127.0.0.1:${address.port}/v1/health`));
    assert.equal(f.control.snapshot().job.state, 'failed');
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
test('operator stop waits for an in-flight telemetry poll instead of failing busy', async () => {
  const f = fixture(); let release, entered = false;
  const blocked = new Promise(resolve => { release = resolve; });
  f.transport.status = async () => { entered = true; await blocked; return { sourceValid: true, outputs: [] }; };
  try {
    const { job } = await f.control.start(request);
    await until(() => entered);
    const stop = f.control.stop(job.id);
    await delay(5); assert.equal(f.calls.some(c => c[0] === 'end'), false);
    release(); await stop;
    assert.equal(f.control.snapshot().job.state, 'stopped');
  } finally { release(); await f.control.close(); }
});
test('NDI HTTP endpoints keep authentication, disable default and require exact job id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-ndi-api-')); const f = fixture();
  const token = 'fixture-control-01234567890123456789';
  const server = await createPixelBrightnessServer({ dataDir: root, controlToken: token, ndiVideoControl: f.control });
  try {
    const address = await server.listen({ port: 0 }), url = `http://127.0.0.1:${address.port}/v1/outputs/ndi-preview`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(url + '/sources', { headers })).status, 200);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(response.status, 202);
    const { job } = await response.json();
    assert.equal((await fetch(url + '/blank', { method: 'POST', headers, body: JSON.stringify({ id: 'wrong', blank: false }) })).status, 409);
    assert.equal((await fetch(url + '/stop', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) })).status, 200);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  const disabledRoot = await mkdtemp(join(tmpdir(), 'pb-ndi-disabled-'));
  const disabled = await createPixelBrightnessServer({ dataDir: disabledRoot });
  try { const address = await disabled.listen({ port: 0 }); assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/outputs/ndi-preview`)).status, 503); }
  finally { await disabled.close(); await rm(disabledRoot, { recursive: true, force: true }); }
});
