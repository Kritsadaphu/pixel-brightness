"""DomePlayer phase 1: play a Domemaster fisheye video, looped, fullscreen on one monitor.

Pipeline (kept this way so later phases only add shaders, not a new architecture):

    file --(NVDEC, CUDA->GL interop)--> mpv render API --> video texture (FBO, native 3840x3840)
         --> our GLSL shader (now: fit/rotate preview; later: per-projector fisheye slice,
             mesh warp, edge blend) --> window back buffer --> swap (vsync)
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

from .config import APP_DIR, ConfigError, load_config

log = logging.getLogger("domeplayer")

VIDEO_VERT = """
#version 330
in vec2 in_pos;          // full-screen quad, -1..1
out vec2 v_ndc;
void main() { v_ndc = in_pos; gl_Position = vec4(in_pos, 0.0, 1.0); }
"""

VIDEO_FRAG = """
#version 330
uniform sampler2D u_video;
uniform bool  u_has_video;
uniform vec2  u_scale;   // screen NDC -> video NDC (aspect fit + zoom)
uniform vec2  u_flip;
uniform float u_rot;     // radians
uniform vec3  u_bg;
in vec2 v_ndc;
out vec4 f_color;
void main() {
    vec2 p = v_ndc * u_scale * u_flip;
    float c = cos(u_rot), s = sin(u_rot);
    p = mat2(c, s, -s, c) * p;
    vec2 uv = p * 0.5 + 0.5;
    if (!u_has_video || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
        f_color = vec4(u_bg, 1.0);
        return;
    }
    f_color = vec4(texture(u_video, uv).rgb, 1.0);
}
"""


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

    # ---- window ----------------------------------------------------------------------
    def create_window(self):
        import glfw
        from .monitors import find_monitor

        d = self.cfg["display"]
        if not glfw.init():
            raise RuntimeError("could not initialise GLFW (graphics driver problem?)")
        self.glfw = glfw

        mon, all_mons = find_monitor(d["monitor"])
        for m in all_mons:
            log.info("found %s", m.describe())
        if mon is None:
            mon = next((m for m in all_mons if m.primary), all_mons[0] if all_mons else None)
            msg = (f"display.monitor = {d['monitor']} not found, using monitor "
                   f"{mon.number if mon else '?'}. Run IDENTIFY-MONITORS.bat.")
            log.warning(msg)
            self.messages.append(msg)
        if mon is None:
            raise RuntimeError("no monitor found")
        self.monitor = mon

        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
        glfw.window_hint(glfw.OPENGL_FORWARD_COMPAT, True)
        glfw.window_hint(glfw.DOUBLEBUFFER, True)
        glfw.window_hint(glfw.AUTO_ICONIFY, False)        # don't minimise when focus is lost
        glfw.window_hint(glfw.FLOATING, bool(d["always_on_top"] and d["fullscreen"]))

        title = "DomePlayer"
        if not d["fullscreen"]:
            glfw.window_hint(glfw.DECORATED, True)
            win = glfw.create_window(d["width"], d["height"], title, None, None)
            if win:
                glfw.set_window_pos(win, mon.x + 40, mon.y + 40)
        elif d["mode"] == "exclusive":
            if d["refresh_rate"]:
                glfw.window_hint(glfw.REFRESH_RATE, d["refresh_rate"])
            win = glfw.create_window(d["width"], d["height"], title, mon.handle, None)
        else:  # borderless window that exactly covers the monitor
            glfw.window_hint(glfw.DECORATED, False)
            glfw.window_hint(glfw.VISIBLE, False)
            win = glfw.create_window(mon.width, mon.height, title, None, None)
            if win:
                glfw.set_window_pos(win, mon.x, mon.y)
                glfw.set_window_size(win, mon.width, mon.height)
                glfw.show_window(win)
        if not win:
            raise RuntimeError("could not create an OpenGL 3.3 window (is the NVIDIA driver installed?)")
        self.window = win
        glfw.make_context_current(win)
        self.vsync = bool(d["vsync"])
        glfw.swap_interval(1 if self.vsync else 0)
        if d["hide_cursor"] and d["fullscreen"]:
            glfw.set_input_mode(win, glfw.CURSOR, glfw.CURSOR_HIDDEN)
        glfw.set_key_callback(win, self._on_key)
        glfw.focus_window(win)

        mode = glfw.get_video_mode(mon.handle)
        self.refresh_hz = float(mode.refresh_rate or 60)
        log.info("output on monitor %d (%s), %dx%d @ %.0f Hz, mode=%s, vsync=%s",
                 mon.number, mon.device or mon.name, mode.size.width, mode.size.height,
                 self.refresh_hz, d["mode"] if d["fullscreen"] else "window", self.vsync)

        k = self.cfg["keys"]
        self.keys = {
            "quit": key_code(glfw, k["quit"]),
            "pause": key_code(glfw, k["pause"]),
            "restart": key_code(glfw, k["restart"]),
            "stats": key_code(glfw, self.cfg["stats"]["key"]),
        }

    def _on_key(self, _win, key, _scancode, action, _mods):
        if action != self.glfw.PRESS:
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

        self.overlay = TextOverlay(self.ctx, self.cfg["stats"]["font_size"])
        self.msg_overlay = TextOverlay(self.ctx, max(24, self.cfg["stats"]["font_size"] + 6))

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

        self.player = None
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

            # 2) draw to the window (mpv may have changed GL state, so set what we need)
            fw, fh = glfw.get_framebuffer_size(self.window)
            if fw == 0 or fh == 0:
                time.sleep(0.01)
                continue
            screen = self.ctx.screen
            screen.use()
            self.ctx.viewport = (0, 0, fw, fh)
            self.ctx.disable(self.mgl.BLEND | self.mgl.DEPTH_TEST | self.mgl.CULL_FACE)
            self.draw_video(fw, fh, bg)

            if self.show_stats:
                if now >= next_stats_text:
                    next_stats_text = now + 0.25
                    self.overlay.set_text(self.stats_text())
                self.overlay.draw(fw, fh)
            msgs = list(self.messages)
            if (self._file_loaded and self._mpv_errors and now - self._load_time > 3.0
                    and self.prop("idle-active")):
                msgs.append("Video could not be played:\n" + self._mpv_errors[-1])
            if msgs:
                self.msg_overlay.set_text("\n\n".join(msgs), color=(255, 200, 80))
                self.msg_overlay.draw(fw, fh, center=True)

            glfw.swap_buffers(self.window)
            self.render_ctx.report_swap()
            self.stats.on_swap(self.vsync)

        self.shutdown()

    def draw_video(self, fw, fh, bg):
        p = self.cfg["preview"]
        has_video = self.video_tex is not None
        sx = sy = 1.0
        if has_video and p["fit"] != "stretch":
            vw, vh = self.video_tex.size
            a = vw / vh            # video aspect
            s = fw / fh            # screen aspect
            cover = p["fit"] == "cover"
            if (a < s) != cover:   # fit height
                sx = s / a
            else:                  # fit width
                sy = a / s
        zoom = float(p["zoom"]) or 1.0
        prog = self.prog
        prog["u_scale"].value = (sx / zoom, sy / zoom)
        prog["u_flip"].value = (-1.0 if p["flip_x"] else 1.0, -1.0 if p["flip_y"] else 1.0)
        prog["u_rot"].value = math.radians(float(p["rotate_deg"]))
        prog["u_bg"].value = bg
        prog["u_has_video"].value = has_video
        if has_video:
            self.video_tex.use(0)
            prog["u_video"].value = 0
        self.vao.render(self.mgl.TRIANGLE_STRIP)

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
        return "\n".join([
            f"DomePlayer  phase 1{paused}",
            f"render fps   {st.render_fps:5.1f}   (display {self.refresh_hz:.0f} Hz, vsync {'on' if self.vsync else 'off'})",
            f"video fps    {st.video_fps:5.1f}   (file {container_fps:.3f})",
            f"max gap      {st.max_frame_gap_ms:5.0f} ms between video frames (2 s window)",
            f"dropped      mpv {vo_drop}  decoder {dec_drop}  delayed {delayed}",
            f"missed vsync {st.missed_vsync_total} total, {st.missed_vsync_10s} in last 10 s",
            f"hw decode    {hw}",
            f"video        {codec} {vw}x{vh} -> texture {tex[0]}x{tex[1]}",
            f"time         {fmt_time(pos)} / {fmt_time(dur)}   loop #{self.loop_count}",
            f"gpu          {self.gpu_name}",
            f"monitor      {self.monitor.number} {self.monitor.device}",
            f"uptime       {fmt_time(st.uptime)}",
            "keys         F1 stats | Space pause | Home restart | Esc quit",
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
    log.info("DomePlayer starting, config from %s, log %s", cfg_path or APP_DIR / "config.json", log_file)
    try:
        app = DomePlayer(cfg)
        app._mpv = import_mpv()
        app.run()
    except Exception as e:  # noqa: BLE001 - last line of defence for a kiosk app
        log.exception("fatal error")
        show_fatal(f"{e}\n\nDetails are in {log_file}")
        return 1
    return 0
