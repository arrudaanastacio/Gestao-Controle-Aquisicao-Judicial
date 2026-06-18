@echo off
chcp 65001 >nul
title Controle de Compras Judiciais - Instalacao
cd /d "%~dp0"

echo ============================================================
echo   INSTALACAO DO SISTEMA - Controle de Compras Judiciais
echo ============================================================
echo.

REM --- Verifica se o Node esta instalado ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo.
  echo Instale o Node.js versao 22 ou superior em https://nodejs.org
  echo Baixe a versao LTS, instale e rode este arquivo novamente.
  echo.
  pause
  exit /b 1
)

echo Versao do Node instalada:
node --version
echo.
echo IMPORTANTE: a versao precisa ser v22 ou superior.
echo Se aparecer v20 ou menor acima, atualize o Node antes de continuar.
echo.

REM --- Cria o arquivo .env se nao existir ---
if not exist ".env" (
  echo Criando arquivo de configuracao .env ...
  copy ".env.example" ".env" >nul
  echo .env criado. Lembre-se de trocar o JWT_SECRET depois, se for usar em rede.
  echo.
)

echo Instalando as dependencias (isso pode levar 1 a 2 minutos)...
echo.
call npm install --no-fund --no-audit

if errorlevel 1 (
  echo.
  echo [ERRO] Falha ao instalar as dependencias.
  echo Verifique sua conexao com a internet e tente de novo.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   INSTALACAO CONCLUIDA!
echo ============================================================
echo.
echo Proximo passo: rode o arquivo "2 - criar-usuario-admin.bat"
echo para criar seu usuario de acesso.
echo.
pause
