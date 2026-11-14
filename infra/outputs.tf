# Printed in the owner's terminal only (they name the account's resources); never paste them into the repo.
output "server_public_ip" {
  description = "The Elastic IP, for DNS at cutover (Phase 1H)."
  value       = aws_eip.app.public_ip
}

output "server_instance_id" {
  description = "For aws ssm start-session --target <id>."
  value       = aws_instance.app.id
}

output "db_endpoint" {
  description = "RDS host:port, reachable from the server only."
  value       = aws_db_instance.main.endpoint
}

output "db_master_secret_arn" {
  description = "The RDS-managed master password's secret (Secrets Manager)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "alert_topic_arn" {
  description = "The SNS topic the alarms email through."
  value       = aws_sns_topic.alerts.arn
}
