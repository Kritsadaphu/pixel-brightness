"""Keeps the player running: DomePlayer.exe --watch  (--autostart = the same, started by Windows).

* only one DomePlayer show at a time (named mutex); a new start can ask the old one to stop
* at Windows start-up: waits until all the dome monitors are there (projectors warming up)
* starts the player (--play --supervised)
* restarts it when it crashes, freezes (no heartbeat for FREEZE_S) or when monitors were
  disconnected/connected while playing
* stops when the player is closed normally (Esc)
* started by hand and the player never comes up: says so in a message box instead of
  retrying silently for ever

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
STOP_FILE = LOG_DIR / "stop.request"   # written by a new start that wants this one to end
STOP_VALID_S = 30      # an older stop.request is a leftover and is ignored
FREEZE_S = 30          # no heartbeat for this long = frozen
FIRST_BEAT_S = 120     # time allowed for the first heartbeat (start-up, big video)
MONITOR_WAIT_S = 120   # at Windows start-up: wait this long for missing monitors, then start anyway
MONITOR_BACK_S = 15    # a projector dropped out while playing: wait this long for it to come back
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "DomePlayer"
MUTEX_NAME = "Local\\DomePlayer.show"
_mutex = None          # handle kept for the life of the process
_child = None          # the running player (so an unexpected watchdog error can end it)


def self_command(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    exe = sys.executable
    w = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return [w if os.path.exists(w) else exe, "-m", "domeplayer", *args]


def _setup_log() -> None:
    if log.handlers:
        return
    LOG_DIR.mkdir(exist_ok=True)
    h = RotatingFileHandler(LOG_DIR / "watchdog.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
    log.addHandler(h)
    log.setLevel(logging.INFO)
    log.propagate = False


# ---- one show at a time -------------------------------------------------------------------

def _kernel32():
    import ctypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateMutexW.restype = ctypes.c_void_p
    k32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    k32.OpenMutexW.restype = ctypes.c_void_p
    k32.OpenMutexW.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_wchar_p]
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
    return k32


def single_instance() -> bool:
    """Claim "the DomePlayer show" for this process. False = another watchdog/player has it."""
    global _mutex
    if os.name != "nt" or _mutex is not None:
        return True
    import ctypes
    k32 = _kernel32()
    ctypes.set_last_error(0)
    h = k32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == 183:          # ERROR_ALREADY_EXISTS
        if h:
            k32.CloseHandle(h)
        return False
    _mutex = h                                   # held until this process ends
    try:
        STOP_FILE.unlink()                       # a leftover request must not stop the new show
    except OSError:
        pass
    return True


def is_running() -> bool:
    """True when a DomePlayer watchdog or player is running in this Windows session."""
    if os.name != "nt":
        return False
    k32 = _kernel32()
    h = k32.OpenMutexW(0x00100000, False, MUTEX_NAME)     # SYNCHRONIZE
    if h:
        k32.CloseHandle(h)
    return bool(h)


def stop_requested() -> bool:
    try:
        return time.time() - STOP_FILE.stat().st_mtime < STOP_VALID_S
    except OSError:
        return False


def request_stop(limit_s: float = 20.0) -> bool:
    """Ask the running DomePlayer (watchdog and player) to end. True when it is gone."""
    try:
        LOG_DIR.mkdir(exist_ok=True)
        STOP_FILE.write_text(str(time.time()), encoding="ascii")
    except OSError:
        return not is_running()
    t0 = time.time()
    while is_running() and time.time() - t0 < limit_s:
        time.sleep(0.25)
    gone = not is_running()
    try:
        STOP_FILE.unlink()
    except OSError:
        pass
    return gone


def tell(message: str) -> None:
    """Message box on top of everything (the only screens may be the projectors)."""
    _setup_log()
    log.error(message.replace("\n", " | "))
    if os.environ.get("DOMEPLAYER_NO_DIALOG"):      # automated tests: log only
        return
    if os.name == "nt":
        try:
            import ctypes       # MB_ICONERROR | MB_TOPMOST | MB_SETFOREGROUND
            ctypes.windll.user32.MessageBoxW(None, message, "DomePlayer", 0x10 | 0x40000 | 0x10000)
        except Exception:  # noqa: BLE001
            pass


ALREADY_RUNNING = ("DomePlayer เปิดอยู่แล้ว (กำลังเล่น หรือเพิ่งเปิดเครื่องและกำลังรอโปรเจคเตอร์ สูงสุด 2 นาที)\n"
                   "กด Esc ที่หน้าจอเล่นเพื่อปิดก่อน หรือเปิดหน้าต่างเริ่มต้นแล้วกด \"เล่น\" เพื่อเริ่มใหม่")


def _last_error() -> str:
    """Last ERROR line of the player's log (for the message box)."""
    try:
        lines = (LOG_DIR / "domeplayer.log").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return next((ln for ln in reversed(lines) if " ERROR " in ln), "")[:400]


