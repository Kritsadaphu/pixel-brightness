"""Keeps the player running: DomePlayer.exe --watch  (--autostart = the same, started by Windows).

* waits until all the dome monitors are there (projectors still warming up after power-on)
* starts the player (--play --supervised)
* restarts it when it crashes, freezes (no heartbeat for FREEZE_S) or when monitors were
  disconnected/connected while playing
* stops when the player is closed normally (Esc)

Also: turn "start with Windows" on/off (HKCU Run key, no admin rights needed).
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from logging.handlers import RotatingFileHandler

from .config import APP_DIR, ConfigError, load_config

log = logging.getLogger("domeplayer.watchdog")
LOG_DIR = APP_DIR / "logs"
HEARTBEAT = LOG_DIR / "heartbeat.txt"
FREEZE_S = 30          # no heartbeat for this long = frozen
FIRST_BEAT_S = 120     # time allowed for the first heartbeat (start-up, big video)
MONITOR_WAIT_S = 120   # wait this long for missing monitors, then start anyway
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "DomePlayer"


def self_command(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return [w if os.path.exists(w) else exe, "-m", "domeplayer", *args]


def _setup_log() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    h = RotatingFileHandler(LOG_DIR / "watchdog.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)
    log.propagate = False


def present_monitors() -> list[int]:
    import glfw
    from .monitors import list_monitors
    if not glfw.init():
        return []
    try:
        return sorted(m.number for m in list_monitors())
    finally:
        glfw.terminate()


def wait_for_monitors(want: list[int], limit_s: float = MONITOR_WAIT_S) -> None:
    t0 = time.time()
    last = None
    while True:
        try:
            have = present_monitors()
        except Exception as e:  # noqa: BLE001
            log.warning("could not list monitors: %s", e)
            have = []
        missing = [n for n in want if n not in have]
        if not missing:
            log.info("all monitors present: %s", want)
            return
        if missing != last:
            log.info("waiting for monitors %s (present: %s)", missing, have)
            last = missing
        if time.time() - t0 > limit_s:
            log.warning("monitors %s still missing after %d s - starting anyway", missing, limit_s)
            return
        time.sleep(3)


def _no_window() -> int:
    return 0x08000000 if os.name == "nt" else 0     # CREATE_NO_WINDOW


def main(autostart: bool = False) -> int:
    _setup_log()
    log.info("watchdog started (%s)", "Windows start-up" if autostart else "launcher")
    try:
        cfg = load_config()
    except ConfigError as e:
        from .app import show_fatal
        show_fatal(str(e))
        return 2
    want = list(cfg["stack"]["monitors"]) if cfg["stack"]["enabled"] else [cfg["display"]["monitor"]]
    if autostart:
        time.sleep(8)          # let Windows finish logging in
    if cfg["display"]["fullscreen"]:
        wait_for_monitors(want)

    crashes: list[float] = []
    while True:
        try:
            HEARTBEAT.unlink()
        except OSError:
            pass
        t0 = time.time()
        proc = subprocess.Popen(self_command("--play", "--supervised"), cwd=str(APP_DIR),
                                creationflags=_no_window())
        log.info("player started (pid %d)", proc.pid)
        frozen = False
        while proc.poll() is None:
            time.sleep(1)
            try:
                beat = HEARTBEAT.stat().st_mtime
            except OSError:
                beat = None
            age = time.time() - (beat if beat else t0)
            if (beat and age > FREEZE_S) or (not beat and age > FIRST_BEAT_S):
                log.error("player frozen (no sign of life for %d s) - restarting it", age)
                frozen = True
                proc.kill()
                proc.wait(10)
                break
        code = proc.returncode
        if code == 0 and not frozen:
            log.info("player closed normally - watchdog stops")
            return 0
        if code == 2:
            log.error("player stopped because of a config.json error - not restarting")
            return 2
        if code == 3:
            log.warning("monitors changed while playing - waiting for them, then restarting")
            wait_for_monitors(want)
        else:
            log.error("player stopped unexpectedly (exit code %s) - restarting", code)
        now = time.time()
        crashes = [t for t in crashes if now - t < 600] + [now]
        time.sleep(60 if len(crashes) >= 5 else 3)


# ---- start with Windows -----------------------------------------------------------------

def autostart_command() -> str:
    return " ".join(f'"{a}"' if " " in a else a for a in self_command("--autostart"))


def autostart_enabled() -> bool:
    if os.name != "nt":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            val, _ = winreg.QueryValueEx(k, RUN_NAME)
        return bool(val)
    except OSError:
        return False


def set_autostart(on: bool) -> None:
    if os.name != "nt":
        return
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        if on:
            winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_NAME)
            except OSError:
                pass
