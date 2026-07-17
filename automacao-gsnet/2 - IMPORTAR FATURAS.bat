@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Importar Faturas - GSNET (Suplementos 3.0)
color 0B
echo ============================================================
echo    IMPORTAR FATURAS NO GSNET (Fatura em Lote)
echo ============================================================
echo.
echo O robo vai abrir o Chrome, logar e deixar a tela pronta.
echo Depois, NESTA MESMA janela do Chrome, voce escolhe o
echo arquivo da grade e clica Importar. Ao terminar, feche o
echo Chrome que o robo encerra sozinho.
echo.
echo Aguarde...
echo.
node importar.js
echo.
pause