# ---- monitors -----------------------------------------------------------------------------

def present_monitors() -> list[int]:
    import glfw
    from .monitors import list_monitors
    if not glfw.init():
        return []
    try:
        return sorted(m.number for m in list_monitors())
    finally:
        glfw.terminate()


def _sleep(seconds: float) -> bool:
    """Sleep, but wake up early (True) when a new start asked this watchdog to stop."""
    t_end = time.time() + seconds
    while time.time() < t_end:
        if stop_requested():
            return True
        time.sleep(min(0.5, max(0.0, t_end - time.time())))
    return stop_requested()


def _displays_at_calibration(cfg: dict) -> int:
    """How many displays the show used when it was last calibrated (0 = not known)."""
    try:
        import json
        from .config import resolve_path
        info = json.loads((resolve_path(cfg["calibration"]["folder"]) / "calibration.json").read_text(encoding="utf-8"))
        return len(info.get("monitors") or [])
    except (OSError, ValueError):
        return 0


def wait_for_monitors(want: list[int], limit_s: float = MONITOR_WAIT_S, count: int = 0) -> bool:
    """Wait until all wanted monitors are present, and at least 'count' displays in all
    (or limit_s is over). True = asked to stop."""
    t0 = time.time()
    last = None
    while True:
        try:
            have = present_monitors()
        except Exception as e:  # noqa: BLE001
            log.warning("could not list monitors: %s", e)
            have = []
        missing = [n for n in want if n not in have]
        if not missing and len(have) < count:
            missing = [f"{count - len(have)} more display(s)"]
        if not missing:
            log.info("all monitors present: %s", have)
            return False
        if missing != last:
            log.info("waiting for monitors %s (present: %s)", missing, have)
            last = missing
        if time.time() - t0 > limit_s:
            log.warning("monitors %s still missing after %d s - starting anyway", missing, limit_s)
            return False
        if _sleep(3):
            return True


def _no_window() -> int:
    return 0x08000000 if os.name == "nt" else 0     # CREATE_NO_WINDOW


# ---- the watchdog -------------------------------------------------------------------------

def main(autostart: bool = False) -> int:
    _setup_log()
    try:
        return _watch(autostart)
    except Exception:  # noqa: BLE001 - never leave a player behind without its watchdog
        log.exception("watchdog stopped by an unexpected error")
        if _child is not None and _child.poll() is None:
            try:
                _child.kill()
            except OSError:
                pass
        return 1


