@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Testar robo de Empenhos (assistido)
color 0A
echo ============================================================
echo    TESTE ASSISTIDO - Robo de Empenhos
echo ============================================================
echo.
echo O robo vai: logar, abrir o relatorio, aplicar os filtros,
echo exportar o .xlsx e depois importar no sistema (Controle de
echo Empenhos). Fique de olho na janela do Chrome.
echo.
echo Aguarde...
echo.
node baixar-empenhos.js
if errorlevel 1 (
  echo.
  echo *** O download falhou. Veja a mensagem acima e o erro.png. ***
  echo.
  pause
  exit /b 1
)
echo.
echo --- Importando a planilha no sistema... ---
node importar-planilha.js
echo.
echo ============================================================
echo  Terminou. Confira a aba "Controle de Empenhos" no sistema.
echo ============================================================
pause
