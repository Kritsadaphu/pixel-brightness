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

ถ้ามีปัญหา ส่งไฟล์ logs\\domeplayer.log มาดู
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

    zip_base = DIST / "DomePlayer-offline"
    shutil.make_archive(str(zip_base), "zip", root_dir=DIST, base_dir="DomePlayer")
    print(f"\nOK: {OUT / 'DomePlayer.exe'}\n    {zip_base}.zip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
