@echo off
setlocal
cd /d "%~dp0"
echo.
echo === Instalador do Transcritor de Audios ===
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado no PATH.
  echo Instale o Node.js LTS em https://nodejs.org/ e tente novamente.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo ERRO: npm nao encontrado no PATH.
  pause
  exit /b 1
)
echo Instalando dependencias locais...
call npm install
if errorlevel 1 (
  echo ERRO: npm install falhou.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Foi criado o arquivo .env.
  echo Abra o arquivo .env e preencha OPENAI_API_KEY antes de executar.
)
echo.
call npm run diagnostico
echo.
echo Instalacao concluida.
pause
