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
copy terraform.tfvars.example terraform.tfvars   # the alert email and the deploy key's public half
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

Nothing serves traffic yet. Phase 1G adds:
- the app's database (C collation) and its two roles;
- the parameters under `/health-review/` (SecureString, `alias/health-review`);
- compose, Caddy and the deploy.

DNS moves only at cutover (1H).

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
