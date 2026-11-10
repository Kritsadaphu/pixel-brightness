"""Load config.json, fill in defaults, and validate values.

Every key has a default, so config.json only needs the keys you want to change.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

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
    "log_level": "info",
}


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
        if isinstance(base[key], dict):
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

    cfg["video"]["path_resolved"] = str(resolve_path(v["path"]))
    return cfg
