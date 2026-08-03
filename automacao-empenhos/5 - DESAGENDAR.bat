@echo off
chcp 65001 >nul
title Remover agendamento do robo de Empenhos
echo Removendo as tarefas agendadas...
schtasks /Delete /TN "ComprasJudiciais-Empenhos-0300" /F
schtasks /Delete /TN "ComprasJudiciais-Empenhos-1330" /F
echo.
echo Pronto (se aparecer "SUCCESS/EXITO", foram removidas).
pause
