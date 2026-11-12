"""Build an offline, no-install DomePlayer folder: dist/DomePlayer/DomePlayer.exe

Needs (on the build PC only, with internet): Python 3.10+ 64-bit and
    pip install -r requirements.txt pyinstaller
and lib/libmpv-2.dll (run tools/get_libmpv.py first).

The result needs no Python and no internet. Copy the whole dist/DomePlayer folder
(or the zip made next to it) to the playback PC.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DIST = APP_DIR / "dist"
OUT = DIST / "DomePlayer"
DLL = APP_DIR / "lib" / "libmpv-2.dll"

QUICKSTART = """DomePlayer {VERSION} - วิธีใช้ (ไม่ต้องติดตั้ง ไม่ต้องใช้เน็ต)
(เลขเวอร์ชันอยู่บนหัวหน้าต่างเริ่มต้นด้วย ถ้าไม่ใช่ {VERSION} แปลว่าเปิดโฟลเดอร์เก่า)

1. แตกไฟล์ zip ก่อน แล้วก๊อปทั้งโฟลเดอร์ DomePlayer ไปไว้ที่ C:\\DomePlayer
   (ห้ามลาก DomePlayer.exe ออกจากโฟลเดอร์ ทำ shortcut ได้)
2. ดับเบิลคลิก DomePlayer.exe
   (ถ้าขึ้นจอสีฟ้า "Windows protected your PC" กด More info แล้วกด Run anyway หรือถ้ามีปุ่ม Run ให้กด Run)
3. กด "เลือกไฟล์…" แล้วเลือกวิดีโอ
4. โดม: ติ๊ก "ใช้หลายจอพร้อมกัน" และ "เลือกจอให้เอง" ไว้ (ใช้ทุกจอยกเว้นจอหลักของ Windows ซึ่งเป็นจอคนคุม)
   จอหลักของ Windows ต้องเป็นจอคนคุม อย่าตั้งโปรเจคเตอร์เป็นจอหลัก
5. กด "ตรวจความพร้อม" แก้ข้อที่ขึ้น ❌ ก่อน แล้วกด "เล่น"
6. หลังกด "เล่น" จะมี "แผงควบคุม" ขึ้นที่จอคนคุม: บอกสถานะเป็นภาษาไทย และมีปุ่มแทนปุ่มคีย์บอร์ดทุกปุ่มข้างล่างนี้

ระหว่างเล่น:  F1 = หน้าสถิติ   Space = หยุด/เล่น   Home = เริ่มใหม่   Esc = ปิด
หลายจอ:  T = ตาราง/ขาว/ปิด   1-9 = ดูทีละจอ   0 = ทุกจอ
ปรับอัตโนมัติด้วยกล้องที่อัดวิดีโอ (Insta360 Ace Pro 2 / กล้อง 360) - ใช้วิธีนี้กับห้องนี้ เพราะกล้อง R50 เห็นโดมไม่ครบ:
   1) วางกล้องนอนราบกลางห้อง เลนส์หันขึ้นโดม ปิดไฟห้อง ตั้งวิดีโอมุมกว้างสุด 30 fps ค่าแสง Manual ปิดกันสั่น
      (Ace Pro 2: FreeFrame Video 4K 4:3) ดูในจอกล้องว่าเห็นขอบโดมครบทั้งวง
   2) กดอัดที่กล้อง แล้วที่แผงควบคุมกด "1) ฉายลายให้กล้องอัด" รอราว 3 นาทีจนจบ แล้วหยุดอัด
   3) ก๊อปไฟล์วิดีโอจากกล้องมาไว้ในเครื่องนี้ แล้วกด "2) เลือกไฟล์วิดีโอ…" รอคำนวณ
   4) กด "ดูภาพจากวิดีโอ" ปรับวงกลมให้ทับขอบโดม กด "บันทึกวงกลม"
   (ละเอียดใน คู่มือ-README.txt หัวข้อ "calibrate ด้วยกล้องที่อัดวิดีโอ")
