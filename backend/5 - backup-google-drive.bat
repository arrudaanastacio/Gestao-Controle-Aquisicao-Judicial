@echo off
chcp 65001 >nul
title Backup no Google Drive - Controle de Compras Judiciais
cd /d "%~dp0"

echo ============================================================
echo   BACKUP DO BANCO NO GOOGLE DRIVE
echo ============================================================
echo.
echo Cria uma copia segura do banco dentro da pasta do Google
echo Drive (Meu Drive\Backup Compras Judiciais), e o Google
echo sincroniza para a nuvem automaticamente.
echo.
echo Precisa do "Google Drive para Desktop" instalado e logado.
echo ============================================================
echo.

node src/backupGoogleDrive.js

echo.
if errorlevel 1 (
  echo ------------------------------------------------------------
  echo   ATENCAO: nao deu certo. Leia a mensagem acima.
  echo   Em geral e porque o Google Drive ainda nao esta instalado.
  echo ------------------------------------------------------------
) else (
  echo ------------------------------------------------------------
  echo   PRONTO! Backup enviado para o Google Drive.
  echo ------------------------------------------------------------
)
echo.
pause
