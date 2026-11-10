"""Download libmpv-2.dll (64-bit Windows build of mpv) into the lib folder.

Source: https://github.com/shinchiro/mpv-winbuild-cmake/releases (the builds linked from mpv.io).

Usage:
    python tools/get_libmpv.py                 # download the latest build
    python tools/get_libmpv.py --file X.7z     # use an archive you downloaded yourself
    python tools/get_libmpv.py --force         # replace an existing DLL
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
LIB_DIR = APP_DIR / "lib"
DLL = "libmpv-2.dll"
API = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest"
# mpv-dev-x86_64-20251101-git-abc1234.7z  (not the "-v3-" build, which needs a newer CPU)
ASSET_RE = re.compile(r"^mpv-dev-x86_64-\d{8}-git-[0-9a-f]+\.7z$")
MANUAL = (
    "\nManual way:\n"
    "  1. Open https://github.com/shinchiro/mpv-winbuild-cmake/releases\n"
    "  2. Download the file named mpv-dev-x86_64-<date>-git-<code>.7z\n"
    "     (NOT the one with -v3- and NOT aarch64)\n"
    f"  3. Run:  python tools/get_libmpv.py --file <that .7z file>\n"
    f"     or open it with 7-Zip and copy {DLL} into {LIB_DIR}\n"
)


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "DomePlayer-setup"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": "DomePlayer-setup"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:6.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()


def extract(archive: Path) -> None:
    import py7zr

    with py7zr.SevenZipFile(archive, "r") as z:
        names = [n for n in z.getnames() if n.replace("\\", "/").split("/")[-1].lower() == DLL]
        if not names:
            raise RuntimeError(f"{DLL} is not inside {archive.name}")
        with tempfile.TemporaryDirectory() as tmp:
            z.extract(path=tmp, targets=[names[0]])
            LIB_DIR.mkdir(exist_ok=True)
            shutil.copyfile(Path(tmp) / names[0], LIB_DIR / DLL)
    print(f"OK: {LIB_DIR / DLL}")


def main(argv: list[str]) -> int:
    target = LIB_DIR / DLL
    if target.exists() and "--force" not in argv:
        print(f"OK: {DLL} already present ({target.stat().st_size / 1e6:.0f} MB). Use --force to replace.")
        return 0
    if "--file" in argv:
        extract(Path(argv[argv.index("--file") + 1]))
        return 0
    try:
        print("Looking up the latest mpv build ...")
        release = json.loads(fetch(API))
        assets = [a for a in release.get("assets", []) if ASSET_RE.match(a["name"])]
        if not assets:
            raise RuntimeError("no matching mpv-dev-x86_64 file in the latest release")
        asset = assets[0]
        print(f"Downloading {asset['name']} ...")
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / asset["name"]
            download(asset["browser_download_url"], archive)
            extract(archive)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"\nCould not download libmpv automatically: {e}")
        print(MANUAL)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
