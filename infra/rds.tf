# RDS PostgreSQL 18, encrypted with the customer-managed key, private, TLS only. The master password is made and kept by
# RDS in Secrets Manager (under the same key), so it never appears in Terraform state. No database is created here: the
# app's database is made in Phase 1G with C collation and ctype (CREATE DATABASE ... LOCALE 'C' TEMPLATE template0),
# which db/pg/migrate.js requires, together with the app and migration roles.
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg18"
  family = "postgres18"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "-1" # never log statement text (it can carry health data)
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "18" # the latest 18.x; minor versions upgrade in the maintenance window
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = local.key_arn

  username                      = "hr_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = local.key_arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = false
  multi_az               = false
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  # 7 days of point-in-time recovery; times in UTC (03:00 to 03:30 and Mondays 04:00 in New York, outside every job).
  backup_retention_period    = 7
  backup_window              = "08:00-08:30"
  maintenance_window         = "mon:09:00-mon:09:30"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  performance_insights_enabled = false
  apply_immediately            = false
}
