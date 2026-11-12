#!/bin/bash
set -e

cd "$(dirname "$0")"

# Without buildx (Ubuntu's docker.io package), Compose's default Bake/BuildKit
# build fails with "no such job"; fall back to the classic builder.
if docker buildx version >/dev/null 2>&1; then
  sudo docker compose -f compose.yyc-local.yml up -d --build
else
  sudo env COMPOSE_BAKE=false DOCKER_BUILDKIT=0 docker compose -f compose.yyc-local.yml up -d --build
fi

echo ""
echo "YYC Trucking Brokerage"
echo "URL: http://localhost:3001"
echo ""

sudo docker compose -f compose.yyc-local.yml ps
