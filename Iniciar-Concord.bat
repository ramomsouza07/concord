@echo off
chcp 65001 >nul
title Concord — Desktop & Servidor P2P
cd /d "%~dp0"

echo ==============================================================
echo   ✈️  INICIANDO CONCORD (VOZ, VIDEO E TELA P2P 1080p/60fps)
echo ==============================================================

if exist "node_modules\.bin\electron.cmd" (
    echo [Concord] Iniciando aplicativo Desktop via Electron...
    call "node_modules\.bin\electron.cmd" .
    goto :eof
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [Concord] Node.js detectado! Iniciando servidor em http://localhost:3456 ...
    start "Concord Server" /min cmd /c "node server\index.js"
    timeout /t 2 /nobreak >nul
    if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
        start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3456 --window-size=1360,840
    ) else (
        start "" "http://localhost:3456"
    )
    goto :eof
)

echo [Concord] Iniciando Servidor Nativo Windows (.NET) + Janela Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456 -LaunchApp
