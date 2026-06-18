@echo off
chcp 65001 >nul
title Controle de Compras Judiciais - Servidor
cd /d "%~dp0"

echo ============================================================
echo   INICIANDO O SISTEMA
echo ============================================================
echo.
echo O sistema vai abrir abaixo. NAO FECHE esta janela enquanto
echo estiver usando o sistema - ela e o "motor" que mantem tudo
echo funcionando.
echo.
echo Para acessar NESTE computador, abra o navegador em:
echo     http://localhost:3000
echo.
echo Para acessar de OUTRO computador na mesma rede, descubra o
echo IP desta maquina (abra outro Prompt e digite: ipconfig) e
echo use:  http://SEU_IP:3000  (ex: http://192.168.0.15:3000)
echo.
echo Para PARAR o sistema, feche esta janela ou aperte Ctrl+C.
echo ============================================================
echo.

node src/server.js

echo.
echo O servidor foi encerrado.
pause
