# Stops the Health Review server: ends the "Health-Review server" task, then the node process listening on the port.
#   npm run server:stop
#   powershell -ExecutionPolicy Bypass -File scripts\stop-server.ps1 [-Port 5188] [-KeepTask]
# Ending the task alone leaves node running (the task runs conhost, then cmd, then node, and only the first is
# stopped), so the old server kept answering with old code. Only a node process whose command line runs
# server\index.js is stopped, never anything else on the port. -KeepTask skips ending the task (server-start.cmd
# uses it to clear a leftover server before starting a new one).
param([int]$Port = 5188, [switch]$KeepTask)

$taskName = 'Health-Review server'
if (-not $KeepTask) {
  try { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop } catch {}
}

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $listeners) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
  if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'server[\\/]index\.js') {
    Stop-Process -Id $id -Force -Confirm:$false
    Write-Output "Stopped the server on port $Port (process $id)."
  } elseif ($p) {
    Write-Output "Port $Port is used by $($p.Name) (process $id), which is not the Health Review server; left running."
    exit 1
  }
}

for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { exit 0 }
  Start-Sleep -Milliseconds 500
}
Write-Output "Port $Port is still in use after 10 seconds."
exit 1
