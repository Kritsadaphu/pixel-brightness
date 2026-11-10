"""Start window: pick the video file and the monitor, then press Play.

Choices are saved into config.json, so the next start remembers them. Playback runs in a
separate process (DomePlayer.exe --play) so the player always starts with a clean state.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from .config import APP_DIR, ConfigError, load_config

CONFIG = APP_DIR / "config.json"
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
    CONFIG.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


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
    root.title("DomePlayer")
    root.resizable(False, False)
    font = ("Leelawadee UI", 11)
    big = ("Leelawadee UI", 13, "bold")
    root.option_add("*Font", font)
    ttk.Style(root).configure(".", font=font)

    try:
        raw = _read_raw()
        cfg = load_config()
    except (json.JSONDecodeError, ConfigError) as e:
        if not messagebox.askyesno(
                "DomePlayer", f"config.json เสีย:\n{e}\n\nสร้าง config.json ใหม่เป็นค่าเริ่มต้นไหม?"):
            return 2
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

    def on_stack():
        on = stack.get()
        mon_box.configure(state="disabled" if on else "readonly")
        stack_entry.configure(state="normal" if on else "disabled")

    ttk.Checkbutton(srow, text="ฉายภาพเดียวกันทุกจอ (stack)   จอ:", variable=stack,
                    command=on_stack).pack(side="left")
    stack_entry.pack(side="left", padx=6)
    on_stack()

    opts = ttk.Frame(frm)
    opts.grid(row=5, column=0, columnspan=2, sticky="w", **pad)
    ttk.Checkbutton(opts, text="เต็มจอ", variable=fullscreen).pack(side="left", padx=(0, 16))
    ttk.Checkbutton(opts, text="เปิดเสียง", variable=audio).pack(side="left", padx=(0, 16))
    ttk.Checkbutton(opts, text="โชว์หน้าสถิติ (F1)", variable=stats).pack(side="left")

    def play():
        path = video.get().strip().strip('"')
        if not path or not Path(path).is_file():
            messagebox.showwarning("DomePlayer", "ยังไม่ได้เลือกไฟล์วิดีโอ หรือหาไฟล์ไม่เจอ\nกด \"เลือกไฟล์…\" ก่อน")
            return
        r = _read_raw()
        r.setdefault("video", {})["path"] = path.replace("\\", "/")
        r["video"]["audio"] = bool(audio.get())
        r.setdefault("display", {})["monitor"] = numbers[mon_box.current()]
        r["display"]["fullscreen"] = bool(fullscreen.get())
        r.setdefault("stats", {})["show_on_start"] = bool(stats.get())
        try:
            mon_list = [int(x) for x in stack_list.get().replace(" ", ",").split(",") if x.strip()]
        except ValueError:
            messagebox.showwarning("DomePlayer", "เลขจอต้องเป็นตัวเลขคั่นด้วยจุลภาค เช่น 3, 6, 2, 4, 5, 1")
            return
        r.setdefault("stack", {})["enabled"] = bool(stack.get())
        if mon_list:
            r["stack"]["monitors"] = mon_list
        try:
            _write_raw(r)
            load_config()  # same checks the player does, so errors show here
        except (OSError, ConfigError) as e:
            messagebox.showerror("DomePlayer", f"บันทึก config.json ไม่ได้:\n{e}")
            return
        try:
            subprocess.Popen(_self_command("--play"), cwd=str(APP_DIR))
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("DomePlayer", f"เปิดตัวเล่นไม่ได้:\n{e}")
            return
        root.destroy()

    ttk.Button(frm, text="▶  เล่น", command=play).grid(row=6, column=0, columnspan=2, sticky="we", padx=14, pady=(10, 4), ipady=8)
    ttk.Label(frm, text="ระหว่างเล่น:  F1 สถิติ  |  T ตารางทดสอบ  |  1-9 ดูทีละจอ, 0 ทุกจอ  |  E ปรับมุม  |  Esc ปิด",
              foreground="#555").grid(row=7, column=0, columnspan=2, **pad)

    root.bind("<Return>", lambda _e: play())
    root.mainloop()
    return 0
