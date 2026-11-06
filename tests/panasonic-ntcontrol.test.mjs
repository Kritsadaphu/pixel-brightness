import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

import {
  PANASONIC_NTCONTROL_COMMANDS,
  PanasonicNtControlError,
  sendPanasonicCommand,
} from "../runtime/server/panasonic-ntcontrol.mjs";

async function createNtControlFixture(t, {
  greeting = "NTCONTROL 0\r",
  greetingChunks = null,
  response = "00OK\r",
  responseChunks = null,
  greetingDelayMs = 0,
  responseDelayMs = 0,
  closeAfterRequest = false,
  onRequest = null,
} = {}) {
  const connections = [];
  const sockets = new Set();

  function writeChunks(socket, chunks, delayMs, closeWhenDone = false) {
    if (chunks == null) return;
    const values = Array.isArray(chunks) ? chunks : [chunks];
    let index = 0;
    const writeNext = () => {
      if (socket.destroyed) return;
      if (index >= values.length) {
        if (closeWhenDone) socket.end();
        return;
      }
      socket.write(values[index]);
      index += 1;
      if (index < values.length) setTimeout(writeNext, 2);
      else if (closeWhenDone) setTimeout(() => socket.end(), 2);
    };
    setTimeout(writeNext, delayMs);
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    const connection = { requests: [], bytes: "" };
    connections.push(connection);
    socket.on("close", () => sockets.delete(socket));
    if (greeting != null) writeChunks(socket, greetingChunks || [greeting], greetingDelayMs);
    let pending = "";
    socket.on("data", (chunk) => {
      connection.bytes += chunk.toString("ascii");
      pending += chunk.toString("ascii");
      const terminator = pending.indexOf("\r");
      if (terminator < 0) return;
      const request = pending.slice(0, terminator + 1);
      pending = pending.slice(terminator + 1);
      connection.requests.push(request);
      const selected = typeof onRequest === "function" ? onRequest(request, connection) : response;
      if (closeAfterRequest) {
        socket.end();
        return;
      }
      if (selected != null) writeChunks(
        socket,
        responseChunks || [selected],
        responseDelayMs,
        true,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  return {
    host: "127.0.0.1",
    port: server.address().port,
    connections,
  };
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected promise to reject");
}

test("transport injection receives the host and default Panasonic command port", async () => {
  const socket = new EventEmitter();
  const writes = [];
  let connectionOptions;
  socket.destroyed = false;
  socket.setNoDelay = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (bytes, callback) => {
    writes.push(Buffer.from(bytes).toString("ascii"));
    callback?.();
    queueMicrotask(() => socket.emit("data", Buffer.from("00001\r")));
    return true;
  };
  const resultPromise = sendPanasonicCommand({
    host: "projector-a.local",
    command: "QPW",
    createConnection: (options) => {
      connectionOptions = options;
      queueMicrotask(() => {
        socket.emit("connect");
        socket.emit("data", Buffer.from("NTCONTROL 0\r"));
      });
      return socket;
    },
  });
  assert.deepEqual(await resultPromise, { command: "QPW", response: "001", protected: false });
  assert.deepEqual(connectionOptions, { host: "projector-a.local", port: 1024 });
  assert.deepEqual(writes, ["00QPW\r"]);
  assert.equal(socket.destroyed, true);
});

test("unprotected NTCONTROL tolerates fragmented greeting and response", async (t) => {
  const fixture = await createNtControlFixture(t, {
    greetingChunks: ["NTCON", "TROL 0", "\r"],
    responseChunks: ["000", "01", "\r"],
  });
  const result = await sendPanasonicCommand({
    host: fixture.host,
    port: fixture.port,
    command: "QPW",
    timeoutMs: 1_000,
  });
  assert.deepEqual(result, { command: "QPW", response: "001", protected: false });
  assert.equal(fixture.connections.length, 1);
  assert.deepEqual(fixture.connections[0].requests, ["00QPW\r"]);
});

test("protected NTCONTROL hashes username, password and projector nonce without exposing secrets", async (t) => {
  const username = "admin1";
  const password = "private-projector-password";
  const nonce = "23181e1e";
  const digest = createHash("md5").update(`${username}:${password}:${nonce}`, "utf8").digest("hex");
  const fixture = await createNtControlFixture(t, {
    greetingChunks: ["NTCONTROL 1 ", nonce.slice(0, 3), nonce.slice(3), "\r"],
    response: "00001\r",
    onRequest: (request) => request === `${digest}00QPW\r` ? "00001\r" : "ERRA\r",
  });
  const result = await sendPanasonicCommand({
    host: fixture.host,
    port: fixture.port,
    username,
    password,
    command: "QPW",
  });
  assert.deepEqual(result, { command: "QPW", response: "001", protected: true });
  assert.equal(fixture.connections[0].requests[0], `${digest}00QPW\r`);
  assert.equal(fixture.connections[0].bytes.includes(username), false);
  assert.equal(fixture.connections[0].bytes.includes(password), false);
  assert.equal(JSON.stringify(result).includes(username), false);
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("protected mode fails closed when credentials are absent or rejected", async (t) => {
  const missingFixture = await createNtControlFixture(t, { greeting: "NTCONTROL 1 abcdef12\r", response: null });
  const missing = await rejected(sendPanasonicCommand({
    host: missingFixture.host,
    port: missingFixture.port,
    command: "QPW",
  }));
  assert.ok(missing instanceof PanasonicNtControlError);
  assert.equal(missing.code, "PANASONIC_CREDENTIALS_REQUIRED");
  assert.deepEqual(missingFixture.connections[0].requests, []);

  const password = "never-return-this-password";
  const rejectedFixture = await createNtControlFixture(t, {
    greeting: "NTCONTROL 1 abcdef12\r",
    response: "ERRA\r",
  });
  const denied = await rejected(sendPanasonicCommand({
    host: rejectedFixture.host,
    port: rejectedFixture.port,
    username: "admin1",
    password,
    command: "QPW",
  }));
  assert.equal(denied.code, "PANASONIC_AUTH_FAILED");
  assert.equal(denied.deviceCode, "ERRA");
  assert.equal(JSON.stringify(denied).includes(password), false);
  assert.equal(denied.message.includes(password), false);
});

test("only documented VMZ51 commands are accepted and every call opens one connection", async (t) => {
  const queryResponses = {
    QPW: "001",
    QSH: "1",
    QIN: "HD1",
    "Q$S": "2",
    "Q$L": "123",
  };
  const fixture = await createNtControlFixture(t, {
    onRequest: (request) => {
      const command = request.slice(2, -1);
      return `00${queryResponses[command] ?? "ACK"}\r`;
    },
  });
  for (const command of PANASONIC_NTCONTROL_COMMANDS) {
    const result = await sendPanasonicCommand({
      host: fixture.host,
      port: fixture.port,
      command,
    });
    assert.deepEqual(result, {
      command,
      response: queryResponses[command] ?? "ACK",
      protected: false,
    });
  }
  assert.equal(fixture.connections.length, PANASONIC_NTCONTROL_COMMANDS.length);
  assert.ok(fixture.connections.every((connection) => connection.requests.length === 1));
  assert.deepEqual(
    fixture.connections.map((connection) => connection.requests[0]),
    PANASONIC_NTCONTROL_COMMANDS.map((command) => `00${command}\r`),
  );

  let connectionAttempts = 0;
  for (const command of [
    "OSH:2",
    "IIS:RG1",
    "IIS:HD1\rPOF",
    "QPW ",
    "qPW",
    "RAW:COMMAND",
    "",
  ]) {
    const error = await rejected(sendPanasonicCommand({
      host: "127.0.0.1",
      command,
      createConnection: () => { connectionAttempts += 1; },
    }));
    assert.equal(error.code, "PANASONIC_INVALID_ARGUMENT");
  }
  assert.equal(connectionAttempts, 0, "rejected commands must never reach the network");
});

test("projector error frames map to stable typed errors", async (t) => {
  const expected = {
    ERR1: "PANASONIC_UNDEFINED_COMMAND",
    ERR2: "PANASONIC_PARAMETER_OUT_OF_RANGE",
    ERR3: "PANASONIC_PROJECTOR_BUSY",
    ERR4: "PANASONIC_PROJECTOR_TIMEOUT",
    ERR5: "PANASONIC_INVALID_COMMAND_LENGTH",
    ERRA: "PANASONIC_AUTH_FAILED",
  };
  const errors = Object.keys(expected);
  let index = 0;
  const fixture = await createNtControlFixture(t, {
    onRequest: () => `${errors[index++]}\r`,
  });
  for (const deviceCode of errors) {
    const error = await rejected(sendPanasonicCommand({
      host: fixture.host,
      port: fixture.port,
      command: "QPW",
    }));
    assert.ok(error instanceof PanasonicNtControlError);
    assert.equal(error.code, expected[deviceCode]);
    assert.equal(error.deviceCode, deviceCode);
  }
});

test("malformed, multi-frame and oversized replies fail the strict framing contract", async (t) => {
  const malformedGreeting = await createNtControlFixture(t, { greeting: "PJLINK 0\r" });
  assert.equal((await rejected(sendPanasonicCommand({
    host: malformedGreeting.host,
    port: malformedGreeting.port,
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");

  const invalidNonce = await createNtControlFixture(t, { greeting: "NTCONTROL 1 not-hex!\r" });
  assert.equal((await rejected(sendPanasonicCommand({
    host: invalidNonce.host,
    port: invalidNonce.port,
    username: "admin1",
    password: "password",
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");

  const missingHeader = await createNtControlFixture(t, { response: "001\r" });
  assert.equal((await rejected(sendPanasonicCommand({
    host: missingHeader.host,
    port: missingHeader.port,
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");

  const multiple = await createNtControlFixture(t, { response: "00001\r00000\r" });
  assert.equal((await rejected(sendPanasonicCommand({
    host: multiple.host,
    port: multiple.port,
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");

  const lineFeed = await createNtControlFixture(t, { greeting: "NTCONTROL 0\n" });
  assert.equal((await rejected(sendPanasonicCommand({
    host: lineFeed.host,
    port: lineFeed.port,
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");

  const oversized = await createNtControlFixture(t, { response: "A".repeat(4_097) });
  assert.equal((await rejected(sendPanasonicCommand({
    host: oversized.host,
    port: oversized.port,
    command: "QPW",
  }))).code, "PANASONIC_PROTOCOL_ERROR");
});

test("greeting and response timeouts are bounded and mutation ambiguity is explicit", async (t) => {
  const silent = await createNtControlFixture(t, { greeting: null, response: null });
  const greetingTimeout = await rejected(sendPanasonicCommand({
    host: silent.host,
    port: silent.port,
    command: "QPW",
    timeoutMs: 60,
  }));
  assert.equal(greetingTimeout.code, "PANASONIC_TIMEOUT");
  assert.equal(greetingTimeout.phase, "greeting");
  assert.equal(greetingTimeout.outcomeUnknown, false);

  const noReply = await createNtControlFixture(t, { response: null });
  const responseTimeout = await rejected(sendPanasonicCommand({
    host: noReply.host,
    port: noReply.port,
    command: "PON",
    timeoutMs: 60,
  }));
  assert.equal(responseTimeout.code, "PANASONIC_TIMEOUT");
  assert.equal(responseTimeout.phase, "response");
  assert.equal(responseTimeout.outcomeUnknown, true);
  assert.equal(noReply.connections.length, 1, "a timed-out mutation must not be retried");
  assert.deepEqual(noReply.connections[0].requests, ["00PON\r"]);
});

test("peer close mid-response is reported without retrying the command", async (t) => {
  const fixture = await createNtControlFixture(t, { closeAfterRequest: true });
  const error = await rejected(sendPanasonicCommand({
    host: fixture.host,
    port: fixture.port,
    command: "OSH:1",
  }));
  assert.equal(error.code, "PANASONIC_CONNECTION_CLOSED");
  assert.equal(error.phase, "response");
  assert.equal(error.outcomeUnknown, true);
  assert.equal(fixture.connections.length, 1);
  assert.deepEqual(fixture.connections[0].requests, ["00OSH:1\r"]);
});

test("invalid connection arguments fail before a socket is created", async () => {
  let called = 0;
  const createConnection = () => { called += 1; };
  const cases = [
    { host: "", port: 1024, command: "QPW" },
    { host: "127.0.0.1\r", port: 1024, command: "QPW" },
    { host: "127.0.0.1", port: 0, command: "QPW" },
    { host: "127.0.0.1", port: 65_536, command: "QPW" },
    { host: "127.0.0.1", port: 1024, command: "QPW", timeoutMs: 0 },
  ];
  for (const options of cases) {
    const error = await rejected(sendPanasonicCommand({ ...options, createConnection }));
    assert.equal(error.code, "PANASONIC_INVALID_ARGUMENT");
  }
  assert.equal(called, 0);
});

test("malformed injected AbortSignal and socket contracts fail as typed argument or connection errors", async () => {
  let connectionAttempts = 0;
  const invalidSignal = await rejected(sendPanasonicCommand({
    host: "127.0.0.1",
    command: "QPW",
    signal: { addEventListener() {} },
    createConnection: () => { connectionAttempts += 1; },
  }));
  assert.ok(invalidSignal instanceof PanasonicNtControlError);
  assert.equal(invalidSignal.code, "PANASONIC_INVALID_ARGUMENT");
  assert.equal(connectionAttempts, 0);

  const invalidSocket = await rejected(sendPanasonicCommand({
    host: "127.0.0.1",
    command: "QPW",
    timeoutMs: 20,
    createConnection: () => ({ on() {}, write() {} }),
  }));
  assert.ok(invalidSocket instanceof PanasonicNtControlError);
  assert.equal(invalidSocket.code, "PANASONIC_CONNECTION_FAILED");
});

test("abort closes a pending connection with a stable safe error", async (t) => {
  const fixture = await createNtControlFixture(t, { greeting: null, response: null });
  const controller = new AbortController();
  const pending = sendPanasonicCommand({
    host: fixture.host,
    port: fixture.port,
    command: "QPW",
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  const error = await rejected(pending);
  assert.equal(error.code, "PANASONIC_ABORTED");
  assert.equal(error.outcomeUnknown, false);
});
