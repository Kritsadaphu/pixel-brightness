@echo off
setlocal
cd /d "%~dp0"
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo Node.js is not installed at the expected path. This diagnostic needs Node.js 22 or later.
  pause
  exit /b 1
)
echo Pixel Brightness USB camera diagnostic - no projector or Arena changes.
echo Open http://localhost:4310/ in your browser after the server starts.
echo Close this window or press Ctrl+C to stop the diagnostic.
"%ProgramFiles%\nodejs\node.exe" "%~dp0scripts\uvc-camera-diagnostic.mjs" "%~dp0pixel-brightness-uvc.exe"
pause
