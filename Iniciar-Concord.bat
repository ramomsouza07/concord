@echo off
chcp 65001 >nul
title Concord — Desktop e Servidor P2P
cd /d "%~dp0"

echo ==============================================================
echo   INICIANDO CONCORD (VOZ, VIDEO E TELA P2P)
echo ==============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "NODE_CMD=node"
) else if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
) else (
    set "NODE_CMD="
)

if exist "node_modules\electron\dist\electron.exe" (
    echo [Concord] Iniciando aplicativo Desktop via Electron...
    call "node_modules\.bin\electron.cmd" .
    if %ERRORLEVEL% EQU 0 goto :done
)

if not "%NODE_CMD%"=="" (
    echo [Concord] Node.js detectado! Iniciando servidor em http://localhost:3456 ...
    netstat -ano | findstr ":3456" | findstr "LISTENING" >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        start "Concord Server" /min cmd /c ""%NODE_CMD%" server\index.js"
        ping 127.0.0.1 -n 3 >nul
    )
    if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
        start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3456 --window-size=1360,840
    ) else (
        start "" "http://localhost:3456"
    )
    goto :done
)

echo [Concord] Iniciando Servidor Nativo Windows (.NET) + Janela Desktop...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456 -LaunchApp

:done
echo.
echo ==============================================================
echo   Concord iniciado com sucesso!
echo   Acesse http://localhost:3456 no seu navegador.
echo ==============================================================
pause
