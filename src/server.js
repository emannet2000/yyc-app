import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import * as store from './store.js';
import * as redis from './redis.js';
import { healthCheck as redisHealthCheck } from './redis.js';
import { authRateLimiter } from './middleware/ratelimit.js';
import { query as pgQuery } from './db/postgres.js';
import * as emailClient from './email/client.js';
import * as documents from './storage/documents.js';
import { isConfigured as isS3Configured } from './storage/s3.js';
import { verifyConnection as verifyS3Connection } from './storage/s3.js';
import * as gpsLocation from './gps/location.js';
import * as maps from './maps/directions.js';
import * as stripePayments from './payments/stripe.js';
import { initializeWebSocket, broadcastShipmentUpdate, broadcastGPSUpdate, broadcastPaymentUpdate } from './websocket/server.js';
import * as mfa from './auth/mfa.js';
import * as notifications from './notifications/manager.js';
import { generateInvoice } from './invoices/generator.js';

const { AppError, check } = store;
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp({ secure = process.env.NODE_ENV === 'production', publicOrigin = process.env.PUBLIC_ORIGIN || '' } = {}) {
  if (secure) {
    let origin;
    try {
      origin = new URL(publicOrigin);
    } catch {
      throw new Error('Production requires PUBLIC_ORIGIN set to the exact HTTPS browser origin.');
    }
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) {
      throw new Error('Production PUBLIC_ORIGIN must be an origin such as https://broker.example.com, without a path.');
    }
  }

  function json(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(data));
  }

  function cookie(req) {
    let m = (req.headers.cookie || '').match(/(?:^|;\s*)yyc_session=([a-f0-9]{64})(?:;|$)/);
    return m?.[1];
  }

  function setCookie(res, token, maxAge = 43200) {
    res.setHeader('Set-Cookie', `yyc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }

  async function body(req) {
    check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'Send application/json.');
    let chunks = [], size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      check(size <= 32768, 413, 'Request is too large.');
      chunks.push(chunk);
    }
    try {
      let result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      check(result && typeof result === 'object' && !Array.isArray(result), 400, 'JSON object required.');
      return result;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, 'Invalid JSON.');
    }
  }

  function origin(req) {
    let expected = publicOrigin || `${secure ? 'https' : 'http'}://${req.headers.host}`;
    check(req.headers.origin === expected, 403, 'Request origin is not allowed.');
    check(!['cross-site'].includes(req.headers['sec-fetch-site']), 403, 'Cross-site requests are not allowed.');
  }

  // Rate limiting middleware wrapper for inline use
  async function rateLimit(req) {
    return new Promise((resolve, reject) => {
      authRateLimiter(req, { setHeader: () => {} }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://js.stripe.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://*.tile.openstreetmap.org https://*.stripe.com; connect-src 'self' ws: wss: https://api.stripe.com; frame-src https://www.google.com https://maps.google.com https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://js.stripe.com https://hooks.stripe.com");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

    try {
      let url = new URL(req.url, 'http://localhost');
      let path = url.pathname;

      // Health check endpoint
      if (path === '/healthz' && req.method === 'GET') {
        try {
          await pgQuery('SELECT 1');
          const redisOk = await redisHealthCheck();
          return json(res, 200, {
            status: 'ok',
            database: 'connected',
            redis: redisOk ? 'connected' : 'degraded',
            maps: maps.isConfigured(),
            gps: true
          });
        } catch (err) {
          return json(res, 503, { status: 'error', error: err.message });
        }
      }

      // API routes
      if (path.startsWith('/api/')) {
        const mutation = !['GET', 'HEAD'].includes(req.method);
        // Stripe authenticates callbacks with its signed raw body, not a browser Origin header.
        if (mutation && path !== '/api/webhooks/stripe') origin(req);

        // Registration endpoint (with rate limiting)
        if (path === '/api/register' && req.method === 'POST') {
          await rateLimit(req);
          let u = await store.createUser(await body(req));

          // Send verification email for non-admin users
          if (u.role !== 'admin') {
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            await redis.setVerificationCode(u.email, code);
            await emailClient.sendVerificationEmail(u.email, code, u.name);
          }

          return json(res, 201, {
            user: u,
            message: u.role === 'driver'
              ? 'Registration saved. Check your email for a verification code. YYC approval is also required.'
              : 'Store account created. Check your email for a verification code to activate your account.'
          });
        }

        // Login endpoint (with rate limiting)
        if (path === '/api/login' && req.method === 'POST') {
          await rateLimit(req);
          let data = await body(req);
          let u = await store.login(data.email, data.password);

          // Check email verification (except for admin accounts)
          if (u.role !== 'admin' && !u.email_verified) {
            return json(res, 403, { error: 'Please verify your email address before logging in. Check your inbox for the verification code.' });
          }

          // Check if MFA is enabled
          if (u.mfa_enabled) {
            // If MFA code is provided, verify it
            if (data.mfaCode) {
              const isValid = mfa.verifyTOTP(u.mfa_secret, data.mfaCode);
              const isBackupCode = !isValid && await mfa.verifyBackupCode(u.id, data.mfaCode);

              if (!isValid && !isBackupCode) {
                return json(res, 401, { error: 'Invalid MFA code' });
              }

              // MFA verified, create session
              let s = await store.createSession(u.id);
              setCookie(res, s.token);
              return json(res, 200, { user: await store.publicUser(u), csrf: s.csrf });
            } else {
              // MFA required but not provided
              return json(res, 200, { mfaRequired: true, userId: u.id });
            }
          }

          // No MFA, create session normally
          let s = await store.createSession(u.id);
          setCookie(res, s.token);
          return json(res, 200, { user: await store.publicUser(u), csrf: s.csrf });
        }

        // Verify Email endpoint
        if (path === '/api/verify-email' && req.method === 'POST') {
          await rateLimit(req);
          let data = await body(req);
          const { email, code } = data;

          check(email && code, 400, 'Email and verification code are required');

          // Verify code from Redis
          const storedCode = await redis.getVerificationCode(email);
          check(storedCode && storedCode === code.toString(), 400, 'Invalid or expired verification code');

          // Mark email as verified
          await store.verifyEmail(email);

          // Delete used code
          await redis.deleteVerificationCode(email);

          return json(res, 200, { success: true, message: 'Email verified successfully! You can now log in.' });
        }

        // Resend Verification Code endpoint
        if (path === '/api/resend-code' && req.method === 'POST') {
          await rateLimit(req);
          let data = await body(req);
          const { email } = data;

          check(email, 400, 'Email is required');

          // Get user
          const user = await store.getUserByEmail(email);
          check(user, 404, 'User not found');
          check(!user.email_verified, 400, 'Email is already verified');

          // Generate new 6-digit code
          const code = Math.floor(100000 + Math.random() * 900000).toString();
          await redis.setVerificationCode(email, code);

          // Send email
          await emailClient.sendVerificationEmail(email, code, user.name);

          return json(res, 200, { success: true, message: 'Verification code sent to your email' });
        }

        // Request Password Reset endpoint
        if (path === '/api/request-reset' && req.method === 'POST') {
          await rateLimit(req);
          let data = await body(req);
          const { email } = data;

          check(email, 400, 'Email is required');

          // Get user
          const user = await store.getUserByEmail(email);

          // Always return success to prevent email enumeration
          if (user) {
            // Generate secure reset token
            const token = crypto.randomBytes(32).toString('hex');
            await redis.setResetToken(email, token);

            // Send reset email
            await emailClient.sendPasswordResetEmail(email, token, user.name);
          }

          return json(res, 200, { success: true, message: 'If an account exists with this email, a password reset link has been sent.' });
        }

        // Reset Password endpoint
        if (path === '/api/reset-password' && req.method === 'POST') {
          await rateLimit(req);
          let data = await body(req);
          const { token, password } = data;

          check(token && password, 400, 'Token and new password are required');
          check(password.length >= 12, 400, 'Password must be at least 12 characters');

          // Verify token from Redis
          const email = await redis.getResetToken(token);
          check(email, 400, 'Invalid or expired reset token');

          // Update password
          await store.updatePassword(email, password);

          // Delete used token
          await redis.deleteResetToken(token);

          return json(res, 200, { success: true, message: 'Password reset successfully! You can now log in with your new password.' });
        }

        // Stripe Webhook Handler (before authentication - uses signature verification)
        if (path === '/api/webhooks/stripe' && req.method === 'POST') {
          check(stripePayments.webhooksConfigured(), 503, 'Stripe webhooks are not configured.');

          // Get raw body for signature verification
          let chunks = [], size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            check(size <= 32768, 413, 'Request is too large.');
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');
          const signature = req.headers['stripe-signature'];

          check(signature, 400, 'Missing Stripe signature');

          try {
            const event = stripePayments.constructWebhookEvent(rawBody, signature);

            console.log(`[Stripe Webhook] Received event: ${event.type}`);

            // Handle different event types
            switch (event.type) {
              case 'payment_intent.succeeded': {
                const paymentIntent = event.data.object;
                const shipmentId = paymentIntent.metadata.shipmentId;
                const storeId = paymentIntent.metadata.storeId;

                if (shipmentId) {
                  await pgQuery(
                    'UPDATE shipments SET payment_status = $1 WHERE id = $2',
                    ['succeeded', shipmentId]
                  );
                  console.log(`[Stripe] Payment succeeded for shipment ${shipmentId}`);

                  // Broadcast payment update via WebSocket
                  broadcastPaymentUpdate(shipmentId, { status: 'succeeded' });

                  // Send notification to store owner
                  if (storeId) {
                    const storeUser = await pgQuery('SELECT * FROM users WHERE id = $1', [storeId]);
                    if (storeUser.rows[0]) {
                      const store = storeUser.rows[0];
                      await notifications.notifyShipmentUpdate(
                        storeId,
                        store.profile?.phone,
                        shipmentId,
                        'Payment successful! Your shipment will be processed.'
                      );
                    }
                  }
                }
                break;
              }

              case 'payment_intent.payment_failed': {
                const paymentIntent = event.data.object;
                const shipmentId = paymentIntent.metadata.shipmentId;

                if (shipmentId) {
                  await pgQuery(
                    'UPDATE shipments SET payment_status = $1 WHERE id = $2',
                    ['failed', shipmentId]
                  );
                  console.log(`[Stripe] Payment failed for shipment ${shipmentId}`);
                }
                break;
              }

              case 'transfer.created':
              case 'transfer.paid': {
                const transfer = event.data.object;
                const shipmentId = transfer.metadata.shipmentId;

                if (shipmentId) {
                  await pgQuery(
                    'UPDATE shipments SET payout_status = $1 WHERE id = $2',
                    ['paid', shipmentId]
                  );
                  console.log(`[Stripe] Payout completed for shipment ${shipmentId}`);
                }
                break;
              }

              case 'transfer.failed': {
                const transfer = event.data.object;
                const shipmentId = transfer.metadata.shipmentId;

                if (shipmentId) {
                  await pgQuery(
                    'UPDATE shipments SET payout_status = $1 WHERE id = $2',
                    ['failed', shipmentId]
                  );
                  console.log(`[Stripe] Payout failed for shipment ${shipmentId}`);
                }
                break;
              }

              default:
                console.log(`[Stripe] Unhandled event type: ${event.type}`);
            }

            return json(res, 200, { received: true });
          } catch (err) {
            console.error('[Stripe Webhook] Error:', err.message);
            return json(res, 400, { error: err.message });
          }
        }

        // Session check endpoint
        const token = cookie(req);
        const session = await store.session(token);

        if (path === '/api/session' && req.method === 'GET') {
          return json(res, 200, {
            user: session ? await store.publicUser(session.user) : null,
            csrf: session?.csrf || null
          });
        }

        // Require authentication for all other endpoints
        check(session, 401, 'Please log in.');
        if (mutation) {
          check(req.headers['x-csrf-token'] === session.csrf, 403, 'Your session token is missing or expired. Refresh and try again.');
        }

        let u = session.user;

        // Logout endpoint
        if (path === '/api/logout' && req.method === 'POST') {
          await store.logout(token);
          setCookie(res, '', 0);
          return json(res, 200, { ok: true });
        }

        // State endpoint (shipments list)
        if (path === '/api/state' && req.method === 'GET') {
          let limit = Number(url.searchParams.get('limit') || 100);
          let after = url.searchParams.get('after') || '';
          return json(res, 200, await store.state(u, { limit, after }));
        }

        // Profile update endpoint
        if (path === '/api/account/export' && req.method === 'GET') {
          let shipmentRows = [], cursor = '';
          for (let page = 0; page < 100; page++) {
            const result = await store.state(u, { limit: 200, after: cursor });
            shipmentRows.push(...result.shipments);
            if (!result.next) break;
            cursor = result.next;
          }
          const [account, ownDocuments, ownNotifications, accountAudit] = await Promise.all([
            store.publicUser(u), documents.getUserDocuments(u.id),
            pgQuery('SELECT title,message,shipment_id,read_at,created_at FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC', [u.id]),
            pgQuery('SELECT event,shipment_id,created_at FROM audit WHERE actor_id=$1 ORDER BY created_at DESC', [u.id])
          ]);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="yyc-account-export.json"', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), account, shipments: shipmentRows, documents: ownDocuments, notifications: ownNotifications.rows, audit: accountAudit.rows }, null, 2));
        }
        if (path === '/api/account/deletion-request' && req.method === 'GET') {
          const result = await pgQuery('SELECT id,status,reason,requested_at FROM account_deletion_requests WHERE user_id=$1 ORDER BY requested_at DESC LIMIT 1', [u.id]);
          return json(res, 200, { request: result.rows[0] || null });
        }
        if (path === '/api/account/deletion-request' && req.method === 'POST') {
          const data = await body(req);
          const existing = await pgQuery("SELECT id FROM account_deletion_requests WHERE user_id=$1 AND status='pending' LIMIT 1", [u.id]);
          check(!existing.rowCount, 409, 'You already have a pending account-removal request.');
          const result = await pgQuery('INSERT INTO account_deletion_requests(user_id,reason) VALUES($1,$2) RETURNING id,status,requested_at', [u.id, String(data.reason || '').slice(0,1000)]);
          return json(res, 201, { request: result.rows[0] });
        }
        if (path === '/api/account/deletion-request' && req.method === 'DELETE') {
          await body(req);
          const result = await pgQuery("UPDATE account_deletion_requests SET status='rejected',decision_notes='Cancelled by account owner',decided_at=NOW() WHERE user_id=$1 AND status='pending' RETURNING id", [u.id]);
          return json(res, 200, { cancelled: result.rowCount > 0 });
        }
        if (path === '/api/admin/account-deletion-requests' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required.');
          const result = await pgQuery(`SELECT r.id,r.user_id,r.reason,r.status,r.requested_at,u.email,u.name,u.role
            FROM account_deletion_requests r JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.requested_at`);
          return json(res, 200, { requests: result.rows });
        }
        let deletionDecision = path.match(/^\/api\/admin\/account-deletion-requests\/([a-f0-9-]+)$/);
        if (deletionDecision && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required.');
          const data = await body(req), decision = data.decision;
          check(['approve','reject'].includes(decision), 400, 'Choose approve or reject.');
          const request = await pgQuery("SELECT user_id FROM account_deletion_requests WHERE id=$1 AND status='pending'", [deletionDecision[1]]);
          check(request.rowCount === 1, 404, 'Pending request not found.');
          const accountId = request.rows[0].user_id;
          if (decision === 'approve') {
            const docs = await documents.getUserDocuments(accountId);
            for (const doc of docs) await documents.deleteDocument(doc.id);
            await pgQuery('DELETE FROM notification_tokens WHERE user_id=$1', [accountId]);
            await pgQuery('DELETE FROM user_notifications WHERE user_id=$1', [accountId]);
            await pgQuery('DELETE FROM store_team_memberships WHERE owner_user_id=$1 OR member_user_id=$1', [accountId]);
            await pgQuery("DELETE FROM gps_locations WHERE driver_id=$1", [accountId]);
            await pgQuery("UPDATE shipments SET data=data - 'pickupContact' - 'receivingContact' - 'notes' - 'appointment' - 'cargoNotes' WHERE store_id=$1", [accountId]);
            await pgQuery("UPDATE users SET disabled=true,email='removed+'||id::text||'@deleted.invalid',name='Deleted account',password_hash='account-removed',profile='{}'::jsonb,notification_preferences='{}'::jsonb WHERE id=$1", [accountId]);
          }
          await pgQuery('UPDATE account_deletion_requests SET status=$1,decided_by=$2,decided_at=NOW(),decision_notes=$3 WHERE id=$4', [decision === 'approve' ? 'approved' : 'rejected', u.id, String(data.notes || '').slice(0,1000), deletionDecision[1]]);
          await pgQuery('INSERT INTO audit(shipment_id,actor_id,event) VALUES(NULL,$1,$2)', [u.id, `Account removal request ${decision}d for ${accountId}`]);
          return json(res, 200, { decision });
        }

        if (path === '/api/team' && req.method === 'GET') {
          check(u.role === 'store', 403, 'Store team access required.');
          const ownerId = await store.storeOwnerId(u);
          const result = await pgQuery(`SELECT m.member_user_id AS id, u.email, u.name, m.permissions, m.created_at
            FROM store_team_memberships m JOIN users u ON u.id = m.member_user_id WHERE m.owner_user_id = $1 ORDER BY m.created_at`, [ownerId]);
          return json(res, 200, { owner: ownerId === u.id, members: result.rows });
        }
        if (path === '/api/team' && req.method === 'POST') {
          check(u.role === 'store' && (await store.storeOwnerId(u)) === u.id, 403, 'Only the store account owner can invite team members.');
          let data = await body(req), email = String(data.email || '').trim().toLowerCase();
          check(email.includes('@') && email.length <= 254, 400, 'Enter a valid existing account email.');
          const member = await pgQuery("SELECT id, role, disabled, email_verified FROM users WHERE email = $1", [email]);
          check(member.rows[0]?.role === 'store' && !member.rows[0].disabled && member.rows[0].email_verified, 404, 'Invitees need an active, verified store account first.');
          check(member.rows[0].id !== u.id, 400, 'You cannot add the owner as a team member.');
          const existingMembership = await pgQuery('SELECT owner_user_id FROM store_team_memberships WHERE member_user_id=$1', [member.rows[0].id]);
          check(!existingMembership.rowCount || existingMembership.rows[0].owner_user_id === u.id, 409, 'This account already belongs to another store team.');
          const permissions = { 'shipments.read': true, 'shipments.write': data.permissions?.['shipments.write'] === true, 'billing.read': data.permissions?.['billing.read'] === true };
          const result = await pgQuery(`INSERT INTO store_team_memberships(owner_user_id, member_user_id, permissions)
            VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_user_id,member_user_id) DO UPDATE SET permissions=EXCLUDED.permissions
            RETURNING owner_user_id, member_user_id, permissions`, [u.id, member.rows[0].id, JSON.stringify(permissions)]);
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL,$1,$2)', [u.id, 'Store team access granted to ' + email]);
          return json(res, 201, { membership: result.rows[0] });
        }
        let teamMemberMatch = path.match(/^\/api\/team\/([a-f0-9-]+)$/);
        if (teamMemberMatch && req.method === 'DELETE') {
          await body(req);
          check(u.role === 'store' && (await store.storeOwnerId(u)) === u.id, 403, 'Only the store account owner can remove team members.');
          const result = await pgQuery('DELETE FROM store_team_memberships WHERE owner_user_id = $1 AND member_user_id = $2 RETURNING member_user_id', [u.id, teamMemberMatch[1]]);
          check(result.rowCount === 1, 404, 'Team member not found.');
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL,$1,$2)', [u.id, 'Store team membership removed: ' + teamMemberMatch[1]]);
          return json(res, 200, { removed: true });
        }

        if (path === '/api/profile' && req.method === 'PATCH') {
          return json(res, 200, { user: await store.updateProfile(u, await body(req)) });
        }

        if (path === '/api/admin/accounts' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');
          const result = await pgQuery('SELECT id, email, role, name, approved, disabled, email_verified, created_at FROM users ORDER BY created_at DESC LIMIT 250');
          return json(res, 200, { accounts: result.rows });
        }
        if (path === '/api/admin/providers' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');
          return json(res, 200, { providers: {
            postgres: true,
            redis: await redisHealthCheck(),
            maps: maps.isConfigured(),
            email: emailClient.isConfigured(),
            storage: isS3Configured(),
            payments: stripePayments.isConfigured(),
            paymentWebhooks: stripePayments.webhooksConfigured(),
            sms: notifications.smsConfigured?.() || false,
            push: notifications.pushConfigured?.() || false
          } });
        }
        if (path === '/api/admin/providers/verify' && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          const probe = async fn => {
            let timer;
            try {
              const result = await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider probe timed out')), 4500); })]);
              return { status: 'verified', details: result };
            } catch (e) { return { status: 'failed', error: String(e.message).slice(0, 180) }; }
            finally { clearTimeout(timer); }
          };
          const checks = {
            postgres: () => pgQuery('SELECT 1').then(() => ({ connected: true })),
            redis: () => redis.redis.ping().then(pong => ({ pong })),
            maps: maps.isConfigured() ? () => maps.geocodeAddress('Calgary, Alberta, Canada').then(() => ({ connected: true })) : null,
            email: emailClient.isConfigured() ? () => emailClient.verifyConnection() : null,
            storage: isS3Configured() ? () => verifyS3Connection() : null,
            payments: stripePayments.isConfigured() ? () => stripePayments.verifyConnection() : null,
            sms: notifications.smsConfigured() ? () => notifications.verifySMSProvider() : null,
            push: null
          };
          const results = await Promise.all(Object.entries(checks).map(async ([name, fn]) => [name, fn ? await probe(fn) : { status: 'unconfigured' }]));
          const providers = Object.fromEntries(results);
          if (notifications.pushConfigured()) providers.push = { status: 'configured_unverified', details: { note: 'Firebase credentials initialize; token delivery requires a registered device.' } };
          return json(res, 200, { providers, checkedAt: new Date().toISOString() });
        }
        const accountStateMatch = path.match(/^\/api\/admin\/accounts\/([a-f0-9-]+)\/(suspend|restore)$/);
        if (accountStateMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          const [, accountId, operation] = accountStateMatch;
          check(accountId !== u.id, 400, 'You cannot suspend your own broker account.');
          const disabled = operation === 'suspend';
          const result = await pgQuery('UPDATE users SET disabled = $1 WHERE id = $2 RETURNING id, email, role, name, disabled', [disabled, accountId]);
          check(result.rowCount === 1, 404, 'Account not found.');
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, `Account ${disabled ? 'suspended' : 'restored'}: ${accountId}`]);
          return json(res, 200, { account: result.rows[0] });
        }

        // Create shipment endpoint
        if (path === '/api/shipments' && req.method === 'POST') {
          return json(res, 201, { shipment: await store.createShipment(u, await body(req)) });
        }

        // Shipment actions endpoint
        let shipmentMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/actions$/);
        if (shipmentMatch && req.method === 'POST') {
          let data = await body(req);
          const shipment = await store.act(u, shipmentMatch[1], data.action, data);
          broadcastShipmentUpdate(shipmentMatch[1], { version: shipment.version, status: shipment.status });
          const shipmentRecord = await store.getShipment(shipmentMatch[1]);
          const recipientIds = [...new Set([shipmentRecord?.store_id, shipmentRecord?.driver_id, shipmentRecord?.offered_to].filter(id => id && id !== u.id))];
          for (const recipientId of recipientIds) {
            try {
              const slaMessage = shipment.pickupSlaMet === false ? 'Pickup target missed. ' : shipment.deliverySlaMet === false ? 'Delivery target missed. ' : '';
              await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [recipientId, shipmentMatch[1], `Delivery ${shipmentMatch[1]} updated`, `${slaMessage}Status: ${shipment.status}`]);
              const recipient = await pgQuery('SELECT email, profile FROM users WHERE id = $1', [recipientId]);
              const account = recipient.rows[0];
              if (account) await notifications.notifyShipmentUpdate(recipientId, account.profile?.phone || '', shipmentMatch[1], `Delivery status changed to ${shipment.status}.`);
            } catch (error) { console.warn('[Notifications] Shipment update could not be delivered:', error.message); }
          }
          return json(res, 200, { shipment });
        }

        // Driver approval endpoint
        let driverMatch = path.match(/^\/api\/drivers\/([a-f0-9-]+)\/approve$/);
        if (driverMatch && req.method === 'POST') {
          await body(req);
          return json(res, 200, { driver: await store.approve(u, driverMatch[1]) });
        }

        // Document upload: Get pre-signed URL
        if (path === '/api/documents/upload-url' && req.method === 'POST') {
          check(isS3Configured(), 503, 'Document uploads are not configured. Contact administrator.');

          let data = await body(req);
          const { documentType, fileExtension } = data;

          check(documentType && fileExtension, 400, 'Document type and file extension are required');

          const { uploadUrl, uploadId, s3Key } = await documents.createUploadUrl(u.id, documentType, fileExtension);

          return json(res, 200, { uploadUrl, uploadId, s3Key });
        }

        // Document upload: Confirm upload and create record
        if (path === '/api/documents' && req.method === 'POST') {
          let data = await body(req);
          const { s3Key, filename, documentType, fileSize, contentType, expiryDate, shipmentId } = data;

          check(s3Key && filename && documentType, 400, 'S3 key, filename, and document type are required');
          check(typeof s3Key === 'string' && s3Key.startsWith(`documents/${u.id}/${documentType}/`), 403, 'Uploaded file does not belong to your account or selected document type.');
          check(['license', 'insurance', 'registration', 'pod', 'invoice', 'receipt'].includes(documentType), 400, 'Unsupported document type.');
          const attachedShipment = shipmentId ? await store.getShipment(shipmentId) : null;
          check(!shipmentId || u.role === 'admin' || (attachedShipment && (await store.hasStorePermission(u, attachedShipment.store_id, 'shipments.read') || attachedShipment.driver_id === u.id)), 403, 'You cannot attach a file to this shipment.');

          const document = await documents.createDocument({
            userId: u.id,
            shipmentId: shipmentId || null,
            type: documentType,
            s3Key,
            filename,
            fileSize: fileSize || null,
            contentType: contentType || null,
            expiryDate: expiryDate || null
          });

          return json(res, 201, { document });
        }

        // Get user's documents
        if (path === '/api/documents' && req.method === 'GET') {
          const type = url.searchParams.get('type') || null;
          const status = url.searchParams.get('status') || null;

          const userDocs = await documents.getUserDocuments(u.id, { type, status });

          return json(res, 200, { documents: userDocs });
        }

        // Get document download URL
        let documentDownloadMatch = path.match(/^\/api\/documents\/([a-f0-9-]+)\/download$/);
        if (documentDownloadMatch && req.method === 'GET') {
          const documentId = documentDownloadMatch[1];
          const doc = await documents.getDocument(documentId);

          check(doc, 404, 'Document not found');
          const linkedShipment = doc.shipment_id ? await store.getShipment(doc.shipment_id) : null;
          check(doc.user_id === u.id || u.role === 'admin' || (linkedShipment && (await store.hasStorePermission(u, linkedShipment.store_id, 'shipments.read') || linkedShipment.driver_id === u.id)), 403, 'You do not have access to this document');

          const downloadUrl = await documents.getDocumentDownloadUrl(documentId);

          return json(res, 200, { downloadUrl });
        }

        // Admin: Get pending documents for review
        if (path === '/api/admin/documents/pending' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');

          const pending = await documents.getPendingDocuments();

          return json(res, 200, { documents: pending });
        }

        // Admin: Get expiring documents
        if (path === '/api/admin/documents/expiring' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');

          const expiring = await documents.getExpiringDocuments();

          return json(res, 200, { documents: expiring });
        }

        // Admin: Approve document
        let documentApproveMatch = path.match(/^\/api\/admin\/documents\/([a-f0-9-]+)\/approve$/);
        if (documentApproveMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');

          const documentId = documentApproveMatch[1];
          let data = await body(req);
          const { notes } = data;

          const document = await documents.approveDocument(documentId, u.id, notes || null);

          return json(res, 200, { document });
        }

        // Admin: Reject document
        let documentRejectMatch = path.match(/^\/api\/admin\/documents\/([a-f0-9-]+)\/reject$/);
        if (documentRejectMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');

          const documentId = documentRejectMatch[1];
          let data = await body(req);
          const { notes } = data;

          check(notes, 400, 'Rejection reason is required');

          const document = await documents.rejectDocument(documentId, u.id, notes);

          return json(res, 200, { document });
        }

        // Delete document
        let documentDeleteMatch = path.match(/^\/api\/documents\/([a-f0-9-]+)$/);
        if (documentDeleteMatch && req.method === 'DELETE') {
          const documentId = documentDeleteMatch[1];
          const doc = await documents.getDocument(documentId);

          check(doc, 404, 'Document not found');
          check(doc.user_id === u.id || u.role === 'admin', 403, 'You do not have permission to delete this document');

          await documents.deleteDocument(documentId);

          return json(res, 200, { success: true, message: 'Document deleted successfully' });
        }

        // GPS: Record location
        if (path === '/api/gps/location' && req.method === 'POST') {
          check(u.role === 'driver', 403, 'Only drivers can record GPS locations');

          let data = await body(req);
          const { shipmentId, latitude, longitude, accuracy, speed, heading, altitude } = data;

          check(shipmentId && latitude != null && longitude != null, 400, 'Shipment ID, latitude, and longitude are required');

          // Verify driver is assigned to this shipment
          const shipment = await store.getShipment(shipmentId);
          check(shipment, 404, 'Shipment not found');
          check(shipment.driver_id === u.id, 403, 'You are not assigned to this shipment');
          check(['In transit', 'Assigned'].includes(shipment.status), 400, 'GPS tracking is only available for active shipments');

          const location = await gpsLocation.recordLocation({
            shipmentId,
            driverId: u.id,
            latitude,
            longitude,
            accuracy,
            speed,
            heading,
            altitude
          });

          // Broadcast GPS update via WebSocket
          broadcastGPSUpdate(shipmentId, location);

          return json(res, 201, { location });
        }

        // GPS: Get latest location for a shipment
        let gpsLatestMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/location$/);
        if (gpsLatestMatch && req.method === 'GET') {
          const shipmentId = gpsLatestMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(
            await store.hasStorePermission(u, shipment.store_id, 'shipments.read') || shipment.driver_id === u.id,
            403,
            'You do not have access to this shipment'
          );

          const location = await gpsLocation.getLatestLocation(shipmentId);

          return json(res, 200, { location });
        }

        // GPS: Get location history for a shipment
        let gpsHistoryMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/location\/history$/);
        if (gpsHistoryMatch && req.method === 'GET') {
          const shipmentId = gpsHistoryMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(
            await store.hasStorePermission(u, shipment.store_id, 'shipments.read') || shipment.driver_id === u.id,
            403,
            'You do not have access to this shipment'
          );

          const limit = parseInt(url.searchParams.get('limit')) || 100;
          const since = url.searchParams.get('since') || null;

          const history = await gpsLocation.getLocationHistory(shipmentId, { limit, since });

          return json(res, 200, { history });
        }

        // GPS: Calculate ETA
        if (path === '/api/maps/eta' && req.method === 'POST') {
          check(maps.isConfigured(), 503, 'Maps service is not configured. Contact administrator.');

          let data = await body(req);
          const { origin, destination } = data;

          check(origin && destination, 400, 'Origin and destination are required');

          const eta = await maps.calculateETA(origin, destination);

          return json(res, 200, eta);
        }

        // Maps: Get directions
        if (path === '/api/maps/directions' && req.method === 'POST') {
          check(maps.isConfigured(), 503, 'Maps service is not configured. Contact administrator.');

          let data = await body(req);
          const { origin, destination } = data;

          check(origin && destination, 400, 'Origin and destination are required');

          const directions = await maps.getDirections(origin, destination);

          return json(res, 200, directions);
        }

        // Maps: Geocode address
        if (path === '/api/maps/geocode' && req.method === 'POST') {
          check(maps.isConfigured(), 503, 'Maps service is not configured. Contact administrator.');

          let data = await body(req);
          const { address } = data;

          check(address, 400, 'Address is required');

          const coords = await maps.geocodeAddress(address);

          return json(res, 200, coords);
        }

        // Admin: Get all active shipment locations
        if (path === '/api/admin/gps/active' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');

          const activeLocations = await gpsLocation.getActiveShipmentLocations();

          return json(res, 200, { locations: activeLocations });
        }

        // Download the shipment invoice for an authorized participant.
        let invoiceMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/invoice$/);
        if (invoiceMatch && req.method === 'GET') {
          const shipment = await store.getShipment(invoiceMatch[1]);
          check(shipment, 404, 'Shipment not found');
          check(await store.hasStorePermission(u, shipment.store_id, 'billing.read') || shipment.driver_id === u.id, 403, 'You do not have billing access to this shipment');
          check(shipment.status === 'Delivered', 400, 'An invoice is available after delivery is complete');
          const customer = await pgQuery('SELECT id, name, email, profile FROM users WHERE id = $1', [shipment.store_id]);
          const driver = shipment.driver_id ? await pgQuery('SELECT id, name, email, profile FROM users WHERE id = $1', [shipment.driver_id]) : { rows: [] };
          const pdf = await generateInvoice(shipment, customer.rows[0], driver.rows[0] || null);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="invoice-${shipment.id}.pdf"`, 'Cache-Control': 'no-store' });
          return res.end(pdf);
        }

        // Payments: Create PaymentIntent for a shipment
        let paymentIntentMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/payment$/);
        if (path === '/api/payments/config' && req.method === 'GET') {
          return json(res, 200, { publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
        }
        if (paymentIntentMatch && req.method === 'POST') {
          check(stripePayments.isConfigured(), 503, 'Payment processing is not configured. Contact administrator.');

          const shipmentId = paymentIntentMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(await store.hasStorePermission(u, shipment.store_id, 'billing.read'), 403, 'You do not have billing access to this shipment');
          check(shipment.status === 'Delivered', 400, 'Payment can only be created after delivery is complete');
          if (shipment.payment_intent_id) {
            const existingIntent = await stripePayments.getPaymentIntent(shipment.payment_intent_id);
            check(existingIntent.status !== 'succeeded', 400, 'Payment has already succeeded');
            return json(res, 200, { paymentIntent: existingIntent });
          }

          const subtotal = Number(shipment.data.price);
          const tax = Math.round(subtotal * 0.05 * 100) / 100;
          const amount = Math.round((subtotal + tax) * 100) / 100;
          check(amount > 0, 400, 'Invalid shipment price');

          const paymentIntent = await stripePayments.createPaymentIntent(amount, 'cad', {
            shipmentId,
            storeId: shipment.store_id
          });

          // Update shipment with payment intent ID
          await pgQuery(
            'UPDATE shipments SET payment_intent_id = $1, payment_status = $2, payment_amount = $3 WHERE id = $4',
            [paymentIntent.paymentIntentId, 'processing', amount, shipmentId]
          );

          return json(res, 201, { paymentIntent });
        }

        // Payments: Get payment status for a shipment
        let paymentStatusMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/payment\/status$/);
        if (paymentStatusMatch && req.method === 'GET') {
          const shipmentId = paymentStatusMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(
            await store.hasStorePermission(u, shipment.store_id, 'billing.read') || shipment.driver_id === u.id,
            403,
            'You do not have access to this shipment'
          );

          return json(res, 200, {
            paymentStatus: shipment.payment_status,
            paymentAmount: shipment.payment_amount,
            paymentIntentId: shipment.payment_intent_id,
            ...(u.role === 'store' ? {} : { payoutStatus: shipment.payout_status, payoutAmount: shipment.payout_amount })
          });
        }

        // Stripe Connect: Start onboarding for driver
        if (path === '/api/payments/connect/onboard' && req.method === 'POST') {
          check(stripePayments.isConfigured(), 503, 'Payment processing is not configured. Contact administrator.');
          check(u.role === 'driver', 403, 'Only drivers can onboard to Stripe Connect');
          check(!u.stripe_onboarded, 400, 'You are already onboarded to Stripe Connect');

          let accountId = u.stripe_account_id;

          // Create Connect account if it doesn't exist
          if (!accountId) {
            accountId = await stripePayments.createConnectAccount(u.email, {
              userId: u.id,
              driverName: u.name
            });

            // Save account ID to user
            await pgQuery(
              'UPDATE users SET stripe_account_id = $1 WHERE id = $2',
              [accountId, u.id]
            );
          }

          // Create onboarding link
          const refreshUrl = `${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/profile`;
          const returnUrl = `${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/profile?stripe=success`;

          const onboardingUrl = await stripePayments.createAccountLink(accountId, refreshUrl, returnUrl);

          return json(res, 200, { onboardingUrl });
        }

        // Stripe Connect: Complete onboarding
        if (path === '/api/payments/connect/complete' && req.method === 'POST') {
          check(u.role === 'driver', 403, 'Only drivers can complete Stripe Connect onboarding');
          check(u.stripe_account_id, 400, 'No Stripe account found. Please start onboarding first.');

          // Mark user as onboarded
          await pgQuery(
            'UPDATE users SET stripe_onboarded = true WHERE id = $1',
            [u.id]
          );

          return json(res, 200, { success: true, message: 'Stripe Connect onboarding completed!' });
        }

        // Admin: Create payout for completed delivery
        let payoutMatch = path.match(/^\/api\/admin\/shipments\/(YYC-\d+)\/payout$/);
        if (payoutMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          check(stripePayments.isConfigured(), 503, 'Payment processing is not configured. Contact administrator.');

          const shipmentId = payoutMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(shipment.status === 'delivered', 400, 'Payout can only be created for delivered shipments');
          check(shipment.payment_status === 'succeeded', 400, 'Payment must be successful before creating payout');
          check(!shipment.payout_transfer_id, 400, 'Payout already exists for this shipment');
          check(shipment.driver_id, 400, 'No driver assigned to this shipment');
          const payoutInput = await body(req);

          // Get driver
          const driver = await pgQuery(
            'SELECT * FROM users WHERE id = $1',
            [shipment.driver_id]
          );
          const driverData = driver.rows[0];

          check(driverData.stripe_account_id && driverData.stripe_onboarded, 400, 'Driver has not completed Stripe Connect onboarding');

          const baseAmount = Number(shipment.data.rate || shipment.data.driverRate || shipment.data.price * 0.7);
          const adjustment = payoutInput.adjustment == null || payoutInput.adjustment === '' ? 0 : Number(payoutInput.adjustment);
          check(Number.isFinite(adjustment) && Math.abs(adjustment) <= baseAmount, 400, 'Payout adjustment cannot exceed the agreed driver rate.');
          const payoutAmount = Math.round((baseAmount + adjustment) * 100) / 100;
          const adjustmentReason = adjustment === 0 ? '' : String(payoutInput.adjustmentReason || '').trim();
          check(adjustment === 0 || (adjustmentReason.length > 0 && adjustmentReason.length <= 500), 400, 'Provide a reason for the payout adjustment.');
          check(payoutAmount > 0, 400, 'Invalid payout amount');
          check(payoutAmount <= Number(shipment.data.price), 400, 'Driver payout cannot exceed the shipment subtotal.');

          const transfer = await stripePayments.createPayout(driverData.stripe_account_id, payoutAmount, {
            shipmentId,
            driverId: shipment.driver_id,
            driverName: driverData.name
          });

          // Update shipment with payout info
          const payoutBreakdown = { baseAmount, adjustment, adjustmentReason, total: payoutAmount, currency: 'CAD', transferId: transfer.transferId, createdAt: new Date().toISOString() };
          const shipmentData = { ...shipment.data, payoutBreakdown };
          await pgQuery('UPDATE shipments SET payout_transfer_id=$1,payout_status=$2,payout_amount=$3,data=$4 WHERE id=$5', [transfer.transferId, 'paid', payoutAmount, JSON.stringify(shipmentData), shipmentId]);
          await pgQuery('INSERT INTO audit(shipment_id,actor_id,event) VALUES($1,$2,$3)', [shipmentId, u.id, `Driver payout issued: $${payoutAmount.toFixed(2)} CAD (base $${baseAmount.toFixed(2)}, adjustment $${adjustment.toFixed(2)})`]);

          return json(res, 201, { transfer, payoutAmount });
        }

        // MFA: Start enrollment
        if (path === '/api/mfa/enroll' && req.method === 'POST') {
          check(!u.mfa_enabled, 400, 'MFA is already enabled for your account');

          // Generate TOTP secret
          const { secret, uri } = mfa.generateTOTPSecret(u.email);

          // Generate QR code
          const qrCode = await mfa.generateQRCode(uri);

          // Store secret temporarily in Redis (10-minute expiry)
          await redis.setVerificationCode(`mfa_enrollment:${u.id}`, secret, 600);

          return json(res, 200, {
            qrCode,
            secret,
            message: 'Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.)'
          });
        }

        // MFA: Complete enrollment
        if (path === '/api/mfa/enroll/verify' && req.method === 'POST') {
          check(!u.mfa_enabled, 400, 'MFA is already enabled for your account');

          let data = await body(req);
          const { code } = data;

          check(code, 400, 'TOTP code is required');

          // Get temporary secret from Redis
          const secret = await redis.getVerificationCode(`mfa_enrollment:${u.id}`);
          check(secret, 400, 'Enrollment session expired. Please start enrollment again.');

          // Verify TOTP code
          const isValid = mfa.verifyTOTP(secret, code);
          check(isValid, 400, 'Invalid TOTP code. Please try again.');

          // Generate backup codes
          const backupCodes = mfa.generateBackupCodes(10);

          // Enable MFA
          await mfa.enrollMFA(u.id, secret, backupCodes);

          // Delete temporary secret
          await redis.deleteVerificationCode(`mfa_enrollment:${u.id}`);

          return json(res, 200, {
            success: true,
            backupCodes,
            message: 'MFA enabled successfully! Save your backup codes in a secure location.'
          });
        }

        // MFA: Disable
        if (path === '/api/mfa/disable' && req.method === 'POST') {
          check(u.mfa_enabled, 400, 'MFA is not enabled for your account');

          let data = await body(req);
          const { code, password } = data;

          check(code && password, 400, 'TOTP code and password are required');

          // Verify password
          const passwordValid = await store.verifyPassword(password, u.password_hash);
          check(passwordValid, 401, 'Invalid password');

          // Verify TOTP code or backup code
          const isValid = mfa.verifyTOTP(u.mfa_secret, code);
          const isBackupCode = !isValid && await mfa.verifyBackupCode(u.id, code);

          check(isValid || isBackupCode, 401, 'Invalid MFA code');

          // Disable MFA
          await mfa.disableMFA(u.id);

          return json(res, 200, { success: true, message: 'MFA disabled successfully' });
        }

        // MFA: Regenerate backup codes
        if (path === '/api/mfa/backup-codes/regenerate' && req.method === 'POST') {
          check(u.mfa_enabled, 400, 'MFA is not enabled for your account');

          let data = await body(req);
          const { code } = data;

          check(code, 400, 'TOTP code is required');

          // Verify TOTP code
          const isValid = mfa.verifyTOTP(u.mfa_secret, code);
          check(isValid, 401, 'Invalid TOTP code');

          // Regenerate backup codes
          const newBackupCodes = await mfa.regenerateBackupCodes(u.id, 10);

          return json(res, 200, {
            backupCodes: newBackupCodes,
            message: 'New backup codes generated. Save them in a secure location.'
          });
        }

        // MFA: Get status
        if (path === '/api/mfa/status' && req.method === 'GET') {
          const remainingBackupCodes = u.mfa_enabled ? await mfa.getRemainingBackupCodesCount(u.id) : 0;

          return json(res, 200, {
            mfaEnabled: u.mfa_enabled,
            remainingBackupCodes,
            mfaEnforced: u.role === 'admin' // Admins must have MFA
          });
        }

        // Notifications: Register device token
        if (path === '/api/notifications/inbox' && req.method === 'GET') {
          const result = await pgQuery('SELECT id, shipment_id, title, message, read_at, created_at FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [u.id]);
          return json(res, 200, { notifications: result.rows, unread: result.rows.filter(item => !item.read_at).length });
        }
        let notificationReadMatch = path.match(/^\/api\/notifications\/inbox\/([a-f0-9-]+)\/read$/);
        if (notificationReadMatch && req.method === 'POST') {
          await body(req);
          const result = await pgQuery('UPDATE user_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id', [notificationReadMatch[1], u.id]);
          check(result.rowCount === 1, 404, 'Notification not found.');
          return json(res, 200, { success: true });
        }
        if (path === '/api/notifications/inbox/read-all' && req.method === 'POST') {
          await body(req);
          await pgQuery('UPDATE user_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL', [u.id]);
          return json(res, 200, { success: true });
        }

        // Notifications: Register device token
        if (path === '/api/notifications/preferences' && req.method === 'GET') {
          const result = await pgQuery('SELECT notification_preferences FROM users WHERE id = $1', [u.id]);
          return json(res, 200, { preferences: result.rows[0]?.notification_preferences || { email: true, sms: false, push: true } });
        }
        if (path === '/api/notifications/preferences' && req.method === 'PATCH') {
          let data = await body(req);
          const preferences = { email: data.email === true, sms: data.sms === true, push: data.push === true };
          await pgQuery('UPDATE users SET notification_preferences = $1::jsonb WHERE id = $2', [JSON.stringify(preferences), u.id]);
          return json(res, 200, { preferences });
        }

        // Notifications: Register device token
        if (path === '/api/notifications/register' && req.method === 'POST') {
          let data = await body(req);
          const { token, platform, deviceInfo } = data;

          check(token && platform, 400, 'Token and platform are required');
          check(['ios', 'android', 'web'].includes(platform), 400, 'Invalid platform. Must be ios, android, or web');

          await notifications.registerToken(u.id, token, platform, deviceInfo || {});

          return json(res, 200, { success: true, message: 'Notification token registered' });
        }

        // Notifications: Unregister device token
        if (path === '/api/notifications/unregister' && req.method === 'POST') {
          let data = await body(req);
          const { token } = data;

          check(token, 400, 'Token is required');

          await notifications.unregisterToken(u.id, token);

          return json(res, 200, { success: true, message: 'Notification token unregistered' });
        }

        // Notifications: Get registered tokens
        if (path === '/api/notifications/tokens' && req.method === 'GET') {
          const tokens = await notifications.getUserTokens(u.id);

          return json(res, 200, { tokens });
        }

        // Admin: Send test notification
        if (path === '/api/admin/notifications/test' && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');

          let data = await body(req);
          const { userId, title, body: notifBody } = data;

          check(userId && title && notifBody, 400, 'userId, title, and body are required');

          const result = await notifications.sendToUser(userId, {
            title,
            body: notifBody
          }, {
            type: 'test',
            sentBy: u.name
          });

          return json(res, 200, { result });
        }

        throw new AppError(404, 'API endpoint not found.');
      }

      // Static file serving
      check(['GET', 'HEAD'].includes(req.method), 405, 'Method not allowed.');

      let filePath;
      try {
        let decoded = decodeURIComponent(path);
        check(!decoded.includes('\0') && !decoded.includes('\\'), 404, 'Not found.');
        filePath = resolve(
          publicDir,
          '.' + (
            decoded === '/' ? '/index.html' :
            decoded === '/demo' || decoded === '/demo/' ? '/demo/index.html' :
            decoded
          )
        );
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(404, 'Not found.');
      }

      check(filePath.startsWith(publicDir + sep), 404, 'Not found.');

      let types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.jpg': 'image/jpeg',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };

      check(types[extname(filePath)], 404, 'Not found.');

      let content;
      try {
        check((await stat(filePath)).isFile(), 404, 'Not found.');
        content = await readFile(filePath);
      } catch {
        throw new AppError(404, 'Not found.');
      }

      res.writeHead(200, {
        'Content-Type': types[extname(filePath)],
        'Cache-Control': 'no-cache'
      });
      res.end(req.method === 'HEAD' ? undefined : content);

    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }

      let status = e instanceof AppError ? e.status : 500;
      if (status === 500) {
        console.error('YYC request failed:', e);
      }
      json(res, status, {
        error: status === 500 ? 'An unexpected server error occurred.' : e.message
      });
    }
  });

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;

  // Initialize WebSocket server
  let io = null;
  initializeWebSocket(server, { secure, publicOrigin })
    .then(socketServer => {
      io = socketServer;
      console.log('[Server] WebSocket initialized');
    })
    .catch(err => {
      console.error('[Server] Failed to initialize WebSocket:', err);
    });

  return { server, io };
}

// Server startup
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => {
    let i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };

  let port = Number(option('--port') || process.env.PORT || 3000);
  let host = option('--host') || process.env.HOST || '127.0.0.1';

  check(Number.isInteger(port) && port > 0 && port < 65536, 400, 'PORT must be between 1 and 65535.');

  // Initialize database schema
  console.log('Initializing database...');
  store.initStore().then(async () => {
    const { server } = createApp();

    server.on('error', err => {
      console.error(
        err.code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Try PORT=3001 npm start.`
          : 'Server could not start: ' + err.code
      );
      process.exitCode = 1;
    });

    server.listen(port, host, () => {
      console.log(`YYC Brokers running at http://${host}:${port}`);
      console.log('Database: PostgreSQL');
      console.log('Sessions: Redis');
      console.log('Create a broker account with: npm run setup-admin');
      console.log('Maps, GPS, email and file uploads are not connected.');
    });

    let stopping = false;
    for (let sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, async () => {
        if (stopping) return;
        stopping = true;
        console.log('\nShutting down gracefully...');
        server.close(async () => {
          const { close: closePg } = await import('./db/postgres.js');
          const { close: closeRedis } = await import('./redis.js');
          await closePg();
          await closeRedis();
          console.log('Server stopped');
          process.exit(0);
        });
        setTimeout(() => process.exit(1), 5000).unref();
      });
    }
  }).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
}
