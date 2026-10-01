@echo off
rem Run by the "Health-Review weekly review" scheduled task (see register-review-task.ps1).
rem Syncs, writes the review for the week ending last Saturday, and appends the run's
rem metadata (never report text) to data\logs\review.log.
rem Optional first argument: full path to node.exe, for when node is not on the task's PATH.
setlocal
cd /d "%~dp0.."
if not exist data\logs mkdir data\logs
set "NODE=%~1"
if "%NODE%"=="" set "NODE=node"
echo ==== %DATE% %TIME% >> data\logs\review.log
"%NODE%" --env-file=.env scripts\review.js >> data\logs\review.log 2>&1
exit /b %ERRORLEVEL%
