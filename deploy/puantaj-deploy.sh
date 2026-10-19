#!/bin/bash
# Server-side deploy for the puantaj app. Installed as /usr/local/bin/puantaj-deploy.
#
# The GitHub Actions SSH key is locked to this script in /root/.ssh/authorized_keys
# (restrict,command="/usr/local/bin/puantaj-deploy"), so that key can do nothing else.
# The requested action arrives in $SSH_ORIGINAL_COMMAND (or as arguments when run by hand):
#
#   deploy <commit-sha>   release tarball on stdin; build in a clean folder, swap, health-check,
#                         roll back automatically if the new version is unhealthy
#   rollback              switch back to the previous release
#   status                show the deployed commit and container state
set -euo pipefail

APP=/opt/puantaj
HEALTH_URL=http://127.0.0.1:8090/api/health
PAGE_URL=http://127.0.0.1:8090/

read -r -a ARGS <<<"${SSH_ORIGINAL_COMMAND:-$*}"
ACTION="${ARGS[0]:-}"

exec 9>/run/lock/puantaj-deploy.lock
if ! flock -n 9; then
  echo "Another deploy is running" >&2
  exit 1
fi

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 -o /dev/null "$HEALTH_URL" && curl -fsS -m 5 -o /dev/null "$PAGE_URL"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

rollback() {
  if [ ! -d "$APP.prev" ]; then
    echo "No previous release to roll back to" >&2
    return 1
  fi
  rm -rf "$APP.failed"
  mv "$APP" "$APP.failed"
  mv "$APP.prev" "$APP"
  (cd "$APP" && docker compose up -d --build)
  if healthy; then
    echo "Rolled back to $(cat "$APP/REVISION" 2>/dev/null || echo 'previous release')"
  else
    echo "Rolled back, but the previous release is not healthy either" >&2
    return 1
  fi
}

case "$ACTION" in
  deploy)
    SHA="${ARGS[1]:-}"
    if [[ ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Usage: deploy <40-char commit sha>" >&2
      exit 2
    fi
    rm -rf "$APP.new"
    mkdir "$APP.new"
    tar --no-same-owner -x -C "$APP.new"
    cp -p "$APP/.env" "$APP.new/.env"
    echo "$SHA" >"$APP.new/REVISION"

    # Build while the current version keeps serving; a failed build changes nothing.
    (cd "$APP.new" && docker compose build)

    rm -rf "$APP.prev"
    mv "$APP" "$APP.prev"
    mv "$APP.new" "$APP"
    (cd "$APP" && docker compose up -d)

    if healthy; then
      echo "Deployed $SHA"
    else
      echo "New release is unhealthy, rolling back" >&2
      rollback || true
      exit 1
    fi
    ;;
  rollback)
    rollback
    ;;
  status)
    echo "Deployed: $(cat "$APP/REVISION" 2>/dev/null || echo unknown)"
    (cd "$APP" && docker compose ps --format '{{.Name}}: {{.Status}}')
    ;;
  *)
    echo "Unknown action. Allowed: deploy <sha> | rollback | status" >&2
    exit 2
    ;;
esac
