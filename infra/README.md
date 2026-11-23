# Infrastructure (v3 Phase 1F)

Terraform for production's next home: RDS PostgreSQL and one EC2 server in a new VPC, everything that holds health data
or secrets encrypted with one customer-managed KMS key. Why each choice: `docs/adr/0009-infrastructure.md`.

The owner runs every `plan` and `apply`, with their own AWS credentials. Claude Code writes and checks the code (CI:
`terraform fmt`, `validate` and a Trivy scan) and never holds AWS credentials.

**Nothing here may hold an account id, ARN, address, email or secret.** The values live in two gitignored files on the
owner's computer, `terraform.tfvars` and `backend.hcl`. check-personal refuses those files, Terraform state and plans,
and any account id, ARN with an account, email or public IP address in `infra/`.

## Two stacks
- **`bootstrap/`** (once): the KMS key (`alias/health-review`, yearly rotation, 30-day deletion window) and the encrypted,
  versioned, TLS-only state bucket. Both are protected from `terraform destroy`.
- **`.` (main):** the VPC and subnets, security groups, RDS, the EC2 server with its Elastic IP and role, and the alarms.
  State in the bootstrap bucket, locked with S3's own lock file.

## What it costs (us-east-2, on demand, estimated 2026-11-13)
| Item | Monthly |
|---|---|
| EC2 t3a.small ($0.0188/h, standard credits) | ~$13.70 |
| EC2 disk, gp3 30 GB | ~$2.40 |
| Elastic IP (public IPv4, $0.005/h) | ~$3.65 |
| RDS db.t4g.micro single AZ ($0.016/h) | ~$11.70 |
| RDS gp3 20 GB (grows to 50 GB on its own if needed) | ~$2.30 |
| KMS key and requests | ~$1.00 |
| Secrets Manager (the RDS master password) | $0.40 |
| Parameter Store, SNS email, 8 alarms, state bucket | under $0.50 |
| **Total** | **~$35 to $36** |

RDS backups within the database's size are free. Check the AWS Pricing Calculator before applying; prices change.

