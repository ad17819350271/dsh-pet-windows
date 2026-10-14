@echo off
rem ===========================================================================
rem  dsh-pet Windows stopper: POST /shutdown to the standalone service.
rem ===========================================================================
chcp 65001 >nul
setlocal
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-pet] node.exe not found in PATH. Install Node.js 22.12+ and retry.
  pause
  exit /b 1
)

node "%~dp0stop-pet.mjs"
pause
