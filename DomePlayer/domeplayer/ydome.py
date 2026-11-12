"""Put back the two settings files of the room's old player, YDome, when they are blank.

What was found on the show PC (2026-11): YDome writes config.xml and dome.proj when it is
closed. If the power goes within seconds of that, Windows leaves both files at the right
length but filled with zero bytes. A blank config.xml makes YDome end at once, before its
first log line - which is all it has done since. Good copies are kept in the folder
"YDome-Fix", next to the small program YDome-Fix.exe
(tools/ydome_fix.py - separate from DomePlayer, which has nothing to do with it):
    dome.proj    the saved 2021 project ("dome - Final Final.proj")
    config.xml   rebuilt from the program and the project (same length as the lost file)

repair() keeps the blank files, copies the good ones in and makes them read-only, so the
same accident cannot blank them again (YDome then simply cannot save changes).
Nothing of YDome itself is changed or started.
"""
from __future__ import annotations

import os
import shutil
import stat
import time
from pathlib import Path

from .config import APP_DIR

KIT = APP_DIR / "ydome-repair"          # YDome-Fix.exe sets this to its own folder
DEFAULT_HOME = Path("C:/YDome")


def blank(path: Path) -> bool:
    """True when the file is missing, empty or holds nothing but zero bytes / spaces."""
    try:
        data = path.read_bytes()
    except OSError:
        return True
    return not data.strip(b"\x00 \t\r\n")


def kit_ready() -> bool:
    return (KIT / "dome.proj").is_file() and (KIT / "config.xml").is_file() \
        and not blank(KIT / "dome.proj") and not blank(KIT / "config.xml")


def exe_folders(home: Path) -> list[Path]:
    """Folders with a YDome.exe (the program reads config.xml next to the exe and dome.proj
    one folder up). The one used last (newest log) comes first."""
    found = []
    try:
        for d in home.iterdir():
            if d.is_dir() and (d / "YDome.exe").is_file():
                logs = [f.stat().st_mtime for f in (d / "log").glob("*.log")] if (d / "log").is_dir() else []
                found.append((max(logs, default=0.0), d))
    except OSError:
        return []
    return [d for _, d in sorted(found, reverse=True)]


def look(home: Path = DEFAULT_HOME) -> dict:
    """What is there now. Changes nothing."""
    folders = exe_folders(home)
    return {"home": home, "found": bool(folders), "folders": folders,
            "project_blank": blank(home / "dome.proj"),
            "config_blank": {d: blank(d / "config.xml") for d in folders}}


def _put(src: Path, dst: Path, keep: Path) -> None:
    if dst.exists():
        try:
            os.chmod(dst, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass
        shutil.copy2(dst, keep / (dst.parent.name + "__" + dst.name))
    shutil.copyfile(src, dst)
    os.chmod(dst, stat.S_IREAD)          # read-only: a power cut while YDome closes cannot blank it


def repair(home: Path = DEFAULT_HOME, force: bool = False) -> list[str]:
    """Copy the good files over the blank ones. force = also replace files that are not blank.
    Returns what was done (for the message). Raises OSError / RuntimeError with a plain reason."""
    if not kit_ready():
        raise RuntimeError(f"the repair files are missing in {KIT}")
    state = look(home)
    if not state["found"]:
        raise RuntimeError(f"no YDome.exe found under {home}")
    keep = home / time.strftime("files-before-repair-%Y%m%d-%H%M%S")
    done = []
    todo = []
    if state["project_blank"] or force:
        todo.append((KIT / "dome.proj", home / "dome.proj"))
    for d, is_blank in state["config_blank"].items():
        if is_blank or force:
            todo.append((KIT / "config.xml", d / "config.xml"))
    if not todo:
        return []
    keep.mkdir(parents=True, exist_ok=True)
    for src, dst in todo:
        _put(src, dst, keep)
        done.append(str(dst))
    return done
