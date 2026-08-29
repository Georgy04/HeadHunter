@echo off
rem Запуск сервера на ноутбуке-хосте двойным щелчком: ставит зависимости при
rem первом старте и не закрывает окно, если что-то пошло не так.
rem chcp нужен для русских сообщений: файл в UTF-8, а консоль по умолчанию в cp866.
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title HeadHunter - сервер игры, не закрывайте это окно

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите его с https://nodejs.org и запустите файл снова.
  pause
  exit /b 1
)

rem Второй запуск поверх первого выглядел бы как непонятная ошибка про занятый порт.
rem Отметка переживает жёсткую перезагрузку, а её номер достаётся потом чужому
rem процессу. Поэтому верим ей только если процесс и правда слушает наш порт.
set SRVUP=
if exist "data\server.pid" (
  set /p SRVPID=<"data\server.pid"
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":3000 " ^| findstr /C:"LISTENING"') do (
    if "%%p"=="!SRVPID!" set SRVUP=1
  )
)
if defined SRVUP (
  echo Сервер уже запущен, второй раз запускать не нужно.
  echo Его окно где-то открыто; остановить сервер можно файлом stop.cmd.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Ставим зависимости, это займёт минуту...
  call npm install || (echo Не удалось поставить зависимости. & pause & exit /b 1)
)

node server/index.js
echo.
echo Сервер остановлен, игра сохранена. Окно можно закрыть.
echo Чтобы продолжить игру, запустите start.cmd снова.
pause
