@echo off
setlocal
chcp 65001 > nul
title VTuber Studio Pro - Portable Launcher

echo ============================================================
echo   VTuber Studio Pro (Web Edition)
echo ============================================================
echo.

cd /d "%~dp0"

REM 1. Check if prebuilt dist exists
if exist "dist\index.html" goto check_node

echo [INFO] Prebuilt dist folder not found.
where node >nul 2>nul
if errorlevel 1 goto no_node_no_dist

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
)

echo [INFO] Building application...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

:check_node
where node >nul 2>nul
if errorlevel 1 goto run_powershell

:run_node
echo [OK] Launching portable Node.js server...
if exist "server.cjs" (
    node server.cjs
) else (
    node server.js
)
goto finish

:run_powershell
echo [OK] Launching built-in Windows HTTP server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
goto finish

:no_node_no_dist
echo [ERROR] Prebuilt dist folder is missing and Node.js is not installed.
echo Please install Node.js from https://nodejs.org/ or download the release ZIP.
pause
exit /b 1

:finish
if errorlevel 1 (
    echo.
    echo [INFO] Server stopped.
    pause
)
