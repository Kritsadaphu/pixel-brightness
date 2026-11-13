"""Load config.json, fill in defaults, and validate values.

Every key has a default, so config.json only needs the keys you want to change.
"""
from __future__ import annotations

import copy
import json
import os
import shutil
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
        "show_on_start": False,
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
        # true = use every display except the Windows main display (the operator's screen),
        # whatever numbers Windows gives them today. "monitors" is then ignored.
        "auto": False,
        # displays that are connected but not part of the show (e.g. the customer's 6th projector).
        # "unused_ports" remembers their card sockets, so the choice survives Windows renumbering.
        "unused": [],
        "unused_ports": {},
    },
    # Per-projector alignment, written by the player's edit mode (E key, then Ctrl+S).
    # "3": {"corners": [[x, y] top-left, top-right, bottom-right, bottom-left], "brightness": 1.0}
    # "adjust": manual correction on top of the camera calibration: where the four corners of the
    #           calibrated picture are put (same order; [[0,0],[1,0],[1,1],[0,1]] = unchanged)
    # Corners are fractions of that output's width/height (0..1, y downwards).
    "outputs": {},
    # Camera calibration (C = camera preview, K K = calibrate, U = calibration on/off).
    "calibration": {
        "use": True,             # apply the saved calibration when playing
        "camera": 0,             # webcam number; change with [ and ] in the camera preview
        "camera_width": 1920,
        "camera_height": 1080,
        "camera_fourcc": "",     # "" = let Windows choose; "MJPG" if the camera preview is slow
        "settle_ms": 450,        # shortest wait after each pattern before taking the picture
        "measure_delay": True,   # measure the camera delay first and wait longer if needed
        "average": 2,            # pictures averaged per pattern
        "skip_bits": 2,          # finest stripes not used (4 px), the camera can't resolve them
        "folder": "calibration", # where results are saved (next to config.json)
        "simulate": False,       # test without a camera (pretend projectors)
        "simulate_delay_ms": 0,  # (test only) pretend camera delay
        # calibration from a recorded video (360 camera, phone): seconds each pattern stays on
        # the projectors, and the biggest picture size worked on (bigger videos are made smaller)
        "show_hold_ms": 700,
        "video_max_px": 2160,
        # "dome"  = projectors each cover part of the dome (fanned out, overlapping); the
        #           camera looks up at the dome and dome_circle marks the dome's edge in its picture
        # "stack" = all projectors show the whole picture on the same area, lined up on monitor 1
        "mode": "dome",
        # dome edge in the camera picture: [centre x, centre y, radius] as fractions of the
        # picture width, height, height. [0, 0, 0] = find it from the projected light.
        "dome_circle": [0, 0, 0],
        "dome_front_deg": 0.0,   # turns the video around the dome (which side is "front")
        "lens_mm": 0.0,          # a normal lens on a USB camera: focal length (R50 at 10 mm = 10); 0 = not used
        # the recording camera's lens: "action" = Insta360 Ace Pro 2 / action camera,
        # "equidistant" = plain fisheye, "none" = no lens correction (360 camera, unknown lens)
        "lens_type": "action",
        # angle seen across the SHORT side of the full camera picture. Ace Pro 2, FreeFrame Video
        # 4K 4:3, stabilization off: 2.7 m wide from 1 m away = 107 degrees (measured 2026-11-12)
        "lens_view_deg": 107.0,
        # shape of the dome (from the room's old player YDome): rim diameter and height of the
        # cap in metres. 0 = unknown (the picture is then spread evenly over the view angle)
        "dome_diameter_m": 4.847,
        "dome_height_m": 0.778,
        "usb_camera": True,      # the live camera (Ace Pro 2 as a webcam) is the main route; false = the
                                 # readiness check does not test a USB camera
        # fine tuning of the result, changed live from the control panel:
        "blend_gamma": 2.2,      # the projectors' gamma: lower = overlaps darker, higher = overlaps brighter
        "black_level": 1.0,      # black level compensation: 0 = off, 1 = as measured, up to 3
        "color_match": 1.0,      # colour matching between projectors: 0 = off ... 1 = full
        "sensor_width_mm": 22.3, # R50 sensor width
    },
    # Black outside a circle of the video (Domemaster circle = radius 1.0). Smaller radius
    # hides the outer edge; feather softens the edge. Used when playing and for flat white.
    "mask": {
        "enabled": True,
        "radius": 1.0,
        "feather": 0.01,
        "center": [0.0, 0.0],
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
    for sec, key in (("video", "loop"), ("video", "audio"), ("display", "fullscreen"), ("display", "vsync"),
                     ("display", "always_on_top"), ("display", "hide_cursor"), ("preview", "flip_x"),
                     ("preview", "flip_y"), ("render", "mipmaps"), ("stats", "show_on_start"),
                     ("stack", "enabled"), ("stack", "auto"), ("calibration", "use"), ("calibration", "simulate"),
                     ("calibration", "measure_delay"), ("mask", "enabled")):
        _check(isinstance(cfg[sec][key], bool), f"{sec}.{key} must be true or false (no quotes)")

    def _num(x) -> bool:
        return isinstance(x, (int, float)) and not isinstance(x, bool)

    for sec, key in (("video", "volume"), ("display", "refresh_rate"), ("preview", "zoom"),
                     ("preview", "rotate_deg"), ("calibration", "camera"), ("calibration", "camera_width"),
                     ("calibration", "camera_height"), ("calibration", "settle_ms"), ("calibration", "average"),
                     ("calibration", "skip_bits"), ("calibration", "simulate_delay_ms"),
                     ("calibration", "show_hold_ms"), ("calibration", "video_max_px")):
        _check(_num(cfg[sec][key]), f"{sec}.{key} must be a number (no quotes)")
    _check(isinstance(cfg["preview"]["background"], list) and len(cfg["preview"]["background"]) == 3
           and all(_num(x) for x in cfg["preview"]["background"]),
           "preview.background must be [r, g, b] with values 0-255")
    for sec, key in (("video", "hwdec"), ("stats", "key"), ("keys", "quit"), ("keys", "pause"),
                     ("keys", "restart"), ("calibration", "folder"), ("calibration", "camera_fourcc"),
                     ("log_level", None)):
        val = cfg[sec] if key is None else cfg[sec][key]
        _check(isinstance(val, str), f"{sec}{'.' + key if key else ''} must be text in quotes")

    st = cfg["stack"]
    mons = st["monitors"]
    _check(isinstance(mons, list) and mons and all(isinstance(m, int) and m >= 1 for m in mons)
           and len(set(mons)) == len(mons),
           "stack.monitors must be a list of different monitor numbers, e.g. [3, 6, 2, 4, 5, 1]")
    un = st.get("unused", [])
    _check(isinstance(un, list) and all(isinstance(m, int) and m >= 1 for m in un),
           "stack.unused must be a list of monitor numbers, e.g. [7], or []")
    _check(isinstance(st.get("unused_ports", {}), dict), "stack.unused_ports must be a { ... } section")
    for num, o in cfg["outputs"].items():
        where = f'outputs."{num}"'
        _check(str(num).isdigit(), f"{where}: the name must be a monitor number in quotes, e.g. \"3\"")
        _check(isinstance(o, dict), f"{where} must be a {{ ... }} section")
        unknown = set(o) - {"corners", "brightness", "adjust"} - {k for k in o if k.startswith("_")}
        _check(not unknown, f"{where}: unknown setting {sorted(unknown)}")
        if "corners" in o:
            c = o["corners"]
            _check(isinstance(c, list) and len(c) == 4 and all(
                isinstance(pt, list) and len(pt) == 2 and all(isinstance(x, (int, float)) for x in pt)
                for pt in c), f"{where}.corners must be 4 points [[x, y], [x, y], [x, y], [x, y]]")
        if "adjust" in o:
            c = o["adjust"]
            _check(isinstance(c, list) and len(c) == 4 and all(
                isinstance(pt, list) and len(pt) == 2 and all(isinstance(x, (int, float)) for x in pt)
                for pt in c), f"{where}.adjust must be 4 points [[x, y], [x, y], [x, y], [x, y]]")
        if "brightness" in o:
            b = o["brightness"]
            _check(isinstance(b, (int, float)) and 0 <= b <= 2, f"{where}.brightness must be 0.0-2.0")

    cc = cfg["calibration"]
    _check(cc["mode"] in ("dome", "stack"), 'calibration.mode must be "dome" or "stack"')
    dc = cc["dome_circle"]
    _check(isinstance(dc, list) and len(dc) == 3 and all(isinstance(x, (int, float)) for x in dc)
           and dc[2] >= 0, "calibration.dome_circle must be [centre x, centre y, radius], e.g. [0.5, 0.5, 0.45]")
    for k in ("dome_front_deg", "lens_mm", "sensor_width_mm"):
        _check(isinstance(cc[k], (int, float)), f"calibration.{k} must be a number")
    _check(cc["lens_mm"] >= 0 and cc["sensor_width_mm"] > 0, "calibration.lens_mm must be 0 or more")
    _check(isinstance(cc["blend_gamma"], (int, float)) and 1.0 <= cc["blend_gamma"] <= 4.0,
           "calibration.blend_gamma must be 1.0-4.0")
    _check(isinstance(cc["black_level"], (int, float)) and 0 <= cc["black_level"] <= 3,
           "calibration.black_level must be 0-3")
    _check(isinstance(cc["color_match"], (int, float)) and 0 <= cc["color_match"] <= 1,
           "calibration.color_match must be 0-1")
    _check(cc["lens_type"] in ("action", "equidistant", "none"),
           'calibration.lens_type must be "action", "equidistant" or "none"')
    for k in ("lens_view_deg", "dome_diameter_m", "dome_height_m"):
        _check(isinstance(cc[k], (int, float)) and cc[k] >= 0, f"calibration.{k} must be a number, 0 or more")
    mk = cfg["mask"]
    _check(isinstance(mk["radius"], (int, float)) and 0 < mk["radius"] <= 2, "mask.radius must be 0.0-2.0")
    _check(isinstance(mk["feather"], (int, float)) and 0 <= mk["feather"] <= 1, "mask.feather must be 0.0-1.0")
    _check(isinstance(mk["center"], list) and len(mk["center"]) == 2
           and all(isinstance(x, (int, float)) for x in mk["center"]), "mask.center must be [x, y]")

    cfg["video"]["path_resolved"] = str(resolve_path(v["path"]))
    cfg["_config_path"] = str(path)
    return cfg


def write_config(config_path: str | Path, raw: dict) -> None:
    """Replace config.json in one step. The new text is on the disk before the old file is
    replaced (power cut = old or new file, never an empty one) and the last readable
    config.json is kept as config.json.bak."""
    path = Path(config_path)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(raw, indent=2, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    try:
        json.loads(path.read_text(encoding="utf-8-sig"))
        shutil.copyfile(path, path.with_suffix(".json.bak"))
    except (OSError, ValueError):
        pass                      # no config.json yet, or it is damaged: keep the older .bak
    os.replace(tmp, path)


def save_setting(config_path: str | Path, section: str, key: str, value) -> None:
    """Change one value in config.json, keeping everything else as it is."""
    path = Path(config_path)
    raw = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    raw.setdefault(section, {})[key] = value
    write_config(path, raw)


def save_outputs(config_path: str | Path, outputs: dict) -> None:
    """Write per-projector alignment into config.json, keeping everything else as it is."""
    path = Path(config_path)
    raw = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    merged = dict(raw.get("outputs") or {})
    for num, o in outputs.items():
        entry = merged.setdefault(str(num), {})
        entry.update(o)
        for k in [k for k, v in entry.items() if v is None]:
            del entry[k]
    raw["outputs"] = dict(sorted(merged.items(), key=lambda kv: int(kv[0])))
    write_config(path, raw)
