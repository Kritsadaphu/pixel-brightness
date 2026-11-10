"""Show a big number on every monitor so you know what to put in display.monitor.

Also writes the list to logs/monitors.txt.
"""
from __future__ import annotations

import os
import sys

from .config import APP_DIR

SECONDS = 20


def main() -> int:
    if os.name == "nt":
        try:  # real pixel positions on scaled (125%, 150%) displays
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            pass

    import glfw
    from .monitors import list_monitors

    if not glfw.init():
        print("GLFW init failed")
        return 1
    mons = list_monitors()
    glfw.terminate()

    lines = [m.describe() for m in sorted(mons, key=lambda m: m.number)]
    text = "\n".join(lines) or "no monitors found"
    print(text)
    (APP_DIR / "logs").mkdir(exist_ok=True)
    (APP_DIR / "logs" / "monitors.txt").write_text(text + "\n", encoding="utf-8")

    import tkinter as tk

    root = tk.Tk()
    root.withdraw()
    colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085", "#7f8c8d", "#2c3e50"]
    wins = []
    for i, m in enumerate(mons):
        w = tk.Toplevel(root)
        w.overrideredirect(True)
        w.geometry(f"{m.width}x{m.height}+{m.x}+{m.y}")
        w.attributes("-topmost", True)
        bg = colors[i % len(colors)]
        w.configure(bg=bg)
        big = max(80, m.height // 2)
        tk.Label(w, text=str(m.number), font=("Arial", big, "bold"), fg="white", bg=bg).pack(expand=True)
        tk.Label(w, text=f'"monitor": {m.number}\n{m.width}x{m.height} @ {m.refresh} Hz   '
                         f'position {m.x},{m.y}\n{m.name}  {m.device}',
                 font=("Arial", max(14, m.height // 40)), fg="white", bg=bg).pack(pady=m.height // 20)
        tk.Label(w, text=f"click or press any key to close (closes by itself in {SECONDS} s)",
                 font=("Arial", max(10, m.height // 70)), fg="white", bg=bg).pack(pady=10)
        w.bind("<Button>", lambda _e: root.destroy())
        w.bind("<Key>", lambda _e: root.destroy())
        wins.append(w)
    if wins:
        wins[0].focus_force()
    root.after(SECONDS * 1000, root.destroy)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
