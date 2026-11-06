import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("native telemetry persistence is latest-only, asynchronous, and truthfully observable", async () => {
  const [
    renderer,
    telemetry,
    persistenceHeader,
    persistence,
    mailbox,
    mailboxTest,
    cmake,
    contract,
    readme,
  ] = await Promise.all([
    source("native/windows/src/RendererApp.cpp"),
    source("native/windows/src/Telemetry.cpp"),
    source("native/windows/include/pbwin/TelemetryPersistence.hpp"),
    source("native/windows/src/TelemetryPersistence.cpp"),
    source("native/windows/include/pbwin/LatestSnapshotMailbox.hpp"),
    source("native/windows/tests/LatestSnapshotMailboxTests.cpp"),
    source("native/windows/CMakeLists.txt"),
    source("native/windows/ipc/contract.md"),
    source("native/windows/README.md"),
  ]);

  const update = renderer.indexOf("void RendererApp::UpdateTelemetry()");
  const blank = renderer.indexOf("void RendererApp::BlankAll", update);
  assert.ok(update >= 0 && blank > update);
  assert.match(renderer.slice(update, blank), /telemetry_\.MaybePublish\(\)/);
  assert.doesNotMatch(renderer.slice(update, blank),
    /create_directories|CreateFileW|WriteFile|FlushFileBuffers|MoveFileExW|ofstream/,
    "render-thread telemetry update must not perform filesystem persistence");
  assert.match(telemetry, /persistence_\.TryPublish\(\*path_, snapshot_\.load\(\)\)/,
    "render path must hand an immutable snapshot to the writer");
  assert.doesNotMatch(telemetry,
    /create_directories|CreateFileW|WriteFile|FlushFileBuffers|MoveFileExW|ofstream/,
    "Telemetry facade must not hide synchronous persistence");

  assert.match(mailbox, /kCapacity = 1/);
  assert.match(mailbox, /std::try_to_lock/,
    "producer handoff must never wait behind the persistence consumer");
  assert.match(mailbox, /pending_ = std::move\(value\)/,
    "a fresh snapshot must replace the one stale pending snapshot");
  assert.match(mailboxTest, /consumer did not receive exactly the newest snapshot/);
  assert.match(mailboxTest, /shutdown did not wake the consumer/);
  assert.match(cmake, /pbwin-latest-snapshot-mailbox-contract/);

  assert.match(persistenceHeader, /kMaximumSerializedBytes = 1024ULL \* 1024/);
  assert.match(persistenceHeader, /kShutdownDrainDeadlineMs = 750/);
  assert.match(persistence, /writerThread_ = std::thread/);
  assert.match(persistence, /THREAD_MODE_BACKGROUND_BEGIN/,
    "persistence worker must not inherit the render process scheduling class unmodified");
  assert.match(persistence,
    /create_directories[\s\S]*CreateFileW[\s\S]*WriteFile[\s\S]*FlushFileBuffers[\s\S]*MoveFileExW/,
    "only the dedicated writer may create, write, flush, and publish the file");
  assert.match(persistence, /MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH/);
  assert.match(persistence, /temporaryPath \+= std::format\(L"\.tmp\./,
    "temporary file must be adjacent to the destination for one-volume replacement");
  const replace = persistence.indexOf("MoveFileExW");
  const currentBeforeReplace = persistence.lastIndexOf("if (!JobIsCurrent(job))", replace);
  assert.ok(currentBeforeReplace >= 0 && currentBeforeReplace < replace,
    "reconfigured snapshots must be fenced before atomic replacement");

  assert.match(persistence, /"lastSuccessAgeMilliseconds"/);
  assert.match(persistence, /"lastCompletedAgeMilliseconds"/);
  assert.match(persistence, /"coalescedStale"/);
  assert.match(persistence, /"producerContention"/);
  assert.match(persistence, /"writerStalled"/);
  assert.match(persistence, /"completionDetailAvailable"/);
  assert.match(persistence, /"statusCaptured"\] = "before-this-write-completed"/);
  assert.match(persistence, /persisted payload does not claim its own write/,
    "persisted status must not recursively claim the write carrying that status");

  assert.match(persistence, /mailbox_\.CloseAndDiscard\(\)/);
  assert.match(persistence, /wait_for\(lock, drainDeadline/);
  assert.match(persistence, /CancelActiveIo\(\)[\s\S]*CancelSynchronousIo/);
  assert.match(persistence, /writerThread_\.join\(\)/,
    "writer lifetime must end before its owner is destroyed");
  assert.doesNotMatch(persistence, /\.detach\(\)/);

  assert.match(contract, /telemetryPersistence/);
  assert.match(readme, /latest-only mailbox/);
  assert.match(readme, /disk-fault/);
});
