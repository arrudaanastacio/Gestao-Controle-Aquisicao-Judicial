@echo off
chcp 65001 >nul
title Controle de Compras Judiciais - REINICIAR
cd /d "%~dp0"

echo ============================================================
echo   REINICIAR O SISTEMA (com seguranca)
echo ============================================================
echo.
echo Este atalho ENCERRA qualquer servidor que tenha ficado preso
echo na porta 3000 e sobe o sistema de novo, ja com a versao mais
echo recente do codigo. Use sempre que o sistema tiver sido
echo atualizado ou parecer "travado na versao antiga".
echo ============================================================
echo.

echo Encerrando servidores presos na porta 3000 (se houver)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Write-Host '   Servidor antigo encerrado.' } else { Write-Host '   Nada estava preso. Tudo certo.' }"

echo.
echo Subindo o sistema...
echo.
echo Para acessar NESTE computador:  http://localhost:3000
echo Para PARAR o sistema, feche esta janela ou aperte Ctrl+C.
echo ============================================================
echo.

node src/server.js

echo.
echo O servidor foi encerrado.
pause
