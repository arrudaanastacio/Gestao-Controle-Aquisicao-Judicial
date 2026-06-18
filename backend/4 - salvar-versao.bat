@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
echo ================================================
echo   SALVAR UMA VERSAO DO SISTEMA
echo ================================================
echo.
echo Isto guarda uma "foto" do estado atual do codigo,
echo para que voce possa voltar a ela depois se precisar.
echo.
set /p DESCRICAO="Descreva em poucas palavras o que mudou: "
echo.
git add -A
git commit -m "%DESCRICAO%"
echo.
echo ================================================
echo   Versao salva! Lista das ultimas versoes:
echo ================================================
git log --oneline -10
echo.
pause
