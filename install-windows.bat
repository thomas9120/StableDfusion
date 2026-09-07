@echo off
setlocal

cd /d "%~dp0"

echo.
echo StableDfusion Windows installer
echo ==============================
echo.

where py >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "PY_CMD=py -3"
) else (
    where python >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Python was not found. Install Python 3.11+ and try again.
        pause
        exit /b 1
    )
    set "PY_CMD=python"
)

%PY_CMD% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Python 3.11+ is required.
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo Creating local Python environment in .venv...
    %PY_CMD% -m venv .venv
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Failed to create .venv.
        pause
        exit /b 1
    )
)

echo Upgrading pip...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to upgrade pip.
    pause
    exit /b 1
)

echo Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Failed to install Python dependencies.
    pause
    exit /b 1
)

where npm >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Installing frontend test dependencies...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
    REM Optional: enable Playwright browsers for frontend smoke tests.
    REM Uncomment to install: npx playwright install --with-deps chromium
) else (
    echo npm was not found; skipping optional frontend test dependencies.
)

echo.
echo Install complete.
echo Run start-windows.bat to launch StableDfusion.
echo.
pause
