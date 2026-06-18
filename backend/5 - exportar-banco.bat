@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo   EXPORTAR BANCO DE DADOS (backup completo)
echo ================================================
echo.
echo Gera dois arquivos em backend\data\export:
echo   - esquema.sql            (so a estrutura das tabelas)
echo   - dump_completo_DATA.sql (estrutura + todos os dados)
echo.
node src\exportarBanco.js
echo.
echo Pronto! Os arquivos estao em backend\data\export
echo.
pause
