#!/bin/bash
# Back up the local Docker PostgreSQL database to ./backups (restore with pg_restore).
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p backups
chmod 700 backups
target="backups/yyc-$(date -u +%Y-%m-%dT%H-%M-%SZ).dump"

if sudo docker exec yyc-postgres pg_dump -U yyc_user --format=custom --no-owner yyc_dev > "$target"; then
  chmod 600 "$target"
  echo "Backup created: $target ($(stat -c %s "$target") bytes)"
else
  rm -f "$target"
  echo "Backup failed; is the yyc-postgres container running? (./start-yyc.sh)" >&2
  exit 1
fi
