@echo off
chcp 65001 >nul
title Salvar no GitHub - Controle de Compras Judiciais
cd /d "%~dp0.."

echo ============================================================
echo   SALVAR (BACKUP) NO GITHUB
echo ============================================================
echo.
echo Este programa envia para o GitHub TODAS as alteracoes feitas
echo no sistema desde a ultima vez que voce salvou.
echo.
echo Os dados (banco) e a senha (.env) NAO sao enviados - apenas
echo o codigo do sistema.
echo ============================================================
echo.

set /p MENSAGEM="Descreva em poucas palavras o que mudou (Enter para padrao): "
if "%MENSAGEM%"=="" set MENSAGEM=Atualizacao do sistema

echo.
echo Verificando alteracoes...
git add -A

echo Registrando alteracoes...
git commit -m "%MENSAGEM%"

echo.
echo Enviando para o GitHub...
git push

echo.
if errorlevel 1 (
  echo ------------------------------------------------------------
  echo   ATENCAO: algo deu errado no envio. Leia as mensagens
  echo   acima. Se aparecer "nothing to commit", significa que
  echo   nao havia nada novo para salvar - tudo certo.
  echo ------------------------------------------------------------
) else (
  echo ------------------------------------------------------------
  echo   PRONTO! Tudo salvo no GitHub com sucesso.
  echo ------------------------------------------------------------
)
echo.
pause
