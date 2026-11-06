import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadNodeConfig } from "../runtime/node/config.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { createNodeCredential, verifyNodeCredential } from "../runtime/shared/node-auth.mjs";

const CONTROL_TOKEN = "control-only-token-000000000000000000000001";
const NODE_SIGNING_KEY = "node-signing-key-000000000000000000000001";

function headers(token, extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function jsonRequest(baseUrl, pathname, { token, method = "GET", body, extraHeaders = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? headers(token) : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function register(baseUrl, nodeId, token, outputId) {
  return jsonRequest(baseUrl, "/v1/nodes/register", {
    token,
    method: "POST",
    body: {
      protocolVersion: 1,
      nodeId,
      capabilities: { outputs: [{ id: outputId, connector: `DP-${outputId}` }] },
    },
  });
}

test("signed Render Node credentials are canonical, tamper-evident, and id-bound", () => {
  const token = createNodeCredential("render-a", NODE_SIGNING_KEY);
  assert.equal(verifyNodeCredential(token, NODE_SIGNING_KEY), "render-a");
  assert.equal(verifyNodeCredential(`${token.slice(0, -1)}x`, NODE_SIGNING_KEY), null);
  assert.equal(verifyNodeCredential(token, `${NODE_SIGNING_KEY}-wrong`), null);
  assert.notEqual(token, createNodeCredential("render-b", NODE_SIGNING_KEY));
});

test("Node configuration accepts only the node-scoped credential variable", async () => {
  const nodeToken = createNodeCredential("render-a", NODE_SIGNING_KEY);
  const config = await loadNodeConfig({
    argv: [],
    env: {
      PIXEL_BRIGHTNESS_NODE_ID: "render-a",
      PIXEL_BRIGHTNESS_NODE_TOKEN: nodeToken,
    },
    cwd: process.cwd(),
    platform: "linux",
  });
  assert.equal(config.nodeToken, nodeToken);
  assert.equal("authToken" in config, false);

  await assert.rejects(
    loadNodeConfig({
      argv: [],
      env: {
        PIXEL_BRIGHTNESS_NODE_ID: "render-b",
        PIXEL_BRIGHTNESS_NODE_TOKEN: nodeToken,
      },
      cwd: process.cwd(),
      platform: "linux",
    }),
    /bound to a different nodeId/i,
  );

  await assert.rejects(
    loadNodeConfig({
      argv: [],
      env: { PIXEL_BRIGHTNESS_AUTH_TOKEN: CONTROL_TOKEN },
      cwd: process.cwd(),
      platform: "linux",
    }),
    /Legacy shared auth tokens are not accepted/i,
  );
  await assert.rejects(
    loadNodeConfig({
      argv: ["--auth-token", CONTROL_TOKEN],
      env: {},
      cwd: process.cwd(),
      platform: "linux",
    }),
    /Legacy shared auth tokens are not accepted/i,
  );
});

test("control and per-node credentials cannot cross roles or node identities", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-auth-isolation-"));
  const server = await createPixelBrightnessServer({
    dataDir,
    controlToken: CONTROL_TOKEN,
    nodeSigningKey: NODE_SIGNING_KEY,
    offlineAfterMs: 60_000,
  });
  const nodeAToken = createNodeCredential("render-a", NODE_SIGNING_KEY);
  const nodeBToken = createNodeCredential("render-b", NODE_SIGNING_KEY);
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    assert.equal((await register(baseUrl, "render-a", nodeAToken, "A")).response.status, 201);
    assert.equal((await register(baseUrl, "render-b", nodeBToken, "B")).response.status, 201);
    assert.equal((await register(baseUrl, "render-b", nodeAToken, "B")).response.status, 403);
    assert.equal((await register(baseUrl, "control-cannot-register", CONTROL_TOKEN, "C")).response.status, 403);

    const ownHeartbeat = await jsonRequest(baseUrl, "/v1/nodes/render-a/heartbeat", {
      token: nodeAToken,
      method: "POST",
      body: { protocolVersion: 1, status: "ready" },
    });
    assert.equal(ownHeartbeat.response.status, 200);
    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-a/commands?after=0", { token: nodeAToken })).response.status, 200);

    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-b/heartbeat", {
      token: nodeAToken,
      method: "POST",
      body: { protocolVersion: 1, status: "ready" },
    })).response.status, 403);
    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-b/commands?after=0", { token: nodeAToken })).response.status, 403);
    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-a/heartbeat", {
      token: CONTROL_TOKEN,
      method: "POST",
      body: { protocolVersion: 1, status: "ready" },
    })).response.status, 403);
    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-a/commands?after=0", { token: CONTROL_TOKEN })).response.status, 403);

    for (const request of [
      ["/v1/state", "GET"],
      ["/v1/projects/default", "GET"],
      ["/v1/timeline/prepare", "POST", {}],
      ["/v1/outputs/A/pattern", "POST", { enabled: true, type: "grid" }],
      ["/v1/calibrations/camera", "POST", {}],
      ["/v1/nodes/render-a/actions", "POST", { type: "RESTART_RENDERER" }],
    ]) {
      const denied = await jsonRequest(baseUrl, request[0], {
        token: nodeAToken,
        method: request[1],
        ...(request.length > 2 ? { body: request[2] } : {}),
      });
      assert.equal(denied.response.status, 403, `${request[1]} ${request[0]} must reject a node credential`);
      assert.equal(denied.body.error.code, "insufficient_scope");
    }

    assert.equal((await jsonRequest(baseUrl, "/v1/projects/default", { token: CONTROL_TOKEN })).response.status, 200);
    assert.equal((await jsonRequest(baseUrl, "/v1/nodes/render-a", { token: CONTROL_TOKEN })).response.status, 200);

    const ownedProject = server.control.getProject();
    ownedProject.outputs = ownedProject.outputs.map((output) => ({
      ...output,
      nodeId: output.id === "A"
        ? "render-a"
        : output.id === "B" ? "render-b" : output.nodeId,
    }));
    await server.control.saveProject(ownedProject, { ifMatchRevision: ownedProject.revision });

    const bytes = Buffer.from("credential-scoped show asset\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await fetch(`${baseUrl}/v1/media/upload`, {
      method: "POST",
      headers: headers(CONTROL_TOKEN, {
        "content-type": "application/octet-stream",
        "x-file-name": "scoped.bin",
      }),
      body: bytes,
    });
    assert.equal(upload.status, 201);
    assert.equal((await upload.json()).media.sha256, sha256);

    assert.equal((await fetch(`${baseUrl}/v1/assets/${sha256}`, { headers: headers(nodeAToken) })).status, 403,
      "knowing a media hash is not enough for a Node to download it");
    const prepared = await jsonRequest(baseUrl, "/v1/timeline/prepare", {
      token: CONTROL_TOKEN,
      method: "POST",
      body: { nodeIds: ["render-a"], assetSha256: sha256, baseFrame: 0 },
    });
    assert.equal(prepared.response.status, 200);
    const nodeAsset = await fetch(`${baseUrl}/v1/assets/${sha256}`, { headers: headers(nodeAToken) });
    assert.equal(nodeAsset.status, 200);
    assert.deepEqual(Buffer.from(await nodeAsset.arrayBuffer()), bytes);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${sha256}`, { headers: headers(nodeBToken) })).status, 403);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${sha256}`, { headers: headers(CONTROL_TOKEN) })).status, 200);

    const scopedBytes = [Buffer.from("wall A boot cue\n"), Buffer.from("wall B boot cue\n"), Buffer.from("broadcast boot cue\n")];
    const scopedSha256 = scopedBytes.map((value) => createHash("sha256").update(value).digest("hex"));
    for (const [index, value] of scopedBytes.entries()) {
      const cueUpload = await fetch(`${baseUrl}/v1/media/upload`, {
        method: "POST",
        headers: headers(CONTROL_TOKEN, {
          "content-type": "application/octet-stream",
          "x-file-name": `boot-cue-${index}.bin`,
        }),
        body: value,
      });
      assert.equal(cueUpload.status, 201);
    }
    const currentProject = server.control.getProject();
    currentProject.timeline.cues = [
      { id: "boot-a", assetSha256: scopedSha256[0], startFrame: 0, durationFrames: 1, outputIds: ["A"] },
      { id: "boot-b", assetSha256: scopedSha256[1], startFrame: 0, durationFrames: 1, outputIds: ["B"] },
      { id: "boot-all", assetSha256: scopedSha256[2], startFrame: 0, durationFrames: 1, outputIds: [] },
    ];
    await server.control.saveProject(currentProject, { ifMatchRevision: currentProject.revision });
    for (const [nodeId, token] of [["render-a", nodeAToken], ["render-b", nodeBToken]]) {
      const commandSequence = server.store.state.nodes[nodeId].commandSequence;
      const acknowledgement = await jsonRequest(baseUrl, `/v1/nodes/${nodeId}/heartbeat`, {
        token,
        method: "POST",
        body: { protocolVersion: 1, status: "ready", ackSequence: commandSequence },
      });
      assert.equal(acknowledgement.response.status, 200);
      assert.deepEqual(server.store.state.commandQueues[nodeId], []);
    }
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[0]}`, { headers: headers(nodeAToken) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[1]}`, { headers: headers(nodeAToken) })).status, 403);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[0]}`, { headers: headers(nodeBToken) })).status, 403);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[1]}`, { headers: headers(nodeBToken) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[2]}`, { headers: headers(nodeAToken) })).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/assets/${scopedSha256[2]}`, { headers: headers(nodeBToken) })).status, 200);
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("secured LAN startup and leaked-secret configurations fail closed", async () => {
  const roots = [];
  async function make(options) {
    const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-auth-startup-"));
    roots.push(dataDir);
    return createPixelBrightnessServer({ dataDir, ...options });
  }
  await assert.rejects(
    make({ authToken: CONTROL_TOKEN }),
    /Legacy authToken.*cannot retain control authority/i,
  );
  await assert.rejects(
    make({ nodeSigningKey: NODE_SIGNING_KEY }),
    /requires a distinct.*control token/i,
  );
  await assert.rejects(
    make({ controlToken: CONTROL_TOKEN, nodeSigningKey: CONTROL_TOKEN }),
    /must be distinct/i,
  );
  await assert.rejects(
    make({ controlToken: CONTROL_TOKEN, nodeSigningKey: NODE_SIGNING_KEY, powerActionToken: CONTROL_TOKEN }),
    /Power confirmation token must be distinct/i,
  );
  const legacyOnly = await make({ controlToken: CONTROL_TOKEN });
  try {
    await assert.rejects(
      legacyOnly.listen({ host: "0.0.0.0", port: 0 }),
      /without distinct control and render-node credentials/i,
    );
  } finally {
    await legacyOnly.close();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
