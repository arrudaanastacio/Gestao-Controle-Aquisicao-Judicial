@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agendar robo de Empenhos (3h e 13h30)
color 0B
echo ============================================================
echo    AGENDAR o robo de Empenhos para rodar sozinho
echo    todos os dias as 03:00 e as 13:30
echo ============================================================
echo.
set "ALVO=%~dp0rodar-automatico.bat"
echo Acao agendada: "%ALVO%"
echo.

schtasks /Create /TN "ComprasJudiciais-Empenhos-0300" /TR "\"%ALVO%\"" /SC DAILY /ST 03:00 /F
schtasks /Create /TN "ComprasJudiciais-Empenhos-1330" /TR "\"%ALVO%\"" /SC DAILY /ST 13:30 /F

echo.
echo === Tarefas criadas: ===
schtasks /Query /TN "ComprasJudiciais-Empenhos-0300" /FO LIST | findstr /I "TaskName Proxima Next Status"
schtasks /Query /TN "ComprasJudiciais-Empenhos-1330" /FO LIST | findstr /I "TaskName Proxima Next Status"
echo.
echo Pronto. Se aparecer "SUCCESS/EXITO" acima, o agendamento esta ativo.
echo (Para remover depois, use o "5 - DESAGENDAR.bat".)
echo.
pause
