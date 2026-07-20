@echo off
chcp 65001 >nul
title Instalar o sistema como SERVICO do Windows
cd /d "%~dp0"

rem --- Precisa de Administrador para mexer em servicos do Windows. Se nao for,
rem --- reabre este mesmo .bat pedindo elevacao e encerra a copia sem permissao.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Este passo precisa de permissao de Administrador.
  echo Abrindo de novo com a permissao... confirme na janela do Windows.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo   INSTALAR O SISTEMA COMO SERVICO DO WINDOWS
echo ============================================================
echo.
echo Depois disso, o sistema:
echo   - Sobe SOZINHO quando o computador liga (sem clicar em nada).
echo   - Reinicia sozinho se travar.
echo   - Roda invisivel, sem janela preta aberta.
echo.
echo Aguarde a mensagem de sucesso abaixo...
echo ============================================================
echo.

node src/servico-windows.js instalar

echo.
echo ============================================================
echo   Pronto. Confira em "Servicos" do Windows (services.msc).
echo ============================================================
echo.
pause
