@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo DomePlayer is not set up yet. Double-click 1-SETUP.bat first.
  pause
  exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" -m domeplayer
