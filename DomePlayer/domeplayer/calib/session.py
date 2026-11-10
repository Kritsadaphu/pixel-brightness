"""Capture sequence: one projector at a time shows white, then Gray-code stripes (+ inverse)
for x and y, while every other projector is black. Each camera frame is decoded as soon as
it arrives, so memory stays small.

Before that, every projector flashes white/black a few times. The camera's delay (time from
the picture being shown until the camera delivers it) is measured from these flashes, and
the wait per pattern is made long enough for it. This also checks the camera sees the dome.

Result per projector: camera-space maps of the projector pixel that lights each camera pixel
(px, py; NaN where unknown) and its full-white camera image. Plus one all-black image.
"""
from __future__ import annotations

import logging
import math
import time

log = logging.getLogger("domeplayer.calib")


class Step:
    __slots__ = ("num", "kind", "axis", "bit", "inv")

    def __init__(self, num, kind, axis=0, bit=0, inv=False):
        self.num, self.kind, self.axis, self.bit, self.inv = num, kind, axis, bit, inv

    def __repr__(self):
        return f"Step({self.num},{self.kind},{'xy'[self.axis]}{self.bit}{'~' if self.inv else ''})"


PROBE_S = 2.5          # how long each flash is held while measuring the camera delay
PROBE_FLASHES = 2      # white flashes (each followed by black)
MAX_DELAY_S = 3.0


