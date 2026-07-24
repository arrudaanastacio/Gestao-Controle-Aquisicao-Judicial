@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Instalando o que a automacao SCODES precisa (so a 1a vez)
echo ============================================================
echo.
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
echo.
echo Pronto! Se nao deu erro vermelho acima, esta instalado.
echo.
pause
