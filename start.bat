@echo off
chcp 65001 > nul
title VTuber Studio Pro - Portable Launcher

echo ============================================================
echo   VTuber Studio Pro (Web Edition)
echo ============================================================
echo.

cd /d "%~dp0"

REM 1. Check if prebuilt dist exists
if not exist "dist" (
    echo [INFO] dist folder not found. Building project...
    where node >nul 2>nul
    if %errorlevel% equ 0 (
        if not exist "node_modules" (
            echo [INFO] Installing dependencies (npm install)...
            call npm install
        )
        echo [INFO] Building (npm run build)...
        call npm run build
    ) else (
        echo [ERROR] dist folder missing and Node.js not installed.
        echo Please install Node.js from https://nodejs.org/
        pause
        exit /b 1
    )
)

REM 2. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Node.js found. Launching high-speed local server...
    node server.js
) else (
    echo [OK] Node.js not detected. Launching built-in Windows HTTP server...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
)

if %errorlevel% neq 0 (
    echo.
    echo [INFO] Server stopped.
    pause
)
