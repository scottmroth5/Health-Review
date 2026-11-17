#!/usr/bin/env bash
# Deploys, rolls back, or reports Health Review on the server. Lives at /opt/health-review/deploy.sh. Adapted from Job
# Agent's.
#
#   ./deploy.sh deploy <image tag>   pull that image, start it, wait for /api/health on the app and the demo; on failure,
#                                    go back to the last good one. When the image would change the database (its
#                                    migrations, tried first on a throwaway copy), an encrypted Drive backup is made with
#                                    the current image before it starts, the app keeps a checked pre-migration copy in
#                                    data/backups, and a failed deploy puts that copy back before the old image starts.
#   ./deploy.sh deploy <tag> --no-backup        the same without the Drive backup (emergency only)
#   ./deploy.sh deploy <tag> --skip-db-check    deploy an image that has no migration check (an old tag)
#   ./deploy.sh rollback             start the previous good image again. On PostgreSQL, not to an image older than
#                                    migration 035 (row-level security, docs/adr/0011): it would sign in to empty screens
#                                    and have its writes refused (nothing is lost; deploy the newer tag again)
#   ./deploy.sh up                   start the current good image (after a reboot or a .env change)
#   ./deploy.sh pull                 download the current good image again without restarting anything
#   ./deploy.sh status               the running tag and each container's health
#
# GitHub Actions reaches this script through a deploy key whose authorized_keys line forces this command, so the key
# can run nothing else: command="/opt/health-review/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty
# In that case the requested words arrive in SSH_ORIGINAL_COMMAND and are checked below before anything runs.
#
# State (the deployed and previous tags, and the lock) lives in ./state, which the deploy user must own, because
# /opt/health-review itself is owned by root:  sudo install -d -o deploy -g deploy -m 700 /opt/health-review/state
#
# PostgreSQL servers (v3 Phase 1G, docs/adr/0010): ./server.conf (written at first boot by infra/user-data.sh; not secret)
# holds DB_ENGINE=postgres and ENV_SOURCE=ssm. Then .env is rebuilt from Parameter Store before each start
# (env-from-ssm.sh), the backup container (compose profile postgres, image <tag>-backup) runs with the app, and a deploy
# that would migrate goes: pre-migrate (a pg_dump restored into a scratch cluster and migrated there first; the checked
# dump is kept in data/backups), the encrypted Drive backup with the current image, scripts/migrate.js as the migration
# role, then the new image. A failed migration or start puts the dump back (under a minute at today's size) before the
# old image runs. Without server.conf (the Lightsail server) everything runs as before, on SQLite.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"
STATE_DIR=state
CURRENT_FILE="$STATE_DIR/deployed-tag"
PREVIOUS_FILE="$STATE_DIR/previous-tag"
HEALTH_WAIT_SECONDS=120

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] %s\n' "$*" >&2; exit 1; }

# Words from the forced SSH command, else from the command line. No shell expansion of what the client sent.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a ARGS <<< "$SSH_ORIGINAL_COMMAND"
else
  ARGS=("$@")
