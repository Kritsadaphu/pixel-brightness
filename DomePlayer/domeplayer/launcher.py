"""Start window: pick the video file and the monitor, then press Play.

Choices are saved into config.json, so the next start remembers them. Playback runs in a
separate process, looked after by the watchdog (DomePlayer.exe --watch), which restarts the
player if it crashes or freezes. Also: readiness check, calibration rollback, problem report,
start with Windows.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import __version__
from .config import APP_DIR, ConfigError, load_config, write_config

CONFIG = APP_DIR / "config.json"
CHECK_LIMIT_S = 240      # the readiness check normally needs 30-90 s
VIDEO_TYPES = [("Video files", "*.mp4 *.mov *.mkv *.m4v *.avi *.ts *.webm"), ("All files", "*.*")]
def _fallback_dirs() -> list[str]:
    dirs = ["C:/YDome/data/videos", "C:/YDome"]
    for var in ("USERPROFILE", "PUBLIC"):
        if os.environ.get(var):
            dirs.append(os.path.join(os.environ[var], "Videos"))
    return dirs + ["C:/"]


def _self_command(*args: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, "-m", "domeplayer", *args]


def _read_raw() -> dict:
    if not CONFIG.exists():
        return {}
    return json.loads(CONFIG.read_text(encoding="utf-8-sig"))


def _write_raw(raw: dict) -> None:
    """Check the settings first (same checks as the player); config.json is only replaced when
    they are fine. Raises ConfigError / OSError and then leaves config.json as it was."""
    tmp = CONFIG.with_name("config.check.json")
    tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        load_config(tmp)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    write_config(CONFIG, raw)


def _monitors() -> list[tuple[int, str]]:
    try:
        import glfw
        from .monitors import list_monitors

        if not glfw.init():
            return []
        try:
            mons = list_monitors()
        finally:
            glfw.terminate()
        return [(m.number, f"จอ {m.number}   {m.width}x{m.height} @ {m.refresh} Hz"
                           + ("   (จอหลัก)" if m.primary else "")) for m in sorted(mons, key=lambda m: m.number)]
    except Exception:  # noqa: BLE001 - the window must still open
        return []


LENS_KINDS = ["action", "equidistant", "none"]
VIDEO_TYPES = (".mp4", ".insv", ".mov", ".lrv")


def newest_recording(roots=None) -> Path | None:
    """The newest video in a DCIM folder of a camera / memory card (any drive but C:)."""
    if roots is None:
        roots = [Path(f"{c}:/DCIM") for c in "DEFGHIJKLMNOPQRSTUVWXYZ"] if os.name == "nt" else []
    best, when = None, 0.0
    for r in roots:
        try:
            if not r.is_dir():
                continue
            for f in r.rglob("*"):
                if f.suffix.lower() in VIDEO_TYPES and f.suffix.lower() != ".lrv" and f.is_file():
                    m = f.stat().st_mtime
                    if m > when:
                        best, when = f, m
        except OSError:
            continue
    return best


def thai_reason(text: str) -> str:
    """The player's (English) reason why a calibration stopped, as advice in Thai."""
    t = (text or "").lower()
    if "over-exposed" in t:
        return "ภาพในกล้องสว่างเกินไป: ตั้งกล้องเป็น Manual แล้วลด ISO หรือความเร็วชัตเตอร์ลง"
    if "too bright with all projectors black" in t:
        return "ตอนโปรเจคเตอร์ฉายสีดำ ภาพกล้องยังสว่างเกิน: ปิดไฟห้อง หรือลดค่าแสงของกล้อง"
    if "did not see any projector" in t or "does not see the projectors" in t:
        return "กล้องไม่เห็นแสงจากโปรเจคเตอร์เลย: โปรเจคเตอร์เปิดอยู่ไหม กล้องหันขึ้นโดมไหม ค่าแสงกล้องมืดเกินไหม"
    if "stopped sending" in t or "no picture from the camera" in t:
        return "กล้องหยุดส่งภาพ: เช็กสาย USB แบตกล้อง หรือกล้องดับเอง"
    if "too slow" in t or "almost no pictures" in t or "could not measure" in t:
        return "กล้องส่งภาพช้าเกินไป: เสียบ USB ตรงเข้าเครื่อง (ไม่ผ่าน hub) แล้วลองใหม่"
    two = " (ถ้ากล้องอัดออกมา 2 ไฟล์ต่อครั้ง ชื่อต่างกันตรง _00_ กับ _10_ ให้ลองอีกไฟล์ด้วย)"
    if "no projector picture" in t or "no projector is visible" in t:
        return ("ในวิดีโอนี้อ่านลายจากโปรเจคเตอร์ไม่ได้: เลนส์ไม่ได้หันไปทางโดม หรือภาพมืด/สว่างเกินไปมาก "
                "เช็กว่าเลนส์หันขึ้นโดมและค่าแสงเป็น Manual แล้วอัดใหม่" + two)
    if "closing flash" in t:
        return ("ไม่เจอแสงกะพริบปิดท้ายในวิดีโอ: หยุดอัดเร็วเกินไป หรือในไฟล์มีการฉายลายมากกว่า 1 รอบ "
                "อัดใหม่: กดอัด > ฉายลาย 1 รอบจนจบ > หยุดอัด")
    if "stuttered" in t:
        return "ตอนฉายลาย โปรแกรมสะดุด ทำให้บางลายขึ้นสั้นเกินไป: ฉายลายใหม่และอัดวิดีโอใหม่"
    if "start flashes were not found" in t:
        return ("หาแสงกะพริบ 3 ครั้งตอนต้นในวิดีโอไม่เจอ: ต้องกดอัดที่กล้องก่อน แล้วค่อยกด 'ฉายลาย' "
                "ห้องต้องมืด กล้องหันขึ้นโดม และล็อกค่าแสงกล้องเป็น Manual" + two)
    if "does not belong to the last pattern show" in t or "no pattern show was run" in t:
        return "ไฟล์วิดีโอนี้ไม่ตรงกับการฉายลายครั้งล่าสุด: ฉายลายใหม่และอัดวิดีโอใหม่ แล้วเลือกไฟล์นั้น"
    if "video ends at pattern" in t or "no picture for pattern" in t or "gaps around" in t:
        return "วิดีโอจบก่อนลายจะหมด หรือภาพขาดช่วง: อัดใหม่ตั้งแต่ก่อนกดฉายลาย จนลายจบ (มีแสงกะพริบปิดท้าย)"
    if "too faint" in t:
        return "แสงในวิดีโอมืดเกินไป: เพิ่ม ISO หรือเปิดหน้ากล้องนานขึ้น แล้วอัดใหม่"
    if "runs" in t and ("late" in t or "early" in t):
        return "เวลาของวิดีโอไม่ตรงกับตอนฉาย (กล้องทำภาพตกหล่น): อัดใหม่ที่ 30 ภาพ/วินาที"
    if "video file could not be opened" in t:
        return "เปิดไฟล์วิดีโอไม่ได้: ก๊อปไฟล์มาไว้ในเครื่องนี้ก่อน (เช่น C:\\DomePlayer) แล้วเลือกใหม่"
    if "could not be opened" in t:
        return "เปิดกล้องไม่ได้: เช็กสาย USB และโหมด webcam ของกล้อง"
    return ""


