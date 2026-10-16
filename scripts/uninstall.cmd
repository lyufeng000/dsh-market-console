@echo off
REM ===========================================================================
REM  dsh-market-console - double-click to uninstall
REM ===========================================================================
REM  Usage:
REM    uninstall.cmd                  remove from the auto-resolved profile
REM    uninstall.cmd -WhatIf          print the planned changes only
REM    uninstall.cmd -KeepPackage     unmount but keep the package directory
REM ===========================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
