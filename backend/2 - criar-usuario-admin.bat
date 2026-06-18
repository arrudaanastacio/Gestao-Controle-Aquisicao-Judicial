@echo off
chcp 65001 >nul
title Controle de Compras Judiciais - Criar usuario admin
cd /d "%~dp0"

echo ============================================================
echo   CRIAR USUARIO ADMINISTRADOR
echo ============================================================
echo.
echo Este usuario podera fazer login e tem acesso total ao sistema.
echo.

set /p NOME="Digite o nome do usuario (ex: Rafael): "
set /p EMAIL="Digite o e-mail de login (ex: rafael@tenentepena.local): "
set /p SENHA="Digite a senha: "

echo.
echo Criando usuario...
node src/seedAdmin.js "%NOME%" "%EMAIL%" "%SENHA%"

echo.
echo Se apareceu "Usuario admin criado/atualizado" acima, deu certo!
echo Guarde o e-mail e a senha para fazer login.
echo.
echo Proximo passo: rode o arquivo "3 - iniciar-sistema.bat"
echo.
pause
