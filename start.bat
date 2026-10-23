@echo off
setlocal
chcp 65001 > nul
title VTuber Studio Pro - Launcher

echo ============================================================
echo   VTuber Studio Pro (Web Edition)
echo ============================================================
echo.

cd /d "%~dp0"

REM 1. Check Node.js
where node >nul 2>nul
if errorlevel 1 goto no_node

REM 2. Check dependencies
if not exist "node_modules\" goto do_install
goto do_build

:do_install
echo [INFO] Installing dependencies...
call npm install
if errorlevel 1 goto fail_install

:do_build
echo [INFO] Building application...
call npm run build
if errorlevel 1 goto fail_build

:run_server
echo [OK] Starting VTuber Studio server...
if exist "server.cjs" (
    node server.cjs
) else (
    node server.js
)
goto finish

:fail_install
echo [ERROR] npm install failed.
pause
exit /b 1

:fail_build
echo [ERROR] Build failed.
pause
exit /b 1

:no_node
if not exist "dist\index.html" (
    echo [ERROR] Node.js is not installed and prebuilt dist is missing.
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Launching Windows native HTTP server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
goto finish

:finish
if errorlevel 1 (
    echo.
    echo [INFO] Server stopped.
    pause
)