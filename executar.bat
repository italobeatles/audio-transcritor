@echo off
setlocal
cd /d "%~dp0"
echo.
echo === Transcritor de Audios ===
echo.
if not exist node_modules (
  echo Dependencias nao encontradas. Executando instalar.bat primeiro...
  call instalar.bat
)
call npm start
echo.
echo Processo finalizado. Veja a pasta output.
pause
