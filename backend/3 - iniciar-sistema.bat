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

rem Usa o repositorio de certificados do Windows (CA da UDTP/gov).
set NODE_USE_SYSTEM_CA=1

:loop_servidor
node src/server.js

rem Se o Node saiu por ERRO (errorlevel >= 1), sobe de novo sozinho apos 3s.
rem Saida limpa (fechar a janela / Ctrl+C respondido com Y) NAO reinicia.
if errorlevel 1 (
  echo.
  echo [%date% %time%] O servidor caiu inesperadamente. Reiniciando em 3 segundos...
  echo (Para NAO reiniciar, feche esta janela agora.)
  timeout /t 3 /nobreak >nul
  goto loop_servidor
)

echo.
echo O servidor foi encerrado normalmente.
pause
