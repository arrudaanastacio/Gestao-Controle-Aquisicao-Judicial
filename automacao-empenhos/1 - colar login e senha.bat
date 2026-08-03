@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Vou abrir o arquivo de configuracao no Bloco de Notas.
echo.
echo Preencha:
echo    GSNET_USUARIO=  (seu usuario do GsnetCompras)
echo    GSNET_SENHA=    (sua senha)
echo.
echo Depois salve com Ctrl+S e feche o Bloco de Notas.
echo.
notepad .env
