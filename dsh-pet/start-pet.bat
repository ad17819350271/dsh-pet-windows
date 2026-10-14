@echo off
rem ===========================================================================
rem  dsh-pet Windows launcher (standalone desktop mode, no DSH required)
rem  Must sit next to lib\standalone.js (i.e. in the package root).
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

rem GPU fallback level 2 (--in-process-gpu): enables instantly on machines whose
rem Electron GPU child process crashes with 0xC0000005 (RDP / VM / broken driver).
rem Not needed on healthy machines - the host auto-detects the crash and degrades
rem by itself (README "Windows troubleshooting"). Delete the next line to test.
set DSH_PET_DISABLE_GPU=2

echo [dsh-pet] starting desktop pet...
echo [dsh-pet] service  : http://127.0.0.1:3080/dsh-pet-7340/  (3081..3104 on conflict)
echo [dsh-pet] stop     : run stop-pet.bat, or press Ctrl+C in this window
echo.
node lib\standalone.js
pause
