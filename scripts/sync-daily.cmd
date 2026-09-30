@echo off
rem Run by the "Health-Review daily sync" scheduled task (see register-sync-task.ps1).
rem Appends each run's output (counts and warnings only) to data\logs\sync.log.
rem Optional first argument: full path to node.exe, for when node is not on the task's PATH.
setlocal
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
set "NODE=%~1"
if "%NODE%"=="" set "NODE=node"
echo ==== %DATE% %TIME% >> data\logs\sync.log
"%NODE%" --env-file=.env scripts\sync.js >> data\logs\sync.log 2>&1
exit /b %ERRORLEVEL%
