#!/usr/bin/env bash
# Rebuilds the server's settings files from Parameter Store (v3 Phase 1G, docs/adr/0010). deploy.sh runs it before every
# start on servers whose server.conf says ENV_SOURCE=ssm; it runs on the host with the instance role (containers cannot
# reach the instance metadata service: IMDSv2 with a hop limit of 1). Values are never printed; only counts are.
#
#   /health-review/env/NAME      -> .env         the app and the backup container (DATABASE_URL is the app role's)
#   /health-review/backup/NAME   -> backup.env   the backup container only: MIGRATE_DATABASE_URL, BACKUP_DATABASE_URL,
#                                                so the app never holds the logins that change the schema or read it all
#
# Each SecureString parameter becomes NAME='value'. Refuses a name that is not NAME-shaped and a value holding a single
# quote or a line break, since compose reads the files. Everything is read into state/ (the deploy user's, mode 700)
# before any file changes, so a failed read leaves both files as they were; then each is copied over its file (the deploy
# user's, mode 600, made at first boot in the root-owned folder).
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

region="$(grep -x 'AWS_REGION=[a-z0-9-]*' server.conf | cut -d= -f2 || true)"
[[ -n "$region" ]] || { echo '[env] server.conf has no AWS_REGION line' >&2; exit 1; }

umask 077
app_tmp="$(mktemp state/env.XXXXXX)"
backup_tmp="$(mktemp state/env.XXXXXX)"
trap 'rm -f "$app_tmp" "$backup_tmp"' EXIT

read_prefix() {
  local prefix="$1"
  aws ssm get-parameters-by-path --region "$region" --path "$prefix" --with-decryption --recursive --output json \
    --query 'Parameters[].{n:Name,v:Value}' \
  | PREFIX="$prefix" python3 -c '
import json, os, re, sys
prefix = os.environ["PREFIX"]
params = json.load(sys.stdin) or []
out = []
for p in sorted(params, key=lambda p: p["n"]):
    name = p["n"][len(prefix):] if p["n"].startswith(prefix) else None
    if not name or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        sys.exit(f"[env] a parameter name under {prefix} is not NAME-shaped")
    v = p["v"]
    if "\x27" in v or "\n" in v or "\r" in v:
        sys.exit(f"[env] {name} holds a single quote or a line break, which an env file cannot carry")
    out.append(f"{name}=\x27{v}\x27")
if not out:
    sys.exit(f"[env] no parameters found under {prefix}")
sys.stdout.write("\n".join(out) + "\n")
print(f"[env] {len(out)} settings read from {prefix}", file=sys.stderr)
'
}

read_prefix /health-review/env/ > "$app_tmp"
read_prefix /health-review/backup/ > "$backup_tmp"

for f in .env backup.env; do
  [[ -f "$f" && -w "$f" ]] || { echo "[env] $f is missing or not writable (first boot creates it for the deploy user)" >&2; exit 1; }
done
cat "$app_tmp" > .env
cat "$backup_tmp" > backup.env
chmod 600 .env backup.env
