@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Acao agendada (23h): baixa o Relatorio Estrategico de Compras e importa no sistema.
rem O log de cada passo fica em log-compras.txt (importar grava em log-import-compras.txt).
node baixar-compras.js
if errorlevel 1 (
  echo %date% %time% - FALHA no download >> log-agenda-compras.txt
  exit /b 1
)
node importar-compras.js >> log-import-compras.txt 2>&1
echo %date% %time% - OK (baixou e importou) >> log-agenda-compras.txt
