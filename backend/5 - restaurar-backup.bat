@echo off
chcp 65001 >nul
title Restaurar Backup (.gz) - Controle de Compras Judiciais
cd /d "%~dp0"

echo ============================================================
echo   RESTAURAR BACKUP (DESCOMPACTAR .gz -^> .db)
echo ============================================================
echo.
echo Os backups sao salvos compactados (.db.gz) para economizar
echo espaco. Este utilitario DESCOMPACTA o backup mais recente
echo para a pasta:
echo     backend\data\backups\restaurados
echo.
echo Dica: para restaurar um backup ESPECIFICO, arraste o arquivo
echo .db.gz para cima deste .bat (ou informe o caminho).
echo ============================================================
echo.

node src/descompactarBackup.js "%~1"

echo.
if errorlevel 1 (
  echo ------------------------------------------------------------
  echo   ATENCAO: algo deu errado. Leia a mensagem acima.
  echo ------------------------------------------------------------
) else (
  echo ------------------------------------------------------------
  echo   PRONTO! O arquivo .db foi gerado em data\backups\restaurados.
  echo.
  echo   PARA RESTAURAR DE VERDADE:
  echo     1) PARE o sistema (feche o "3 - iniciar-sistema.bat").
  echo     2) Copie o .db gerado por cima de:
  echo          backend\data\medicamentos_judicial.db
  echo     3) Inicie o sistema de novo.
  echo ------------------------------------------------------------
)
echo.
pause
