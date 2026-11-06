import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const sourceName = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);

/** API versions are explicit. No fallback write, mode change, preset change,
 * default-password attempt, arbitrary request URL, or implicit login. */
export class NdiReceiverAdapter {
  constructor(profile, { fetchImpl = fetch, environment = process.env } = {}) {
    this.profile = structuredClone(profile); this.fetch = fetchImpl; this.environment = environment;
    const url = new URL(profile.baseUrl);
    if (!id(profile.outputId) || !['magewell-ip-v1', 'magewell-classic', 'kiloview-v1', 'kiloview-web-v2'].includes(profile.kind) ||
        !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid receiver profile');
    if (profile.passwordEnv && (profile.cookieEnv || profile.sessionEnv || profile.tokenEnv)) throw new Error('Choose password login or session headers, not both');
    if (profile.sourceHost != null && isIP(profile.sourceHost) !== 4) throw new Error('Receiver sourceHost must be an explicit IPv4 address');
    this.base = url.origin;
  }
  async login() {
    const p = this.profile;
    if (!p.passwordEnv) return;
    if (this.auth && Date.now() - this.authAt < 5 * 60 * 1000) return;
    const password = this.environment[p.passwordEnv];
    if (typeof p.username !== 'string' || !p.username || typeof password !== 'string' || !password || password.length > 1024) throw new Error(`Receiver ${p.outputId} needs its configured username/password`);
    if (p.kind === 'magewell-classic') throw new Error('Classic Magewell requires an explicit session Cookie; automatic login is not configured for this API version');
    const kilo = p.kind === 'kiloview-v1';
    const webKilo = p.kind === 'kiloview-web-v2';
    const r = await this.fetch(this.base + (webKilo ? '/api/users/login.json' : kilo ? '/api/v1/user/authorize' : '/api/user/login'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': kilo ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: webKilo ? JSON.stringify({ user: p.username, password }) : kilo ? new URLSearchParams({ username: p.username, password }).toString() :
        JSON.stringify({ username: p.username, password: createHash('sha256').update(password).digest('hex') }),
    });
    const value = await this.readJson(r);
    if (webKilo) {
      if (value.result !== 'ok' || typeof value.data?.token !== 'string' || !value.data.token) throw new Error(`Receiver ${p.outputId} API login rejected`);
      this.auth = { Cookie: `user=${encodeURIComponent(p.username)}; alias=${encodeURIComponent(value.data.alias || '')}; token=${encodeURIComponent(value.data.token)}` };
    } else if (kilo) {
      if (value.result !== 'ok' || !value.data?.session || !value.data?.token) throw new Error(`Receiver ${p.outputId} API login rejected`);
      this.auth = { 'API-Session': value.data.session, 'API-Token': value.data.token };
    } else {
      const cookies = r.headers.getSetCookie?.() || [r.headers.get('set-cookie') || ''];
      // Newer Pro Convert firmware uses a base64url/JWT-shaped session, not
      // only a hexadecimal/alphanumeric ID. Preserve it without decoding.
      const cookie = cookies.map(c => c.split(';')[0]).find(c => c.length <= 4096 && /^sid-[A-Za-z0-9_-]+=[A-Za-z0-9._~+/=-]+$/.test(c));
      if (value.status !== 0 || !cookie) throw new Error(`Receiver ${p.outputId} API login rejected or returned no session`);
      this.auth = { Cookie: cookie };
    }
    if (Object.values(this.auth).some(v => typeof v !== 'string' || v.length > 4096 || /[\r\n]/.test(v))) { this.auth = null; throw new Error('Invalid receiver session headers'); }
    this.authAt = Date.now();
  }
  async request(path, body) {
    await this.login();
    const headers = { 'Content-Type': 'application/json', ...this.auth };
    const p = this.profile;
    for (const [field, key] of [['cookieEnv', 'Cookie'], ['sessionEnv', 'API-Session'], ['tokenEnv', 'API-Token']]) {
      if (!p[field]) continue;
      const value = this.environment[p[field]];
      if (!value || /[\r\n]/.test(value)) throw new Error(`Receiver ${p.outputId} needs configured API credentials`);
      headers[key] = value;
    }
    const r = await this.fetch(this.base + path, { method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(5000) });
    const value = await this.readJson(r);
    if (p.kind.startsWith('kiloview-') ? value.result !== 'ok' : value.status !== 0) {
      this.auth = null; // Retry requires a new caller operation, never replay a write.
      throw new Error(`Receiver ${p.outputId} rejected API request; check login/configuration`);
    }
    return value;
  }
  async readJson(r) {
    if (!r.ok) { this.auth = null; throw new Error(`Receiver ${this.profile.outputId} HTTP ${r.status}; check API version/login`); }
    const chunks = []; let bytes = 0;
    const reader = r.body?.getReader(); if (!reader) throw new Error('Receiver returned no API body');
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error('Receiver response exceeds limit'); }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    let value; try { value = JSON.parse(text); } catch { throw new Error('Receiver did not return API JSON'); }
    return value;
  }
  async sources() {
    const data = await this.request('/api/source/list?type=all');
    if (!Number.isSafeInteger(data.selected)) throw new Error('Magewell routing requires Simple Mode; no automatic mode change is allowed');
    const sources = [...(data.static || []), ...(data.ndi || [])];
    return { selected: data.selected, sources };
  }
  async read() {
    if (this.profile.kind === 'kiloview-web-v2') {
      const pane = await this.kiloviewPane();
      if (!sourceName(pane.stream_name) || !id(pane.stream_id) || typeof pane.stream_ip !== 'string' || !pane.stream_ip) throw new Error('Current Kiloview source is not restorable');
      // Stream IDs can retain a stale interface after NDI network changes.
      // Journal the selected endpoint and re-resolve its exact ID at each write.
      return { name: pane.stream_name, address: pane.stream_ip };
    }
    if (this.profile.kind === 'magewell-ip-v1') {
      const { selected, sources } = await this.sources();
      const s = sources.find(s => s.id === selected);
      if (!s?.config?.ndi || !sourceName(s.config.ndi.name) || typeof s.config.ndi.url !== 'string') throw new Error('Current Magewell source is not a restorable NDI source');
      return { name: s.config.ndi.name, address: s.config.ndi.url, sourceId: selected };
    }
    if (this.profile.kind === 'magewell-classic') {
      const s = await this.request('/mwapi?method=get-channel');
      if (s['ndi-name'] !== true || !sourceName(s.name)) throw new Error('Current Magewell source is not NDI');
      return { name: s.name };
    }
    const { data: s } = await this.request('/api/v1/decoder/current/status');
    if (!sourceName(s?.name) || typeof s.url !== 'string' || !s.url) throw new Error('Current Kiloview NDI selection is not restorable');
    return { name: s.name, address: s.url };
  }
  async resolve(source) {
    if (!sourceName(source?.name)) throw new Error('Exact NDI source identity required');
    if (this.profile.kind === 'magewell-classic') return { name: source.name };
    const isolatedPattern = typeof source.address === 'string' && !source.address && this.profile.sourceHost &&
      new RegExp(`^.+ \\(PB-GEOMETRY-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-${this.profile.outputId}\\)$`, 'i').test(source.name);
    if (!isolatedPattern && (typeof source.address !== 'string' || !source.address || source.address.length > 512)) throw new Error('Discovered NDI source address required');
    const matchesAddress = address => isolatedPattern
      ? typeof address === 'string' && address.startsWith(this.profile.sourceHost + ':') && /^\d+$/.test(address.slice(this.profile.sourceHost.length + 1))
      : address === source.address;
    if (isolatedPattern && !['kiloview-web-v2','magewell-ip-v1'].includes(this.profile.kind)) throw new Error('This receiver API cannot discover isolated patterns');
    if (this.profile.kind === 'kiloview-v1') return { name: source.name, address: source.address };
    if (this.profile.kind === 'kiloview-web-v2') {
      const { data } = await this.request('/api/source/groups/list', { is_need_stream: true, show_template: false });
      if (!Array.isArray(data)) throw new Error('Invalid Kiloview discovery response');
      const found = data.flatMap(g => g.streams || []).filter(s => s.type === 'ndi' && s.name === source.name && matchesAddress(s.url));
      const unique = [...new Map(found.map(s => [s.id, s])).values()];
      if (!unique.length) throw Object.assign(new Error('Exact NDI source is not yet discovered on Kiloview'), { code: 'NDI_SOURCE_MISSING' });
      if (unique.length !== 1 || !id(unique[0].id)) throw new Error('Ambiguous Kiloview source');
      return { name: source.name, address: unique[0].url };
    }
    const { sources } = await this.sources();
    const found = sources.filter(s => s.config?.ndi?.name === source.name && matchesAddress(s.config.ndi.url));
    if (found.length === 0) throw Object.assign(new Error('Exact NDI source is not yet discovered on Magewell'), { code: 'NDI_SOURCE_MISSING' });
    if (found.length !== 1 || !Number.isSafeInteger(found[0].id)) throw new Error('Ambiguous Magewell source');
    return { name: source.name, address: found[0].config.ndi.url, sourceId: found[0].id };
  }
  async select(source) {
    if (this.profile.kind === 'kiloview-web-v2') {
      const target = await this.resolve(source);
      const { data } = await this.request('/api/source/groups/list', { is_need_stream: true, show_template: false });
      const matches = Array.isArray(data) ? data.flatMap(g => g.streams || []).filter(s => s.type === 'ndi' && s.name === target.name && s.url === target.address) : [];
      const ids = [...new Set(matches.map(s => s.id))];
      if (ids.length !== 1 || !id(ids[0])) throw new Error('Kiloview discovery changed before switching');
      await this.kiloviewPane();
      // Same source-only operation as the firmware's setOutputSource action.
      // Do not modify layout, resolution, presets, audio, or discovery groups.
      await this.request('/api/output/source/set', {
        from: { type: 'source', output_id: '1' },
        to: { type: 'output', stream_id: ids[0], stream_name: target.name, stream_url: target.address, output_id: '1', pos_id: 1 },
      });
    } else if (this.profile.kind === 'magewell-ip-v1') {
      const target = await this.resolve(source);
      if (target.sourceId !== source.sourceId) throw new Error('Magewell source ID changed before switching');
      await this.request('/api/source/select', { id: target.sourceId });
    } else if (this.profile.kind === 'magewell-classic') {
      await this.request('/mwapi?' + new URLSearchParams({ method: 'set-channel', 'ndi-name': 'true', name: source.name }));
    } else {
      // Kiloview API accepts form POST (not JSON) or GET parameters. Avoid
      // unrelated presets/output format settings; only name and URL are sent.
      await this.request('/api/v1/decoder/current/set?' + new URLSearchParams({ name: source.name, url: source.address }));
    }
  }
  async kiloviewPane() {
    const { data } = await this.request('/api/output/get?output_id=1');
    const panes = data?.position;
    if (!Array.isArray(panes) || panes.length !== 1 || panes[0].id !== 1 || panes[0].type !== 'ndi' ||
        panes[0].enable !== true || panes[0].width !== 100 || panes[0].height !== 100 || panes[0].x !== 0 || panes[0].y !== 0) {
      throw new Error('Kiloview web routing requires one existing full-frame NDI pane; layout is not changed automatically');
    }
    return panes[0];
  }
}

