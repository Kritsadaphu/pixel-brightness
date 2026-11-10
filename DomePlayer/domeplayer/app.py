"""DomePlayer: play a Domemaster fisheye video, looped, on one monitor or stacked on many.

Pipeline:

    file --(NVDEC, CUDA->GL interop)--> mpv render API --> video texture (FBO, native 3840x3840)
         --> our GLSL shader, once per output (4-corner warp, brightness, test grid)
         --> one window back buffer --> swap (vsync)

Stacked projection (stack.enabled): every projector shows the same full image on the same dome
area. All outputs live in ONE borderless window that spans those monitors, so every projector
gets the same video frame in the same swap; no network sync between processes is needed.
Each output has its own 4-corner warp + brightness so the stacked images can be lined up.
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

from . import warp
from .config import APP_DIR, ConfigError, load_config, save_outputs

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
uniform int   u_mode;    // 0 = video, 1 = test grid
uniform vec3  u_tint;    // test grid colour of this output
uniform float u_sweep;   // 0..1, advances every display refresh (sync check)
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
    vec3 q = u_hinv * vec3(o, 1.0);
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
    } else if (u_has_video) {
        col = texture(u_video, uv).rgb;
    } else {
        col = u_bg;
    }
    f_color = vec4(clamp(col * u_gain, 0.0, 1.0), 1.0);
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
    if os.name == "nt":
        os.environ["PATH"] = str(lib_dir) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(lib_dir))
        if not any((lib_dir / n).exists() for n in ("libmpv-2.dll", "mpv-2.dll")):
            raise RuntimeError(
                f"libmpv-2.dll not found in {lib_dir}. Run 1-SETUP.bat again "
                "(or put libmpv-2.dll into the lib folder by hand, see README)."
            )
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
        self.test = False
        self.edit = False
        self.sel_corner = 0
        self.dragging = False
        self.dirty: set[int] = set()
        self.toast: tuple[str, float] | None = None
        self.frame_no = 0
        self._rects: dict[int, tuple[int, int, int, int]] = {}

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
        except OSError as e:
            self.say(f"could not save config.json: {e}", 6)
            return
        self.dirty.clear()
        self.say(f"saved alignment of monitor {', '.join(map(str, nums))} to config.json")

    def _on_key(self, _win, key, _scancode, action, mods):
        g = self.glfw
        if action not in (g.PRESS, g.REPEAT):
            return
        repeatable = key in (g.KEY_LEFT, g.KEY_RIGHT, g.KEY_UP, g.KEY_DOWN, g.KEY_EQUAL, g.KEY_MINUS,
                             g.KEY_KP_ADD, g.KEY_KP_SUBTRACT)
        if action == g.REPEAT and not repeatable:
            return
        ctrl = bool(mods & g.MOD_CONTROL)
        shift = bool(mods & g.MOD_SHIFT)

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
            self.test = not self.test
            return
        if key == g.KEY_E or (self.edit and key == g.KEY_ESCAPE):
            self.toggle_edit()
            return
        if self.edit:
            self._edit_key(key, shift)
            return
        if key == self.keys["stats"]:
            self.show_stats = not self.show_stats
        elif key == self.keys["quit"]:
            self.running = False
        elif key == self.keys["pause"] and self.player is not None:
            self.player.pause = not self.player.pause
        elif key == self.keys["restart"] and self.player is not None:
            self.player.seek(0, "absolute", "exact")
            self.stats.reset()

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
            self.edit = True
            self.test = True
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

        while self.running and not glfw.window_should_close(self.window):
            glfw.poll_events()
            now = time.perf_counter()

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
                time.sleep(0.01)
                continue
            self.draw_frame(fw, fh, bg, now)

            glfw.swap_buffers(self.window)
            self.render_ctx.report_swap()
            self.stats.on_swap(self.vsync)
            self.frame_no += 1

        self.shutdown()

    def draw_frame(self, fw: int, fh: int, bg, now: float) -> None:
        mgl = self.mgl
        self.ctx.screen.use()
        self.ctx.viewport = (0, 0, fw, fh)
        self.ctx.disable(mgl.BLEND | mgl.DEPTH_TEST | mgl.CULL_FACE)
        self.ctx.clear(0.0, 0.0, 0.0, 1.0)

        rects = self.output_rects(fw, fh)
        self._rects = {n: (x, y, w, h) for n, x, y, w, h in rects}
        visible = [r for r in rects if self.solo is None or r[0] == self.solo]
        target = self.edit_target() if self.edit else None

        for n, x, y, w, h in visible:
            self.ctx.viewport = (x, fh - y - h, w, h)
            self.draw_output(n, w, h, bg)
            if self.test:
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
        if self.show_stats and not self.edit:
            if now >= self._next_stats:
                self._next_stats = now + 0.25
                self.overlay.set_text(self.stats_text())
            self.overlay.draw(w, h)
        msgs = list(self.messages)
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
        corners = self.corners_for(num, w, h)
        try:
            hinv = warp.output_to_image_uniform(corners)
        except ValueError:
            hinv = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        has_video = self.video_tex is not None
        idx = self.nums.index(num) if num in self.nums else 0
        period = max(1, round(self.refresh_hz * 2))
        values = {
            "u_hinv": hinv,
            "u_flip": (-1.0 if p["flip_x"] else 1.0, -1.0 if p["flip_y"] else 1.0),
            "u_rot": math.radians(float(p["rotate_deg"])),
            "u_bg": bg,
            "u_gain": self.gain.get(num, 1.0) ** (1 / 2.2),   # light output -> signal (gamma 2.2)
            "u_mode": 1 if self.test else 0,
            "u_tint": TINTS[idx % len(TINTS)],
            "u_sweep": (self.frame_no % period) / period,
            "u_has_video": has_video,
            "u_video": 0,
        }
        for name, value in values.items():
            member = prog.get(name, None)
            if member is not None:
                member.value = value
        if has_video:
            self.video_tex.use(0)
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
        flags = (" TEST" if self.test else "") + (" ALIGN" if self.edit else "")
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
            f"uptime       {fmt_time(st.uptime)}",
            "keys         F1 stats | T test grid | 1-9 one output, 0 all | E align | Space pause | Esc quit",
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


def show_fatal(message: str) -> None:
    """Show an error even when started with pythonw.exe (no console)."""
    log.error(message)
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, "DomePlayer error", 0x10)
            return
        except Exception:
            pass
    print("ERROR:", message, file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--identify" in argv:
        from .identify import main as identify_main
        return identify_main()
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
    return 0
