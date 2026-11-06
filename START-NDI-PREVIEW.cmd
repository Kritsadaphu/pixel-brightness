@echo off
setlocal
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo Node.js is not installed. This is a development preview, not an offline installer.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\Start-PixelBrightnessPreviewOnce.ps1"
pause
