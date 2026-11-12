"""DomePlayer: play a Domemaster fisheye video, looped, on one monitor or stacked on many.

Pipeline:

    file --(NVDEC, CUDA->GL interop)--> mpv render API --> video texture (FBO, native 3840x3840)
         --> our GLSL shader, once per output (4-corner warp, brightness, test grid)
         --> one window back buffer --> swap (vsync)

Stacked projection (stack.enabled): every projector shows the same full image on the same dome
area. All outputs live in ONE borderless window that spans those monitors, so every projector
gets the same video frame in the same swap; no network sync between processes is needed.
Each output has its own 4-corner warp + brightness so the stacked images can be lined up.

Dome projection (calibration.mode "dome"): the projectors point at different parts of the dome
and overlap. Camera calibration gives every output a mesh straight into the video and a
brightness map that blends the overlaps; the dome circle (marked in the camera picture) is
the edge of the video, everything outside it stays black.
"""
from __future__ import annotations

import logging
import math
import os
import struct
import sys
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

from . import monitors as displays
from . import remote, warp, watchdog
from .config import APP_DIR, ConfigError, load_config, resolve_path, save_outputs, save_setting

log = logging.getLogger("domeplayer")

VIDEO_VERT = """
#version 330
in vec2 in_pos;          // full-viewport quad, -1..1
out vec2 v_ndc;
void main() { v_ndc = in_pos; gl_Position = vec4(in_pos, 0.0, 1.0); }
"""

VIDEO_FRAG = """
#version 330
uniform sampler2D u_video;
uniform bool  u_has_video;
uniform mat3  u_hinv;    // output (0..1, y down) -> image square (0..1, y down)
uniform vec2  u_flip;
uniform float u_rot;     // radians
uniform vec3  u_bg;
uniform float u_gain;    // signal multiplier (brightness)
uniform int   u_mode;    // 0 = video, 1 = test grid, 2 = flat white (uniformity check)
uniform vec3  u_tint;    // test grid colour of this output
uniform float u_sweep;   // 0..1, advances every display refresh (sync check)
// camera calibration
uniform bool      u_use_mesh;    // output pixel -> reference output position (stacking)
uniform sampler2D u_mesh;
uniform vec2      u_mesh_size;
uniform bool      u_use_gainmap; // per-pixel brightness (signal multiplier)
uniform sampler2D u_gainmap;
uniform int   u_pattern;         // 0 = none, 1 = white, 2 = Gray-code stripes, 3 = black
uniform int   u_axis;
uniform int   u_bit;
uniform bool  u_inv;
uniform vec2  u_size;            // output size in pixels
uniform bool  u_mask_on;         // black outside a circle of the video
uniform vec2  u_mask_c;
uniform float u_mask_r;
uniform float u_mask_feather;
in vec2 v_ndc;
out vec4 f_color;

float lines(vec2 x) {
    vec2 g = abs(fract(x + 0.5) - 0.5) / max(fwidth(x), vec2(1e-5));
    return 1.0 - clamp(min(g.x, g.y) - 0.5, 0.0, 1.0);
}
float rings(float x) {
    float g = abs(fract(x + 0.5) - 0.5) / max(fwidth(x), 1e-5);
    return 1.0 - clamp(g - 0.75, 0.0, 1.0);
}

void main() {
    vec2 o = vec2(v_ndc.x * 0.5 + 0.5, 0.5 - v_ndc.y * 0.5);
    if (u_pattern != 0) {
        float val = 0.0;
        if (u_pattern == 1) {
            val = 1.0;
        } else if (u_pattern == 2) {
            int c = (u_axis == 0) ? int(floor(o.x * u_size.x)) : int(floor(o.y * u_size.y));
            int g = c ^ (c >> 1);
            val = float((g >> u_bit) & 1);
            if (u_inv) val = 1.0 - val;
        }
        f_color = vec4(vec3(val), 1.0);
        return;
    }
    vec2 base = o;
    if (u_use_mesh) {
        vec2 tc = (o * (u_mesh_size - 1.0) + 0.5) / u_mesh_size;
        vec2 m = texture(u_mesh, tc).rg;
        if (any(lessThan(m, vec2(-0.25))) || any(greaterThan(m, vec2(1.25)))) {
            f_color = vec4(0.0, 0.0, 0.0, 1.0);
            return;
        }
        base = m;
    }
    float gm = u_use_gainmap ? texture(u_gainmap, o).r : 1.0;
    vec3 q = u_hinv * vec3(base, 1.0);
    vec2 s = q.xy / q.z;
    if (q.z <= 0.0 || any(lessThan(s, vec2(0.0))) || any(greaterThan(s, vec2(1.0)))) {
        f_color = vec4(u_bg, 1.0);
        return;
    }
    vec2 p = vec2(s.x * 2.0 - 1.0, 1.0 - s.y * 2.0) * u_flip;   // -1..1, y up
    float c = cos(u_rot), sn = sin(u_rot);
    p = mat2(c, sn, -sn, c) * p;
    vec2 uv = p * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        f_color = vec4(u_bg, 1.0);
        return;
    }
    vec3 col;
    if (u_mode == 1) {
        float r = length(p);
        col = vec3(0.05);
        col = mix(col, u_tint, lines(uv * 16.0));
        col = mix(col, vec3(1.0), rings(r * 4.0) * step(r, 1.01));
        float ang = atan(p.y, p.x) / 6.2831853 + 0.5;
        float d = abs(fract(ang - u_sweep + 0.5) - 0.5) * 6.2831853 * max(r, 0.05);
        col = mix(col, vec3(1.0), (1.0 - smoothstep(0.004, 0.010, d)) * step(r, 1.0));
        if (r > 1.0) col *= 0.35;
    } else if (u_mode == 2) {
        col = vec3(1.0);
    } else if (u_has_video) {
        col = texture(u_video, uv).rgb;
    } else {
        col = u_bg;
    }
    if (u_mask_on && u_mode != 1) {
        float d = length(p - u_mask_c);
        col *= 1.0 - smoothstep(u_mask_r - max(u_mask_feather, 1e-4), u_mask_r, d);
    }
    f_color = vec4(clamp(col * u_gain * gm, 0.0, 1.0), 1.0);
}
"""

# test grid colour per output (by position in stack.monitors)
TINTS = [(1.0, 0.25, 0.25), (0.25, 1.0, 0.25), (0.35, 0.5, 1.0),
         (1.0, 1.0, 0.2), (1.0, 0.3, 1.0), (0.2, 1.0, 1.0), (1.0, 0.6, 0.2), (0.8, 0.8, 0.8)]
CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"]


# --------------------------------------------------------------------------- setup helpers

def setup_logging(level: str) -> Path:
    log_dir = APP_DIR / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / "domeplayer.log"
    handlers: list[logging.Handler] = [
        RotatingFileHandler(log_file, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    ]
    if sys.stdout is not None:  # pythonw.exe has no console
        try:
            sys.stdout.reconfigure(errors="replace")   # Thai text on an old console code page
        except Exception:  # noqa: BLE001
            pass
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )
    return log_file


def import_mpv():
    """Make lib/libmpv-2.dll findable, then import python-mpv."""
    lib_dir = APP_DIR / "lib"
    # CUDA numbers the GPUs in PCI slot order, like nvidia-smi (cuda_device in config)
    os.environ.setdefault("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
    # OpenCV's Media Foundation camera open can take tens of seconds with this left on
    os.environ.setdefault("OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS", "0")
    if os.name == "nt":
        if not any((lib_dir / n).exists() for n in ("libmpv-2.dll", "mpv-2.dll")):
            raise RuntimeError(
                f"libmpv-2.dll not found in {lib_dir}. The lib folder must stay next to "
                "DomePlayer.exe - copy the whole DomePlayer folder again "
                "(source install: run 1-SETUP.bat again)."
            )
        os.environ["PATH"] = str(lib_dir) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(lib_dir))
    import mpv  # noqa: WPS433 (import after PATH change on purpose)
    return mpv


def key_code(glfw, name: str):
    if not name:
        return None
    code = getattr(glfw, "KEY_" + name.strip().upper().replace(" ", "_"), None)
    if code is None:
        log.warning('unknown key name "%s" in config.json (ignored)', name)
    return code


def _marker(color, size=30):
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    dr.ellipse((2, 2, size - 3, size - 3), outline=(0, 0, 0, 255), width=6)
    dr.ellipse((2, 2, size - 3, size - 3), outline=color + (255,), width=3)
    m = size // 2
    dr.line((m, 6, m, size - 7), fill=color + (255,), width=1)
    dr.line((6, m, size - 7, m), fill=color + (255,), width=1)
    return img


# --------------------------------------------------------------------------- the player

