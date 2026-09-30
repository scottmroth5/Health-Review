# Registers (or replaces) the daily sync as a Windows scheduled task for the current user.
#   powershell -ExecutionPolicy Bypass -File scripts\register-sync-task.ps1 [-At 7:00am]
# Runs while you are signed in, hidden (conhost --headless), and catches up after sleep or shutdown.
# Remove with: Unregister-ScheduledTask -TaskName "Health-Review daily sync"
param([string]$At = '7:00am')

$ErrorActionPreference = 'Stop'
$taskName = 'Health-Review daily sync'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $repo 'scripts\sync-daily.cmd'
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c `"`"$wrapper`" `"$node`"`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Copies new rows from the Google Sheets into data/health.db (npm run sync).' -Force | Out-Null
Write-Output "Registered '$taskName' daily at $At using $node"
