@echo off
rem Запуск сервера на ноутбуке-хосте двойным щелчком: ставит зависимости при
rem первом старте и не закрывает окно, если что-то пошло не так.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите его с https://nodejs.org и запустите файл снова.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Ставим зависимости, это займёт минуту...
  call npm install || (echo Не удалось поставить зависимости. & pause & exit /b 1)
)

node server/index.js
pause
