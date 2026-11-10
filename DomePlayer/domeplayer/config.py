"""Load config.json, fill in defaults, and validate values.

Every key has a default, so config.json only needs the keys you want to change.
"""
from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

# The DomePlayer folder (config.json, lib/, logs/). When packaged as DomePlayer.exe
# (PyInstaller) that is the folder holding the .exe, not the bundled source.
if getattr(sys, "frozen", False):
    APP_DIR = Path(sys.executable).resolve().parent
else:
    APP_DIR = Path(__file__).resolve().parent.parent

DEFAULTS: dict = {
    "video": {
        # Relative paths are resolved against the DomePlayer folder.
        "path": "videos/dome.mp4",
        "loop": True,
        "audio": True,
        "volume": 100,
        # mpv hwdec list, tried in order. "nvdec" = NVIDIA decoder with zero-copy
        # CUDA->OpenGL interop. "nvdec-copy" copies frames back (slower, still GPU decode).
        "hwdec": "nvdec,nvdec-copy,auto-copy",
        # CUDA device used for decoding: -1 = auto (driver picks). Used later for 2-GPU setups.
        "cuda_device": -1,
    },
    "display": {
        # Windows display number (\\.\DISPLAY<n>). Run IDENTIFY-MONITORS.bat to see the numbers.
        "monitor": 1,
        "fullscreen": True,
        # "borderless" = borderless window covering the monitor (recommended, needed for multi-window later)
        # "exclusive"  = real fullscreen video mode using width/height/refresh_rate below
        "mode": "borderless",
        "width": 1920,
        "height": 1200,
        # 0 = keep the monitor's current refresh rate (only used in "exclusive" mode)
        "refresh_rate": 0,
        "vsync": True,
        "always_on_top": True,
        "hide_cursor": True,
    },
    "preview": {
        # contain = whole fisheye visible, cover = fill the screen, stretch = ignore aspect
        "fit": "contain",
        "zoom": 1.0,
        "rotate_deg": 0.0,
        "flip_x": False,
        "flip_y": False,
        "background": [0, 0, 0],
    },
    "render": {
        # 0 = decode texture at the video's native size (3840x3840). Otherwise the longest side
        # is limited to this many pixels (e.g. 2048 to save GPU memory while testing).
        "video_texture_size": 0,
        # Mipmaps avoid shimmering when the 3840 image is shown smaller.
        "mipmaps": True,
    },
    "stats": {
        "show_on_start": True,
        "key": "F1",
        "font_size": 22,
    },
    "keys": {
        # Key names follow GLFW: ESCAPE, SPACE, HOME, F1..F12, A..Z ... Use "" to disable a key.
        "quit": "ESCAPE",
        "pause": "SPACE",
        "restart": "HOME",
    },
    # Stacked projection: every projector shows the same full image on the same dome area.
    "stack": {
        # true = show the video on every monitor in "monitors" (one window spanning them all,
        # so all projectors always show the same video frame). false = only display.monitor.
        "enabled": False,
        "monitors": [1, 2, 3, 4, 5, 6],
    },
    # Per-projector alignment, written by the player's edit mode (E key, then Ctrl+S).
    # "3": {"corners": [[x, y] top-left, top-right, bottom-right, bottom-left], "brightness": 1.0}
    # Corners are fractions of that output's width/height (0..1, y downwards).
    "outputs": {},
    # Camera calibration (C = camera preview, K K = calibrate, U = calibration on/off).
    "calibration": {
        "use": True,             # apply the saved calibration when playing
        "camera": 0,             # webcam number; change with [ and ] in the camera preview
        "camera_width": 1920,
        "camera_height": 1080,
        "settle_ms": 450,        # wait after each pattern before taking the picture
        "average": 2,            # pictures averaged per pattern
        "skip_bits": 2,          # finest stripes not used (4 px), the camera can't resolve them
        "folder": "calibration", # where results are saved (next to config.json)
        "simulate": False,       # test without a camera (pretend projectors)
    },
    "log_level": "info",
}

# Sections whose keys are free (monitor numbers) instead of fixed setting names.
FREE_SECTIONS = {"outputs"}


class ConfigError(Exception):
    pass


def _merge(base: dict, override: dict, path: str = "") -> dict:
    out = copy.deepcopy(base)
    for key, value in override.items():
        if key.startswith("_"):
            continue  # "_comment" style keys are allowed and ignored
        full = f"{path}{key}"
        if key not in base:
            raise ConfigError(f'Unknown setting "{full}" in config.json (check spelling)')
        if full in FREE_SECTIONS:
            if not isinstance(value, dict):
                raise ConfigError(f'"{full}" must be a {{ ... }} section')
            out[key] = copy.deepcopy(value)
        elif isinstance(base[key], dict):
            if not isinstance(value, dict):
                raise ConfigError(f'"{full}" must be a {{ ... }} section')
            out[key] = _merge(base[key], value, full + ".")
        else:
            out[key] = value
    return out


