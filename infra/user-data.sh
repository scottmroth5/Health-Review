#!/bin/bash
# First boot of the Health Review server (Terraform templatefile; runs once as root through cloud-init). Phase 1G adds
# compose.yml, the Caddyfile, deploy.sh and the .env from Parameter Store. Nothing here is secret.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y docker.io docker-compose-v2 fail2ban unattended-upgrades

# Security updates install themselves; a needed reboot happens at 04:30 (the compose services restart on their own).
cat > /etc/apt/apt.conf.d/52health-review <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF

# SSH: keys only, and only the deploy user has one.
cat > /etc/ssh/sshd_config.d/60-health-review.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
systemctl reload ssh || true
systemctl enable --now fail2ban docker

# The deploy user: in the docker group, and its one key can only run deploy.sh (which reads SSH_ORIGINAL_COMMAND).
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo 'restrict,command="/opt/health-review/deploy.sh" ${deploy_ssh_public_key}' > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys

# The app folder: root-owned, with the data folder for the container's uid 1000 only.
install -d -m 755 -o root -g root /opt/health-review
install -d -m 700 -o 1000 -g 1000 /opt/health-review/data

# The CloudWatch agent: memory and root disk use, for the alarms (namespace CWAgent, by instance).
curl -fsSL -o /tmp/cwagent.deb https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb
dpkg -i /tmp/cwagent.deb
rm -f /tmp/cwagent.deb
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'EOF'
{
  "agent": { "metrics_collection_interval": 300 },
  "metrics": {
    "append_dimensions": { "InstanceId": "$${aws:InstanceId}" },
    "metrics_collected": {
      "mem": { "measurement": ["mem_used_percent"] },
      "disk": { "measurement": ["used_percent"], "resources": ["/"], "drop_device": true, "ignore_file_system_types": ["sysfs", "tmpfs", "overlay"] }
    }
  }
}
EOF
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json
