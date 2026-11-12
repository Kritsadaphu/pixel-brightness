"""How the start window (control panel) and the running player talk: three small files in logs/.

status.json   written by the player twice a second: what it is doing, messages, progress
command.txt   written by the control panel: one command per line, taken by the player
preview.png   the camera picture while the camera page is open
"""
from __future__ import annotations

import json
import os
import time

from .config import APP_DIR

LOGS = APP_DIR / "logs"
STATUS = LOGS / "status.json"
COMMAND = LOGS / "command.txt"
PREVIEW = LOGS / "preview.png"


def send(command: str) -> bool:
    """Control panel: ask the player to do something ("key T", "key S ctrl", "calibrate")."""
    try:
        LOGS.mkdir(exist_ok=True)
        with open(COMMAND, "a", encoding="utf-8") as f:
            f.write(f"{time.time():.2f}\t{command.strip()}\n")
        return True
    except OSError:
        return False


def take_commands() -> list[str]:
    """Player: fetch and remove what was sent. The file is renamed first, so a command written
    at the same moment is neither lost nor run twice."""
    taken = COMMAND.with_suffix(".taken")
    try:
        os.replace(COMMAND, taken)
    except OSError:
        return []
    try:
        lines = taken.read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    try:
        taken.unlink()
    except OSError:
        pass
    out: list[str] = []
    now = time.time()
    for ln in lines:
        stamp, _, cmd = ln.partition("\t")
        try:
            age = now - float(stamp)
        except ValueError:
            continue
        cmd = cmd.strip()
        if not cmd or age > 10 or age < -10:     # pressed long ago (player was busy or not running)
            continue
        if out and out[-1] == cmd and not cmd.startswith("key "):
            continue                              # a double click on "calibrate" / "show" / "still"
        out.append(cmd)
    return out


def write_status(data: dict) -> None:
    tmp = STATUS.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, STATUS)
    except OSError:
        pass      # the panel is reading it right now: the next one will do


def read_status(max_age_s: float = 3.0) -> dict | None:
    """None = no player is writing (not running, or frozen)."""
    try:
        d = json.loads(STATUS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if time.time() - float(d.get("time", 0)) > max_age_s:
        return None
    return d
