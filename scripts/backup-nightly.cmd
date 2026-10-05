@echo off
rem Run by the "Health-Review nightly backup" scheduled task (see register-backup-task.ps1).
rem Appends each run's output (file name, size and counts only) to data\logs\backup.log.
rem Optional first argument: full path to node.exe, for when node is not on the task's PATH.
setlocal
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
set "NODE=%~1"
if "%NODE%"=="" set "NODE=node"
echo ==== %DATE% %TIME% >> data\logs\backup.log
"%NODE%" --env-file=.env scripts\backup.js >> data\logs\backup.log 2>&1
exit /b %ERRORLEVEL%
