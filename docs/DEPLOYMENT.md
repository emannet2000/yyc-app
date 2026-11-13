# Production Deployment Guide

## Pre-Deployment Checklist

Before deploying to production, ensure you've completed:

### ✅ Infrastructure
- [ ] PostgreSQL database provisioned and accessible
- [ ] Redis instance running and accessible
- [ ] Domain name registered and DNS configured
- [ ] SSL certificate obtained (Let's Encrypt or commercial)
- [ ] Server/hosting environment set up (AWS, DigitalOcean, etc.)

### ✅ Services
- [ ] Resend account created and domain verified
- [ ] Stripe account set up (live mode)
- [ ] AWS S3 bucket created for documents (optional)
- [ ] Sentry project created for error tracking
- [ ] Twilio account set up for SMS (optional)

### ✅ Environment
- [ ] All environment variables configured (see `.env.example`)
- [ ] `NODE_ENV=production` set
- [ ] Secrets rotated from development values
- [ ] Broker registration codes set to secure values

### ✅ Code
- [ ] React frontend built (`npm run client:build`)
- [ ] Tests passing (`npm test`)
- [ ] Database migrations ready (`npm run migrate`)
- [ ] No console.log statements in production code
- [ ] Git repository clean (no uncommitted changes)

---

## Deployment Options

### Option 1: Traditional VPS (Recommended for Beginners)

Deploy to a single server (DigitalOcean, Linode, AWS EC2):

#### Step 1: Provision Server

**Requirements:**
- Ubuntu 22.04 LTS
- 2GB RAM minimum (4GB recommended)
- 25GB SSD storage
- Public IP address

**Providers:**
- DigitalOcean: $12/month (Basic Droplet)
- Linode: $12/month (Shared CPU)
- AWS EC2: t3.small (~$15/month)

#### Step 2: Initial Server Setup

```bash
# SSH into your server
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Node.js 24.x
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# Install PostgreSQL
apt install -y postgresql postgresql-contrib

# Install Redis
apt install -y redis-server

# Install Nginx
apt install -y nginx

# Install PM2 (process manager)
npm install -g pm2

# Install Certbot (SSL)
apt install -y certbot python3-certbot-nginx
```

#### Step 3: Configure PostgreSQL

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database and user
CREATE DATABASE yyc_brokers;
CREATE USER yyc_user WITH ENCRYPTED PASSWORD 'your-secure-password';
GRANT ALL PRIVILEGES ON DATABASE yyc_brokers TO yyc_user;
\q

# Enable remote connections (if needed)
# Edit /etc/postgresql/14/main/postgresql.conf
listen_addresses = 'localhost'

# Edit /etc/postgresql/14/main/pg_hba.conf
# Add: host    yyc_brokers    yyc_user    127.0.0.1/32    md5
```

#### Step 4: Deploy Application

```bash
# Create app user
adduser --disabled-password yyc
su - yyc

# Clone repository
git clone https://github.com/yourorg/yyc-app.git
cd yyc-app

# Install dependencies
npm install

# Build React frontend
npm run client:build

# Copy environment file
cp .env.example .env
nano .env  # Edit with your production values

# Run database migrations
npm run migrate

# Create admin account
npm run setup-admin

# Start with PM2
pm2 start src/server.js --name yyc-brokers
pm2 save
pm2 startup  # Follow the instructions
```

#### Step 5: Configure Nginx

```bash
# Create Nginx config
sudo nano /etc/nginx/sites-available/yyc-brokers

# Add configuration:
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # Redirect to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # SSL certificates (will be added by certbot)
    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Proxy to Node.js app
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # WebSocket support
        proxy_read_timeout 86400;
    }

    # Static files (optional - Node.js serves them fine)
    # location /dist/ {
    #     alias /home/yyc/yyc-app/public/dist/;
    #     expires 1y;
    #     add_header Cache-Control "public, immutable";
    # }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/yyc-brokers /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com

# Restart Nginx
sudo systemctl restart nginx
```

#### Step 6: Configure Firewall

```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

#### Step 7: Set Up Monitoring

```bash
# PM2 monitoring
pm2 install pm2-logrotate

# View logs
pm2 logs yyc-brokers

# Monitor resources
pm2 monit
```

---

### Option 2: Docker Deployment

