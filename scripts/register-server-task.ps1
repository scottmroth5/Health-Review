# Registers (or replaces) the UI and API server as a Windows scheduled task that starts when you sign in, then
# starts it now so there is no need to sign out first.
#   powershell -ExecutionPolicy Bypass -File scripts\register-server-task.ps1
# Runs hidden (conhost --headless) until you sign out, restarts up to 3 times if it crashes, and logs its startup
# line and errors to data\logs\server.log. Still bound to 127.0.0.1 only (AUTH_MODE=none).
# Stop it with:   Stop-ScheduledTask -TaskName "Health-Review server"
# Remove with:    Unregister-ScheduledTask -TaskName "Health-Review server"
$ErrorActionPreference = 'Stop'
$taskName = 'Health-Review server'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wrapper = Join-Path $repo 'scripts\server-start.cmd'
$node = (Get-Command node).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless cmd.exe /c `"`"$wrapper`" `"$node`"`"" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'  # let the disk and network settle after sign-in
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Health Review UI and API at http://localhost:5188 (npm start), started at sign-in.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Registered '$taskName' to start at sign-in using $node, and started it now: http://localhost:5188"
