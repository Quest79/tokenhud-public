@echo off
rem Installs TokenHUD Server as a real Windows Service (one admin prompt). To uninstall: "Install TokenHUD Service.bat" remove
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-service.ps1" %*
