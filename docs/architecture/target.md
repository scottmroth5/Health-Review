# The AWS network and keys (v3 Phase 1, written 2026-11-13; reached 2026-11-17)

Production has run like this since the cutover (Phase 1H, 2026-11-17), from the Terraform in `infra/`
([ADR 0009](../adr/0009-infrastructure.md)). [current.md](current.md) shows the containers and how data moves inside
them. The containers didn't change in the move: the app, the demo and Caddy moved to the new server as they were, a
backup container joined them, and the database moved out of the app's data folder. No addresses or account details
appear here.

```mermaid
flowchart LR
  subgraph Users
    B["Browser or installed web app"]
    HAE["Health Auto Export (iPhone)"]
    GH["GitHub Actions deploy"]
  end

  subgraph VPC["VPC (one region)"]
    subgraph Public["Public subnet"]
      EC2["EC2 server (Ubuntu, Docker Compose)<br/>Caddy, app, demo<br/>disk encrypted with the owner's key<br/>IMDSv2, admin by SSM only"]
    end
    subgraph Private["Private subnets (two zones)"]
      RDS[("RDS PostgreSQL 18<br/>TLS only, encrypted with the owner's key<br/>7 days point-in-time recovery")]
    end
  end

  KMS["KMS customer-managed key"]
  SSM["Parameter Store<br/>app secrets under /health-review/"]
  SM["Secrets Manager<br/>RDS master password"]
  CW["CloudWatch alarms<br/>and RDS events"]
  SNS["SNS topic, emailed to the owner"]
  G["Google Drive<br/>encrypted nightly backup"]

  B -- "HTTPS 443" --> EC2
  HAE -- "HTTPS 443, ingest token" --> EC2
  GH -- "SSH 22, forced deploy command" --> EC2
  EC2 -- "5432, TLS; only this server's group" --> RDS
  EC2 -- "instance role" --> SSM
  EC2 -- "backup, encrypted before upload" --> G
  KMS -.encrypts.-> RDS
  KMS -.encrypts.-> EC2
  KMS -.encrypts.-> SSM
  KMS -.encrypts.-> SM
  KMS -.encrypts.-> SNS
  CW --> SNS
```

## Trust boundaries that change
- **The database leaves the server.** It's reachable only from the server's security group, over TLS, and never from the internet.
- **Every key that protects health data is the owner's:** the database, its backups and snapshots, the server's disk and the secrets. This ended the Lightsail exception (ADR 0003) once the Lightsail server and its snapshots were deleted on 2026-11-22.
- **Secrets move from the server's `.env` file to Parameter Store.** The server reads them with its instance role, and no AWS key exists on any machine.
- **Administration is through SSM Session Manager.** The only SSH key on the server is the deploy key, which can only run the deploy script.
