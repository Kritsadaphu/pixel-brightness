import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("native IPC responses are bounded, connection-bound, and never written by the render thread", async () => {
  const [header, source, renderer, cmake, harness, contract, readme] = await Promise.all([
    readFile(new URL("native/windows/include/pbwin/NamedPipeServer.hpp", root), "utf8"),
    readFile(new URL("native/windows/src/NamedPipeServer.cpp", root), "utf8"),
    readFile(new URL("native/windows/src/RendererApp.cpp", root), "utf8"),
    readFile(new URL("native/windows/CMakeLists.txt", root), "utf8"),
    readFile(new URL("native/windows/tests/NamedPipeTests.cpp", root), "utf8"),
    readFile(new URL("native/windows/ipc/contract.md", root), "utf8"),
    readFile(new URL("native/windows/README.md", root), "utf8"),
  ]);

  assert.match(header, /kMaximumQueuedResponseBytes\s*=\s*128ULL \* 1024 \* 1024/);
  assert.match(header, /kMaximumQueuedResponses\s*=\s*32/);
  assert.match(header, /kWriteDeadlineMs\s*=\s*2000/);
  assert.match(header, /kFirstMessageDeadlineMs\s*=\s*5000/);
  assert.match(header, /kFramingIdleDeadlineMs\s*=\s*2000/);
  assert.match(header, /kTerminalDisconnectDeadlineMs\s*=\s*500/);
  assert.match(header, /std::jthread readerThread_/);
  assert.match(header, /std::jthread writerThread_/);
  assert.match(header, /std::uint64_t connectionId/,
    "requests and responses must be bound to one connection generation");

  assert.match(source, /PIPE_ACCESS_DUPLEX \| FILE_FLAG_OVERLAPPED/);
  assert.match(source, /PIPE_REJECT_REMOTE_CLIENTS/);
  assert.match(source, /TokenUser/);
  assert.match(source, /D:P\(A;;GA;;;SY\)\(A;;GA;;;/,
    "pipe DACL must be protected and limited to LocalSystem plus the launch identity");
  assert.match(source, /ConvertStringSecurityDescriptorToSecurityDescriptorW/);
  assert.match(source, /pipeSecurity\.Attributes\(\)/,
    "CreateNamedPipeW must receive the explicit security descriptor");
  assert.doesNotMatch(source, /CreateNamedPipeW\([\s\S]{0,300}0, nullptr\)/,
    "listener must not fall back to a default DACL");
  assert.match(source, /WaitForMultipleObjects\(2, waits, FALSE, timeout\)/,
    "the first-message and partial-frame read must have an absolute wait bound");
  assert.match(source, /FIRST_MESSAGE_TIMEOUT/);
  assert.match(source, /FRAMING_TIMEOUT/);
  assert.match(source, /WriterRun[\s\S]*WriteMessage/);
  const sendResult = source.indexOf("void NamedPipeServer::SendResult");
  const writeMessage = source.indexOf("bool NamedPipeServer::WriteMessage");
  assert.ok(sendResult >= 0 && writeMessage > sendResult);
  assert.doesNotMatch(source.slice(sendResult, writeMessage), /\bWriteFile\s*\(/,
    "render-thread SendResult/SendEvent path must only enqueue");
  assert.match(source.slice(sendResult, writeMessage), /std::try_to_lock/,
    "render-thread enqueue must not wait for the writer queue mutex");
  assert.match(source, /outboundCount_ >= kMaximumQueuedResponses/);
  assert.match(source, /kMaximumQueuedResponseBytes/);
  assert.match(source, /message\.deadline/);
  assert.match(source, /message\.closeAfterWrite/);
  assert.match(source, /connection->MarkTerminalWritten\(\)/,
    "terminal write completion must wake the bounded client-close phase");
  assert.match(source, /void NamedPipeServer::AwaitTerminalClose/);
  assert.match(source, /DisconnectNamedPipe discards unread bytes/);
  assert.match(source, /terminalDisconnectDeadlineMs_\.load\(\)/);
  assert.match(source, /connection->terminalCloseQueued\.store\(true\)/,
    "a terminal response must prevent later events from overtaking connection close");
  assert.match(source, /WaitForMultipleObjects\(2, waits, FALSE, timeout\)/);
  assert.match(source, /CancelIoEx\(pipe, &overlapped\)/);
  assert.match(source, /writeStateChanged\.wait\(lock,[\s\S]{0,80}!writeActive/,
    "pipe handle close must wait until cancelled OVERLAPPED writes release stack state");
  assert.match(source, /readerThread_\.join\(\)/);
  assert.match(source, /writerThread_\.join\(\)/);
  assert.match(source, /connection->id == message\.connectionId/);
  assert.match(source.slice(sendResult, writeMessage),
    /connection && connection->id == request\.connectionId/,
    "a failed stale response must not disconnect a newer client generation");
  assert.match(renderer, /SendResult\(request,/);
  assert.doesNotMatch(renderer, /SendResult\(request\.requestId,/);

  assert.match(cmake, /pbwin-pipe-tests/);
  assert.match(cmake, /pbwin-pipe-nonreading-client/);
  assert.match(cmake, /TIMEOUT 20/);
  assert.match(cmake, /pbwin-pipe-tests PRIVATE[\s\S]{0,100}advapi32/);
  assert.match(harness, /client deliberately never reads/);
  assert.match(harness, /response enqueue blocked on a non-reading client/);
  assert.match(harness, /frame\/status cadence did not continue/);
  assert.match(harness, /TestIdleClientEvictionAndReconnect/);
  assert.match(harness, /SetClientDeadlinesForTesting\(150, 150, 500\)/);
  assert.match(harness, /after-silent-client/);
  assert.match(harness, /after-partial-client/);
  assert.match(harness, /liveness-before-result/,
    "Windows harness must prove an event ahead of a terminal result survives");
  assert.match(harness, /ReadLinesAfterDelay/);
  assert.match(harness, /2 \* 1024 \* 1024/,
    "Windows harness must drain a multi-buffer terminal result through the handoff");
  assert.match(contract, /exactly one non-empty request record per[\s\S]{0,180}connection/);
  assert.match(contract, /protected DACL[\s\S]{0,180}LocalSystem/);
  assert.match(readme, /physical Windows\/MSVC gate/);
});
