@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   EXTRAIR ATAS DO SISCOA
echo ================================================
echo.
echo Entra no SISCOA automaticamente, baixa o relatorio de Atas
echo e salva na pasta compartilhada. O sistema importa sozinho
echo em seguida (mesmo mecanismo do Estoque).
echo.
node scripts\extrairAtasSiscoa.js
echo.
echo Concluido.
echo.
pause
