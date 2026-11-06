import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createNodeCredential } from "../runtime/shared/node-auth.mjs";

const NODE_SIGNING_KEY = "trusted-local-node-signing-key-000000001";

async function startServer(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-auth-mode-"));
  const server = await createPixelBrightnessServer({ dataDir, ...options });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await server.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function localWebHeaders(baseUrl) {
  return { origin: `${new URL(baseUrl).protocol}//${new URL(baseUrl).hostname}:3000` };
}

test('trusted-local exemption follows its configured web port, not the old production port', async () => {
  const fixture = await startServer({ controlToken: 'configured-web-port-test-token', trustedLocalWeb: true, webControlPort: 3001 });
  try {
    const origin = 'http://127.0.0.1:3001';
    const allowed = await fetch(fixture.baseUrl + '/v1/state', { headers: { origin } });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).server.accessMode, 'trusted-local');
    const old = await fetch(fixture.baseUrl + '/v1/state', { headers: { origin: 'http://127.0.0.1:3000' } });
    assert.equal(old.status, 401);
  } finally { await fixture.close(); }
});

async function upload(baseUrl, name, { token, origin } = {}) {
  return fetch(`${baseUrl}/v1/media/upload`, {
    method: "POST",
    headers: {
      "content-type": "video/mp4",
      "x-file-name": name,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: Buffer.from(`trusted-local fixture: ${name}\n`),
  });
}

async function rawRequest(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(pathname, baseUrl);
  const bytes = body == null ? null : Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: {
        ...headers,
        ...(bytes ? { "content-length": bytes.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (bytes) request.end(bytes);
    else request.end();
  });
}

test("trusted-local Web mode refuses to start without an API token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-invalid-trusted-mode-"));
  try {
    await assert.rejects(
      createPixelBrightnessServer({ dataDir, trustedLocalWeb: true }),
      /trustedLocalWeb.*(?:PIXEL_CONTROL_TOKEN|auth(?:entication)?\s+token)/i,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("trusted-local Web origin is advertised as unpaired and may upload without exposing the Server token", async () => {
  const token = "trusted-local-server-token";
  const fixture = await startServer({
    controlToken: token,
    nodeSigningKey: NODE_SIGNING_KEY,
    trustedLocalWeb: true,
    trustedWebHosts: ["127.0.0.1"],
  });
  try {
    const localHeaders = localWebHeaders(fixture.baseUrl);
    const healthResponse = await fetch(`${fixture.baseUrl}/v1/health`, { headers: localHeaders });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.authRequired, false);

    const stateResponse = await fetch(`${fixture.baseUrl}/v1/state`, { headers: localHeaders });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.server.authRequired, false);

    const uploadResponse = await upload(fixture.baseUrl, "trusted-local.mp4", { origin: localHeaders.origin });
    assert.equal(uploadResponse.status, 201);
    const result = await uploadResponse.json();
    assert.equal(result.media.name, "trusted-local.mp4");

    const registrationBody = JSON.stringify({
      protocolVersion: 1,
      nodeId: "trusted-browser-must-not-register",
      capabilities: {},
    });
    const unpairedRegistration = await fetch(`${fixture.baseUrl}/v1/nodes/register`, {
      method: "POST",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: registrationBody,
    });
    assert.equal(unpairedRegistration.status, 401, "trusted Web bypass must never authenticate render nodes");

    const controlRegistration = await fetch(`${fixture.baseUrl}/v1/nodes/register`, {
      method: "POST",
      headers: {
        ...localHeaders,
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: registrationBody,
    });
    assert.equal(controlRegistration.status, 403, "control credentials must not impersonate a Render Node");

    const nodeRegistration = await fetch(`${fixture.baseUrl}/v1/nodes/register`, {
      method: "POST",
      headers: {
        ...localHeaders,
        "content-type": "application/json",
        authorization: `Bearer ${createNodeCredential("trusted-browser-must-not-register", NODE_SIGNING_KEY)}`,
      },
      body: registrationBody,
    });
    assert.equal(nodeRegistration.status, 201);

    const noOriginState = await fetch(`${fixture.baseUrl}/v1/state`);
    assert.equal(noOriginState.status, 401, "untrusted LAN clients must not enumerate topology or media hashes");
    assert.equal((await upload(fixture.baseUrl, "no-origin-unpaired.mp4")).status, 401);
    assert.equal((await upload(fixture.baseUrl, "no-origin-paired.mp4", { token })).status, 201);

    const remoteOrigin = "http://192.0.2.44:3000";
    const remoteState = await fetch(`${fixture.baseUrl}/v1/state`, { headers: { origin: remoteOrigin } });
    assert.equal(remoteState.status, 401);
    assert.equal((await upload(fixture.baseUrl, "remote-unpaired.mp4", { origin: remoteOrigin })).status, 401);

    const port = new URL(fixture.baseUrl).port;
    const attackerHost = `attacker.example:${port}`;
    const attackerOrigin = "http://attacker.example:3000";
    const spoofedState = await rawRequest(fixture.baseUrl, "/v1/state", {
      headers: { host: attackerHost, origin: attackerOrigin },
    });
    assert.equal(spoofedState.status, 401);
    const spoofedUpload = await rawRequest(fixture.baseUrl, "/v1/media/upload", {
      method: "POST",
      headers: {
        host: attackerHost,
        origin: attackerOrigin,
        "content-type": "video/mp4",
        "x-file-name": "host-spoof.mp4",
      },
      body: "host spoof must not enter trusted mode\n",
    });
    assert.equal(spoofedUpload.status, 401, "matching attacker Host and Origin must not bypass trustedWebHosts");
  } finally {
    await fixture.close();
  }
});

test("standard token-protected Server keeps pairing and write protection for the local Web origin", async () => {
  const token = "protected-mode-regression-token";
  const fixture = await startServer({ controlToken: token });
  try {
    const localHeaders = localWebHeaders(fixture.baseUrl);
    const healthResponse = await fetch(`${fixture.baseUrl}/v1/health`, { headers: localHeaders });
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.authRequired, true);

    const stateResponse = await fetch(`${fixture.baseUrl}/v1/state`, { headers: localHeaders });
    assert.equal(stateResponse.status, 401, "token mode must protect read-side topology as well as writes");
    const pairedState = await fetch(`${fixture.baseUrl}/v1/state`, {
      headers: { ...localHeaders, authorization: `Bearer ${token}` },
    });
    assert.equal(pairedState.status, 200);

    const unpaired = await upload(fixture.baseUrl, "unpaired.mp4", { origin: localHeaders.origin });
    assert.equal(unpaired.status, 401);
    const error = await unpaired.json();
    assert.equal(error.error.code, "unauthorized");

    const paired = await upload(fixture.baseUrl, "paired.mp4", { token, origin: localHeaders.origin });
    assert.equal(paired.status, 201);
    const result = await paired.json();
    assert.equal(result.media.name, "paired.mp4");
    assert.equal((await fetch(`${fixture.baseUrl}/v1/assets/${result.media.sha256}`)).status, 401,
      "asset bytes must not be downloadable by an untrusted LAN client that only knows the hash");
    assert.equal((await fetch(`${fixture.baseUrl}/v1/assets/${result.media.sha256}`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
  } finally {
    await fixture.close();
  }
});