Use Docker for consistent deployments:

#### Dockerfile

Create `Dockerfile`:

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY . .

# Build React frontend
RUN npm run client:build

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start app
CMD ["node", "src/server.js"]
```

#### docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://yyc_user:password@db:5432/yyc_brokers
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: yyc_brokers
      POSTGRES_USER: yyc_user
      POSTGRES_PASSWORD: your-password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

#### Deploy

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f app

# Run migrations
docker-compose exec app npm run migrate

# Create admin
docker-compose exec app npm run setup-admin
```

---

### Option 3: Platform as a Service (Easiest)

Deploy to managed platforms:

#### Heroku

```bash
# Install Heroku CLI
# https://devcenter.heroku.com/articles/heroku-cli

# Login
heroku login

# Create app
heroku create yyc-brokers

# Add PostgreSQL
heroku addons:create heroku-postgresql:mini

# Add Redis
heroku addons:create heroku-redis:mini

# Set environment variables
heroku config:set NODE_ENV=production
heroku config:set RESEND_API_KEY=re_your_key
heroku config:set STRIPE_SECRET_KEY=sk_your_key
# ... etc

# Deploy
git push heroku main

# Run migrations
heroku run npm run migrate

# Open app
heroku open
```

#### Railway.app

1. Sign up at https://railway.app
2. Create new project
3. Connect GitHub repository
4. Add PostgreSQL and Redis services
5. Configure environment variables
6. Deploy automatically on git push

#### Render.com

Similar to Railway, with auto-deploy from GitHub.

---

## Environment Variables

### Required Production Values

```env
# Core
NODE_ENV=production
PORT=3000
PUBLIC_ORIGIN=https://yourdomain.com

# Database
DATABASE_URL=postgresql://user:pass@host:5432/yyc_brokers

# Redis
REDIS_URL=redis://host:6379

# Email (CRITICAL)
RESEND_API_KEY=re_live_xxxxxxxxxxxxxx
FROM_EMAIL=YYC Brokers <noreply@yourdomain.com>

# Security
BROKER_REGISTRATION_CODES=prod-code-1,prod-code-2

# Payments
STRIPE_SECRET_KEY=sk_live_xxxxxxxxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxx

# Monitoring
SENTRY_DSN=https://xxx@sentry.io/xxx
```

---

## Post-Deployment

### Verify Deployment

```bash
# Health check
curl https://yourdomain.com/api/health

# Expected response:
# {"status":"ok","database":"connected","redis":"connected"}

# Test registration
curl -X POST https://yourdomain.com/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "role": "store",
    "name": "Test Store",
    "email": "test@yourdomain.com",
    "password": "testpassword123456",
    "phone": "123-456-7890",
    "address": "123 Main St",
    "contact": "John Doe"
  }'

# Check your email for verification code
```

### Configure Stripe Webhooks

1. Go to https://dashboard.stripe.com/webhooks
2. Add endpoint: `https://yourdomain.com/api/stripe/webhook`
3. Select events:
   - `payment_intent.succeeded`
   - `payment_intent.failed`
   - `charge.refunded`
4. Copy webhook signing secret
5. Add to `.env`: `STRIPE_WEBHOOK_SECRET=whsec_...`
6. Restart app

### Set Up Monitoring

**Uptime Monitoring:**
- UptimeRobot (free): https://uptimerobot.com
- Pingdom
- StatusCake

**Error Tracking:**
- Verify Sentry is receiving errors
- Set up alerts in Sentry dashboard

**Performance:**
- Monitor PM2 dashboard
- Check Sentry performance metrics
- Review server resources (CPU, RAM, disk)

### Database Backups

**Manual Backup:**
```bash
pg_dump -U yyc_user yyc_brokers > backup_$(date +%Y%m%d).sql
```

**Automated Backup (cron):**
```bash
# Edit crontab
crontab -e

# Add daily backup at 3 AM
0 3 * * * pg_dump -U yyc_user yyc_brokers > /backups/yyc_$(date +\%Y\%m\%d).sql
```

**Backup to S3:**
```bash
# Install AWS CLI
pip3 install awscli

# Configure
aws configure

# Backup script
pg_dump -U yyc_user yyc_brokers | gzip | aws s3 cp - s3://your-backup-bucket/yyc_$(date +%Y%m%d).sql.gz
```

