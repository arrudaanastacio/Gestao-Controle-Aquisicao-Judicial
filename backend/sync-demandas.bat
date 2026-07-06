@echo off
REM =====================================================================
REM sync-demandas.bat
REM Roda a sincronizacao diaria das demandas judiciais (Oracle -> SQLite).
REM Agende no Agendador de Tarefas do Windows para rodar as 6h da manha.
REM Grava um log em logs\sync-demandas-AAAA-MM-DD.log
REM =====================================================================
cd /d "C:\Compras Judiciais\backend"

if not exist logs mkdir logs

set LOGFILE=logs\sync-demandas-%date:~-4%-%date:~3,2%-%date:~0,2%.log

echo ===================================================== >> "%LOGFILE%"
echo Iniciando sync em %date% %time% >> "%LOGFILE%"
echo ===================================================== >> "%LOGFILE%"

node sync-demandas.js >> "%LOGFILE%" 2>&1

echo Sync finalizado em %date% %time% >> "%LOGFILE%"
