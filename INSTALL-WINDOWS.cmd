@echo off
setlocal
if not exist "%~dp0deploy\windows\Setup-PixelBrightness.cmd" (
  echo Extract the complete Pixel Brightness ZIP before running this installer.
  pause
  exit /b 2
)
call "%~dp0deploy\windows\Setup-PixelBrightness.cmd"
exit /b %ERRORLEVEL%
