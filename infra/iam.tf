# The server's role: Session Manager, the CloudWatch agent, and reading its own parameters under /health-review/
# (decrypted with the customer-managed key through Parameter Store only). No long-lived AWS keys anywhere.
resource "aws_iam_role" "app" {
  name = "${local.name}-server"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy" "parameters" {
  name = "read-own-parameters"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadOwnParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
        Resource = "arn:${local.partition}:ssm:${local.region}:${local.account}:parameter/${local.name}/*"
      },
      {
        Sid      = "DecryptThroughParameterStoreOnly"
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = local.key_arn
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-server"
  role = aws_iam_role.app.name
}
