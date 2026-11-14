# The production stack (v3 Phase 1F; docs/adr/0009-infrastructure.md): network, RDS PostgreSQL, the EC2 server, its
# role, and the alarms. The owner runs plan and apply (infra/README.md); nothing here holds a secret value, an account id
# or an address. State lives in the bootstrap stack's encrypted bucket; backend.hcl (gitignored) names it.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: terraform init -backend-config=backend.hcl (see backend.hcl.example).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      app        = "health-review"
      managed-by = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

# The bootstrap stack's customer-managed key.
data "aws_kms_alias" "main" {
  name = "alias/health-review"
}

locals {
  name      = "health-review"
  key_arn   = data.aws_kms_alias.main.target_key_arn
  partition = data.aws_partition.current.partition
  region    = data.aws_region.current.region
  account   = data.aws_caller_identity.current.account_id
}
