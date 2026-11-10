"""Frame timing statistics for the on-screen display."""
from __future__ import annotations

import collections
import time


class FrameStats:
    def __init__(self, refresh_hz: float):
        self.refresh_hz = refresh_hz if refresh_hz and refresh_hz > 0 else 60.0
        self.start = time.perf_counter()
        self.swaps = collections.deque()        # timestamps of buffer swaps (last 1 s)
        self.frames = collections.deque()       # timestamps of new video frames (last 1 s)
        self.frame_gaps = collections.deque()   # (t, gap) between new video frames (last 2 s)
        self.last_swap: float | None = None
        self.last_frame: float | None = None
        self.missed_vsync_total = 0
        self.missed_recent = collections.deque()  # timestamps of missed vsyncs (last 10 s)
        self.video_frames_total = 0

    def reset(self) -> None:
        self.__init__(self.refresh_hz)

    def on_swap(self, vsync: bool) -> None:
        now = time.perf_counter()
        if self.last_swap is not None and vsync:
            period = 1.0 / self.refresh_hz
            gap = now - self.last_swap
            if gap > period * 1.5:
                missed = int(round(gap / period)) - 1
                self.missed_vsync_total += missed
                for _ in range(min(missed, 100)):
                    self.missed_recent.append(now)
        self.last_swap = now
        self.swaps.append(now)
        self._trim(now)

    def on_video_frame(self) -> None:
        now = time.perf_counter()
        if self.last_frame is not None:
            self.frame_gaps.append((now, now - self.last_frame))
        self.last_frame = now
        self.frames.append(now)
        self.video_frames_total += 1

    def _trim(self, now: float) -> None:
        while self.swaps and now - self.swaps[0] > 1.0:
            self.swaps.popleft()
        while self.frames and now - self.frames[0] > 1.0:
            self.frames.popleft()
        while self.frame_gaps and now - self.frame_gaps[0][0] > 2.0:
            self.frame_gaps.popleft()
        while self.missed_recent and now - self.missed_recent[0] > 10.0:
            self.missed_recent.popleft()

    @property
    def render_fps(self) -> float:
        return float(len(self.swaps))

    @property
    def video_fps(self) -> float:
        return float(len(self.frames))

    @property
    def max_frame_gap_ms(self) -> float:
        return max((g for _, g in self.frame_gaps), default=0.0) * 1000.0

    @property
    def missed_vsync_10s(self) -> int:
        return len(self.missed_recent)

    @property
    def uptime(self) -> float:
        return time.perf_counter() - self.start


def fmt_time(seconds) -> str:
    if seconds is None:
        return "--:--"
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
