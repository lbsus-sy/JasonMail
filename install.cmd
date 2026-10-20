@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%INSTALL_EXIT_CODE%"=="0" (
  echo Jason Mail installer stopped with an error. Read the message above, fix that step, and run install.cmd again.
)
pause
exit /b %INSTALL_EXIT_CODE%

