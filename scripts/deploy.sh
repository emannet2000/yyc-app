#!/bin/bash

# YYC Brokers Production Deployment Script
# Usage: ./scripts/deploy.sh

set -e  # Exit on error

echo "=================================="
echo "YYC Brokers Production Deployment"
echo "=================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if running as correct user
if [ "$USER" = "root" ]; then
    echo -e "${RED}Error: Do not run as root. Run as application user.${NC}"
    exit 1
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${RED}Error: .env file not found${NC}"
    echo "Copy .env.example to .env and configure it first"
    exit 1
fi

# Check NODE_ENV
if ! grep -q "NODE_ENV=production" .env; then
    echo -e "${YELLOW}Warning: NODE_ENV not set to production in .env${NC}"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo -e "${GREEN}✓${NC} Pre-flight checks passed"
echo ""

# Pull latest code
echo "📦 Pulling latest code..."
git pull origin main
echo -e "${GREEN}✓${NC} Code updated"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm ci --only=production
echo -e "${GREEN}✓${NC} Dependencies installed"
echo ""

# Build React frontend
echo "🔨 Building React frontend..."
npm run client:build
echo -e "${GREEN}✓${NC} Frontend built"
echo ""

# Run database migrations
echo "🗄️  Running database migrations..."
if npm run migrate; then
    echo -e "${GREEN}✓${NC} Migrations completed"
else
    echo -e "${RED}✗${NC} Migrations failed"
    echo "Check the error above and fix before continuing"
    exit 1
fi
echo ""

# Restart application
echo "🔄 Restarting application..."

if command -v pm2 &> /dev/null; then
    # Using PM2
    if pm2 list | grep -q "yyc-brokers"; then
        pm2 reload yyc-brokers --update-env
        echo -e "${GREEN}✓${NC} Application reloaded with PM2"
    else
        pm2 start src/server.js --name yyc-brokers
        pm2 save
        echo -e "${GREEN}✓${NC} Application started with PM2"
    fi
elif systemctl is-active --quiet yyc-brokers; then
    # Using systemd
    sudo systemctl restart yyc-brokers
    echo -e "${GREEN}✓${NC} Application restarted with systemd"
else
    echo -e "${YELLOW}⚠${NC}  Please manually restart your application"
fi
echo ""

# Health check
echo "🏥 Running health check..."
sleep 3  # Wait for app to start

HEALTH_URL="${PUBLIC_ORIGIN:-http://localhost:3000}/api/health"
if curl -sf "$HEALTH_URL" > /dev/null; then
    echo -e "${GREEN}✓${NC} Health check passed"
    curl -s "$HEALTH_URL" | jq '.' 2>/dev/null || curl -s "$HEALTH_URL"
else
    echo -e "${RED}✗${NC} Health check failed"
    echo "Check application logs: pm2 logs yyc-brokers"
    exit 1
fi
echo ""

# Summary
echo "=================================="
echo -e "${GREEN}Deployment completed successfully!${NC}"
echo "=================================="
echo ""
echo "Next steps:"
echo "1. Monitor logs: pm2 logs yyc-brokers"
echo "2. Check Sentry for errors: https://sentry.io"
echo "3. Test critical user flows"
echo ""
