@echo off
rem Run by the "Health-Review server" scheduled task at sign-in (see register-server-task.ps1).
rem Appends the server's output (the startup line and any errors; requests are not logged) to data\logs\server.log.
rem Optional first argument: full path to node.exe, for when node is not on the task's PATH.
setlocal
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
set "NODE=%~1"
if "%NODE%"=="" set "NODE=node"
echo ==== %DATE% %TIME% >> data\logs\server.log
"%NODE%" --env-file=.env server\index.js >> data\logs\server.log 2>&1
exit /b %ERRORLEVEL%
