"""Camera sources for calibration.

UvcCamera: any camera Windows sees as a webcam. The Canon EOS R50 works this way without
Canon's SDK: on the camera set  Set-up > Choose USB connection app > Video calls/streaming.
Exposure, ISO, white balance and focus cannot be locked over USB, so set them on the camera
(Movie manual exposure, fixed ISO, fixed WB, MF) before calibrating.

SimCamera: a pretend camera that looks at the player's own outputs through made-up projector
positions, lens fall-off and brightness differences. Used to test calibration without hardware.
"""
from __future__ import annotations

import collections
import logging
import math
import os
import threading
import time

log = logging.getLogger("domeplayer.camera")


class UvcCamera:
    def __init__(self, index: int, width: int = 1920, height: int = 1080, fourcc: str = ""):
        import cv2

        self.index = index
        cap = None
        backends = [cv2.CAP_MSMF, cv2.CAP_DSHOW] if os.name == "nt" else [cv2.CAP_ANY]
        for be in backends:
            c = cv2.VideoCapture(index, be)
            if c.isOpened():
                cap = c
                break
            c.release()
        if cap is None:
            raise RuntimeError(f"camera {index} could not be opened")
        if len(fourcc) == 4:             # config calibration.camera_fourcc, e.g. "MJPG"
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fourcc))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        try:
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        except Exception:
            pass
        self.cap = cap
        self.size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        self._frames: collections.deque = collections.deque(maxlen=6)
        self._lock = threading.Lock()
        self._stop = False
        self.fails = 0
        self._opened = time.perf_counter()
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()
        log.info("camera %d opened, %dx%d", index, *self.size)

    def _run(self):
        while not self._stop:
            ok, frame = self.cap.read()
            now = time.perf_counter()
            if ok and frame is not None:
                with self._lock:
                    self._frames.append((now, frame))
                self.fails = 0
            else:
                self.fails += 1
                time.sleep(0.05)

    @property
    def alive(self) -> bool:
        return self.fails < 40

    def stale(self) -> bool:
        """No picture for 2 s: the camera was turned off, unplugged or went to sleep."""
        with self._lock:
            last = self._frames[-1][0] if self._frames else self._opened
        return time.perf_counter() - last > 2.0

    @property
    def fps(self) -> float:
        """Pictures per second the camera really delivers (from the last few pictures)."""
        with self._lock:
            ts = [t for t, _ in self._frames]
        return (len(ts) - 1) / (ts[-1] - ts[0]) if len(ts) > 1 and ts[-1] > ts[0] else 0.0

    def latest(self):
        with self._lock:
            return self._frames[-1][1] if self._frames else None

    def wait_frames(self, t_ready: float, n: int):
        """n frames captured after t_ready, or None if not there yet."""
        with self._lock:
            got = [f for ts, f in self._frames if ts >= t_ready]
        return got[:n] if len(got) >= n else None

    def frames_since(self, since: float):
        """[(arrival time, frame)] that arrived after 'since'."""
        with self._lock:
            return [(ts, f) for ts, f in self._frames if ts > since]

    def close(self):
        self._stop = True
        self._thread.join(timeout=2)
        self.cap.release()


