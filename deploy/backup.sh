#!/usr/bin/env bash
# Dumps the register and keeps the last N days of dumps.
#
# There is no managed service taking snapshots now, so this is the only thing
# standing between a lost instance and a lost register. Install the timer:
#   sudo cp deploy/team-register-backup.{service,timer} /etc/systemd/system/
#   sudo systemctl enable --now team-register-backup.timer
#
# Restore the most recent dump:
#   gunzip -c BACKUP_DIR/sih2026-YYYYmmdd-HHMMSS.sql.gz \
#     | docker compose -f deploy/docker-compose.prod.yml exec -T db psql -U sih -d sih2026

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$HERE/docker-compose.prod.yml"
BACKUP_DIR="${BACKUP_DIR:-$HERE/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

# shellcheck source=/dev/null
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

DB_USER="${POSTGRES_USER:-sih}"
DB_NAME="${POSTGRES_DB:-sih2026}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/$DB_NAME-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

# Write to a partial file first, so an interrupted run never leaves something
# that looks like a usable backup.
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip -9 > "$OUT.partial"

mv "$OUT.partial" "$OUT"

# Refuse to report success on a dump too small to be real.
SIZE=$(stat -c %s "$OUT")
if [ "$SIZE" -lt 1024 ]; then
  echo "backup is only ${SIZE} bytes, treating as failed: $OUT" >&2
  exit 1
fi

find "$BACKUP_DIR" -name "$DB_NAME-*.sql.gz" -mtime "+$KEEP_DAYS" -delete

echo "$OUT ($SIZE bytes), keeping $KEEP_DAYS days"
