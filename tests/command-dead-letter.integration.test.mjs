import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PixelBrightnessNode } from "../runtime/node/daemon.mjs";
import { hostActionResultId } from "../runtime/node/host-actions.mjs";
import { NodeStateStore } from "../runtime/node/state-store.mjs";
import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { COMMAND, PROTOCOL_VERSION, createCommand, defaultProject } from "../runtime/shared/protocol.mjs";
import { epochNowNs } from "../runtime/shared/timecore.mjs";

let executionLeaseCounter = 0;
function executionLease(nodeId) {
  const issuedAtNs = epochNowNs();
  executionLeaseCounter += 1;
  return {
    schemaVersion: 1,
    leaseId: `execution_lease_${executionLeaseCounter.toString(16).padStart(32, "0")}`,
    nodeId,
    fenceGeneration: 0,
    issuedAtNs: issuedAtNs.toString(),
    expiresAtNs: (issuedAtNs + 5_000_000_000n).toString(),
  };
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 20, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}; last value: ${JSON.stringify(lastValue)}`);
}

function deadLetterEvidence({ nodeId, command, deadLetterId, safetyCritical = true }) {
  const firstFailedAt = new Date(Date.now() - 1_000).toISOString();
  const lastFailedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    deadLetterId,
    nodeId,
    command: { id: command.id, sequence: command.sequence, type: command.type },
    attempts: 2,
    retryBudget: 2,
    safetyCritical,
    firstFailedAt,
    lastFailedAt,
    deadLetteredAt: lastFailedAt,
    errors: [
      { attempt: 1, failedAt: firstFailedAt, name: "Error", code: "FIXTURE_FAILURE", message: "fixture failure" },
      { attempt: 2, failedAt: lastFailedAt, name: "Error", code: "FIXTURE_FAILURE", message: "fixture failure" },
    ],
    failClosed: safetyCritical ? { active: true, blackApplied: true, enforcementError: null } : null,
  };
}

test("Server atomically persists timeline dead-letter evidence and bounded fail-closed compensation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-command-dead-letter-server-"));
  let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "dead-letter-server-node",
      name: "Dead letter server node",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    await server.control.heartbeat("dead-letter-server-node", {
      protocolVersion: PROTOCOL_VERSION,
      status: "ready",
      ackSequence: registration.commandSequence,
    });

    const { poison, later } = await server.store.transaction((state) => {
      const make = (type, payload) => {
        const sequence = state.nextCommandSequence;
        state.nextCommandSequence += 1;
        return {
          protocolVersion: PROTOCOL_VERSION,
          id: `manual-command-${sequence}`,
          sequence,
          type,
          createdAtNs: epochNowNs().toString(),
          effectiveAtNs: null,
          payload,
        };
      };
      const poisoned = make(COMMAND.PLAY_AT, { baseFrame: 0, effectiveAtNs: "not-an-integer" });
      const following = make(COMMAND.STOP, {});
      state.commandQueues["dead-letter-server-node"].push(poisoned, following);
      state.nodes["dead-letter-server-node"].commandSequence = following.sequence;
      return { poison: poisoned, later: following };
    });
    const firstFailedAt = new Date(Date.now() - 1_000).toISOString();
    const lastFailedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: 1,
      deadLetterId: "command_dead_letter_0123456789abcdef0123456789abcdef",
      nodeId: "dead-letter-server-node",
      command: { id: poison.id, sequence: poison.sequence, type: poison.type },
      attempts: 2,
      retryBudget: 2,
      safetyCritical: true,
      firstFailedAt,
      lastFailedAt,
      deadLetteredAt: lastFailedAt,
      errors: [
        { attempt: 1, failedAt: firstFailedAt, name: "SyntaxError", code: "INVALID_TIME", message: "invalid time" },
        { attempt: 2, failedAt: lastFailedAt, name: "SyntaxError", code: "INVALID_TIME", message: "invalid time" },
      ],
      failClosed: { active: true, blackApplied: true, enforcementError: null },
    };

    const originalTransaction = server.store.transaction.bind(server.store);
    let rejectDurableCommit = true;
    server.store.transaction = async (...arguments_) => {
      if (rejectDurableCommit) {
        const error = new Error("simulated dead-letter state disk failure");
        error.code = "ENOSPC";
        throw error;
      }
      return originalTransaction(...arguments_);
    };
    await assert.rejects(
      server.control.heartbeat("dead-letter-server-node", {
        protocolVersion: PROTOCOL_VERSION,
        status: "error",
        ackSequence: registration.commandSequence,
        commandDeadLetters: [evidence],
      }),
      /simulated dead-letter state disk failure/,
    );
    assert.deepEqual(
      server.store.state.commandQueues["dead-letter-server-node"].map((command) => command.id),
      [poison.id, later.id],
      "a failed durable transaction must expose neither audit evidence nor queue pruning",
    );
    assert.deepEqual(server.store.state.commandDeadLetters["dead-letter-server-node"] || [], []);

    rejectDurableCommit = false;
    const accepted = await server.control.heartbeat("dead-letter-server-node", {
      protocolVersion: PROTOCOL_VERSION,
      status: "error",
      ackSequence: registration.commandSequence,
      commandDeadLetters: [evidence],
    });
    assert.deepEqual(accepted.acknowledgedCommandDeadLetterIds, [evidence.deadLetterId]);
    assert.deepEqual(
      server.store.state.commandQueues["dead-letter-server-node"].map((command) => command.id),
      [],
      "later timeline commands from the stale poll lease must be superseded",
    );
    const retained = server.store.state.commandDeadLetters["dead-letter-server-node"][0];
    assert.equal(retained.recovery.status, "operator-review-required");
    assert.equal(retained.queueDisposition, "removed-after-durable-evidence");
    assert.equal(retained.compensation.timelineInvalidated, true);
    assert.ok(retained.compensation.supersededCommands.some((command) => command.id === later.id));

    const replay = await server.control.heartbeat("dead-letter-server-node", {
      protocolVersion: PROTOCOL_VERSION,
      status: "error",
      ackSequence: registration.commandSequence,
      commandDeadLetters: [evidence],
    });
    assert.deepEqual(replay.acknowledgedCommandDeadLetterIds, [evidence.deadLetterId]);
    assert.equal(server.store.state.commandDeadLetters["dead-letter-server-node"].length, 1,
      "lost-response replay must be idempotent");
    await assert.rejects(
      server.control.heartbeat("dead-letter-server-node", {
        protocolVersion: PROTOCOL_VERSION,
        status: "error",
        ackSequence: registration.commandSequence,
        commandDeadLetters: [{
          ...evidence,
          errors: evidence.errors.map((error, index) => index === 1 ? { ...error, message: "changed replay" } : error),
        }],
      }),
      (error) => error?.code === "command_dead_letter_replay_mismatch",
    );

    await server.close();
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    const restored = server.control.getNodeDetail("dead-letter-server-node");
    assert.equal(restored.recentCommandDeadLetters[0].deadLetterId, evidence.deadLetterId);
    assert.equal(restored.recentCommandDeadLetters[0].command.sequence, poison.sequence);
    const durable = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
    assert.equal(durable.commandDeadLetters["dead-letter-server-node"][0].errors[1].message, "invalid time");
    await server.close();
    for (const scenario of [
      {
        name: "forged-latest-summary",
        mutate(state) {
          state.nodes["dead-letter-server-node"].latestCommandDeadLetter.deadLetterId =
            "command_dead_letter_ffffffffffffffffffffffffffffffff";
        },
      },
      {
        name: "forged-count",
        mutate(state) {
          state.nodes["dead-letter-server-node"].commandDeadLetterCount = 2;
        },
      },
      {
        name: "forged-safety-lock",
        mutate(state) {
          state.nodes["dead-letter-server-node"].commandFailureSafetyLock = {
            status: "active",
            deadLetterId: evidence.deadLetterId,
            command: evidence.command,
            blackApplied: false,
            enforcementError: null,
            receivedAt: state.commandDeadLetters["dead-letter-server-node"][0].receivedAt,
          };
        },
      },
    ]) {
      const corruptRoot = join(directory, scenario.name);
      await mkdir(corruptRoot, { recursive: true });
      const corrupt = structuredClone(durable);
      scenario.mutate(corrupt);
      await writeFile(join(corruptRoot, "state.json"), `${JSON.stringify(corrupt)}\n`, "utf8");
      await writeFile(
        join(corruptRoot, "state.last-known-good.json"),
        `${JSON.stringify(durable)}\n`,
        "utf8",
      );
      const recovered = await createPixelBrightnessServer({ dataDir: corruptRoot, offlineAfterMs: 60_000 });
      assert.equal(
        recovered.store.state.commandDeadLetters["dead-letter-server-node"][0].deadLetterId,
        evidence.deadLetterId,
      );
      assert.ok((await readdir(corruptRoot)).some((entry) => entry.startsWith("state.json.invalid-")));
      await recovered.close();
    }
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("lost host-action dead-letter response replays after restart without advancing the Server ACK cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-host-dead-letter-replay-"));
  let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "host-dead-letter-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("host-dead-letter-node", { ackSequence: registration.commandSequence });
    const queuedAction = await server.control.requestHostAction("host-dead-letter-node", {
      type: "RESTART_RENDERER",
      payload: { reason: "dead-letter-replay" },
    });
    const command = server.store.state.commandQueues["host-dead-letter-node"].find((candidate) => (
      candidate.id === queuedAction.command.id
    ));
    const evidence = deadLetterEvidence({
      nodeId: "host-dead-letter-node",
      command,
      deadLetterId: "command_dead_letter_11111111111111111111111111111111",
      safetyCritical: false,
    });
    const ackBefore = server.store.state.nodes["host-dead-letter-node"].ackSequence;
    // Treat the successful transaction response as lost by deliberately not
    // using it before closing/restarting the Server.
    await server.control.heartbeat("host-dead-letter-node", { commandDeadLetters: [evidence] });
    assert.equal(server.store.state.nodes["host-dead-letter-node"].ackSequence, ackBefore);
    assert.equal(server.store.state.actionAudit.at(-1).status, "dead-lettered");
    assert.equal(server.store.state.actionAudit.at(-1).deadLetterId, evidence.deadLetterId);
    await server.close();

    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    const replay = await server.control.heartbeat("host-dead-letter-node", { commandDeadLetters: [evidence] });
    assert.deepEqual(replay.acknowledgedCommandDeadLetterIds, [evidence.deadLetterId]);
    assert.equal(server.store.state.nodes["host-dead-letter-node"].ackSequence, ackBefore);
    assert.equal(server.store.state.commandQueues["host-dead-letter-node"].some(
      (candidate) => candidate.id === command.id,
    ), false);
    await server.control.heartbeat("host-dead-letter-node", { ackSequence: command.sequence });
    assert.equal(server.store.state.nodes["host-dead-letter-node"].ackSequence, command.sequence);
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("a durable Node dead-letter receipt bridges local-ahead restart until the Server cursor catches up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-node-dead-letter-receipt-restart-"));
  const nodeId = "node-dead-letter-receipt";
  const command = { id: "host-action-dead-letter-command", sequence: 1, type: COMMAND.HOST_ACTION };
  const deadLetterId = "command_dead_letter_44444444444444444444444444444444";
  const serverReceivedAt = new Date().toISOString();
  const durable = new NodeStateStore(join(directory, "state.json"));
  await durable.initialize();
  durable.state.lastSequence = 1;
  durable.state.commandFailures = {
    "sequence:1": {
      command,
      status: "dead-lettered",
      attempts: 2,
      retryBudget: 2,
      safetyCritical: false,
      deadLetterId,
      serverAcknowledgedAt: serverReceivedAt,
      updatedAt: serverReceivedAt,
    },
  };
  durable.state.commandDeadLetterReceipts = [{
    schemaVersion: 1,
    status: "server-accepted-awaiting-cursor-ack",
    deadLetterId,
    command,
    serverReceivedAt,
  }];
  await durable.save(durable.state);
  await durable.flush();

  let serverAckSequence = 0;
  const heartbeatAcks = [];
  function client() {
    let aborted = false;
    return {
      time: async () => ({ serverTimeNs: epochNowNs().toString() }),
      register: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        node: { ackSequence: serverAckSequence, commandSequence: 1 },
        commandSequence: 1,
        commandDeadLetters: [{ deadLetterId, command, receivedAt: serverReceivedAt }],
        project: null,
      }),
      state: async () => ({ timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
      heartbeat: async (payload) => {
        heartbeatAcks.push(payload.ackSequence);
        serverAckSequence = Math.max(serverAckSequence, Number(payload.ackSequence) || 0);
        return {
          serverTimeNs: epochNowNs().toString(),
          ackSequence: serverAckSequence,
          acknowledgedActionResultIds: [],
        };
      },
      pollCommands: async () => {
        while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("aborted");
      },
      assetUrl: (sha256) => `/v1/assets/${sha256}`,
      download: async () => { throw new Error("unexpected download"); },
      abort: () => { aborted = true; },
    };
  }
  const nodeConfig = {
    nodeId,
    name: "Dead-letter receipt node",
    version: "0.3.0-test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 20,
    hostTelemetryMs: 60_000,
    clockSyncMs: 60_000,
    clockSyncRounds: 1,
    pollWaitMs: 20,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    maxCacheBytes: 2_000_000,
    hostActionsDryRun: true,
    platform: "darwin",
    logLevel: "error",
    nodeToken: null,
  };
  const dependencies = {
    hostTelemetryCollector: {
      collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: nodeId }, renderer }),
    },
  };
  let node = new PixelBrightnessNode(nodeConfig, dependencies);
  let fakeClient = client();
  node.client = fakeClient;
  node.cache.client = fakeClient;
  try {
    await node.start();
    await waitFor(() => (
      serverAckSequence === 1
      && node.diagnostics().commandDeadLetterReceipts.length === 0
    ), { message: "durable dead-letter cursor handoff" });
    assert.equal(node.diagnostics().stateRecoverySafetyLock, null);
    assert.ok(heartbeatAcks.includes(1));
    await node.stop();

    node = new PixelBrightnessNode(nodeConfig, dependencies);
    fakeClient = client();
    node.client = fakeClient;
    node.cache.client = fakeClient;
    await node.start();
    await waitFor(() => node.diagnostics().connected, { message: "post-handoff restart" });
    assert.equal(node.diagnostics().ackSequence, 1);
    assert.equal(node.diagnostics().commandDeadLetterReceipts.length, 0);
    assert.equal(node.diagnostics().stateRecoverySafetyLock, null);
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("split-running timeline dead letter fences a full peer queue and accepts exact stale superseded evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-timeline-dead-letter-compensation-"));
  let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
  try {
    const registrations = {};
    const latestLeases = {};
    for (const nodeId of ["timeline-a", "timeline-b"]) {
      registrations[nodeId] = await server.control.register({
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
      });
      const heartbeat = await server.control.heartbeat(nodeId, {
        ackSequence: registrations[nodeId].commandSequence,
      });
      latestLeases[nodeId] = heartbeat.executionLease;
    }
    const prepared = await server.control.prepare({ nodeIds: ["timeline-a", "timeline-b"] });
    for (const command of prepared.commands) {
      const target = command === prepared.commands[0] ? "timeline-a" : "timeline-b";
      const heartbeat = await server.control.heartbeat(target, { ackSequence: command.sequence });
      latestLeases[target] = heartbeat.executionLease;
    }
    const played = await server.control.play({ nodeIds: ["timeline-a", "timeline-b"], delayMs: 100 });
    const playA = played.commands[0];
    const playB = played.commands[1];
    await server.store.transaction((state) => {
      const queue = state.commandQueues["timeline-a"];
      while (queue.length < 4_096) {
        const sequence = state.nextCommandSequence;
        state.nextCommandSequence += 1;
        queue.push(createCommand(COMMAND.RESTART_ENGINE, {}, {
          id: `capacity-command-${sequence}`,
          sequence,
          createdAtNs: epochNowNs().toString(),
          effectiveAtNs: null,
        }));
        state.nodes["timeline-a"].commandSequence = sequence;
      }
    });
    assert.equal(server.store.state.commandQueues["timeline-a"].length, 4_096);
    const evidence = deadLetterEvidence({
      nodeId: "timeline-b",
      command: playB,
      deadLetterId: "command_dead_letter_22222222222222222222222222222222",
    });
    const accepted = await server.control.heartbeat("timeline-b", { commandDeadLetters: [evidence] });
    assert.deepEqual(accepted.acknowledgedCommandDeadLetterIds, [evidence.deadLetterId]);
    assert.equal(server.store.state.timeline.status, "idle");
    const retained = server.store.state.commandDeadLetters["timeline-b"].at(-1);
    assert.equal(retained.compensation.timelineInvalidated, true);
    assert.deepEqual(retained.compensation.targetNodeIds, ["timeline-a", "timeline-b"]);
    assert.ok(retained.compensation.supersededCommands.some((reference) => (
      reference.nodeId === "timeline-a"
      && reference.id === playA.id
      && reference.sequence === playA.sequence
      && reference.type === COMMAND.PLAY_AT
    )));
    const peerCommands = server.store.state.commandQueues["timeline-a"];
    assert.equal(peerCommands.length, 4_095);
    assert.ok(peerCommands.every((command) => command.type === COMMAND.RESTART_ENGINE));
    assert.equal(server.store.state.nodes["timeline-a"].failClosedFence.deadLetterId, evidence.deadLetterId);
    assert.equal(server.control.nodeReadiness("timeline-a").ready, false);
    const fenceA = server.store.state.nodes["timeline-a"].failClosedFence;
    assert.ok(BigInt(fenceA.effectiveAtNs) >= BigInt(latestLeases["timeline-a"].expiresAtNs),
      "the emergency boundary must drain every old-generation lease already issued to the peer");
    const fencedPoll = await server.control.pollCommands("timeline-a", 0, 0);
    assert.equal(fencedPoll.executionLease, null);
    assert.deepEqual(fencedPoll.failClosedFence, fenceA);
    const queueBeforeReconnect = structuredClone(server.store.state.commandQueues["timeline-a"]);
    const fencedRegistration = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "timeline-a",
      capabilities: { outputs: [{ id: "A", connector: "DP-1" }] },
    });
    assert.equal(fencedRegistration.executionLease, null);
    assert.deepEqual(fencedRegistration.node.failClosedFence, fenceA);
    assert.deepEqual(server.store.state.commandQueues["timeline-a"], queueBeforeReconnect,
      "reconnect behind an active fence must not enqueue new mutable project work");

    const staleEvidence = deadLetterEvidence({
      nodeId: "timeline-a",
      command: playA,
      deadLetterId: "command_dead_letter_33333333333333333333333333333333",
    });
    await server.control.heartbeat("timeline-a", { commandDeadLetters: [staleEvidence] });
    const inherited = server.store.state.commandDeadLetters["timeline-a"].at(-1).compensation;
    assert.equal(inherited.inheritedFrom, evidence.deadLetterId);
    assert.equal(inherited.timelineInvalidated, false);
    assert.deepEqual(inherited.commands, []);

    await server.close();
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.equal(server.store.state.timeline.status, "idle");
    assert.equal(server.store.state.commandDeadLetters["timeline-a"].length, 1);
    assert.equal(server.store.state.commandDeadLetters["timeline-b"].length, 1);
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("dead-letter evidence timestamps are captured after serialized backlog ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-command-dead-letter-backlog-time-"));
  let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
  try {
    const registration = await server.control.register({
      protocolVersion: PROTOCOL_VERSION,
      nodeId: "timeline-backlog-node",
      capabilities: { outputs: [] },
    });
    await server.control.heartbeat("timeline-backlog-node", { ackSequence: registration.commandSequence });
    await server.control.prepare({ nodeIds: ["timeline-backlog-node"], baseFrame: "0" });
    await server.control.heartbeat("timeline-backlog-node", {
      ackSequence: server.store.state.timeline.prepareSequences["timeline-backlog-node"],
    });
    await server.control.play({ nodeIds: ["timeline-backlog-node"], baseFrame: "0", delayMs: 10_000 });
    const command = server.store.state.commandQueues["timeline-backlog-node"]
      .find((candidate) => candidate.type === COMMAND.PLAY_AT);
    const evidence = deadLetterEvidence({
      nodeId: "timeline-backlog-node",
      command,
      deadLetterId: "command_dead_letter_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    let releaseBlocker;
    const blocker = server.store.transaction(async () => {
      await new Promise((resolve) => { releaseBlocker = resolve; });
    });
    while (!releaseBlocker) await new Promise((resolve) => setTimeout(resolve, 1));
    const publication = server.control.heartbeat("timeline-backlog-node", {
      commandDeadLetters: [evidence],
    });
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    releaseBlocker();
    await blocker;
    await publication;

    const fence = server.store.state.nodes["timeline-backlog-node"].failClosedFence;
    assert.equal(fence.status, "active");
    assert.ok(BigInt(fence.effectiveAtNs)
      <= BigInt(Date.parse(fence.activatedAt)) * 1_000_000n + 6_000_000_000n);
    await server.close();
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.equal(server.store.recoverySnapshot(), null,
      "a valid backlog-delayed fence must hydrate from primary rather than roll back to LKG");
    assert.equal(server.store.state.nodes["timeline-backlog-node"].failClosedFence.deadLetterId,
      evidence.deadLetterId);
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary dead-letter audit capacity cannot block the first fleet emergency fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-command-dead-letter-emergency-capacity-"));
  let server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
  try {
    const registrations = {};
    for (const nodeId of ["capacity-a", "capacity-b"]) {
      registrations[nodeId] = await server.control.register({
        protocolVersion: PROTOCOL_VERSION,
        nodeId,
        capabilities: { outputs: [] },
      });
      await server.control.heartbeat(nodeId, { ackSequence: registrations[nodeId].commandSequence });
    }
    const timestamp = new Date().toISOString();
    await server.store.transaction((state) => {
      const records = [];
      for (let index = 0; index < 4_096; index += 1) {
        const sequence = state.nextCommandSequence;
        state.nextCommandSequence += 1;
        records.push({
          schemaVersion: 1,
          deadLetterId: `command_dead_letter_${index.toString(16).padStart(32, "0")}`,
          nodeId: "capacity-a",
          command: { id: `historical-identify-${sequence}`, sequence, type: COMMAND.IDENTIFY_OUTPUT },
          attempts: 1,
          retryBudget: 1,
          safetyCritical: false,
          firstFailedAt: timestamp,
          lastFailedAt: timestamp,
          deadLetteredAt: timestamp,
          errors: [{
            attempt: 1,
            failedAt: timestamp,
            name: "Error",
            code: "HISTORICAL_FAILURE",
            message: "bounded historical non-safety failure",
          }],
          failClosed: null,
          receivedAt: timestamp,
          status: "dead-lettered",
          recovery: {
            status: "operator-review-required",
            reviewedAt: null,
            disposition: null,
            replacementCommand: null,
          },
          queueDisposition: "removed-after-durable-evidence",
          compensation: {
            timelineInvalidated: false,
            targetNodeIds: [],
            supersededCommands: [],
            commands: [],
            fences: [],
            inheritedFrom: null,
            owner: null,
          },
        });
      }
      state.commandDeadLetters["capacity-a"] = records;
      const latest = records.at(-1);
      state.nodes["capacity-a"].commandSequence = latest.command.sequence;
      state.nodes["capacity-a"].commandDeadLetterCount = records.length;
      state.nodes["capacity-a"].latestCommandDeadLetter = {
        deadLetterId: latest.deadLetterId,
        command: latest.command,
        safetyCritical: false,
        receivedAt: latest.receivedAt,
        recoveryStatus: latest.recovery.status,
      };
      state.nodes["capacity-a"].commandFailureSafetyLock = null;
    });

    await server.control.prepare({ nodeIds: ["capacity-a", "capacity-b"], baseFrame: "0" });
    for (const nodeId of ["capacity-a", "capacity-b"]) {
      await server.control.heartbeat(nodeId, {
        ackSequence: server.store.state.timeline.prepareSequences[nodeId],
      });
    }
    await server.control.play({ nodeIds: ["capacity-a", "capacity-b"], baseFrame: "0", delayMs: 10_000 });
    const command = server.store.state.commandQueues["capacity-a"]
      .find((candidate) => candidate.type === COMMAND.PLAY_AT);
    const evidence = deadLetterEvidence({
      nodeId: "capacity-a",
      command,
      deadLetterId: "command_dead_letter_ffffffffffffffffffffffffffffffff",
    });
    const accepted = await server.control.heartbeat("capacity-a", { commandDeadLetters: [evidence] });
    assert.deepEqual(accepted.acknowledgedCommandDeadLetterIds, [evidence.deadLetterId]);
    assert.equal(server.store.state.commandDeadLetters["capacity-a"].length, 4_097);
    assert.equal(server.store.state.timeline.status, "idle");
    assert.equal(server.store.state.nodes["capacity-a"].failClosedFence.status, "active");
    assert.equal(server.store.state.nodes["capacity-b"].failClosedFence.status, "active");
    await server.close();
    server = await createPixelBrightnessServer({ dataDir: directory, offlineAfterMs: 60_000 });
    assert.equal(server.store.recoverySnapshot(), null);
    assert.equal(server.store.state.commandDeadLetters["capacity-a"].length, 4_097);
    assert.equal(server.store.state.nodes["capacity-b"].failClosedFence.status, "active");
  } finally {
    await server.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("Node dead-letters permanent commands, continues ordered work, and keeps safety failures black", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pb-command-dead-letter-node-"));
  const project = defaultProject();
  let aborted = false;
  const publicationAttempts = new Map();
  const heartbeatPayloads = [];
  const actionCalls = [];
  let serverAckSequence = 0;
  const commands = [
    {
      protocolVersion: PROTOCOL_VERSION,
      id: "poison-transport",
      sequence: 1,
      type: COMMAND.PLAY_AT,
      effectiveAtNs: "not-an-integer",
      payload: { baseFrame: 0 },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      id: "later-host-action",
      sequence: 2,
      type: COMMAND.HOST_ACTION,
      action: { id: "collect-after-poison", type: "COLLECT_DIAGNOSTICS", payload: {} },
      payload: { action: { id: "collect-after-poison", type: "COLLECT_DIAGNOSTICS", payload: {} } },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      id: "poison-safety-pattern",
      sequence: 3,
      type: COMMAND.CALIBRATION_PATTERN,
      payload: { enabled: true, type: "not-a-pattern" },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      id: "later-content-restore",
      sequence: 4,
      type: COMMAND.CALIBRATION_PATTERN,
      payload: { enabled: false, type: "content" },
    },
  ];
  const fakeClient = {
    time: async () => ({ serverTimeNs: epochNowNs().toString() }),
    register: async () => ({
      protocolVersion: PROTOCOL_VERSION,
      node: { ackSequence: serverAckSequence, commandSequence: 4 },
      commandSequence: 4,
      executionLease: executionLease("dead-letter-node"),
      project,
    }),
    state: async () => ({ project, timeline: { status: "idle", targetNodeIds: [] }, media: [] }),
    heartbeat: async (payload) => {
      heartbeatPayloads.push(structuredClone(payload));
      serverAckSequence = Math.max(serverAckSequence, Number(payload.ackSequence) || 0);
      const acknowledgements = [];
      for (const deadLetter of payload.commandDeadLetters || []) {
        const attempt = (publicationAttempts.get(deadLetter.deadLetterId) || 0) + 1;
        publicationAttempts.set(deadLetter.deadLetterId, attempt);
        if (attempt >= 2) acknowledgements.push({
          deadLetterId: deadLetter.deadLetterId,
          sequence: deadLetter.command.sequence,
          receivedAt: new Date().toISOString(),
        });
      }
      return {
        serverTimeNs: epochNowNs().toString(),
        failClosedFence: null,
        executionLease: executionLease("dead-letter-node"),
        acknowledgedCommandDeadLetters: acknowledgements,
        acknowledgedCommandDeadLetterIds: acknowledgements.map((item) => item.deadLetterId),
        acknowledgedActionResultIds: (payload.actionResults || []).map((result) => result.resultId),
      };
    },
    pollCommands: async (after) => {
      // Model the real independent heartbeat path reaching the Server before
      // it dispatches the next queued command. The strict boot contract treats
      // reconnect-before-ACK as an intentional recovery-lock boundary.
      while (!aborted && serverAckSequence < after) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const pending = commands.filter((command) => command.sequence > after).slice(0, 1);
      if (pending.length > 0) return {
        protocolVersion: PROTOCOL_VERSION,
        failClosedFence: null,
        executionLease: executionLease("dead-letter-node"),
        commands: pending,
      };
      while (!aborted) await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("aborted");
    },
    assetUrl: (sha256) => `/v1/assets/${sha256}`,
    download: async () => { throw new Error("unexpected download"); },
    abort: () => { aborted = true; },
  };
  const hostActionExecutor = {
    dryRun: true,
    allowPowerActions: false,
    allowXrandrFallback: false,
    platform: "darwin",
    displayStore: { initialize: async () => null, snapshot: () => null, flush: async () => {} },
    initialize: async () => null,
    execute: async ({ commandId, sequence, action }) => {
      actionCalls.push({ commandId, sequence, action });
      const completedAt = new Date().toISOString();
      return {
        resultId: hostActionResultId(commandId, sequence, action.id),
        commandId,
        sequence,
        actionId: action.id,
        actionType: action.type,
        status: "dry-run",
        startedAt: completedAt,
        completedAt,
        result: { collected: true },
      };
    },
  };
  const hostTelemetryCollector = {
    collect: async ({ renderer }) => ({ schemaVersion: 2, host: { hostname: "dead-letter-node" }, renderer }),
  };
  const config = {
    protocolVersion: PROTOCOL_VERSION,
    nodeId: "dead-letter-node",
    name: "Dead letter node",
    version: "test",
    serverUrl: "http://127.0.0.1:4100",
    dataDir: directory,
    outputs: [{ id: "A", connector: "DP-1" }],
    heartbeatMs: 25,
    hostTelemetryMs: 1_000,
    clockSyncMs: 60_000,
    clockSyncRounds: 3,
    pollWaitMs: 25,
    requestTimeoutMs: 500,
    maxAssetBytes: 1_000_000,
    commandRetryBudget: 2,
    logLevel: "error",
    nodeToken: null,
  };
  const node = new PixelBrightnessNode(config, { hostActionExecutor, hostTelemetryCollector });
  node.client = fakeClient;
  node.cache.client = fakeClient;
  try {
    await node.start();
    try {
      await waitFor(() => node.store.snapshot().lastSequence === 4, {
        message: "dead-letter hand-offs and following ordered commands",
      });
    } catch (error) {
      error.message += `; diagnostics=${JSON.stringify(node.diagnostics())}; durable=${JSON.stringify(node.store.snapshot())}`;
      throw error;
    }
    await waitFor(() => node.store.snapshot().actionResults.length === 0, {
      message: "later host-action result acknowledgement",
    });
    const snapshot = node.store.snapshot();
    assert.equal(snapshot.commandFailures["sequence:1"].attempts, 2);
    assert.equal(snapshot.commandFailures["sequence:1"].status, "dead-lettered");
    assert.equal(snapshot.commandFailures["sequence:1"].safetyCritical, true);
    assert.equal(snapshot.commandFailures["sequence:3"].attempts, 2);
    assert.equal(snapshot.commandFailures["sequence:3"].status, "dead-lettered");
    assert.equal(snapshot.commandFailures["sequence:3"].safetyCritical, true);
    assert.equal(snapshot.commandFailures["sequence:4"].status, "dead-lettered",
      "a later content restore must be rejected into its own visible audit while the lock is active");
    assert.deepEqual(snapshot.pendingCommandDeadLetters, []);
    assert.equal(actionCalls.length, 1, "an unrelated action after poison must execute exactly once");
    assert.equal(node.diagnostics().render.outputs[0].mode, "black",
      "a later content restore must not erase the durable safety lock");
    assert.equal(node.diagnostics().commandFailureSafetyLock.status, "active");
    assert.equal(node.diagnostics().commandFailureSafetyLock.blackApplied, true);
    const firstTransportPublication = heartbeatPayloads.find((payload) => (
      payload.commandDeadLetters?.[0]?.command?.id === "poison-transport"
    ));
    assert.equal(firstTransportPublication.ackSequence, 0,
      "the Node must not advance before Server evidence is durable");
    assert.equal(publicationAttempts.size, 3);
    assert.ok([...publicationAttempts.values()].every((attempts) => attempts >= 2),
      "lost publication responses must replay the same durable ids");
  } finally {
    await node.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
