"""YDome-Fix.exe: a small program of its own (separate from DomePlayer) that puts good copies of
YDome's two settings files back when they are blank. The good files (dome.proj, config.xml) lie
in the same folder as this program. The work itself is in domeplayer/ydome.py.

    YDome-Fix.exe              ask, then repair
    YDome-Fix.exe --self-test  exit 0 when the repair files are next to the program
"""
import sys
from pathlib import Path

from domeplayer import ydome

HERE = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
TITLE = "ซ่อม YDome"


def main() -> int:
    ydome.KIT = HERE
    if "--self-test" in sys.argv:
        return 0 if ydome.kit_ready() else 1
    if "--quiet" in sys.argv:          # for testing: YDome-Fix.exe --quiet <YDome folder>, no windows
        try:
            ydome.repair(Path(sys.argv[sys.argv.index("--quiet") + 1]))
        except (OSError, RuntimeError, IndexError):
            return 1
        return 0
    import tkinter as tk
    from tkinter import filedialog, messagebox
    root = tk.Tk()
    root.withdraw()
    if not ydome.kit_ready():
        messagebox.showerror(TITLE, f"ไม่พบไฟล์ dome.proj และ config.xml ข้างโปรแกรมนี้\n{HERE}\n\n"
                                    "ต้องก๊อปมาทั้งโฟลเดอร์ ห้ามลากโปรแกรมนี้ออกมาตัวเดียว")
        return 1
    home = ydome.DEFAULT_HOME
    st = ydome.look(home)
    if not st["found"]:
        d = filedialog.askdirectory(title="เลือกโฟลเดอร์ YDome (โฟลเดอร์ที่มี dome.proj และโฟลเดอร์ bin)")
        if not d:
            return 0
        home = Path(d)
        st = ydome.look(home)
        if not st["found"]:
            messagebox.showerror(TITLE, f"ไม่พบ YDome.exe ในโฟลเดอร์ย่อยของ\n{home}")
            return 1
    lines = ["dome.proj: " + ("ว่างเปล่า (เสีย)" if st["project_blank"] else "มีข้อมูลอยู่")]
    lines += [f"{d.name}\\config.xml: " + ("ว่างเปล่า (เสีย)" if b else "มีข้อมูลอยู่")
              for d, b in st["config_blank"].items()]
    broken = st["project_blank"] or any(st["config_blank"].values())
    if broken:
        ask = ("พบไฟล์ตั้งค่าของ YDome ว่างเปล่า (สาเหตุที่ YDome เปิดไม่ขึ้น):\n\n" + "\n".join(lines)
               + "\n\nใส่ไฟล์ที่กู้ไว้แทนไฟล์ที่ว่างเปล่าไหม?\n"
               "- ไฟล์เดิมจะถูกเก็บไว้ในโฟลเดอร์ files-before-repair-… ข้างๆ\n"
               "- ไฟล์ใหม่จะถูกตั้งเป็น read-only เพื่อกันพังซ้ำแบบเดิม\n\n"
               "ปิด YDome ก่อน ถ้าเปิดค้างอยู่")
    else:
        ask = ("ไฟล์ตั้งค่าของ YDome ไม่ได้ว่างเปล่า:\n\n" + "\n".join(lines)
               + "\n\nเขียนทับด้วยค่าที่กู้ไว้ (ค่าปี 2021) ไหม?\nไฟล์เดิมจะถูกเก็บไว้ในโฟลเดอร์ files-before-repair-…")
    if not messagebox.askyesno(TITLE, ask, default="yes" if broken else "no"):
        return 0
    try:
        done = ydome.repair(home, force=not broken)
    except (OSError, RuntimeError) as e:
        messagebox.showerror(TITLE, f"ซ่อมไม่สำเร็จ:\n{e}\n\nถ้า YDome เปิดค้างอยู่ ให้ปิดก่อนแล้วลองใหม่")
        return 1
    messagebox.showinfo(
        TITLE,
        "ใส่ไฟล์แล้ว:\n" + "\n".join(done) + "\n\n"
        "ต่อไป: เปิด YDome จาก shortcut เดิมบน Desktop\n"
        "เปิดได้ทีละโปรแกรม อย่าเปิด DomePlayer กับ YDome พร้อมกัน\n\n"
        "ถ้า YDome เปิดขึ้นแต่ภาพจากกลางโดมถึงขอบดูยืดหรือหดผิดปกติ: ดูไฟล์ อ่านก่อน.txt ในโฟลเดอร์นี้")
    return 0


if __name__ == "__main__":
    sys.exit(main())
