@echo off
chcp 65001 >nul
title Backup do Banco - Controle de Compras Judiciais
cd /d "%~dp0"

echo ============================================================
echo   BACKUP (COPIA DE SEGURANCA) DO BANCO DE DADOS
echo ============================================================
echo.
echo Cria uma copia segura e datada do banco na pasta:
echo     backend\data\backups
echo.
echo Pode rodar com o sistema LIGADO - a copia sai consistente.
echo Backups diarios mantidos por 14 dias + 1 backup por mes
echo (longo prazo) na subpasta backups\mensais.
echo ============================================================
echo.

node src/backupBanco.js

echo.
if errorlevel 1 (
  echo ------------------------------------------------------------
  echo   ATENCAO: algo deu errado. Leia a mensagem acima.
  echo ------------------------------------------------------------
) else (
  echo ------------------------------------------------------------
  echo   PRONTO! Backup criado com sucesso.
  echo ------------------------------------------------------------
)
echo.
pause
