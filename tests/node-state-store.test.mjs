import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeStateStore } from "../runtime/node/state-store.mjs";
import {
  COMMAND,
  createCommand,
  defaultProject,
  normalizeProject,
} from "../runtime/shared/protocol.mjs";

function hostResultId(commandId, sequence, actionId) {
  const digest = createHash("sha256")
    .update(`${commandId}:${sequence}:${actionId}`)
    .digest("hex")
    .slice(0, 24);
  return `host-result-${digest}`;
}

function installPendingSafetyDeadLetter(state, sequence = 5) {
  const command = { id: `cmd-${sequence}`, sequence, type: "play-at" };
  const deadLetterId = `command_dead_letter_${"a".repeat(32)}`;
  state.lastSequence = sequence - 1;
  state.pendingCommandDeadLetters = [{
    schemaVersion: 1,
    deadLetterId,
    nodeId: "render-01",
    command,
    attempts: 3,
    retryBudget: 3,
    safetyCritical: true,
  }];
  state.commandFailures = {
    [`sequence:${sequence}`]: {
      command,
      deadLetterId,
      status: "pending-server",
      attempts: 3,
      retryBudget: 3,
      safetyCritical: true,
    },
  };
  state.commandFailureSafetyLock = {
    schemaVersion: 1,
    status: "active",
    activatedAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    command,
    deadLetterId,
    attempts: 3,
    reason: { code: "TEST_FAILURE", message: "fixture" },
    blackApplied: true,
    lastEnforcedAt: "2026-08-25T00:00:00.000Z",
    enforcementError: null,
  };
}

