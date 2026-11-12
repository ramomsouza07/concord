@echo off
chcp 65001 >nul
title Concord — Servidor Dedicado do Grupo
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    node server\index.js
) else if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" server\index.js
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456
)
echo.
echo Servidor finalizado.
pause