class SimCamera:
    """Looks at the player's outputs as if 'nums' projectors were stacked on a curved surface."""

    def __init__(self, nums: list[int], size=(960, 540), seed: int = 7, layout: str = "stack",
                 delay_s: float = 0.0):
        import numpy as np

        self.np = np
        self.delay_s = delay_s          # pretend USB delay (pictures arrive this late)
        self._hist = collections.deque(maxlen=400)
        self.index = -1
        self.size = size
        self.alive = True
        rng = np.random.default_rng(seed)
        w, h = size
        self.truth = {}
        self.layout = layout
        # dome layout: camera looks straight up, dome edge = this circle (lens without distortion)
        self.dome_circle = (w * 0.5, h * 0.5, h * 0.45)
        for i, n in enumerate(nums):
            if layout == "dome":
                # projector on the rim at angle phi, shining across the dome (keystoned footprint)
                C0, C1, R = self.dome_circle
                phi = math.radians(i * 360.0 / len(nums) + rng.uniform(-6, 6))
                er = (-math.cos(phi), -math.sin(phi))        # toward the far side
                et = (-er[1], er[0])
                c = (C0 + 0.45 * R * er[0], C1 + 0.45 * R * er[1])
                L, far, near = 0.75 * R, 0.8 * R, 0.6 * R
                pt = lambda a, b: [c[0] + a * er[0] + b * et[0], c[1] + a * er[1] + b * et[1]]  # noqa: E731
                quad = [pt(L, -far), pt(L, far), pt(-L, near), pt(-L, -near)]
                quad = [[x + rng.uniform(-0.01, 0.01) * w, y + rng.uniform(-0.01, 0.01) * h] for x, y in quad]
                self.truth[n] = {"quad": quad, "bulge": rng.uniform(-0.08, 0.08, size=2),
                                 "bright": rng.uniform(0.65, 1.0), "vignette": rng.uniform(0.25, 0.45),
                                 "hot": rng.uniform(-0.15, 0.15, size=2)}
                continue
            # projector footprint in the camera: a jittered quad + a bulge (curved screen)
            cx, cy = w * 0.5 + rng.uniform(-0.03, 0.03) * w, h * 0.5 + rng.uniform(-0.03, 0.03) * h
            hw, hh = w * 0.36 * rng.uniform(0.95, 1.05), h * 0.40 * rng.uniform(0.95, 1.05)
            quad = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]]
            quad = [[x + rng.uniform(-0.04, 0.04) * w, y + rng.uniform(-0.04, 0.04) * h] for x, y in quad]
            self.truth[n] = {
                "quad": quad,
                "bulge": rng.uniform(-0.12, 0.12, size=2),
                "bright": rng.uniform(0.65, 1.0),
                "vignette": rng.uniform(0.25, 0.45),
                "hot": rng.uniform(-0.15, 0.15, size=2),
            }
        tints = np.random.default_rng(seed + 77)
        for t in self.truth.values():        # every lamp has its own tint (r g b)
            t["tint"] = tints.uniform(0.86, 1.0, size=3).astype(np.float32)
        self._maps: dict = {}
        self.source = None      # set by the player: () -> (timestamp, {num: RGB uint8 image})

    # projector-normalised (u, v) -> camera pixels
    def forward(self, n, u, v):
        from ..warp import square_to_quad
        t = self.truth[n]
        du, dv = u - 0.5, v - 0.5
        r2 = du * du + dv * dv
        u2 = u + t["bulge"][0] * du * r2 * 4
        v2 = v + t["bulge"][1] * dv * r2 * 4
        m = square_to_quad(t["quad"])
        x = m[0][0] * u2 + m[0][1] * v2 + m[0][2]
        y = m[1][0] * u2 + m[1][1] * v2 + m[1][2]
        z = m[2][0] * u2 + m[2][1] * v2 + m[2][2]
        return x / z, y / z

    def _inverse_map(self, n):
        """camera pixel -> projector-normalised (u, v), by inverting forward() numerically."""
        np = self.np
        if n in self._maps:
            return self._maps[n]
        from ..warp import invert3, square_to_quad
        w, h = self.size
        xs, ys = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
        mi = invert3(square_to_quad(self.truth[n]["quad"]))
        z = mi[2][0] * xs + mi[2][1] * ys + mi[2][2]
        u2 = (mi[0][0] * xs + mi[0][1] * ys + mi[0][2]) / z
        v2 = (mi[1][0] * xs + mi[1][1] * ys + mi[1][2]) / z
        b = self.truth[n]["bulge"]
        u, v = u2.copy(), v2.copy()
        for _ in range(8):
            du, dv = u - 0.5, v - 0.5
            r2 = du * du + dv * dv
            u = u2 - b[0] * du * r2 * 4
            v = v2 - b[1] * dv * r2 * 4
        self._maps[n] = (u.astype(np.float32), v.astype(np.float32))
        return self._maps[n]

    def capture(self, images: dict):
        import cv2
        np = self.np
        w, h = self.size
        acc = np.zeros((h, w, 3), np.float32)
        for n, img in images.items():
            if n not in self.truth:
                continue
            t = self.truth[n]
            ph, pw = img.shape[:2]
            lin = (img.astype(np.float32) / 255.0) ** 2.2
            yy, xx = np.mgrid[0:ph, 0:pw].astype(np.float32)
            du = xx / pw - 0.5 - t["hot"][0]
            dv = yy / ph - 0.5 - t["hot"][1]
            vig = (1.0 - t["vignette"] * (du * du + dv * dv) * 2.2) * t["bright"]
            lin = (lin * vig[..., None] + 0.004 * t["bright"]) * t["tint"]   # light + black level, lamp tint
            u, v = self._inverse_map(n)
            acc += cv2.remap(lin, u * pw - 0.5, v * ph - 0.5, cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        acc = acc * 0.14 + 0.002                                        # exposure + room light
        acc += np.random.default_rng().normal(0, 0.0015, acc.shape).astype(np.float32)
        out = np.clip(acc, 0, 1) ** (1 / 2.2) * 255
        return out[..., ::-1].astype(np.uint8)                          # BGR like OpenCV

    def _seen(self):
        """What the camera delivers now: the outputs as they were delay_s ago."""
        if self.source is None:
            return None
        ts, images = self.source()
        if ts is None or not images:
            return None
        if not self._hist or self._hist[-1][0] != ts:
            self._hist.append((ts, images))
        cut = time.perf_counter() - self.delay_s
        old = [im for t, im in self._hist if t <= cut]
        return old[-1] if old else None

    def latest(self):
        images = self._seen()
        return self.capture(images) if images else None

    def wait_frames(self, t_ready: float, n: int):
        images = self._seen()          # always look, so the delay history keeps filling
        if time.perf_counter() < t_ready or not images:
            return None
        return [self.capture(images) for _ in range(n)]

    def frames_since(self, since: float):
        now = time.perf_counter()
        images = self._seen()
        if now - since < 1 / 30:
            return []
        return [(now, self.capture(images))] if images else []

    def close(self):
        pass


class StillCamera:
    """One saved picture instead of a live camera: the dome as the recorded video saw it, so
    the dome circle can be set on it."""

    def __init__(self, path):
        import cv2
        import numpy as np
        img = cv2.imdecode(np.fromfile(str(path), np.uint8), cv2.IMREAD_COLOR)   # any folder name
        if img is None:
            raise RuntimeError(f"could not read {path}")
        self.frame = img
        self.index = -2
        self.size = (img.shape[1], img.shape[0])
        self.alive = True
        self.fps = 0.0
        self.source = "still"

    def latest(self):
        return self.frame

    def stale(self) -> bool:
        return False

    def close(self):
        pass


def open_camera(cfg_cal: dict, nums: list[int]):
    if cfg_cal.get("simulate"):
        return SimCamera(nums, layout="dome" if cfg_cal.get("mode") == "dome" else "stack",
                         delay_s=float(cfg_cal.get("simulate_delay_ms", 0)) / 1000.0)
    return UvcCamera(int(cfg_cal["camera"]), int(cfg_cal["camera_width"]), int(cfg_cal["camera_height"]),
                     str(cfg_cal.get("camera_fourcc") or ""))
