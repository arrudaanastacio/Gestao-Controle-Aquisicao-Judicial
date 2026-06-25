@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   BACKUP COMPLETO DO BANCO DE DADOS
echo ================================================
echo.
echo Gera, em backend\data\export:
echo   - dump_completo_DATA.sql  (estrutura + todos os dados)
echo   - esquema.sql             (so a estrutura)
echo   - backup_banco_DATA.db    (copia direta do banco)
echo.

rem 1) Gera os arquivos .sql (estrutura + dados)
node src\exportarBanco.js
if errorlevel 1 goto erro

rem 2) Copia o arquivo .db com a data de hoje (AAAA-MM-DD)
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set HOJE=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
copy /Y "data\medicamentos_judicial.db" "data\export\backup_banco_%HOJE%.db" >nul
if errorlevel 1 goto erro

echo.
echo ================================================
echo   Backup concluido! Arquivos em backend\data\export
echo ================================================
echo.
echo DICA: copie a pasta "export" para um pendrive ou nuvem
echo       para manter o backup seguro fora desta maquina.
echo.
pause
goto fim

:erro
echo.
echo *** Ocorreu um erro ao gerar o backup. ***
echo Verifique se o sistema esta instalado (pasta node_modules) e tente de novo.
echo.
pause

:fim