class CalibrationSession:
    def __init__(self, nums, sizes: dict, camera, settle_s=0.4, n_avg=2, skip_bits=2,
                 measure_delay=True):
        self.nums = list(nums)
        self.sizes = dict(sizes)                 # num -> (w, h) output pixels
        self.cam = camera
        self.settle = settle_s
        self.n_avg = n_avg
        self.skip = skip_bits
        self.steps: list[Step] = []
        if measure_delay:   # all black, then white/black flashes on every projector
            self.steps.append(Step(None, "probe", inv=True))
            for _ in range(PROBE_FLASHES):
                self.steps += [Step(None, "probe", inv=False), Step(None, "probe", inv=True)]
        self.steps.append(Step(None, "black"))
        self.bits = {}
        for n in self.nums:
            w, h = self.sizes[n]
            bx, by = max(1, math.ceil(math.log2(w))), max(1, math.ceil(math.log2(h)))
            self.bits[n] = (bx, by)
            self.steps.append(Step(n, "white"))
            for axis, nb in ((0, bx), (1, by)):
                for bit in range(nb - 1, min(self.skip, nb - 1) - 1, -1):
                    self.steps.append(Step(n, "gray", axis, bit, False))
                    self.steps.append(Step(n, "gray", axis, bit, True))
        self.steps.append(Step(None, "black"))
        self.i = 0
        self.t_ready = None
        self.started = time.perf_counter()
        self.error: str | None = None
        self.done = False
        self.black = None
        self.black_end = None
        self.white = {}
        self.code = {}         # num -> [code_x, code_y] uint32 gray-code bits
        self.bad = {}          # num -> bool mask of unreliable pixels
        self._pending = None   # frame of the non-inverted stripe, waiting for its inverse
        self.t_shown = None
        self.delays: list[float] = []     # measured camera delay per flash change (s)
        self.delay_s: float | None = None
        self._probe_level = None
        self._probe_trace: list[tuple[float, float]] = []
        self._probe_last = 0.0

    # ---- what to show --------------------------------------------------------------------
    @property
    def step(self) -> Step | None:
        return self.steps[self.i] if self.i < len(self.steps) else None

    @property
    def progress(self) -> float:
        return self.i / len(self.steps)

    def eta_s(self) -> float:
        el = time.perf_counter() - self.started
        return el / max(self.progress, 1e-3) - el

    def presented(self, now: float) -> None:
        """Called after every buffer swap. The settle time counts from the first swap of a step."""
        if self.t_ready is None and not self.done:
            self.t_ready = now + self.settle
            self.t_shown = now

    # ---- capture ---------------------------------------------------------------------------
    def poll(self) -> None:
        if self.done or self.t_ready is None:
            return
        if not self.cam.alive:
            self.error = "camera stopped sending pictures (cable, battery or camera turned off?)"
            self.done = True
            return
        if self.step.kind == "probe":
            try:
                self._probe_poll(self.step)
            except Exception as e:  # noqa: BLE001
                log.warning("camera delay check: %s", e)
                self.error = str(e)
                self.done = True
            return
        frames = self.cam.wait_frames(self.t_ready, self.n_avg)
        if frames is None:
            if time.perf_counter() > self.t_ready + 8.0:
                self.error = "no picture from the camera for 8 seconds"
                self.done = True
            return
        import numpy as np
        g = np.mean([self._gray(f) for f in frames], axis=0).astype(np.float32)
        try:
            self._process(self.step, g)
        except Exception as e:  # noqa: BLE001
            log.exception("calibration step failed")
            self.error = str(e)
            self.done = True
            return
        self.i += 1
        self.t_ready = None
        if self.i >= len(self.steps):
            self.done = True

    def _probe_poll(self, st: Step) -> None:
        import numpy as np
        for ts, f in self.cam.frames_since(self._probe_last):
            self._probe_last = ts
            small = f[::8, ::8]
            self._probe_trace.append((ts, float(np.mean(self._gray(small)))))
        now = time.perf_counter()
        if now < self.t_shown + PROBE_S:
            return
        trace = [(ts, m) for ts, m in self._probe_trace if ts >= self.t_shown]
        if len(trace) < 4:
            raise RuntimeError("the camera sends almost no pictures (less than 2 per second)")
        tail = [m for ts, m in trace if ts >= self.t_shown + PROBE_S - 0.6] or [trace[-1][1]]
        level = float(np.median(tail))
        if self._probe_level is not None:
            delta = level - self._probe_level
            if not st.inv and delta < 3.0:
                raise RuntimeError("the camera does not see the projectors light up (brightness "
                                   f"{self._probe_level:.0f} -> {level:.0f}). Are the projectors on, "
                                   "is the camera pointing at the dome, is the exposure too dark?")
            if abs(delta) >= 3.0:
                half = self._probe_level + delta * 0.5
                hit = next((ts for ts, m in trace if (m - half) * np.sign(delta) >= 0), None)
                if hit is None:
                    raise RuntimeError("could not measure the camera delay")
                self.delays.append(hit - self.t_shown)
                log.info("camera delay %s: %.0f ms (level %.0f -> %.0f)", "on" if not st.inv else "off",
                         (hit - self.t_shown) * 1000, self._probe_level, level)
        elif level > 200:
            raise RuntimeError("camera picture is too bright with all projectors black - "
                               "darken the room or lower the camera exposure")
        self._probe_level = level
        self._probe_trace = []
        self.i += 1
        self.t_ready = None
        nxt = self.step
        if nxt is not None and nxt.kind != "probe" and self.delays:
            self.delay_s = max(self.delays)
            if self.delay_s > MAX_DELAY_S:
                raise RuntimeError(f"the camera is {self.delay_s:.1f} s late - too slow. "
                                   "Use the USB cable straight into the PC, lower the camera resolution")
            settle = max(self.settle, self.delay_s + 0.25)
            log.info("camera delay %.0f ms (max of %s) -> wait %.0f ms per pattern",
                     self.delay_s * 1000, [round(d * 1000) for d in self.delays], settle * 1000)
            self.settle = settle

    @staticmethod
    def _gray(frame):
        import numpy as np
        f = frame.astype(np.float32)
        if f.ndim == 3:   # BGR -> luma
            f = f[..., 0] * 0.114 + f[..., 1] * 0.587 + f[..., 2] * 0.299
        return f

    def _process(self, st: Step, g) -> None:
        import numpy as np
        if st.kind == "black":
            if self.black is None:
                self.black = g
                log.info("black frame: mean %.1f, max %.1f", g.mean(), g.max())
                if g.max() > 200:
                    raise RuntimeError("camera picture is too bright with all projectors black - "
                                       "darken the room or lower the camera exposure")
            else:
                self.black_end = g
            return
        n = st.num
        if st.kind == "white":
            diff = g - self.black
            clipped = float(np.mean(g[diff > 30] >= 250)) if np.any(diff > 30) else 0.0
            peak = float(np.percentile(diff, 99.5))
            log.info("monitor %s white: contrast p99.5 %.1f, clipped %.1f%%", n, peak, clipped * 100)
            if peak < 25:
                raise RuntimeError(f"monitor {n}: the camera barely sees it (contrast {peak:.0f}). "
                                   "Is that projector on, and in the camera's view? "
                                   "Or raise the camera exposure.")
            if clipped > 0.02:
                raise RuntimeError(f"monitor {n}: {clipped*100:.0f}% of its picture is over-exposed in the "
                                   "camera - lower the camera exposure (ISO/shutter) and try again")
            self.white[n] = g
            self.code[n] = [np.zeros(g.shape, np.uint32), np.zeros(g.shape, np.uint32)]
            self.bad[n] = diff < max(12.0, peak * 0.12)
            return
        # gray stripes
        if not st.inv:
            self._pending = g
            return
        p, q = self._pending, g
        self._pending = None
        contrast = self.white[n] - self.black
        reliable = np.abs(p - q) > np.maximum(4.0, contrast * 0.10)
        self.bad[n] |= ~reliable
        bit = (p > q).astype(np.uint32)
        self.code[n][st.axis] |= bit << np.uint32(st.bit - self.skip)

    # ---- result ------------------------------------------------------------------------------
    def result(self) -> dict:
        import numpy as np
        out = {"black": self.black, "projectors": {}}
        for n in self.nums:
            w, h = self.sizes[n]
            px = _gray_to_bin(self.code[n][0]).astype(np.float32) * (1 << self.skip) + (1 << self.skip) / 2 - 0.5
            py = _gray_to_bin(self.code[n][1]).astype(np.float32) * (1 << self.skip) + (1 << self.skip) / 2 - 0.5
            bad = self.bad[n] | (px > w - 1 + (1 << self.skip)) | (py > h - 1 + (1 << self.skip))
            px[bad] = np.nan
            py[bad] = np.nan
            out["projectors"][n] = {"px": np.clip(px, 0, w - 1), "py": np.clip(py, 0, h - 1),
                                    "white": self.white[n], "size": (w, h)}
            log.info("monitor %s: decoded %.1f%% of camera pixels", n, 100 * np.mean(~bad))
        if self.black_end is not None:
            drift = float(np.mean(np.abs(self.black_end - self.black)))
            out["black_drift"] = drift
            log.info("black drift during capture: %.2f grey levels", drift)
        return out


def _gray_to_bin(g):
    b = g.copy()
    shift = 1
    while shift < 32:
        b ^= b >> shift
        shift <<= 1
    return b
