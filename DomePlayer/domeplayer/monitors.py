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


def adapters() -> dict[int, tuple[str, str]]:
    """Windows: display number -> (graphics card name, id of that card). Two cards of the same
    model have different ids, so this tells which projector hangs on which card."""
    import ctypes
    from ctypes import wintypes

    class DISPLAY_DEVICEW(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("DeviceName", wintypes.WCHAR * 32),
                    ("DeviceString", wintypes.WCHAR * 128), ("StateFlags", wintypes.DWORD),
                    ("DeviceID", wintypes.WCHAR * 128), ("DeviceKey", wintypes.WCHAR * 128)]

    out: dict[int, tuple[str, str]] = {}
    user32 = ctypes.windll.user32
    i = 0
    while i < 64:
        dd = DISPLAY_DEVICEW()
        dd.cb = ctypes.sizeof(dd)
        if not user32.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
            break
        i += 1
        num = re.search(r"DISPLAY(\d+)", dd.DeviceName)
        if not num or not dd.StateFlags & 1:          # 1 = attached to the desktop
            continue
        card = re.search(r"\{[0-9A-Fa-f-]+\}", dd.DeviceKey)
        out[int(num.group(1))] = (dd.DeviceString, card.group(0).lower() if card else dd.DeviceString)
    return out


def ports() -> dict[int, str]:
    """Windows: display number -> name of the graphics-card socket that display hangs on.
    Windows hands out new display numbers when a projector is switched on late or a cable is
    re-plugged; the socket name stays, so a saved calibration can find its projector again.
    Empty when it cannot be read (then numbers are used as before)."""
    import ctypes
    import os
    from ctypes import wintypes
    if os.name != "nt":
        return {}

    class DISPLAY_DEVICEW(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("DeviceName", wintypes.WCHAR * 32),
                    ("DeviceString", wintypes.WCHAR * 128), ("StateFlags", wintypes.DWORD),
                    ("DeviceID", wintypes.WCHAR * 128), ("DeviceKey", wintypes.WCHAR * 128)]

    out: dict[int, str] = {}
    try:
        user32 = ctypes.windll.user32
        i = 0
        while i < 64:
            dd = DISPLAY_DEVICEW()
            dd.cb = ctypes.sizeof(dd)
            if not user32.EnumDisplayDevicesW(None, i, ctypes.byref(dd), 0):
                break
            i += 1
            num = re.search(r"DISPLAY(\d+)", dd.DeviceName)
            if not num or not dd.StateFlags & 1:          # 1 = attached to the desktop
                continue
            mon = DISPLAY_DEVICEW()
            mon.cb = ctypes.sizeof(mon)
            # 1 = EDD_GET_DEVICE_INTERFACE_NAME: \?\DISPLAY#<model>#<card socket>&UID<n>#{...}
            if not user32.EnumDisplayDevicesW(dd.DeviceName, 0, ctypes.byref(mon), 1):
                continue
            parts = mon.DeviceID.split("#")
            if len(parts) >= 3 and "UID" in parts[2].upper():
                out[int(num.group(1))] = parts[2].lower()
    except Exception:  # noqa: BLE001 - only a help, never a reason to fail
        return {}
    if len(set(out.values())) != len(out):       # not unique: useless as a key
        return {}
    return out


def unused_today(cfg: dict) -> set[int]:
    """The displays ticked as "not used", as numbered today. They were remembered with their card
    socket; when Windows renumbers the displays the tick follows the socket, not the number."""
    st = cfg["stack"]
    saved = st.get("unused_ports") or {}
    now = ports() if saved else {}
    by_port = {v: k for k, v in now.items()}
    out: set[int] = set()
    for n in st.get("unused") or []:
        port = str(saved.get(str(n), "")).lower()
        if port and by_port:
            if port in by_port:
                out.add(by_port[port])      # (socket empty today: nothing to leave out)
        else:
            out.add(int(n))
    return out


def wanted(cfg: dict, mons: list[MonitorInfo]) -> list[int]:
    nums = _wanted(cfg, mons)
    if cfg["stack"]["enabled"]:
        skip = unused_today(cfg)
        left = [n for n in nums if n not in skip]
        if left:
            return left
    return nums


def _wanted(cfg: dict, mons: list[MonitorInfo]) -> list[int]:
    """The monitor numbers the show uses: one monitor, the list from the settings, or
    (stack.auto) every display except the Windows main display, left to right."""
    st = cfg["stack"]
    if not st["enabled"]:
        return [cfg["display"]["monitor"]]
    if st.get("auto"):
        nums = [m.number for m in sorted(mons, key=lambda m: (m.x, m.y)) if not m.primary]
        if nums:
            return nums
        return [m.number for m in mons if m.primary][:1] or [cfg["display"]["monitor"]]
    return list(st["monitors"])


def remap_by_port(saved: dict, now: dict[int, str]) -> dict[int, int | None]:
    """saved: {monitor number at calibration time: socket name}. now: ports() today.
    Returns {old number: number today}; None = that socket has no display now.
    Empty dict = nothing to do (no socket names, or nothing moved)."""
    if not saved or not now:
        return {}
    by_port = {v: k for k, v in now.items()}
    out: dict[int, int | None] = {}
    for old, port in saved.items():
        out[int(old)] = by_port.get(str(port).lower())
    if all(k == v for k, v in out.items()):
        return {}
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
