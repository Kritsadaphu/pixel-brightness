import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PanasonicProjectorControl,
  ProjectorControlError,
  defaultPanasonicProjectors,
} from "../runtime/server/projector-control.mjs";

function configuredRows() {
  return defaultPanasonicProjectors().map((projector, index) => ({
    ...projector,
    host: `192.168.50.${101 + index}`,
    enabled: true,
  }));
}

function responseFor(command) {
  return {
    QPW: "001",
    QSH: "0",
    QIN: "HD1",
    "Q$S": "2",
    "Q$L": "4321",
  }[command] ?? "OK";
}

test("Panasonic projector inventory persists IP bindings and never exposes credentials", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-control-"));
  const secret = "projector-password-must-not-leak";
  const calls = [];
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      username: "dispadmin",
      password: secret,
      commandGapMs: 0,
      sendCommand: async (request) => {
        calls.push({ host: request.host, command: request.command });
        return { command: request.command, response: responseFor(request.command), protected: true };
      },
    });
    await control.init();
    assert.equal(control.snapshot().projectors.length, 5);
    assert.equal(control.snapshot().credential.configured, true);
    assert.equal(JSON.stringify(control.snapshot()).includes(secret), false);

    const configured = await control.configure({ projectors: configuredRows() });
    assert.equal(configured.revision, 1);
    assert.equal(configured.projectors[0].outputId, "A");
    assert.equal(configured.projectors[0].webControlUrl, "http://192.168.50.101/");

    const status = await control.refresh({ projectorIds: ["projector-1"] });
    assert.equal(status.results[0].ok, true);
    assert.deepEqual(status.projectors[0].status, {
      online: true,
      state: "on",
      power: "on",
      shutter: "open",
      input: "hdmi1",
      light: "on",
      lightHours: 4321,
      checkedAt: status.projectors[0].status.checkedAt,
      error: null,
    });
    assert.deepEqual(calls.map((call) => call.command), ["QPW", "Q$S", "QSH", "QIN", "Q$L"]);

    const action = await control.action({
      projectorIds: ["projector-1", "projector-2"],
      action: "shutter-close",
      staggerMs: 0,
    });
    assert.equal(action.lastBatch.succeeded, 2);
    assert.equal(action.lastBatch.failed, 0);
    assert.deepEqual(calls.slice(-2).map((call) => call.command), ["OSH:1", "OSH:1"]);

    await assert.doesNotReject(
      control.configure({ projectors: configuredRows() }),
      "a completed action must release the configuration lock",
    );

    const restored = new PanasonicProjectorControl({ dataDir, sendCommand: async () => ({ response: "000" }) });
    await restored.init();
    assert.equal(restored.snapshot().revision, 2);
    await assert.rejects(
      restored.action({ projectorIds: ["projector-1"], action: "standby", expectedRevision: 1 }),
      (error) => error instanceof ProjectorControlError
        && error.code === "projector_configuration_revision_mismatch"
        && error.status === 412,
      "a server restart must retain the same projector binding authority",
    );
    assert.equal(restored.snapshot().projectors[4].host, "192.168.50.105");
    assert.equal(restored.snapshot().credential.configured, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("scheduled projector operations reject a stale pinned IP-binding revision", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-revision-"));
  const calls = [];
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ host, command }) => {
        calls.push({ host, command });
        return { command, response: responseFor(command), protected: false };
      },
    });
    await control.init();
    const original = await control.configure({ projectors: configuredRows() });
    const reboundRows = configuredRows().map((projector, index) => index === 0
      ? { ...projector, host: "192.168.50.201" }
      : projector);
    const rebound = await control.configure({ projectors: reboundRows });
    assert.equal(rebound.revision, original.revision + 1);

    for (const operation of [
      () => control.action({
        projectorIds: ["projector-1"], action: "standby", expectedRevision: original.revision,
      }),
      () => control.refresh({ projectorIds: ["projector-1"], expectedRevision: original.revision }),
    ]) {
      await assert.rejects(
        operation(),
        (error) => error instanceof ProjectorControlError
          && error.code === "projector_configuration_revision_mismatch"
          && error.status === 412,
      );
    }
    assert.deepEqual(calls, [], "a stale scheduled binding must not contact either the old or rebound endpoint");

    await control.action({
      projectorIds: ["projector-1"], action: "standby", expectedRevision: rebound.revision,
    });
    assert.deepEqual(calls, [{ host: "192.168.50.201", command: "POF" }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("projector actions are allowlisted by configured id and return partial fleet failure", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-partial-"));
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ host, command }) => {
        if (host.endsWith(".103")) {
          const error = new Error("fixture failure");
          error.code = "ECONNREFUSED";
          throw error;
        }
        return { command, response: responseFor(command), protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });

    const result = await control.action({
      projectorIds: configuredRows().map((projector) => projector.id),
      action: "power-on",
      staggerMs: 0,
    });
    assert.equal(result.results.length, 5);
    assert.equal(result.lastBatch.succeeded, 4);
    assert.equal(result.lastBatch.failed, 1);
    assert.equal(result.results[2].projectorId, "projector-3");
    assert.equal(result.results[2].ok, false);

    await assert.rejects(
      control.action({ projectorIds: ["projector-1"], action: "raw", command: "POF" }),
      (error) => error instanceof ProjectorControlError && error.code === "invalid_projector_request",
    );
    await assert.rejects(
      control.action({ projectorIds: ["missing"], action: "standby" }),
      (error) => error instanceof ProjectorControlError && error.code === "projector_not_found",
    );
    await assert.rejects(
      control.configure({ projectors: configuredRows().map((item) => ({ ...item, host: "http://192.168.50.1/" })) }),
      /literal IPv4 or IPv6/,
    );
    await assert.rejects(
      control.configure({
        projectors: configuredRows().map((item, index) => (
          index === 0 ? { ...item, enabled: "true" } : item
        )),
      }),
      /enabled must be a boolean/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("malformed projectorIds never expands into a fleet-wide refresh or action", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-selector-"));
  const calls = [];
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ command }) => {
        calls.push(command);
        return { command, response: responseFor(command), protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });

    await assert.rejects(
      control.action({ action: "standby" }),
      (error) => error instanceof ProjectorControlError && error.code === "invalid_projector_request",
    );
    await assert.rejects(
      control.action({ projectorIds: "projector-1", action: "standby" }),
      (error) => error instanceof ProjectorControlError && error.code === "invalid_projector_request",
    );
    await assert.rejects(
      control.refresh({ projectorIds: { id: "projector-1" } }),
      (error) => error instanceof ProjectorControlError && error.code === "invalid_projector_request",
    );
    await assert.rejects(
      control.refresh({ projectorIds: ["projector-1", "missing"] }),
      (error) => error instanceof ProjectorControlError && error.code === "projector_not_found",
    );
    assert.deepEqual(calls, [], "a malformed selector must not contact any configured projector");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("projector inventory is capped at the five physical output bindings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-limit-"));
  try {
    assert.equal(defaultPanasonicProjectors(32).length, 5);
    const control = new PanasonicProjectorControl({ dataDir });
    await control.init();
    const sixRows = [
      ...configuredRows(),
      {
        id: "projector-6",
        name: "Projector 6",
        outputId: "F",
        host: "192.168.50.106",
        port: 1024,
        enabled: true,
        model: "PT-VMZ51",
      },
    ];
    await assert.rejects(
      control.configure({ projectors: sixRows }),
      (error) => error instanceof ProjectorControlError
        && error.code === "invalid_projector_configuration",
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("concurrent group actions fail busy instead of interleaving", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-action-busy-"));
  const calls = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ host, command }) => {
        calls.push({ host, command });
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
        }
        return { command, response: "OK", protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });

    const first = control.action({ projectorIds: ["projector-1"], action: "power-on" });
    await firstStarted;
    await assert.rejects(
      control.action({ projectorIds: ["projector-2"], action: "standby" }),
      (error) => error instanceof ProjectorControlError
        && error.code === "projector_control_busy"
        && error.status === 409,
    );
    assert.deepEqual(calls, [{ host: "192.168.50.101", command: "PON" }]);

    releaseFirst();
    await first;
    await control.action({ projectorIds: ["projector-2"], action: "standby" });
    assert.deepEqual(calls.at(-1), { host: "192.168.50.102", command: "POF" });
  } finally {
    releaseFirst?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("rebinding a projector endpoint invalidates cached status", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-rebind-status-"));
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ command }) => ({
        command,
        response: command === "QPW" ? "000" : responseFor(command),
        protected: false,
      }),
    });
    await control.init();
    const original = configuredRows();
    await control.configure({ projectors: original });
    await control.refresh({ projectorIds: ["projector-1"] });
    assert.equal(control.snapshot().projectors[0].status.power, "standby");

    const rebound = original.map((projector, index) => index === 0
      ? { ...projector, host: "192.168.50.201" }
      : projector);
    const snapshot = await control.configure({ projectors: rebound });
    assert.equal(snapshot.projectors[0].host, "192.168.50.201");
    assert.deepEqual(snapshot.projectors[0].status, {
      online: false,
      state: "not-checked",
      checkedAt: null,
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("same-device work is serialized and configuration cannot change beneath its queue", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-current-endpoint-"));
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ host, command }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push({ host, command });
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
        }
        active -= 1;
        return { command, response: "000", protected: false };
      },
    });
    await control.init();
    const original = configuredRows();
    await control.configure({ projectors: original });

    const first = control.refresh({ projectorIds: ["projector-1"] });
    await firstStarted;
    const queued = control.refresh({ projectorIds: ["projector-1"] });
    const rebound = original.map((projector, index) => index === 0
      ? { ...projector, host: "192.168.50.201" }
      : projector);
    await assert.rejects(
      control.configure({ projectors: rebound }),
      (error) => error instanceof ProjectorControlError && error.code === "projector_control_busy",
    );
    releaseFirst();
    await Promise.all([first, queued]);

    assert.equal(maximumActive, 1, "commands for one physical projector must never overlap");
    assert.deepEqual(calls, [
      { host: "192.168.50.101", command: "QPW" },
      { host: "192.168.50.101", command: "QPW" },
    ], "one queue generation must retain one endpoint authority");

    await control.configure({ projectors: rebound });
    await control.refresh({ projectorIds: ["projector-1"] });
    assert.deepEqual(calls.at(-1), { host: "192.168.50.201", command: "QPW" });
  } finally {
    releaseFirst?.();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("startup status stays reachable and defers nonessential telemetry", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-startup-"));
  const calls = [];
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ command }) => {
        calls.push(command);
        return { command, response: command === "QPW" ? "001" : "1", protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });

    const result = await control.refresh({ projectorIds: ["projector-1"] });
    assert.equal(result.results[0].ok, true);
    assert.equal(result.projectors[0].status.online, true);
    assert.equal(result.projectors[0].status.state, "starting");
    assert.deepEqual(calls, ["QPW", "Q$S"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DIGITAL LINK sub-inputs are accepted and mutation ambiguity is retained", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-digital-link-"));
  try {
    let failMutation = false;
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 0,
      sendCommand: async ({ command }) => {
        if (failMutation && command === "OSH:1") {
          const error = new Error("fixture response lost");
          error.code = "PANASONIC_TIMEOUT";
          error.phase = "response";
          error.outcomeUnknown = true;
          throw error;
        }
        const response = {
          QPW: "001",
          "Q$S": "2",
          QSH: "0",
          QIN: "DL1:HD1",
          "Q$L": "123",
        }[command] ?? "OK";
        return { command, response, protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });
    const status = await control.refresh({ projectorIds: ["projector-1"] });
    assert.equal(status.projectors[0].status.input, "digital-link-hdmi1");

    failMutation = true;
    const action = await control.action({
      projectorIds: ["projector-1"],
      action: "shutter-close",
      staggerMs: 0,
    });
    assert.equal(action.results[0].ok, false);
    assert.equal(action.results[0].error.outcomeUnknown, true);
    assert.equal(action.projectors[0].status.online, true);
    assert.equal(action.projectors[0].status.state, "outcome-unknown");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the configured command gap is enforced across consecutive actions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-gap-"));
  const calls = [];
  try {
    const control = new PanasonicProjectorControl({
      dataDir,
      commandGapMs: 30,
      sendCommand: async ({ command }) => {
        calls.push({ command, at: performance.now() });
        return { command, response: "OK", protected: false };
      },
    });
    await control.init();
    await control.configure({ projectors: configuredRows() });
    await control.action({ projectorIds: ["projector-1"], action: "shutter-close", staggerMs: 0 });
    await control.action({ projectorIds: ["projector-1"], action: "shutter-open", staggerMs: 0 });
    assert.deepEqual(calls.map((call) => call.command), ["OSH:1", "OSH:0"]);
    assert.ok(calls[1].at - calls[0].at >= 20, "consecutive commands must respect the device gap");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
