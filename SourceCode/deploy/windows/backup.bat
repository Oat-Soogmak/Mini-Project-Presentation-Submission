@echo off
rem Daily backup (used by the scheduled task). Output: data\backups\helpdesk-*.db.gz
rem Usage: backup.bat [full path to node.exe]
setlocal
cd /d "%~dp0..\.."
set "NODE_EXE=%~1"
if "%NODE_EXE%"=="" set "NODE_EXE=node"
if not exist logs mkdir logs
"%NODE_EXE%" --disable-warning=ExperimentalWarning scripts\backup.js >> logs\backup.log 2>&1
exit /b %ERRORLEVEL%
