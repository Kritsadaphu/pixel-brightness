@echo off
setlocal
cd /d "%~dp0"
title DomePlayer setup
echo.
echo ===== DomePlayer setup =====
echo.
echo [1/4] Looking for Python ...
set "PY="
py -3 --version >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if not defined PY (
  python --version >nul 2>&1
  if not errorlevel 1 set "PY=python"
)
if not defined PY (
  echo.
  echo   Python was not found.
  echo   Install Python 3.12 64-bit from https://www.python.org/downloads/windows/
  echo   and tick "Add python.exe to PATH" on the first screen, then run this file again.
  goto :fail
)
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) and sys.maxsize > 2**32 else 1)"
if errorlevel 1 (
  echo   Python is too old or 32-bit. Install Python 3.12 64-bit from python.org.
  goto :fail
)
%PY% --version

echo.
echo [2/4] Creating the private Python folder (.venv) ...
if not exist ".venv\Scripts\python.exe" (
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)

echo.
echo [3/4] Installing Python packages (needs internet) ...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto :fail

echo.
echo [4/4] Getting libmpv-2.dll (video engine, about 30-120 MB) ...
".venv\Scripts\python.exe" tools\get_libmpv.py
if errorlevel 1 goto :fail

echo.
echo ===== SETUP FINISHED OK =====
echo Next: edit config.json, then double-click 2-RUN.bat
echo.
pause
exit /b 0

:fail
echo.
echo ===== SETUP FAILED - read the messages above =====
echo.
pause
exit /b 1
