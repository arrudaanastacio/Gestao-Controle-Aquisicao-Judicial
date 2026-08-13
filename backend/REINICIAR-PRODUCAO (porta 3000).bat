@echo off
chcp 65001 >nul
title PRODUCAO (porta 3000) - Controle de Compras Judiciais
rem Caminho ABSOLUTO: este atalho SEMPRE reinicia a PRODUCAO,
rem nao importa de qual pasta ele for executado.
cd /d "C:\Compras Judiciais\backend"

echo ============================================================
echo   REINICIAR A PRODUCAO  (porta 3000)
echo ============================================================
echo.
echo Este atalho encerra o que estiver preso na porta 3000 e sobe
echo a PRODUCAO de novo, ja com a versao mais recente do codigo.
echo (A pasta e sempre C:\Compras Judiciais - nunca a de TESTE.)
echo ============================================================
echo.

echo Encerrando servidores presos na porta 3000 (se houver)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Write-Host '   Servidor antigo encerrado.' } else { Write-Host '   Nada estava preso. Tudo certo.' }"

echo.
echo Subindo a PRODUCAO...
echo.
echo Para acessar NESTE computador:  http://localhost:3000
echo Para PARAR o sistema, feche esta janela ou aperte Ctrl+C.
echo ============================================================
echo.

rem Usa o repositorio de certificados do Windows (CA da UDTP/gov).
set NODE_USE_SYSTEM_CA=1
node src/server.js

echo.
echo O servidor foi encerrado.
pause
