"""Entry point for the packaged DomePlayer.exe (see tools/build_exe.py)."""
import sys

from domeplayer.app import main

if __name__ == "__main__":
    sys.exit(main())
