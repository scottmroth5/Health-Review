# The server: Ubuntu 24.04 (as on Lightsail), Docker Compose, Caddy, the app and the demo. Its disk is encrypted with the
# customer-managed key; it holds the MAPS files, the Google sign-in files and Caddy's state once the database is on RDS.
# Administration is through SSM Session Manager (no admin SSH key); port 22 serves only the forced-command deploy key.

# Canonical's current Ubuntu 24.04 image, from AWS's public parameter (no account id needed).
data "aws_ssm_parameter" "ubuntu" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.ubuntu.value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.app.name

  # Standard credits: a runaway process slows down rather than adding charges.
  credit_specification {
    cpu_credits = "standard"
  }

  # IMDSv2 only, one hop: the host reads its role's credentials; containers cannot reach the metadata service.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 30
    encrypted             = true
    kms_key_id            = local.key_arn
    delete_on_termination = true
  }

  disable_api_termination = true

  user_data = templatefile("${path.module}/user-data.sh", {
    deploy_ssh_public_key = var.deploy_ssh_public_key
  })

  tags = { Name = local.name }

  lifecycle {
    # A newer Ubuntu image or edited first-boot script never replaces the running server; unattended upgrades patch it.
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
  tags     = { Name = local.name }
}
