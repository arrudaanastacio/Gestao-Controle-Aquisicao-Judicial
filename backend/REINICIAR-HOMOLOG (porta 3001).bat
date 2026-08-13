@echo off
chcp 65001 >nul
title HOMOLOGACAO (porta 3001) - Controle de Compras Judiciais
rem Caminho ABSOLUTO: este atalho SEMPRE reinicia a HOMOLOGACAO (TESTE),
rem na porta 3001 - NUNCA mexe na producao (porta 3000).
cd /d "C:\Compras Judiciais - TESTE\backend"

echo ============================================================
echo   REINICIAR A HOMOLOGACAO  (porta 3001)
echo ============================================================
echo.
echo Este atalho encerra o que estiver preso na porta 3001 e sobe
echo a HOMOLOGACAO (pasta de TESTE) de novo. Nao afeta a producao.
echo ============================================================
echo.

echo Encerrando servidores presos na porta 3001 (se houver)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Write-Host '   Servidor antigo encerrado.' } else { Write-Host '   Nada estava preso. Tudo certo.' }"

echo.
echo Subindo a HOMOLOGACAO...
echo.
echo Para acessar NESTE computador:  http://localhost:3001
echo Para PARAR o sistema, feche esta janela ou aperte Ctrl+C.
echo ============================================================
echo.

rem Usa o repositorio de certificados do Windows (CA da UDTP/gov).
set NODE_USE_SYSTEM_CA=1
node src/server.js

echo.
echo O servidor foi encerrado.
pause
