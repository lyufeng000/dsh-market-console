@echo off
REM ===========================================================================
REM  dsh-market-console - double-click to install
REM  Bypasses the machine's script execution policy, which blocks .ps1 by default.
REM ===========================================================================
REM  Usage:
REM    install.cmd                    install into the auto-resolved profile
REM    install.cmd -Profile desktop   target a specific profile
REM    install.cmd -Mode Copy         copy instead of creating a junction
REM ===========================================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
