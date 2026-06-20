@echo off
setlocal

cd /d "%~dp0"

set "HOST=%SD_GUI_HOST%"
if "%HOST%"=="" set "HOST=127.0.0.1"

set "PORT=%SD_GUI_PORT%"
if "%PORT%"=="" set "PORT=5250"

if exist ".venv\Scripts\python.exe" (
    set "PYTHON_EXE=.venv\Scripts\python.exe"
) else (
    where py >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        set "PYTHON_EXE=py -3"
    ) else (
        set "PYTHON_EXE=python"
    )
)

echo.
echo Starting Stable-D GUI...
echo URL: http://%HOST%:%PORT%
echo.

start "" "http://%HOST%:%PORT%"
%PYTHON_EXE% server.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Stable-D GUI exited with an error.
    pause
)
