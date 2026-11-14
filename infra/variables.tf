variable "region" {
  description = "AWS region (US only)."
  type        = string
  default     = "us-east-2"
}

variable "alert_email" {
  description = "Where CloudWatch alarms and RDS events are emailed (the owner confirms the subscription email)."
  type        = string
  sensitive   = true
}

variable "deploy_ssh_public_key" {
  description = "The GitHub deploy key's public half (ssh-ed25519 ...). It can only run /opt/health-review/deploy.sh."
  type        = string

  # It is written into a quoted line of the first-boot script: one plain public key, nothing else.
  validation {
    condition     = can(regex("^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$", var.deploy_ssh_public_key))
    error_message = "deploy_ssh_public_key must be one OpenSSH public key line (type, key and an optional plain comment)."
  }
}

variable "ssh_allowed_cidrs" {
  description = "Who may reach port 22 (the forced-command deploy key only). GitHub's runners have no fixed addresses."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "instance_type" {
  description = "The server: x86, because the image is built for linux/amd64."
  type        = string
  default     = "t3a.small"
}

variable "db_instance_class" {
  description = "The RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "vpc_cidr" {
  description = "The VPC's private address range."
  type        = string
  default     = "10.40.0.0/16"
}
