@echo off
chcp 65001 >nul
title Remover o SERVICO do Windows (voltar ao modo .bat)
cd /d "%~dp0"

rem --- Precisa de Administrador para mexer em servicos do Windows.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Este passo precisa de permissao de Administrador.
  echo Abrindo de novo com a permissao... confirme na janela do Windows.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================================
echo   REMOVER O SERVICO DO WINDOWS
echo ============================================================
echo.
echo Isto desliga e remove o servico. O sistema PARA de subir
echo sozinho e volta a ser iniciado pelo .bat, se voce quiser.
echo O banco de dados e os arquivos NAO sao afetados.
echo.
pause

node src/servico-windows.js desinstalar

echo.
echo ============================================================
echo   Servico removido.
echo ============================================================
echo.
pause
