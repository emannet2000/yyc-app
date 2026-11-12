#!/bin/bash
# Run the full test suite, including the PostgreSQL + Redis integration test, against the
# local Docker stack (start it first with ./start-yyc.sh). The integration test creates its own
# accounts and shipments in yyc_dev and deletes them afterwards; it uses Redis database 5 so
# your local sessions are untouched.
set -euo pipefail
cd "$(dirname "$0")"

network="$(sudo docker inspect yyc-postgres --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"

sudo docker run --rm \
  --network "$network" \
  -v "$PWD":/app -w /app \
  -e YYC_INTEGRATION_DATABASE_URL=postgresql://yyc_user:yyc_local_dev_password@postgres:5432/yyc_dev \
  -e YYC_INTEGRATION_REDIS_URL=redis://redis:6379/5 \
  -e NODE_ENV=test \
  node:24-bookworm-slim npm test