ปรับอัตโนมัติด้วยกล้อง USB เช่น R50 (ใช้ได้เมื่อกล้องเห็นโดมครบทั้งวง; ตั้งกล้องโหมด M ค่าแสงคงที่ ห้ามใช้ Auto):
   1) กด T สองครั้ง (ขาวทุกเครื่อง) แล้วกด C ดูภาพกล้อง: ต้องเห็นขอบโดมครบทั้งวงในภาพ
      ถ้าขอบโดมล้นภาพ ให้วางกล้องต่ำลงหรือใช้เลนส์กว้างขึ้น (ส่วนที่กล้องไม่เห็นจะเป็นสีดำ)
   2) กด K แล้ว K = ถ่ายลายและคำนวณ (2-3 นาที ห้องมืด ห้ามขยับกล้อง)   U = เปิด/ปิดผล
   3) กด C = กำหนดขอบวงกลมโดม (ลูกศร เลื่อน, +/- ขนาด, Ctrl+S บันทึก)
      , . = หมุนเส้น FRONT ไปทางที่ต้องการให้เป็น "ด้านหน้า" ของวิดีโอ (ขอบล่างของไฟล์วิดีโอ)
(ละเอียดใน คู่มือ-README.txt หัวข้อ "โหมดโดม")

calibrate แล้วแย่ลง: กด "ย้อนค่า calibrate…" เลือกชุดก่อนหน้า
เปิดเองตอนเปิดเครื่อง: ติ๊ก "เปิดเล่นเองทุกครั้งที่เปิดเครื่อง" แล้วกด "เล่น" 1 ครั้ง
   = บูตเครื่องแล้วเล่นเอง ค้าง/ปิดไปเองจะเปิดใหม่เอง (Esc = ปิดจริง)
   จะเลิก: เอาติ๊กออกแล้วกด "เล่น" อีก 1 ครั้ง
   (อย่าสร้าง shortcut "DomePlayer.exe --play" หรือ Task Scheduler เอง จะไม่มีตัวเฝ้า)
กด "เล่น" ตอนที่โปรแกรมเล่นอยู่แล้ว: โปรแกรมจะถามว่าจะปิดตัวเดิมแล้วเริ่มใหม่ไหม
เปิดโปรเจคเตอร์ให้ครบ 6 เครื่องก่อน แล้วค่อยเปิดเครื่อง Dell
ปิด Screensaver ของ Windows (Personalize > Lock screen > Screen saver > None)
ถ้ามีปัญหา กด "เก็บข้อมูลส่งช่าง (zip)" แล้วส่งไฟล์ zip บน Desktop มาให้ดู
ค่าตั้งละเอียดอยู่ใน config.json (เปิดด้วย Notepad) ดูคำอธิบายใน คู่มือ-README.txt
   ถ้าแก้ config.json แล้วพัง: มีสำเนาอัตโนมัติชื่อ config.json.bak อยู่ข้างกัน
"""


def main() -> int:
    if not DLL.exists():
        print(f"missing {DLL} - run: python tools/get_libmpv.py")
        return 1
    version = re.search(r'__version__ = "([^"]+)"', (APP_DIR / "domeplayer" / "__init__.py").read_text()).group(1)
    c = json.loads((APP_DIR / "config.json").read_text(encoding="utf-8-sig"))
    if not c["display"]["fullscreen"] or c["calibration"].get("simulate") or c["stats"]["show_on_start"]:
        print("config.json is not the show configuration (fullscreen on, simulate off, stats off) - not building")
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
        "--hidden-import", "domeplayer.remote", "--hidden-import", "domeplayer.calib.video",
        "--exclude-module", "py7zr",
        str(APP_DIR / "tools" / "domeplayer_exe.py"),
    ]
    print(" ".join(cmd))
    subprocess.run(cmd, check=True)

    (OUT / "lib").mkdir(exist_ok=True)
    shutil.copyfile(DLL, OUT / "lib" / DLL.name)
    (OUT / "logs").mkdir(exist_ok=True)
    shutil.copyfile(APP_DIR / "config.json", OUT / "config.json")
    # .md has no program to open it on a clean Windows: ship the manual as .txt (Notepad)
    (OUT / "คู่มือ-README.txt").write_text((APP_DIR / "README.md").read_text(encoding="utf-8"), encoding="utf-8-sig")
    (OUT / "อ่านก่อน-README.txt").write_text(QUICKSTART.replace("{VERSION}", version), encoding="utf-8-sig")
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