---

## Scaling

### Vertical Scaling (Easier)

Upgrade server resources:
- 2GB → 4GB RAM
- Add more CPU cores
- Upgrade disk to SSD

### Horizontal Scaling (Advanced)

Run multiple instances behind a load balancer:

1. **Session Storage:** Already using Redis (stateless)
2. **Load Balancer:** Nginx, HAProxy, or AWS ELB
3. **Multiple App Servers:** PM2 cluster mode or separate servers
4. **Database:** PostgreSQL read replicas

Example PM2 cluster:
```bash
pm2 start src/server.js -i max --name yyc-cluster
```

---

## Troubleshooting

### App Won't Start

```bash
# Check logs
pm2 logs yyc-brokers --lines 100

# Common issues:
# 1. Database connection failed
#    - Verify DATABASE_URL
#    - Check PostgreSQL is running: sudo systemctl status postgresql
#
# 2. Redis connection failed
#    - Verify REDIS_URL
#    - Check Redis: sudo systemctl status redis
#
# 3. Port already in use
#    - Change PORT in .env
#    - Or kill process: sudo lsof -ti:3000 | xargs kill -9
```

### SSL Certificate Issues

```bash
# Renew certificate
sudo certbot renew

# Test renewal
sudo certbot renew --dry-run

# Auto-renewal (should be enabled by default)
sudo systemctl status certbot.timer
```

### High Memory Usage

```bash
# Check process memory
pm2 monit

# If > 1GB, consider:
# 1. Restart app: pm2 restart yyc-brokers
# 2. Increase server RAM
# 3. Enable swap file
# 4. Investigate memory leaks (check Sentry)
```

### Database Performance

```bash
# Check slow queries
sudo -u postgres psql yyc_brokers

# Enable query logging
ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries > 1s
SELECT pg_reload_conf();

# View logs
tail -f /var/log/postgresql/postgresql-14-main.log
```

---

## Security Checklist

- [ ] HTTPS enabled with valid SSL certificate
- [ ] Firewall configured (UFW or cloud provider)
- [ ] SSH key authentication only (disable password login)
- [ ] Regular security updates: `apt update && apt upgrade`
- [ ] Fail2ban installed to block brute force attacks
- [ ] Database not exposed to public internet
- [ ] Strong passwords for all services
- [ ] Environment variables secured (not in code)
- [ ] Stripe webhook secret configured
- [ ] Rate limiting enabled
- [ ] CSRF protection enabled
- [ ] Security headers set (helmet.js)

---

## Maintenance

### Weekly
- [ ] Review Sentry errors
- [ ] Check uptime monitoring reports
- [ ] Review server resources

### Monthly
- [ ] Update npm dependencies: `npm update`
- [ ] Security audit: `npm audit`
- [ ] Review access logs for anomalies
- [ ] Test backups (restore to staging)

### Quarterly
- [ ] Rotate API keys and secrets
- [ ] Review user access and permissions
- [ ] Update Node.js version if needed
- [ ] Security penetration testing

---

## Rollback Plan

If deployment fails:

1. **Immediate:**
   ```bash
   pm2 stop yyc-brokers
   git checkout previous-stable-tag
   npm install
   npm run client:build
   pm2 restart yyc-brokers
   ```

2. **Database:**
   ```bash
   # Restore backup
   psql -U yyc_user yyc_brokers < backup_previous.sql
   ```

3. **Notify users** if downtime > 5 minutes

---

## Support Contacts

- Infrastructure issues: Your hosting provider
- DNS issues: Your domain registrar
- Email issues: Resend support (support@resend.com)
- Payment issues: Stripe support
- Code issues: Check GitHub issues or internal team

---

## Cost Estimate (Monthly)

| Service | Cost |
|---------|------|
| VPS (4GB RAM) | $24 |
| PostgreSQL | Included |
| Redis | Included |
| Domain | $12/year |
| SSL Certificate | Free (Let's Encrypt) |
| Resend (50K emails) | $20 |
| Stripe | 2.9% + 30¢ per transaction |
| Sentry | Free tier or $26/month |
| AWS S3 (50GB) | ~$1 |
| **Total** | **~$50-75/month** |

(Scales with usage - add load balancer, CDN, etc. as needed)
