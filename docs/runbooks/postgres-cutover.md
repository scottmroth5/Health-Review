# Cutover runbook: Lightsail (SQLite) to EC2 and RDS (PostgreSQL)

v3 Phase 1H, run 2026-11-17 (the fixes found that day are folded in). Lightsail was deleted on 2026-11-22, after five
clean days instead of 14 (owner's choice), so "Back out before DNS" and the rollback below are a record only; a restore
now comes from RDS's point-in-time recovery or the encrypted Drive backups. The owner runs every step; Claude guides live. Names in angle brackets are the owner's own values (the app
and demo names, the staging names, the Lightsail address, the Elastic IP, the running image tag). None of them belong in
this repository.

The new server already runs staging on the one RDS database (infra/README.md steps 1 to 8). Cutover replaces staging's
copy of the data with a final one, switches that server to production settings, and moves DNS. Lightsail stays, stopped,
for 14 days as the fallback.

Run every server command on its own line. In an SSM session, type `bash` first: its default shell garbles multi-line
pastes. Commands on the new server run in `/opt/health-review`; so do the Lightsail ones.

Expected downtime: about an hour, most of it the smoke tests in step 4. The demo stays up throughout.

## Connecting

The new server (from `infra\`, in PowerShell):
```powershell
$env:Path += ";$HOME\tools\terraform;C:\Program Files\Amazon\SessionManagerPlugin\bin"
aws ssm start-session --region us-east-2 --target (terraform output -raw server_instance_id)
```
Lightsail (from the repository folder): `ssh -i <Lightsail key file> ubuntu@<Lightsail address>`

## 0. The day before
- Lower the TTL of the app's and the demo's A records to 300 seconds.
- Rehearse on staging (the new server, still staging settings): step 3 below, ending in PASS. Repeat it if the cutover
  slips more than 48 hours.
- Check that the new server runs the same image tag as Lightsail (`sudo -u deploy ./deploy.sh status` on both); deploy
  it to the new server if not.
- Tell the other users the window (a short email from the owner).
- Check Lightsail's last nightly backup on the Activity tab.
- Install the current `deploy/Caddyfile` on both servers (deploys never copy it), so a stopped app shows the
  maintenance line; the reload doesn't interrupt the sites:
  ```bash
  sudo curl -fsSL -o Caddyfile https://raw.githubusercontent.com/scottmroth5/Health-Review/<commit>/deploy/Caddyfile
  sudo -u deploy docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
  ```

## 1. Freeze Lightsail
1. Stop the app (the demo keeps running; Caddy answers "down for maintenance" with a 503):
   ```bash
   cd /opt/health-review
   sudo -u deploy docker compose stop app
   ```
2. In the Lightsail console, take a manual snapshot of the instance (after the stop, so nothing is writing to the file).

From here on nothing writes to the SQLite database. Health Auto Export's posts fail with the 503; step 8 sends those
days again.

## 2. Final backup on Lightsail
The same encrypted Drive backup as every night, from the stopped app's database; it becomes the newest file in
production's Drive folder.
```bash
sudo -u deploy env IMAGE_TAG=<tag> docker compose run --rm --no-deps -T app node scripts/backup.js
```
Expect a line naming `health-<today>.hrbk`.

## 3. Load it into RDS (new server, staging settings)
```bash
sudo -u deploy env COMPOSE_PROFILES=postgres docker compose stop app backup
sudo -u deploy env IMAGE_TAG=<tag> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js reset-database --confirm health_review
sudo -u deploy env IMAGE_TAG=<tag> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js load-from-backup
sudo -u deploy ./deploy.sh up
```
The load must name today's file from step 2 and end in `PASS: every table copied and verified`. Anything else: stop and
go to "Back out before DNS".

## 4. Smoke tests on the staging name
As the owner, and as a second user in a private window:
- sign-in and every tab; the newest data matches what Lightsail showed;
- Sync now;
- Download my data;
- the second user sees only their own data.

Any failure: "Back out before DNS".

## 5. Production settings into Parameter Store
In PowerShell, from `infra\`:
```powershell
.\env-to-ssm.ps1 -Mode production -Lightsail ubuntu@<Lightsail address> -KeyFile <Lightsail key file>
```
Lightsail's settings as they are: the real names, the schedules and email. The staging-only Drive folder setting is
deleted, so backups go to production's folder. Nothing on the server changes until step 6's restart.

## 6. DNS, then restart with production settings
1. Point the app's and the demo's A records at the Elastic IP (`terraform output -raw server_public_ip`).
2. Wait until both resolve to it: `Resolve-DnsName <app name>` and `Resolve-DnsName <demo name>`.
3. On the new server: `sudo -u deploy ./deploy.sh up` (it reads the production settings; Caddy gets certificates for the
   real names).
4. Open both names over https.

## 7. Move the deploys
GitHub's deploy job still points at Lightsail. In PowerShell, from `infra\` (Windows' own ssh-keyscan is too old for the
server's key exchange, and PowerShell has no `<` redirect, hence these forms):
1. On the new server (SSM), the public host key: `sudo cat /etc/ssh/ssh_host_ed25519_key.pub`. Over SSM it comes through
   an authenticated channel, so no fingerprint comparison is needed.
2. On the PC, the known-hosts line from it:
   ```powershell
   $ip = terraform output -raw server_public_ip
   $pub = "<the ssh-ed25519 line from step 1>"
   "$ip $pub" | Out-File -Encoding ascii <known hosts file>
   ```
3. The deploy key works and the network shows the same host key (the no-passphrase key, whose private half is the
   `DEPLOY_SSH_KEY` secret; Windows' ssh ignores a key file other accounts can read, which
   `icacls <deploy key file> /inheritance:r /grant:r "$($env:USERNAME):R"` fixes):
   ```powershell
   ssh -i <deploy key file> -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<known hosts file> deploy@$ip status
   ```
4. Update the secrets: `gh secret set DEPLOY_HOST --body $ip` and
   `Get-Content <known hosts file> -Raw | gh secret set DEPLOY_KNOWN_HOSTS`.
5. Run the deploy workflow by hand with the current tag (`gh workflow run deploy.yml -f action=deploy -f tag=<tag>`); it
   must end with the server healthy.

## 8. Reopen and check
- Sign in on the real name.
- Sync now.
- Health Auto Export: a manual export covering the window's days (same URL, so nothing to change on the phone). Tell the
  other users to do the same if their posts matter to them.
- Activity: the scheduled jobs show their next runs.
- One backup and one restore test now (new server):
  ```bash
  sudo -u deploy env IMAGE_TAG=<tag> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js backup-now
  sudo -u deploy env IMAGE_TAG=<tag> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js restore-test
  ```
- The next morning: the nightly backup ran (Activity).

## 9. Publish and tidy
- Claude pushes the prepared documentation commit: the privacy notice's storage wording (approved by the owner before
  the window), README.md, CLAUDE.md and the architecture page.
- Remove the staging DNS records and the two staging redirect URIs from Health Review's Google web client.
- Delete the "Health-Review staging backups" folder in Google Drive.

## Back out before DNS (steps 1 to 5)
Nothing has been written anywhere but Lightsail. On Lightsail: `sudo -u deploy docker compose start app`. The new server
keeps its copy until the next attempt resets it.

## Days 1 to 14
- Lightsail keeps its app stopped. After two days of clean running, stop the instance in the Lightsail console (its static
  IP stays attached).
- Fix forward by default.
- **Rollback** (only if fixing forward cannot work; the owner decides):
  1. New server: stop the app and the backup service, then export the database as an encrypted SQLite backup in
     production's Drive folder (it refuses while anything is connected, so nothing written later is lost):
     ```bash
     sudo -u deploy env COMPOSE_PROFILES=postgres docker compose stop app backup
     sudo -u deploy env IMAGE_TAG=<tag> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js rollback-export
     ```
  2. Lightsail (start the instance if stopped): restore that newest backup with the same tag as the new server, then
     swap it in, keeping the old file:
     ```bash
     sudo -u deploy env IMAGE_TAG=<tag> docker compose run --rm --no-deps -T app node scripts/backup-restore.js --file latest --out /app/data/rollback.db
     sudo mv data/health.db data/health-before-rollback.db
     sudo rm -f data/health.db-wal data/health.db-shm data/restored-programs.json
     sudo mv data/rollback.db data/health.db
     sudo -u deploy ./deploy.sh deploy <tag> --no-backup
     ```
     (`--no-backup`: a Drive backup now would replace today's rollback file.)
  3. DNS back to the Lightsail address; the GitHub secrets back to Lightsail's (step 7 in reverse).
- **Day 14**, with the owner's approval: delete the Lightsail instance, its snapshots and its static IP; Claude removes the
  dated Lightsail lines and the key exception from the docs; then 1I (row-level security).
