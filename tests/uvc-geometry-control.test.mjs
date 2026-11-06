import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UvcGeometryControl } from '../runtime/server/uvc-geometry-control.mjs';
import { createPixelBrightnessServer } from '../runtime/server/server.mjs';
import { createIdentityMesh } from '../runtime/shared/mapping.mjs';

const plan = { deviceId: 'fixture', outputs: [{ id: 'left', width: 6, height: 5 }], settleMs: 100 };
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  throw new Error('Timed out waiting for test state');
}
function makeControl(dataDir, { devices = [{ id: 'fixture' }], connected = true, getProject, saveProject, canApply, receiverRouting } = {}) {
  let ends = 0, starts = 0;
  const control = new UvcGeometryControl({ dataDir, routingTimeoutMs: 1000,
    getProject, saveProject, canApply, receiverRouting,
    camera: { async list() { return devices; } },
    transportFactory: () => ({
      async begin() { starts++; return { sources: [{ outputId: 'left', name: 'fixture-pattern' }] }; },
      async status() { return { connections: [{ outputId: 'left', connections: connected ? 1 : 0 }] }; },
      async show() {}, async end() { ends++; return { blackSubmitted: true, contentRestored: false }; },
    }),
    sessionFactory: ({ patterns }) => ({ async run(value, options) {
      try {
        await patterns.begin(value, options); options.signal.throwIfAborted();
        options.onProgress({ completedCaptures: 16, outputId: 'left' });
        return { schema: 'pb-uvc-geometry-candidate-v1', status: 'candidate-not-applied', outputs: getProject ? value.outputs.map(o => ({
          outputId: o.id, referenceDrift: 0, mesh: { ...createIdentityMesh(o.targetMesh.columns, o.targetMesh.rows), holes: 0, confidence: 0.9 },
        })) : [], endResult: { contentRestored: false } };
      } finally { await patterns.end(); }
    } }),
  });
  return { control, get ends() { return ends; }, get starts() { return starts; } };
}
test('main controller starts once, requires routing, persists candidate and never applies it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-control-')); const f = makeControl(root);
  try {
    const started = await f.control.start(plan), id = started.job.id;
    await until(() => f.control.snapshot().job.state === 'awaiting-routing');
    await assert.rejects(f.control.start(plan), e => e.status === 409 || e.statusCode === 409);
    await assert.rejects(f.control.confirmRouting('wrong'));
    await f.control.confirmRouting(id);
    await until(() => f.control.snapshot().job.finishedAt);
    const state = f.control.snapshot();
    assert.equal(state.job.state, 'candidate-not-applied'); assert.equal(state.job.candidateApplied, false);
    assert.equal(state.job.restorationRequired, true); assert.equal(f.ends, 1);
    const saved = JSON.parse(await readFile(join(root, 'uvc-geometry', id, 'candidate.json'), 'utf8'));
    assert.equal(saved.status, 'candidate-not-applied');
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('geometry controller applies once with durable backup, rejects active output/stale or corrupt candidates, and restores only its own revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-geometry-apply-'));
  let project = { revision: 2, canvas: { width: 64, height: 64 }, outputs: [{ id: 'left', resolution: { width: 64, height: 64 }, warp: createIdentityMesh(2, 2), blend: { gamma: 2 } }] };
  let available = true, saves = 0;
  const f = makeControl(root, { getProject: () => project, canApply: () => available, saveProject: async (next, { ifMatchRevision }) => {
    assert.equal(ifMatchRevision, project.revision); saves++; project = { ...next, revision: project.revision + 1 }; return { project };
  } });
  const acquire = async () => {
    const { job } = await f.control.start({ ...plan, outputs: [{ id: 'left', width: 64, height: 64 }], expectedRevision: project.revision, targetArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } });
    await until(() => f.control.snapshot().job.state === 'awaiting-routing'); await f.control.confirmRouting(job.id);
    await until(() => f.control.snapshot().job.finishedAt); return job.id;
  };
  try {
    const id = await acquire(); available = false;
    await assert.rejects(f.control.apply({ id, expectedRevision: 2 })); assert.equal(saves, 0); available = true;
    await assert.rejects(f.control.apply({ id, expectedRevision: 1 })); assert.equal(saves, 0);
    const applied = await f.control.apply({ id, expectedRevision: 2 });
    assert.equal(applied.job.appliedRevision, 3); assert.equal(project.outputs[0].warp.enabled, true);
    const files = await readdir(join(root, 'uvc-geometry', id));
    const backup = JSON.parse(await readFile(join(root, 'uvc-geometry', id, files.find(f => f.startsWith('project-before-apply-'))), 'utf8'));
    assert.equal(backup.revision, 2); assert.equal(backup.outputs[0].blend.gamma, 2);
    await assert.rejects(f.control.apply({ id, expectedRevision: 2 }));
    project.revision = 4; await assert.rejects(f.control.restore({ id, expectedRevision: 3 })); project.revision = 3;
    await f.control.restore({ id, expectedRevision: 3 }); assert.equal(project.revision, 4);
    assert.equal(f.control.snapshot().job.state, 'restored-to-project'); assert.equal(saves, 2);
    const next = await acquire(); await writeFile(join(root, 'uvc-geometry', next, 'candidate.json'), '{}');
    await assert.rejects(f.control.apply({ id: next, expectedRevision: 4 }), /digest/); assert.equal(saves, 2);
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('geometric blend creates digest-bound assets, applies with Warp, restores originals, and rejects corrupted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-geometry-blend-'));
  let project = { revision: 1, canvas: { width: 64, height: 64 }, outputs: [{ id: 'left',
    resolution: { width: 64, height: 64 }, warp: createIdentityMesh(2, 2), blend: { gamma: 2 }, blackUniformity: { lift: 0.02 } }] };
  const f = makeControl(root, { getProject: () => project, saveProject: async (p, { ifMatchRevision }) => {
    assert.equal(ifMatchRevision, project.revision); project = { ...p, revision: project.revision + 1 }; return { project };
  } });
  const acquire = async () => {
    const { job } = await f.control.start({ ...plan, outputs: [{ id: 'left', width: 64, height: 64 }],
      expectedRevision: project.revision, targetArea: { x: 0, y: 0, width: 1, height: 1 }, autoBlend: true });
    await until(() => f.control.snapshot().job.state === 'awaiting-routing'); await f.control.confirmRouting(job.id);
    await until(() => f.control.snapshot().job.finishedAt); return job.id;
  };
  try {
    await assert.rejects(f.control.start({ ...plan, autoBlend: true }), /target/);
    const id = await acquire(); assert.equal(f.control.snapshot().job.blendGenerated, true);
    await f.control.apply({ id, expectedRevision: 1 });
    const ref = project.outputs[0].blend.map;
    assert.equal(ref.format, 'r32_float'); assert.equal(project.outputs[0].blackUniformity.lift, 0.02);
    const data = await readFile(join(root, ref.path)); assert.equal(data.length, 16384); assert.equal(data.readFloatLE(0), 1);
    await f.control.restore({ id, expectedRevision: 2 }); assert.equal(project.outputs[0].blend.map, undefined);
    const id2 = await acquire();
    await writeFile(join(root, 'uvc-geometry', id2, 'left-geometry-blend.bin'), Buffer.alloc(16384));
    await assert.rejects(f.control.apply({ id: id2, expectedRevision: 3 }), /digest/); assert.equal(project.revision, 3);
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('automatic routing runs before capture and always restores receiver selection afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-auto-route-')); let routed, restored;
  const receiverRouting = {
    snapshot: () => ({ enabled: true, outputIds: ['left'], jobId: routed, pendingRecovery: Boolean(routed && !restored) }),
    async route(id, sources) { assert.equal(sources[0].outputId, 'left'); routed = id; },
    async restore(id) { assert.equal(id, routed); restored = id; },
  };
  const f = makeControl(root, { receiverRouting });
  try {
    const { job } = await f.control.start({ ...plan, autoRoute: true });
    await until(() => f.control.snapshot().job.finishedAt);
    assert.equal(restored, job.id); assert.equal(f.control.snapshot().job.restorationRequired, false);
    assert.equal(f.control.snapshot().job.routingReadbackVerified, true);
    assert.equal(f.control.snapshot().productionAutoReady, false);
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('missing camera never starts NDI; command injection fields are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-control-')); const f = makeControl(root, { devices: [] });
  try {
    await assert.rejects(f.control.start({ ...plan, cameraCommand: 'untrusted' }));
    await assert.rejects(f.control.start(plan)); assert.equal(f.starts, 0);
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('no receiver blocks capture; cancellation and server close clean up the sender', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-control-')); const f = makeControl(root, { connected: false });
  try {
    const { job } = await f.control.start(plan);
    await until(() => f.control.snapshot().job.state === 'awaiting-routing');
    await assert.rejects(f.control.confirmRouting(job.id));
    f.control.cancel(job.id); await f.control.close();
    assert.equal(f.control.snapshot().job.state, 'cancelled'); assert.equal(f.ends, 1);
  } finally { await f.control.close(); await rm(root, { recursive: true, force: true }); }
});
test('main HTTP endpoints keep control authentication and do not allow executable paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-api-')); const f = makeControl(root, {
    receiverRouting: { snapshot: () => ({ enabled: false, pendingRecovery: false, jobId: null }), restore: async () => { throw new Error('must not call'); } },
  });
  const token = 'control-only-fixture-secret-0123456789';
  const server = await createPixelBrightnessServer({ dataDir: root, controlToken: token, uvcGeometryControl: f.control });
  try {
    const address = await server.listen({ port: 0 }); const url = `http://127.0.0.1:${address.port}/v1/calibrations/uvc-geometry`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(url, { headers })).status, 200);
    const missingRouting = await fetch(`${url}/restore-routing`, { method: 'POST', headers, body: JSON.stringify({ id: 'missing' }) });
    assert.equal(missingRouting.status, 409); assert.equal((await missingRouting.json()).error.code, 'uvc_routing');
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...plan, command: 'bad' }) })).status, 400);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(plan) });
    assert.equal(response.status, 202); const id = (await response.json()).job.id;
    await until(() => f.control.snapshot().job.state === 'awaiting-routing');
    assert.equal((await fetch(`${url}/cancel`, { method: 'POST', headers, body: JSON.stringify({ id }) })).status, 202);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
test('main server leaves local acquisition disabled unless configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-uvc-disabled-'));
  const server = await createPixelBrightnessServer({ dataDir: root });
  try {
    const address = await server.listen({ port: 0 });
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/v1/calibrations/uvc-geometry`)).status, 503);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