## First time
You need Terraform 1.10 or later (`winget install Hashicorp.Terraform`), the AWS CLI with the Session Manager plugin
(`winget install Amazon.SessionManagerPlugin`), and an AWS profile allowed to administer the account. In PowerShell:
`$env:AWS_PROFILE = "<your admin profile>"`, or sign in with `aws login` (answer n to its AI skills and MCP questions).
Without winget, download Terraform's zip from releases.hashicorp.com and check it against the SHA256SUMS file there.
An account created as a project in AWS Settings blocks creating KMS keys until advanced features are activated (AWS
Settings, Projects, Explore advanced features; it can't be undone and ends the spend limit, so set an AWS budget).
In PowerShell, quote any argument that holds `=` and a dot, as the commands below do.

### 1. Bootstrap
```powershell
cd infra\bootstrap
copy terraform.tfvars.example terraform.tfvars   # pick a unique bucket name
terraform init
terraform apply                                  # 9 to add: the key, its alias, the bucket and its 6 settings
```
Then move the bootstrap's own state into the bucket it made, so no state stays on this computer:
```powershell
copy ..\backend.hcl.example ..\backend.hcl       # fill in the bucket name from the output
Set-Content backend_override.tf "terraform {`n  backend `"s3`" {}`n}"
terraform init -migrate-state "-backend-config=..\backend.hcl" "-backend-config=key=health-review/bootstrap.tfstate"
Remove-Item terraform.tfstate*                   # after "Successfully configured the backend"
```
`backend_override.tf` and `backend.hcl` are gitignored; keep them.

### 2. Plan the main stack
```powershell
cd ..
copy terraform.tfvars.example terraform.tfvars   # the alert email and the deploy key's public half (the
                                                 # no-passphrase key whose private half is DEPLOY_SSH_KEY)
terraform init "-backend-config=backend.hcl"      # quoted: PowerShell splits the argument otherwise
terraform plan "-out=main.tfplan"
```
Expect **37 to add, 0 to change, 0 to destroy**. Paste only that line back to Claude Code, plus anything that looks
wrong. The full plan names the account, so it stays on this computer.

### 3. Apply
```powershell
terraform apply main.tfplan                      # about 10 to 15 minutes; RDS is the slow part
terraform output                                 # your terminal only
```
Then:
1. **Confirm the SNS email.** AWS sends a confirmation to the alert address, and alarms only arrive once it's confirmed.
2. **Check the server** without SSH: `aws ssm start-session --target <server_instance_id>`, then `cloud-init status`
   (expect `done`), `docker --version` and `exit`.

Nothing serves traffic yet.

### 4. The database and its roles (Phase 1G)
From `infra\`, signed in with `aws login`:
```powershell
powershell -ExecutionPolicy Bypass -File db-setup.ps1
```
It reads RDS's master password from Secrets Manager and makes three new passwords, all in memory only. Through an SSM
port forward it then creates the `health_review` database (C collation) and the three roles:
- `hr_migrate`: owns the schema;
- `hr_app`: rows only;
- `hr_backup`: read only.

Their URLs are stored as SecureString parameters:
- `/health-review/env/DATABASE_URL`;
- `/health-review/backup/MIGRATE_DATABASE_URL` and `BACKUP_DATABASE_URL`.

It prints progress lines only. See [ADR 0010](../docs/adr/0010-postgres-operations.md).

### 5. The settings
Each name in [deploy/cloud.env.example](../deploy/cloud.env.example) is one SecureString parameter under
`/health-review/env/`, encrypted with the owner's key. `deploy/env-from-ssm.sh` turns them into the server's `.env`
before every start. From `infra\`, signed in with `aws login`, once per name:
```powershell
aws ssm put-parameter --region us-east-2 --name /health-review/env/<NAME> --type SecureString --key-id alias/health-review --overwrite --value "<value>"
```
(or the Parameter Store console). A value may not hold a single quote or a line break.
- **Carried over, never new:** `USER_KEY_SECRET` seals users' Claude keys, `HEALTH_BACKUP_PASSPHRASE` opens the Drive
  backups, and `SESSION_SECRET` keeps everyone signed in. New values lose those keys, backups or sign-ins.
- **The Drive sign-in:** `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from `data\google\client_secret.json`, and
  `GOOGLE_REFRESH_TOKEN` from `data\google\token.json` (`npm run google:login` makes it).
- **Left out:** `DATABASE_URL` and `DB_ENGINE` (step 4's), and `HEALTH_DB_PATH` and `DATA_DIR`.
- **A test server:** its own `SITE_ADDRESS`, `DEMO_SITE_ADDRESS`, `PUBLIC_URL` and `BACKUP_DRIVE_FOLDER`, and no
  `SCHEDULE_` or `SMTP_` names, so it runs no jobs and sends no email.

Lightsail's settings were copied here once by `env-to-ssm.ps1` (1G and 1H, removed after Lightsail was deleted on
2026-11-22).

### 6. DNS and Google
- **DNS:** two A records (the staging app name and the staging demo name) pointing at `terraform output server_public_ip`.
- **Google:** in Google Cloud, add the web client's redirect URIs for the staging name:
  - `https://<staging app name>/auth/google/callback`;
  - `https://<staging app name>/auth/google/sheets/callback`.

### 7. Install the deploy files and start
Open a session on the server: `aws ssm start-session --target <server_instance_id>`. Then copy the four files from this
repository at the commit being deployed:
```bash
cd /opt/health-review
for f in compose.yml Caddyfile deploy.sh env-from-ssm.sh; do
  sudo curl -fsSL -o "$f" "https://raw.githubusercontent.com/scottmroth5/Health-Review/<commit>/deploy/$f"
done
sudo chmod 755 deploy.sh env-from-ssm.sh
# The first deploy creates the schema (the baseline migration, as hr_migrate) on the empty database. There is no current
# image to make a Drive backup with, and nothing in the database to back up, hence --no-backup this once.
sudo -u deploy ./deploy.sh deploy sha-<7> --no-backup
sudo -u deploy ./deploy.sh status
```

### 8. Load a copy of the data and test
The newest backup in production's Drive folder goes into the empty database. It is audited, copied and verified by
fingerprint, printing PASS or FAIL with counts only. The copy refuses a database that holds rows beyond the owner's, and
the app writes some as soon as it runs (on 2026-11-16 a bot's first visit counted one arrival in usage_totals), so every
load starts with the app stopped and `reset-database`: it refuses while anything else is connected, keeps a pg_dump
checked in a scratch cluster in data/backups (pre-migration-<stamp>.dump, pruned with the others), then drops the
schema and migrates it afresh. Run each line on its own (an SSM session's shell garbles multi-line pastes; type `bash`
first):
```bash
sudo -u deploy env COMPOSE_PROFILES=postgres docker compose stop app backup
sudo -u deploy env IMAGE_TAG=sha-<7> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js reset-database --confirm health_review
sudo -u deploy env IMAGE_TAG=sha-<7> COMPOSE_PROFILES=postgres docker compose run --rm --no-deps -T backup node scripts/backup-service.js load-from-backup
sudo -u deploy ./deploy.sh up
```
Then test together:
- sign-in and every tab;
- a manual sync;
- an ingest post with a staging token;
- a review dry run and the account export;
- a second user's isolation;
- `backup-now` and `restore-test` (the same `docker compose run ... backup` line, with those commands).

Cutover (1H): [docs/runbooks/postgres-cutover.md](../docs/runbooks/postgres-cutover.md). It repeats step 8 with a final
backup and production's settings (the reset empties staging's copy from the same database), then moves DNS. It ran on
2026-11-17 and is now a record.

## Later changes
Run `terraform plan "-out=main.tfplan"` and read it, then `terraform apply main.tfplan`.
- **The server is never replaced** for a newer Ubuntu image or an edited `user-data.sh`: both are ignored after creation, and unattended upgrades patch the running server.
- **RDS changes wait for its maintenance window** (`apply_immediately` is off).

## Taking it down
Deletion is deliberately hard:
- RDS has deletion protection and takes a final snapshot.
- The server has termination protection.
- The key and the bucket refuse `destroy` outright.

To tear down after the move is abandoned:
1. turn off the two protections in the code;
2. apply;
3. `terraform destroy` the main stack;
4. delete the final snapshot if it's no longer wanted;
5. schedule the key's deletion (30 days) in the console only when nothing encrypted with it is needed.
