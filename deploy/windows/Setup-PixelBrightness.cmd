@echo off
setlocal
set "PB_SETUP_SCRIPT=%~dp0Setup-PixelBrightness.ps1"
if not exist "%PB_SETUP_SCRIPT%" (
  echo Pixel Brightness setup script is missing: "%PB_SETUP_SCRIPT%"
  pause
  exit /b 2
)

echo Pixel Brightness Windows setup
echo This will request Administrator approval through Windows UAC.
echo No Windows password is read or stored by Pixel Brightness.
echo.

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PB_SETUP_SCRIPT%"
set "PB_SETUP_EXIT=%ERRORLEVEL%"
echo.
if "%PB_SETUP_EXIT%"=="0" (
  echo Pixel Brightness installed successfully.
  echo Next: read WINDOWS-START-HERE.txt, identify the physical displays, then run Bind-PixelBrightnessDisplays.ps1.
) else (
  echo Setup failed with exit code %PB_SETUP_EXIT%. Review the error left visible in the Administrator window.
)
pause
exit /b %PB_SETUP_EXIT%