def _watch(autostart: bool) -> int:
    global _child
    if not single_instance():
        log.info("another DomePlayer is already running - this one stops")
        if not autostart:
            tell(ALREADY_RUNNING)
        return 0
    log.info("watchdog started (%s)", "Windows start-up" if autostart else "launcher")
    from .app import keep_awake
    keep_awake()        # the PC must not fall asleep while we wait for projectors or retry
    try:
        cfg = load_config()
    except ConfigError as e:
        tell(str(e))
        return 2
    want = list(cfg["stack"]["monitors"]) if cfg["stack"]["enabled"] else [cfg["display"]["monitor"]]
    count = 0
    if cfg["stack"]["enabled"] and cfg["stack"].get("auto"):
        want, count = [], _displays_at_calibration(cfg) + 1      # + the operator's screen
    if autostart:
        if _sleep(8):          # let Windows finish logging in
            return 0
        # only at power-on: the projectors are still warming up. A start by hand begins at once
        # (the player uses the monitors that are there and says which are missing).
        if cfg["display"]["fullscreen"] and wait_for_monitors(want, count=count):
            log.info("asked to stop while waiting for the monitors")
            return 0

    crashes: list[float] = []
    quick, ever_ok = 0, False
    while True:
        try:
            HEARTBEAT.unlink()
        except OSError:
            pass
        t0 = time.time()
        try:
            proc = subprocess.Popen(self_command("--play", "--supervised"), cwd=str(APP_DIR),
                                    creationflags=_no_window())
        except OSError as e:
            log.error("could not start the player (%s) - trying again in 10 s", e)
            if _sleep(10):
                return 0
            continue
        _child = proc
        log.info("player started (pid %d)", proc.pid)
        frozen = stopped = False
        last, seen = t0, False          # only heartbeats written by THIS player count
        while proc.poll() is None:
            time.sleep(1)
            if stop_requested():        # a new start wants the dome: the player ends by itself
                stopped = True
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                break
            try:
                beat = HEARTBEAT.stat().st_mtime
            except OSError:
                beat = None
            if beat and beat > t0:
                last, seen = beat, True
            age = time.time() - last
            if age > (FREEZE_S if seen else FIRST_BEAT_S):
                log.error("player frozen (no sign of life for %d s) - restarting it", age)
                frozen = True
                proc.kill()
                try:
                    proc.wait(10)
                except subprocess.TimeoutExpired:
                    log.error("player did not end 10 s after it was killed")
                break
        code = proc.returncode
        ran = time.time() - t0
        if stopped or stop_requested():
            log.info("a new start of DomePlayer asked this one to stop - watchdog stops")
            return 0
        if code == 0 and not frozen:
            log.info("player closed normally - watchdog stops")
            return 0
        if code == 2:
            log.error("player stopped because of a config.json error - not restarting")
            try:
                load_config()
            except ConfigError as e:
                tell(str(e))
            return 2
        if code == 3 and not frozen:
            log.warning("monitors changed while playing - waiting for them, then restarting")
            # a projector that stays off must not hold up the others for long; when it comes
            # back later the player notices and we set the outputs up again
            if wait_for_monitors(want, MONITOR_BACK_S, count=count):
                return 0
            if ran >= 15 or not want:   # a real monitor change is not a crash: no back-off
                # (automatic list: the player takes what is there, so let the displays settle first)
                if _sleep(3 if want else MONITOR_BACK_S):
                    return 0
                continue
        else:
            log.error("player stopped unexpectedly (exit code %s) after %d s - restarting", code, ran)
        now = time.time()
        crashes = [t for t in crashes if now - t < 600] + [now]
        ever_ok = ever_ok or ran >= 30
        quick = quick + 1 if (ran < 30 and not frozen) else 0
        if quick >= 3 and not autostart and not ever_ok:
            # started by hand and it never came up: tell the person in front of it.
            # (After a good run, or at Windows start-up, keep retrying silently - nobody is there.)
            tell("DomePlayer เปิดตัวเล่นไม่ขึ้น (ลองแล้ว 3 ครั้ง)\n"
                 "กด 'ตรวจความพร้อม' ดูสาเหตุ หรือกด 'เก็บข้อมูลส่งช่าง (zip)' แล้วส่งให้ช่าง\n\n" + _last_error())
            return 1
        if _sleep(60 if len(crashes) >= 5 else 3):
            return 0


# ---- start with Windows -----------------------------------------------------------------

def autostart_command() -> str:
    cmd = self_command("--autostart")
    if not getattr(sys, "frozen", False):
        # Windows starts Run-key programs in another folder, where "-m domeplayer" is not found
        cmd = [cmd[0], "-c", f"import sys; sys.path.insert(0, r'{APP_DIR}'); "
                             "from domeplayer.app import main; sys.exit(main(['--autostart']))"]
    return " ".join(f'"{a}"' if " " in a else a for a in cmd)


def autostart_target() -> str:
    """The command Windows runs at logon ("" = none)."""
    if os.name != "nt":
        return ""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return str(winreg.QueryValueEx(k, RUN_NAME)[0])
    except OSError:
        return ""


def autostart_enabled() -> bool:
    return bool(autostart_target())


def autostart_is_this_folder() -> bool:
    """True when the Run key starts THIS copy of DomePlayer (not one in another/moved folder)."""
    return autostart_target().strip().lower() == autostart_command().lower()


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
