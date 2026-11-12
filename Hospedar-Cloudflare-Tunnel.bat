@echo off
chcp 65001 >nul
title Concord — Hospedagem Publica HTTPS (Cloudflare Tunnel)
cd /d "%~dp0"

echo ======================================================================
echo   HOSPEDANDO O CONCORD COM LINK HTTPS PUBLICO (CLOUDFLARE TUNNEL)
echo ======================================================================
echo.
echo Por que HTTPS e importante?
echo Navegadores exigem HTTPS (https://) para liberar Microfone, Camera
echo e Compartilhamento de Tela para amigos fora do seu PC sem precisar
echo configurar flags ou instalar VPNs.
echo.

REM 1. Inicia o servidor Concord em segundo plano se ainda nao estiver rodando
netstat -ano | findstr ":3456" | findstr "LISTENING" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [1/2] Iniciando Servidor Concord na porta 3456...
    where node >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        start "Concord Server" /min cmd /c "node server\index.js"
    ) else if exist "C:\Program Files\nodejs\node.exe" (
        start "Concord Server" /min cmd /c ""C:\Program Files\nodejs\node.exe" server\index.js"
    ) else (
        start "Concord Server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456
    )
    ping 127.0.0.1 -n 3 >nul
) else (
    echo [1/2] Servidor Concord ja esta ativo na porta 3456!
)

REM 2. Define o executavel do cloudflared
set "CF_BIN=%~dp0cloudflared.exe"
if exist "%CF_BIN%" goto :run_tunnel

where cloudflared >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "CF_BIN=cloudflared"
    goto :run_tunnel
)

echo [2/2] Baixando Cloudflare Tunnel oficial (cloudflared-windows-amd64.exe)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object System.Net.WebClient).DownloadFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', '%~dp0cloudflared.exe')"
set "CF_BIN=%~dp0cloudflared.exe"

:run_tunnel
if not exist "%CF_BIN%" (
    where cloudflared >nul 2>nul
    if %ERRORLEVEL% NEQ 0 (
        echo [ERRO] Nao foi possivel encontrar ou baixar o cloudflared.exe.
        pause
        exit /b 1
    )
    set "CF_BIN=cloudflared"
)

echo.
echo ======================================================================
echo   GERANDO SEU LINK HTTPS PUBLICO...
echo   Copie o link "https://....trycloudflare.com" que aparecer abaixo
echo   e envie para seus amigos junto com o convite: CONCORD-AMIGOS-2026
echo ======================================================================
echo.
"%CF_BIN%" tunnel --url http://localhost:3456
echo.
echo O tunel foi encerrado.
pause
