@echo off
chcp 65001 >nul
title Controle de Compras Judiciais - REINICIAR
cd /d "%~dp0"

rem Descobre a porta pelo .env DESTA pasta (producao=3000, teste=3001),
rem para encerrar/subir sempre o servidor correto da pasta onde o atalho esta.
set PORT=3000
for /f "usebackq tokens=2 delims==" %%a in (`findstr /b /c:"PORT=" ".env"`) do set PORT=%%a

echo ============================================================
echo   REINICIAR O SISTEMA  (porta %PORT%)
echo ============================================================
echo.
echo Este atalho ENCERRA o servidor preso na porta %PORT% e sobe o
echo sistema de novo, ja com a versao mais recente do codigo.
echo (A porta vem do .env desta pasta - nao afeta a outra instancia.)
echo ============================================================
echo.

echo Encerrando servidores presos na porta %PORT% (se houver)...
powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c.OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } ; Write-Host '   Servidor antigo encerrado.' } else { Write-Host '   Nada estava preso. Tudo certo.' }"

echo.
echo Subindo o sistema...
echo.
echo Para acessar NESTE computador:  http://localhost:%PORT%
echo Para PARAR o sistema, feche esta janela ou aperte Ctrl+C.
echo ============================================================
echo.

rem Usa o repositorio de certificados do Windows (CA da UDTP/gov).
set NODE_USE_SYSTEM_CA=1
node src/server.js

echo.
echo O servidor foi encerrado.
pause
