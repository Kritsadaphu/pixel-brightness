import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { hostActionResultId } from "../runtime/node/host-actions.mjs";
import { createNodeCredential } from "../runtime/shared/node-auth.mjs";

const API_TOKEN = "fleet-api-token";
const POWER_TOKEN = "fleet-power-confirmation-token";
const NODE_SIGNING_KEY = "fleet-node-signing-key-0000000000000001";
const NODE_TOKEN = createNodeCredential("render-01", NODE_SIGNING_KEY);

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${API_TOKEN}`, ...extra };
}

function nodeHeaders(extra = {}) {
  return { authorization: `Bearer ${NODE_TOKEN}`, ...extra };
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

test("Ubuntu fleet telemetry, diagnostics, allowlisted actions, and power gates are durable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-fleet-"));
  let server = await createPixelBrightnessServer({
    dataDir,
    controlToken: API_TOKEN,
    nodeSigningKey: NODE_SIGNING_KEY,
    powerActionToken: POWER_TOKEN,
    allowPowerActions: false,
    offlineAfterMs: 60_000,
  });
  try {
    let address = await server.listen({ host: "127.0.0.1", port: 0 });
    let baseUrl = `http://127.0.0.1:${address.port}`;

    const preflight = await fetch(`${baseUrl}/v1/nodes/render-01/actions`, {
      method: "OPTIONS",
      headers: { "access-control-request-headers": "authorization,content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);

    const unauthorizedRegistration = await request(baseUrl, "/v1/nodes/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, nodeId: "render-01", capabilities: {} }),
    });
    assert.equal(unauthorizedRegistration.response.status, 401);

    const registration = await request(baseUrl, "/v1/nodes/register", {
      method: "POST",
      headers: nodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        protocolVersion: 1,
        nodeId: "render-01",
        capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
      }),
    });
    assert.equal(registration.response.status, 201);

    const unauthorizedAction = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "RESTART_RENDERER" }),
    });
    assert.equal(unauthorizedAction.response.status, 401);

    const arbitraryAction = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "RUN_SHELL", payload: { command: "whoami" } }),
    });
    assert.equal(arbitraryAction.response.status, 400);
    assert.equal(arbitraryAction.body.error.code, "unsupported_host_action");

    const queued = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "RESTART_RENDERER", payload: { reason: "fleet-test" } }),
    });
    assert.equal(queued.response.status, 202);
    assert.equal(queued.body.action.status, "queued");
    assert.equal(queued.body.command.type, "HOST_ACTION");
    assert.equal(JSON.stringify(queued.body).includes(POWER_TOKEN), false);

    const commandPoll = await request(baseUrl, "/v1/nodes/render-01/commands?after=0", {
      headers: nodeHeaders(),
    });
    assert.equal(commandPoll.response.status, 200);
    const hostCommand = commandPoll.body.commands.find((command) => command.id === queued.body.command.id);
    assert.equal(hostCommand.type, "HOST_ACTION");
    assert.equal(hostCommand.action.type, "RESTART_RENDERER");
    assert.deepEqual(hostCommand.action.payload, { reason: "fleet-test" });
    assert.equal(hostCommand.action.confirmationToken, undefined);

    const resultId = hostActionResultId(hostCommand.id, hostCommand.sequence, hostCommand.action.id);
    const completedAt = new Date().toISOString();
    const heartbeatPayload = {
      protocolVersion: 1,
      status: "ready",
      host: {
        capturedAt: completedAt,
        hostname: "render-01",
        kernel: "6.8.0-ubuntu",
        driver: { status: "failed" },
        displays: [{ name: "DP-1", status: "disconnected", edidHash: "abc123" }],
        services: { renderer: { active: false, state: "failed" } },
      },
      actionResults: [{
        resultId,
        commandId: hostCommand.id,
        sequence: hostCommand.sequence,
        actionId: hostCommand.action.id,
        actionType: "RESTART_RENDERER",
        status: "failed",
        startedAt: completedAt,
        completedAt,
        error: { code: "RENDERER_RESTART_FAILED", message: "renderer unit failed", details: null },
      }],
    };
    for (const forgedResult of [
      {
        ...heartbeatPayload.actionResults[0],
        commandId: "cmd-orphan",
        resultId: hostActionResultId("cmd-orphan", hostCommand.sequence, hostCommand.action.id),
      },
      {
        ...heartbeatPayload.actionResults[0],
        actionId: "action-forged",
        resultId: hostActionResultId(hostCommand.id, hostCommand.sequence, "action-forged"),
      },
      {
        ...heartbeatPayload.actionResults[0],
        actionType: "RESTART_NODE",
      },
    ]) {
      const before = JSON.stringify(server.store.state);
      const forged = await request(baseUrl, "/v1/nodes/render-01/heartbeat", {
        method: "POST",
        headers: nodeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ protocolVersion: 1, status: "ready", actionResults: [forgedResult] }),
      });
      assert.equal(forged.response.status, 409);
      assert.equal(forged.body.error.code, "host_action_result_authority_mismatch");
      assert.equal(JSON.stringify(server.store.state), before, "forged result must leave state byte-identical");
    }
    const heartbeat = await request(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: nodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(heartbeatPayload),
    });
    assert.equal(heartbeat.response.status, 200);
    assert.deepEqual(heartbeat.body.acknowledgedActionResultIds, [resultId]);

    const repeated = await request(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: nodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(heartbeatPayload),
    });
    assert.deepEqual(repeated.body.acknowledgedActionResultIds, [resultId]);

    const beforeChangedReplay = JSON.stringify(server.store.state);
    const changedReplay = await request(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: nodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        ...heartbeatPayload,
        actionResults: [{
          ...heartbeatPayload.actionResults[0],
          error: {
            ...heartbeatPayload.actionResults[0].error,
            message: "changed terminal evidence",
          },
        }],
      }),
    });
    assert.equal(changedReplay.response.status, 409);
    assert.equal(changedReplay.body.error.code, "host_action_result_replay_mismatch");
    assert.equal(JSON.stringify(server.store.state), beforeChangedReplay, "changed replay must roll back heartbeat state");

    const detail = await request(baseUrl, "/v1/nodes/render-01", { headers: authHeaders() });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.node.host.hostname, "render-01");
    assert.equal(detail.body.recentActions.length, 1, "idempotent action result must not duplicate audit rows");
    assert.ok(detail.body.readiness.driverFaults >= 1);
    assert.ok(detail.body.readiness.displayFaults >= 1);

    const diagnostics = await request(baseUrl, "/v1/nodes/render-01/diagnostics", { headers: authHeaders() });
    assert.equal(diagnostics.response.status, 200);
    assert.equal(diagnostics.body.host.kernel, "6.8.0-ubuntu");
    assert.equal(diagnostics.body.lastActionResult.status, "failed");

    const state = await request(baseUrl, "/v1/state", { headers: authHeaders() });
    assert.ok(state.body.timeline.readiness.driverFaults >= 1);
    assert.ok(state.body.timeline.readiness.displayFaults >= 1);
    assert.ok(state.body.fleet.warnings.some((warning) => warning.nodeId === "render-01"));

    const disabledPower = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "REBOOT_HOST", confirmationPhrase: "REBOOT render-01" }),
    });
    assert.equal(disabledPower.response.status, 403);
    assert.equal(disabledPower.body.error.code, "power_actions_disabled");

    await server.close();
    server = await createPixelBrightnessServer({
      dataDir,
      controlToken: API_TOKEN,
      nodeSigningKey: NODE_SIGNING_KEY,
      powerActionToken: POWER_TOKEN,
      allowPowerActions: true,
      offlineAfterMs: 60_000,
    });
    address = await server.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;

    const persisted = await request(baseUrl, "/v1/nodes/render-01/diagnostics", { headers: authHeaders() });
    assert.equal(persisted.body.host.hostname, "render-01");
    assert.ok(persisted.body.actions.some((action) => action.status === "rejected"));
    assert.ok(persisted.body.actions.some((action) => action.status === "failed"));

    const wrongPhrase = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "REBOOT_HOST", confirmationPhrase: "REBOOT wrong-node" }),
    });
    assert.equal(wrongPhrase.response.status, 400);
    assert.equal(wrongPhrase.body.error.code, "confirmation_phrase_mismatch");

    const reboot = await request(baseUrl, "/v1/nodes/render-01/actions", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ type: "REBOOT_HOST", confirmationPhrase: "REBOOT render-01" }),
    });
    assert.equal(reboot.response.status, 202);
    assert.equal(JSON.stringify(reboot.body).includes(POWER_TOKEN), false);

    const rebootPoll = await request(baseUrl, "/v1/nodes/render-01/commands?after=0", {
      headers: nodeHeaders(),
    });
    const rebootCommand = rebootPoll.body.commands.find((command) => command.id === reboot.body.command.id);
    assert.equal(rebootCommand.action.type, "REBOOT_HOST");
    assert.equal(rebootCommand.action.confirmationToken, POWER_TOKEN);

    const deniedResult = await request(baseUrl, "/v1/nodes/render-01/heartbeat", {
      method: "POST",
      headers: nodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        protocolVersion: 1,
        status: "ready",
        actionResults: [{
          resultId: hostActionResultId(rebootCommand.id, rebootCommand.sequence, rebootCommand.action.id),
          commandId: rebootCommand.id,
          sequence: rebootCommand.sequence,
          actionId: rebootCommand.action.id,
          actionType: "REBOOT_HOST",
          status: "denied",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          error: { code: "POWER_ACTIONS_DISABLED", message: "node power gate rejected action", details: null },
        }],
      }),
    });
    assert.deepEqual(deniedResult.body.acknowledgedActionResultIds, [
      hostActionResultId(rebootCommand.id, rebootCommand.sequence, rebootCommand.action.id),
    ]);
    const deniedDiagnostics = await request(baseUrl, "/v1/nodes/render-01/diagnostics", { headers: authHeaders() });
    assert.ok(deniedDiagnostics.body.actions.some((action) => (
      action.commandId === rebootCommand.id && action.status === "denied"
    )));
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("bounded action-audit pruning retains exactly coupled terminal result evidence across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-action-audit-capacity-"));
  let server = await createPixelBrightnessServer({
    dataDir,
    maxActionAudit: 100,
    offlineAfterMs: 60_000,
  });
  try {
    const registration = await server.control.register({
      protocolVersion: 1,
      nodeId: "capacity-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("capacity-node", { ackSequence: registration.commandSequence });
    let finalResultId;
    for (let index = 0; index < 101; index += 1) {
      const queued = await server.control.requestHostAction("capacity-node", {
        type: "RESTART_RENDERER",
        payload: { index },
      }, { requestedBy: "capacity-test" });
      const command = server.store.state.commandQueues["capacity-node"].find((candidate) => (
        candidate.id === queued.command.id
      ));
      const completedAt = new Date().toISOString();
      finalResultId = hostActionResultId(command.id, command.sequence, command.action.id);
      await server.control.heartbeat("capacity-node", {
        ackSequence: command.sequence,
        actionResults: [{
          resultId: finalResultId,
          commandId: command.id,
          sequence: command.sequence,
          actionId: command.action.id,
          actionType: command.action.type,
          status: "succeeded",
          startedAt: completedAt,
          completedAt,
          result: { restarted: true, index },
        }],
      });
    }
    assert.equal(server.store.state.actionAudit.length, 100);
    assert.equal(Object.keys(server.store.state.processedActionResults).length, 100);
    assert.ok(server.store.state.processedActionResults[finalResultId]);

    await server.close();
    server = await createPixelBrightnessServer({ dataDir, maxActionAudit: 100, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.actionAudit.length, 100);
    assert.equal(Object.keys(server.store.state.processedActionResults).length, 100);
    assert.equal(server.store.state.nodes["capacity-node"].lastActionResult.resultId, finalResultId);
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("forged persisted host-action result evidence restores the exact LKG", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-action-result-lkg-"));
  let server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: 1,
      nodeId: "action-lkg-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("action-lkg-node", { ackSequence: registration.commandSequence });
    const queued = await server.control.requestHostAction("action-lkg-node", {
      type: "RESTART_RENDERER",
      payload: { reason: "lkg-test" },
    });
    const command = server.store.state.commandQueues["action-lkg-node"].find((candidate) => (
      candidate.id === queued.command.id
    ));
    const completedAt = new Date().toISOString();
    const resultId = hostActionResultId(command.id, command.sequence, command.action.id);
    await server.control.heartbeat("action-lkg-node", {
      ackSequence: command.sequence,
      actionResults: [{
        resultId,
        commandId: command.id,
        sequence: command.sequence,
        actionId: command.action.id,
        actionType: command.action.type,
        status: "succeeded",
        startedAt: completedAt,
        completedAt,
        result: { restarted: true },
      }],
    });
    await server.store.transaction((state) => {
      state.nodes["action-lkg-node"].lastSeenAt = "2099-01-01T00:00:00.000Z";
    });
    await server.close();

    const statePath = join(dataDir, "state.json");
    const forged = JSON.parse(await readFile(statePath, "utf8"));
    forged.processedActionResults[resultId].result.result.restarted = false;
    await writeFile(statePath, `${JSON.stringify(forged)}\n`, "utf8");

    server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.processedActionResults[resultId].result.result.restarted, true);
    assert.equal(server.store.state.nodes["action-lkg-node"].lastActionResult.resultId, resultId);
    assert.ok((await readdir(dataDir)).some((entry) => entry.startsWith("state.json.invalid-")));
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("host-action ACK cannot prune a command before exact terminal evidence is durable", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-brightness-action-ack-gate-"));
  const server = await createPixelBrightnessServer({ dataDir, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: 1,
      nodeId: "action-ack-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("action-ack-node", { ackSequence: registration.commandSequence });
    const queued = await server.control.requestHostAction("action-ack-node", {
      type: "RESTART_RENDERER",
      payload: { reason: "ack-gate" },
    });
    const command = server.store.state.commandQueues["action-ack-node"].find((candidate) => (
      candidate.id === queued.command.id
    ));
    const before = JSON.stringify(server.store.state);
    await assert.rejects(
      server.control.heartbeat("action-ack-node", { ackSequence: command.sequence }),
      (error) => error?.status === 409 && error?.code === "host_action_ack_result_required",
    );
    assert.equal(JSON.stringify(server.store.state), before);

    const completedAt = new Date().toISOString();
    const result = {
      resultId: hostActionResultId(command.id, command.sequence, command.action.id),
      commandId: command.id,
      sequence: command.sequence,
      actionId: command.action.id,
      actionType: command.action.type,
      status: "succeeded",
      startedAt: completedAt,
      completedAt,
      result: { restarted: true },
    };
    const published = await server.control.heartbeat("action-ack-node", { actionResults: [result] });
    assert.deepEqual(published.acknowledgedActionResultIds, [result.resultId]);
    assert.ok(server.store.state.commandQueues["action-ack-node"].some((candidate) => candidate.id === command.id));

    await server.control.heartbeat("action-ack-node", { ackSequence: command.sequence });
    assert.equal(server.store.state.nodes["action-ack-node"].ackSequence, command.sequence);
    assert.ok(!server.store.state.commandQueues["action-ack-node"].some((candidate) => candidate.id === command.id));

    const second = await server.control.requestHostAction("action-ack-node", {
      type: "RESTART_RENDERER",
      payload: { reason: "same-transaction" },
    });
    const secondCommand = server.store.state.commandQueues["action-ack-node"].find((candidate) => (
      candidate.id === second.command.id
    ));
    const secondAt = new Date().toISOString();
    const secondResult = {
      resultId: hostActionResultId(secondCommand.id, secondCommand.sequence, secondCommand.action.id),
      commandId: secondCommand.id,
      sequence: secondCommand.sequence,
      actionId: secondCommand.action.id,
      actionType: secondCommand.action.type,
      status: "dry-run",
      startedAt: secondAt,
      completedAt: secondAt,
      result: { dryRun: true },
    };
    await server.control.heartbeat("action-ack-node", {
      ackSequence: secondCommand.sequence,
      actionResults: [secondResult],
    });
    assert.equal(server.store.state.nodes["action-ack-node"].ackSequence, secondCommand.sequence);
    assert.ok(server.store.state.processedActionResults[secondResult.resultId]);
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
