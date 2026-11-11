# YYC Brokers - Deployment Guide

## Overview

This guide covers deploying the YYC Brokers app to **Render** (recommended) using Docker, with PostgreSQL and Redis managed services.

---

## Prerequisites

- GitHub account
- Render account (free tier available: https://render.com)
- Git repository for your code

---

## Local Development Setup

### 1. Install Dependencies

**Required:**
- Node.js 24+ (tested with 24.22.1)
- PostgreSQL 16+
- Redis 7+

**macOS (Homebrew):**
```bash
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install postgresql-16 redis-server
sudo systemctl start postgresql redis-server
```

### 2. Setup Local Database

```bash
# Create PostgreSQL database
createdb yyc_dev

# Set environment variables
cp .env.example .env
# Edit .env with your local DATABASE_URL and REDIS_URL
```

### 3. Install Node Dependencies

```bash
npm install
```

### 4. Initialize Database Schema

```bash
# Run migrations (creates tables)
npm run migrate
```

### 5. Create Admin Account

```bash
npm run setup-admin
```

### 6. Start Development Server

```bash
npm run dev
```

Open http://localhost:3000 and log in with your admin account.

---

## Deploying to Render

### Step 1: Push Code to GitHub

```bash
git init
git add .
git commit -m "Initial YYC Brokers commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/yyc-app.git
git push -u origin main
```

### Step 2: Create Render Account

1. Go to https://render.com
2. Sign up with your GitHub account
3. Authorize Render to access your repositories

### Step 3: Create PostgreSQL Database

1. In Render dashboard, click **New +** → **PostgreSQL**
2. Configure:
   - **Name:** `yyc-postgres`
   - **Database:** `yyc`
   - **User:** (auto-generated)
   - **Region:** Choose closest to your users
   - **Plan:** Starter ($7/month) or Free (limited)
3. Click **Create Database**
4. Wait for provisioning (~2 minutes)

### Step 4: Create Redis Instance

1. Click **New +** → **Redis**
2. Configure:
   - **Name:** `yyc-redis`
   - **Region:** Same as PostgreSQL
   - **Plan:** Starter ($10/month) or Free (limited)
3. Click **Create Redis**

### Step 5: Create Web Service

1. Click **New +** → **Web Service**
2. Connect your GitHub repository
3. Configure:
   - **Name:** `yyc-brokers`
   - **Region:** Same as database/Redis
   - **Branch:** `main`
   - **Runtime:** Docker
   - **Plan:** Starter ($7/month) or Free

4. **Environment Variables:**
   Click **Advanced** → **Add Environment Variable**

   **Required:**
   ```
   NODE_ENV=production
   PUBLIC_ORIGIN=https://yyc-brokers.onrender.com
   ```

   **Auto-filled by Render:**
   - `DATABASE_URL` - Link to `yyc-postgres` database
   - `REDIS_URL` - Link to `yyc-redis` instance

5. Click **Create Web Service**

### Step 6: Wait for First Deploy

Render will:
1. Build Docker image (~3-5 minutes)
2. Run database migrations
3. Start your app

Watch the logs in the Render dashboard.

### Step 7: Create Admin Account

Once deployed, use Render Shell:

1. In Render dashboard, go to your web service
2. Click **Shell** tab
3. Run:
   ```bash
   npm run setup-admin
   ```
4. Follow prompts to create admin account

### Step 8: Test Your App

1. Open https://yyc-brokers.onrender.com
2. Log in with admin account
3. Test creating store/driver accounts
4. Test shipment workflow

---

## Configuration

### Environment Variables in Render

Set these in your Render web service dashboard:

**Production Settings:**
- `NODE_ENV=production` - Enables secure cookies, HSTS
- `PUBLIC_ORIGIN=https://your-domain.com` - CORS/CSRF validation

**Database (Auto-configured):**
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

**Optional (for Phase 2+ features):**
- `RESEND_API_KEY` - Email sending
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` - Card payments, checkout and signed payment status updates
- `GOOGLE_MAPS_API_KEY` - Route polylines, traffic estimates, ETAs and provider verification
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` - SMS delivery
- `RESEND_API_KEY`, `EMAIL_FROM` - Email delivery
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` - File uploads
- `SENTRY_DSN` - Error tracking

### Custom Domain (Optional)

1. In Render dashboard, go to your web service
2. Click **Settings** → **Custom Domain**
3. Add your domain (e.g., `app.yycbrokers.com`)
4. Update DNS with CNAME record (Render provides instructions)
5. Update `PUBLIC_ORIGIN` environment variable to match

---

## Deployment Workflow

### Automatic Deployments

Render auto-deploys on every push to `main`:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

Render will:
1. Build new Docker image
2. Run health checks
3. Deploy with zero downtime (keeps old version running until new is ready)

### Manual Deployments

In Render dashboard:
1. Go to your web service
2. Click **Manual Deploy** → **Deploy latest commit**

### Rollback

If a deployment fails:
1. In Render dashboard, click **Rollback**
2. Select previous deployment
3. Confirm rollback

---

## Database Migrations

### Running Migrations

Migrations run automatically on each Render deployment via the build command.

To run manually:
```bash
# In Render Shell
npm run migrate
```

### Creating New Migrations

For schema changes:
1. Update `src/db/schema.sql`
2. Create migration script in `src/db/migrations/`
3. Test locally first:
   ```bash
   npm run migrate
   ```
4. Commit and push - Render runs migrations on deploy

---

## Monitoring & Logs

### View Logs

In Render dashboard:
1. Go to your web service
2. Click **Logs** tab
3. Real-time log streaming

### Health Checks

Render automatically monitors `/healthz` endpoint:
- Checks PostgreSQL connection
- Checks Redis connection
- Returns 200 if healthy, 503 if not

### Metrics

Render provides basic metrics:
- CPU usage
- Memory usage
- Request rate
- Response time

For advanced monitoring, integrate Sentry or Datadog (Phase 4).

---

## Backups

### PostgreSQL Backups

**Render Automatic Backups:**
- Starter plan: Daily backups, 7-day retention
- Standard plan: Daily backups, 30-day retention

**Manual Backup:**
1. In Render dashboard → PostgreSQL
2. Click **Backups** tab
3. Click **Create Backup**

**Restore from Backup:**
1. Download backup file
2. Create new database
3. Restore with `pg_restore` or Render UI

### Redis Backups

Redis data is primarily ephemeral (sessions, rate limits).

For persistence:
- Render Redis includes RDB snapshots
- Sessions recreated on login
- Rate limits reset (not critical)

---

## Scaling

### Vertical Scaling (More Resources)

1. In Render dashboard → Web Service
2. Click **Settings**
3. Change **Plan** to higher tier:
   - Starter: 512MB RAM, shared CPU ($7/month)
   - Standard: 2GB RAM, 1 CPU ($25/month)
   - Pro: 4GB RAM, 2 CPU ($85/month)

### Horizontal Scaling (More Instances)

Render auto-scales on Standard+ plans:
- Scales 1-3 instances based on traffic
- Redis handles distributed sessions
- No code changes needed

### Database Scaling

1. In Render dashboard → PostgreSQL
2. Click **Settings** → Change Plan:
   - Starter: 1GB storage, 1 CPU
   - Standard: 10GB storage, 1 CPU
   - Pro: 50GB storage, 2 CPU

---

## Troubleshooting

### App Won't Start

1. Check logs in Render dashboard
2. Verify environment variables are set
3. Ensure DATABASE_URL and REDIS_URL are linked correctly
4. Check health endpoint: https://yyc-brokers.onrender.com/healthz

### Database Connection Errors

1. Verify PostgreSQL is running (Render dashboard)
2. Check DATABASE_URL is correct
3. Restart web service
4. Check firewall/security groups

### Redis Connection Errors

1. Verify Redis is running (Render dashboard)
2. Check REDIS_URL is correct
3. App degrades gracefully if Redis is down (logs warning, continues)

### Rate Limiting Issues

If Redis is down, rate limiting is disabled temporarily (logged warning).

### Deployment Fails

1. Check build logs for errors
2. Verify Dockerfile syntax
3. Ensure dependencies in package.json
4. Test Docker build locally:
   ```bash
   docker build -t yyc-test .
   docker run -p 3000:3000 yyc-test
   ```

---

## Security Checklist

Before going live:

- [ ] `NODE_ENV=production` set
- [ ] `PUBLIC_ORIGIN` matches actual domain
- [ ] All secrets in environment variables (not code)
- [ ] HTTPS enabled (Render provides free SSL)
- [ ] Database passwords rotated from defaults
- [ ] Admin account uses strong password (12+ characters)
- [ ] Rate limiting enabled (check Redis is running)
- [ ] CORS configured correctly
- [ ] Review security headers in browser DevTools

---

## Cost Estimate

**Starter Setup (Low Traffic):**
- Web Service (Starter): $7/month
- PostgreSQL (Starter): $7/month
- Redis (Starter): $10/month
- **Total: $24/month**

**Production Setup (Medium Traffic):**
- Web Service (Standard): $25/month
- PostgreSQL (Standard): $20/month
- Redis (Standard): $25/month
- **Total: $70/month**

Plus third-party services (Phase 2+):
- Resend (emails): $20/month
- Google Maps: $50/month
- AWS S3: ~$5/month
- Sentry: $26/month

---

## Next Steps

After successful deployment:

1. **Test thoroughly** - Create test accounts, run through workflows
2. **Set up monitoring** - Configure Sentry for error tracking
3. **Phase 2 features** - Email, documents, GPS, payments (see plan)
4. **Load testing** - Test with expected user volumes
5. **Backup strategy** - Schedule regular database backups
6. **Documentation** - Document operational procedures

---

## Support

- **Render Docs:** https://render.com/docs
- **Render Support:** support@render.com
- **PostgreSQL Docs:** https://www.postgresql.org/docs/
- **Redis Docs:** https://redis.io/docs/

---

**Congratulations! Your YYC Brokers app is now production-ready on Render.** 🎉
