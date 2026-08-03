@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Diagnostico - GsnetCompras (Relatorio de Empenhos)
color 0E
echo ============================================================
echo    DIAGNOSTICO - GsnetCompras (mapear as telas)
echo ============================================================
echo.
echo O robo vai abrir o Chrome e clicar em "Acesso GsNetCompras".
echo.
echo Depois, NA JANELA DO CHROME, VOCE:
echo    1) Digita seu usuario e senha e entra;
echo    2) Navega ate a tela de FILTROS do
echo       "Relatorio Estrategico de Empenhos".
echo.
echo Com a tela de filtros aberta, volte para ESTA janela preta
echo e tecle ENTER. Ele salva os arquivos e fecha.
echo.
echo Aguarde...
echo.
node inspecionar.js
echo.
pause
