# Registers (or replaces) the weekly review as a Windows scheduled task for the current user.
#   powershell -ExecutionPolicy Bypass -File scripts\register-review-task.ps1 [-Day Sunday] [-At 8:00am]
# Runs while you are signed in, hidden (conhost --headless), and catches up after sleep or shutdown.
# Each run costs a Claude API call (about $0.10 to $0.30 on claude-opus-5-5).
# Remove with: Unregister-ScheduledTask -TaskName "Health-Review weekly review"
param([string]$Day = 'Sunday', [string]$At = '8:00am')

$ErrorActionPreference = 'Stop'
$taskName = 'Health-Review weekly review'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $repo 'scripts\review-weekly.cmd'
$node = (Get-Command node).Source

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c `"`"$wrapper`" `"$node`"`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Syncs and writes the weekly health review (npm run review); read it on the Reviews tab.' -Force | Out-Null
Write-Output "Registered '$taskName' every $Day at $At using $node"