def _check(cond: bool, msg: str) -> None:
    if not cond:
        raise ConfigError(msg)


def resolve_path(p: str) -> Path:
    path = Path(p.replace("\\", "/")).expanduser()
    if not path.is_absolute():
        path = APP_DIR / path
    return path


def load_config(path: Path | None = None) -> dict:
    path = path or (APP_DIR / "config.json")
    if not path.exists():
        raise ConfigError(f"config file not found: {path}")
    text = path.read_text(encoding="utf-8-sig")  # tolerate Notepad's BOM
    try:
        user = json.loads(text)
    except json.JSONDecodeError as e:
        raise ConfigError(
            f"config.json has a mistake at line {e.lineno}, column {e.colno}: {e.msg}. "
            "Common causes: a missing or extra comma, or a single backslash in a path "
            "(use / instead of \\)."
        ) from e
    _check(isinstance(user, dict), "config.json must start with { and end with }")
    cfg = _merge(DEFAULTS, user)

    v, d, p, r, s = cfg["video"], cfg["display"], cfg["preview"], cfg["render"], cfg["stats"]
    _check(isinstance(v["path"], str) and v["path"], "video.path must be a file path")
    _check(isinstance(d["monitor"], int) and d["monitor"] >= 1, "display.monitor must be 1, 2, 3 ...")
    _check(d["mode"] in ("borderless", "exclusive"), 'display.mode must be "borderless" or "exclusive"')
    _check(p["fit"] in ("contain", "cover", "stretch"), 'preview.fit must be "contain", "cover" or "stretch"')
    _check(isinstance(p["background"], list) and len(p["background"]) == 3,
           "preview.background must be [r, g, b] with values 0-255")
    for k in ("width", "height"):
        _check(isinstance(d[k], int) and d[k] > 0, f"display.{k} must be a positive number")
    _check(isinstance(r["video_texture_size"], int) and r["video_texture_size"] >= 0,
           "render.video_texture_size must be 0 or a positive number")
    _check(isinstance(s["font_size"], int) and 8 <= s["font_size"] <= 200, "stats.font_size must be 8-200")
    _check(isinstance(v["cuda_device"], int), "video.cuda_device must be a number (-1 = auto)")

    st = cfg["stack"]
    mons = st["monitors"]
    _check(isinstance(mons, list) and mons and all(isinstance(m, int) and m >= 1 for m in mons)
           and len(set(mons)) == len(mons),
           "stack.monitors must be a list of different monitor numbers, e.g. [3, 6, 2, 4, 5, 1]")
    for num, o in cfg["outputs"].items():
        where = f'outputs."{num}"'
        _check(str(num).isdigit(), f"{where}: the name must be a monitor number in quotes, e.g. \"3\"")
        _check(isinstance(o, dict), f"{where} must be a {{ ... }} section")
        unknown = set(o) - {"corners", "brightness"} - {k for k in o if k.startswith("_")}
        _check(not unknown, f"{where}: unknown setting {sorted(unknown)}")
        if "corners" in o:
            c = o["corners"]
            _check(isinstance(c, list) and len(c) == 4 and all(
                isinstance(pt, list) and len(pt) == 2 and all(isinstance(x, (int, float)) for x in pt)
                for pt in c), f"{where}.corners must be 4 points [[x, y], [x, y], [x, y], [x, y]]")
        if "brightness" in o:
            b = o["brightness"]
            _check(isinstance(b, (int, float)) and 0 <= b <= 2, f"{where}.brightness must be 0.0-2.0")

    cfg["video"]["path_resolved"] = str(resolve_path(v["path"]))
    cfg["_config_path"] = str(path)
    return cfg


def save_setting(config_path: str | Path, section: str, key: str, value) -> None:
    """Change one value in config.json, keeping everything else as it is."""
    path = Path(config_path)
    raw = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    raw.setdefault(section, {})[key] = value
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def save_outputs(config_path: str | Path, outputs: dict) -> None:
    """Write per-projector alignment into config.json, keeping everything else as it is."""
    path = Path(config_path)
    raw = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    merged = dict(raw.get("outputs") or {})
    for num, o in outputs.items():
        merged.setdefault(str(num), {}).update(o)
    raw["outputs"] = dict(sorted(merged.items(), key=lambda kv: int(kv[0])))
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
