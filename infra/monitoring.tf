# Alarms and RDS events, emailed through one encrypted SNS topic (the owner confirms the subscription email once).
# Eight alarms, inside CloudWatch's ten free ones. Messages carry metric names and the instance only, never health data.
resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = local.key_arn
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  alarms = {
    db-cpu-credits-low = {
      namespace = "AWS/RDS", metric = "CPUCreditBalance", stat = "Minimum", op = "LessThanThreshold", threshold = 20
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, missing = "notBreaching"
    }
    db-storage-low = {
      namespace = "AWS/RDS", metric = "FreeStorageSpace", stat = "Minimum", op = "LessThanThreshold", threshold = 4294967296 # 4 GiB
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, missing = "notBreaching"
    }
    db-connections-high = {
      namespace = "AWS/RDS", metric = "DatabaseConnections", stat = "Maximum", op = "GreaterThanThreshold", threshold = 50
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, missing = "notBreaching"
    }
    db-cpu-high = {
      namespace = "AWS/RDS", metric = "CPUUtilization", stat = "Average", op = "GreaterThanThreshold", threshold = 80
      dims      = { DBInstanceIdentifier = aws_db_instance.main.identifier }, missing = "notBreaching"
    }
    server-status-check-failed = {
      namespace = "AWS/EC2", metric = "StatusCheckFailed", stat = "Maximum", op = "GreaterThanOrEqualToThreshold", threshold = 1
      dims      = { InstanceId = aws_instance.app.id }, missing = "breaching"
    }
    server-cpu-credits-low = {
      namespace = "AWS/EC2", metric = "CPUCreditBalance", stat = "Minimum", op = "LessThanThreshold", threshold = 20
      dims      = { InstanceId = aws_instance.app.id }, missing = "notBreaching"
    }
    server-memory-high = {
      namespace = "CWAgent", metric = "mem_used_percent", stat = "Average", op = "GreaterThanThreshold", threshold = 90
      dims      = { InstanceId = aws_instance.app.id }, missing = "notBreaching"
    }
    server-disk-high = {
      namespace = "CWAgent", metric = "disk_used_percent", stat = "Maximum", op = "GreaterThanThreshold", threshold = 80
      dims      = { InstanceId = aws_instance.app.id, path = "/", fstype = "ext4" }, missing = "notBreaching"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  dimensions          = each.value.dims
  statistic           = each.value.stat
  comparison_operator = each.value.op
  threshold           = each.value.threshold
  period              = 300
  evaluation_periods  = 3
  treat_missing_data  = each.value.missing
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# RDS events: failures, failovers and low storage. Backup start and finish events are left out on purpose (they fire
# every night); a backup that fails is a failure event.
resource "aws_db_event_subscription" "main" {
  name             = "${local.name}-db-events"
  sns_topic        = aws_sns_topic.alerts.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["failure", "failover", "low storage"]
}
