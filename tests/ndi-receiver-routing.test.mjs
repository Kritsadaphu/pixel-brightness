import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdiReceiverAdapter, NdiReceiverRouting } from '../runtime/server/ndi-receiver-routing.mjs';

test('Kiloview web firmware uses explicit cookie login and source-only pane assignment', async () => {
  const calls = []; let multi = false;
  const pane = { id: 1, type: 'ndi', enable: true, width: 100, height: 100, x: 0, y: 0, stream_name: 'Arena', stream_ip: '192.168.68.50:5963', stream_id: 'original' };
  const a = new NdiReceiverAdapter({ outputId: 'B', kind: 'kiloview-web-v2', baseUrl: 'http://192.168.68.31/', username: 'fixture', passwordEnv: 'TEST_PASSWORD' }, {
    environment: { TEST_PASSWORD: 'fixture-only' }, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/login.json')) {
        assert.deepEqual(JSON.parse(options.body), { user: 'fixture', password: 'fixture-only' });
        return Response.json({ result: 'ok', data: { token: 'fixture-token', alias: 'Fixture User' } });
      }
      assert.equal(options.headers.Cookie, 'user=fixture; alias=Fixture%20User; token=fixture-token');
      if (url.includes('/output/get?')) return Response.json({ result: 'ok', data: { position: multi ? [pane, pane] : [pane] } });
      if (url.endsWith('/groups/list')) return Response.json({ result: 'ok', data: [{ streams: [
        { id: 'wrong-network', type: 'ndi', name: 'Arena', url: '169.254.1.2:5963' },
        { id: 'target', type: 'ndi', name: 'Arena', url: '192.168.68.50:5963' },
      ] }] });
      assert.ok(url.endsWith('/api/output/source/set')); return Response.json({ result: 'ok' });
    },
  });
  const before = await a.read();
  const target = await a.resolve({ name: 'Arena', address: '192.168.68.50:5963' });
  assert.deepEqual(target, { name: 'Arena', address: '192.168.68.50:5963' });
  await a.select(target);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { from: { type: 'source', output_id: '1' }, to: { type: 'output', stream_id: 'target', stream_name: 'Arena', stream_url: '192.168.68.50:5963', output_id: '1', pos_id: 1 } });
  await a.select(before); // Re-resolves the endpoint, not the stale ID from a different interface.
  assert.equal(JSON.parse(calls.at(-1).options.body).to.stream_id, 'target');
  await assert.rejects(a.resolve({ name: 'Arena', address: '192.168.1.200:5963' }), /not yet discovered/);
  multi = true;
  await assert.rejects(a.select(target), /one existing full-frame/);
  assert.ok(!calls.at(-1).url.endsWith('/source/set'));
});

