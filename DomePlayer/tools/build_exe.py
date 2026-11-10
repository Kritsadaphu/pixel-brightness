"""Build an offline, no-install DomePlayer folder: dist/DomePlayer/DomePlayer.exe

Needs (on the build PC only, with internet): Python 3.10+ 64-bit and
    pip install -r requirements.txt pyinstaller
and lib/libmpv-2.dll (run tools/get_libmpv.py first).

The result needs no Python and no internet. Copy the whole dist/DomePlayer folder
(or the zip made next to it) to the playback PC.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DIST = APP_DIR / "dist"
OUT = DIST / "DomePlayer"
DLL = APP_DIR / "lib" / "libmpv-2.dll"

QUICKSTART = """DomePlayer - วิธีใช้ (ไม่ต้องติดตั้ง ไม่ต้องใช้เน็ต)

1. ก๊อปทั้งโฟลเดอร์นี้ไปไว้ที่ C:\\DomePlayer
2. ดับเบิลคลิก DomePlayer.exe
   (ถ้าขึ้นจอสีฟ้า "Windows protected your PC" กด More info แล้วกด Run anyway)
3. กด "เลือกไฟล์…" แล้วเลือกวิดีโอ
4. เลือกจอ (กด "โชว์เลขจอ" ถ้าไม่แน่ใจว่าจอไหนเลขอะไร)
5. กด "เล่น"

ระหว่างเล่น:  F1 = หน้าสถิติ   Space = หยุด/เล่น   Home = เริ่มใหม่   Esc = ปิด
หลายจอ:  T = ตาราง/ขาว/ปิด   1-9 = ดูทีละจอ   0 = ทุกจอ
ปรับอัตโนมัติด้วยกล้อง R50 (ตั้งกล้องกลางห้อง หันขึ้นโดม):
   K แล้ว K = ถ่ายลายและคำนวณ   U = เปิด/ปิดผล
   C = ดูภาพกล้อง + กำหนดขอบวงกลมโดม (ลูกศร เลื่อน, +/- ขนาด, , . หมุนด้านหน้า, Ctrl+S บันทึก)
(ละเอียดใน README.md หัวข้อ "โหมดโดม")

ก่อนใช้งานจริงทุกครั้งที่ไปหน้างาน: กด "ตรวจความพร้อม" แก้ข้อที่ขึ้น ❌ ก่อน
calibrate แล้วแย่ลง: กด "ย้อนค่า calibrate…" เลือกชุดก่อนหน้า
ติ๊ก "เปิดเล่นเองทุกครั้งที่เปิดเครื่อง" = บูตเครื่องแล้วเล่นเอง ค้าง/ปิดไปเองจะเปิดใหม่เอง (Esc = ปิดจริง)
เปิดโปรเจคเตอร์ให้ครบ 6 เครื่องก่อน แล้วค่อยเปิดเครื่อง Dell
ปิด Screensaver ของ Windows (Personalize > Lock screen > Screen saver > None)
ถ้ามีปัญหา กด "เก็บข้อมูลส่งช่าง (zip)" แล้วส่งไฟล์ zip บน Desktop มาให้ดู
ค่าตั้งละเอียดอยู่ใน config.json (เปิดด้วย Notepad) ดูคำอธิบายใน README.md
เล่นทันทีโดยไม่ขึ้นหน้าต่างเลือกไฟล์ (เช่นตอนเปิดเครื่อง): DomePlayer.exe --play
"""


def main() -> int:
    if not DLL.exists():
        print(f"missing {DLL} - run: python tools/get_libmpv.py")
        return 1
    work = DIST / "_build"
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
        "--name", "DomePlayer", "--windowed", "--onedir",
        "--distpath", str(DIST), "--workpath", str(work), "--specpath", str(work),
        "--paths", str(APP_DIR),
        "--collect-all", "glfw", "--collect-all", "moderngl", "--collect-all", "glcontext",
        "--hidden-import", "domeplayer.launcher", "--hidden-import", "domeplayer.identify",
        "--hidden-import", "domeplayer.calib.camera", "--hidden-import", "domeplayer.calib.session",
        "--hidden-import", "domeplayer.calib.solve", "--hidden-import", "domeplayer.watchdog", "--hidden-import", "domeplayer.check",
        "--hidden-import", "domeplayer.report", "--hidden-import", "domeplayer.backup", "--hidden-import", "cv2", "--hidden-import", "numpy",
        "--exclude-module", "py7zr",
        str(APP_DIR / "tools" / "domeplayer_exe.py"),
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)

    (OUT / "lib").mkdir(exist_ok=True)
    shutil.copyfile(DLL, OUT / "lib" / DLL.name)
    (OUT / "logs").mkdir(exist_ok=True)
    for name in ("config.json", "README.md"):
        shutil.copyfile(APP_DIR / name, OUT / name)
    (OUT / "อ่านก่อน-README.txt").write_text(QUICKSTART, encoding="utf-8-sig")
    shutil.rmtree(work, ignore_errors=True)

    test = subprocess.run([str(OUT / "DomePlayer.exe"), "--self-test"], cwd=str(OUT))
    log_file = OUT / "logs" / "domeplayer.log"
    if test.returncode != 0:
        print(f"self-test of the built DomePlayer.exe FAILED, see {log_file}")
        return 1
    print("self-test OK")
    log_file.unlink(missing_ok=True)

    zip_base = DIST / "DomePlayer-offline"
    shutil.make_archive(str(zip_base), "zip", root_dir=DIST, base_dir="DomePlayer")
    print(f"\nOK: {OUT / 'DomePlayer.exe'}\n    {zip_base}.zip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
