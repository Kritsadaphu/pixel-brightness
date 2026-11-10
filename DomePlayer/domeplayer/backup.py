"""Calibration backups.

Before a calibration is replaced (new camera calibration, dome circle changed, or a backup
put back), the current one is copied into <calibration folder>_backup/<date-time>/ together
with config.json. The newest KEEP backups are kept. restore() puts one back.
"""
from __future__ import annotations

import json
import logging
import shutil
import time
from pathlib import Path

log = logging.getLogger("domeplayer.backup")
KEEP = 20
_SKIP = {"config.json", "backup.json"}


def backup_root(cal_folder: Path) -> Path:
    cal_folder = Path(cal_folder)
    return cal_folder.with_name(cal_folder.name + "_backup")


def backup(cal_folder: Path, config_path: Path | None, reason: str) -> Path | None:
    """Copy the current calibration away. Returns the backup folder (None if nothing to keep)."""
    cal_folder = Path(cal_folder)
    if not (cal_folder / "calibration.json").exists():
        return None
    root = backup_root(cal_folder)
    root.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dst = root / stamp
    k = 2
    while dst.exists():
        dst = root / f"{stamp}-{k}"
        k += 1
    shutil.copytree(cal_folder, dst)
    if config_path and Path(config_path).exists():
        shutil.copyfile(config_path, dst / "config.json")
    (dst / "backup.json").write_text(json.dumps({"reason": reason, "saved": time.strftime("%Y-%m-%d %H:%M:%S")},
                                                ensure_ascii=False), encoding="utf-8")
    log.info("calibration backed up to %s (%s)", dst, reason)
    olds = sorted(p for p in root.iterdir() if p.is_dir())
    for p in olds[:-KEEP]:
        shutil.rmtree(p, ignore_errors=True)
    return dst


def list_backups(cal_folder: Path) -> list[dict]:
    """Newest first: {path, created, saved, reason, mode, monitors}."""
    root = backup_root(cal_folder)
    out = []
    if not root.is_dir():
        return out
    for p in sorted((p for p in root.iterdir() if p.is_dir()), reverse=True):
        try:
            info = json.loads((p / "calibration.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - broken backup, skip it
            continue
        try:
            meta = json.loads((p / "backup.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            meta = {}
        out.append({"path": p, "created": info.get("created", "?"), "saved": meta.get("saved", p.name),
                    "reason": meta.get("reason", ""), "mode": info.get("mode", "stack"),
                    "monitors": info.get("monitors", []), "stats": info.get("stats", {})})
    return out


def restore(cal_folder: Path, config_path: Path, src: Path) -> None:
    """Put backup 'src' back as the current calibration (the current one is backed up first)."""
    cal_folder, src = Path(cal_folder), Path(src)
    if not (src / "calibration.json").exists():
        raise RuntimeError(f"{src} is not a calibration backup")
    backup(cal_folder, config_path, "before restore")
    tmp = cal_folder.with_name(cal_folder.name + ".restoring")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(src, tmp, ignore=lambda _d, names: [n for n in names if n in _SKIP])
    old = cal_folder.with_name(cal_folder.name + ".old")
    shutil.rmtree(old, ignore_errors=True)
    if cal_folder.exists():
        cal_folder.rename(old)
    tmp.rename(cal_folder)
    shutil.rmtree(old, ignore_errors=True)

    # settings that belong to that calibration
    info = json.loads((cal_folder / "calibration.json").read_text(encoding="utf-8"))
    cfg_path = Path(config_path)
    raw = json.loads(cfg_path.read_text(encoding="utf-8-sig")) if cfg_path.exists() else {}
    cal = raw.setdefault("calibration", {})
    if info.get("mode"):
        cal["mode"] = info["mode"]
    if info.get("mode") == "dome" and info.get("circle"):
        cal["dome_circle"] = [round(float(x), 5) for x in info["circle"]]
        cal["dome_front_deg"] = float(info.get("front_deg") or 0.0)
    try:
        old_cfg = json.loads((src / "config.json").read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        old_cfg = {}
    if "outputs" in old_cfg:
        raw["outputs"] = old_cfg["outputs"]
    if info.get("monitors"):
        raw.setdefault("stack", {})["monitors"] = info["monitors"]
    t = cfg_path.with_suffix(".json.tmp")
    t.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    t.replace(cfg_path)
    log.info("calibration restored from %s", src)
