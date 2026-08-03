@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Acao agendada (3h e 13h30): baixa o relatorio e importa no sistema.
rem O log de cada passo fica em log.txt (e importar grava em log-import.txt).
node baixar-empenhos.js
if errorlevel 1 (
  echo %date% %time% - FALHA no download >> log-agenda.txt
  exit /b 1
)
node importar-planilha.js >> log-import.txt 2>&1
echo %date% %time% - OK (baixou e importou) >> log-agenda.txt
