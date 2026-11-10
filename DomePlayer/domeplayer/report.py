"""One zip with everything needed to find a problem: DomePlayer.exe --report

logs, config.json, calibration (results + camera pictures), list of backups, monitors and
system info. Saved on the Desktop as DomePlayer-report-<date-time>.zip (or in the
DomePlayer folder if there is no Desktop). Prints the zip path.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import time
import zipfile
from pathlib import Path

from . import __version__
from .config import APP_DIR

BIG = 80_000_000      # skip single files bigger than this (e.g. a huge capture)


def desktop() -> Path:
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
            if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buf) == 0 and buf.value:
                return Path(buf.value)
        except Exception:  # noqa: BLE001
            pass
    p = Path.home() / "Desktop"
    return p if p.is_dir() else APP_DIR


def _system_info() -> str:
    lines = [f"DomePlayer {__version__}", f"time {time.strftime('%Y-%m-%d %H:%M:%S')}",
             f"windows {platform.platform()}", f"python {sys.version.split()[0]}",
             f"frozen {getattr(sys, 'frozen', False)}", f"folder {APP_DIR}", ""]
    try:
        import glfw
        from .monitors import list_monitors
        if glfw.init():
            try:
                for m in list_monitors():
                    lines.append(m.describe())
            finally:
                glfw.terminate()
    except Exception as e:  # noqa: BLE001
        lines.append(f"monitors: {e}")
    try:
        from .watchdog import autostart_command, autostart_enabled
        lines.append(f"\nautostart {autostart_enabled()}  ({autostart_command()})")
    except Exception:  # noqa: BLE001
        pass
    return "\n".join(lines)


def make_report(out_dir: Path | None = None) -> Path:
    from . import backup
    from .config import load_config, resolve_path
    out_dir = out_dir or desktop()
    zpath = out_dir / f"DomePlayer-report-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    try:
        cal = resolve_path(load_config()["calibration"]["folder"])
    except Exception:  # noqa: BLE001
        cal = APP_DIR / "calibration"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("system.txt", _system_info())
        for name in ("config.json",):
            if (APP_DIR / name).exists():
                z.write(APP_DIR / name, name)
        for folder, arc in ((APP_DIR / "logs", "logs"), (cal, "calibration")):
            if folder.is_dir():
                for f in folder.rglob("*"):
                    if f.is_file() and f.stat().st_size < BIG:
                        z.write(f, f"{arc}/{f.relative_to(folder).as_posix()}")
        baks = [{"folder": b["path"].name, "saved": b["saved"], "reason": b["reason"],
                 "created": b["created"], "mode": b["mode"], "stats": b["stats"]}
                for b in backup.list_backups(cal)]
        z.writestr("calibration_backups.json", json.dumps(baks, indent=1, ensure_ascii=False))
    return zpath


def main() -> int:
    p = make_report()
    print(p)
    return 0
