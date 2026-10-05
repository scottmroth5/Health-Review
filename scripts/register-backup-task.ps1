# Registers (or replaces) the nightly encrypted backup to Google Drive as a Windows scheduled task.
#   powershell -ExecutionPolicy Bypass -File scripts\register-backup-task.ps1 [-At 11:00pm]
# Runs while you are signed in, hidden (conhost --headless), and catches up after sleep or shutdown.
# Remove with: Unregister-ScheduledTask -TaskName "Health-Review nightly backup"
param([string]$At = '11:00pm')

$ErrorActionPreference = 'Stop'
$taskName = 'Health-Review nightly backup'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $repo 'scripts\backup-nightly.cmd'
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c `"`"$wrapper`" `"$node`"`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Encrypted backup of data/health.db to Google Drive (npm run backup).' -Force | Out-Null
Write-Output "Registered '$taskName' daily at $At using $node"
