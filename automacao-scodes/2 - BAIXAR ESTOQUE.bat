@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Baixando o relatorio "Itens em Estoque" do SCODES...
echo ============================================================
echo.
python baixar_estoque.py
echo.
pause
