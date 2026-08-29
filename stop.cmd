@echo off
rem Остановка сервера двойным щелчком, когда окно с ним потерялось или свёрнуто.
rem PID сервер пишет сам при запуске, так что искать процесс руками не нужно.
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title HeadHunter - остановка сервера

if not exist "data\server.pid" (
  echo Сервер не запущен.
  echo Если окно с сервером всё же открыто, нажмите в нём Ctrl+C или закройте его.
  pause
  exit /b 0
)

set /p SRVPID=<"data\server.pid"
tasklist /FI "PID eq !SRVPID!" 2>nul | find /I "node.exe" >nul
if errorlevel 1 (
  echo Сервер уже остановлен, убираю старую отметку.
  del "data\server.pid" >nul 2>nul
  pause
  exit /b 0
)

echo Останавливаю сервер...
taskkill /PID !SRVPID! /F >nul 2>nul
if errorlevel 1 (
  echo Не удалось остановить сервер сам. Закройте его окно вручную.
  pause
  exit /b 1
)

del "data\server.pid" >nul 2>nul
echo Сервер остановлен, игра сохранена.
echo Запустить снова - start.cmd, все игроки и очки останутся на месте.
pause
