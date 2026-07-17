@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Vou abrir o arquivo de configuracao no Bloco de Notas.
echo Cole sua SENHA depois de   GSNET_SENHA=   e salve (Ctrl+S).
echo.
notepad .env
