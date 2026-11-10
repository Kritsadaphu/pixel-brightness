"""Monitor discovery. Numbers match Windows' \\\\.\\DISPLAY<n> names.

On other systems (development on Linux/macOS) the number is simply the GLFW order + 1.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import glfw


@dataclass
class MonitorInfo:
    number: int          # what display.monitor in config.json refers to
    index: int           # GLFW enumeration order
    name: str            # friendly name reported by the driver
    device: str          # e.g. \\.\DISPLAY3 on Windows
    x: int
    y: int
    width: int
    height: int
    refresh: int
    primary: bool
    handle: object

    def describe(self) -> str:
        prim = " (primary)" if self.primary else ""
        return (f"monitor {self.number}: {self.width}x{self.height} @ {self.refresh} Hz, "
                f"position {self.x},{self.y}, {self.name} {self.device}{prim}")


def list_monitors() -> list[MonitorInfo]:
    """glfw.init() must have been called."""
    primary = glfw.get_primary_monitor()
    primary_addr = _addr(primary)
    out: list[MonitorInfo] = []
    get_adapter = getattr(glfw, "get_win32_adapter", None)
    for i, m in enumerate(glfw.get_monitors() or []):
        device = ""
        number = i + 1
        if get_adapter is not None:
            try:
                device = get_adapter(m) or ""
            except Exception:
                device = ""
            match = re.search(r"DISPLAY(\d+)", device)
            if match:
                number = int(match.group(1))
        mode = glfw.get_video_mode(m)
        x, y = glfw.get_monitor_pos(m)
        name = glfw.get_monitor_name(m)
        if isinstance(name, bytes):
            name = name.decode("utf-8", "replace")
        out.append(MonitorInfo(
            number=number, index=i, name=name or "?", device=device, x=x, y=y,
            width=mode.size.width, height=mode.size.height, refresh=mode.refresh_rate,
            primary=_addr(m) == primary_addr, handle=m,
        ))
    return out


def find_monitor(number: int) -> tuple[MonitorInfo | None, list[MonitorInfo]]:
    mons = list_monitors()
    for m in mons:
        if m.number == number:
            return m, mons
    return None, mons


def _addr(ptr) -> int:
    try:
        import ctypes
        return ctypes.cast(ptr, ctypes.c_void_p).value or 0
    except Exception:
        return id(ptr)
