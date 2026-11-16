# Copies the Lightsail server's settings into Parameter Store for the new server (v3 Phase 1G, docs/adr/0010). The owner
# runs it from infra\, signed in with aws login, after db-setup.ps1. Claude Code never runs it.
#
#   powershell -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode staging -Lightsail <user@address> -KeyFile <pem> `
#     -Site <staging app name> -DemoSite <staging demo name>
#   powershell -ExecutionPolicy Bypass -File env-to-ssm.ps1 -Mode production -Lightsail <user@address> -KeyFile <pem>   (1H)
#
# Reads /opt/health-review/.env and the Google sign-in files over SSH into memory only (never to disk), then stores each
# setting as a SecureString parameter /health-review/env/NAME encrypted with alias/health-review. The secrets that must
# match stay identical (USER_KEY_SECRET seals users' keys, HEALTH_BACKUP_PASSPHRASE opens the backups, SESSION_SECRET
# keeps sign-ins). The Drive sign-in becomes GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.
# Staging changes: the site names, no scheduled jobs, no email (SMTP left out), and its own Drive backup folder.
# Production (the 1H cutover) keeps every setting as Lightsail has it. Parameters under /health-review/env/ that the new set
# does not name are deleted, except DATABASE_URL and DB_ENGINE (db-setup.ps1's). Prints names only, never values.
param(
  [Parameter(Mandatory)][ValidateSet('staging', 'production')][string]$Mode,
  [Parameter(Mandatory)][string]$Lightsail,
  [Parameter(Mandatory)][string]$KeyFile,
  [string]$Site,
  [string]$DemoSite
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if ($Mode -eq 'staging' -and (-not $Site -or -not $DemoSite)) { throw 'Staging needs -Site and -DemoSite (the temporary names)' }
$region = terraform output -raw region
if ($LASTEXITCODE -ne 0) { throw 'terraform output region failed' }

function Remote($path) {
  $text = ssh -i $KeyFile -o BatchMode=yes $Lightsail "sudo cat $path"
  if ($LASTEXITCODE -ne 0) { throw "Could not read $path on Lightsail" }
  return ($text -join "`n")
}

# KEY=value lines; quotes around a value are removed, comments and blank lines skipped.
$settings = [ordered]@{}
foreach ($line in (Remote '/opt/health-review/.env') -split "`n") {
  $l = $line.Trim()
  if (-not $l -or $l.StartsWith('#')) { continue }
  $i = $l.IndexOf('=')
  if ($i -lt 1) { continue }
  $k = $l.Substring(0, $i).Trim()
  $v = $l.Substring($i + 1).Trim()
  if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
  if ($k -notmatch '^[A-Z][A-Z0-9_]*$') { throw "A setting name in .env is not NAME-shaped (line skipped would hide it)" }
  $settings[$k] = $v
}

# The Drive sign-in (backups, load-from-backup), as environment settings the app already reads.
if (-not $settings.Contains('GOOGLE_REFRESH_TOKEN')) {
  $token = Remote '/opt/health-review/data/google/token.json' | ConvertFrom-Json
  $client = (Remote '/opt/health-review/data/google/client_secret.json' | ConvertFrom-Json)
  $c = if ($client.installed) { $client.installed } else { $client.web }
  $settings['GOOGLE_CLIENT_ID'] = $c.client_id
  $settings['GOOGLE_CLIENT_SECRET'] = $c.client_secret
  $settings['GOOGLE_REFRESH_TOKEN'] = $token.refresh_token
}

# Never carried over: the SQLite path and anything the database setup owns.
foreach ($k in 'HEALTH_DB_PATH', 'DATABASE_URL', 'DB_ENGINE', 'DATA_DIR') { $settings.Remove($k) }

if ($Mode -eq 'staging') {
  $settings['SITE_ADDRESS'] = $Site
  $settings['DEMO_SITE_ADDRESS'] = $DemoSite
  $settings['PUBLIC_URL'] = "https://$Site"
  $settings['BACKUP_DRIVE_FOLDER'] = 'Health-Review staging backups'
  foreach ($k in @($settings.Keys)) {
    if ($k -like 'SCHEDULE_*' -or $k -like 'SMTP_*') { $settings.Remove($k) }
  }
} else {
  $settings.Remove('BACKUP_DRIVE_FOLDER')
}

foreach ($k in $settings.Keys) {
  $v = [string]$settings[$k]
  if (-not $v) { continue }
  if ($v.Contains("'") -or $v.Contains("`n")) { throw "$k holds a single quote or a line break, which the server's env file cannot carry" }
}

$prefix = '/health-review/env/'
$keep = @('DATABASE_URL', 'DB_ENGINE')
$existing = aws ssm get-parameters-by-path --region $region --path $prefix --query 'Parameters[].Name' --output json | ConvertFrom-Json
foreach ($name in $existing) {
  $k = $name.Substring($prefix.Length)
  if (-not $settings.Contains($k) -and $keep -notcontains $k) {
    aws ssm delete-parameter --region $region --name $name | Out-Null
    Write-Host "Deleted $name"
  }
}
foreach ($k in $settings.Keys) {
  $v = [string]$settings[$k]
  if (-not $v) { continue }
  aws ssm put-parameter --region $region --name "$prefix$k" --type SecureString --key-id alias/health-review --overwrite "--value=$v" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not store $prefix$k" }
}
Write-Host "Stored $($settings.Count) settings under $prefix ($Mode)"
$settings = $null
