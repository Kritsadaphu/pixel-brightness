"""Download libmpv-2.dll (64-bit Windows build of mpv) into the lib folder.

Source: https://github.com/shinchiro/mpv-winbuild-cmake/releases (the builds linked from mpv.io).

Usage:
    python tools/get_libmpv.py                 # download the latest build
    python tools/get_libmpv.py --file X.7z     # use an archive you downloaded yourself
    python tools/get_libmpv.py --force         # replace an existing DLL
"""
from __future__ import annotations

import gc
import json
import os
import re
import shutil
import subprocess
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


def _is_dll(name: str) -> bool:
    return name.replace("\\", "/").split("/")[-1].lower() == DLL


def _extract_py7zr(archive: Path, out: Path) -> Path:
    import py7zr

    with py7zr.SevenZipFile(archive, "r") as z:
        names = [n for n in z.getnames() if _is_dll(n)]
        if not names:
            raise RuntimeError(f"{DLL} is not inside {archive.name}")
        z.extract(path=out, targets=[names[0]])
    return out / names[0]


def _extract_tool(exe: str, list_args: list[str], extract_args: list[str], archive: Path, out: Path) -> Path:
    """Extract with an external program (Windows tar.exe or 7-Zip's 7z.exe)."""
    listing = subprocess.run([exe, *list_args, str(archive)], capture_output=True, text=True,
                             errors="replace", check=True).stdout
    names = [n.strip().removeprefix("Path = ") for n in listing.splitlines()]
    names = [n for n in names if _is_dll(n)]
    if not names:
        raise RuntimeError(f"{DLL} is not inside {archive.name}")
    subprocess.run([exe, *extract_args, str(archive), names[0]], cwd=out,
                   capture_output=True, check=True)
    found = [p for p in out.rglob("*") if p.is_file() and _is_dll(p.name)]
    if not found:
        raise RuntimeError(f"{exe} ran but {DLL} did not appear")
    return found[0]


def _extractors() -> list[tuple[str, object]]:
    """Ways to open the .7z, tried in order.

    py7zr cannot read archives that use the BCJ2 filter (the mpv builds do), so we fall back to
    Windows' own tar.exe (reads .7z on recent Windows 10/11) and then to 7-Zip if it is installed.
    """
    out: list[tuple[str, object]] = [("py7zr", _extract_py7zr)]
    sysroot = os.environ.get("SystemRoot", r"C:\Windows")
    tar = Path(sysroot) / "System32" / "tar.exe"
    if tar.exists():
        out.append(("Windows tar", lambda a, o: _extract_tool(str(tar), ["-tf"], ["-xf"], a, o)))
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")):
        seven = Path(base or "") / "7-Zip" / "7z.exe"
        if base and seven.exists():
            out.append(("7-Zip", lambda a, o, s=str(seven): _extract_tool(
                s, ["l", "-ba", "-slt"], ["e", "-y"], a, o)))
            break
    return out


def extract(archive: Path) -> None:
    errors = []
    for label, fn in _extractors():
        tmp = Path(tempfile.mkdtemp(prefix="domeplayer-mpv-"))
        try:
            dll = fn(archive, tmp)
            LIB_DIR.mkdir(exist_ok=True)
            shutil.copyfile(dll, LIB_DIR / DLL)
            print(f"OK ({label}): {LIB_DIR / DLL}")
            return
        except Exception as e:  # noqa: BLE001 - try the next way
            errors.append(f"{label}: {e}")
            print(f"  {label} could not extract it, trying the next way ...")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
            gc.collect()  # py7zr can leave the archive open when it fails; release it
    raise RuntimeError("could not extract the archive:\n    " + "\n    ".join(errors))


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
        # Not TemporaryDirectory(): if cleanup fails (file still locked by antivirus or py7zr)
        # its error would replace the real one and setup would fail although the DLL is in place.
        tmp = Path(tempfile.mkdtemp(prefix="domeplayer-dl-"))
        try:
            archive = tmp / asset["name"]
            download(asset["browser_download_url"], archive)
            extract(archive)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"\nCould not download libmpv automatically: {e}")
        print(MANUAL)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
