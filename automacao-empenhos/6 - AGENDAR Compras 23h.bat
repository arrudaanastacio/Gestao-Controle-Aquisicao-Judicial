@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agendar robo de Compras (23h)
color 0B
echo ============================================================
echo    AGENDAR o robo de Compras para rodar sozinho
echo    todos os dias as 23:00
echo ============================================================
echo.
set "ALVO=%~dp0rodar-automatico-compras.bat"
echo Acao agendada: "%ALVO%"
echo.

schtasks /Create /TN "ComprasJudiciais-Compras-2300" /TR "\"%ALVO%\"" /SC DAILY /ST 23:00 /F

echo.
echo === Tarefa criada: ===
schtasks /Query /TN "ComprasJudiciais-Compras-2300" /FO LIST | findstr /I "TaskName Proxima Next Status"
echo.
echo Pronto. Se aparecer "SUCCESS/EXITO" acima, o agendamento esta ativo.
echo (Para remover depois: schtasks /Delete /TN "ComprasJudiciais-Compras-2300" /F)
echo.
pause