const profiles = ['left', 'right'].map((outputId, i) => ({ outputId, kind: 'kiloview-v1', baseUrl: `http://192.168.68.${31 + i}/` }));
test('isolated pattern with SDK-empty address resolves only on the configured NDI host', async () => {
  const name='MAPPINGPC (PB-GEOMETRY-22591c6a-7c53-4bc5-9301-2670e421c1e1-A)';
  for (const kind of ['magewell-ip-v1','kiloview-web-v2']) {
    let duplicate=false;
    const a=new NdiReceiverAdapter({outputId:'A',kind,baseUrl:'http://192.168.68.34/',sourceHost:'192.168.68.50'}, {
      fetchImpl:async()=>{
        const streams=[{id:'wrong',type:'ndi',name,url:'192.168.1.200:5970'},{id:'right',type:'ndi',name,url:'192.168.68.50:5970'}];
        if(duplicate)streams.push({id:'ambiguous',type:'ndi',name,url:'192.168.68.50:5971'});
        return Response.json(kind==='kiloview-web-v2'?{result:'ok',data:[{streams}]}:{status:0,selected:1,ndi:streams.map((s,i)=>({id:i+1,config:{ndi:{name:s.name,url:s.url}}}))});
      },
    });
    assert.equal((await a.resolve({name,address:''})).address,'192.168.68.50:5970');
    await assert.rejects(a.resolve({name:'Arena',address:''}),/address required/);
    await assert.rejects(a.resolve({name:name.replace('-A)','-B)'),address:''}),/address required/);
    duplicate=true;await assert.rejects(a.resolve({name,address:''}),/Ambiguous/);
    a.profile.sourceHost=undefined;await assert.rejects(a.resolve({name,address:''}),/address required/);
  }
});
const sources = profiles.map(p => ({ outputId: p.outputId, name: `test-${p.outputId}`, address: '192.168.68.50:5961' }));
function fixture(root, { fail, conflict } = {}) {
  const selections = new Map(profiles.map(p => [p.outputId, { name: `original-${p.outputId}`, address: '192.168.68.50:5970' }]));
  const writes = [];
  const options = { dataDir: root, profiles, adapterFactory: p => ({
    async read() { return structuredClone(selections.get(p.outputId)); },
    async resolve(s) { return { name: s.name, address: s.address }; },
    async select(s) {
      const journal = JSON.parse(await readFile(join(root, 'ndi-routing', 'pending.json'), 'utf8'));
      assert.ok(journal.entries.some(e => e.outputId === p.outputId && e.attempted), 'durable intent precedes every device write');
      writes.push([p.outputId, s.name]); selections.set(p.outputId, structuredClone(s));
      if (conflict && p.outputId === 'right' && s.name.startsWith('test')) selections.set('left', { name: 'operator-new', address: '192.168.68.50:5999' });
      if (fail && p.outputId === 'right' && s.name.startsWith('test')) throw new Error('timeout after device accepted');
    },
  }) };
  return { options, selections, writes };
}
test('routes two receivers with durable intent and restores after controller restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-route-')), f = fixture(root);
  try {
    const router = await new NdiReceiverRouting(f.options).initialize();
    await router.route('job1', sources); assert.equal(router.snapshot().state, 'routed');
    await assert.rejects(router.route('job2', sources), /pending/);
    const resumed = await new NdiReceiverRouting(f.options).initialize(); assert.equal(resumed.snapshot().pendingRecovery, true);
    await assert.rejects(resumed.restore('wrong'));
    await resumed.restore('job1'); assert.equal(resumed.snapshot().pendingRecovery, false);
    assert.equal(f.selections.get('left').name, 'original-left'); assert.equal(f.selections.get('right').name, 'original-right');
    await resumed.restore('job1'); assert.equal(f.writes.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('corrupt routing journal blocks routing without crashing the API constructor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-route-corrupt-')), f = fixture(root);
  try {
    await mkdir(join(root, 'ndi-routing')); await writeFile(join(root, 'ndi-routing', 'pending.json'), '{bad');
    const router = await new NdiReceiverRouting(f.options).initialize();
    assert.equal(router.snapshot().pendingRecovery, true); assert.match(router.snapshot().error, /unreadable/);
    await assert.rejects(router.route('new-job', sources)); assert.equal(f.writes.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('uncertain write rolls back others but remains visibly recovery-required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-route-fail-')), f = fixture(root, { fail: true });
  try {
    const router = await new NdiReceiverRouting(f.options).initialize();
    await assert.rejects(router.route('job1', sources), AggregateError);
    assert.equal(router.snapshot().state, 'recovery-required'); assert.equal(f.selections.get('left').name, 'original-left');
    const journal = JSON.parse(await readFile(join(root, 'ndi-routing', 'pending.json')));
    assert.equal(journal.entries[1].uncertain, true); assert.ok(!JSON.stringify(journal).includes('token'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('recovery never overwrites a new operator selection or a changed receiver profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pb-route-conflict-')), f = fixture(root, { conflict: true });
  try {
    const router = await new NdiReceiverRouting(f.options).initialize(); await router.route('job1', sources);
    await assert.rejects(router.restore('job1'), AggregateError);
    assert.equal(f.selections.get('left').name, 'operator-new'); assert.equal(f.selections.get('right').name, 'original-right');
    const changed = await new NdiReceiverRouting({ ...f.options, profiles: [profiles[0]] }).initialize();
    await assert.rejects(changed.restore('job1'), /profile changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Kiloview adapter checks application result and passes configured auth only in headers', async () => {
  const calls = [];
  const adapter = new NdiReceiverAdapter({ ...profiles[0], sessionEnv: 'TEST_SESSION', tokenEnv: 'TEST_TOKEN' }, {
    environment: { TEST_SESSION: 'session-fixture', TEST_TOKEN: 'token-fixture' },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(url.includes('/status') ?
      { result: 'ok', data: { name: 'Arena', url: '192.168.68.50:5961', online: true } } : { result: 'ok' }); },
  });
  const before = await adapter.read(); await adapter.select(before);
  assert.equal(calls[1].options.headers['API-Token'], 'token-fixture'); assert.ok(!calls[1].url.includes('token-fixture'));
  assert.ok(calls[1].url.includes('/current/set?name=Arena&url=')); assert.equal(calls[1].options.redirect, 'error');
  adapter.fetch = async () => Response.json({ result: 'auth-failed', msg: 'private-detail' });
  await assert.rejects(adapter.read(), e => /rejected/.test(e.message) && !e.message.includes('private-detail'));
});
test('Magewell IP adapter uses selected dynamic source ID and refuses advanced mode and identity changes', async () => {
  let advanced = false, changed = false; const calls = [];
  const adapter = new NdiReceiverAdapter({ outputId: 'left', kind: 'magewell-ip-v1', baseUrl: 'http://192.168.68.34/' }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(url.includes('/list') ? { status: 0, ...(advanced ? {} : { selected: 10 }), ndi: [
        { id: changed ? 11 : 10, config: { ndi: { name: 'Arena', url: '192.168.68.50:5961' } } },
      ] } : { status: 0 });
    },
  });
  const s = await adapter.read(); assert.equal(s.sourceId, 10); await adapter.select(s);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { id: 10 }); assert.equal(calls.at(-1).options.method, 'POST');
  changed = true; await assert.rejects(adapter.select(s), /ID changed/);
  advanced = true; await assert.rejects(adapter.read(), /Simple Mode/);
});
test('classic API remains explicit, arbitrary credentials/redirects/unsupported profiles are not inferred', async () => {
  const calls = [];
  const a = new NdiReceiverAdapter({ outputId: 'left', kind: 'magewell-classic', baseUrl: 'http://192.168.68.34/' }, {
    fetchImpl: async url => { calls.push(url); return Response.json({ status: 0, name: 'Arena & Test', 'ndi-name': true }); },
  });
  await a.select(await a.read()); assert.ok(calls[1].includes('name=Arena+%26+Test'));
  assert.throws(() => new NdiReceiverAdapter({ ...profiles[0], baseUrl: 'http://user:password@192.168.68.31/' }));
  assert.throws(() => new NdiReceiverAdapter({ ...profiles[0], kind: 'guess' }));
  a.profile.cookieEnv = 'MISSING'; await assert.rejects(a.read(), /credentials/);
});
test('API login refreshes expired sessions without exposing secrets or retrying failed mutations', async () => {
  for (const kind of ['kiloview-v1', 'magewell-ip-v1']) {
    let logins = 0, writes = 0, fail = false;
    const a = new NdiReceiverAdapter({ outputId: 'left', baseUrl: 'http://192.168.68.34/', kind, username: 'fixture-user', passwordEnv: 'FIXTURE_PASSWORD' }, {
      environment: { FIXTURE_PASSWORD: 'fixture-only-password' },
      fetchImpl: async (url, options) => {
        assert.ok(!url.includes('fixture-only-password'));
        if (url.endsWith('/authorize') || url.endsWith('/login')) {
          logins++;
          if (kind === 'kiloview-v1') {
            assert.equal(new URLSearchParams(options.body).get('password'), 'fixture-only-password');
            return Response.json({ result: 'ok', data: { session: 'fixture-session', token: 'fixture-token' } });
          }
          assert.match(JSON.parse(options.body).password, /^[a-f0-9]{64}$/);
          return Response.json({ status: 0 }, { headers: { 'Set-Cookie': 'sid-FIXTURE=abc123; Path=/' } });
        }
        assert.ok(options.headers.Cookie === 'sid-FIXTURE=abc123' || options.headers['API-Token'] === 'fixture-token');
        writes++; return Response.json(fail ? { result: 'auth-failed', status: 37 } : { result: 'ok', status: 0 });
      },
    });
    await a.request('/fixture-mutating', { value: 1 }); await a.request('/fixture-mutating', { value: 2 });
    assert.equal(logins, 1); a.authAt = 0; await a.request('/fixture-mutating', { value: 3 }); assert.equal(logins, 2);
    fail = true; await assert.rejects(a.request('/fixture-mutating', { value: 4 }), /rejected/); assert.equal(writes, 4);
    assert.equal(a.auth, null);
  }
});
test('Magewell accepts firmware JWT-shaped cookies without modifying their value', async()=>{
  const cookie='sid-FIXTURE=fixture_header.fixture_payload.fixture-signature_1';
  const a=new NdiReceiverAdapter({outputId:'A',baseUrl:'http://192.168.68.34/',kind:'magewell-ip-v1',username:'fixture',passwordEnv:'FIXTURE_PASSWORD'}, {
    environment:{FIXTURE_PASSWORD:'fixture-only'},fetchImpl:async(url,options)=>{
      if(url.endsWith('/login')) return Response.json({status:0},{headers:{'Set-Cookie':cookie+'; Path=/; HttpOnly'}});
      assert.equal(options.headers.Cookie,cookie);return Response.json({status:0});
    }});
  await a.request('/fixture-read');
});
