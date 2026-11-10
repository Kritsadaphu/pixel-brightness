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
    def __init__(self, index: int, width: int = 1920, height: int = 1080):
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

    def latest(self):
        with self._lock:
            return self._frames[-1][1] if self._frames else None

    def wait_frames(self, t_ready: float, n: int):
        """n frames captured after t_ready, or None if not there yet."""
        with self._lock:
            got = [f for ts, f in self._frames if ts >= t_ready]
        return got[:n] if len(got) >= n else None

    def close(self):
        self._stop = True
        self._thread.join(timeout=2)
        self.cap.release()


class SimCamera:
    """Looks at the player's outputs as if 'nums' projectors were stacked on a curved surface."""

    def __init__(self, nums: list[int], size=(960, 540), seed: int = 7):
        import numpy as np

        self.np = np
        self.index = -1
        self.size = size
        self.alive = True
        rng = np.random.default_rng(seed)
        w, h = size
        self.truth = {}
        for i, n in enumerate(nums):
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
            lin = lin * vig[..., None] + 0.004 * t["bright"]           # light + black level
            u, v = self._inverse_map(n)
            acc += cv2.remap(lin, u * pw - 0.5, v * ph - 0.5, cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        acc = acc * 0.14 + 0.002                                        # exposure + room light
        acc += np.random.default_rng().normal(0, 0.0015, acc.shape).astype(np.float32)
        out = np.clip(acc, 0, 1) ** (1 / 2.2) * 255
        return out[..., ::-1].astype(np.uint8)                          # BGR like OpenCV

    def latest(self):
        if self.source is None:
            return None
        _, images = self.source()
        return self.capture(images) if images else None

    def wait_frames(self, t_ready: float, n: int):
        if self.source is None:
            return None
        ts, images = self.source()
        if ts is None or ts < t_ready or not images:
            return None
        return [self.capture(images) for _ in range(n)]

    def close(self):
        pass


def open_camera(cfg_cal: dict, nums: list[int]):
    if cfg_cal.get("simulate"):
        return SimCamera(nums)
    return UvcCamera(int(cfg_cal["camera"]), int(cfg_cal["camera_width"]), int(cfg_cal["camera_height"]))
