import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";

async function withServer(options, run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "pixel-brightness-server-network-"));
  const server = await createPixelBrightnessServer({ dataDir, ...options });
  try {
    await run(server);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("tokenless server refuses wildcard/LAN listeners unless the unsafe override is explicit", async () => {
  await withServer({}, async (server) => {
    await assert.rejects(
      server.listen({ host: "0.0.0.0", port: 0 }),
      /Refusing a non-loopback Pixel Brightness listener without distinct control and render-node credentials/,
    );
  });
  await withServer({ allowInsecureNetwork: true }, async (server) => {
    const address = await server.listen({ host: "0.0.0.0", port: 0 });
    assert.ok(Number(address.port) > 0);
  });
});

test("tokenless loopback CORS allows only the local Web Control origin", async () => {
  await withServer({}, async (server) => {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const url = `http://127.0.0.1:${address.port}/v1/health`;
    const local = await fetch(url, { headers: { origin: "http://localhost:3000" } });
    assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.match(local.headers.get("vary"), /Origin/);
    const before = server.store.snapshot();
    const foreign = await fetch(url, { headers: { origin: "https://attacker.example" } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    const mutation = await fetch(`http://127.0.0.1:${address.port}/v1/timeline/prepare`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(mutation.status, 403);
    assert.equal((await mutation.json()).error.code, "origin_not_allowed");
    assert.deepEqual(server.store.snapshot(), before,
      "a rejected browser origin must not publish any control-plane mutation");

    const opaqueOrigin = await fetch(url, { headers: { origin: "null" } });
    assert.equal(opaqueOrigin.status, 403);
  });
});

test("server retains unlimited total duration while assigning bounded inactivity deadlines", async () => {
  await withServer({ requestIdleTimeoutMs: 12_000, uploadIdleTimeoutMs: 45_000 }, async (server) => {
    assert.equal(server.httpServer.requestTimeout, 0);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    assert.equal(response.status, 200);
  });
});

test("preview browser port supports project GET, preflight and POST without admitting other origins", async () => {
  await withServer({ webControlPort: 3001 }, async server => {
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${address.port}`;
    for (const origin of ['http://localhost:3001', 'http://127.0.0.1:3001']) {
      for (const route of ['/v1/state?includeProject=0', '/v1/projects/default']) {
        const response = await fetch(base + route, { headers: { origin } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
      }
      const preflight = await fetch(base + '/v1/timeline/prepare', { method: 'OPTIONS', headers: {
        origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type',
      } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      // Invalid payload exercises browser POST validation without starting video.
      const post = await fetch(base + '/v1/outputs/ndi-preview/blank', { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(post.status, 503); // Disabled feature, not a CORS failure.
      assert.equal(post.headers.get('access-control-allow-origin'), origin);
    }
    for (const origin of ['http://localhost:3000', 'http://localhost:3002', 'http://example.com:3001', 'null']) {
      assert.equal((await fetch(base + '/v1/state', { headers: { origin } })).status, 403);
    }
  });
});

test("invalid configured web ports fail before starting the server", async () => {
  for (const webControlPort of [0, 80, 65536, -1, 3001.5, '3001', NaN]) {
    await assert.rejects(createPixelBrightnessServer({ webControlPort }), /webControlPort/);
  }
});
