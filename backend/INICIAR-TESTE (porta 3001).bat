@echo off
chcp 65001 >nul
title *** HOMOLOGACAO / TESTE *** - porta 3001
color 0E
cd /d "%~dp0"

echo ============================================================
echo    AMBIENTE DE TESTE (HOMOLOGACAO)  -  NAO E O DOS COLEGAS
echo ============================================================
echo.
echo Esta e a copia de TESTE do sistema. Serve para experimentar
echo novidades sem afetar quem usa o sistema de verdade.
echo.
echo   - Endereco de teste:  http://localhost:3001
echo   - Banco: copia propria (mexer aqui NAO altera a producao)
echo.
echo A producao (a dos colegas) continua em http://SEU_IP:3000,
echo numa OUTRA janela, na pasta "C:\Compras Judiciais".
echo.
echo Encerrando qualquer teste preso na porta 3001...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }"
echo.
echo ============================================================
echo.

node src/server.js

echo.
echo Ambiente de teste encerrado.
pause
