@echo off
rem Start IT Helpdesk (used by the scheduled task, or double-click to run by hand).
rem Usage: run.bat [full path to node.exe]
setlocal
cd /d "%~dp0..\.."
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
if not exist logs mkdir logs
rem rotate the log when it exceeds 10 MB (keeps one old copy)
if exist logs\helpdesk.log for %%F in (logs\helpdesk.log) do if %%~zF GTR 10485760 move /y logs\helpdesk.log logs\helpdesk.old.log >nul
set NODE_ENV=production
if not defined LOG_REQUESTS set LOG_REQUESTS=0
echo [%date% %time%] starting >> logs\helpdesk.log
"%NODE_EXE%" --disable-warning=ExperimentalWarning src\server.js >> logs\helpdesk.log 2>&1
set "RC=%ERRORLEVEL%"
echo [%date% %time%] stopped, exit code %RC% >> logs\helpdesk.log
exit /b %RC%