def main() -> int:
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    root = tk.Tk()
    root.title(f"DomePlayer {__version__}")
    root.resizable(False, False)
    font = ("Leelawadee UI", 11)
    big = ("Leelawadee UI", 13, "bold")
    root.option_add("*Font", font)
    ttk.Style(root).configure(".", font=font)

    try:
        raw = _read_raw()
        cfg = load_config()
    except (ValueError, OSError, ConfigError) as e:
        if not messagebox.askyesno(
                "DomePlayer", f"config.json เสีย:\n{e}\n\nสร้าง config.json ใหม่เป็นค่าเริ่มต้นไหม?\n"
                              "(ไฟล์เดิมจะถูกเก็บไว้เป็น config.broken-วันที่.json)"):
            return 2
        try:      # keep the broken file: it still holds the projector alignment and other settings
            shutil.copyfile(CONFIG, CONFIG.with_name(time.strftime("config.broken-%Y%m%d-%H%M%S.json")))
        except OSError:
            pass
        raw = {}
        _write_raw(raw)
        cfg = load_config()

    video = tk.StringVar(value=cfg["video"]["path_resolved"] if raw.get("video", {}).get("path") else "")
    fullscreen = tk.BooleanVar(value=cfg["display"]["fullscreen"])
    stats = tk.BooleanVar(value=cfg["stats"]["show_on_start"])
    audio = tk.BooleanVar(value=cfg["video"]["audio"])

    pad = {"padx": 14, "pady": 6}
    frm = ttk.Frame(root, padding=10)
    frm.grid()

    ttk.Label(frm, text="1) ไฟล์วิดีโอ (Domemaster)", font=big).grid(row=0, column=0, columnspan=2, sticky="w", **pad)
    entry = ttk.Entry(frm, textvariable=video, width=62)
    entry.grid(row=1, column=0, sticky="we", padx=(14, 4))

    def browse():
        cur = Path(video.get())
        cands = ([str(cur.parent)] if video.get() else []) + _fallback_dirs()
        start = next((d for d in cands if Path(d).is_dir()), "C:/")
        chosen = filedialog.askopenfilename(parent=root, title="เลือกไฟล์วิดีโอ",
                                            initialdir=start, filetypes=VIDEO_TYPES)
        if chosen:
            video.set(chosen)

    ttk.Button(frm, text="เลือกไฟล์…", command=browse).grid(row=1, column=1, padx=(4, 14))

    ttk.Label(frm, text="2) ฉายออกจอไหน", font=big).grid(row=2, column=0, columnspan=2, sticky="w", **pad)
    mons = _monitors()
    labels = [label for _, label in mons] or [f"จอ {cfg['display']['monitor']}"]
    numbers = [n for n, _ in mons] or [cfg["display"]["monitor"]]
    mon_box = ttk.Combobox(frm, values=labels, state="readonly", width=60)
    current = cfg["display"]["monitor"]
    mon_box.current(numbers.index(current) if current in numbers else 0)
    mon_box.grid(row=3, column=0, sticky="we", padx=(14, 4))

    def identify():
        try:
            subprocess.Popen(_self_command("--identify"), cwd=str(APP_DIR))
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("DomePlayer", str(e))

    ttk.Button(frm, text="โชว์เลขจอ", command=identify).grid(row=3, column=1, padx=(4, 14))

    stack = tk.BooleanVar(value=cfg["stack"]["enabled"])
    stack_list = tk.StringVar(value=", ".join(map(str, cfg["stack"]["monitors"])))
    srow = ttk.Frame(frm)
    srow.grid(row=4, column=0, columnspan=2, sticky="w", padx=14, pady=(8, 0))
    stack_entry = ttk.Entry(srow, textvariable=stack_list, width=22)
    auto = tk.BooleanVar(value=bool(cfg["stack"].get("auto")))
    arow = ttk.Frame(frm)
    arow.grid(row=5, column=0, columnspan=2, sticky="w", padx=14)
    auto_box = ttk.Checkbutton(arow, variable=auto,
                               text="เลือกจอให้เอง: ใช้ทุกจอยกเว้นจอหลักของ Windows (แนะนำ เลขจอเปลี่ยนก็ไม่เป็นไร)")

    def on_stack():
        on = stack.get()
        mon_box.configure(state="disabled" if on else "readonly")
        stack_entry.configure(state="normal" if on and not auto.get() else "disabled")
        auto_box.configure(state="normal" if on else "disabled")

    auto_box.configure(command=on_stack)
    auto_box.pack(side="left", padx=(22, 0))
    ttk.Checkbutton(srow, text="ใช้หลายจอพร้อมกัน (โปรเจคเตอร์โดม)   จอ:", variable=stack,
                    command=on_stack).pack(side="left")
    stack_entry.pack(side="left", padx=6)
    on_stack()

    opts = ttk.Frame(frm)
    opts.grid(row=6, column=0, columnspan=2, sticky="w", **pad)
    ttk.Checkbutton(opts, text="เต็มจอ", variable=fullscreen).pack(side="left", padx=(0, 16))
    ttk.Checkbutton(opts, text="เปิดเสียง", variable=audio).pack(side="left", padx=(0, 16))
    ttk.Checkbutton(opts, text="โชว์หน้าสถิติ (F1)", variable=stats).pack(side="left")

    from . import watchdog
    autostart = tk.BooleanVar(value=watchdog.autostart_enabled())
    ttk.Checkbutton(frm, text="เปิดเล่นเองทุกครั้งที่เปิดเครื่อง (และเปิดใหม่เองถ้าโปรแกรมค้าง/ปิดไปเอง)",
                    variable=autostart).grid(row=9, column=0, columnspan=2, sticky="w", padx=14, pady=(0, 4))

    def save_choices(need_file: bool) -> bool:
        """Write what is chosen in this window into config.json. False = not saved (message shown)."""
        path = video.get().strip().strip('"')
        if need_file and (not path or not Path(path).is_file()):
            messagebox.showwarning("DomePlayer", "ยังไม่ได้เลือกไฟล์วิดีโอ หรือหาไฟล์ไม่เจอ\nกด \"เลือกไฟล์…\" ก่อน")
            return False
        try:
            r = _read_raw()
        except (ValueError, OSError) as e:
            messagebox.showerror("DomePlayer", f"อ่าน config.json ไม่ได้:\n{e}")
            return False
        if path:
            r.setdefault("video", {})["path"] = path.replace("\\", "/")
        r.setdefault("video", {})["audio"] = bool(audio.get())
        r.setdefault("display", {})["monitor"] = numbers[mon_box.current()]
        r["display"]["fullscreen"] = bool(fullscreen.get())
        r.setdefault("stats", {})["show_on_start"] = bool(stats.get())
        try:
            mon_list = [int(x) for x in stack_list.get().replace(" ", ",").split(",") if x.strip()]
        except ValueError:
            messagebox.showwarning("DomePlayer", "เลขจอต้องเป็นตัวเลขคั่นด้วยจุลภาค เช่น 3, 6, 2, 4, 5, 1")
            return False
        r.setdefault("stack", {})["enabled"] = bool(stack.get())
        r["stack"]["auto"] = bool(auto.get())
        if mon_list:
            r["stack"]["monitors"] = mon_list
        try:
            _write_raw(r)      # same checks the player does; config.json is replaced only if they pass
        except (OSError, ConfigError) as e:
            messagebox.showerror("DomePlayer", f"บันทึก config.json ไม่ได้:\n{e}")
            return False
        return True

    def play():
        if not save_choices(need_file=True):
            return
        if watchdog.is_running():      # Play pressed twice, or the power-on start is still running
            if not messagebox.askyesno(
                    "DomePlayer", "DomePlayer เปิดอยู่แล้ว (กำลังเล่น หรือเพิ่งเปิดเครื่องและกำลังรอโปรเจคเตอร์)\n\n"
                                  "ปิดตัวเดิม แล้วเริ่มเล่นใหม่ไหม?"):
                return
            status.set("กำลังปิดตัวเดิม…")
            root.update()
            gone = watchdog.request_stop()
            status.set("")
            if not gone:
                messagebox.showerror("DomePlayer", "ปิดตัวเดิมไม่สำเร็จ\nกด Esc ที่หน้าจอเล่น หรือรีสตาร์ทเครื่อง แล้วลองใหม่")
                return
        try:
            c = load_config()
            want = list(c["stack"]["monitors"]) if c["stack"]["enabled"] else [c["display"]["monitor"]]
            have = [n for n, _ in _monitors()]
            if c["stack"]["enabled"] and c["stack"].get("auto"):
                want = []          # the player takes whatever displays are there
                if len(have) == 1 and c["display"]["fullscreen"] and not messagebox.askyesno(
                        "DomePlayer", "เครื่องนี้เห็นจอเดียว (ไม่เจอโปรเจคเตอร์)\n"
                                      "ถ้าเล่นตอนนี้ ภาพจะขึ้นเต็มจอนี้ (กด Esc เพื่อปิด)\n\nเล่นเลยไหม?"):
                    return
            missing = [n for n in want if n not in have]
        except Exception:  # noqa: BLE001 - only a courtesy question, never block Play
            c, have, missing = None, [], []
        if c is not None and c["display"]["fullscreen"] and have and missing:
            if not messagebox.askyesno(
                    "DomePlayer", f"หาจอ {', '.join(map(str, missing))} ไม่เจอ "
                                  "(โปรเจคเตอร์ยังไม่เปิด หรือเลขจอเปลี่ยน)\n"
                                  f"ตอนนี้เจอจอ: {', '.join(map(str, have))}\n\n"
                                  "เล่นเฉพาะจอที่เจอไปก่อนไหม?\n(ไม่ = กลับไปแก้  กด 'โชว์เลขจอ' เพื่อดูเลขจอ)"):
                return
        try:
            watchdog.set_autostart(bool(autostart.get()))
        except OSError as e:
            messagebox.showwarning("DomePlayer", f"ตั้งเปิดเองตอนเปิดเครื่องไม่ได้:\n{e}")
        try:
            subprocess.Popen(_self_command("--watch"), cwd=str(APP_DIR))
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("DomePlayer", f"เปิดตัวเล่นไม่ได้:\n{e}")
            return
        open_panel()

    def open_panel():
        """Control panel: what the player is doing, in Thai, and buttons that press its keys.
        The player's own texts appear on the dome (first projector), which is hard to read."""
        from . import remote
        win = tk.Toplevel(root)
        win.title(f"DomePlayer {__version__} - แผงควบคุม")
        win.resizable(False, False)
        root.withdraw()
        head = tk.StringVar(value="กำลังเปิดตัวเล่น…")
        detail = tk.StringVar(value="")
        ttk.Label(win, textvariable=head, font=big).grid(row=0, column=0, sticky="w", padx=14, pady=(12, 2))
        ttk.Label(win, textvariable=detail, wraplength=700, justify="left").grid(row=1, column=0, sticky="w", padx=14)
        pic = ttk.Label(win)
        pic.grid(row=2, column=0, padx=14, pady=4)
        state = {"shot": 0.0, "img": None, "t0": time.time(), "seen": False}

        def key(name):
            return lambda: remote.send("key " + name)

        def box(title, row):
            f = ttk.LabelFrame(win, text=title, padding=6)
            f.grid(row=row, column=0, sticky="we", padx=14, pady=4)
            return f

        def buttons(frame, items):
            for i, (label, command) in enumerate(items):
                ttk.Button(frame, text=label, command=command).grid(row=0, column=i, padx=3, ipady=2)

        buttons(box("ดูภาพ", 3), [
            ("ตาราง / ขาว / วิดีโอ  (T)", key("T")), ("หยุด / เล่นต่อ", key("SPACE")),
            ("เริ่มวิดีโอใหม่", key("HOME")), ("หน้าสถิติ (F1)", key("F1")),
            ("เปิด / ปิดผล calibrate (U)", key("U"))])

        def calibrate():
            if messagebox.askyesno(
                    "DomePlayer", "เริ่ม calibrate ด้วยกล้อง?\n\n"
                    "- ปิดไฟห้องแล้ว\n- กล้องอยู่กลางห้อง หันขึ้นโดม เห็นขอบโดมครบทั้งวง\n"
                    "- ใช้เวลา 2-3 นาที ห้ามขยับกล้อง ห้ามเดินผ่านหน้ากล้อง\n"
                    "- ช่อง 'เลนส์กล้อง' ด้านล่างต้องตรงกับกล้อง (R50 = เลนส์ปกติ)\n\n"
                    "(ค่าเดิมจะถูกเก็บสำรองไว้ ย้อนกลับได้)", parent=win):
                remote.send("calibrate")

        def show_patterns():
            if messagebox.askyesno(
                    "DomePlayer", "ฉายลายให้กล้องอัดวิดีโอ?\n\n"
                    "ทำตามลำดับ:\n1. วางกล้องกลางห้อง เลนส์หันขึ้นโดม ปิดไฟห้อง\n"
                    "2. Ace Pro 2: FreeFrame Video, 4K 4:3, มุมกว้างสุด, ปิดกันสั่น, ค่าแสง Manual\n"
                    "   (ดูในจอกล้องว่าเห็นขอบโดมครบทั้งวง)\n"
                    "3. กดอัดวิดีโอที่กล้อง แล้วออกห่างจากกล้อง\n4. กด Yes ที่นี่\n\n"
                    "ลายจะฉาย 3 นาทีกว่า (เริ่มและจบด้วยแสงขาวกะพริบ) จบแล้วค่อยหยุดอัด", parent=win):
                remote.send("show")

        def pick_video():
            f = filedialog.askopenfilename(
                parent=win, title="เลือกไฟล์วิดีโอที่กล้องอัดไว้",
                filetypes=[("Video", "*.mp4 *.mov *.insv *.lrv *.mkv *.avi *.m4v *.360"), ("All files", "*.*")])
            if f:
                remote.send("video " + f)

        def from_camera():
            """The newest video on the camera (plugged in by USB as a drive, or its card in a reader)."""
            since = (remote.read_status() or {}).get("show_done") or 0
            f = newest_recording()
            if f is None:
                messagebox.showinfo(
                    "DomePlayer", "ไม่พบกล้องหรือการ์ดของกล้อง\n\n"
                    "เสียบ Ace Pro 2 ด้วยสาย USB แล้วเลือก U-Disk / File Transfer ที่จอกล้อง\n"
                    "(หรือถอดการ์ด microSD มาเสียบเครื่องนี้) แล้วกดปุ่มนี้อีกครั้ง\n\n"
                    "หรือกด 'เลือกไฟล์เอง…'", parent=win)
                return
            st_ = f.stat()
            old = ("\n\n⚠ ไฟล์นี้ถูกอัดก่อนการฉายลายรอบล่าสุด อาจไม่ใช่ไฟล์ที่ต้องการ"
                   if since and st_.st_mtime < since - 30 else "")
            if messagebox.askyesno(
                    "DomePlayer", f"ใช้ไฟล์ล่าสุดในกล้อง?\n\n{f}\n"
                    f"อัดเมื่อ {time.strftime('%d/%m %H:%M', time.localtime(st_.st_mtime))}   "
                    f"ขนาด {st_.st_size / 1e6:.0f} MB{old}\n\n"
                    "ห้ามถอดสายกล้องจนกว่าจะอ่านเสร็จ", parent=win):
                remote.send("video " + str(f))

        vf = box("calibrate ด้วย Insta360 Ace Pro 2 (อัดวิดีโอ แล้วให้โปรแกรมอ่านไฟล์จากกล้อง)", 4)
        buttons(vf, [("1) ฉายลายให้กล้องอัด", show_patterns), ("2) อ่านไฟล์ล่าสุดจากกล้อง", from_camera),
                     ("เลือกไฟล์เอง…", pick_video), ("3) ดูภาพจากวิดีโอ (ปรับวงกลม)", lambda: remote.send("still")),
                     ("ยกเลิก", lambda: remote.send("cancel"))])
        lens = tk.StringVar(value="")
        ttk.Label(vf, text=" เลนส์:").grid(row=0, column=5)
        lens_box = ttk.Combobox(vf, textvariable=lens, state="readonly", width=20,
                                values=["Ace Pro 2 (กล้องแอ็กชัน)", "ฟิชอายธรรมดา", "ไม่แก้เลนส์ (กล้อง 360)"])
        lens_box.grid(row=0, column=6, padx=4)
        lens_box.bind("<<ComboboxSelected>>",
                      lambda _e: remote.send("lenstype " + LENS_KINDS[lens_box.current()]))
        state["lens_box"] = lens_box

        try:
            usb = bool(load_config()["calibration"].get("usb_camera"))
        except Exception:  # noqa: BLE001
            usb = False
        if usb:
            buttons(box("calibrate ด้วยกล้อง USB (ภาพสด)", 7), [
                ("เปิด / ปิดภาพกล้อง (C)", key("C")), ("กล้องตัวถัดไป", key("RIGHT_BRACKET")),
                ("กล้องตัวก่อนหน้า", key("LEFT_BRACKET")), ("▶ เริ่ม calibrate", calibrate),
                ("ยกเลิก calibrate", lambda: remote.send("cancel"))])

        big_step = tk.BooleanVar(value=False)

        def circle(name):
            return lambda: remote.send("key " + name + (" shift" if big_step.get() else ""))

        cf = box("ขอบวงกลมโดม (เปิดภาพกล้อง หรือ ภาพจากวิดีโอ ก่อน แล้วปรับให้วงกลมทับขอบโดมพอดี)", 5)
        buttons(cf, [("◀", circle("LEFT")), ("▲", circle("UP")), ("▼", circle("DOWN")), ("▶", circle("RIGHT")),
                     ("ใหญ่ขึ้น", circle("EQUAL")), ("เล็กลง", circle("MINUS")),
                     ("หมุน FRONT ⟲", circle("COMMA")), ("หมุน FRONT ⟳", circle("PERIOD")),
                     ("หาเอง", key("A")), ("บันทึกวงกลม", lambda: remote.send("key S ctrl"))])
        ttk.Checkbutton(cf, text="ทีละ 10", variable=big_step).grid(row=0, column=10, padx=6)

        def stop_show():
            if messagebox.askyesno("DomePlayer", "ปิดการฉายตอนนี้เลยไหม?", parent=win):
                head.set("กำลังปิดตัวเล่น…")
                win.update()
                watchdog.request_stop(limit_s=8)

        def back():
            win.destroy()
            root.deiconify()

        end = ttk.Frame(win)
        end.grid(row=8, column=0, sticky="we", padx=14, pady=(6, 12))
        ttk.Button(end, text="■ ปิดการฉาย", command=stop_show).pack(side="left", ipady=3, ipadx=10)
        ttk.Button(end, text="กลับหน้าตั้งค่า (การฉายไม่หยุด)", command=back).pack(side="right", ipady=3)
        win.protocol("WM_DELETE_WINDOW", back)

        def describe(st: dict) -> tuple[str, str]:
            lines = []
            if st["state"] == "capture":
                h = (f"กำลังถ่ายลาย {st.get('progress', 0) * 100:.0f}%   เหลือประมาณ {st.get('eta', 0)} วินาที   "
                     "ห้ามขยับกล้อง ห้ามเดินผ่าน")
                if st.get("monitor"):
                    lines.append(f"ตอนนี้ถ่ายจอ {st['monitor']}")
                if st.get("skipped"):
                    lines.append("กล้องไม่เห็นจอ " + ", ".join(map(str, st["skipped"])) + " (ข้ามไป จอนั้นจะดำ)")
            elif st["state"] == "show":
                h = (f"กำลังฉายลายให้กล้องอัด {st.get('progress', 0) * 100:.0f}%   เหลือประมาณ {st.get('eta', 0)} วินาที   "
                     "อย่าหยุดอัดจนกว่าจะจบ")
            elif st["state"] == "read":
                h = f"กำลังอ่านไฟล์วิดีโอ {st.get('progress', 0) * 100:.0f}%  (อาจนานหลายนาที)"
            elif st["state"] == "solve":
                h = f"กำลังคำนวณ {st.get('progress', 0) * 100:.0f}%"
            elif st.get("preview"):
                h = "หน้าภาพกล้อง (ภาพเดียวกับที่ขึ้นบนโดม)"
            else:
                h = ["กำลังเล่นวิดีโอ", "ตารางทดสอบ", "สีขาวทุกเครื่อง"][int(st.get("test", 0)) % 3]
                if st.get("paused") and not st.get("test"):
                    h += "  (หยุดชั่วคราว)"
            outs = ", ".join(map(str, st.get("outputs", [])))
            cal = st.get("calibrated") or []
            lines.append(f"จอที่ใช้: {outs}      วาด {st.get('fps', 0):.0f} ภาพ/วินาที  วิดีโอ {st.get('video_fps', 0):.0f} ภาพ/วินาที")
            if cal:
                lines.append("ผล calibrate: มีของจอ " + ", ".join(map(str, cal))
                             + ("  (ใช้อยู่)" if st.get("cal_use") else "  (ปิดไว้ กด U เพื่อเปิด)"))
            else:
                lines.append("ผล calibrate: ยังไม่มี (ภาพจะยังไม่เข้ารูปโดม)")
            cam = st.get("camera")
            if cam and cam.get("index") == -2:
                lines.append(f"ภาพนิ่งจากการ calibrate ครั้งล่าสุด ({cam['size'][0]}x{cam['size'][1]}): "
                             "ใช้ปรับวงกลมโดม แล้วกด 'บันทึกวงกลม'")
                if st.get("circle_dirty"):
                    lines.append("วงกลมโดมถูกแก้แล้วแต่ยังไม่ได้บันทึก กด 'บันทึกวงกลม'")
            elif cam:
                t = f"กล้อง {cam['index']}: {cam['size'][0]}x{cam['size'][1]}  {cam['fps']} ภาพ/วินาที  สว่างเกิน {cam['over']}%"
                if cam.get("black"):
                    t += "   ← ภาพดำสนิท น่าจะไม่ใช่กล้องตัวจริง กด 'กล้องตัวถัดไป'"
                elif cam["over"] > 1:
                    t += "   ← สว่างเกิน ลด ISO ที่กล้อง"
                elif 0 < cam["fps"] < 15:
                    t += "   ← ช้า (ควรได้ราว 30)"
                lines.append(t)
                if st.get("circle_dirty"):
                    lines.append("วงกลมโดมถูกแก้แล้วแต่ยังไม่ได้บันทึก กด 'บันทึกวงกลม'")
            if st.get("show_done") and not (st.get("result") or {}).get("at", 0) > st["show_done"]:
                lines.append("ฉายลายจบแล้วเมื่อ " + time.strftime("%H:%M", time.localtime(st["show_done"]))
                             + ": หยุดอัดที่กล้อง เสียบกล้องเข้าเครื่องนี้ด้วย USB (เลือก U-Disk) แล้วกด '2) อ่านไฟล์ล่าสุดจากกล้อง'")
            box_ = state.get("lens_box")
            if box_ is not None and st.get("lens_type") in LENS_KINDS:      # show what the player uses
                want = LENS_KINDS.index(st["lens_type"])
                if box_.current() != want:
                    box_.current(want)
            res = st.get("result")
            if res:
                when = time.strftime("%H:%M", time.localtime(res.get("at", 0)))
                if res.get("ok"):
                    t = (f"calibrate เสร็จเมื่อ {when}: ได้ {len(res.get('outputs', []))} จอ  "
                         f"แสงต่างกัน {res.get('before')}% → {res.get('after')}%")
                    if res.get("skipped"):
                        t += ("\n⚠ กล้องไม่เห็นจอ " + ", ".join(map(str, res["skipped"]))
                              + " เลย จอนั้นจะดำ (ถ้าเป็นโปรเจคเตอร์โดม ให้เปิดเครื่องแล้ว calibrate ใหม่)")
                    for w in res.get("warnings", []):
                        if "edge of the camera picture" in w:
                            t += "\n⚠ วงกลมโดมชนขอบภาพกล้อง: กล้องเห็นโดมไม่ครบ ส่วนที่ไม่เห็นจะดำ"
                        elif "only part of monitor" in w:
                            t += "\n⚠ กล้องเห็นภาพของบางจอไม่ครบ: " + w.split("monitor", 1)[-1].strip()
                    lines.append(t)
                else:
                    lines.append(f"calibrate ไม่สำเร็จเมื่อ {when} (ค่าเดิมไม่ถูกเปลี่ยน): "
                                 + (thai_reason(res.get("text", "")) or res.get("text", "")))
            if st.get("toast"):
                lines.append("ข้อความบนโดม: " + st["toast"].replace("\n", "  "))
            for m in st.get("messages", []):
                lines.append("⚠ " + m.replace("\n", "  "))
            return h, "\n".join(lines)

        def tick():
            if not win.winfo_exists():
                return
            st = remote.read_status()
            if st is None:
                if watchdog.is_running():
                    head.set("กำลังเปิดตัวเล่น…" if not state["seen"] else "ตัวเล่นไม่ตอบ (ถ้าเกิน 30 วินาที จะถูกเปิดใหม่เอง)")
                elif state["seen"] or time.time() - state["t0"] > 15:
                    head.set("ตัวเล่นปิดแล้ว")
                    detail.set("กด 'กลับหน้าตั้งค่า' แล้วกด เล่น เพื่อเริ่มใหม่\nถ้าปิดไปเองโดยไม่ได้สั่ง ดู logs\\domeplayer.log")
                pic.configure(image="")
            else:
                state["seen"] = True
                try:
                    h, d = describe(st)
                    head.set(h)
                    detail.set(d)
                except Exception as e:  # noqa: BLE001 - a new field must never break the panel
                    detail.set(str(e))
                if st.get("preview"):
                    try:
                        mt = remote.PREVIEW.stat().st_mtime
                        if mt != state["shot"]:
                            img = tk.PhotoImage(file=str(remote.PREVIEW))
                            if img.height() > 230:        # the panel must fit a 900-line screen
                                img = img.subsample(2)
                            state["img"] = img
                            state["shot"] = mt
                            pic.configure(image=state["img"])
                    except (OSError, tk.TclError):
                        pass      # being written right now: next time
                else:
                    pic.configure(image="")
            win.after(400, tick)

        tick()

    ttk.Button(frm, text="▶  เล่น", command=play).grid(row=7, column=0, columnspan=2, sticky="we", padx=14, pady=(10, 4), ipady=8)
    ttk.Label(frm, text="ระหว่างเล่น:  F1 สถิติ  |  T ตารางทดสอบ  |  1-9 ดูทีละจอ, 0 ทุกจอ  |  E ปรับมุม  |  Esc ปิด",
              foreground="#555").grid(row=8, column=0, columnspan=2, **pad)

    # ---- tools: readiness check, calibration rollback, problem report -------------------
    tools = ttk.Frame(frm)
    tools.grid(row=10, column=0, columnspan=2, sticky="we", padx=14, pady=(6, 10))
    status = tk.StringVar(value="")
    ttk.Label(frm, textvariable=status, foreground="#a60").grid(row=11, column=0, columnspan=2, sticky="w", padx=14)

    def show_text(title: str, text: str) -> None:
        win = tk.Toplevel(root)
        win.title(title)
        txt = tk.Text(win, width=100, height=34, wrap="word", font=("Leelawadee UI", 11))
        sb = ttk.Scrollbar(win, command=txt.yview)
        txt.configure(yscrollcommand=sb.set)
        txt.tag_configure("ok", foreground="#080")
        txt.tag_configure("warn", foreground="#b60")
        txt.tag_configure("fail", foreground="#c00", font=("Leelawadee UI", 11, "bold"))
        for line in text.splitlines():
            tag = ("fail" if line.startswith("❌") else "warn" if line.startswith("⚠") else
                   "ok" if line.startswith("✅") else "")
            txt.insert("end", line + "\n", tag)
        txt.configure(state="disabled")
        txt.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

    def check():
        if not save_choices(need_file=False):      # check what is chosen on screen, not the old file
            return
        f = APP_DIR / "logs" / "check.txt"
        try:
            f.unlink()                             # never show an old result
        except OSError:
            pass
        status.set("กำลังตรวจความพร้อม… ประมาณ 30-90 วินาที (อย่าเพิ่งปิด)")
        for b in tool_buttons:
            b.configure(state="disabled")
        t0 = time.time()
        try:
            proc = subprocess.Popen(_self_command("--check"), cwd=str(APP_DIR))
        except Exception as e:  # noqa: BLE001
            status.set("")
            for b in tool_buttons:
                b.configure(state="normal")
            messagebox.showerror("DomePlayer", str(e))
            return

        def wait():
            if proc.poll() is None:
                if time.time() - t0 < CHECK_LIMIT_S:
                    root.after(500, wait)
                    return
                proc.kill()        # stuck (usually a camera driver): end it so it does not keep the camera
            for b in tool_buttons:
                b.configure(state="normal")
            status.set("")
            try:
                fresh = f.stat().st_mtime >= t0 - 2      # written by THIS run
            except OSError:
                fresh = False
            if fresh:
                show_text("DomePlayer - ตรวจความพร้อม", f.read_text(encoding="utf-8-sig"))
            else:
                messagebox.showerror("DomePlayer", "ตรวจไม่สำเร็จ (โปรแกรมตรวจค้างหรือปิดตัวเอง)\n"
                                     "ถ้ากล้องเสียบอยู่ ลองถอดสาย USB กล้องแล้วกดตรวจใหม่\nดู logs\\domeplayer.log")
        root.after(500, wait)

    def rollback():
        from . import backup
        from .config import resolve_path
        try:
            c = load_config()
        except ConfigError as e:
            messagebox.showerror("DomePlayer", str(e))
            return
        folder = resolve_path(c["calibration"]["folder"])
        baks = backup.list_backups(folder)
        if not baks:
            messagebox.showinfo("DomePlayer", "ยังไม่มีค่า calibrate สำรอง\n(จะมีหลังจาก calibrate ครั้งที่ 2 เป็นต้นไป)")
            return
        reasons = {"before new calibration": "ก่อน calibrate ใหม่", "before dome circle change": "ก่อนแก้วงกลมโดม",
                   "before restore": "ก่อนย้อนค่า"}
        win = tk.Toplevel(root)
        win.title("ย้อนค่า calibrate")
        ttk.Label(win, text="เลือกชุดที่ต้องการใช้ (ทำเมื่อ … / เก็บสำรองเมื่อ …)").pack(anchor="w", padx=12, pady=(10, 4))
        lb = tk.Listbox(win, width=90, height=min(15, len(baks)), font=("Leelawadee UI", 11))
        for b in baks:
            st = b["stats"] or {}
            lb.insert("end", f"ทำเมื่อ {b['created']}   (สำรองเมื่อ {b['saved']} {reasons.get(b['reason'], b['reason'])})"
                             f"   โหมด {b['mode']}   แสงต่างกัน {st.get('uniformity_after', 0)*100:.0f}%")
        lb.selection_set(0)
        lb.pack(padx=12, pady=4)

        def do():
            sel = lb.curselection()
            if not sel:
                return
            b = baks[sel[0]]
            if not messagebox.askyesno("DomePlayer", f"ใช้ค่า calibrate ที่ทำเมื่อ {b['created']} ?\n"
                                       "(ค่าปัจจุบันจะถูกเก็บสำรองไว้ก่อน ย้อนกลับได้)", parent=win):
                return
            try:
                backup.restore(folder, Path(c["_config_path"]), b["path"])
            except Exception as e:  # noqa: BLE001
                messagebox.showerror("DomePlayer", f"ย้อนค่าไม่สำเร็จ:\n{e}", parent=win)
                return
            win.destroy()
            messagebox.showinfo("DomePlayer", "ย้อนค่าแล้ว กด เล่น ได้เลย")
        ttk.Button(win, text="ใช้ค่านี้", command=do).pack(pady=(4, 12), ipadx=20)

    def report():
        status.set("กำลังรวบรวมข้อมูล…")
        root.update()
        try:
            from .report import make_report
            z = make_report()
        except Exception as e:  # noqa: BLE001
            status.set("")
            messagebox.showerror("DomePlayer", f"สร้างไฟล์ไม่สำเร็จ:\n{e}")
            return
        status.set("")
        if os.name == "nt":
            try:
                subprocess.Popen(["explorer", "/select,", str(z)])
            except Exception:  # noqa: BLE001
                pass
        messagebox.showinfo("DomePlayer", f"สร้างไฟล์แล้ว:\n{z}\n\nส่งไฟล์นี้ให้ช่างได้เลย")

    tool_buttons = [
        ttk.Button(tools, text="แผงควบคุม", command=open_panel),
        ttk.Button(tools, text="ตรวจความพร้อม", command=check),
        ttk.Button(tools, text="ย้อนค่า calibrate…", command=rollback),
        ttk.Button(tools, text="เก็บข้อมูลส่งช่าง (zip)", command=report),
    ]
    for i, b in enumerate(tool_buttons):
        b.grid(row=0, column=i, sticky="we", padx=(0 if i == 0 else 6, 0), ipady=3)
        tools.columnconfigure(i, weight=1)

    root.bind("<Return>", lambda _e: play())
    root.mainloop()
    return 0
