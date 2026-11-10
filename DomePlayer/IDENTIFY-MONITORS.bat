@echo off
cd /d "%~dp0"
title DomePlayer - identify monitors
if not exist ".venv\Scripts\python.exe" (
  echo DomePlayer is not set up yet. Double-click 1-SETUP.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m domeplayer --identify
echo.
echo The list above is also saved in logs\monitors.txt
pause
