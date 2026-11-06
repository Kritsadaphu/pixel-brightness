import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { PersistentStore } from "../runtime/server/store.mjs";
import { createIdentityMesh } from "../runtime/shared/mapping.mjs";
import { COMMAND, PROTOCOL_VERSION } from "../runtime/shared/protocol.mjs";

async function json(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(body)}`);
  return body;
}

test("server persists projects/media and coordinates ordered node commands", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-server-"));
  const server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  assert.equal(server.httpServer.requestTimeout, 0, "large media uploads must not be cut off after 60 seconds");
  let restarted;
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await json(baseUrl, "/v1/health");
    assert.equal(health.ok, true);
    assert.equal(health.protocolVersion, PROTOCOL_VERSION);

    const registration = await json(baseUrl, "/v1/nodes/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        nodeId: "render-01",
        name: "North wall node",
        capabilities: {
          outputs: [
            { id: "A", connector: "DP-1" },
            { id: "B", connector: "DP-2" },
            { id: "C", connector: "DP-3" },
          ],
        },
      }),
    });
    assert.equal(registration.node.nodeId, "render-01");

    const initialCommands = await json(baseUrl, "/v1/nodes/render-01/commands?after=0");
    assert.deepEqual(initialCommands.commands.map((command) => command.type), ["sync-project"]);
    const syncSequence = initialCommands.commands[0].sequence;

    await json(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        status: "ready",
        ackSequence: syncSequence,
        telemetry: { currentFrame: "0", clockOffsetNs: "1200", droppedFrames: 0 },
      }),
    });
    const acknowledged = await json(baseUrl, `/v1/nodes/render-01/commands?after=${syncSequence}`);
    assert.equal(acknowledged.commands.length, 0);

    const pattern = await json(baseUrl, "/v1/outputs/A/pattern", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, type: "grid", cellSize: 32 }),
    });
    assert.equal(pattern.outputId, "A");
    assert.deepEqual(pattern.nodeIds, ["render-01"]);
    assert.equal(pattern.commands[0].type, "calibration-pattern");

    const invalidCorrectedGrid = await fetch(`${baseUrl}/v1/outputs/A/pattern`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        type: "grid",
        cellSize: 32,
        applyCorrections: true,
      }),
    });
    assert.equal(invalidCorrectedGrid.status, 400);
    assert.equal(
      (await invalidCorrectedGrid.json()).error.code,
      "invalid_pattern_correction_mode",
    );

    const bytes = Buffer.from("Pixel Brightness deterministic media fixture\n");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const uploadResponse = await fetch(`${baseUrl}/v1/media/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "fixture.bin" },
      body: bytes,
    });
    assert.equal(uploadResponse.status, 201);
    const upload = await uploadResponse.json();
    assert.equal(upload.media.sha256, expectedSha);

    const rangeResponse = await fetch(`${baseUrl}/v1/assets/${expectedSha}`, {
      headers: { range: "bytes=0-4" },
    });
    assert.equal(rangeResponse.status, 206);
    assert.match(rangeResponse.headers.get("cache-control") ?? "", /^private\b/,
      "authenticated show media must never be reusable by a shared HTTP cache");
    assert.equal(await rangeResponse.text(), "Pixel");

    const prepared = await json(baseUrl, "/v1/timeline/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetSha256: expectedSha, baseFrame: 120 }),
    });
    assert.equal(prepared.timeline.status, "prepared");
    assert.equal(prepared.commands[0].type, "prepare");

    const played = await json(baseUrl, "/v1/timeline/play", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ delayMs: 150, baseFrame: 120 }),
    });
    assert.equal(played.timeline.status, "scheduled");
    assert.equal(played.commands[0].type, "play-at");
    assert.ok(BigInt(played.timeline.playAtNs) > BigInt(played.serverTimeNs));

    const projectResponse = await json(baseUrl, "/v1/projects/default");
    projectResponse.project.name = "Persisted room";
    projectResponse.project.denseMeshTransportFixture = "x".repeat(5 * 1024 * 1024);
    const saved = await json(baseUrl, "/v1/projects/default", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": String(projectResponse.project.revision),
      },
      body: JSON.stringify(projectResponse.project),
    });
    assert.equal(saved.project.name, "Persisted room");
    assert.ok(saved.project.revision > projectResponse.project.revision);
    assert.deepEqual(saved.syncTargets, [{
      nodeId: "render-01",
      commandSequence: saved.commandSequence,
    }], "project save must return the exact per-node renderer acknowledgement receipt");

    const state = await json(baseUrl, "/v1/state");
    assert.equal(state.nodes.length, 1);
    assert.equal(state.media.length, 1);
    assert.equal(state.project.name, "Persisted room");
    const compactState = await json(baseUrl, "/v1/state?includeProject=0");
    assert.equal("project" in compactState, false, "the polling endpoint must not resend dense meshes every second");
    assert.equal(compactState.projectRevision, saved.project.revision);

    const originalSnapshot = server.store.snapshot;
    server.store.snapshot = () => { throw new Error("compact polling must not clone the dense authoritative project"); };
    const summaryWithoutFullClone = await json(baseUrl, "/v1/state?includeProject=0");
    assert.equal(summaryWithoutFullClone.projectRevision, saved.project.revision);
    server.store.snapshot = originalSnapshot;

    await server.store.flush();
    const persistedBeforeVolatileHeartbeat = await readFile(join(dataDir, "state.json"), "utf8");
    await json(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        status: "ready",
        ackSequence: syncSequence,
        telemetry: { currentFrame: "999", clockOffsetNs: "1200", droppedFrames: 0 },
        // The real Node includes this bounded snapshot on every heartbeat.
        // Periodic diagnostics are operational telemetry, not durable state;
        // persisting them every two seconds would rewrite every dense mesh.
        diagnostics: {
          render: { backend: "windows-dxgi-native", ready: true, outputs: [] },
          metrics: { heartbeats: 10 },
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const persistedAfterVolatileHeartbeat = await readFile(join(dataDir, "state.json"), "utf8");
    assert.equal(
      persistedAfterVolatileHeartbeat,
      persistedBeforeVolatileHeartbeat,
      "steady 2-second heartbeats must not rewrite the complete dense project to SSD",
    );

    await server.store.transaction((durable) => {
      durable.nodes["render-01"].lastSeenAt = "2099-01-01T00:00:00.000Z";
    });

    await server.close();
    restarted = await createPixelBrightnessServer({ dataDir });
    const restartedAddress = await restarted.listen({ host: "127.0.0.1", port: 0 });
    const restartedState = await json(`http://127.0.0.1:${restartedAddress.port}`, "/v1/state");
    assert.equal(restartedState.project.name, "Persisted room");
    assert.equal(restartedState.media[0].sha256, expectedSha);
    const restartedNode = restartedState.nodes.find((node) => node.nodeId === "render-01");
    assert.equal(restartedNode.status, "offline");
    assert.equal(restartedNode.readiness.active, false);
    assert.equal(restartedNode.readiness.ready, false,
      "persisted or future heartbeat timestamps must never establish liveness in a new Server process");

    await json(`http://127.0.0.1:${restartedAddress.port}`, "/v1/nodes/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        nodeId: "render-01",
        name: "North wall node",
        capabilities: {
          outputs: [
            { id: "A", connector: "DP-1" },
            { id: "B", connector: "DP-2" },
            { id: "C", connector: "DP-3" },
          ],
        },
      }),
    });
    const freshlyRegistered = await json(
      `http://127.0.0.1:${restartedAddress.port}`,
      "/v1/state",
    );
    assert.equal(
      freshlyRegistered.nodes.find((node) => node.nodeId === "render-01").readiness.active,
      true,
      "fresh authenticated registration may establish process-local liveness",
    );
  } finally {
    await server.close().catch(() => {});
    await restarted?.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("one node cannot acknowledge another node's global command sequence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-ack-isolation-"));
  let server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const first = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "ack-node-a",
      name: "Ack node A",
      capabilities: { outputs: [] },
    });
    const second = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "ack-node-b",
      name: "Ack node B",
      capabilities: { outputs: [] },
    });
    assert.ok(second.commandSequence > first.commandSequence);

    await assert.rejects(
      server.control.heartbeat("ack-node-a", {
        protocolVersion: PROTOCOL_VERSION,
        status: "ready",
        ackSequence: second.commandSequence,
      }),
      (error) => error?.code === "ack_sequence_out_of_range",
    );
    assert.equal(server.store.state.nodes["ack-node-a"].ackSequence, 0);
    assert.deepEqual(
      server.store.state.commandQueues["ack-node-a"].map((command) => command.sequence),
      [first.commandSequence],
    );

    await server.close();
    server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.nodes["ack-node-a"].ackSequence, 0);
    assert.deepEqual(
      server.store.state.commandQueues["ack-node-a"].map((command) => command.sequence),
      [first.commandSequence],
      "a rejected cross-node ACK must leave a restartable durable queue",
    );
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("re-registration reports the durable node cursor and sparse per-node sequences do not request reset", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-sparse-node-cursors-"));
  const server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const firstA = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "sparse-node-a",
      capabilities: { outputs: [] },
    });
    const firstB = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "sparse-node-b",
      capabilities: { outputs: [] },
    });
    const prepared = await server.control.prepare({
      nodeIds: ["sparse-node-a", "sparse-node-b"],
      baseFrame: "0",
    });
    const [prepareA, prepareB] = prepared.commands;
    assert.ok(prepareA.sequence > firstB.commandSequence);
    assert.ok(prepareB.sequence > prepareA.sequence);

    const reconnectedA = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "sparse-node-a",
      capabilities: { outputs: [] },
    });
    assert.equal(reconnectedA.commandSequence, prepareA.sequence);
    assert.equal(reconnectedA.node.commandSequence, prepareA.sequence);

    await server.control.heartbeat("sparse-node-a", { ackSequence: firstA.commandSequence });
    await server.control.heartbeat("sparse-node-b", { ackSequence: firstB.commandSequence });
    const [polledA, polledB] = await Promise.all([
      server.control.pollCommands("sparse-node-a", firstA.commandSequence, 0),
      server.control.pollCommands("sparse-node-b", firstB.commandSequence, 0),
    ]);
    assert.deepEqual(polledA.commands.map((command) => command.sequence), [prepareA.sequence]);
    assert.deepEqual(polledB.commands.map((command) => command.sequence), [prepareB.sequence]);
    assert.equal(polledA.resetRequired, false);
    assert.equal(polledB.resetRequired, false);
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("capability-changing re-registration replaces a stale pending scoped SYNC and survives restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-reregister-sync-"));
  let server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const first = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "changing-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    assert.deepEqual(first.project.outputs.map((output) => output.id), ["A"]);
    const second = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "changing-node",
      capabilities: { outputs: [{ id: "B", connector: "DP-2" }] },
    });
    assert.ok(second.commandSequence > first.commandSequence);
    assert.deepEqual(second.project.outputs.map((output) => output.id), ["B"]);
    assert.deepEqual(server.store.state.commandQueues["changing-node"].map((command) => (
      command.payload.project.outputs.map((output) => output.id)
    )), [["B"]]);

    await server.close();
    server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
    const [pending] = server.store.state.commandQueues["changing-node"];
    assert.equal(pending.type, "sync-project");
    assert.deepEqual(pending.payload.project.outputs.map((output) => output.id), ["B"]);
    assert.equal(server.store.state.nodes["changing-node"].commandSequence, second.commandSequence);
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a canonical PREPARE lease survives strict timeline hydration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-prepare-hydration-"));
  let server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "prepare-node",
      name: "Prepare node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("prepare-node", {
      protocolVersion: PROTOCOL_VERSION,
      status: "ready",
      ackSequence: registration.commandSequence,
    });
    const prepared = await server.control.prepare({ nodeIds: ["prepare-node"], baseFrame: "42" });
    const prepareSequence = prepared.commands[0].sequence;
    assert.equal(server.store.state.timeline.status, "prepared");

    await server.close();
    server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.timeline.status, "prepared");
    assert.equal(server.store.state.timeline.baseFrame, "42");
    assert.equal(server.store.state.timeline.prepareSequences["prepare-node"], prepareSequence);
    assert.equal(
      server.store.state.commandQueues["prepare-node"].find((command) => command.sequence === prepareSequence)?.type,
      "prepare",
    );
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("project If-Match accepts the current revision and rejects stale concurrent writers", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-project-cas-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await json(baseUrl, "/v1/projects/default");

    const acceptedResponse = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": `"${initial.project.revision}"`,
      },
      body: JSON.stringify({ ...initial.project, name: "CAS accepted" }),
    });
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json();
    assert.equal(accepted.project.name, "CAS accepted");
    assert.ok(accepted.project.revision > initial.project.revision);

    const staleResponse = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": String(initial.project.revision),
      },
      body: JSON.stringify({ ...accepted.project, name: "stale overwrite" }),
    });
    assert.equal(staleResponse.status, 409);
    const stale = await staleResponse.json();
    assert.equal(stale.error.code, "project_revision_mismatch");
    assert.deepEqual(stale.error.details, {
      expectedRevision: initial.project.revision,
      currentRevision: accepted.project.revision,
    });
    const afterStale = await json(baseUrl, "/v1/projects/default");
    assert.equal(afterStale.project.name, "CAS accepted");
    assert.equal(afterStale.project.revision, accepted.project.revision);

    const candidates = ["concurrent left", "concurrent right"].map((name) => fetch(
      `${baseUrl}/v1/projects/default`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": String(afterStale.project.revision),
        },
        body: JSON.stringify({ ...afterStale.project, name }),
      },
    ));
    const concurrent = await Promise.all(candidates);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409]);

    const final = await json(baseUrl, "/v1/projects/default");
    assert.ok(["concurrent left", "concurrent right"].includes(final.project.name));
    assert.equal(final.project.revision, afterStale.project.revision + 1);

    const inflatedInput = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": String(final.project.revision),
      },
      body: JSON.stringify({
        ...final.project,
        revision: Number.MAX_SAFE_INTEGER,
        name: "Server-owned revision",
      }),
    });
    assert.equal(inflatedInput.status, 200);
    const serverOwned = await inflatedInput.json();
    assert.equal(serverOwned.project.revision, final.project.revision + 1,
      "a client-supplied revision must never inflate the Server sequence");

    const missingPrecondition = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...serverOwned.project, name: "must not overwrite" }),
    });
    assert.equal(missingPrecondition.status, 428);
    assert.equal((await missingPrecondition.json()).error.code, "project_revision_precondition_required");
    const afterMissing = await json(baseUrl, "/v1/projects/default");
    assert.equal(afterMissing.project.name, serverOwned.project.name);
    assert.equal(afterMissing.project.revision, serverOwned.project.revision);

    await server.store.transaction((state) => {
      state.project.revision = Number.MAX_SAFE_INTEGER;
    });
    const beforeExhausted = structuredClone(server.store.state);
    const exhausted = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "if-match": String(Number.MAX_SAFE_INTEGER),
      },
      body: JSON.stringify({ ...server.store.state.project, name: "must not wrap" }),
    });
    assert.equal(exhausted.status, 409);
    assert.equal((await exhausted.json()).error.code, "project_revision_exhausted");
    assert.deepEqual(server.store.state, beforeExhausted,
      "revision exhaustion must reject before publishing project or queue mutations");
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an active timeline rejects project frame-rate changes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-frame-rate-lock-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "frame-rate-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    await server.control.prepare({ nodeIds: ["frame-rate-node"], baseFrame: 0 });
    const before = server.control.getProject();
    const queueBefore = structuredClone(server.store.state.commandQueues["frame-rate-node"]);
    await assert.rejects(
      server.control.saveProject({
        ...before,
        canvas: { ...before.canvas, frameRateNum: 50, frameRateDen: 1 },
        compositionSource: {
          ...before.compositionSource,
          frameRateNum: 50,
          frameRateDen: 1,
        },
      }, { ifMatchRevision: before.revision }),
      (error) => error?.status === 409
        && error?.code === "project_frame_rate_change_requires_idle_timeline",
    );
    assert.equal(server.control.getProject().revision, before.revision);
    assert.deepEqual(server.store.state.commandQueues["frame-rate-node"], queueBefore);

    const renamed = await server.control.saveProject({
      ...before,
      name: "Prepared lease invalidated",
    }, { ifMatchRevision: before.revision });
    assert.equal(renamed.project.revision, before.revision + 1);
    assert.equal(server.store.state.timeline.status, "idle");
    assert.deepEqual(server.store.state.timeline.targetNodeIds, []);
    assert.deepEqual(server.store.state.timeline.prepareSequences, {});
    assert.equal(server.store.state.timeline.preparedAssetSha256, null);
    const queueAfterSave = structuredClone(server.store.state.commandQueues["frame-rate-node"]);
    await assert.rejects(
      server.control.play({ nodeIds: ["frame-rate-node"], delayMs: 150 }),
      (error) => error?.status === 409 && error?.code === "timeline_target_nodes_required",
    );
    assert.deepEqual(server.store.state.commandQueues["frame-rate-node"], queueAfterSave);
    await server.control.prepare({ nodeIds: ["frame-rate-node"], baseFrame: 0 });
    await server.control.play({ nodeIds: ["frame-rate-node"], delayMs: 150 });
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("PREPARE fails atomically when any project cue asset is unavailable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-cue-assets-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "cue-node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    const bytes = Buffer.from("authoritative cue asset\n");
    const cueSha256 = createHash("sha256").update(bytes).digest("hex");
    const beforeProject = server.control.getProject();
    await server.control.saveProject({
      ...beforeProject,
      timeline: {
        cues: [{
          id: "cue-one",
          assetSha256: cueSha256,
          startFrame: 0,
          durationFrames: 60,
          loop: false,
          outputIds: ["A"],
        }],
      },
    }, { ifMatchRevision: beforeProject.revision });

    const timelineBefore = structuredClone(server.store.state.timeline);
    const queueBefore = structuredClone(server.store.state.commandQueues["cue-node"]);
    await assert.rejects(
      server.control.prepare({ nodeIds: ["cue-node"], baseFrame: 0 }),
      (error) => error?.status === 404
        && error?.code === "timeline_asset_not_found"
        && error?.details?.missingSha256?.[0] === cueSha256,
    );
    assert.deepEqual(server.store.state.timeline, timelineBefore);
    assert.deepEqual(server.store.state.commandQueues["cue-node"], queueBefore);

    const upload = await fetch(`${baseUrl}/v1/media/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-file-name": "cue.bin" },
      body: bytes,
    });
    assert.equal(upload.status, 201);
    await server.control.prepare({ nodeIds: ["cue-node"], baseFrame: 0 });
    const prepareCommand = server.store.state.commandQueues["cue-node"].at(-1);
    assert.deepEqual(prepareCommand.payload.assets.map((asset) => asset.sha256), [cueSha256]);

    const current = server.control.getProject();
    await assert.rejects(
      server.control.saveProject({
        ...current,
        timeline: {
          cues: [{
            id: "invalid-cue",
            assetSha256: "not-a-digest",
            startFrame: 0,
            durationFrames: 1,
            loop: false,
            outputIds: [],
          }],
        },
      }, { ifMatchRevision: current.revision }),
      (error) => error?.status === 400 && error?.code === "invalid_project",
    );
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pause and seek cannot split one authoritative timeline across render nodes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-timeline-targets-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    for (const [nodeId, outputId] of [["timeline-a", "A"], ["timeline-b", "B"]]) {
      await server.control.register({
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        capabilities: { outputs: [{ id: outputId, connector: `DP-${outputId}` }] },
      });
    }
    await assert.rejects(
      server.control.play({ nodeIds: ["timeline-a", "timeline-b"], delayMs: 150 }),
      (error) => error?.status === 409 && error?.code === "timeline_target_nodes_required",
    );
    await server.control.prepare({ nodeIds: ["timeline-a", "timeline-b"], baseFrame: 0 });
    await assert.rejects(
      server.control.play({ nodeIds: ["timeline-a"], delayMs: 150 }),
      (error) => error?.status === 409 && error?.code === "timeline_target_nodes_mismatch",
    );
    await server.control.play({ delayMs: 150 });

    const timelineBefore = structuredClone(server.store.state.timeline);
    const queuesBefore = structuredClone(server.store.state.commandQueues);
    for (const operation of [
      () => server.control.pause({ nodeIds: ["timeline-a"], delayMs: 100 }),
      () => server.control.seek({ nodeIds: ["timeline-b"], frame: 120, delayMs: 100 }),
      () => server.control.pause({ nodeIds: [], delayMs: 100 }),
    ]) {
      await assert.rejects(operation(), (error) => error?.status >= 400);
      assert.deepEqual(server.store.state.timeline, timelineBefore);
      assert.deepEqual(server.store.state.commandQueues, queuesBefore);
    }

    const paused = await server.control.pause({ delayMs: 100 });
    assert.deepEqual(paused.nodeIds.sort(), ["timeline-a", "timeline-b"]);
    assert.equal(paused.commands.length, 2);
    assert.deepEqual(server.store.state.timeline.targetNodeIds.sort(), ["timeline-a", "timeline-b"]);
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("dense project sync commands coalesce only across a contiguous trailing run", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-sync-coalesce-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await json(baseUrl, "/v1/nodes/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        nodeId: "offline-render-01",
        capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
      }),
    });
    await json(baseUrl, "/v1/outputs/A/pattern", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, type: "grid", cellSize: 32 }),
    });

    let current = (await json(baseUrl, "/v1/projects/default")).project;
    current.outputs[0].warp = { ...createIdentityMesh(128, 128), enabled: true };
    for (let revision = 0; revision < 6; revision += 1) {
      const saved = await json(baseUrl, "/v1/projects/default", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "if-match": String(current.revision),
        },
        body: JSON.stringify({
          ...current,
          name: `Dense edit ${revision}`,
        }),
      });
      current = saved.project;
    }

    const poll = await json(baseUrl, "/v1/nodes/offline-render-01/commands?after=0");
    const syncCommands = poll.commands.filter((command) => command.type === "sync-project");
    const patternIndex = poll.commands.findIndex((command) => command.type === "calibration-pattern");
    assert.equal(syncCommands.length, 2, "a sync separated by an ordered command must remain queued");
    assert.ok(patternIndex > 0, "the ordered command must follow its authoritative project snapshot");
    assert.equal(poll.commands[patternIndex - 1].type, "sync-project");
    assert.ok(
      poll.commands[patternIndex - 1].payload.revision < current.revision,
      "the dependency snapshot must not be replaced across the ordered command",
    );
    assert.equal(poll.commands.at(-1).type, "sync-project");
    assert.equal(poll.commands.at(-1).payload.revision, current.revision);
    assert.equal(poll.commands.at(-1).payload.project.name, "Dense edit 5");

    await server.store.flush();
    const durable = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
    assert.equal(
      durable.commandQueues["offline-render-01"].filter((command) => command.type === "sync-project").length,
      2,
    );
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a full durable command queue rejects the whole mutation instead of dropping ordered history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-command-capacity-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await json(baseUrl, "/v1/nodes/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        nodeId: "capacity-render-01",
        capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
      }),
    });

    await server.store.transaction((draft) => {
      draft.commandQueues["capacity-render-01"] = Array.from({ length: 4_096 }, (_, index) => ({
        protocolVersion: PROTOCOL_VERSION,
        id: `capacity-${index + 1}`,
        sequence: index + 2,
        type: COMMAND.STOP,
        createdAtNs: "1",
        effectiveAtNs: null,
        payload: {},
      }));
      draft.nextCommandSequence = 4_098;
      draft.nodes["capacity-render-01"].commandSequence = 4_097;
    });
    const before = JSON.stringify(server.store.state);

    const response = await fetch(`${baseUrl}/v1/outputs/A/pattern`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, type: "grid", cellSize: 32 }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "command_queue_capacity");
    assert.equal(JSON.stringify(server.store.state), before, "failed enqueue must not publish any sibling state mutation");
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("multi-node project save rolls back earlier enqueues when a later node queue is full", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-command-capacity-multinode-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const [nodeId, outputId, connector] of [
      ["capacity-render-a", "A", "DP-1"],
      ["capacity-render-b", "B", "DP-2"],
    ]) {
      await json(baseUrl, "/v1/nodes/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          nodeId,
          capabilities: { outputs: [{ id: outputId, connector }] },
        }),
      });
    }
    await server.store.transaction((draft) => {
      draft.commandQueues["capacity-render-b"] = Array.from({ length: 4_096 }, (_, index) => ({
        protocolVersion: PROTOCOL_VERSION,
        id: `capacity-b-${index + 1}`,
        sequence: index + 10,
        type: COMMAND.STOP,
        createdAtNs: "1",
        effectiveAtNs: null,
        payload: {},
      }));
      draft.nextCommandSequence = 4_106;
      draft.nodes["capacity-render-b"].commandSequence = 4_105;
    });
    const before = JSON.stringify(server.store.state);
    const project = (await json(baseUrl, "/v1/projects/default")).project;

    const response = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(project.revision) },
      body: JSON.stringify({ ...project, name: "must roll back across both nodes" }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "command_queue_capacity");
    assert.equal(JSON.stringify(server.store.state), before);
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("durable store transactions do not publish memory state when the atomic write fails", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-store-rollback-"));
  const store = new PersistentStore(dataDir);
  try {
    await store.init();
    const before = store.snapshot();
    await rm(store.statePath, { force: true });
    await mkdir(store.statePath);
    await assert.rejects(
      store.transaction((draft) => {
        draft.project.name = "must never become visible";
        draft.nextCommandSequence += 100;
      }),
    );
    assert.deepEqual(store.snapshot(), before, "RAM must remain exactly at the last durable state");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("server rejects destructive or folded authoritative warp meshes without changing the project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-project-mesh-"));
  const server = await createPixelBrightnessServer({ dataDir });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await json(baseUrl, "/v1/projects/default");
    const invalidCount = structuredClone(initial.project);
    invalidCount.outputs[0].warp = { enabled: true, columns: 2, rows: 2, interpolation: "bicubic", points: [] };
    const countResponse = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(initial.project.revision) },
      body: JSON.stringify(invalidCount),
    });
    assert.equal(countResponse.status, 400);
    assert.match((await countResponse.json()).error.message, /points count must equal/);

    const folded = structuredClone(initial.project);
    const mesh = createIdentityMesh(2, 2);
    mesh.points[1].x = -0.25;
    folded.outputs[0].warp = { ...mesh, enabled: true };
    const foldedResponse = await fetch(`${baseUrl}/v1/projects/default`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(initial.project.revision) },
      body: JSON.stringify(folded),
    });
    assert.equal(foldedResponse.status, 400);
    assert.match((await foldedResponse.json()).error.message, /folded or degenerate cell/);

    const unchanged = await json(baseUrl, "/v1/projects/default");
    assert.equal(unchanged.project.revision, initial.project.revision);
    assert.deepEqual(unchanged.project.outputs[0].warp, initial.project.outputs[0].warp);
  } finally {
    await server.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});
