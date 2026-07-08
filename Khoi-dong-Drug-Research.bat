@echo off
title Drug Research Pro
color 0B
echo.
echo  =========================================
echo   DRUG RESEARCH PRO - Dang khoi dong...
echo  =========================================
echo.

:: Tim Node.js
set "NODE_PATH="
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE_PATH=%%i"

if "%NODE_PATH%"=="" (
    echo  [LOI] Khong tim thay Node.js!
    echo  Vui long cai dat Node.js tai: https://nodejs.org
    pause
    exit /b 1
)

echo  [OK] Node.js: %NODE_PATH%
echo  [OK] Dang khoi dong server...
echo.

:: Mo trinh duyet sau 2 giay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Chay server
node "%~dp0server.js"

pause
