@echo off
REM Double-click after advancing a week in Madden. Exports your newest franchise save and uploads it.
cd /d "%~dp0"
node exporter/export.js %*
echo.
pause
