@echo off
:: JARVIS Windows Launcher
:: Run this to start JARVIS detached from the command prompt

set DIR=%~dp0
set ELECTRON=%DIR%node_modules\.bin\electron.cmd

if not exist "%ELECTRON%" (
    echo Electron not found. Run: npm install
    pause
    exit /b 1
)

:: Kill any existing JARVIS instance
taskkill /F /IM electron.exe /FI "WINDOWTITLE eq JARVIS*" 2>nul

:: Launch detached so command prompt can close
start "JARVIS" /B "%ELECTRON%" "%DIR%" --no-sandbox > "%USERPROFILE%\jarvis.log" 2>&1

echo.
echo  J.A.R.V.I.S. launched
echo  Look for the orb in the top-left corner of your screen
echo  Logs: %USERPROFILE%\jarvis.log
echo.
timeout /t 2 >nul