class DomePlayer:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.running = True
        self.show_stats = bool(cfg["stats"]["show_on_start"])
        self.messages: list[str] = []          # problems shown on screen
        self.video_size: tuple[int, int] | None = None
        self.loop_count = 0
        self._last_time_pos = None
        self._frame_ready = threading.Event()
        self._frame_ready.set()
        self._mpv_errors: list[str] = []
        self._file_loaded = False
        self._load_time = 0.0
        self._beat_pos = None      # video position at the last 2 s tick
        self._stalled = 0          # 2 s ticks in a row without the video moving
        self._t_run = time.perf_counter()
        self.player = None

        # stacking / alignment state
        st = cfg["stack"]
        self.nums: list[int] = list(st["monitors"]) if st["enabled"] else [cfg["display"]["monitor"]]
        self.corners: dict[int, list] = {}
        self.gain: dict[int, float] = {}
        for k, o in cfg["outputs"].items():
            n = int(k)
            if "corners" in o and warp.is_valid(o["corners"]):
                self.corners[n] = [list(map(float, pt)) for pt in o["corners"]]
            elif "corners" in o:
                log.warning("outputs.%s.corners is not a usable shape, ignored", k)
            if "brightness" in o:
                self.gain[n] = float(o["brightness"])
        self.solo: int | None = None
        self.test = 0          # 0 off, 1 grid, 2 flat white
        self.edit = False
        # camera calibration
        cc = cfg["calibration"]
        self.cal_folder = resolve_path(cc["folder"])
        self.cal_use = bool(cc["use"])
        self.cal = None              # loaded calibration (ref + per-output textures)
        self._cal_data = None        # loaded/solved data waiting for GL textures
        self.cam_index = int(cc["camera"])
        self.cal_mode = cc["mode"]
        self.circle = [float(x) for x in cc["dome_circle"]]   # [cx, cy, r] fractions, r=0: auto
        self.front_deg = float(cc["dome_front_deg"])
        self.circle_dirty = False
        self.camera = None
        self.preview = False
        self.session = None
        self._solve = None           # {"thread", "progress", "result", "error"}
        self._k_armed = 0.0
        self._sim_frame = (None, None)
        self._preview_next = 0.0
        self.sel_corner = 0
        self.dragging = False
        self.dirty: set[int] = set()
        self.toast: tuple[str, float] | None = None
        self.frame_no = 0
        self._rects: dict[int, tuple[int, int, int, int]] = {}
        self.exit_code = 0
        self.ports: dict[int, str] = {}       # monitor number -> graphics-card socket (Windows)
        self._next_health = time.perf_counter() + 20
        self._next_status = 0.0
        self._next_shot = 0.0
        self._cam_note = None                 # camera page facts for the control panel
        self._cal_result = None               # outcome of the last calibration, for the control panel

    # ---- window ----------------------------------------------------------------------
    def create_window(self):
        import glfw
        from .monitors import list_monitors

        d = self.cfg["display"]
        if not glfw.init():
            raise RuntimeError("could not initialise GLFW (graphics driver problem?)")
        self.glfw = glfw

        all_mons = list_monitors()
        for m in all_mons:
            log.info("found %s", m.describe())
        by_num = {m.number: m for m in all_mons}
        primary = next((m for m in all_mons if m.primary), all_mons[0] if all_mons else None)
        if primary is None:
            raise RuntimeError("no monitor found")
        if self.cfg["stack"]["enabled"] and self.cfg["stack"].get("auto") and d["fullscreen"]:
            self.nums = displays.wanted(self.cfg, all_mons)
            log.info("automatic monitor list: every display except the main one = %s", self.nums)
        self.ports = displays.ports()
        if self.ports:
            log.info("graphics-card sockets: %s", self.ports)
        missing = [n for n in self.nums if n not in by_num]

        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
        glfw.window_hint(glfw.OPENGL_FORWARD_COMPAT, True)
        glfw.window_hint(glfw.DOUBLEBUFFER, True)
        glfw.window_hint(glfw.AUTO_ICONIFY, False)        # don't minimise when focus is lost
        glfw.window_hint(glfw.FLOATING, bool(d["always_on_top"] and d["fullscreen"]))

        title = "DomePlayer"
        win = None
        if not d["fullscreen"]:
            # test window: 1 output fills it, several outputs are shown side by side
            ref = by_num.get(self.nums[0], primary)
            glfw.window_hint(glfw.DECORATED, True)
            win = glfw.create_window(d["width"], d["height"], title, None, None)
            if win:
                glfw.set_window_pos(win, ref.x + 40, ref.y + 40)
            self.layout = "full" if len(self.nums) == 1 else "tile"
        else:
            if missing:
                msg = (f"monitor {', '.join(map(str, missing))} not found (not connected or "
                       "different number). Run IDENTIFY-MONITORS / 'show monitor numbers'.")
                log.warning(msg)
                self.messages.append(msg)
                self.nums = [n for n in self.nums if n in by_num]
            if not self.nums:
                self.nums = [primary.number]
            present = [by_num[n] for n in self.nums]
            ref = present[0]
            if len(present) == 1 and d["mode"] == "exclusive":
                if d["refresh_rate"]:
                    glfw.window_hint(glfw.REFRESH_RATE, d["refresh_rate"])
                win = glfw.create_window(d["width"], d["height"], title, ref.handle, None)
                self.layout = "full"
            else:  # one borderless window exactly covering all the chosen monitors
                x0 = min(m.x for m in present)
                y0 = min(m.y for m in present)
                x1 = max(m.x + m.width for m in present)
                y1 = max(m.y + m.height for m in present)
                glfw.window_hint(glfw.DECORATED, False)
                glfw.window_hint(glfw.VISIBLE, False)
                win = glfw.create_window(x1 - x0, y1 - y0, title, None, None)
                if win:
                    glfw.set_window_pos(win, x0, y0)
                    glfw.set_window_size(win, x1 - x0, y1 - y0)
                    between = [m.number for m in all_mons if m.number not in self.nums
                               and m.x < x1 and m.x + m.width > x0 and m.y < y1 and m.y + m.height > y0]
                    if between:      # e.g. the operator's screen sits between the projectors
                        free = _window_keep_only(glfw, win, [(m.x - x0, m.y - y0, m.width, m.height)
                                                             for m in present])
                        log.info("monitor %s lies inside the show window: %s", between,
                                 "left free" if free else "could not be left free, it is covered")
                    glfw.show_window(win)
                self.layout = "fixed"
                self.fixed_rects = {m.number: (m.x - x0, m.y - y0, m.width, m.height) for m in present}
                self.window_size = (x1 - x0, y1 - y0)
        if not win:
            raise RuntimeError("could not create an OpenGL 3.3 window (is the NVIDIA driver installed?)")
        self.window = win
        self.monitor = ref
        glfw.make_context_current(win)
        self.vsync = bool(d["vsync"])
        glfw.swap_interval(1 if self.vsync else 0)
        self.hide_cursor = bool(d["hide_cursor"] and d["fullscreen"])
        if self.hide_cursor:
            glfw.set_input_mode(win, glfw.CURSOR, glfw.CURSOR_HIDDEN)
        glfw.set_key_callback(win, self._on_key)
        glfw.set_mouse_button_callback(win, self._on_mouse_button)
        glfw.set_cursor_pos_callback(win, self._on_cursor)
        glfw.focus_window(win)

        mode = glfw.get_video_mode(ref.handle)
        self.refresh_hz = float(mode.refresh_rate or 60)
        rates = {by_num[n].refresh for n in self.nums if n in by_num}
        if len(rates) > 1:
            msg = f"monitors run at different refresh rates {sorted(rates)} Hz - set them all the same"
            log.warning(msg)
            self.messages.append(msg)
        log.info("outputs %s (layout %s), reference monitor %d %dx%d @ %.0f Hz, vsync=%s",
                 self.nums, self.layout, ref.number, mode.size.width, mode.size.height,
                 self.refresh_hz, self.vsync)

        k = self.cfg["keys"]
        self.keys = {
            "quit": key_code(glfw, k["quit"]),
            "pause": key_code(glfw, k["pause"]),
            "restart": key_code(glfw, k["restart"]),
            "stats": key_code(glfw, self.cfg["stats"]["key"]),
        }

    def output_rects(self, fw: int, fh: int) -> list[tuple[int, int, int, int, int]]:
        """(monitor number, x, y, w, h) in framebuffer pixels, top-left origin."""
        if self.layout == "full":
            return [(self.nums[0], 0, 0, fw, fh)]
        if self.layout == "tile":
            if self.solo is not None:   # test window: one output at a time fills it
                return [(self.solo, 0, 0, fw, fh)]
            return [(n, *r) for n, r in zip(self.nums, warp.tile_rects(len(self.nums), fw, fh))]
        ww, wh = self.window_size
        sx, sy = fw / ww, fh / wh
        return [(n, round(x * sx), round(y * sy), round(w * sx), round(h * sy))
                for n, (x, y, w, h) in self.fixed_rects.items()]

    # ---- input -----------------------------------------------------------------------
    def say(self, text: str, seconds: float = 3.0) -> None:
        self.toast = (text, time.perf_counter() + seconds)
        log.info("%s", text.replace("\n", " "))

    def edit_target(self) -> int | None:
        if self.solo is not None:
            return self.solo
        return self.nums[0] if len(self.nums) == 1 else None

    def corners_for(self, num: int, w: int, h: int) -> list:
        if num in self.corners:
            return self.corners[num]
        p = self.cfg["preview"]
        aspect = (self.video_size[0] / self.video_size[1]) if self.video_size else 1.0
        return warp.default_corners(w, h, aspect, p["fit"], float(p["zoom"]))

    def _set_corner(self, num: int, idx: int, x: float, y: float) -> None:
        r = self._rects.get(num)
        if r is None:
            return
        cur = [list(pt) for pt in self.corners_for(num, r[2], r[3])]
        cur[idx] = [min(max(x, -1.0), 2.0), min(max(y, -1.0), 2.0)]
        if warp.is_valid(cur):
            self.corners[num] = cur
            self.dirty.add(num)

    def save_alignment(self) -> None:
        nums = sorted(self.dirty)
        if not nums:
            self.say("nothing changed")
            return
        data = {}
        for n in nums:
            o = {"brightness": round(self.gain.get(n, 1.0), 3)}
            if n in self.corners:
                o["corners"] = [[round(x, 5), round(y, 5)] for x, y in self.corners[n]]
            data[str(n)] = o
        try:
            save_outputs(self.cfg["_config_path"], data)
        except (OSError, ValueError) as e:
            self.say(f"could not save config.json: {e}", 6)
            return
        self.dirty.clear()
        self.say(f"saved alignment of monitor {', '.join(map(str, nums))} to config.json")

    def _on_key(self, _win, key, _scancode, action, mods):
        try:
            self._handle_key(key, action, mods)
        except Exception as e:  # noqa: BLE001 - a key press must never end the show
            log.exception("key %s failed", key)
            self.say(f"that key did not work: {e}", 6)

    def _handle_key(self, key, action, mods):
        g = self.glfw
        if action not in (g.PRESS, g.REPEAT):
            return
        repeatable = key in (g.KEY_LEFT, g.KEY_RIGHT, g.KEY_UP, g.KEY_DOWN, g.KEY_EQUAL, g.KEY_MINUS,
                             g.KEY_KP_ADD, g.KEY_KP_SUBTRACT, g.KEY_COMMA, g.KEY_PERIOD)
        if action == g.REPEAT and not repeatable:
            return
        ctrl = bool(mods & g.MOD_CONTROL)
        shift = bool(mods & g.MOD_SHIFT)

        if self.session is not None:          # capturing: only Esc (cancel) works
            if key == g.KEY_ESCAPE:
                self.session = None
                self.say("calibration cancelled - nothing was changed", 5)
            return
        if self._solve is not None:
            return
        if key == g.KEY_C:
            self.toggle_preview()
            return
        if self.preview and key in (g.KEY_LEFT_BRACKET, g.KEY_RIGHT_BRACKET):
            self.cam_index = max(0, self.cam_index + (1 if key == g.KEY_RIGHT_BRACKET else -1))
            self.close_camera()
            self.open_camera()
            return
        if self.preview and self.cal_mode == "dome" and self._circle_key(key, shift, ctrl):
            return
        if key == g.KEY_K:
            self.start_calibration()
            return
        if key == g.KEY_U:
            if self.cal is None:
                self.say("no calibration yet - C = check camera, then K K = calibrate")
            else:
                self.cal_use = not self.cal_use
                self.say("calibration ON" if self.cal_use else "calibration OFF (as before calibrating)")
            return
        if ctrl and key == g.KEY_S:
            self.save_alignment()
            return
        digit = None
        if g.KEY_0 <= key <= g.KEY_9:
            digit = key - g.KEY_0
        elif g.KEY_KP_0 <= key <= g.KEY_KP_9:
            digit = key - g.KEY_KP_0
        if digit is not None:
            if digit == 0:
                self.solo = None
                if self.edit and len(self.nums) > 1:
                    self.edit = False
                self.say("showing all outputs")
            elif digit in self.nums:
                self.solo = digit
                self.say(f"showing only monitor {digit}" + ("  (E = align it)" if not self.edit else ""))
            else:
                self.say(f"monitor {digit} is not one of the outputs {self.nums}")
            self._update_cursor()
            return
        if key == g.KEY_T:
            self.test = (self.test + 1) % 3
            self.say(["test pattern off", "test grid", "flat white (check brightness evenness)"][self.test], 2)
            return
        if key == g.KEY_E or (self.edit and key == g.KEY_ESCAPE):
            self.toggle_edit()
            return
        if self.edit:
            self._edit_key(key, shift)
            return
        if key == self.keys["stats"]:
            self.show_stats = not self.show_stats
            try:    # remembered, so a power-on / automatic restart does not bring the page back
                save_setting(self.cfg["_config_path"], "stats", "show_on_start", self.show_stats)
            except Exception:  # noqa: BLE001
                pass
        elif key == self.keys["quit"]:
            self.running = False
        elif key == self.keys["pause"] and self.player is not None:
            self.player.pause = not self.player.pause
        elif key == self.keys["restart"] and self.player is not None:
            if not self.prop("idle-active"):      # seek raises when nothing is loaded
                self.player.seek(0, "absolute", "exact")
                self.stats.reset()

    def _circle_key(self, key, shift, ctrl) -> bool:
        """Dome circle editing while the camera preview is open. True if the key was used."""
        g = self.glfw
        cam = self.camera.size if self.camera is not None else (1920, 1080)
        if ctrl and key == g.KEY_S:
            self.save_circle()
            return True
        if key == g.KEY_A:
            self.circle = [0.0, 0.0, 0.0]
            self.circle_dirty = True
            self.say("dome circle: automatic (found from the projected light)\nCtrl+S = save and recalculate", 5)
            return True
        moves = {g.KEY_LEFT: (-1, 0), g.KEY_RIGHT: (1, 0), g.KEY_UP: (0, -1), g.KEY_DOWN: (0, 1)}
        step = 10 if shift else 1
        if key not in moves and key not in (g.KEY_EQUAL, g.KEY_KP_ADD, g.KEY_MINUS, g.KEY_KP_SUBTRACT,
                                            g.KEY_COMMA, g.KEY_PERIOD):
            return False
        if self.circle[2] <= 0:      # start from the automatic circle (or the picture centre)
            auto = getattr(self, "auto_circle", None)
            self.circle = list(auto) if auto else [0.5, 0.5, 0.45]
        cx, cy, r = self.circle
        if key in moves:
            dx, dy = moves[key]
            cx += dx * step / cam[0]
            cy += dy * step / cam[1]
        elif key in (g.KEY_EQUAL, g.KEY_KP_ADD):
            r += step / cam[1]
        elif key in (g.KEY_MINUS, g.KEY_KP_SUBTRACT):
            r = max(0.02, r - step / cam[1])
        else:
            self.front_deg = (self.front_deg + (step if key == g.KEY_PERIOD else -step)) % 360
        self.circle = [round(cx, 5), round(cy, 5), round(r, 5)]
        self.circle_dirty = True
        self._preview_next = 0.0
        return True

    def save_circle(self) -> None:
        try:
            save_setting(self.cfg["_config_path"], "calibration", "dome_circle", self.circle)
            save_setting(self.cfg["_config_path"], "calibration", "dome_front_deg", round(self.front_deg, 2))
        except (OSError, ValueError) as e:
            self.say(f"could not save config.json: {e}", 6)
            return
        self.circle_dirty = False
        from .calib import solve
        busy(120)
        try:
            data = solve.load_capture(self.cal_folder)
        except Exception as e:  # noqa: BLE001 - damaged camera pictures must not end the player
            log.exception("could not read the saved camera pictures")
            self.say(f"dome circle saved, but the camera pictures could not be read ({e}).\n"
                     "K K = calibrate again", 8)
            return
        if data is None:
            self.say("dome circle saved. Now K K = calibrate", 5)
            return
        self.say("dome circle saved - recalculating from the last camera pictures ...", 5)
        self._start_solve(self._capture_for_today(data))

    def toggle_edit(self) -> None:
        if self.edit:
            self.edit = False
            self.dragging = False
            if self.dirty:
                self.say("alignment NOT saved yet - press Ctrl+S", 5)
        else:
            if self.edit_target() is None:
                self.say("first press a monitor number (1-9) to show one output, then E", 5)
                return
            if self._calibrated(self.edit_target()) and self.cal["ref"] is None:
                self.say("this monitor follows the camera calibration (dome). Press U to turn "
                         "calibration off, or C to change the dome circle.", 6)
                return
            if self._calibrated(self.edit_target()) and self.edit_target() != self.cal["ref"]:
                self.say(f"monitor {self.edit_target()} follows the camera calibration. "
                         f"Align the reference (monitor {self.cal['ref']}) to move everything, "
                         "or press U to turn calibration off.", 6)
                return
            self.edit = True
            self.test = 1
            self.sel_corner = 0
        self._update_cursor()

    def _edit_key(self, key, shift) -> None:
        g = self.glfw
        num = self.edit_target()
        r = self._rects.get(num)
        if num is None or r is None:
            return
        if key == g.KEY_TAB:
            self.sel_corner = (self.sel_corner + (3 if shift else 1)) % 4
        elif key in (g.KEY_LEFT, g.KEY_RIGHT, g.KEY_UP, g.KEY_DOWN):
            step = 10 if shift else 1
            dx = {g.KEY_LEFT: -step, g.KEY_RIGHT: step}.get(key, 0) / r[2]
            dy = {g.KEY_UP: -step, g.KEY_DOWN: step}.get(key, 0) / r[3]
            x, y = self.corners_for(num, r[2], r[3])[self.sel_corner]
            self._set_corner(num, self.sel_corner, x + dx, y + dy)
        elif key in (g.KEY_EQUAL, g.KEY_KP_ADD, g.KEY_MINUS, g.KEY_KP_SUBTRACT):
            up = key in (g.KEY_EQUAL, g.KEY_KP_ADD)
            self.gain[num] = round(min(2.0, max(0.0, self.gain.get(num, 1.0) + (0.02 if up else -0.02))), 3)
            self.dirty.add(num)
        elif key == g.KEY_R:
            self.corners.pop(num, None)
            self.gain[num] = 1.0
            self.dirty.add(num)
            self.say(f"monitor {num}: alignment reset (Ctrl+S to keep)")

    def _cursor_fb(self):
        g = self.glfw
        cx, cy = g.get_cursor_pos(self.window)
        ww, wh = g.get_window_size(self.window)
        fw, fh = g.get_framebuffer_size(self.window)
        return cx * fw / max(ww, 1), cy * fh / max(wh, 1)

    def _on_mouse_button(self, _win, button, action, _mods):
        g = self.glfw
        if not self.edit or button != g.MOUSE_BUTTON_LEFT:
            return
        if action == g.RELEASE:
            self.dragging = False
            return
        num = self.edit_target()
        r = self._rects.get(num)
        if r is None:
            return
        cx, cy = self._cursor_fb()
        pts = self.corners_for(num, r[2], r[3])
        dist = [math.hypot(r[0] + x * r[2] - cx, r[1] + y * r[3] - cy) for x, y in pts]
        self.sel_corner = dist.index(min(dist))
        self.dragging = True
        self._on_cursor(None, 0, 0)

    def _on_cursor(self, _win, _x, _y):
        if not (self.edit and self.dragging):
            return
        num = self.edit_target()
        r = self._rects.get(num)
        if r is None:
            return
        cx, cy = self._cursor_fb()
        self._set_corner(num, self.sel_corner, (cx - r[0]) / r[2], (cy - r[1]) / r[3])

    def _update_cursor(self):
        g = self.glfw
        hidden = self.hide_cursor and not self.edit
        g.set_input_mode(self.window, g.CURSOR, g.CURSOR_HIDDEN if hidden else g.CURSOR_NORMAL)

    # ---- camera calibration -------------------------------------------------------------
    def _calibrated(self, num) -> bool:
        return bool(self.cal_use and self.cal is not None and num in self.cal["tex"])

    def open_camera(self) -> bool:
        if self.camera is not None:
            stale = getattr(self.camera, "stale", None)
            if stale is None or not stale():
                return True
            log.warning("camera %d stopped sending pictures - opening it again", self.cam_index)
            self.close_camera()
        busy(180)       # opening a USB camera can take long: the watchdog must not take it for a freeze
        cc = dict(self.cfg["calibration"], camera=self.cam_index)
        try:
            from .calib.camera import open_camera
            self.camera = open_camera(cc, self.nums)
        except Exception as e:  # noqa: BLE001
            log.exception("camera open failed")
            self.say(f"camera {self.cam_index} could not be opened: {e}\n"
                     "R50: Set-up > Choose USB connection app > Video calls/streaming", 7)
            return False
        if getattr(self.camera, "source", "x") is None:      # simulated camera
            self.camera.source = lambda: self._sim_frame
        return True

    def close_camera(self) -> None:
        if self.camera is not None:
            busy(30)
            try:
                self.camera.close()
            except Exception:
                pass
            self.camera = None

    def toggle_preview(self) -> None:
        if self.preview:
            self.preview = False
            self.close_camera()
            return
        if self.open_camera():
            self.preview = True

    def start_calibration(self) -> None:
        now = time.perf_counter()
        if now > self._k_armed:
            self._k_armed = now + 4.0
            self.say("press K again to start camera calibration\n"
                     f"(about {int(len(self.nums) * 22 + 17)} s, room dark, camera must not move)", 4)
            return
        self._k_armed = 0.0
        if getattr(self.camera, "index", 0) == -2:      # the still picture of a video calibration
            self.close_camera()
        if not self.open_camera():
            return
        self.preview = False
        self.edit = False
        self.solo = None
        self.test = 0
        sizes = {n: (r[2], r[3]) for n, r in self._rects.items()}
        if any(n not in sizes for n in self.nums):
            self.say("outputs are not ready yet, try again", 4)
            return
        cc = self.cfg["calibration"]
        from .calib.session import CalibrationSession
        self.session = CalibrationSession(self.nums, sizes, self.camera, cc["settle_ms"] / 1000.0,
                                          int(cc["average"]), int(cc["skip_bits"]),
                                          measure_delay=bool(cc.get("measure_delay", True)))
        try:
            save_setting(self.cfg["_config_path"], "calibration", "camera", self.cam_index)
        except (OSError, ValueError):
            pass
        log.info("calibration started: %d patterns, outputs %s sizes %s",
                 len(self.session.steps), self.nums, sizes)

    # ---- calibration with a camera that records a video (360 camera, phone) ----------------
    def start_show(self) -> None:
        """Show every pattern on a timetable while the camera records."""
        if self.session is not None or self._solve is not None:
            return
        sizes = {n: (r[2], r[3]) for n, r in self._rects.items()}
        if any(n not in sizes for n in self.nums):
            self.say("outputs are not ready yet, try again", 4)
            return
        cc = self.cfg["calibration"]
        from .calib.session import PatternShow
        self.close_camera()
        self.preview = False
        self.edit = False
        self.solo = None
        self.test = 0
        self.session = PatternShow(self.nums, sizes, int(cc["skip_bits"]), float(cc["show_hold_ms"]) / 1000.0)
        log.info("pattern show for a recording camera started: %d patterns, %.0f s, outputs %s",
                 len(self.session.inner.steps), self.session.total, self.nums)

    def _after_show(self, show) -> None:
        import json
        rec = show.record()
        rec["ports"] = {str(n): self.ports[n] for n in self.nums if n in self.ports}
        try:
            self.cal_folder.mkdir(parents=True, exist_ok=True)
            (self.cal_folder / "show.json").write_text(json.dumps(rec), encoding="utf-8")
        except OSError as e:
            self.say(f"could not save the pattern times: {e}", 20)
            self._cal_result = {"ok": False, "text": f"could not save the pattern times: {e}", "at": time.time()}
            return
        self._show_done = time.time()
        self.say("patterns finished. Stop the recording, copy the video file to this PC,\n"
                 "then choose it in the control panel (calibrate from video file)", 30)

    def start_video_calibration(self, path: str) -> None:
        """Read the recording of the last pattern show and calibrate from it."""
        import json
        if self.session is not None or self._solve is not None:
            self.say("busy - wait until the current step is finished", 4)
            return
        try:
            show = json.loads((self.cal_folder / "show.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.say("no pattern show was run yet: first show the patterns while the camera records", 10)
            self._cal_result = {"ok": False, "text": "no pattern show was run yet", "at": time.time()}
            return
        move = displays.remap_by_port(show.get("ports") or {}, self.ports)
        max_px = int(self.cfg["calibration"]["video_max_px"])

        def read(progress):
            from .calib import video
            data = video.decode_best(path, show, max_px=max_px, progress=progress, work_dir=VIDEO_TMP)
            if move:      # Windows renumbered the displays between the show and now
                data["projectors"] = {move.get(n, n): v for n, v in data["projectors"].items()
                                      if move.get(n, n) is not None}
                data["skipped"] = [move.get(n, n) for n in data["skipped"] if move.get(n, n) is not None]
            data["ports"] = {str(n): self.ports[n] for n in data["projectors"] if n in self.ports}
            return data

        # every recording is cut to its own lit area, so a dome circle saved on another picture does
        # not fit: find it again (the operator then adjusts it on the still picture). The cut picture
        # has no known lens centre either, so only the fisheye way of reading it applies.
        try:
            self.circle = [0.0, 0.0, 0.0]
            self.circle_dirty = False
            save_setting(self.cfg["_config_path"], "calibration", "dome_circle", self.circle)
            if float(self.cfg["calibration"]["lens_mm"]) > 0:
                self.cfg["calibration"]["lens_mm"] = 0.0
                save_setting(self.cfg["_config_path"], "calibration", "lens_mm", 0.0)
        except (OSError, ValueError):
            pass

        log.info("calibration from video file %s", path)
        self.say("reading the video ... (this can take several minutes)", 8)
        self._start_solve(None, save_raw=True, source=read)

    def show_still(self) -> None:
        """The dome as the last video saw it, to set the dome circle on."""
        pic = self.cal_folder / "camera_white_all.jpg"
        if not pic.exists():
            self.say("no camera picture yet - calibrate first", 5)
            return
        self.close_camera()
        try:
            from .calib.camera import StillCamera
            self.camera = StillCamera(pic)
        except Exception as e:  # noqa: BLE001
            self.say(f"could not open the saved camera picture: {e}", 6)
            return
        self.preview = True

    def set_lens(self, mm: float) -> None:
        """0 = fisheye / 360 camera, otherwise the focal length of a normal lens. Recalculates."""
        self.cfg["calibration"]["lens_mm"] = float(mm)
        try:
            save_setting(self.cfg["_config_path"], "calibration", "lens_mm", float(mm))
        except (OSError, ValueError) as e:
            self.say(f"could not save config.json: {e}", 6)
            return
        if self.session is not None or self._solve is not None:
            return
        from .calib import solve
        busy(120)
        try:
            data = solve.load_capture(self.cal_folder)
        except Exception:  # noqa: BLE001
            data = None
        if data is not None:
            self.say("camera lens type changed - recalculating from the last camera pictures ...", 5)
            self._start_solve(self._capture_for_today(data))

    def _after_capture(self) -> None:
        ses, self.session = self.session, None
        if hasattr(ses, "record"):          # a pattern show: nothing was read, only shown
            self._after_show(ses)
            return
        if ses.error:
            self.say(f"calibration stopped: {ses.error}\nnothing was changed  (also in logs/domeplayer.log)", 60)
            self._cal_result = {"ok": False, "text": ses.error, "at": time.time()}
            return
        data = ses.result()
        data["ports"] = {str(n): self.ports[n] for n in data["projectors"] if n in self.ports}
        self._start_solve(data, save_raw=True)

    def _capture_for_today(self, data: dict) -> dict:
        """A saved capture is filed under the display numbers of its day. Windows may have
        renumbered the displays since: move every projector to the number its socket has today."""
        move = displays.remap_by_port(data.get("ports") or {}, self.ports)
        if move:
            data["projectors"] = {move.get(n, n): v for n, v in data["projectors"].items()
                                  if move.get(n, n) is not None}
            data["skipped"] = [move.get(n, n) for n in data.get("skipped") or [] if move.get(n, n) is not None]
            log.warning("the saved camera pictures were taken under other display numbers (%s) - followed the sockets",
                        ", ".join(f"{k} is now {v}" for k, v in move.items() if v is not None and k != v))
        data["ports"] = {str(n): self.ports[n] for n in data["projectors"] if n in self.ports}
        return data

    def _start_solve(self, data: dict | None, save_raw: bool = False, source=None) -> None:
        """source(progress) -> data: a slow way to get the data (reading a video), done in the
        same background thread before the calculation."""
        ref = self.nums[0]
        cc = self.cfg["calibration"]
        dome = None
        if self.cal_mode == "dome":
            dome = {"circle": list(self.circle), "front_deg": self.front_deg,
                    "lens_mm": cc["lens_mm"], "sensor_width_mm": cc["sensor_width_mm"]}
        job = {"progress": 0.0, "result": None, "error": None, "reading": source is not None,
               "old_circle": bool(save_raw and dome is not None and self.circle[2] > 0)}

        def work():
            nonlocal data
            try:
                from .calib import solve
                from . import backup
                if source is not None:
                    data = source(lambda p: job.__setitem__("progress", 0.8 * p))
                    job["reading"] = False
                try:
                    backup.backup(self.cal_folder, Path(self.cfg["_config_path"]),
                                  "before new calibration" if save_raw else "before dome circle change")
                except Exception:  # noqa: BLE001 - a failed backup must not stop calibrating
                    log.exception("calibration backup failed")
                if save_raw:
                    try:
                        solve.save_capture(data, self.cal_folder)
                    except Exception:  # noqa: BLE001 - only needed to change the circle later
                        log.exception("could not keep the camera pictures")
                part = 0.8 if source is not None else 0.0
                res = solve.solve(data, ref, dome=dome,
                                  progress=lambda p: job.__setitem__("progress", part + (1 - part) * p))
                seen = max((float(o["coverage"]) for o in res["outputs"].values()), default=0.0)
                even = res["stats"].get("uniformity_after")
                if not seen > 0.02 or even is None or even != even:       # (NaN != NaN)
                    raise RuntimeError("no projector picture could be read from the camera pictures - "
                                       "nothing was saved")
                solve.save(res, self.cal_folder, {
                    "monitors": self.nums, "camera": self.cam_index,
                    "skipped": list(data.get("skipped") or []), "video": data.get("video"),
                    "crop": data.get("crop"), "lens_mm": cc["lens_mm"],
                    "ports": {str(n): self.ports[n] for n in self.nums if n in self.ports}})
                job["result"] = solve.load(self.cal_folder)
            except Exception as e:  # noqa: BLE001
                log.exception("calibration solve failed")
                job["error"] = str(e) or type(e).__name__

        job["thread"] = threading.Thread(target=work, name="calib-solve", daemon=True)
        job["thread"].start()
        self._solve = job

    def _check_solve(self) -> None:
        job = self._solve
        if job is None or job["thread"].is_alive():
            return
        self._solve = None
        if job["error"]:
            self.say(f"calibration failed: {job['error']}\nnothing was changed  (also in logs/domeplayer.log)", 60)
            self._cal_result = {"ok": False, "text": job["error"], "at": time.time()}
            return
        self._cal_data = job["result"]
        self.cal_use = True
        self.test = 1
        info = job["result"]["info"]
        st = info["stats"]
        self.messages = [m for m in self.messages if not m.startswith("The saved calibration")]
        warn = []
        c = info.get("circle")
        cw, ch = info.get("camera_size") or (0, 0)
        if c and ch and (c[1] - c[2] < 0.01 or c[1] + c[2] > 0.99
                         or c[0] * cw - c[2] * ch < 0.01 * ch or c[0] * cw + c[2] * ch > cw - 0.01 * ch):
            warn.append("the dome circle reaches the edge of the camera picture")
        low = [f"{n} ({o['coverage'] * 100:.0f}%)" for n, o in info["outputs"].items()
               if o.get("coverage", 1) < 0.9]
        if low:
            warn.append("the camera saw only part of monitor " + ", ".join(low))
        skipped = info.get("skipped") or []
        if skipped:
            warn.append("the camera did NOT see monitor " + ", ".join(map(str, skipped)) + " at all, it stays black "
                        "(fine if that display is not a dome projector; otherwise switch it on and calibrate again)")
        tail = ("\nCHECK: " + "; ".join(warn) + ".\nWhat the camera cannot see stays BLACK. Press C: the whole "
                "dome edge must be inside the camera picture") if warn else ""
        if job.get("old_circle"):
            tail += "\nThe dome circle is the saved one - if the camera was moved, press C and check it (A = automatic)"
        self.say("calibration done and saved.\n"
                 f"brightness evenness: {st['uniformity_before']*100:.0f}% -> {st['uniformity_after']*100:.0f}% "
                 f"variation, keeps {st['brightness_kept']*100:.0f}% of the light\n"
                 "T = grid / white / video   U = compare with calibration off" + tail, 40 if tail else 12)
        self._cal_result = {"ok": True, "at": time.time(), "warnings": warn, "skipped": skipped,
                            "before": round(st["uniformity_before"] * 100), "after": round(st["uniformity_after"] * 100),
                            "outputs": sorted(int(n) for n in info["outputs"])}

    def _build_cal_textures(self, rects: dict) -> None:
        """Upload loaded calibration as GL textures (main thread, needs output sizes)."""
        import numpy as np
        data, self._cal_data = self._cal_data, None
        if data is None:
            return
        self._follow_sockets(data)
        mgl = self.mgl
        if self.cal is not None:
            for t in self.cal["tex"].values():
                for x in t.values():
                    if hasattr(x, "release"):
                        x.release()
        tex = {}
        for n, o in data["outputs"].items():
            if n not in rects:
                continue
            if tuple(o["size"]) != (rects[n][2], rects[n][3]):
                msg = (f"calibration of monitor {n} was made at {o['size'][0]}x{o['size'][1]}, "
                       f"now {rects[n][2]}x{rects[n][3]} - calibrate again (K K)")
                log.warning(msg)
                self.messages.append(msg)
                continue
            t = {}
            g = np.ascontiguousarray(o["gain"], np.float32)
            t["gain"] = self.ctx.texture((g.shape[1], g.shape[0]), 1, g.tobytes(), dtype="f4")
            if o["mesh"] is not None:
                m = np.nan_to_num(o["mesh"], nan=-10.0).astype(np.float32)
                t["mesh"] = self.ctx.texture((m.shape[1], m.shape[0]), 2, np.ascontiguousarray(m).tobytes(), dtype="f4")
                t["mesh_size"] = (float(m.shape[1]), float(m.shape[0]))
            for x in t.values():
                if hasattr(x, "filter"):
                    x.filter = (mgl.LINEAR, mgl.LINEAR)
                    x.repeat_x = x.repeat_y = False
            tex[n] = t
        if data["ref"] is not None and data["ref"] not in tex:
            log.warning("calibration reference monitor %s is not available, calibration not used", data["ref"])
            self.cal = None
            return
        info = data.get("info", {})
        self.cal = {"ref": data["ref"], "tex": tex, "info": info, "mode": data.get("mode", "stack")}
        if self.cal["mode"] == "dome" and self.circle[2] <= 0 and info.get("circle"):
            self.auto_circle = list(info["circle"])
        log.info("calibration (%s) loaded for monitors %s (reference %s)", self.cal["mode"],
                 sorted(tex), data["ref"])

    def _follow_sockets(self, data: dict) -> None:
        """Windows may number the displays differently than on the day of the calibration (a
        projector switched on late, a cable re-plugged). The graphics-card socket of every
        output was saved with it: give each warp to the display on that socket today."""
        saved = (data.get("info") or {}).get("ports") or {}
        move = displays.remap_by_port(saved, self.ports)
        if not move:
            return
        if all(v is None for v in move.values()):
            msg = ("none of the graphics-card sockets of the calibration is in use now (cables moved or driver "
                   "changed?) - using the display numbers. If the picture is mixed up, calibrate again")
            log.warning(msg)
            self.messages.append(msg)
            return
        outs = {}
        for n, o in data["outputs"].items():
            target = move.get(n, n)
            if target is None:
                log.warning("calibration of monitor %s: nothing is connected to its socket now", n)
                continue
            if n not in move and target in move.values():
                continue        # no socket known for it and its number now belongs to another one
            outs[target] = o
        changed = {k: v for k, v in move.items() if v is not None and k != v}
        if changed:
            log.warning("Windows numbers the displays differently than at calibration (%s): "
                        "the calibration follows the sockets", ", ".join(f"{k} is now {v}" for k, v in changed.items()))
        data["outputs"] = outs
        if data.get("ref") is not None:
            data["ref"] = move.get(data["ref"], data["ref"])

    def load_saved_calibration(self) -> None:
        try:
            from .calib import solve
            self._cal_data = solve.load(self.cal_folder)
        except Exception as e:  # noqa: BLE001
            log.warning("could not load calibration from %s: %s", self.cal_folder, e)
            self._cal_data = None
            self.messages.append("The saved calibration could not be read - the picture is NOT fitted to the dome.\n"
                                 "Close DomePlayer and use the calibration roll-back button, or calibrate again (K K).")

    def _grab_outputs(self, fw: int, fh: int) -> None:
        """Simulated camera only: hand it what every output shows right now."""
        import numpy as np
        raw = self.ctx.screen.read(viewport=(0, 0, fw, fh), components=3)
        img = np.frombuffer(raw, np.uint8).reshape(fh, fw, 3)[::-1]
        self._sim_frame = (time.perf_counter(),
                           {n: img[y:y + h, x:x + w] for n, (x, y, w, h) in self._rects.items()})

    def draw_preview(self, w: int, h: int, now: float) -> None:
        if now >= self._preview_next:
            self._preview_next = now + 0.1
            frame = self.camera.latest() if self.camera else None
            if frame is not None and getattr(self.camera, "stale", lambda: False)():
                frame = None          # camera went off: do not show an old picture as if it were live
            if frame is None:
                self.preview_info.set_text(f"camera {self.cam_index}: waiting for picture...", color=(255, 200, 80))
                return
            import numpy as np
            from PIL import Image
            gray = frame.mean(axis=2) if frame.ndim == 3 else frame
            over = float(np.mean(gray >= 250)) * 100
            img = Image.fromarray(np.ascontiguousarray(frame[..., ::-1]) if frame.ndim == 3 else frame).convert("RGB")
            scale = min(w * 0.6 / img.width, h * 0.6 / img.height)
            fh_, fw_ = frame.shape[:2]
            small = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
            circ = self.circle if self.circle[2] > 0 else getattr(self, "auto_circle", None)
            if self.cal_mode == "dome" and circ:
                from PIL import ImageDraw
                dr = ImageDraw.Draw(small)
                cx, cy, r = circ[0] * small.width, circ[1] * small.height, circ[2] * small.height
                col = (255, 220, 0) if self.circle[2] > 0 else (120, 200, 255)
                dr.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(0, 0, 0), width=4)
                dr.ellipse((cx - r, cy - r, cx + r, cy + r), outline=col, width=2)
                dr.line((cx - 8, cy, cx + 8, cy), fill=col, width=1)
                dr.line((cx, cy - 8, cx, cy + 8), fill=col, width=1)
                a = math.radians(self.front_deg)
                fx, fy = cx + r * math.cos(a), cy + r * math.sin(a)
                dr.line((cx + 0.8 * r * math.cos(a), cy + 0.8 * r * math.sin(a), fx, fy), fill=(255, 80, 80), width=4)
                dr.text((fx + 6, fy - 6), "FRONT", fill=(255, 80, 80))
            self.preview_img.set_image(small)
            black = float(gray.max()) < 10
            self._cam_note = {"index": getattr(self.camera, "index", self.cam_index), "size": [fw_, fh_],
                              "over": round(over, 1),
                              "black": black, "fps": round(float(getattr(self.camera, "fps", 0.0) or 0.0))}
            if now >= self._next_shot:          # the same picture, for the control panel
                self._next_shot = now + 0.5
                try:
                    shot = small.copy()
                    shot.thumbnail((640, 400))
                    tmp = remote.PREVIEW.with_suffix(".tmp")
                    shot.save(tmp, "PNG", compress_level=1)
                    os.replace(tmp, remote.PREVIEW)
                except OSError:
                    pass
            hint = ("  <- picture is all black: probably not the R50 (e.g. an NDI virtual webcam), "
                    "press ] for the next camera" if black else
                    "  <- too bright, lower exposure" if over > 1 else "")
            dome_help = ""
            if self.cal_mode == "dome":
                state = "NOT SAVED (Ctrl+S)" if self.circle_dirty else (
                    "automatic" if self.circle[2] <= 0 else "saved")
                dome_help = (f"\nDOME CIRCLE ({state}): arrows = move  + / - = size  (Shift = x10)   "
                             f", . = turn FRONT ({self.front_deg:.0f} deg)   A = automatic   Ctrl+S = save"
                             "\nT = white on all projectors so the dome is visible")
            cam_fps = float(getattr(self.camera, "fps", 0.0) or 0.0)
            self.preview_info.set_text(
                f"CAMERA {self.cam_index}  {fw_}x{fh_}  {cam_fps:.0f} pictures/s"
                f"{'  <- SLOW (want about 30)' if 0 < cam_fps < 15 else ''}"
                f"   over-exposed: {over:.1f}%{hint}\n"
                "[ ] = other camera    K K = start calibration    C = close" + dome_help,
                color=(255, 230, 120) if over <= 1 and not black else (255, 120, 90))
        iw, ih = self.preview_img.size
        self.preview_img.draw(w, h, x=(w - iw) // 2, y=(h - ih) // 2)
        self.preview_info.draw(w, h, x=(w - self.preview_info.size[0]) // 2, y=max(10, (h - ih) // 2 - self.preview_info.size[1] - 8))

    # ---- GL resources --------------------------------------------------------------------
    def create_gl(self):
        import moderngl
        from .overlay import TextOverlay

        self.mgl = moderngl
        self.ctx = moderngl.create_context()
        info = self.ctx.info
        self.gpu_name = f'{info.get("GL_RENDERER", "?")} / GL {info.get("GL_VERSION", "?").split(" ")[0]}'
        log.info("OpenGL: %s, %s", info.get("GL_RENDERER"), info.get("GL_VERSION"))
        self.max_tex = int(info.get("GL_MAX_TEXTURE_SIZE", 8192))

        self.prog = self.ctx.program(vertex_shader=VIDEO_VERT, fragment_shader=VIDEO_FRAG)
        quad = self.ctx.buffer(struct.pack("8f", -1, -1, 1, -1, -1, 1, 1, 1))
        self.vao = self.ctx.vertex_array(self.prog, [(quad, "2f", "in_pos")])
        self.video_tex = None
        self.video_fbo = None
        # mpv must be able to render before the video size is known
        self.dummy_tex = self.ctx.texture((16, 16), 4)
        self.dummy_fbo = self.ctx.framebuffer([self.dummy_tex])

        fs = self.cfg["stats"]["font_size"]
        self.overlay = TextOverlay(self.ctx, fs)
        self.msg_overlay = TextOverlay(self.ctx, max(24, fs + 6))
        self.help_overlay = TextOverlay(self.ctx, fs)
        self.toast_overlay = TextOverlay(self.ctx, max(24, fs + 4))
        self.labels = {n: TextOverlay(self.ctx, 72) for n in self.nums}
        for i, n in enumerate(self.nums):
            tint = TINTS[i % len(TINTS)]
            self.labels[n].set_text(f" {n} ", color=tuple(int(c * 255) for c in tint))
        self.mark = TextOverlay(self.ctx, 10)
        self.mark.set_image(_marker((255, 255, 255)))
        self.mark_sel = TextOverlay(self.ctx, 10)
        self.mark_sel.set_image(_marker((255, 220, 0), 40))
        self.preview_img = TextOverlay(self.ctx, 10)
        self.preview_info = TextOverlay(self.ctx, max(20, fs))
        self.progress_overlay = TextOverlay(self.ctx, max(24, fs + 4))
        self.load_saved_calibration()     # U turns it on/off; calibration.use = the start state

    def ensure_video_target(self):
        if self.video_size is None:
            return
        w, h = self.video_size
        limit = self.cfg["render"]["video_texture_size"] or max(w, h)
        limit = min(limit, self.max_tex)
        scale = min(1.0, limit / max(w, h))
        size = (max(1, round(w * scale)), max(1, round(h * scale)))
        if self.video_tex is not None and self.video_tex.size == size:
            return
        if self.video_fbo is not None:
            self.video_fbo.release()
            self.video_tex.release()
        mgl = self.mgl
        self.video_tex = self.ctx.texture(size, 4)
        if self.cfg["render"]["mipmaps"]:
            self.video_tex.build_mipmaps()
            self.video_tex.filter = (mgl.LINEAR_MIPMAP_LINEAR, mgl.LINEAR)
            self.video_tex.anisotropy = 8.0
        else:
            self.video_tex.filter = (mgl.LINEAR, mgl.LINEAR)
        self.video_tex.repeat_x = False
        self.video_tex.repeat_y = False
        self.video_fbo = self.ctx.framebuffer([self.video_tex])
        mb = size[0] * size[1] * 4 * (1.34 if self.cfg["render"]["mipmaps"] else 1) / 1e6
        log.info("video texture %dx%d (~%.0f MB GPU memory)", size[0], size[1], mb)

    # ---- mpv -----------------------------------------------------------------------------
    def create_player(self, mpv):
        v = self.cfg["video"]
        opts = dict(
            vo="libmpv",
            hwdec=v["hwdec"],
            loop_file="inf" if v["loop"] else "no",
            keep_open="always" if not v["loop"] else "no",
            idle="yes",
            osd_level=0,
            video_timing_offset=0,         # never block inside render(); we pace with vsync
            input_default_bindings=False,
            input_vo_keyboard=False,
            cache="yes",
            demuxer_max_bytes="300MiB",
            demuxer_readahead_secs=20,
            volume=int(v["volume"]),
            hr_seek="yes",
        )
        if not v["audio"]:
            opts["audio"] = "no"
        if v["cuda_device"] >= 0:
            opts["cuda_decode_device"] = v["cuda_device"]

        self.player = None
        player = mpv.MPV(log_handler=self._mpv_log, loglevel="warn", **opts)
        self.player = player
        log.info("libmpv %s, hwdec request: %s", getattr(player, "mpv_version", "?"), v["hwdec"])

        glfw = self.glfw

        def get_proc_address(_ctx, name):
            addr = glfw.get_proc_address(name.decode("utf-8"))
            return addr or 0

        self._proc_fn = mpv.MpvGlGetProcAddressFn(get_proc_address)  # keep a reference!
        self.render_ctx = mpv.MpvRenderContext(
            player, "opengl", opengl_init_params={"get_proc_address": self._proc_fn}
        )
        self.render_ctx.update_cb = self._on_mpv_update

        player.observe_property("dwidth", self._on_size)
        player.observe_property("dheight", self._on_size)
        player.observe_property("time-pos", self._on_time_pos)

    def _mpv_log(self, level, prefix, text):
        text = text.rstrip()
        if level in ("fatal", "error"):
            log.error("mpv[%s] %s", prefix, text)
            self._mpv_errors.append(f"mpv {prefix}: {text}")
            del self._mpv_errors[:-3]
        else:
            log.warning("mpv[%s] %s", prefix, text)

    def _on_mpv_update(self):
        self._frame_ready.set()
        try:
            self.glfw.post_empty_event()
        except Exception:
            pass

    def _on_size(self, _name, _value):
        try:
            w, h = self.player.dwidth, self.player.dheight
        except Exception:
            return
        if w and h:
            self.video_size = (int(w), int(h))

    def _on_time_pos(self, _name, value):
        if value is None:
            return
        last = self._last_time_pos
        if last is not None and value + 1.0 < last:
            self.loop_count += 1
            log.info("loop %d (jumped from %.2fs to %.2fs)", self.loop_count, last, value)
        self._last_time_pos = value

    def prop(self, name):
        try:
            return self.player._get_property(name)
        except Exception:
            return None

    def _video_stalled(self) -> bool:
        """Called every 2 s. True when the video did play and has now not moved for 30 s although
        the main loop runs (mpv idle, decoder stuck ...). Paused / loop off never count."""
        pos = self._last_time_pos
        if pos != self._beat_pos:
            self._beat_pos, self._stalled = pos, 0
            return False
        if pos is None or not self.cfg["video"]["loop"] or self.prop("pause"):
            return False
        self._stalled += 1
        return self._stalled >= 15

    def _log_health(self) -> None:
        """A line in the log now and then, so a problem report shows how smoothly it ran."""
        now = time.perf_counter()
        st = getattr(self, "stats", None)
        if now < self._next_health or st is None or self.session is not None:
            return
        self._next_health = now + (30 if now - self._t_run < 300 else 600)
        log.info("health: draws %.1f/s (display %.0f Hz), video %.1f/s, longest gap %.0f ms, late %d in 10 s, "
                 "dropped %s + %s, decoder %s, outputs %s", st.render_fps, self.refresh_hz, st.video_fps,
                 st.max_frame_gap_ms, st.missed_vsync_10s, self.prop("frame-drop-count"),
                 self.prop("decoder-frame-drop-count"), self.prop("hwdec-current"), self.nums)

    def _status(self, now: float) -> dict:
        st = getattr(self, "stats", None)
        d = {"time": time.time(), "pid": os.getpid(), "outputs": list(self.nums), "test": self.test,
             "preview": bool(self.preview), "solo": self.solo, "edit": bool(self.edit),
             "calibrated": sorted(self.cal["tex"]) if self.cal else [], "cal_use": bool(self.cal_use),
             "toast": self.toast[0] if self.toast and now < self.toast[1] else "",
             "messages": list(self.messages), "state": "play",
             "paused": bool(self.prop("pause")) if self.player is not None else False,
             "fps": round(st.render_fps, 1) if st else 0, "video_fps": round(st.video_fps, 1) if st else 0,
             "camera": self._cam_note if self.preview else None, "circle_dirty": bool(self.circle_dirty),
             "mode": self.cal_mode, "result": self._cal_result}
        if self.session is not None:
            step = self.session.step
            d.update(state="capture", progress=round(self.session.progress, 3),
                     eta=round(self.session.eta_s()), monitor=step.num if step else None,
                     skipped=sorted(self.session.skipped))
        elif self._solve is not None:
            d.update(state="read" if self._solve.get("reading") else "solve",
                     progress=round(self._solve["progress"], 3))
        if self.session is not None and hasattr(self.session, "record"):
            d["state"] = "show"
        d["show_done"] = getattr(self, "_show_done", None)
        d["lens_mm"] = self.cfg["calibration"]["lens_mm"]
        return d

    def _run_command(self, cmd: str) -> None:
        """From the control panel: "calibrate", or "key NAME [ctrl] [shift]" = that key pressed."""
        g = self.glfw
        parts = cmd.split()
        log.info("control panel: %s", cmd)
        if parts[0] == "calibrate":
            self._k_armed = time.perf_counter() + 4.0      # the panel already asked "are you sure"
            self._handle_key(g.KEY_K, g.PRESS, 0)
        elif parts[0] == "cancel":
            if self.session is not None:
                self._handle_key(g.KEY_ESCAPE, g.PRESS, 0)
        elif self.session is not None or self._solve is not None:
            self.say("busy - wait until this step is finished", 3)
        elif parts[0] == "show":
            self.start_show()
        elif parts[0] == "video" and len(parts) >= 2:
            self.start_video_calibration(cmd.split(" ", 1)[1].strip())
        elif parts[0] == "still":
            if self.preview:
                self.toggle_preview()
            else:
                self.show_still()
        elif parts[0] == "lens" and len(parts) >= 2:
            self.set_lens(float(parts[1]))
        elif parts[0] == "key" and len(parts) >= 2:
            code = key_code(g, parts[1])
            if code is not None:
                mods = (g.MOD_CONTROL if "ctrl" in parts[2:] else 0) | (g.MOD_SHIFT if "shift" in parts[2:] else 0)
                self._handle_key(code, g.PRESS, mods)

    def _panel_tick(self, now: float) -> None:
        for cmd in remote.take_commands():
            try:
                self._run_command(cmd)
            except Exception as e:  # noqa: BLE001 - a button must never end the show
                log.exception("command %r failed", cmd)
                self.say(f"that did not work: {e}", 6)
        if now >= self._next_status:
            self._next_status = now + 0.5
            remote.write_status(self._status(now))

    def _every_2s(self) -> None:
        if watchdog.stop_requested():       # the start window was asked to start a new show
            log.info("a new start of DomePlayer asked this one to stop")
            self.running = False
            return
        self._log_health()
        if not SUPERVISED:
            return
        try:
            HEARTBEAT.write_text(str(time.time()), encoding="ascii")
        except OSError:
            pass
        if self._video_stalled():
            log.error("the video has not moved for 30 s - restarting the player")
            self.exit_code = 1
            self.running = False

    def load_video(self) -> bool:
        path = self.cfg["video"]["path_resolved"]
        if not Path(path).is_file():
            return False
        log.info("playing %s", path)
        self.player.loadfile(path)
        self._file_loaded = True
        self._load_time = time.perf_counter()
        return True

    # ---- main loop -----------------------------------------------------------------------
    def run(self):
        from .stats import FrameStats

        self.create_window()
        self.create_gl()
        self.create_player(self._mpv)
        self.stats = FrameStats(self.refresh_hz)

        next_file_check = 0.0
        next_stats_text = 0.0
        glfw = self.glfw
        bg = tuple(c / 255.0 for c in self.cfg["preview"]["background"])

        keep_awake()
        self._monitors_changed = None
        glfw.set_monitor_callback(lambda _m, _ev: setattr(self, "_monitors_changed", time.perf_counter()))
        next_beat = 0.0
        next_idle_check = 0.0
        next_restore = 0.0
        next_panel = 0.0
        errors = 0
        self._t_run = time.perf_counter()
        remote.take_commands()        # buttons pressed while no player was running do not count
        try:                          # a copy left by a video reading that was cut short
            for f in VIDEO_TMP.glob("*.tmp.mp4"):
                f.unlink()
        except OSError:
            pass

        while self.running and not glfw.window_should_close(self.window):
            try:
                glfw.poll_events()
                now = time.perf_counter()
                if now >= next_beat:
                    next_beat = now + 2.0
                    self._every_2s()
                if now >= next_panel:
                    next_panel = now + 0.2
                    self._panel_tick(now)
                if self._monitors_changed is not None and now - self._monitors_changed > 3.0:
                    self._monitors_changed = None
                    log.warning("monitors were connected/disconnected (projector turned off or on?)")
                    if SUPERVISED and self.cfg["display"]["fullscreen"]:
                        log.warning("restarting the player so the outputs are set up again")
                        self.exit_code = 3
                        self.running = False
                    else:
                        self.say("a monitor was connected or disconnected - restart DomePlayer", 8)

                if self._file_loaded and now >= next_idle_check:
                    next_idle_check = now + 2.0
                    if now - self._load_time > 10.0 and self.prop("idle-active"):
                        log.error("mpv stopped playing (%s) - loading the video again",
                                  self._mpv_errors[-1] if self._mpv_errors else "no error reported")
                        self._file_loaded = False
                if not self._file_loaded and now >= next_file_check:
                    next_file_check = now + 5.0      # keep retrying (e.g. a USB drive mounting late)
                    if not self.load_video():
                        msg = f"Video file not found:\n{self.cfg['video']['path_resolved']}\n(checking again every 5 s)"
                        if msg not in self.messages:
                            self.messages.append(msg)
                            log.error(msg.replace("\n", " "))
                    else:
                        self.messages = [m for m in self.messages if not m.startswith("Video file not found")]

                # 1) let mpv draw the newest decoded frame into our video texture
                if self._frame_ready.is_set():
                    self._frame_ready.clear()
                    if self.render_ctx.update():
                        self.ensure_video_target()
                        fbo = self.video_fbo or self.dummy_fbo
                        w, h = fbo.size
                        self.render_ctx.render(flip_y=True, opengl_fbo={"w": w, "h": h, "fbo": fbo.glo})
                        if self.video_fbo is not None:
                            if self.cfg["render"]["mipmaps"]:
                                self.video_tex.build_mipmaps()
                            self.stats.on_video_frame()

                # 2) draw every output (mpv may have changed GL state, so set what we need)
                fw, fh = glfw.get_framebuffer_size(self.window)
                if fw == 0 or fh == 0:
                    if self.cfg["display"]["fullscreen"] and now >= next_restore:
                        next_restore = now + 2.0
                        glfw.restore_window(self.window)   # minimised (Win+D / Win+M): bring it back
                    time.sleep(0.01)
                    continue
                if self._cal_data is not None and self._rects:
                    self._build_cal_textures(self._rects)
                self.draw_frame(fw, fh, bg, now)
                if self.camera is not None and self.camera.index == -1 and (self.session or self.preview):
                    self._grab_outputs(fw, fh)

                glfw.swap_buffers(self.window)
                self.render_ctx.report_swap()
                self.stats.on_swap(self.vsync)
                self.frame_no += 1

                # 3) camera calibration: take pictures, then solve in the background
                if self.session is not None:
                    self.session.presented(time.perf_counter())
                    self.session.poll()
                    if self.session.done:
                        self._after_capture()
                self._check_solve()
                errors = 0
                # vsync is not holding the loop back (forced off in the driver, display asleep):
                # pace it ourselves instead of spinning one CPU core and the GPU at 100 %
                if self.stats.render_fps > self.refresh_hz * 1.5:
                    spare = 1.0 / self.refresh_hz - (time.perf_counter() - now)
                    if spare > 0:
                        time.sleep(spare)
            except Exception:  # noqa: BLE001 - one bad frame must not end the show
                errors += 1
                log.exception("frame failed (%d in a row)", errors)
                if errors >= 30:
                    raise              # really broken: let the watchdog restart us
                time.sleep(0.05)

        self.close_camera()
        self.shutdown()

    def draw_frame(self, fw: int, fh: int, bg, now: float) -> None:
        mgl = self.mgl
        self.ctx.screen.use()
        self.ctx.viewport = (0, 0, fw, fh)
        self.ctx.disable(mgl.BLEND | mgl.DEPTH_TEST | mgl.CULL_FACE)
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)

        rects = self.output_rects(fw, fh)
        self._rects = {n: (x, y, w, h) for n, x, y, w, h in rects}

        if self.session is not None:     # calibration patterns only, no text at all
            st = self.session.step
            for n, x, y, w, h in rects:
                self.ctx.viewport = (x, fh - y - h, w, h)
                if st is not None and st.kind == "probe":   # camera delay check: all flash
                    pat = 3 if st.inv else 1
                elif st is None or st.num != n:
                    pat = 3
                else:
                    pat = 1 if st.kind == "white" else 2
                self.draw_pattern(pat, w, h, st)
            return

        visible = [r for r in rects if self.solo is None or r[0] == self.solo]
        target = self.edit_target() if self.edit else None

        for n, x, y, w, h in visible:
            self.ctx.viewport = (x, fh - y - h, w, h)
            if (self.cal_use and self.cal is not None and self.cal["ref"] is None
                    and n not in self.cal["tex"] and self.test == 0 and self.solo is None):
                continue      # dome: an output without calibration stays black, not a raw fisheye
            self.draw_output(n, w, h, bg)
            if self.test == 1:
                self.labels[n].draw(w, h, center=True)
            if n == target:
                pts = self.corners_for(n, w, h)
                for i, (px, py) in enumerate(pts):
                    mk = self.mark_sel if i == self.sel_corner else self.mark
                    mw, mh = mk.size
                    mk.draw(w, h, x=int(px * w - mw / 2), y=int(py * h - mh / 2))
                self.help_overlay.set_text(self.edit_help(n), color=(255, 230, 120))
                self.help_overlay.draw(w, h, x=16, y=max(16, h - self.help_overlay.size[1] - 16))

        # text goes on the first visible output (or the whole window if none)
        if visible:
            _, x, y, w, h = visible[0]
            self.ctx.viewport = (x, fh - y - h, w, h)
        else:
            w, h = fw, fh
            self.ctx.viewport = (0, 0, fw, fh)
        if self.preview:
            self.draw_preview(w, h, now)
        elif self.show_stats and not self.edit:
            if now >= self._next_stats:
                self._next_stats = now + 0.25
                self.overlay.set_text(self.stats_text())
            self.overlay.draw(w, h)
        if self._solve is not None:
            self.progress_overlay.set_text(
                f"calculating calibration ... {int(self._solve['progress'] * 100)}%", color=(140, 255, 160))
            self.progress_overlay.draw(w, h, center=True)
        msgs = list(self.messages)
        if SUPERVISED and not self.show_stats and now - self._t_run > 120:
            # unattended show: start-up warnings stay in the log (and on the F1 page) only
            msgs = [m for m in msgs if m.startswith(("Video file not found", "The saved calibration"))]
        if (self._file_loaded and self._mpv_errors and now - self._load_time > 3.0
                and self.prop("idle-active")):
            msgs.append("Video could not be played:\n" + self._mpv_errors[-1])
        if msgs:
            self.msg_overlay.set_text("\n\n".join(msgs), color=(255, 200, 80))
            self.msg_overlay.draw(w, h, center=True)
        if self.toast and now < self.toast[1]:
            self.toast_overlay.set_text(self.toast[0], color=(140, 255, 160))
            tw, th = self.toast_overlay.size
            self.toast_overlay.draw(w, h, x=(w - tw) // 2, y=max(16, h // 5))

    _next_stats = 0.0

    def draw_output(self, num: int, w: int, h: int, bg) -> None:
        p = self.cfg["preview"]
        prog = self.prog
        cal = self.cal["tex"].get(num) if self._calibrated(num) else None
        if cal is not None and "mesh" in cal and self.cal["ref"] is None:
            corners = None       # dome: the mesh already holds video positions
        elif cal is not None and "mesh" in cal:
            # stacked output: show what the reference shows at the same spot on the dome
            ref = self.cal["ref"]
            rr = self._rects.get(ref, (0, 0, w, h))
            corners = self.corners_for(ref, rr[2], rr[3])
        else:
            corners = self.corners_for(num, w, h)
        try:
            if corners is None:
                raise ValueError("identity")
            hinv = warp.output_to_image_uniform(corners)
        except ValueError:
            hinv = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        mk = self.cfg["mask"]
        has_video = self.video_tex is not None
        idx = self.nums.index(num) if num in self.nums else 0
        period = max(1, round(self.refresh_hz * 2))
        use_mesh = cal is not None and "mesh" in cal
        if use_mesh:
            cal["mesh"].use(1)
        if cal is not None:
            cal["gain"].use(2)
        values = {
            "u_pattern": 0,
            "u_use_mesh": use_mesh,
            "u_mesh": 1,
            "u_mesh_size": cal["mesh_size"] if use_mesh else (2.0, 2.0),
            "u_use_gainmap": cal is not None,
            "u_gainmap": 2,
            "u_hinv": hinv,
            "u_flip": (-1.0 if p["flip_x"] else 1.0, -1.0 if p["flip_y"] else 1.0),
            "u_rot": math.radians(float(p["rotate_deg"])),
            "u_bg": bg,
            "u_gain": self.gain.get(num, 1.0) ** (1 / 2.2),   # light output -> signal (gamma 2.2)
            "u_mode": int(self.test),
            "u_tint": TINTS[idx % len(TINTS)],
            "u_sweep": (self.frame_no % period) / period,
            "u_has_video": has_video,
            "u_video": 0,
            "u_mask_on": bool(mk["enabled"]),
            "u_mask_c": (float(mk["center"][0]), float(mk["center"][1])),
            "u_mask_r": float(mk["radius"]),
            "u_mask_feather": float(mk["feather"]),
        }
        for name, value in values.items():
            member = prog.get(name, None)
            if member is not None:
                member.value = value
        if has_video:
            self.video_tex.use(0)
        self.vao.render(self.mgl.TRIANGLE_STRIP)

    def draw_pattern(self, pattern: int, w: int, h: int, st) -> None:
        values = {"u_pattern": pattern, "u_size": (float(w), float(h)),
                  "u_axis": st.axis if st else 0, "u_bit": st.bit if st else 0,
                  "u_inv": bool(st.inv) if st else False}
        for name, value in values.items():
            member = self.prog.get(name, None)
            if member is not None:
                member.value = value
        self.vao.render(self.mgl.TRIANGLE_STRIP)

    def edit_help(self, num: int) -> str:
        unsaved = "   * NOT SAVED - Ctrl+S *" if num in self.dirty else ""
        return "\n".join([
            f"ALIGN monitor {num}{unsaved}",
            f"corner: {CORNER_NAMES[self.sel_corner]}   (Tab = next corner, or drag any corner with the mouse)",
            "arrows = move corner 1 px   Shift+arrows = 10 px",
            f"+ / -  = brightness {self.gain.get(num, 1.0):.2f}    R = reset this monitor",
            "Ctrl+S = save    E or Esc = done    1-9 = other monitor",
        ])

    def stats_text(self) -> str:
        from .stats import fmt_time

        st = self.stats
        hw = self.prop("hwdec-current")
        if not hw or hw == "no":
            hw = "NONE - CPU decoding, expect stutter (check driver / hwdec)"
        codec = self.prop("video-format") or "?"
        vw, vh = self.video_size or (0, 0)
        tex = self.video_tex.size if self.video_tex is not None else (0, 0)
        container_fps = self.prop("container-fps") or 0
        vo_drop = self.prop("frame-drop-count") or 0
        dec_drop = self.prop("decoder-frame-drop-count") or 0
        delayed = self.prop("vo-delayed-frame-count") or 0
        pos = self.prop("time-pos")
        dur = self.prop("duration")
        paused = " [PAUSED]" if self.prop("pause") else ""
        showing = "all" if self.solo is None else f"only {self.solo}"
        flags = (["", " GRID", " WHITE"][self.test]) + (" ALIGN" if self.edit else "")
        if self.cal is None:
            cal = "none (C = camera, K K = calibrate)"
        else:
            kind = "dome" if self.cal["ref"] is None else f"stack, ref {self.cal['ref']}"
            cal = (f"{'ON' if self.cal_use else 'off'}  {kind}, "
                   f"{self.cal['info'].get('created', '?')}  (U = on/off)")
        return "\n".join([
            f"DomePlayer{paused}",
            f"render fps   {st.render_fps:5.1f}   (display {self.refresh_hz:.0f} Hz, vsync {'on' if self.vsync else 'off'})",
            f"video fps    {st.video_fps:5.1f}   (file {container_fps:.3f})",
            f"max gap      {st.max_frame_gap_ms:5.0f} ms between video frames (2 s window)",
            f"dropped      mpv {vo_drop}  decoder {dec_drop}  delayed {delayed}",
            f"missed vsync {st.missed_vsync_total} total, {st.missed_vsync_10s} in last 10 s",
            f"hw decode    {hw}",
            f"video        {codec} {vw}x{vh} -> texture {tex[0]}x{tex[1]}",
            f"time         {fmt_time(pos)} / {fmt_time(dur)}   loop #{self.loop_count}",
            f"gpu          {self.gpu_name}",
            f"outputs      {', '.join(map(str, self.nums))}   showing {showing}{flags}",
            f"calibration  {cal}",
            f"uptime       {fmt_time(st.uptime)}",
            "keys         F1 stats | T grid/white | 1-9 one output, 0 all | E align | C camera | K K calibrate | Esc quit",
        ])

    def shutdown(self):
        log.info("shutting down")
        try:
            self.render_ctx.free()
        except Exception:
            pass
        try:
            self.player.terminate()
        except Exception:
            pass
        try:
            self.glfw.terminate()
        except Exception:
            pass


SUPERVISED = False                      # started by the watchdog (--supervised)
HEARTBEAT = APP_DIR / "logs" / "heartbeat.txt"
VIDEO_TMP = APP_DIR / "video_tmp"       # working copy when the second lens of a two-lens file is read


def _window_keep_only(glfw, win, rects) -> bool:
    """Windows: the window exists only on these rectangles (window pixels). A monitor lying
    between the projectors (the operator's screen) then stays visible and usable."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        gdi, user = ctypes.windll.gdi32, ctypes.windll.user32
        gdi.CreateRectRgn.restype = wintypes.HANDLE
        gdi.CreateRectRgn.argtypes = [ctypes.c_int] * 4
        gdi.CombineRgn.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE, ctypes.c_int]
        gdi.DeleteObject.argtypes = [wintypes.HANDLE]
        user.SetWindowRgn.argtypes = [wintypes.HWND, wintypes.HANDLE, wintypes.BOOL]
        region = gdi.CreateRectRgn(0, 0, 0, 0)
        for x, y, w, h in rects:
            part = gdi.CreateRectRgn(int(x), int(y), int(x + w), int(y + h))
            gdi.CombineRgn(region, region, part, 2)          # 2 = RGN_OR
            gdi.DeleteObject(part)
        return bool(user.SetWindowRgn(glfw.get_win32_window(win), region, True))   # Windows now owns it
    except Exception:  # noqa: BLE001
        log.exception("could not shape the window")
        return False
EXIT_MONITORS_CHANGED = 3


def busy(seconds: float) -> None:
    """Tell the watchdog the main loop will be busy for up to 'seconds' (camera open ...): the
    heartbeat file gets a time in the future, the next normal heartbeat sets it back."""
    if not SUPERVISED:
        return
    try:
        HEARTBEAT.write_text(str(time.time()), encoding="ascii")
        t = time.time() + seconds
        os.utime(HEARTBEAT, (t, t))
    except OSError:
        pass


def keep_awake() -> None:
    """Stop Windows from sleeping / turning the screens off / screensaver while we run."""
    if os.name != "nt":
        return
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED, ES_DISPLAY_REQUIRED = 0x80000000, 0x1, 0x2
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
    except Exception:  # noqa: BLE001
        log.warning("could not stop Windows from sleeping")


def show_fatal(message: str) -> None:
    """Show an error even when started with pythonw.exe (no console)."""
    log.error(message)
    if SUPERVISED:      # the watchdog restarts us; a message box would only block that
        return
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "DomePlayer error", 0x10 | 0x40000 | 0x10000)
            return
        except Exception:
            pass
    print("ERROR:", message, file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    global SUPERVISED
    SUPERVISED = "--supervised" in argv
    if "--watch" in argv or "--autostart" in argv:
        from .watchdog import main as watch_main
        return watch_main(autostart="--autostart" in argv)
    if "--check" in argv:
        from .check import main as check_main
        return check_main()
    if "--report" in argv:
        from .report import main as report_main
        return report_main()
    if "--identify" in argv:
        from .identify import main as identify_main
        return identify_main()
    if "--self-test" in argv:   # checks the packaged parts load (used after building the .exe)
        log_file = setup_logging("info")
        try:
            import cv2
            import numpy
            import_mpv()
            from .calib import camera, session, solve  # noqa: F401
            from . import backup, check, report, ydome  # noqa: F401  (watchdog is imported at the top)
            from .calib import video
            # calibration from a recorded video needs OpenCV's own video-file reader in the package:
            # write a tiny film and read it back
            import tempfile
            film = Path(tempfile.gettempdir()) / "domeplayer-selftest.mp4"
            out = cv2.VideoWriter(str(film), cv2.VideoWriter_fourcc(*"mp4v"), 30.0, (64, 48))
            for i in range(12):
                out.write(numpy.full((48, 64, 3), i * 20, numpy.uint8))
            out.release()
            cap = cv2.VideoCapture(video.plain_path(film), cv2.CAP_FFMPEG)
            frames = 0
            while cap.read()[0]:
                frames += 1
            cap.release()
            tracks = len(video.video_tracks(film))
            try:
                film.unlink()
            except OSError:
                pass
            if frames < 10 or tracks != 1:
                raise RuntimeError(f"video files cannot be read ({frames} pictures, {tracks} track)")
            log.info("self-test OK: opencv %s, numpy %s, video files readable", cv2.__version__, numpy.__version__)
            return 0
        except Exception:  # noqa: BLE001
            log.exception("self-test failed")
            return 1
    if "--play" not in argv:
        # No arguments: open the small start window (pick video + monitor, then play).
        # Use --play to start playing straight away (for auto-start at boot).
        try:
            from .launcher import main as launcher_main
            return launcher_main()
        except Exception as e:  # noqa: BLE001 - the .exe has no console, so show it
            log_file = setup_logging("info")
            log.exception("start window failed")
            show_fatal(f"{e}\n\nDetails are in {log_file}")
            return 1

    if not SUPERVISED and not watchdog.single_instance():    # a show is already running
        watchdog.tell(watchdog.ALREADY_RUNNING)
        return 0
    cfg_path = None
    if "--config" in argv:
        cfg_path = Path(argv[argv.index("--config") + 1])
    try:
        cfg = load_config(cfg_path)
    except ConfigError as e:
        setup_logging("info")
        show_fatal(str(e))
        return 2

    log_file = setup_logging(cfg["log_level"])
    log.info("DomePlayer starting, config from %s, log %s", cfg["_config_path"], log_file)
    try:
        app = DomePlayer(cfg)
        app._mpv = import_mpv()
        app.run()
    except Exception as e:  # noqa: BLE001 - last line of defence for a kiosk app
        log.exception("fatal error")
        show_fatal(f"{e}\n\nDetails are in {log_file}")
        return 1
    log.info("DomePlayer closed (exit code %d)", app.exit_code)
    return app.exit_code
