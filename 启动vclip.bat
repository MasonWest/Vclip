@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Vclip

echo ==========================================
echo   Vclip - local clipboard server
echo ==========================================
echo.

where node >nul 2>nul
if not errorlevel 1 goto :node_ready

set "NODE_DIR="
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do set "NODE_DIR=%%D"
if defined NODE_DIR set "PATH=%NODE_DIR%;%PATH%"

:node_ready
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on this machine.
  echo         Install Node.js 22 or newer from https://nodejs.org/
  echo         then run this file again.
  echo.
  pause
  exit /b 1
)

node -v
echo.

if not exist "node_modules\" (
  echo [Setup] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 goto :fail
  echo.
)

if not exist "dist\index.html" (
  echo [Setup] Building frontend...
  call npm run build
  if errorlevel 1 goto :fail
  echo.
)

echo [Start] Press Ctrl+C to stop the server.
echo.
node --disable-warning=ExperimentalWarning server.mjs

echo.
echo [Stop] Server exited.
pause
exit /b 0

:fail
echo.
echo [ERROR] Setup failed, see messages above.
pause
exit /b 1
