@echo off
chcp 65001 >nul
title Concord — Hospedagem Pública HTTPS (Cloudflare Tunnel)
cd /d "%~dp0"

echo ======================================================================
echo   🌐 HOSPEDANDO O CONCORD COM LINK HTTPS PÚBLICO (CLOUDFLARE TUNNEL)
echo ======================================================================
echo.
echo Por que HTTPS é importante?
echo Navegadores exigem HTTPS (https://) para liberar Microfone, Câmera
echo e Compartilhamento de Tela para amigos fora do seu PC.
echo.

REM 1. Inicia o servidor Concord em segundo plano se ainda não estiver rodando
netstat -ano | findstr ":3456" | findstr "LISTENING" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [1/2] Iniciando Servidor Concord na porta 3456...
    where node >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        start "Concord Server" /min cmd /c "node server\index.js"
    ) else (
        start "Concord Server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\native-host.ps1" -Port 3456
    )
    timeout /t 3 /nobreak >nul
) else (
    echo [1/2] Servidor Concord já está ativo na porta 3456!
)

REM 2. Verifica se o cloudflared existe ou baixa automaticamente a versão oficial
set "CF_BIN=cloudflared.exe"
where cloudflared >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set "CF_BIN=cloudflared"
    goto :run_tunnel
)

if not exist "%~dp0cloudflared.exe" (
    echo [2/2] Baixando Cloudflare Tunnel oficial (cloudflared-windows-amd64.exe)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%~dp0cloudflared.exe'"
)

:run_tunnel
echo.
echo ======================================================================
echo   🚀 GERANDO SEU LINK HTTPS PÚBLICO...
echo   Copie o link "https://....trycloudflare.com" que aparecer abaixo
echo   e envie para seus amigos junto com o convite: CONCORD-AMIGOS-2026
echo ======================================================================
echo.
"%CF_BIN%" tunnel --url http://localhost:3456
pause
