"""Build the YDome repair folder, separate from DomePlayer: dist/YDome-Fix/
    YDome-Fix.exe   (one file, no install, no internet)
    dome.proj, config.xml, config-แบบที่2.xml, อ่านก่อน.txt   (copied from ydome-repair/)

Needs the folder ydome-repair/ next to tools/ (the client's own settings: not in the repository).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DIST = APP_DIR / "dist"
OUT = DIST / "YDome-Fix"
KIT = APP_DIR / "ydome-repair"


def main() -> int:
    if not (KIT / "dome.proj").is_file() or not (KIT / "config.xml").is_file():
        print(f"missing repair files in {KIT}")
        return 1
    work = DIST / "_build_ydome"
    shutil.rmtree(OUT, ignore_errors=True)
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--name", "YDome-Fix",
           "--windowed", "--onefile", "--distpath", str(OUT), "--workpath", str(work), "--specpath", str(work),
           "--paths", str(APP_DIR), "--exclude-module", "numpy", "--exclude-module", "cv2",
           str(APP_DIR / "tools" / "ydome_fix.py")]
    if subprocess.run(cmd).returncode != 0:
        return 1
    for f in KIT.iterdir():
        if f.is_file():
            shutil.copyfile(f, OUT / f.name)
    shutil.rmtree(work, ignore_errors=True)
    test = subprocess.run([str(OUT / "YDome-Fix.exe"), "--self-test"], cwd=str(OUT))
    if test.returncode != 0:
        print("self-test FAILED")
        return 1
    zip_path = shutil.make_archive(str(DIST / "YDome-Fix"), "zip", root_dir=DIST, base_dir="YDome-Fix")
    print(f"self-test OK\n\nOK: {OUT}\n    {zip_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
