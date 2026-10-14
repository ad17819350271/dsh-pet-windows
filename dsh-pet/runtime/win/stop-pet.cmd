@echo off
rem ===========================================================================
rem  dsh-pet (packaged app) stopper - POST /shutdown to the embedded host.
rem  No Node.js required (unlike the dev-mode stop-pet.bat).
rem ===========================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-pet.ps1"
pause
