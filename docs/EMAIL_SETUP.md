# Email Service Setup Guide

## Overview

YYC Brokers uses [Resend](https://resend.com) for transactional email delivery. Email verification is **required** for driver and store owner accounts.

## Quick Start (Development)

### Option 1: No Email Service (Console Only)

If you don't configure email, verification codes will be printed to your console:

1. Leave `RESEND_API_KEY` unset in `.env`
2. Start the server: `npm run dev`
3. When a user registers, check the console for output like:
   ```
   [Email] Would send to: user@example.com
   [Email] Subject: Verify your YYC Brokers account
   [Email] Body: ...Your verification code is: 123456...
   ```
4. Copy the 6-digit code and enter it in the verification screen

**Pros:** No setup required, works immediately
**Cons:** Only works locally, can't test real email delivery

### Option 2: Use Resend (Recommended)

1. Sign up at https://resend.com (free tier: 3,000 emails/month)
2. Get your API key from https://resend.com/api-keys
3. Add to `.env`:
   ```env
   RESEND_API_KEY=re_your_api_key_here
   FROM_EMAIL=YYC Brokers <noreply@yourdomain.com>
   ```
4. Restart your server

**Pros:** Real email delivery, production-ready
**Cons:** Requires signup and domain verification for production

---

## Production Setup

### Step 1: Create Resend Account

1. Go to https://resend.com
2. Sign up with your email
3. Verify your email address

### Step 2: Add and Verify Your Domain

#### Why Domain Verification?

- Free tier allows sending from `@resend.dev` domains (limited)
- Your own domain looks professional and improves deliverability
- Required for production volume

#### Add Domain:

1. Go to https://resend.com/domains
2. Click "Add Domain"
3. Enter your domain (e.g., `yycbrokers.com`)
4. Copy the DNS records provided

#### Configure DNS:

Add these DNS records to your domain provider (Cloudflare, Namecheap, etc.):

```
Type: TXT
Name: @
Value: [verification code from Resend]

Type: MX
Name: @
Value: feedback-smtp.us-east-1.amazonses.com
Priority: 10

Type: TXT
Name: _dmarc
Value: v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com
```

**Note:** DNS propagation can take up to 48 hours, but usually completes in 1-2 hours.

#### Verify Domain:

1. Return to Resend dashboard
2. Click "Verify" next to your domain
3. Wait for green checkmark

### Step 3: Get API Key

1. Go to https://resend.com/api-keys
2. Click "Create API Key"
3. Name it (e.g., "YYC Brokers Production")
4. Select permission: "Sending access"
5. Copy the key (starts with `re_`)

**⚠️ Important:** Save this key immediately - you can't view it again!

### Step 4: Configure Environment

Update your production `.env`:

```env
RESEND_API_KEY=re_your_production_key_here
FROM_EMAIL=YYC Brokers <noreply@yourdomain.com>
NODE_ENV=production
```

### Step 5: Test Email Delivery

```bash
# In your app, trigger a registration
curl -X POST http://localhost:3000/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "role": "store",
    "name": "Test Store",
    "email": "your-real-email@gmail.com",
    "password": "testpassword123",
    "phone": "123-456-7890",
    "address": "123 Main St",
    "contact": "John Doe"
  }'

# Check your email inbox for the verification code
```

---

## Email Templates

The app sends these emails:

### 1. Email Verification (Required)
- **Sent to:** Drivers and store owners after registration
- **Contains:** 6-digit verification code
- **Expires:** 15 minutes
- **Template:** `src/email/client.js:sendVerificationEmail`

### 2. Password Reset
- **Sent to:** Users who request password reset
- **Contains:** Password reset link (1-hour expiry)
- **Template:** `src/email/client.js:sendPasswordResetEmail`

### 3. Quote Ready (Store Owners)
- **Sent to:** Store owners when broker sends a quote
- **Contains:** Shipment ID, quote amount, link to accept
- **Template:** `src/email/client.js:sendQuoteReadyEmail`

### 4. Job Offer (Drivers)
- **Sent to:** Drivers when offered a delivery job
- **Contains:** Shipment details, driver rate, link to accept
- **Template:** `src/email/client.js:sendJobOfferEmail`

### 5. Delivery Completed (Store Owners)
- **Sent to:** Store owners when delivery is marked complete
- **Contains:** Shipment ID, proof of delivery reference
- **Template:** `src/email/client.js:sendDeliveryCompletedEmail`

---

## Monitoring Email Delivery

### Resend Dashboard

Monitor your emails at https://resend.com/emails:

- **Sent:** Successfully delivered
- **Delivered:** Confirmed received by recipient
- **Bounced:** Email address invalid
- **Complained:** Marked as spam

### Common Issues

#### Emails Not Sending

**Check console for errors:**
```bash
[Email] Failed to send: Resend rejected the email: API key invalid
```

**Solutions:**
- Verify `RESEND_API_KEY` is correct
- Check API key hasn't been deleted in Resend dashboard
- Ensure API key has "Sending access" permission

#### Emails Going to Spam

**Solutions:**
1. Verify your domain with Resend
2. Add SPF, DKIM, and DMARC records
3. Avoid spam trigger words in subject lines
4. Warm up your domain (start with low volume)
5. Use a professional "from" address

#### Verification Codes Expiring

Codes expire after 15 minutes. This is intentional for security.

**User forgot code:**
- User can click "Resend Code" in the verification screen
- New code invalidates old code
- Rate limited to prevent abuse (5 codes per 15 minutes)

---

## Rate Limits

### Resend Free Tier
- 3,000 emails/month
- 100 emails/day
- No concurrent sending limit

### Resend Pro ($20/month)
- 50,000 emails/month
- Dedicated IP (better deliverability)
- Priority support

### App Rate Limits
- Verification code resend: 5 per 15 minutes per email
- Failed verification attempts: 5 before code burns
- General email sending: No app-level limit (controlled by Resend)

---

## Development Tips

### Testing Without Spam

Use a test email service like:
- https://mailtrap.io (catches emails without sending)
- https://ethereal.email (temporary test emails)
- Your own Gmail with `+tags` (e.g., `yourname+test1@gmail.com`)

### Disable Email in Tests

When running automated tests:

```env
# In .env.test
RESEND_API_KEY=
```

Emails will log to console instead of actually sending.

### View Email HTML Locally

Open `src/email/client.js` and copy an email template's HTML into a local `.html` file to preview styling.

---

## Troubleshooting

### "RESEND_API_KEY not configured"

**Console shows:**
```
[Email] Skipping email send (RESEND_API_KEY not configured)
[Email] Would send to: user@example.com
```

**This is normal in development!** The code will be printed to your console.

**To fix for production:**
1. Get Resend API key
2. Add to `.env`
3. Restart server

### "Resend rejected the email: From address not verified"

You're using a `FROM_EMAIL` that hasn't been verified.

**Solutions:**
- Option 1: Use `onboarding@resend.dev` for testing (free tier)
- Option 2: Verify your domain in Resend dashboard

### "Too many wrong codes"

Security feature: after 5 wrong guesses, the code is deleted.

**Solution:**
- Click "Resend Code" to get a new one
- Check console if in development mode

---

## Security Best Practices

### ✅ Do's

- ✅ Verify domain for production
- ✅ Use environment variables for API keys
- ✅ Never commit `.env` to git
- ✅ Rotate API keys periodically
- ✅ Monitor delivery rates
- ✅ Set up DMARC reporting

### ❌ Don'ts

- ❌ Don't hardcode API keys in code
- ❌ Don't use personal Gmail as FROM_EMAIL
- ❌ Don't send verification codes via SMS (use email)
- ❌ Don't disable rate limiting
- ❌ Don't include sensitive data in emails

---

## Cost Estimates

### Low Volume (< 3,000 emails/month)
**Resend Free Tier:** $0/month

### Medium Volume (< 50,000 emails/month)
**Resend Pro:** $20/month

### High Volume (> 50,000 emails/month)
**Resend Business:** $80/month for 100K emails

### Per-User Email Breakdown
Assuming 100 users:
- Registration verification: 100 emails
- Quote notifications: ~50 emails/month
- Job offers: ~100 emails/month
- Delivery notifications: ~100 emails/month
- Password resets: ~10 emails/month

**Total:** ~360 emails/month per 100 users

---

## Support

### Resend Support
- Documentation: https://resend.com/docs
- Status page: https://status.resend.com
- Support email: support@resend.com

### YYC Brokers Email Issues
Check the code in `src/email/client.js` for email templates and sending logic.

For verification flow issues, check:
- `src/server.js` (registration endpoint)
- `src/redis.js` (verification code storage)
- `src/store.js` (email verification flag)
