import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPixelBrightnessServer } from "../runtime/server/server.mjs";
import { defaultPanasonicProjectors } from "../runtime/server/projector-control.mjs";

const token = "pixel-control-token-that-is-long-and-not-the-projector-password";

async function api(baseUrl, pathname, { body, authenticated = true, method = "GET" } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body == null ? {} : { "content-type": "application/json" }),
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { response, payload };
}

test("authenticated projector API controls only persisted Panasonic LAN endpoints", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pixel-projector-api-"));
  const password = "credential-never-returned-to-browser";
  const calls = [];
  const server = await createPixelBrightnessServer({
    dataDir,
    controlToken: token,
    projectorUsername: "dispadmin",
    projectorPassword: password,
    projectorCommandGapMs: 0,
    projectorSendCommand: async ({ host, command }) => {
      calls.push({ host, command });
      const response = { QPW: "000", QSH: "0", QIN: "HD1", "Q$S": "0", "Q$L": "0" }[command] ?? "OK";
      return { command, response, protected: true };
    },
  });
  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const denied = await api(baseUrl, "/v1/projectors", { authenticated: false });
    assert.equal(denied.response.status, 401);

    const rows = defaultPanasonicProjectors().map((projector, index) => ({
      ...projector,
      host: `10.20.0.${31 + index}`,
      enabled: true,
    }));
    const saved = await api(baseUrl, "/v1/projectors", { method: "PUT", body: { projectors: rows } });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.revision, 1);
    assert.equal(saved.payload.projectors.length, 5);
    assert.equal(saved.payload.credential.configured, true);
    assert.equal(JSON.stringify(saved.payload).includes(password), false);

    const refreshed = await api(baseUrl, "/v1/projectors/refresh", {
      method: "POST",
      body: { projectorIds: ["projector-1"] },
    });
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.payload.projectors[0].status.power, "standby");
    assert.deepEqual(calls, [{ host: "10.20.0.31", command: "QPW" }]);

    const action = await api(baseUrl, "/v1/projectors/actions", {
      method: "POST",
      body: { projectorIds: ["projector-2"], action: "input-hdmi1" },
    });
    assert.equal(action.response.status, 200);
    assert.deepEqual(calls.at(-1), { host: "10.20.0.32", command: "IIS:HD1" });

    const reboundRows = rows.map((projector, index) => index === 1
      ? { ...projector, host: "10.20.0.92" }
      : projector);
    const rebound = await api(baseUrl, "/v1/projectors", { method: "PUT", body: { projectors: reboundRows } });
    assert.equal(rebound.payload.revision, 2);
    const callsBeforeStale = calls.length;
    const stale = await api(baseUrl, "/v1/projectors/actions", {
      method: "POST",
      body: {
        projectorIds: ["projector-2"], action: "standby", expectedRevision: saved.payload.revision,
      },
    });
    assert.equal(stale.response.status, 412);
    assert.equal(stale.payload.error.code, "projector_configuration_revision_mismatch");
    assert.equal(calls.length, callsBeforeStale);

    const staleRefresh = await api(baseUrl, "/v1/projectors/refresh", {
      method: "POST",
      body: { projectorIds: ["projector-2"], expectedRevision: saved.payload.revision },
    });
    assert.equal(staleRefresh.response.status, 412);
    assert.equal(staleRefresh.payload.error.code, "projector_configuration_revision_mismatch");
    assert.equal(calls.length, callsBeforeStale);

    const injection = await api(baseUrl, "/v1/projectors/actions", {
      method: "POST",
      body: {
        projectorIds: ["projector-1"],
        action: "power-on",
        host: "203.0.113.9",
        password,
        command: "POF",
      },
    });
    assert.equal(injection.response.status, 400);
    assert.equal(injection.payload.error.code, "invalid_projector_request");

    const state = await api(baseUrl, "/v1/state?includeProject=0");
    assert.equal(state.response.status, 200);
    assert.equal(state.payload.projectorControl.projectors[1].host, "10.20.0.92");
    assert.equal(JSON.stringify(state.payload).includes(password), false);
  } finally {
    await server.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
