# 0009: RDS and EC2 under a customer-managed key, written in Terraform

- **Status:** accepted (Phase 1F, 2026-11-13: the code; the owner applies it after approving the cost)
- **Date:** 2026-11-13

## Context
Production runs on one Lightsail server. Lightsail encrypts its disks and snapshots with keys AWS manages, which is the one
accepted exception to the rule that health data is encrypted with keys the owner controls. ADR 0003 chose one shared
PostgreSQL database, and 1C to 1E made the app and its data ready to move.

The new home must:
- close the exception;
- keep the bill near today's;
- be reviewable in a public repo without exposing the account.

## Decision
- **Terraform in `infra/`,** in two stacks:
  - `bootstrap` holds the KMS key and the state bucket;
  - the main stack holds everything else.
  - **The owner runs every plan and apply;** CI checks format, validity and misconfigurations (Trivy), and never touches AWS.
  - **Values that identify the account** (bucket name, alert email, deploy key) live in gitignored `terraform.tfvars` and `backend.hcl`. check-personal refuses account ids, ARNs naming an account, emails and public IPs in `infra/`.
- **One customer-managed key** (rotation yearly, 30-day deletion window, protected from destroy). It encrypts:
  - RDS storage, snapshots and backups;
  - the server's disk;
  - the RDS master secret and the Parameter Store values;
  - the alert topic and the state bucket.
  - **Key policy:** account administrators manage it through IAM. CloudWatch and RDS events may use it only to publish alerts for this account. The server may decrypt only through Parameter Store.
- **RDS PostgreSQL 18, db.t4g.micro, single AZ, 20 GB gp3, private.**
  - TLS forced. Statement logging is off, because a statement can carry health data.
  - 7 days of point-in-time recovery, deletion protection and a final snapshot.
  - **The master password is generated and held by RDS** in Secrets Manager, so it is never in Terraform state.
  - **No database is created here.** 1G creates the app's database with C collation and ctype, which db/pg/migrate.js requires, plus separate app and migration roles.
- **One EC2 server, t3a.small (x86), Ubuntu 24.04,** with an Elastic IP.
  - x86 because the image is built for linux/amd64 only.
  - **Hardening:**
    - IMDSv2 only, with a hop limit of 1, so containers can't reach instance credentials;
    - standard CPU credits, so a runaway process can't add charges;
    - termination protection.
  - **Administration is SSM Session Manager.** Port 22 carries only the forced-command deploy key, as on Lightsail.
  - **App secrets go in Parameter Store** under `/health-review/`. Terraform grants the read permission but never holds a value.
- **The network:** one public subnet and two private subnets (RDS needs two zones), and no NAT gateway. The database accepts 5432 only from the server's security group.
- **Alarms:** eight CloudWatch alarms and an RDS event subscription, emailed through one encrypted SNS topic.
  - RDS: CPU credits, storage, connections and CPU.
  - Server: status, CPU credits, and memory and disk from the CloudWatch agent.
  - RDS events: failures, failovers and low storage.

## Alternatives considered
- **Stay on Lightsail:** its disks can't use a customer-managed key, so the exception would stay.
- **A NAT gateway with the server in a private subnet behind a load balancer:** about $32 a month for the NAT and $16 for the load balancer. That would double the bill for one server. Caddy already terminates TLS.
- **Graviton (t4g.small):** about $3 a month less, but it needs an arm64 image build. Reconsider when the build changes.
- **Multi-AZ RDS:** about double the database cost. A single zone with point-in-time recovery and the off-AWS encrypted backup fits a personal app's recovery needs.
- **IAM database authentication:** no passwords at all, but it adds the AWS SDK's token signer to the app and an IAM call on every new connection. Passwords in Parameter Store under the same key are simpler. Trivy's medium finding is accepted.
- **VPC flow logs, S3 access logs, Performance Insights:** cost or noise for little value at this size. They're Trivy's medium and low findings, accepted.
- **A DynamoDB lock table:** S3's native lock file (Terraform 1.10+) does the same at no cost.

## Consequences
- **Cost:** about $35 to $36 a month for this app (infra/README.md), against about $12 on Lightsail. The account budget needs a new ceiling, set by the owner.
- **Two accepted Trivy exceptions, inline with their reasons:**
  - port 22 open to anywhere: GitHub's runners have no fixed addresses;
  - unrestricted outbound traffic: the services the app calls have no fixed ranges.
  - 1G may move deploys to SSM through GitHub's OIDC and close port 22.
- **The policies change at cutover (1H):** keys become the owner's, and RDS's 7-day backups replace Lightsail's daily snapshots, in the owner's wording.
- **Replacing the server is a deliberate act.** The server ignores newer images and edits to its first-boot script. Unattended upgrades keep it patched.