test("node state is externally committed only after its atomic rename succeeds", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-"));
  const pathname = path.join(directory, "node-state.json");
  let rejectRename = false;
  const store = new NodeStateStore(pathname, {
    rename: async (...arguments_) => {
      if (rejectRename) {
        const error = new Error("simulated disk-full rename failure");
        error.code = "ENOSPC";
        throw error;
      }
      return rename(...arguments_);
    },
  });

  try {
    await store.initialize();
    const durableBefore = JSON.parse(await readFile(pathname, "utf8"));
    assert.equal(durableBefore.lastSequence, 0);

    store.state.lastSequence = 7;
    store.state.project = normalizeProject(defaultProject());
    rejectRename = true;
    const failedCommit = store.save(store.state);

    assert.equal(store.snapshot().lastSequence, 0, "pending RAM must not become an acknowledgeable snapshot");
    assert.equal(store.snapshot().project, null);
    await assert.rejects(failedCommit, /simulated disk-full rename failure/);
    assert.equal(store.state.lastSequence, 0, "failed newest draft must roll RAM back to durable state");
    assert.equal(store.state.project, null);

    const durableAfter = JSON.parse(await readFile(pathname, "utf8"));
    assert.equal(durableAfter.lastSequence, 0);
    assert.equal(durableAfter.project, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued state commits expose only the last successful durable candidate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-queue-"));
  const pathname = path.join(directory, "node-state.json");
  const store = new NodeStateStore(pathname);
  try {
    await store.initialize();
    store.state.lastSequence = 1;
    const first = store.save(store.state);
    store.state.lastSequence = 2;
    const second = store.save(store.state);
    await Promise.all([first, second]);

    assert.equal(store.snapshot().lastSequence, 2);
    assert.equal(store.state.lastSequence, 2);
    assert.equal(JSON.parse(await readFile(pathname, "utf8")).lastSequence, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dead-letter cursor advancement cannot outrun retained publication evidence on disk failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-dead-letter-state-"));
  const pathname = path.join(directory, "node-state.json");
  let rejectRename = false;
  const store = new NodeStateStore(pathname, {
    rename: async (...arguments_) => {
      if (rejectRename) {
        const error = new Error("simulated dead-letter acknowledgement disk failure");
        error.code = "ENOSPC";
        throw error;
      }
      return rename(...arguments_);
    },
  });
  try {
    await store.initialize();
    const deadLetter = {
      schemaVersion: 1,
      deadLetterId: "command_dead_letter_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nodeId: "render-01",
      command: { id: "cmd-5", sequence: 5, type: "play-at" },
      attempts: 3,
      retryBudget: 3,
      safetyCritical: false,
    };
    store.state.lastSequence = 4;
    store.state.pendingCommandDeadLetters = [deadLetter];
    store.state.commandFailures = {
      "sequence:5": {
        command: deadLetter.command,
        deadLetterId: deadLetter.deadLetterId,
        status: "pending-server",
        safetyCritical: false,
      },
    };
    await store.save(store.state);

    store.state.lastSequence = 5;
    store.state.pendingCommandDeadLetters = [];
    store.state.commandFailures["sequence:5"].status = "dead-lettered";
    rejectRename = true;
    await assert.rejects(
      store.save(store.state),
      /simulated dead-letter acknowledgement disk failure/,
    );
    assert.equal(store.snapshot().lastSequence, 4);
    assert.equal(store.snapshot().pendingCommandDeadLetters[0].deadLetterId, deadLetter.deadLetterId);
    assert.equal(store.snapshot().commandFailures["sequence:5"].status, "pending-server");

    const reopened = new NodeStateStore(pathname);
    const restored = await reopened.initialize();
    assert.equal(restored.lastSequence, 4);
    assert.equal(restored.pendingCommandDeadLetters[0].command.sequence, 5,
      "restart must replay evidence instead of silently acknowledging poison");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node state refuses an unknown schema instead of silently resetting acknowledgements", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-schema-"));
  const pathname = path.join(directory, "node-state.json");
  try {
    await writeFile(pathname, `${JSON.stringify({ schemaVersion: 99, lastSequence: 42 })}\n`, "utf8");
    const store = new NodeStateStore(pathname);
    await assert.rejects(store.initialize(), /Unsupported or missing Node state schema/);
    assert.equal(JSON.parse(await readFile(pathname, "utf8")).lastSequence, 42,
      "an incompatible durable state must remain untouched for explicit migration/recovery");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node state fsync failures cannot publish a cursor past retained safety evidence", async (t) => {
  for (const failurePoint of ["file", "directory"]) {
    await t.test(`${failurePoint} sync failure`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `pb-node-state-${failurePoint}-sync-`));
      const pathname = path.join(directory, "node-state.json");
      let rejectSync = false;
      const store = new NodeStateStore(pathname, {
        syncFile: async () => {
          if (rejectSync && failurePoint === "file") {
            const error = new Error("simulated file flush failure");
            error.code = "EIO";
            throw error;
          }
        },
        syncDirectory: async () => {
          if (rejectSync && failurePoint === "directory") {
            const error = new Error("simulated directory flush failure");
            error.code = "EIO";
            throw error;
          }
        },
      });
      try {
        await store.initialize();
        installPendingSafetyDeadLetter(store.state);
        await store.save(store.state);

        store.state.lastSequence = 5;
        store.state.pendingCommandDeadLetters = [];
        store.state.commandFailures["sequence:5"].status = "dead-lettered";
        rejectSync = true;
        await assert.rejects(store.save(store.state), /simulated .* flush failure/);

        assert.equal(store.snapshot().lastSequence, 4);
        assert.equal(store.snapshot().pendingCommandDeadLetters.length, 1);
        assert.equal(store.snapshot().commandFailureSafetyLock.status, "active");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("node state restores exact LKG when the primary is missing after quarantine", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-missing-primary-"));
  const pathname = path.join(directory, "node-state.json");
  try {
    const first = new NodeStateStore(pathname);
    await first.initialize();
    first.state.lastSequence = 1;
    await first.save(first.state);
    first.state.lastSequence = 2;
    await first.save(first.state);
    await rm(pathname);

    const recovered = new NodeStateStore(pathname);
    const snapshot = await recovered.initialize();
    assert.equal(snapshot.lastSequence, 1);
    assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
    assert.equal(JSON.parse(await readFile(pathname, "utf8")).lastSequence, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node state restores LKG rather than repairing malformed cursor or sticky-black evidence", async (t) => {
  const corruptions = [
    {
      name: "lastSequence type",
      apply(state) { state.lastSequence = "4"; },
    },
    {
      name: "active lock identity",
      apply(state) { state.commandFailureSafetyLock.command.id = "forged-command"; },
    },
    {
      name: "active lock black evidence",
      apply(state) { state.commandFailureSafetyLock.blackApplied = "yes"; },
    },
    {
      name: "pending dead-letter binding",
      apply(state) { state.pendingCommandDeadLetters[0].deadLetterId = "forged-dead-letter"; },
    },
    {
      name: "deleted safety lock",
      apply(state) { state.commandFailureSafetyLock = null; },
    },
  ];

  for (const scenario of corruptions) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-critical-corruption-"));
      const pathname = path.join(directory, "node-state.json");
      try {
        const first = new NodeStateStore(pathname);
        await first.initialize();
        installPendingSafetyDeadLetter(first.state);
        await first.save(first.state);

        const damaged = JSON.parse(await readFile(pathname, "utf8"));
        scenario.apply(damaged);
        await writeFile(pathname, `${JSON.stringify(damaged)}\n`, "utf8");

        const recovered = new NodeStateStore(pathname);
        const snapshot = await recovered.initialize();
        assert.equal(snapshot.lastSequence, 0);
        assert.equal(snapshot.commandFailureSafetyLock, null);
        assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
        assert.deepEqual(snapshot.pendingCommandDeadLetters, []);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("node state rejects repaired projects and forged transport snapshots into fail-closed LKG recovery", async (t) => {
  const canonicalTransport = {
    state: "playing",
    startNs: "1724544000000000000",
    baseFrame: "120",
    pausedFrame: "120",
    frameRateNum: 60,
    frameRateDen: 1,
  };
  for (const scenario of [
    {
      name: "forgiving empty project",
      apply(state) { state.project = {}; },
    },
    {
      name: "playing transport without an authoritative start",
      apply(state) { state.transport.startNs = null; },
    },
    {
      name: "transport with an unsupported extra field",
      apply(state) { state.transport.currentFrame = "999"; },
    },
    {
      name: "active transport rate differs from its project",
      apply(state) { state.transport.frameRateNum = 50; },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-project-transport-"));
      const pathname = path.join(directory, "node-state.json");
      try {
        const first = new NodeStateStore(pathname);
        await first.initialize();
        const canonicalProject = normalizeProject(defaultProject());
        first.state.project = canonicalProject;
        first.state.transport = canonicalTransport;
        await first.save(first.state);
        first.state.lastSequence = 1;
        await first.save(first.state);

        const damaged = JSON.parse(await readFile(pathname, "utf8"));
        scenario.apply(damaged);
        await writeFile(pathname, `${JSON.stringify(damaged)}\n`, "utf8");

        const recovered = new NodeStateStore(pathname);
        const snapshot = await recovered.initialize();
        assert.equal(snapshot.lastSequence, 0);
        assert.deepEqual(snapshot.project, canonicalProject);
        assert.deepEqual(snapshot.transport, canonicalTransport);
        assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("node state accepts only cursor-bound canonical pending transport actions", async (t) => {
  const validAction = {
    protocolVersion: 1,
    id: "scheduled-pause-5",
    sequence: 5,
    type: "pause-at",
    createdAtNs: "1724544000000000000",
    effectiveAtNs: "1724544001000000000",
    payload: { frame: "240" },
  };
  for (const scenario of [
    {
      name: "unsupported action type",
      apply(state) { state.pendingActions[0].type = "play-at"; },
    },
    {
      name: "action ahead of durable cursor",
      apply(state) { state.pendingActions[0].sequence = 6; },
    },
    {
      name: "noncanonical frame payload",
      apply(state) { state.pendingActions[0].payload.frame = 240; },
    },
    {
      name: "extra resume injection",
      apply(state) { state.pendingActions[0].payload.resume = true; },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-pending-action-"));
      const pathname = path.join(directory, "node-state.json");
      try {
        const first = new NodeStateStore(pathname);
        await first.initialize();
        first.state.lastSequence = 5;
        first.state.pendingActions = [validAction];
        await first.save(first.state);
        await first.save(first.state);

        const validRestart = new NodeStateStore(pathname);
        const validSnapshot = await validRestart.initialize();
        assert.deepEqual(validSnapshot.pendingActions, [validAction]);
        assert.equal(validSnapshot.stateRecoverySafetyLock, null);

        const damaged = JSON.parse(await readFile(pathname, "utf8"));
        scenario.apply(damaged);
        await writeFile(pathname, `${JSON.stringify(damaged)}\n`, "utf8");

        const recovered = new NodeStateStore(pathname);
        const snapshot = await recovered.initialize();
        assert.deepEqual(snapshot.pendingActions, [validAction]);
        assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("synthetic Server-reconcile pause survives an exact Node-state restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-reconcile-pause-"));
  const pathname = path.join(directory, "node-state.json");
  try {
    const store = new NodeStateStore(pathname);
    await store.initialize();
    const action = createCommand(
      COMMAND.PAUSE_AT,
      { frame: "240" },
      {
        id: "server-reconcile-pause",
        sequence: 0,
        createdAtNs: null,
        effectiveAtNs: "1724544001000000000",
      },
    );
    store.state.pendingActions = [action];
    await store.save(store.state);
    await store.save(store.state);

    const restarted = new NodeStateStore(pathname);
    const snapshot = await restarted.initialize();
    assert.deepEqual(snapshot.pendingActions, [action]);
    assert.equal(snapshot.stateRecoverySafetyLock, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("damaged in-flight host-action intent restores LKG and engages recovery black", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-host-started-"));
  const pathname = path.join(directory, "node-state.json");
  try {
    const store = new NodeStateStore(pathname);
    await store.initialize();
    const commandId = "cmd-reboot-once";
    const sequence = 1;
    const actionId = "action-reboot-once";
    const resultId = hostResultId(commandId, sequence, actionId);
    const started = {
      commandId,
      sequence,
      actionId,
      actionType: "REBOOT_HOST",
      resultId,
      status: "started",
      startedAt: "2026-08-25T10:00:00.000Z",
    };
    store.state.hostActionJournal = [started];
    await store.save(store.state);
    await store.save(store.state);

    const damaged = JSON.parse(await readFile(pathname, "utf8"));
    damaged.hostActionJournal = [];
    await writeFile(pathname, `${JSON.stringify(damaged)}\n`, "utf8");

    const recovered = new NodeStateStore(pathname);
    const snapshot = await recovered.initialize();
    assert.deepEqual(snapshot.hostActionJournal, [started],
      "the durable started marker must survive instead of allowing a repeated reboot");
    assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forged completed host-action evidence restores exact LKG result binding", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pb-node-state-host-completed-"));
  const pathname = path.join(directory, "node-state.json");
  try {
    const store = new NodeStateStore(pathname);
    await store.initialize();
    const commandId = "cmd-shutdown-once";
    const sequence = 1;
    const actionId = "action-shutdown-once";
    const resultId = hostResultId(commandId, sequence, actionId);
    const result = {
      resultId,
      commandId,
      sequence,
      actionId,
      actionType: "SHUTDOWN_HOST",
      status: "failed",
      startedAt: "2026-08-25T10:00:00.000Z",
      completedAt: "2026-08-25T10:00:01.000Z",
      error: {
        code: "HOST_ACTION_INTERRUPTED",
        message: "A prior execution was interrupted",
        details: null,
      },
    };
    const journal = {
      commandId,
      sequence,
      actionId,
      actionType: "SHUTDOWN_HOST",
      resultId,
      status: "completed",
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      result,
    };
    store.state.lastSequence = sequence;
    store.state.actionResults = [result];
    store.state.hostActionJournal = [journal];
    await store.save(store.state);
    await store.save(store.state);

    const validRestart = new NodeStateStore(pathname);
    const valid = await validRestart.initialize();
    assert.deepEqual(valid.actionResults, [result]);
    assert.deepEqual(valid.hostActionJournal, [journal]);
    assert.equal(valid.stateRecoverySafetyLock, null);

    const damaged = JSON.parse(await readFile(pathname, "utf8"));
    damaged.hostActionJournal[0].result.commandId = "forged-command";
    await writeFile(pathname, `${JSON.stringify(damaged)}\n`, "utf8");

    const recovered = new NodeStateStore(pathname);
    const snapshot = await recovered.initialize();
    assert.deepEqual(snapshot.actionResults, [result]);
    assert.deepEqual(snapshot.hostActionJournal, [journal]);
    assert.equal(snapshot.stateRecoverySafetyLock.status, "active");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
