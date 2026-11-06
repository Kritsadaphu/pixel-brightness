import assert from "node:assert/strict";
import test from "node:test";

import {
  ClockEstimator,
  FrameScheduler,
  SlewedClock,
  frameAtTime,
  framesToNs,
  timeForFrame,
} from "../runtime/shared/timecore.mjs";

test("rational frame math stays exact at 60 Hz", () => {
  const start = 9_000_000_000n;
  assert.equal(frameAtTime(start + 1_000_000_000n, start, 60, 1), 60n);
  assert.equal(timeForFrame(3_600n, start, 60, 1), start + 60_000_000_000n);
  assert.equal(framesToNs(60n, 60, 1), 1_000_000_000n);
});

test("rational frame math supports 60000/1001 without floating point drift", () => {
  const start = 123_456_789n;
  const oneHourFrames = 216_000n;
  const frameTime = timeForFrame(oneHourFrames, start, 60_000, 1_001);
  assert.equal(frameAtTime(frameTime, start, 60_000, 1_001), oneHourFrames);
  assert.equal(frameAtTime(frameTime - 1n, start, 60_000, 1_001), oneHourFrames - 1n);
});

test("clock estimator favors the lowest round-trip samples", () => {
  const estimator = new ClockEstimator();
  estimator.addSample({ localSendNs: 0n, localReceiveNs: 20n, serverNs: 110n });
  estimator.addSample({ localSendNs: 100n, localReceiveNs: 106n, serverNs: 203n });
  estimator.addSample({ localSendNs: 200n, localReceiveNs: 204n, serverNs: 302n });
  const snapshot = estimator.snapshot();
  assert.equal(snapshot.bestRttNs, 4n);
  assert.equal(snapshot.offsetNs, 100n);
});

test("frame scheduler starts on a future epoch and seeks deterministically", () => {
  let now = 1_000_000_000n;
  const scheduler = new FrameScheduler({ frameRateNum: 60, clock: () => now });
  scheduler.prepare();
  scheduler.playAt(2_000_000_000n, 120n);
  assert.equal(scheduler.currentFrame(), 120n);

  now = 2_500_000_000n;
  assert.equal(scheduler.currentFrame(), 150n);
  scheduler.pause();
  now = 7_000_000_000n;
  assert.equal(scheduler.currentFrame(), 150n);

  scheduler.seek(42n);
  assert.equal(scheduler.currentFrame(), 42n);
});

test("slewed clock applies resync corrections without going backward", () => {
  let source = 1_000_000_000n;
  const clock = new SlewedClock({ source: () => source, maxSlewPpm: 1_000 });
  clock.setTargetOffset(5_000_000n, { step: true });
  const first = clock.nowNs();

  clock.setTargetOffset(-5_000_000n);
  source += 1_000_000_000n;
  const second = clock.nowNs();
  assert.equal(second > first, true);
  assert.equal(clock.snapshot().appliedOffsetNs, 4_000_000n);

  source += 10_000_000_000n;
  const third = clock.nowNs();
  assert.equal(third > second, true);
  assert.equal(clock.snapshot().appliedOffsetNs, -5_000_000n);
});
