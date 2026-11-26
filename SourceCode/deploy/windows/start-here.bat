@echo off
rem Run the server in this window (for a quick test). Close the window or press Ctrl+C to stop.
setlocal
cd /d "%~dp0..\.."
if not exist .env copy .env.windows.example .env >nul
set NODE_ENV=production
node --disable-warning=ExperimentalWarning src\server.js
pause