fi
ACTION="${ARGS[0]:-status}"
TAG="${ARGS[1]:-}"
OPTION="${ARGS[2]:-}"
[[ ${#ARGS[@]} -le 3 ]] || fail "Too many arguments."
[[ -z "$OPTION" || "$OPTION" == --no-backup || "$OPTION" == --skip-db-check ]] || fail "Unknown option \"$OPTION\"."

# server.conf is read by matching whole lines, never sourced.
conf() { [[ -f server.conf ]] && grep -qx "$1" server.conf; }
POSTGRES=0
if conf 'DB_ENGINE=postgres'; then POSTGRES=1; export COMPOSE_PROFILES=postgres; fi
SERVICES=(app demo)
if (( POSTGRES )); then SERVICES+=(backup); fi

valid_tag() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; }

[[ -d "$STATE_DIR" && -w "$STATE_DIR" ]] || fail "$PWD/$STATE_DIR is missing or not writable. Run: sudo install -d -o deploy -g deploy -m 700 $PWD/$STATE_DIR"

# One deploy at a time, even if two pushes land close together.
exec 9> "$STATE_DIR/deploy.lock"
flock -w 600 9 || fail "Another deploy is still running."

compose() { IMAGE_TAG="$1" docker compose "${@:2}"; }

# The settings from Parameter Store (servers with ENV_SOURCE=ssm), refreshed before every start.
refresh_env() {
  if conf 'ENV_SOURCE=ssm'; then ./env-from-ssm.sh || fail "Could not read the settings from Parameter Store; nothing changed."; fi
}

# A one-off backup container of this tag (PostgreSQL servers): scripts/backup-service.js <command>.
backup_run() { local tag="$1"; shift; IMAGE_TAG="$tag" docker compose run --rm --no-deps -T backup node scripts/backup-service.js "$@"; }

# Both the app and the public demo must answer /api/health before a deploy counts as good.
healthy() {
  local waited=0 service
  for service in app demo; do
    while (( waited < HEALTH_WAIT_SECONDS )); do
      if docker compose exec -T "$service" node -e "fetch('http://127.0.0.1:5188/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
        break
      fi
      sleep 3
      waited=$(( waited + 3 ))
    done
    (( waited < HEALTH_WAIT_SECONDS )) || { log "$service is not answering /api/health"; return 1; }
  done
  return 0
}

# A one-off container of the app's image, with the app's settings and data folder (runs as uid 1000, like the app).
app_run() { local tag="$1"; shift; IMAGE_TAG="$tag" docker compose run --rm --no-deps -T "$@"; }

# Would this image change the database? Its own check runs the migrations on a throwaway copy: exit 0 none, 10 some (a
# migration that fails on this data fails here, before the real file is touched).
db_check() {
  local tag="$1" code=0
  app_run "$tag" app node scripts/migrations-pending.js || code=$?
  return "$code"
}

# Puts back the database as it was before this deploy's migrations (the newest pre-migration copy the new app took after
# the deploy began), so the previous image never runs on a schema it does not know.
restore_pre_migration() {
  local tag="$1"
  IMAGE_TAG="$tag" docker compose stop app || true
  if (( POSTGRES )); then
    backup_run "$tag" restore-pre-migration
    return
  fi
  app_run "$tag" --entrypoint sh app -c 'set -e
    f=$(ls -1 /app/data/backups/pre-migration-*.db 2>/dev/null | sort | tail -1)
    [ -n "$f" ] && [ "$f" -nt /app/data/.deploy-started ] || { echo "[deploy] no pre-migration copy from this deploy" >&2; exit 1; }
    cp "$f" /app/data/health.db.restoring
    rm -f /app/data/health.db-wal /app/data/health.db-shm
    mv /app/data/health.db.restoring /app/data/health.db
    echo "[deploy] database put back from $f"'
}

start_tag() {
  local tag="$1"
  log "Starting image $tag"
  compose "$tag" pull "${SERVICES[@]}"
  compose "$tag" up -d --remove-orphans
  healthy
}

# PostgreSQL: check, back up and migrate before the new image starts. Sets migrating=1 once migrations may have run.
pg_prepare() {
  local check=0
  log "Pulling $TAG and checking whether it changes the database (on a scratch copy)"
  IMAGE_TAG="$TAG" docker compose pull app backup
  app_run "$TAG" --entrypoint sh app -c 'touch /app/data/.deploy-started'
  backup_run "$TAG" pre-migrate || check=$?
  if (( check == 0 )); then return 0; fi
  (( check == 10 )) || fail "The database check of $TAG failed (a migration failed on the scratch copy). Nothing changed."
  if [[ "$OPTION" == --no-backup ]]; then
    log "Database changes ahead; the Drive backup is skipped (--no-backup); the checked dump is kept"
  else
    [[ -n "$current" ]] || fail "Database changes ahead but no current image to back up with. Run: ./deploy.sh deploy $TAG --no-backup"
    log "Database changes ahead: encrypted Drive backup with $current first"
    backup_run "$current" backup-now || fail "The backup failed, so $TAG was not started and nothing changed."
  fi
  migrating=1
  log "Migrating the database with $TAG"
  # In the backup container: only it holds the migration role's login (backup.env); the image is this tag's.
  if ! IMAGE_TAG="$TAG" docker compose run --rm --no-deps -T backup node scripts/migrate.js; then
    log "The migration failed; putting the database back"
    restore_pre_migration "$TAG" || fail "Could not put the database back. Check data/backups on the server; RDS point-in-time recovery is the fallback."
    if [[ -n "$current" ]]; then start_tag "$current" || true; fi
    fail "Deploy of $TAG failed at its migration; the database is back as it was."
  fi
}

case "$ACTION" in
  deploy)
    valid_tag "$TAG" || fail "deploy needs an image tag (letters, digits, dot, dash, underscore)."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    migrating=0
    refresh_env
    if (( POSTGRES )) && [[ "$OPTION" != --skip-db-check ]]; then
      pg_prepare
    elif [[ "$OPTION" != --skip-db-check ]]; then
      log "Pulling $TAG and checking whether it changes the database"
      IMAGE_TAG="$TAG" docker compose pull app
      check=0
      db_check "$TAG" || check=$?
      if (( check == 10 )); then
        migrating=1
        if [[ "$OPTION" == --no-backup ]]; then
          log "Database changes ahead; the Drive backup is skipped (--no-backup)"
        else
          [[ -n "$current" ]] || fail "Database changes ahead but no current image to back up with. Run: ./deploy.sh deploy $TAG --no-backup"
          log "Database changes ahead: encrypted backup with $current first"
          app_run "$current" app node scripts/backup.js || fail "The backup failed, so $TAG was not started and nothing changed."
        fi
        app_run "$TAG" --entrypoint sh app -c 'touch /app/data/.deploy-started'
      elif (( check != 0 )); then
        fail "The database check of $TAG failed (a migration failed on a copy, or the image has no check: use --skip-db-check for an old tag). Nothing changed."
      fi
    fi
    if start_tag "$TAG"; then
      if [[ -n "$current" && "$current" != "$TAG" ]]; then echo "$current" > "$PREVIOUS_FILE"; fi
      echo "$TAG" > "$CURRENT_FILE"
      log "Healthy on $TAG"
      # Keep disk use in check: remove images no container uses that are over a week old.
      docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
    else
      log "Image $TAG did not pass /api/health within ${HEALTH_WAIT_SECONDS}s"
      docker compose logs --tail 40 "${SERVICES[@]}" >&2 || true
      if [[ -n "$current" ]]; then
        if (( migrating )); then restore_pre_migration "$TAG" || fail "Could not put the database back; $current not started. Check data/backups on the server."; fi
        log "Going back to $current"
        start_tag "$current" || fail "The previous image $current is not healthy either. Check: docker compose logs app"
        fail "Deploy of $TAG failed; running $current again."
      fi
      fail "Deploy of $TAG failed and there is no earlier image to go back to."
    fi
    ;;
  rollback)
    previous="$(cat "$PREVIOUS_FILE" 2>/dev/null || true)"
    [[ -n "$previous" ]] || fail "No previous image recorded."
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    refresh_env
    start_tag "$previous" || fail "Image $previous is not healthy. Check: docker compose logs app"
    echo "$previous" > "$CURRENT_FILE"
    [[ -n "$current" ]] && echo "$current" > "$PREVIOUS_FILE"
    log "Rolled back to $previous"
    ;;
  up)
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    [[ -n "$current" ]] || fail "Nothing deployed yet. Run: ./deploy.sh deploy <tag> (for example latest)"
    refresh_env
    start_tag "$current" || fail "Image $current is not healthy. Check: docker compose logs app"
    log "Running $current"
    ;;
  pull)
    current="$(cat "$CURRENT_FILE" 2>/dev/null || true)"
    [[ -n "$current" ]] || fail "Nothing deployed yet. Run: ./deploy.sh deploy <tag>"
    compose "$current" pull "${SERVICES[@]}"
    log "Pulled $current; run ./deploy.sh up to restart on it"
    ;;
  status)
    echo "deployed: $(cat "$CURRENT_FILE" 2>/dev/null || echo none)"
    echo "previous: $(cat "$PREVIOUS_FILE" 2>/dev/null || echo none)"
    docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
    ;;
  *)
    fail "Unknown action \"$ACTION\". Use deploy <tag>, rollback, up, pull, or status."
    ;;
esac
