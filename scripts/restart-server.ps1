# Restarts the Health Review server so it runs the current code: stops the task and its node process
# (stop-server.ps1), starts the "Health-Review server" task again, and waits until /api/status answers.
#   npm run server:restart
param([int]$Port = 5188)

$ErrorActionPreference = 'Stop'
$taskName = 'Health-Review server'
& (Join-Path $PSScriptRoot 'stop-server.ps1') -Port $Port
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Start-ScheduledTask -TaskName $taskName
# Wait for the port, then ask /api/status once. Windows PowerShell tries localhost over IPv6 first (about 2 seconds
# before it falls back to 127.0.0.1, where the server listens), so the request gets a generous timeout.
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  $id = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1
  if ($id) { break }
}
if (-not $id) {
  Write-Output "The server did not start listening within 30 seconds; see data\logs\server.log."
  exit 1
}
try {
  Invoke-RestMethod "http://localhost:$Port/api/status" -TimeoutSec 15 | Out-Null
  Write-Output "Server restarted: http://localhost:$Port (process $id)."
} catch {
  Write-Output "The server is listening (process $id) but /api/status failed: $($_.Exception.Message)"
  exit 1
}
