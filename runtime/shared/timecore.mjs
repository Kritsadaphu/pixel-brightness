const NS_PER_MS = 1_000_000n;
const NS_PER_SECOND = 1_000_000_000n;
const epochAnchorNs = BigInt(Date.now()) * NS_PER_MS - process.hrtime.bigint();

export function epochNowNs() {
  return epochAnchorNs + process.hrtime.bigint();
}

export function nsFromMs(value) {
  return BigInt(Math.round(Number(value) * 1_000_000));
}

export function msFromNs(value) {
  return Number(BigInt(value)) / 1_000_000;
}

export function frameAtTime(nowNs, startNs, frameRateNum, frameRateDen = 1) {
  const elapsed = BigInt(nowNs) - BigInt(startNs);
  if (elapsed <= 0n) return 0n;
  return elapsed * BigInt(frameRateNum) / (NS_PER_SECOND * BigInt(frameRateDen));
}

export function timeForFrame(frame, startNs, frameRateNum, frameRateDen = 1) {
  return BigInt(startNs) + BigInt(frame) * NS_PER_SECOND * BigInt(frameRateDen) / BigInt(frameRateNum);
}

export function framesToNs(frames, frameRateNum, frameRateDen = 1) {
  return BigInt(frames) * NS_PER_SECOND * BigInt(frameRateDen) / BigInt(frameRateNum);
}

export class ClockEstimator {
  #samples = [];
  #offsetNs = 0n;
  #maxSamples;

  constructor(maxSamples = 24) {
    this.#maxSamples = maxSamples;
  }

  addSample({ localSendNs, localReceiveNs, serverNs }) {
    const send = BigInt(localSendNs);
    const receive = BigInt(localReceiveNs);
    const remote = BigInt(serverNs);
    const rttNs = receive - send;
    const midpoint = send + rttNs / 2n;
    const offsetNs = remote - midpoint;
    this.#samples.push({ rttNs, offsetNs, atNs: receive });
    this.#samples.sort((a, b) => a.rttNs < b.rttNs ? -1 : a.rttNs > b.rttNs ? 1 : 0);
    this.#samples = this.#samples.slice(0, this.#maxSamples);

    const best = this.#samples.slice(0, Math.min(5, this.#samples.length));
    const total = best.reduce((sum, sample) => sum + sample.offsetNs, 0n);
    this.#offsetNs = total / BigInt(best.length);
    return this.snapshot();
  }

  serverNowNs() {
    return epochNowNs() + this.#offsetNs;
  }

  snapshot() {
    const best = this.#samples[0];
    return {
      offsetNs: this.#offsetNs,
      bestRttNs: best?.rttNs ?? null,
      samples: this.#samples.length,
    };
  }
}

/**
 * Monotonic server-time clock that slews later synchronization corrections.
 * Stepping is appropriate before playback; while a show is running, slew keeps
 * currentFrame from jumping backward or skipping because one network sample
 * changed the estimated offset.
 */
export class SlewedClock {
  #source;
  #maxSlewPpm;
  #targetOffsetNs = 0n;
  #appliedOffsetNs = 0n;
  #lastSourceNs;
  #lastOutputNs = null;

  constructor({ source = epochNowNs, maxSlewPpm = 500 } = {}) {
    this.#source = source;
    this.#maxSlewPpm = Math.max(1, Math.min(100_000, Math.round(Number(maxSlewPpm) || 500)));
    this.#lastSourceNs = BigInt(this.#source());
  }

  setTargetOffset(offsetNs, { step = false } = {}) {
    this.#targetOffsetNs = BigInt(offsetNs);
    if (step || this.#lastOutputNs === null) this.#appliedOffsetNs = this.#targetOffsetNs;
    return this.snapshot();
  }

  nowNs() {
    const sourceNow = BigInt(this.#source());
    const elapsedNs = sourceNow > this.#lastSourceNs ? sourceNow - this.#lastSourceNs : 0n;
    this.#lastSourceNs = sourceNow;
    const difference = this.#targetOffsetNs - this.#appliedOffsetNs;
    const maximumAdjustment = elapsedNs * BigInt(this.#maxSlewPpm) / 1_000_000n;
    const adjustment = difference > maximumAdjustment
      ? maximumAdjustment
      : difference < -maximumAdjustment
        ? -maximumAdjustment
        : difference;
    this.#appliedOffsetNs += adjustment;

    let output = sourceNow + this.#appliedOffsetNs;
    if (this.#lastOutputNs !== null && output <= this.#lastOutputNs) output = this.#lastOutputNs + 1n;
    this.#lastOutputNs = output;
    return output;
  }

  snapshot() {
    return {
      targetOffsetNs: this.#targetOffsetNs,
      appliedOffsetNs: this.#appliedOffsetNs,
      remainingCorrectionNs: this.#targetOffsetNs - this.#appliedOffsetNs,
      maxSlewPpm: this.#maxSlewPpm,
    };
  }
}

export class FrameScheduler {
  constructor({ frameRateNum = 60, frameRateDen = 1, clock = epochNowNs } = {}) {
    this.frameRateNum = frameRateNum;
    this.frameRateDen = frameRateDen;
    this.clock = clock;
    this.state = "idle";
    this.startNs = null;
    this.baseFrame = 0n;
    this.pausedFrame = 0n;
  }

  prepare({ frameRateNum = this.frameRateNum, frameRateDen = this.frameRateDen } = {}) {
    this.frameRateNum = frameRateNum;
    this.frameRateDen = frameRateDen;
    this.state = "ready";
    return this.snapshot();
  }

  playAt(startNs, baseFrame = this.pausedFrame) {
    this.startNs = BigInt(startNs);
    this.baseFrame = BigInt(baseFrame);
    this.state = "scheduled";
    return this.snapshot();
  }

  pause(frame = this.currentFrame()) {
    this.pausedFrame = BigInt(frame);
    this.state = "paused";
    return this.snapshot();
  }

  seek(frame) {
    this.pausedFrame = BigInt(frame);
    if (this.state === "playing" || this.state === "scheduled") {
      this.baseFrame = this.pausedFrame;
      this.startNs = this.clock();
    }
    return this.snapshot();
  }

  currentFrame(nowNs = this.clock()) {
    if (!this.startNs || (this.state !== "playing" && this.state !== "scheduled")) return this.pausedFrame;
    const now = BigInt(nowNs);
    if (now < this.startNs) return this.baseFrame;
    this.state = "playing";
    return this.baseFrame + frameAtTime(now, this.startNs, this.frameRateNum, this.frameRateDen);
  }

  snapshot() {
    return {
      state: this.state,
      startNs: this.startNs,
      baseFrame: this.baseFrame,
      currentFrame: this.currentFrame(),
      frameRateNum: this.frameRateNum,
      frameRateDen: this.frameRateDen,
    };
  }
}
