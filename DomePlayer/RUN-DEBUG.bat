@echo off
cd /d "%~dp0"
title DomePlayer (debug)
if not exist ".venv\Scripts\python.exe" (
  echo DomePlayer is not set up yet. Double-click 1-SETUP.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m domeplayer
echo.
echo DomePlayer stopped. The log is in the logs folder.
pause
