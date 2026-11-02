@echo off
rem Opens TokenHUD, rebuilding first if the code changed.
rem This window shows each step with a progress bar and closes once the TokenHUD window is open.
title Starting TokenHUD
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
exit /b 0
