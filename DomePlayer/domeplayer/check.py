"""Readiness check: DomePlayer.exe --check

Looks at everything the show needs and writes a Thai report to logs/check.txt
(+ logs/check.json, + one picture per camera logs/check_camera_<n>.jpg).
Each line is OK / WARN (works, but look at it) / FAIL (will not work properly).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from pathlib import Path

from .config import APP_DIR, ConfigError, load_config

log = logging.getLogger("domeplayer.check")
LOG_DIR = APP_DIR / "logs"
OK, WARN, FAIL = "OK", "WARN", "FAIL"


class Report:
    def __init__(self):
        self.items: list[dict] = []

    def add(self, status: str, title: str, detail: str = "") -> None:
        self.items.append({"status": status, "title": title, "detail": detail})
        log.info("[%s] %s %s", status, title, detail.replace("\n", " | "))

    def text(self) -> str:
        mark = {OK: "✅ ผ่าน ", WARN: "⚠️ ระวัง", FAIL: "❌ ไม่ผ่าน"}
        lines = [f"DomePlayer ตรวจความพร้อม  {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
        for it in self.items:
            lines.append(f"{mark[it['status']]}  {it['title']}")
            for d in it["detail"].splitlines():
                lines.append(f"            {d}")
        n_fail = sum(it["status"] == FAIL for it in self.items)
        n_warn = sum(it["status"] == WARN for it in self.items)
        lines += ["", (f"สรุป: ไม่ผ่าน {n_fail} ข้อ, ระวัง {n_warn} ข้อ" if n_fail or n_warn
                       else "สรุป: ผ่านทุกข้อที่ตรวจได้  ขั้นสุดท้าย: กด เล่น แล้วกด F1 ดูหน้าสถิติสัก 2 นาที "
                            "(render fps ต้องเท่า Hz ของจอ, missed vsync และ dropped ต้องไม่เพิ่ม)")]
        return "\n".join(lines)


def _run(cmd: list[str], timeout: float = 20) -> str:
    flags = 0x08000000 if os.name == "nt" else 0
    r = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=flags)
    for enc in ("utf-8", "mbcs"):
        try:
            return r.stdout.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return r.stdout.decode("utf-8", "replace")


# ---------------------------------------------------------------------------------- checks

def check_gpus(rep: Report) -> None:
    if os.name != "nt":
        return
    try:
        ps = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        out = _run([str(ps) if ps.exists() else "powershell", "-NoProfile", "-NonInteractive", "-Command",
                    "Get-CimInstance Win32_VideoController | Select-Object Name,Status,DriverVersion,"
                    "ConfigManagerErrorCode | ConvertTo-Json"])
        data = json.loads(out) if out.strip() else []
        if isinstance(data, dict):
            data = [data]
    except Exception as e:  # noqa: BLE001
        rep.add(WARN, "การ์ดจอ: อ่านรายการไม่ได้", str(e))
        return
    names = [f"{d.get('Name')}  (ไดรเวอร์ {d.get('DriverVersion')}, สถานะ {d.get('Status')})" for d in data]
    bad = [d for d in data if d.get("Status") not in ("OK", None) or (d.get("ConfigManagerErrorCode") or 0) != 0]
    basic = [d for d in data if "basic" in str(d.get("Name", "")).lower()]
    nvidia = [d for d in data if "nvidia" in str(d.get("Name", "")).lower() or "quadro" in str(d.get("Name", "")).lower()]
    bad_nv = [d for d in nvidia if d in bad]
    if bad_nv or ((bad or basic) and len(nvidia) - len(bad_nv) < 2):
        rep.add(FAIL, "การ์ดจอ: มีการ์ดที่ทำงานผิดปกติ หรือไดรเวอร์ไม่ได้ลง",
                "\n".join(names) + "\nแก้: ดู Device Manager > Display adapters (ลงไดรเวอร์ NVIDIA ใหม่ / เช็กการ์ด)")
    elif len(nvidia) < 2:
        rep.add(WARN, f"การ์ดจอ NVIDIA เจอ {len(nvidia)} ใบ (เครื่องนี้ควรมี 2 ใบ)", "\n".join(names))
    else:
        rep.add(OK, f"การ์ดจอ NVIDIA เจอ {len(nvidia)} ใบ ทำงานปกติ", "\n".join(names))


def check_opengl(rep: Report) -> None:
    try:
        import glfw
        import moderngl
        if not glfw.init():
            raise RuntimeError("glfw.init failed")
        try:
            glfw.window_hint(glfw.VISIBLE, False)
            glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
            glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
            glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
            glfw.window_hint(glfw.OPENGL_FORWARD_COMPAT, True)
            win = glfw.create_window(64, 64, "check", None, None)
            if not win:
                raise RuntimeError("could not create an OpenGL 3.3 window")
            glfw.make_context_current(win)
            ctx = moderngl.create_context()
            info = ctx.info
            renderer = f"{info.get('GL_RENDERER')} / OpenGL {info.get('GL_VERSION')}"
            ctx.release()
            glfw.destroy_window(win)
        finally:
            glfw.terminate()
    except Exception as e:  # noqa: BLE001
        rep.add(FAIL, "OpenGL ใช้ไม่ได้ (ไดรเวอร์การ์ดจอมีปัญหา)", str(e))
        return
    low = renderer.lower()
    if "gdi generic" in low or "microsoft" in low or "llvmpipe" in low:
        rep.add(FAIL, "OpenGL วิ่งบนซอฟต์แวร์ ไม่ได้ใช้การ์ดจอ", renderer + "\nแก้: ลงไดรเวอร์ NVIDIA ใหม่")
    elif "nvidia" not in low and "quadro" not in low:
        rep.add(WARN, "OpenGL ไม่ได้ใช้การ์ด NVIDIA", renderer)
    else:
        rep.add(OK, "OpenGL ใช้การ์ด NVIDIA", renderer)


def check_monitors(rep: Report, cfg: dict) -> list:
    import glfw
    from .monitors import list_monitors
    if not glfw.init():
        rep.add(FAIL, "อ่านรายการจอไม่ได้")
        return []
    try:
        mons = list_monitors()
    finally:
        glfw.terminate()
    by = {m.number: m for m in mons}
    listing = "\n".join(f"จอ {m.number}: {m.width}x{m.height} @ {m.refresh} Hz ที่ตำแหน่ง ({m.x},{m.y})"
                        f"{'  จอหลัก' if m.primary else ''}  {m.name}" for m in sorted(mons, key=lambda m: m.number))
    want = list(cfg["stack"]["monitors"]) if cfg["stack"]["enabled"] else [cfg["display"]["monitor"]]
    missing = [n for n in want if n not in by]
    if missing:
        rep.add(FAIL, f"หาจอ {', '.join(map(str, missing))} ไม่เจอ (ตั้งไว้ว่าใช้จอ {', '.join(map(str, want))})",
                listing + "\nแก้: เปิดโปรเจคเตอร์ให้ครบก่อนแล้วรีสตาร์ทเครื่อง, เช็กสาย HDMI, "
                "กด 'โชว์เลขจอ' ดูว่าเลขจอเปลี่ยนไปหรือไม่")
    else:
        rep.add(OK, f"เจอจอครบ {len(want)} จอ ({', '.join(map(str, want))})", listing)
    if not cfg["stack"]["enabled"] and len(mons) > 1:
        rep.add(WARN, f"ตั้งให้ฉายจอเดียว (จอ {want[0]}) ทั้งที่เครื่องมี {len(mons)} จอ",
                "ถ้าเป็นห้องโดม: ติ๊ก 'ใช้หลายจอพร้อมกัน' ในหน้าต่างเริ่มต้น แล้วกดตรวจใหม่")
    if not cfg["display"]["fullscreen"]:
        rep.add(WARN, "ไม่ได้ตั้งเต็มจอ ภาพจะอยู่ในหน้าต่างเล็ก", "แก้: ติ๊ก 'เต็มจอ' ในหน้าต่างเริ่มต้น")
    extra = [m.number for m in mons if m.number not in want]
    if cfg["stack"]["enabled"] and extra:
        rep.add(WARN, f"จอ {', '.join(map(str, sorted(extra)))} ต่ออยู่แต่ไม่อยู่ในรายการจอที่ใช้ (จะเห็นเป็นหน้าจอ Windows)",
                "ถ้าเป็นโปรเจคเตอร์โดม ให้เพิ่มเลขนี้ในช่อง 'จอ:' ถ้าเป็นจอคนคุมไม่ต้องทำอะไร")
    _check_cards(rep, mons, want)
    used = [by[n] for n in want if n in by]
    if used:
        sizes = {(m.width, m.height) for m in used}
        rates = {m.refresh for m in used}
        if len(sizes) > 1:
            rep.add(WARN, "ความละเอียดของแต่ละจอไม่เท่ากัน",
                    ", ".join(f"จอ {m.number} {m.width}x{m.height}" for m in used) +
                    "\nแนะนำ: ตั้งทุกจอเป็นความละเอียดจริงของโปรเจคเตอร์ (ค่า Recommended ใน Display settings) "
                    "ให้เท่ากันทุกจอ แล้วค่อย calibrate")
        else:
            w, h = next(iter(sizes))
            rep.add(OK, f"ความละเอียดทุกจอ {w}x{h}")
        if len(rates) > 1:
            rep.add(WARN, f"รีเฟรชเรตไม่เท่ากัน {sorted(rates)} Hz",
                    "แนะนำ: ตั้งทุกจอเป็น 60 Hz เท่ากัน (Display settings > Advanced display)")
        else:
            rep.add(OK, f"รีเฟรชเรตทุกจอ {next(iter(rates))} Hz")
        # other monitors inside the player's window area get covered by it
        x0, y0 = min(m.x for m in used), min(m.y for m in used)
        x1, y1 = max(m.x + m.width for m in used), max(m.y + m.height for m in used)
        inside = [m for m in mons if m.number not in want and m.x < x1 and m.x + m.width > x0
                  and m.y < y1 and m.y + m.height > y0]
        holes = (x1 - x0) * (y1 - y0) - sum(m.width * m.height for m in used)
        if inside:
            rep.add(WARN, f"จอ {', '.join(str(m.number) for m in inside)} อยู่ในพื้นที่ของโดม จะโดนหน้าต่างเล่นทับ",
                    "แนะนำ: ใน Display settings ลากจอนั้นไปไว้ด้านข้าง ให้จอโดมเรียงต่อกันเป็นแถว")
        elif holes > 0:
            rep.add(WARN, "จอโดมเรียงกันไม่เป็นสี่เหลี่ยม (มีช่องว่าง) หน้าต่างจะใหญ่กว่าที่จำเป็น",
                    "แนะนำ: ใน Display settings จัดจอโดมให้อยู่แถวเดียวกัน ขอบบนตรงกัน")
    return mons


def _check_cards(rep: Report, mons: list, want: list) -> None:
    """Which projector hangs on which graphics card. The picture is drawn by ONE card (the one
    with the Windows main display) and copied to the other, so the main display belongs on the
    card that drives most of the dome."""
    if os.name != "nt":
        return
    try:
        from .monitors import adapters
        ad = adapters()
    except Exception as e:  # noqa: BLE001
        log.warning("could not read the graphics card of each monitor: %s", e)
        return
    cards: dict[str, list[int]] = {}
    names: dict[str, str] = {}
    for n in want:
        if n in ad:
            cards.setdefault(ad[n][1], []).append(n)
            names[ad[n][1]] = ad[n][0]
    if len(cards) < 2:
        return
    listing = "\n".join(f"การ์ดใบที่ {i + 1} ({names[k]}): จอ {', '.join(map(str, v))}"
                        for i, (k, v) in enumerate(cards.items()))
    primary = next((m.number for m in mons if m.primary), None)
    most = max(cards.values(), key=len)
    mine = cards.get(ad[primary][1], []) if primary in ad else []
    if len(mine) < len(most):
        rep.add(WARN, f"จอหลักของ Windows (จอ {primary}) อยู่บนการ์ดจอใบที่ต่อโปรเจคเตอร์น้อยกว่า",
                listing + f"\nแนะนำ: ตั้งจอ {most[0]} เป็นจอหลัก (Display settings > คลิกจอ {most[0]} > "
                "ติ๊ก Make this my main display) ภาพจะลื่นกว่า แล้วกดตรวจใหม่")
    else:
        rep.add(OK, "จอหลักของ Windows อยู่บนการ์ดจอใบที่ต่อโปรเจคเตอร์มากที่สุด", listing)


def _decode_test(path: Path, hwdec: str, limit: int) -> dict:
    """Play the file the way the player does (GPU decode -> OpenGL texture), as fast as it
    can go, for a few seconds. Speed 1.0 = exactly real time; below 1.0 the show stutters."""
    import glfw
    import moderngl
    from .app import import_mpv
    mpv = import_mpv()
    if not glfw.init():
        raise RuntimeError("glfw.init failed")
    player = rc = None
    try:
        glfw.window_hint(glfw.VISIBLE, False)
        glfw.window_hint(glfw.CONTEXT_VERSION_MAJOR, 3)
        glfw.window_hint(glfw.CONTEXT_VERSION_MINOR, 3)
        glfw.window_hint(glfw.OPENGL_PROFILE, glfw.OPENGL_CORE_PROFILE)
        glfw.window_hint(glfw.OPENGL_FORWARD_COMPAT, True)
        win = glfw.create_window(64, 64, "decode test", None, None)
        if not win:
            raise RuntimeError("could not create an OpenGL window")
        glfw.make_context_current(win)
        glfw.swap_interval(0)
        ctx = moderngl.create_context()
        player = mpv.MPV(vo="libmpv", hwdec=hwdec, untimed=True, audio="no", loop_file="inf",
                         video_timing_offset=0, osd_level=0, loglevel="error")
        fn = mpv.MpvGlGetProcAddressFn(lambda _c, name: glfw.get_proc_address(name.decode("utf-8")) or 0)
        rc = mpv.MpvRenderContext(player, "opengl", opengl_init_params={"get_proc_address": fn})
        player.play(str(path))
        fbo = None
        frames = 0
        t_start = time.time()
        p0 = w0 = None
        while True:
            glfw.poll_events()
            now = time.time()
            if now - t_start > 25:
                break
            if fbo is None and player.dwidth:
                w, h = player.dwidth, player.dheight
                sc = min(1.0, limit / max(w, h)) if limit else 1.0
                fbo = ctx.framebuffer(color_attachments=[ctx.texture((int(w * sc), int(h * sc)), 4)])
            if fbo is not None and rc.update():
                rc.render(flip_y=True, opengl_fbo={"w": fbo.width, "h": fbo.height, "fbo": fbo.glo})
                ctx.finish()
                frames += 1
                tp = player.time_pos
                if tp is not None and p0 is None and frames > 10:
                    p0, w0, last, played = tp, now, tp, 0.0
                elif p0 is not None and tp is not None:
                    if tp > last:          # the jump back to 0 when the file loops is not counted
                        played += tp - last
                    last = tp
                if p0 is not None and now - w0 > 5:
                    speed = played / (now - w0)
                    return {"speed": speed, "hw": player.hwdec_current or "no", "w": player.dwidth,
                            "h": player.dheight, "codec": player.video_format or "?",
                            "fps": player.container_fps or 0, "tex": (fbo.width, fbo.height)}
            else:
                time.sleep(0.001)
        raise RuntimeError("the video did not play within 25 s (file damaged or format not supported?)")
    finally:
        try:
            if rc is not None:
                rc.free()
            if player is not None:
                player.terminate()
        except Exception:  # noqa: BLE001
            pass
        glfw.terminate()


def check_video(rep: Report, cfg: dict) -> None:
    path = Path(cfg["video"]["path_resolved"])
    if not path.is_file():
        rep.add(FAIL, "หาไฟล์วิดีโอไม่เจอ", str(path) + "\nแก้: กด 'เลือกไฟล์…' ในหน้าต่างเริ่มต้น")
        return
    size_mb = path.stat().st_size / 1e6
    try:
        r = _decode_test(path, cfg["video"]["hwdec"], int(cfg["render"]["video_texture_size"]))
    except Exception as e:  # noqa: BLE001
        rep.add(FAIL, "เล่นไฟล์วิดีโอไม่ได้", f"{path}\n{e}")
        return
    speed, hw = r["speed"], r["hw"]
    rep.add(OK, f"ไฟล์วิดีโอ {r['w']}x{r['h']} {r['codec']} {r['fps']:.0f} fps ({size_mb:.0f} MB)", str(path))
    fix = ("แก้ (ลองตามลำดับ): 1) ใน config.json ตั้ง render.video_texture_size เป็น 2560  "
           "2) แปลงไฟล์เป็น H.265 (HEVC) ขนาด 2560x2560")
    if hw in ("no", ""):
        rep.add(FAIL if speed < 1.05 else WARN, "การ์ดจอไม่ช่วยถอดรหัสวิดีโอ (ใช้ CPU)",
                f"เล่นได้ {speed:.2f} เท่าของความเร็วจริง (ต้องมากกว่า 1.0)\n{fix}")
    elif speed < 1.0:
        rep.add(FAIL, f"เครื่องเล่นไฟล์นี้ไม่ทัน: ได้แค่ {speed:.2f} เท่าของความเร็วจริง (การ์ด {hw}) ภาพจะกระตุก", fix)
    elif speed < 1.2:
        rep.add(WARN, f"เครื่องเล่นทันแบบเฉียดฉิว {speed:.2f} เท่าของความเร็วจริง (การ์ด {hw})",
                "อาจกระตุกบางช่วงตอนส่งภาพออก 6 จอ\n" + fix)
    else:
        rep.add(OK, f"การ์ดถอดรหัสวิดีโอได้ ({hw}) เร็ว {speed:.1f} เท่าของความเร็วจริง",
                f"ขนาดภาพในการ์ด {r['tex'][0]}x{r['tex'][1]} (ยังไม่รวมงานส่งภาพออก 6 จอ)")


def check_camera(rep: Report, cfg: dict) -> None:
    import cv2
    import numpy as np
    want = int(cfg["calibration"]["camera"])
    found = []
    for idx in range(6):
        cap = None
        for be in ([cv2.CAP_MSMF, cv2.CAP_DSHOW] if os.name == "nt" else [cv2.CAP_ANY]):
            c = cv2.VideoCapture(idx, be)
            if c.isOpened():
                cap = c
                break
            c.release()
        if cap is None:
            continue
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(cfg["calibration"]["camera_width"]))
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(cfg["calibration"]["camera_height"]))
        frames, t0 = [], time.time()
        while time.time() - t0 < 4 and len(frames) < 15:
            ok, f = cap.read()
            if ok and f is not None:
                frames.append(f)
        size = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        cap.release()
        if not frames:
            found.append({"idx": idx, "size": size, "kind": "nopic"})
            continue
        f = frames[-1]
        try:
            cv2.imwrite(str(LOG_DIR / f"check_camera_{idx}.jpg"), f)
        except Exception:  # noqa: BLE001
            pass
        g = np.stack([x.astype(np.float32).mean(axis=2) for x in frames[-5:]])
        noise = float(np.mean(np.abs(np.diff(g, axis=0)))) if len(g) > 1 else 0.0
        found.append({"idx": idx, "size": size, "mean": float(g[-1].mean()), "noise": noise,
                      "kind": "fake" if noise < 0.05 and float(g[-1].std()) < 1.0 else "real"})
    if not found:
        rep.add(WARN, "ไม่เจอกล้องเลย (ต้องใช้ตอน calibrate เท่านั้น)",
                "R50: เปิดกล้อง > Set-up > Choose USB connection app > Video calls/streaming แล้วเสียบ USB")
        return
    desc = {"real": "มีภาพจริง", "fake": "ภาพนิ่ง/ดำ (น่าจะเป็นกล้องปลอม เช่น NDI)", "nopic": "เปิดได้แต่ไม่มีภาพ"}
    lines = "\n".join(f"กล้องเลข {c['idx']}: {c['size'][0]}x{c['size'][1]}  {desc[c['kind']]}"
                      f"{'  <- ที่ตั้งไว้' if c['idx'] == want else ''}" for c in found)
    real = [c for c in found if c["kind"] == "real"]
    mine = next((c for c in found if c["idx"] == want), None)
    if mine and mine["kind"] == "real":
        st = OK if mine["size"][0] >= 1280 else WARN
        rep.add(st, f"กล้องเลข {want} ใช้ได้ ({mine['size'][0]}x{mine['size'][1]})",
                lines + ("" if st == OK else "\nความละเอียดกล้องต่ำ ผลจะหยาบลง"))
    elif len(real) == 1:
        from .config import save_setting
        try:
            save_setting(cfg["_config_path"], "calibration", "camera", real[0]["idx"])
            rep.add(WARN, f"กล้องที่ตั้งไว้ (เลข {want}) ไม่มีภาพ  เปลี่ยนเป็นกล้องเลข {real[0]['idx']} ให้แล้ว", lines)
        except OSError as e:
            rep.add(WARN, f"กล้องที่มีภาพจริงคือเลข {real[0]['idx']} (ตั้งไว้ {want})", f"{lines}\n{e}")
    elif real:
        rep.add(WARN, f"กล้องเลข {want} ไม่มีภาพ ลองกล้องเลข {', '.join(str(c['idx']) for c in real)}",
                lines + "\nเปลี่ยนเลขได้ด้วยปุ่ม [ ] ตอนกด C ดูภาพกล้อง")
    else:
        rep.add(WARN, "ไม่มีกล้องไหนส่งภาพจริง (ต้องใช้ตอน calibrate เท่านั้น)",
                lines + "\nR50: Set-up > Choose USB connection app > Video calls/streaming, เช็กสาย USB/แบต")
    rep.add(OK, "รูปจากกล้องทุกตัวเก็บไว้ที่ logs\\check_camera_<เลข>.jpg")


def check_calibration(rep: Report, cfg: dict, mons: list) -> None:
    from . import backup
    from .config import resolve_path
    folder = resolve_path(cfg["calibration"]["folder"])
    n_bak = len(backup.list_backups(folder))
    f = folder / "calibration.json"
    if not f.exists():
        rep.add(WARN, "ยังไม่ได้ calibrate (ภาพยังไม่ถูกดัดให้เข้ากับโดม)",
                "กด เล่น แล้วกด K สองครั้ง (ห้องมืด กล้องอยู่กลางห้อง หันขึ้นโดม)")
        return
    try:
        info = json.loads(f.read_text(encoding="utf-8"))
        from .calib import solve
        solve.load(folder)            # the player needs every <n>_mesh.npy / <n>_gain.npy too
    except Exception as e:  # noqa: BLE001
        rep.add(FAIL, "ไฟล์ calibrate เสีย หรือไม่ครบ (ตอนเล่นจะไม่ถูกใช้)",
                f"{e}\nแก้: กด 'ย้อนค่า calibrate…' เลือกค่าก่อนหน้า")
        return
    if not cfg["calibration"]["use"] or cfg["calibration"]["simulate"]:
        rep.add(WARN, "config.json: calibration.use ปิดอยู่ หรือ calibration.simulate เปิดอยู่",
                "ค่า calibrate / กล้องจริงจะไม่ถูกใช้  แก้: ตั้ง use เป็น true และ simulate เป็น false")
    by = {m.number: m for m in mons}
    wrong = [f"จอ {n}: ทำไว้ {o['size'][0]}x{o['size'][1]} ตอนนี้ {by[int(n)].width}x{by[int(n)].height}"
             for n, o in info.get("outputs", {}).items()
             if int(n) in by and tuple(o["size"]) != (by[int(n)].width, by[int(n)].height)]
    st = info.get("stats", {})
    detail = (f"ทำเมื่อ {info.get('created')}  โหมด {info.get('mode')}  จอ {info.get('monitors')}\n"
              f"ความสว่างต่างกัน {st.get('uniformity_before', 0)*100:.0f}% -> {st.get('uniformity_after', 0)*100:.0f}%"
              f"  มีค่าสำรอง {n_bak} ชุด")
    want = list(cfg["stack"]["monitors"]) if cfg["stack"]["enabled"] else [cfg["display"]["monitor"]]
    if wrong:
        rep.add(FAIL, "ความละเอียดจอเปลี่ยนไปจากตอน calibrate", detail + "\n" + "\n".join(wrong) +
                "\nแก้: ตั้งความละเอียดกลับเหมือนเดิม หรือ calibrate ใหม่ (K K)")
    elif info.get("monitors") and list(info["monitors"]) != want:
        rep.add(WARN, f"calibrate ไว้กับจอ {info['monitors']} แต่ตอนนี้ตั้งใช้จอ {want}", detail)
    else:
        rep.add(OK, "มีค่า calibrate พร้อมใช้", detail)


def check_misc(rep: Report) -> None:
    free_gb = shutil.disk_usage(APP_DIR).free / 1e9
    rep.add(OK if free_gb > 2 else WARN, f"พื้นที่ว่างในไดรฟ์ {free_gb:.1f} GB")
    if os.name == "nt":
        try:
            import ctypes
            on = ctypes.c_int(0)
            ctypes.windll.user32.SystemParametersInfoW(16, 0, ctypes.byref(on), 0)   # SPI_GETSCREENSAVEACTIVE
            if on.value:
                rep.add(WARN, "Screensaver เปิดอยู่ (อาจขึ้นทับวิดีโอ ถ้าไม่มีใครแตะเมาส์นาน)",
                        "แก้: คลิกขวา Desktop > Personalize > Lock screen > Screen saver > เลือก (None)")
            else:
                rep.add(OK, "Screensaver ปิดอยู่")
        except Exception:  # noqa: BLE001
            pass
    from .watchdog import autostart_command, autostart_enabled, autostart_is_this_folder, autostart_target
    if autostart_enabled() and not autostart_is_this_folder():
        rep.add(FAIL, "เปิดเล่นเองตอนเปิดเครื่อง: ตั้งไว้กับ DomePlayer ที่อยู่โฟลเดอร์อื่น (ย้ายโฟลเดอร์หลังตั้ง?)",
                f"ที่ตั้งไว้: {autostart_target()}\nโฟลเดอร์นี้: {autostart_command()}\n"
                "แก้: ติ๊ก 'เปิดเล่นเองทุกครั้งที่เปิดเครื่อง' แล้วกด เล่น จากโฟลเดอร์นี้ 1 ครั้ง")
    elif autostart_enabled():
        rep.add(OK, "เปิดเล่นเองตอนเปิดเครื่อง: เปิดอยู่")
    else:
        rep.add(WARN, "เปิดเล่นเองตอนเปิดเครื่อง: ปิดอยู่", "ติ๊ก 'เปิดเล่นเองทุกครั้งที่เปิดเครื่อง' แล้วกดเล่น")


def run_checks() -> Report:
    rep = Report()
    try:
        cfg = load_config()
    except ConfigError as e:
        rep.add(FAIL, "config.json เสีย", str(e))
        return rep
    steps = [("gpu", lambda: check_gpus(rep)), ("opengl", lambda: check_opengl(rep))]
    mons: list = []

    def _mons():
        nonlocal mons
        mons = check_monitors(rep, cfg)
    steps += [("monitors", _mons), ("video", lambda: check_video(rep, cfg)),
              ("calibration", lambda: check_calibration(rep, cfg, mons)),
              ("camera", lambda: check_camera(rep, cfg)), ("misc", lambda: check_misc(rep))]
    for name, fn in steps:
        try:
            fn()
        except Exception as e:  # noqa: BLE001 - one broken check must not hide the others
            log.exception("check %s failed", name)
            rep.add(WARN, f"ตรวจ {name} ไม่สำเร็จ", str(e))
    return rep


def main() -> int:
    from .app import setup_logging
    setup_logging("info")
    rep = run_checks()
    LOG_DIR.mkdir(exist_ok=True)
    (LOG_DIR / "check.txt").write_text(rep.text(), encoding="utf-8-sig")
    (LOG_DIR / "check.json").write_text(json.dumps(rep.items, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if any(it["status"] == FAIL for it in rep.items) else 0