/** Journal is synced BEFORE the first external write. An interrupted session
 * blocks new routing until explicit recovery; never overwrite an operator's
 * subsequent source selection. Readback verifies selection, not optical output. */
export class NdiReceiverRouting {
  #busy = false; #journal = null;
  constructor({ dataDir, profiles = [], adapterFactory = p => new NdiReceiverAdapter(p) }) {
    if (!Array.isArray(profiles) || profiles.length > 5 || new Set(profiles.map(p => p.outputId)).size !== profiles.length ||
        new Set(profiles.map(p => p.baseUrl)).size !== profiles.length) throw new Error('Duplicate or excessive receiver profiles');
    this.root = join(dataDir, 'ndi-routing'); this.file = join(this.root, 'pending.json');
    this.adapters = new Map(profiles.map(p => [p.outputId, adapterFactory(p)]));
    this.fingerprint = createHash('sha256').update(JSON.stringify(profiles.map(p => ({ outputId: p.outputId, kind: p.kind, baseUrl: p.baseUrl, ...(p.sourceHost ? { sourceHost: p.sourceHost } : {}) })))).digest('hex');
  }
  async initialize() {
    try {
      this.#journal = JSON.parse(await readFile(this.file, 'utf8'));
      const j = this.#journal;
      if (j?.version !== 1 || !id(j.jobId) || !['prepared', 'routed', 'recovery-required', 'restored'].includes(j.state) ||
          !Array.isArray(j.entries) || j.entries.length < 1 || j.entries.length > 5 ||
          new Set(j.entries.map(e => e.outputId)).size !== j.entries.length || j.entries.some(e => !id(e.outputId) || typeof e.attempted !== 'boolean' || !sourceName(e.before?.name) || !sourceName(e.target?.name))) throw new Error('Invalid routing journal');
    } catch (e) {
      // Corrupt recovery metadata must not take down the whole Web/API pair.
      if (e.code !== 'ENOENT') this.#journal = { version: 0, jobId: null, state: 'recovery-required', error: 'Routing journal unreadable; inspect saved journal and receivers before recovery' };
    }
    return this;
  }
  snapshot() { return { enabled: this.adapters.size > 0, outputIds: [...this.adapters.keys()], pendingRecovery: Boolean(this.#journal && this.#journal.state !== 'restored'),
    jobId: this.#journal?.jobId ?? null, state: this.#journal?.state ?? 'idle', error: this.#journal?.error, physicalOutputVerified: false }; }
  async #persist() {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `journal-${randomUUID()}.tmp`), f = await open(temp, 'wx', 0o600);
    try { await f.writeFile(JSON.stringify(this.#journal, null, 2)); await f.sync(); } finally { await f.close(); }
    await rename(temp, this.file);
  }
  async route(jobId, sources) {
    if (this.#busy || this.snapshot().pendingRecovery) throw new Error('Restore pending receiver routing before a new session');
    if (!id(jobId) || !Array.isArray(sources) || !sources.length || sources.length > 5 || new Set(sources.map(s => s.outputId)).size !== sources.length ||
        sources.some(s => !this.adapters.has(s.outputId))) throw new Error('Configure one exact receiver for each output');
    this.#busy = true;
    try {
      const entries = [];
      for (const s of sources) {
        const a = this.adapters.get(s.outputId);
        const before = await a.read(); let target;
        for (let attempt = 0; attempt < 20; attempt++) {
          try { target = await a.resolve(s); break; } catch (e) {
            if (e.code !== 'NDI_SOURCE_MISSING' || attempt === 19) throw e;
            await delay(250);
          }
        }
        entries.push({ outputId: s.outputId, before, target, attempted: false });
      }
      this.#journal = { version: 1, jobId, fingerprint: this.fingerprint, state: 'prepared', entries };
      await this.#persist();
      for (const entry of entries) {
        const a = this.adapters.get(entry.outputId);
        if (!same(await a.read(), entry.before)) throw new Error('Receiver source changed before routing');
        entry.attempted = true; await this.#persist();
        try { await a.select(entry.target); } catch (e) { entry.uncertain = true; await this.#persist(); throw e; }
        let matched = false;
        for (let i = 0; i < 10; i++) {
          if (same(await a.read(), entry.target)) { matched = true; break; }
          await delay(200);
        }
        if (!matched) throw new Error('Receiver did not confirm the selected source');
      }
      this.#journal.state = 'routed'; await this.#persist(); return this.snapshot();
    } catch (error) {
      if (this.#journal?.jobId === jobId) {
        try { await this.#restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Routing failed; receiver recovery is still required'); }
      }
      throw error;
    } finally { this.#busy = false; }
  }
  async #restore() {
    const j = this.#journal;
    if (!j || j.state === 'restored') return this.snapshot();
    if (j.version !== 1 || j.fingerprint !== this.fingerprint || !Array.isArray(j.entries)) throw new Error('Routing profile changed; recover receivers manually');
    const errors = [];
    for (const entry of [...j.entries].reverse()) {
      if (!entry.attempted || entry.restored) continue;
      try {
        const a = this.adapters.get(entry.outputId), now = await a.read();
        if (!same(now, entry.before)) {
          if (!same(now, entry.target)) throw new Error('Operator changed source; refusing to overwrite it');
          await a.select(entry.before);
          let restored = false;
          for (let attempt = 0; attempt < 10; attempt++) {
            if (same(await a.read(), entry.before)) { restored = true; break; }
            await delay(200);
          }
          if (!restored) throw new Error('Receiver restore readback mismatch');
        }
        if (entry.uncertain) throw new Error('A timed-out write may still be pending; inspect receiver before clearing recovery');
        entry.restored = true;
      } catch (e) { errors.push(new Error(`${entry.outputId}: ${e.message}`)); }
    }
    j.state = errors.length ? 'recovery-required' : 'restored'; await this.#persist();
    if (errors.length) throw new AggregateError(errors, 'Some receivers could not be restored');
    return this.snapshot();
  }
  async restore(jobId) {
    if (this.#busy || this.#journal?.jobId !== jobId) throw new Error('No matching idle routing session');
    this.#busy = true; try { return await this.#restore(); } finally { this.#busy = false; }
  }
}
