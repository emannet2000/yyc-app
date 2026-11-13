// Initialize Sentry first for error tracking
import { initSentry, captureException, setUser, clearUser } from './monitoring/sentry.js';
initSentry();

import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import * as store from './store.js';
import * as redis from './redis.js';
import { healthCheck as redisHealthCheck } from './redis.js';
import { authRateLimiter } from './middleware/ratelimit.js';
import { query as pgQuery, transaction as pgTransaction } from './db/postgres.js';
import * as emailClient from './email/client.js';
import * as documents from './storage/documents.js';
import { isConfigured as isS3Configured } from './storage/s3.js';
import { verifyConnection as verifyS3Connection } from './storage/s3.js';
import * as gpsLocation from './gps/location.js';
import * as maps from './maps/directions.js';
import * as stripePayments from './payments/stripe.js';
import { billingTotals, creditRefundAmount } from './invoices/billing.js';
import { initializeWebSocket, broadcastShipmentUpdate, broadcastGPSUpdate, broadcastPaymentUpdate, broadcastToAdmins, broadcastToDrivers, emitToUsers, disconnectUser, disconnectSession } from './websocket/server.js';
import * as mfa from './auth/mfa.js';
import * as notifications from './notifications/manager.js';
import { generateInvoice } from './invoices/generator.js';

const { AppError, check } = store;
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');


const adminMfaRequired = u => u.role === 'admin' && !u.mfa_enabled && process.env.ADMIN_MFA_OPTIONAL !== 'true';

/* Accept each authenticator code once: a captured code cannot be replayed within its window. */
async function verifyTotpOnce(userId, secret, code) {
  // Authenticator apps show codes as "123 456"; accept them typed that way.
  const step = mfa.verifyTOTP(secret, String(code ?? '').replace(/\s+/g, ''));
  if (!step) return false;
  return (await redis.redis.set(`mfa_used:${userId}:${step}`, '1', 'EX', 150, 'NX')) === 'OK';
}

const money = value => value == null || value === '' ? '' : `$${Number(value).toFixed(2)}`;
// Remove customer-side money from audit text, e.g. " ($45.00 credit)".
const withoutAmounts = text => String(text).replace(/\s*\(\$[\d,]+(?:\.\d{2})? credit\)/g, '').replace(/\$[\d,]+(?:\.\d{2})?/g, 'an amount');
const STORE_SILENT_ACTIONS = new Set(['bid', 'withdrawBid', 'assignIssue']);

/* Work out who hears about a shipment action and what each of them is told.
   Recipients come from the state before AND after the action, so a driver who was
   just removed is still told. Each message only contains what that role may see. */
async function notifyShipmentAction(actor, action, before, after) {
  const id = after.id, data = after.data || {}, previous = before || {};
  const lastEvent = after.events?.at?.(-1) || `Status: ${after.status}`;
  const recipients = new Map();
  const add = (userId, kind) => { if (userId && userId !== actor.id && !recipients.has(userId)) recipients.set(userId, kind); };

  if (!STORE_SILENT_ACTIONS.has(action)) for (const userId of await store.storeAudience(after.store_id)) add(userId, 'store');
  if (!['bid', 'withdrawBid'].includes(action)) {
    for (const userId of [after.offered_to, after.driver_id]) add(userId, 'driver');
    for (const userId of [previous.offered_to, previous.driver_id]) add(userId, 'former-driver');
  }
  // Brokers see bids live on the dispatch board; a notification per bid is just noise.
  // Routine progress (bids, arrivals, stop completions) shows live on the board; notifying every
  // broker for each one is noise.
  const BROKER_SILENT_ACTIONS = ['bid', 'withdrawBid', 'arrival', 'arriveStop', 'completeStop'];
  if (actor.role !== 'admin' && !BROKER_SILENT_ACTIONS.includes(action)) for (const userId of await store.activeBrokerIds()) add(userId, 'broker');

  for (const [recipientId, kind] of recipients) {
    try {
      // Default to the audit event itself, so a new date or a resolution is spelled out.
      let message = lastEvent;
      if (kind === 'broker') message = lastEvent;
      else if (kind === 'former-driver') message = after.driver_id === recipientId || after.offered_to === recipientId ? lastEvent : `You are no longer assigned to this delivery (${lastEvent}).`;
      else if (kind === 'driver' && after.status === 'Offered' && after.offered_to === recipientId) message = `New job offer: ${data.pickup} → ${data.destination} on ${data.date} (${data.window}) · ${money(data.rate)} driver rate. Respond before the offer expires.`;
      else if (kind === 'driver' && after.status === 'Assigned' && previous.status !== 'Assigned') message = `You are assigned: pickup ${data.date} (${data.window}) at ${data.pickup}.`;
      else if (kind === 'store') {
        const canSeePrice = await store.hasStorePermission({ id: recipientId, role: 'store' }, after.store_id, 'billing.read');
        if (after.status === 'Quote ready' && previous.status !== 'Quote ready' || action === 'reviseQuote') message = `Quotation ready for ${data.destination}${canSeePrice ? ': ' + money(data.price) : ''}. Review and accept it before it expires.`;
        else if (after.status === 'Delivered' && previous.status !== 'Delivered') message = `Delivered to ${data.destination}${data.recipient ? ', received by ' + data.recipient : ''}.${data.deliveryOutcome === 'partial_or_damaged' ? ' Shortage, damage or refusal was recorded.' : ''}`;
        else if (after.status === 'In transit' && previous.status !== 'In transit') message = `Picked up and on the way to ${data.destination}.`;
        else message = lastEvent;
      }
      // Audit text can carry customer-side amounts (credits): drivers never see them, store members
      // only with billing access. Messages written for a role (e.g. a driver's offer rate) are kept.
      const fromAudit = message.includes(lastEvent);
      if (fromAudit && (kind === 'driver' || kind === 'former-driver')) message = withoutAmounts(message);
      else if (fromAudit && kind === 'store' && !(await store.hasStorePermission({ id: recipientId, role: 'store' }, after.store_id, 'billing.read'))) message = withoutAmounts(message);
      const slaMessage = data.pickupSlaMet === false && action === 'pickup' ? 'Pickup target missed. ' : data.deliverySlaMet === false && action === 'deliver' ? 'Delivery target missed. ' : '';
      const title = kind === 'driver' && after.status === 'Offered' ? `Job offer ${id}` : `Delivery ${id} updated`;
      await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [recipientId, id, title, slaMessage + message]);
      const recipient = await pgQuery('SELECT profile FROM users WHERE id = $1', [recipientId]);
      await notifications.notifyShipmentUpdate(recipientId, recipient.rows[0]?.profile?.phone || '', id, slaMessage + message);
    } catch (error) { console.warn('[Notifications] Shipment update could not be delivered:', error.message); }
  }
}

/* Refund claim credits granted after the store already paid (credit plus its GST). */
async function refundPendingCredits(shipmentId) {
  const record = await store.getShipment(shipmentId);
  const credits = record?.data?.credits || [];
  if (!credits.some(c => c.refund === 'pending')) return;
  if (record.data.paymentWaived) {
    // Nothing was charged on a waived shipment, so there is nothing to refund.
    const cleared = credits.map(c => c.refund === 'pending' ? { ...c, refund: 'not_needed' } : c);
    await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('credits', $1::jsonb), version = version + 1, updated_at = NOW() WHERE id = $2", [JSON.stringify(cleared), shipmentId]);
    return;
  }
  if (!record.payment_intent_id || !stripePayments.isConfigured()) {
    console.warn(`[Claims] Credit on ${shipmentId} needs a manual refund: Stripe is not configured.`);
    return;
  }
  for (let index = 0; index < credits.length; index++) {
    if (credits[index].refund !== 'pending') continue;
    try {
      const refund = await stripePayments.refundPayment(record.payment_intent_id, creditRefundAmount(credits[index].amount), `yyc-claim-credit-${shipmentId}-${index}`, { shipmentId });
      credits[index] = { ...credits[index], refund: 'refunded', refundId: refund.refundId, refundAmount: refund.amount };
      await notifyStoreBilling(shipmentId, `Refund issued for ${shipmentId}`, `YYC refunded $${refund.amount.toFixed(2)} CAD (claim credit plus GST) to your card for ${shipmentId}.`);
    } catch (error) {
      credits[index] = { ...credits[index], refund: 'failed', refundError: String(error.message).slice(0, 200) };
      console.warn(`[Claims] Credit refund failed for ${shipmentId}:`, error.message);
    }
  }
  await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('credits', $1::jsonb), version = version + 1, updated_at = NOW() WHERE id = $2", [JSON.stringify(credits), shipmentId]);
  await pushShipmentChange(shipmentId);
}

/* Stripe cannot charge less than $0.50 CAD. When credits (or a tiny price) leave less than that
   owing on a delivered shipment, mark it settled so the driver payout and account closure can
   proceed, and record the waived amount. */
const STRIPE_MINIMUM_CAD = 0.5;
async function settleIfNothingToCharge(shipmentId, actorId = null) {
  const record = await store.getShipment(shipmentId);
  if (!record || record.status !== 'Delivered' || !['pending', 'failed'].includes(record.payment_status || 'pending')) return false;
  if (record.data.claim?.status === 'open') return false;
  const { total } = billingTotals(record.data);
  if (total >= STRIPE_MINIMUM_CAD) return false;
  if (record.payment_intent_id && stripePayments.isConfigured()) {
    try {
      const intent = await stripePayments.getPaymentIntent(record.payment_intent_id);
      if (!['succeeded', 'processing', 'canceled'].includes(intent.status)) await stripePayments.cancelPaymentIntent(intent.id);
      else if (intent.status !== 'canceled') return false;
    } catch (error) { console.warn(`[Payments] Could not cancel intent for ${shipmentId}:`, error.message); return false; }
  }
  const waiver = JSON.stringify({ amount: total, reason: total === 0 ? 'fully credited' : 'below the card minimum', at: new Date().toISOString() });
  const updated = await pgQuery(
    "UPDATE shipments SET payment_status = 'succeeded', payment_amount = 0, data = data || jsonb_build_object('paymentWaived', $1::jsonb), version = version + 1, updated_at = NOW() WHERE id = $2 AND payment_status IN ('pending', 'failed') RETURNING id",
    [waiver, shipmentId]
  );
  if (!updated.rowCount) return false;
  await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES($1, $2, $3)', [shipmentId, actorId, total === 0 ? 'Nothing left to charge after credits; marked settled' : `Remaining $${total.toFixed(2)} is below the card minimum; waived and marked settled`]);
  await notifyStoreBilling(shipmentId, `Nothing to pay for ${shipmentId}`, total === 0 ? `Credits cover the full amount for ${shipmentId}; there is nothing to pay.` : `The remaining $${total.toFixed(2)} on ${shipmentId} is below the card minimum and has been waived.`);
  await pushShipmentChange(shipmentId);
  return true;
}

/* Pay drivers who handed a load off mid-delivery their recorded share. */
async function payHandoffShares(shipmentId, actorId) {
  const record = await store.getShipment(shipmentId);
  const handoffs = record?.data?.handoffs || [];
  const results = [];
  for (let index = 0; index < handoffs.length; index++) {
    const handoff = handoffs[index];
    if (!['due', 'failed'].includes(handoff.payout) || !(handoff.payAmount > 0)) continue;
    try {
      const driver = (await pgQuery('SELECT name, stripe_account_id, stripe_onboarded FROM users WHERE id = $1', [handoff.driverId])).rows[0];
      if (!driver?.stripe_account_id || !driver.stripe_onboarded) throw new Error('driver has not completed Stripe Connect onboarding');
      const transfer = await stripePayments.createPayout(driver.stripe_account_id, handoff.payAmount, { shipmentId, driverId: handoff.driverId, handoffIndex: String(index), idempotencyKey: `yyc-handoff-payout-${shipmentId}-${index}` });
      handoffs[index] = { ...handoff, payout: 'paid', transferId: transfer.transferId, paidAt: new Date().toISOString() };
      await pgQuery('INSERT INTO audit(shipment_id,actor_id,event) VALUES($1,$2,$3)', [shipmentId, actorId, `Hand-off share paid to ${driver.name}: $${handoff.payAmount.toFixed(2)} CAD`]);
      await notifyShipmentInbox(handoff.driverId, shipmentId, `Payout sent for ${shipmentId}`, `YYC sent you $${handoff.payAmount.toFixed(2)} CAD for your leg of ${shipmentId} before the hand-off.`);
      results.push({ index, status: 'paid' });
    } catch (error) {
      handoffs[index] = { ...handoff, payout: 'failed', payoutError: String(error.message).slice(0, 200) };
      results.push({ index, status: 'failed', error: handoffs[index].payoutError });
    }
  }
  if (results.length) {
    await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('handoffs', $1::jsonb), version = version + 1, updated_at = NOW() WHERE id = $2", [JSON.stringify(handoffs), shipmentId]);
    await pushShipmentChange(shipmentId);
  }
  return results;
}

/* Refund reconciliation: whatever the store paid, minus everything already refunded, minus
   what it owes now (after credits) is refunded. Runs after a payment succeeds and after every
   claim decision, so a credit is never missed whatever order those happen in. Credits saved as
   "not needed" (granted before payment) are marked as covered by the refund. */
async function reconcileRefunds(shipmentId, paymentIntent = null) {
  const record = await store.getShipment(shipmentId);
  if (!record || record.payment_status !== 'succeeded' || !record.payment_intent_id || record.data.paymentWaived) return;
  const cents = value => Math.round(Number(value || 0) * 100);
  const receivedCents = paymentIntent ? (paymentIntent.amount_received ?? paymentIntent.amount) : cents(record.payment_amount);
  const refunds = [...(record.data.overpaymentRefunds || []), ...(record.data.overpaymentRefund && !record.data.overpaymentRefund.status ? [record.data.overpaymentRefund] : [])];
  const seen = new Set();
  const refundedCents = refunds.filter(r => !r.status && r.refundId && !seen.has(r.refundId) && seen.add(r.refundId)).reduce((sum, r) => sum + cents(r.amount), 0)
    + (record.data.credits || []).filter(c => c.refund === 'refunded' && c.refundAmount != null).reduce((sum, c) => sum + cents(c.refundAmount), 0);
  const excessCents = receivedCents - refundedCents - cents(billingTotals(record.data).total);
  if (excessCents < 1) return;
  const excess = excessCents / 100;
  let entry;
  try {
    // Same refunded-so-far total gives the same key, so concurrent runs share one refund.
    const refund = await stripePayments.refundPayment(record.payment_intent_id, excess, `yyc-reconcile-${shipmentId}-${refundedCents}`, { shipmentId, reason: 'amount paid above what is owed after credits' });
    entry = { amount: excess, refundId: refund.refundId, at: new Date().toISOString() };
  } catch (error) {
    entry = { amount: excess, status: 'failed', error: String(error.message).slice(0, 200), at: new Date().toISOString() };
    console.warn(`[Stripe] Refund reconciliation failed for ${shipmentId}:`, error.message);
  }
  const fresh = await store.getShipment(shipmentId);
  const entries = [...(fresh.data.overpaymentRefunds || []).filter(r => !(entry.refundId && r.refundId === entry.refundId)), entry];
  const credits = (fresh.data.credits || []).map(c => c.refund === 'not_needed' && !entry.status ? { ...c, refund: 'refunded', refundId: entry.refundId, coveredByReconciliation: true } : c);
  await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('overpaymentRefunds', $1::jsonb, 'credits', $2::jsonb), version = version + 1, updated_at = NOW() WHERE id = $3", [JSON.stringify(entries), JSON.stringify(credits), shipmentId]);
  await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES($1, NULL, $2)', [shipmentId, entry.status ? `Refund of $${excess.toFixed(2)} failed; refund it manually in Stripe` : `Refunded $${excess.toFixed(2)} paid above the amount owed after credits`]);
  if (!entry.status) await notifyStoreBilling(shipmentId, `Refund issued for ${shipmentId}`, `You paid $${excess.toFixed(2)} CAD more than owed after credits on ${shipmentId}; it has been refunded to your card.`);
  if (entry.status) for (const brokerId of await store.activeBrokerIds()) {
    await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [brokerId, shipmentId, `Refund needed for ${shipmentId}`, `The store paid $${excess.toFixed(2)} more than owed after credits and the automatic refund failed.`]).catch(() => {});
  }
  await pushShipmentChange(shipmentId);
}

/* Tell the store (and brokers) that a request's pickup day passed before dispatch. */
async function notifyPickupDatePassed(shipmentId) {
  const record = await store.getShipment(shipmentId);
  if (!record) return;
  const storeMessage = `The pickup date ${record.data.date} for ${record.data.destination} has passed. Request a new delivery time so YYC can continue.`;
  const brokerMessage = `Pickup date ${record.data.date} passed before dispatch (${record.status}). Waiting for the store to choose a new date.`;
  const audiences = [...(await store.storeAudience(record.store_id)).map(id => [id, storeMessage]), ...(await store.activeBrokerIds()).map(id => [id, brokerMessage])];
  for (const [recipientId, message] of audiences) {
    try {
      await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [recipientId, shipmentId, `New date needed for ${shipmentId}`, message]);
      const account = await pgQuery('SELECT profile FROM users WHERE id = $1', [recipientId]);
      await notifications.notifyShipmentUpdate(recipientId, account.rows[0]?.profile?.phone || '', shipmentId, message);
    } catch (error) { console.warn('[Notifications] Pickup-date notice failed:', error.message); }
  }
}

/* Store owner and team members allowed to see money amounts. */
async function storeBillingAudience(storeId) {
  const audience = [];
  for (const id of await store.storeAudience(storeId)) if (await store.hasStorePermission({ id, role: 'store' }, storeId, 'billing.read')) audience.push(id);
  return audience;
}

async function notifyStoreBilling(shipmentId, title, message) {
  const record = await store.getShipment(shipmentId);
  if (!record) return;
  for (const id of await storeBillingAudience(record.store_id)) await notifyShipmentInbox(id, shipmentId, title, message);
}

/* Inbox entry plus the user's chosen channels, for account-level events. */
async function notifyAccountInbox(userId, title, message, options = {}) {
  try {
    await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, NULL, $2, $3)', [userId, title, message]);
    await notifications.notifyAccount(userId, title, message, options);
  } catch (error) { console.warn('[Notifications] Account notice failed:', error.message); }
}

/* Inbox entry plus channels, tied to a shipment. */
async function notifyShipmentInbox(userId, shipmentId, title, message) {
  try {
    await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [userId, shipmentId, title, message]);
    await notifications.notifyAccount(userId, title, message);
  } catch (error) { console.warn('[Notifications] Shipment notice failed:', error.message); }
}

/* A driver lost approval (document expired, rejected or deleted): tell them and the brokers. */
async function announceRevocation(driverId, reason, released) {
  if (!released) return;
  for (const shipmentId of released) await pushShipmentChange(shipmentId);
  await notifyAccountInbox(driverId, 'Dispatch approval paused', `Your dispatch approval is paused because your ${reason}. Upload a current document so YYC can approve you again.${released.length ? ` ${released.length} job(s) you had not picked up went back to dispatch.` : ''}`);
  const driver = (await pgQuery('SELECT name FROM users WHERE id = $1', [driverId])).rows[0];
  for (const brokerId of await store.activeBrokerIds()) {
    await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, NULL, $2, $3)', [brokerId, `Driver approval paused: ${driver?.name || driverId}`, `${driver?.name || 'A driver'} lost dispatch approval (${reason}).${released.length ? ` ${released.length} job(s) returned to dispatch.` : ''}`]).catch(() => {});
  }
}

/* Remind drivers 30 and 7 days before an approved document expires (once per threshold). */
async function sendExpiryReminders() {
  for (const days of [30, 7]) {
    const due = await pgQuery(
      `SELECT id, user_id, type, filename, expiry_date FROM documents
       WHERE status = 'approved' AND expiry_date IS NOT NULL AND expiry_date > (NOW() AT TIME ZONE 'America/Edmonton')::date AND expiry_date <= (NOW() AT TIME ZONE 'America/Edmonton')::date + $1::int
         AND NOT EXISTS (SELECT 1 FROM documents newer WHERE newer.user_id = documents.user_id AND newer.type = documents.type
           AND newer.id <> documents.id AND newer.status IN ('approved', 'pending')
           AND (newer.expiry_date IS NULL OR newer.expiry_date > documents.expiry_date))`, [days]);
    for (const doc of due.rows) {
      const fresh = await redis.redis.set(`doc_reminder:${doc.id}:${days}`, '1', 'EX', 40 * 86400, 'NX').catch(() => null);
      if (fresh !== 'OK') continue;
      const expires = new Date(doc.expiry_date).toISOString().slice(0, 10);
      await notifyAccountInbox(doc.user_id, `Your ${doc.type} expires ${expires}`, `Your ${doc.type} (${doc.filename}) expires on ${expires}. Upload the renewed document before then to keep receiving jobs.`);
    }
  }
}

/* Push live refreshes for shipments changed outside a normal action (payments, releases). */
async function pushShipmentChange(shipmentId) {
  const record = await store.getShipment(shipmentId);
  if (!record) return;
  await broadcastShipmentUpdate(shipmentId, { version: record.version, status: record.status });
  if (record.status === 'Ready to assign') broadcastToDrivers('shipment:market', {});
}

// Browsers PUT documents straight to S3 with presigned URLs, so the CSP must allow that host.
const s3UploadOrigin = process.env.AWS_S3_ENDPOINT ? new URL(process.env.AWS_S3_ENDPOINT).origin : 'https://*.amazonaws.com';

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

  function setCookie(res, token, maxAge = 7 * 24 * 3600) {
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
  async function rateLimit(req, account = null) {
    await new Promise((resolve, reject) => {
      authRateLimiter(req, { setHeader: () => {} }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    // Per-account limit: stops guessing spread across many addresses, and keeps one busy
    // shared address (office NAT, proxy) from locking out everyone else.
    if (account) {
      try {
        const { allowed } = await redis.checkRateLimit(`ratelimit:account:${account}`, 10, 900);
        check(allowed, 429, 'Too many attempts for this account. Try again in 15 minutes.');
      } catch (error) {
        if (error instanceof AppError) throw error;
        console.error('Account rate limit check failed:', error.message);
      }
    }
  }
  const accountKey = value => { try { return store.email(value); } catch { return null; } };

  const server = http.createServer(async (req, res) => {
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://js.stripe.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https://*.tile.openstreetmap.org https://*.stripe.com; connect-src 'self' ws: wss: https://api.stripe.com ${s3UploadOrigin}; frame-src https://www.google.com https://maps.google.com https://js.stripe.com https://hooks.stripe.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://js.stripe.com https://hooks.stripe.com`);
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
          const registration = await body(req);
          await rateLimit(req, accountKey(registration.email));
          let u = await store.createUser(registration);

          // Send verification email for non-admin users. The account already exists, so a mail
          // failure must not look like a failed signup; the user can request a new code.
          let emailSent = true;
          if (u.role !== 'admin') {
            try {
              const code = crypto.randomInt(100000, 1000000).toString();
              await redis.setVerificationCode(u.email, code);
              await emailClient.sendVerificationEmail(u.email, code, u.name);
            } catch (error) {
              emailSent = false;
              console.error('[Register] Verification email failed:', error.message);
            }
          }

          return json(res, 201, {
            user: u,
            emailSent,
            message: !emailSent
              ? 'Account created, but the verification email could not be sent. Use "Send a new code" on the verification screen.'
              : u.role === 'driver'
              ? 'Registration saved. Check your email for a verification code. YYC approval is also required.'
              : 'Store account created. Check your email for a verification code to activate your account.'
          });
        }

        // Login endpoint (with rate limiting)
        if (path === '/api/login' && req.method === 'POST') {
          let data = await body(req);
          await rateLimit(req);
          // Only failed attempts count against the account, so normal sign-ins never lock it.
          const loginAccount = accountKey(data.email);
          const failureKey = loginAccount && `login_failures:${loginAccount}`;
          if (failureKey) check(Number(await redis.redis.get(failureKey).catch(() => 0) || 0) < 10, 429, 'Too many failed sign-in attempts for this account. Use "Forgot password?" to reset it now, or try again in 15 minutes.');
          const recordFailure = async () => { if (failureKey) await redis.checkRateLimit(failureKey, 10, 900).catch(() => {}); };
          let u;
          try { u = await store.login(data.email, data.password); }
          catch (error) { if (error instanceof AppError && error.status === 401) await recordFailure(); throw error; }

          // Check email verification (except for admin accounts)
          if (u.role !== 'admin' && !u.email_verified) {
            return json(res, 403, { error: 'Please verify your email address before logging in. Check your inbox for the verification code.' });
          }

          // Check if MFA is enabled
          if (u.mfa_enabled) {
            // If MFA code is provided, verify it
            if (data.mfaCode) {
              const isValid = await verifyTotpOnce(u.id, u.mfa_secret, data.mfaCode);
              const isBackupCode = !isValid && await mfa.verifyBackupCode(u.id, data.mfaCode);

              if (!isValid && !isBackupCode) {
                await recordFailure();
                return json(res, 401, { error: 'Invalid MFA code' });
              }

              // MFA verified, create session
              if (failureKey) await redis.resetRateLimit(failureKey).catch(() => {});
              let s = await store.createSession(u.id);
              setCookie(res, s.token);
              return json(res, 200, { user: await store.publicUser(u), csrf: s.csrf });
            } else {
              // MFA required but not provided
              return json(res, 200, { mfaRequired: true, userId: u.id });
            }
          }

          // No MFA, create session normally
          if (failureKey) await redis.resetRateLimit(failureKey).catch(() => {});
          let s = await store.createSession(u.id);
          setCookie(res, s.token);
          return json(res, 200, { user: await store.publicUser(u), csrf: s.csrf });
        }

        // Verify Email endpoint
        if (path === '/api/verify-email' && req.method === 'POST') {
          let data = await body(req);
          check(data.email && data.code, 400, 'Email and verification code are required');
          const email = store.email(data.email), code = String(data.code).replace(/\s+/g, '');
          await rateLimit(req, email);

          // Verify code from Redis; five wrong guesses burn the code.
          const storedCode = await redis.getVerificationCode(email);
          if (storedCode && storedCode !== code.toString()) {
            const { current } = await redis.checkRateLimit(`verify_attempts:${email}`, 5, 900);
            if (current >= 5) {
              await redis.deleteVerificationCode(email);
              throw new AppError(400, 'Too many wrong codes. Request a new verification code.');
            }
          }
          check(storedCode && storedCode === code.toString(), 400, 'Invalid or expired verification code');
          await redis.resetRateLimit(`verify_attempts:${email}`);

          // Mark email as verified
          await store.verifyEmail(email);

          // Delete used code
          await redis.deleteVerificationCode(email);

          return json(res, 200, { success: true, message: 'Email verified successfully! You can now log in.' });
        }

        // Resend Verification Code endpoint
        if (path === '/api/resend-code' && req.method === 'POST') {
          let data = await body(req);
          check(data.email, 400, 'Email is required');
          const email = store.email(data.email);
          await rateLimit(req, email);
          await redis.resetRateLimit(`verify_attempts:${email}`);

          // Same response whether or not the account exists, to prevent email enumeration.
          const user = await store.getUserByEmail(email);
          if (user && !user.email_verified && !user.disabled) {
            const code = crypto.randomInt(100000, 1000000).toString();
            await redis.setVerificationCode(email, code);
            await emailClient.sendVerificationEmail(email, code, user.name);
          }

          return json(res, 200, { success: true, message: 'If that account still needs verification, a new code has been sent.' });
        }

        // Request Password Reset endpoint
        if (path === '/api/request-reset' && req.method === 'POST') {
          let data = await body(req);
          check(data.email, 400, 'Email is required');
          const email = store.email(data.email);
          await rateLimit(req, email);

          // Get user
          const user = await store.getUserByEmail(email);

          // Always return success to prevent email enumeration
          if (user && !user.disabled) {
            // Generate secure reset token (stored as reset_token:<token> -> email)
            const token = crypto.randomBytes(32).toString('hex');
            await redis.setResetToken(token, user.email);

            // Send reset email
            await emailClient.sendPasswordResetEmail(user.email, token, user.name);
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

          // Delete used token and sign the account out everywhere
          await redis.deleteResetToken(token);
          const resetUser = await store.getUserByEmail(email);
          if (resetUser) { await redis.revokeUserSessions(resetUser.id); disconnectUser(resetUser.id); }
          // A successful reset proves ownership, so lift any failed-login lock.
          await redis.resetRateLimit(`login_failures:${store.email(email)}`).catch(() => {});

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

                if (shipmentId) {
                  // Only the PaymentIntent recorded on the shipment can mark it paid.
                  const updated = await pgQuery(
                    "UPDATE shipments SET payment_status = 'succeeded', version = version + 1, updated_at = NOW() WHERE id = $1 AND payment_intent_id = $2 AND payment_status IS DISTINCT FROM 'succeeded' RETURNING store_id",
                    [shipmentId, paymentIntent.id]
                  );
                  // No row: a repeat delivery of this event, or not the shipment's recorded intent.
                  if (!updated.rowCount) { console.log(`[Stripe] Skipped payment event ${event.id} for ${shipmentId} (already recorded or not the current intent)`); break; }
                  console.log(`[Stripe] Payment succeeded for shipment ${shipmentId}`);
                  await reconcileRefunds(shipmentId, paymentIntent);
                  broadcastPaymentUpdate(shipmentId, { status: 'succeeded' });
                  await pushShipmentChange(shipmentId);

                  for (const recipientId of await store.storeAudience(updated.rows[0].store_id)) {
                    try {
                      await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [recipientId, shipmentId, `Payment received for ${shipmentId}`, 'Your card payment was successful. Thank you.']);
                      const account = await pgQuery('SELECT profile FROM users WHERE id = $1', [recipientId]);
                      await notifications.notifyShipmentUpdate(recipientId, account.rows[0]?.profile?.phone || '', shipmentId, 'Your card payment was successful. Thank you.');
                    } catch (error) { console.warn('[Notifications] Payment notice failed:', error.message); }
                  }
                }
                break;
              }

              case 'payment_intent.processing':
              case 'payment_intent.payment_failed': {
                const paymentIntent = event.data.object;
                const shipmentId = paymentIntent.metadata.shipmentId;
                const nextStatus = event.type === 'payment_intent.processing' ? 'processing' : 'failed';

                if (shipmentId) {
                  // Events can arrive out of order: never downgrade a payment that already succeeded.
                  const updated = await pgQuery(
                    "UPDATE shipments SET payment_status = $1, version = version + 1, updated_at = NOW() WHERE id = $2 AND payment_intent_id = $3 AND payment_status NOT IN ('succeeded', 'refunded') RETURNING id",
                    [nextStatus, shipmentId, paymentIntent.id]
                  );
                  if (updated.rowCount) {
                    console.log(`[Stripe] Payment ${nextStatus} for shipment ${shipmentId}`);
                    broadcastPaymentUpdate(shipmentId, { status: nextStatus });
                    await pushShipmentChange(shipmentId);
                  }
                }
                break;
              }

              case 'charge.refunded': {
                const charge = event.data.object;
                if (charge.payment_intent && charge.refunded) {
                  const updated = await pgQuery(
                    "UPDATE shipments SET payment_status = 'refunded', version = version + 1, updated_at = NOW() WHERE payment_intent_id = $1 RETURNING id",
                    [charge.payment_intent]
                  );
                  for (const row of updated.rows) { broadcastPaymentUpdate(row.id, { status: 'refunded' }); await pushShipmentChange(row.id); }
                }
                break;
              }

              case 'charge.dispute.created':
              case 'charge.dispute.updated':
              case 'charge.dispute.closed': {
                // A card dispute holds the driver payout and needs a broker response before the deadline.
                const dispute = event.data.object;
                const intentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
                if (!intentId) break;
                const record = (await pgQuery('SELECT id FROM shipments WHERE payment_intent_id = $1', [intentId])).rows[0];
                if (!record) break;
                const info = { id: dispute.id, status: dispute.status, reason: dispute.reason, amount: dispute.amount / 100, dueBy: dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString() : null, updatedAt: new Date().toISOString() };
                const lost = event.type === 'charge.dispute.closed' && dispute.status === 'lost';
                await pgQuery(
                  `UPDATE shipments SET data = data || jsonb_build_object('dispute', $1::jsonb),
                     payment_status = CASE WHEN $2 THEN 'refunded' ELSE payment_status END, version = version + 1, updated_at = NOW() WHERE id = $3`,
                  [JSON.stringify(info), lost, record.id]
                );
                await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES($1, NULL, $2)', [record.id, event.type === 'charge.dispute.closed' ? `Card dispute closed: ${dispute.status}` : `Card dispute ${event.type === 'charge.dispute.created' ? 'opened' : 'updated'} (${dispute.reason}); respond by ${info.dueBy ? new Date(info.dueBy).toLocaleDateString('en-CA') : 'the Stripe deadline'}`]);
                if (event.type !== 'charge.dispute.updated') for (const brokerId of await store.activeBrokerIds()) {
                  await notifyShipmentInbox(brokerId, record.id, event.type === 'charge.dispute.created' ? `Card dispute on ${record.id}` : `Dispute closed on ${record.id}`,
                    event.type === 'charge.dispute.created' ? `The store disputed $${info.amount.toFixed(2)} (${dispute.reason}). Respond in Stripe${info.dueBy ? ' by ' + new Date(info.dueBy).toLocaleDateString('en-CA') : ''}. The driver payout is on hold.` : `The dispute was ${dispute.status}.${lost ? ' The payment has been returned to the store.' : ''}`);
                }
                await pushShipmentChange(record.id);
                break;
              }

              case 'account.updated': {
                // Stripe can restrict a driver's account later; keep our onboarding flag in step.
                const account = event.data.object;
                const ready = Boolean(account.details_submitted && account.capabilities?.transfers === 'active');
                // While Stripe is verifying, transfers read "pending" with nothing required of the
                // driver: leave payouts as they are. Only act when Stripe needs something or blocks it.
                const needsAction = Boolean(account.requirements?.disabled_reason || (account.requirements?.currently_due || []).length || (account.requirements?.past_due || []).length || account.capabilities?.transfers === 'inactive');
                if (!ready && !needsAction) break;
                const changed = await pgQuery('UPDATE users SET stripe_onboarded = $1 WHERE stripe_account_id = $2 AND stripe_onboarded IS DISTINCT FROM $1 RETURNING id', [ready, account.id]);
                for (const row of changed.rows) {
                  await notifications.notifyAccount(row.id, ready ? 'Payouts connected' : 'Action needed for payouts',
                    ready ? 'Your Stripe account is ready. YYC can now pay you for completed deliveries.' : 'Stripe needs more information before YYC can pay you. Open your profile and choose "Set up payouts with Stripe".');
                  await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, NULL, $2, $3)', [row.id, ready ? 'Payouts connected' : 'Action needed for payouts', ready ? 'Your Stripe account is ready for payouts.' : 'Stripe needs more information before you can be paid.']);
                }
                break;
              }

              case 'transfer.created': {
                const transfer = event.data.object;
                const shipmentId = transfer.metadata.shipmentId;

                if (shipmentId) {
                  const updated = await pgQuery(
                    "UPDATE shipments SET payout_status = 'paid', payout_transfer_id = COALESCE(payout_transfer_id, $2), version = version + 1, updated_at = NOW() WHERE id = $1 AND (payout_transfer_id IS NULL OR payout_transfer_id = $2) AND NOT (COALESCE(data->'payoutHistory', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('transferId', $2::text))) RETURNING id",
                    [shipmentId, transfer.id]
                  );
                  if (updated.rowCount) { console.log(`[Stripe] Payout completed for shipment ${shipmentId}`); await pushShipmentChange(shipmentId); }
                }
                break;
              }

              case 'transfer.reversed': {
                // Stripe has no transfer.failed event; a reversal is how money comes back.
                const transfer = event.data.object;
                const fullyReversed = transfer.reversed === true || transfer.amount_reversed >= transfer.amount;
                const reversal = JSON.stringify({ payoutReversedAt: new Date().toISOString(), payoutReversedAmount: transfer.amount_reversed / 100 });
                const historyEntry = JSON.stringify([{ transferId: transfer.id, amount: transfer.amount / 100, reversedAmount: transfer.amount_reversed / 100, reversedAt: new Date().toISOString(), full: fullyReversed }]);
                // A fully reversed payout leaves the shipment so the broker can issue a new one.
                const updated = await pgQuery(
                  `UPDATE shipments SET payout_status = CASE WHEN $2 THEN 'failed' ELSE payout_status END,
                     payout_transfer_id = CASE WHEN $2 THEN NULL ELSE payout_transfer_id END,
                     data = (data || $3::jsonb || jsonb_build_object('payoutHistory', COALESCE(data->'payoutHistory', '[]'::jsonb) || $4::jsonb)) - CASE WHEN $2 THEN 'payoutClaim' ELSE '' END,
                     version = version + 1, updated_at = NOW()
                   WHERE payout_transfer_id = $1 RETURNING id`,
                  [transfer.id, fullyReversed, reversal, historyEntry]
                );
                if (!updated.rowCount) {
                  // Not a main payout: it may be a hand-off driver's share.
                  const handoffRow = (await pgQuery("SELECT id, data FROM shipments WHERE data->'handoffs' @> jsonb_build_array(jsonb_build_object('transferId', $1::text))", [transfer.id])).rows[0];
                  if (handoffRow) {
                    const handoffs = (handoffRow.data.handoffs || []).map(h => h.transferId === transfer.id ? { ...h, payout: fullyReversed ? 'reversed' : h.payout, reversedAmount: transfer.amount_reversed / 100, reversedAt: new Date().toISOString() } : h);
                    await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('handoffs', $1::jsonb), version = version + 1, updated_at = NOW() WHERE id = $2", [JSON.stringify(handoffs), handoffRow.id]);
                    await pushShipmentChange(handoffRow.id);
                    for (const brokerId of await store.activeBrokerIds()) {
                      await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [brokerId, handoffRow.id, `Hand-off payout reversed for ${handoffRow.id}`, `Stripe reversed $${(transfer.amount_reversed / 100).toFixed(2)} of a hand-off driver's share.`]).catch(() => {});
                    }
                  }
                }
                for (const row of updated.rows) {
                  const reversedFor = (await pgQuery('SELECT driver_id FROM shipments WHERE id = $1', [row.id])).rows[0]?.driver_id;
                  if (reversedFor) await notifyShipmentInbox(reversedFor, row.id, `Payout reversed for ${row.id}`, `$${(transfer.amount_reversed / 100).toFixed(2)} of your payout for ${row.id} was reversed. YYC will contact you about next steps.`);
                  console.log(`[Stripe] Payout for ${row.id} reversed ($${(transfer.amount_reversed / 100).toFixed(2)})`);
                  await pushShipmentChange(row.id);
                  for (const brokerId of await store.activeBrokerIds()) {
                    await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [brokerId, row.id, `Payout reversed for ${row.id}`, `Stripe reversed $${(transfer.amount_reversed / 100).toFixed(2)} of the driver payout.`]).catch(() => {});
                  }
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

        // Brokers must enrol in MFA before using anything but MFA setup.
        if (adminMfaRequired(u) && !['/api/logout', '/api/mfa/enroll', '/api/mfa/enroll/verify', '/api/mfa/status'].includes(path)) {
          const error = new AppError(403, 'Broker accounts must set up an authenticator app before continuing.');
          error.code = 'mfa_enrollment_required';
          throw error;
        }

        // Logout endpoint
        if (path === '/api/logout' && req.method === 'POST') {
          await store.logout(token);
          await disconnectSession(token);
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
          // Capture the address before anonymizing so the person can be told the outcome.
          const requester = (await pgQuery('SELECT email FROM users WHERE id=$1', [accountId])).rows[0];
          if (decision === 'approve') {
            check(accountId !== u.id, 400, 'Another broker must approve removal of your own account.');
            const target = (await pgQuery('SELECT role FROM users WHERE id=$1', [accountId])).rows[0];
            if (target?.role === 'store') {
              const open = await store.openStoreShipmentCount(accountId);
              check(open === 0, 409, `This store still has ${open} open shipment${open === 1 ? '' : 's'}. Complete or cancel them before removing the account.`);
              const outstanding = await store.outstandingStoreShipments(accountId);
              check(!outstanding.length, 409, `This store has unpaid invoices or open claims (${outstanding.join(', ')}). Settle them before removing the account.`);
            }
            // Database changes are all-or-nothing; stored files are removed afterwards.
            const docs = await documents.getUserDocuments(accountId);
            let released = [];
            await pgTransaction(async client => {
              if (target?.role === 'driver') released = await store.releaseDriverWork(u.id, accountId, 'driver account removed', { client });
              await client.query('DELETE FROM notification_tokens WHERE user_id=$1', [accountId]);
              await client.query('DELETE FROM user_notifications WHERE user_id=$1', [accountId]);
              await client.query('DELETE FROM store_team_memberships WHERE owner_user_id=$1 OR member_user_id=$1', [accountId]);
              await client.query("DELETE FROM gps_locations WHERE driver_id=$1", [accountId]);
              await client.query("UPDATE shipments SET data=data - 'pickupContact' - 'receivingContact' - 'notes' - 'appointment' - 'cargoNotes' WHERE store_id=$1", [accountId]);
              await client.query("UPDATE users SET disabled=true,approved=false,email='removed+'||id::text||'@deleted.invalid',name='Deleted account',password_hash='account-removed',profile='{}'::jsonb,notification_preferences='{}'::jsonb WHERE id=$1", [accountId]);
            });
            await redis.revokeUserSessions(accountId);
            disconnectUser(accountId);
            for (const shipmentId of released) await pushShipmentChange(shipmentId);
            for (const doc of docs) {
              try { await documents.deleteDocument(doc.id); } catch (error) { console.warn('[Account removal] Document cleanup failed:', doc.id, error.message); }
            }
          }
          await pgQuery('UPDATE account_deletion_requests SET status=$1,decided_by=$2,decided_at=NOW(),decision_notes=$3 WHERE id=$4', [decision === 'approve' ? 'approved' : 'rejected', u.id, String(data.notes || '').slice(0,1000), deletionDecision[1]]);
          await pgQuery('INSERT INTO audit(shipment_id,actor_id,event) VALUES(NULL,$1,$2)', [u.id, `Account removal request ${decision}d for ${accountId}`]);
          if (decision === 'approve') {
            if (requester?.email) await emailClient.sendEmail({ to: requester.email, subject: 'Your YYC account has been removed', text: 'Your account removal request was approved. Your personal details have been removed; delivery records required for accounting are kept without your contact details.' }).catch(error => console.warn('[Account removal] Notice failed:', error.message));
          } else {
            await notifyAccountInbox(accountId, 'Account removal request not approved', `YYC did not approve your account removal request${data.notes ? ': ' + String(data.notes).slice(0, 500) : '.'}`);
          }
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
          await notifyAccountInbox(member.rows[0].id, `You were added to ${u.name}`, `${u.name} gave you access to their YYC shipments${permissions['shipments.write'] ? ', including making changes' : ''}${permissions['billing.read'] ? ' and billing' : ''}.`);
          return json(res, 201, { membership: result.rows[0] });
        }
        // A team member can leave a store team on their own.
        if (path === '/api/team/membership' && req.method === 'DELETE') {
          await body(req);
          check(u.role === 'store', 403, 'Store team access required.');
          const left = await pgQuery('DELETE FROM store_team_memberships WHERE member_user_id = $1 RETURNING owner_user_id', [u.id]);
          check(left.rowCount === 1, 404, 'You are not a member of another store team.');
          const ownerId = left.rows[0].owner_user_id;
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL,$1,$2)', [u.id, 'Left store team of ' + ownerId]);
          await notifyAccountInbox(ownerId, `${u.name} left your team`, `${u.name} (${u.email}) left your YYC store team and no longer has access to your shipments.`);
          return json(res, 200, { left: true });
        }
        let teamMemberMatch = path.match(/^\/api\/team\/([a-f0-9-]+)$/);
        if (teamMemberMatch && req.method === 'DELETE') {
          await body(req);
          check(u.role === 'store' && (await store.storeOwnerId(u)) === u.id, 403, 'Only the store account owner can remove team members.');
          const result = await pgQuery('DELETE FROM store_team_memberships WHERE owner_user_id = $1 AND member_user_id = $2 RETURNING member_user_id', [u.id, teamMemberMatch[1]]);
          check(result.rowCount === 1, 404, 'Team member not found.');
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL,$1,$2)', [u.id, 'Store team membership removed: ' + teamMemberMatch[1]]);
          await notifyAccountInbox(teamMemberMatch[1], `Access to ${u.name} removed`, `${u.name} removed your access to their YYC shipments.`);
          disconnectUser(teamMemberMatch[1]);
          return json(res, 200, { removed: true });
        }

        if (path === '/api/truck' && req.method === 'PATCH') {
          const { released } = await store.updateTruck(u, await body(req));
          for (const shipmentId of released) await pushShipmentChange(shipmentId);
          for (const brokerId of await store.activeBrokerIds()) {
            await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, NULL, $2, $3)', [brokerId, `Truck re-approval: ${u.name}`, `${u.name} updated their truck and needs re-approval before taking jobs.`]).catch(() => {});
          }
          return json(res, 200, { user: await store.publicUser(await store.getUserById(u.id)), released });
        }

        if (path === '/api/account/password' && req.method === 'POST') {
          const data = await body(req);
          await rateLimit(req, u.email);
          check(typeof data.currentPassword === 'string' && await store.verifyPassword(data.currentPassword, u.password_hash), 401, 'Your current password is incorrect.');
          check(data.newPassword !== data.currentPassword, 400, 'Choose a password different from your current one.');
          await store.updatePassword(u.email, data.newPassword);
          // Sign out every other session, then give this browser a fresh one.
          await redis.revokeUserSessions(u.id);
          disconnectUser(u.id);
          await store.logout(token);
          const fresh = await store.createSession(u.id);
          setCookie(res, fresh.token);
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, 'Password changed; other sessions signed out']);
          return json(res, 200, { csrf: fresh.csrf, message: 'Password changed. Other devices have been signed out.' });
        }

        if (path === '/api/profile' && req.method === 'PATCH') {
          return json(res, 200, { user: await store.updateProfile(u, await body(req)) });
        }

        if (path === '/api/admin/accounts' && req.method === 'GET') {
          check(u.role === 'admin', 403, 'Admin access required');
          // Search by name or email, newest first, 50 at a time.
          const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
          const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
          const pattern = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
          const result = await pgQuery(
            `SELECT id, email, role, name, approved, disabled, email_verified, mfa_enabled, created_at FROM users
             WHERE ($1 = '' OR name ILIKE $2 OR email ILIKE $2) ORDER BY created_at DESC LIMIT 51 OFFSET $3`,
            [q, pattern, offset]
          );
          return json(res, 200, { accounts: result.rows.slice(0, 50), nextOffset: result.rows.length > 50 ? offset + 50 : null });
        }

        // Broker help for accounts: resend a verification code, confirm an email, or reset MFA.
        const accountHelpMatch = path.match(/^\/api\/admin\/accounts\/([a-f0-9-]+)\/(resend-verification|verify-email|reset-mfa)$/);
        if (accountHelpMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          await body(req);
          const [, accountId, operation] = accountHelpMatch;
          const target = (await pgQuery('SELECT id, email, name, email_verified, mfa_enabled, disabled FROM users WHERE id = $1', [accountId])).rows[0];
          check(target && !target.disabled, 404, 'Active account not found.');
          if (operation === 'resend-verification') {
            check(!target.email_verified, 400, 'This email is already verified.');
            const code = crypto.randomInt(100000, 1000000).toString();
            await redis.setVerificationCode(target.email, code);
            await redis.resetRateLimit(`verify_attempts:${target.email}`);
            await emailClient.sendVerificationEmail(target.email, code, target.name);
            await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, `Broker resent the verification code to ${target.email}`]);
            return json(res, 200, { message: `A new code was sent to ${target.email}.` });
          }
          if (operation === 'verify-email') {
            check(!target.email_verified, 400, 'This email is already verified.');
            await pgQuery('UPDATE users SET email_verified = true WHERE id = $1', [accountId]);
            await redis.deleteVerificationCode(target.email);
            await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, `Broker confirmed the email for ${target.email} manually`]);
            await notifyAccountInbox(accountId, 'Your account is confirmed', 'YYC confirmed your email address. You can now sign in.');
            return json(res, 200, { message: `${target.email} can now sign in.` });
          }
          // reset-mfa: for a user who lost their authenticator and backup codes.
          check(accountId !== u.id, 400, 'Another broker must reset your own MFA.');
          check(target.mfa_enabled, 400, 'This account does not use MFA.');
          await mfa.disableMFA(accountId);
          await redis.revokeUserSessions(accountId);
          disconnectUser(accountId);
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, `Broker reset MFA for ${target.email}`]);
          await notifyAccountInbox(accountId, 'Your two-step sign-in was reset', 'A YYC broker reset your authenticator. Sign in and set up two-step sign-in again. If you did not ask for this, contact YYC immediately.');
          return json(res, 200, { message: `MFA reset for ${target.email}. They will set it up again at next sign-in.` });
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
            connectWebhooks: stripePayments.connectWebhooksConfigured(),
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
          let released = [];
          const result = await pgTransaction(async client => {
            const target = (await client.query('SELECT role FROM users WHERE id=$1', [accountId])).rows[0];
            check(target, 404, 'Account not found.');
            // A suspended driver cannot accept or run jobs, so hand pending work back to dispatch.
            if (disabled && target.role === 'driver') released = await store.releaseDriverWork(u.id, accountId, 'driver account suspended', { client });
            return await client.query('UPDATE users SET disabled = $1 WHERE id = $2 RETURNING id, email, role, name, disabled', [disabled, accountId]);
          });
          check(result.rowCount === 1, 404, 'Account not found.');
          // Revoke sessions so restoring the account later does not revive them.
          if (disabled) { await redis.revokeUserSessions(accountId); disconnectUser(accountId); }
          for (const shipmentId of released) await pushShipmentChange(shipmentId);
          await pgQuery('INSERT INTO audit(shipment_id, actor_id, event) VALUES(NULL, $1, $2)', [u.id, `Account ${disabled ? 'suspended' : 'restored'}: ${accountId}`]);
          return json(res, 200, { account: result.rows[0] });
        }

        // Create shipment endpoint
        if (path === '/api/shipments' && req.method === 'POST') {
          const shipment = await store.createShipment(u, await body(req));
          const record = await store.getShipment(shipment.id);
          broadcastToAdmins('shipment:new', { shipmentId: shipment.id });
          emitToUsers((await store.storeAudience(record.store_id)).filter(id => id !== u.id), 'shipment:new', { shipmentId: shipment.id });
          for (const brokerId of await store.activeBrokerIds()) {
            try {
              const message = `New delivery request from ${shipment.customer}: ${shipment.pickup} → ${shipment.destination} on ${shipment.date} (${shipment.window}). Quote needed.`;
              await pgQuery('INSERT INTO user_notifications(user_id, shipment_id, title, message) VALUES($1, $2, $3, $4)', [brokerId, shipment.id, `New request ${shipment.id}`, message]);
              const broker = await pgQuery('SELECT profile FROM users WHERE id = $1', [brokerId]);
              await notifications.notifyShipmentUpdate(brokerId, broker.rows[0]?.profile?.phone || '', shipment.id, message);
            } catch (error) { console.warn('[Notifications] New request notice failed:', error.message); }
          }
          return json(res, 201, { shipment });
        }

        // Shipment actions endpoint
        let shipmentMatch = path.match(/^\/api\/shipments\/(YYC-\d+)\/actions$/);
        if (shipmentMatch && req.method === 'POST') {
          let data = await body(req);
          const before = await store.getShipment(shipmentMatch[1]);
          const shipment = await store.act(u, shipmentMatch[1], data.action, data);
          await broadcastShipmentUpdate(shipmentMatch[1], { version: shipment.version, status: shipment.status });
          if (shipment.status === 'Ready to assign' && before?.status !== 'Ready to assign') broadcastToDrivers('shipment:market', {});
          const after = await store.getShipment(shipmentMatch[1]);
          if (after) await notifyShipmentAction(u, data.action, before, { ...after, events: shipment.events });
          if (data.action === 'resolveClaim') { await refundPendingCredits(shipmentMatch[1]); await reconcileRefunds(shipmentMatch[1]); }
          if (['deliver', 'resolveClaim'].includes(data.action)) await settleIfNothingToCharge(shipmentMatch[1], u.id);
          return json(res, 200, { shipment: data.action === 'resolveClaim' ? await store.serializeFor(u, shipmentMatch[1]) : shipment });
        }

        // Driver approval endpoint
        let driverMatch = path.match(/^\/api\/drivers\/([a-f0-9-]+)\/approve$/);
        if (driverMatch && req.method === 'POST') {
          await body(req);
          const approvedDriver = await store.approve(u, driverMatch[1], { requireDocuments: isS3Configured() });
          await notifyAccountInbox(driverMatch[1], 'You are approved for dispatch', 'YYC approved you and your truck. You can now see open loads, bid and accept jobs.');
          return json(res, 200, { driver: approvedDriver });
        }

        // Document upload: Get pre-signed URL
        if (path === '/api/documents/upload-url' && req.method === 'POST') {
          check(isS3Configured(), 503, 'Document uploads are not configured. Contact administrator.');

          let data = await body(req);
          const { documentType, fileExtension } = data;

          check(documentType && fileExtension, 400, 'Document type and file extension are required');
          check(['license', 'insurance', 'registration', 'pod', 'invoice', 'receipt'].includes(documentType), 400, 'Unsupported document type.');
          check(['pdf', 'jpg', 'jpeg', 'png'].includes(String(fileExtension).toLowerCase()), 400, 'Upload a PDF, JPG or PNG file.');

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
          if (expiryDate) {
            check(/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) && new Date(expiryDate + 'T00:00:00Z').toISOString().slice(0, 10) === expiryDate, 400, 'Enter the expiry date as a valid date (YYYY-MM-DD).');
            check(expiryDate >= store.calgaryToday(), 400, 'This document has already expired. Upload a current copy.');
          }
          // Only record files that actually reached storage; use S3's size and type, not the client's.
          const stored = await documents.storedObject(s3Key);
          check(stored, 400, 'The file upload did not complete. Please upload the file again.');
          // Presigned URLs cannot cap size, so enforce the 12 MB limit here and discard the file.
          if (stored.size != null && stored.size > 12 * 1024 * 1024) {
            await documents.discardUpload(s3Key).catch(error => console.warn('[Documents] Could not discard oversized upload:', error.message));
            throw new AppError(400, 'Files must be 12 MB or smaller.');
          }
          const attachedShipment = shipmentId ? await store.getShipment(shipmentId) : null;
          check(!shipmentId || u.role === 'admin' || (attachedShipment && (await store.hasStorePermission(u, attachedShipment.store_id, 'shipments.read') || attachedShipment.driver_id === u.id)), 403, 'You cannot attach a file to this shipment.');

          const document = await documents.createDocument({
            userId: u.id,
            shipmentId: shipmentId || null,
            type: documentType,
            s3Key,
            filename,
            fileSize: stored.size ?? fileSize ?? null,
            contentType: stored.contentType || contentType || null,
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

          const existing = await documents.getDocument(documentId);
          check(existing, 404, 'Document not found');
          const document = await documents.approveDocument(documentId, u.id, notes || null);
          check(document, 409, existing.status === 'pending' ? 'This document has expired. Ask for a current copy.' : `This document is already ${existing.status}.`);
          await notifyAccountInbox(document.user_id, `Document approved: ${document.type}`, `YYC approved your ${document.type} (${document.filename}).`);

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

          const existing = await documents.getDocument(documentId);
          check(existing, 404, 'Document not found');
          const document = await documents.rejectDocument(documentId, u.id, notes);
          check(document, 409, `This document is already ${existing.status}.`);
          await notifyAccountInbox(document.user_id, `Document rejected: ${document.type}`, `YYC could not accept your ${document.type} (${document.filename}): ${notes}. Please upload a corrected copy.`);
          if (store.COMPLIANCE_TYPES.includes(document.type)) await announceRevocation(document.user_id, `${document.type} was rejected`, await store.recheckDriverCompliance(document.user_id, `${document.type} rejected`, u.id));

          return json(res, 200, { document });
        }

        // Delete document
        let documentDeleteMatch = path.match(/^\/api\/documents\/([a-f0-9-]+)$/);
        if (documentDeleteMatch && req.method === 'DELETE') {
          const documentId = documentDeleteMatch[1];
          const doc = await documents.getDocument(documentId);

          check(doc, 404, 'Document not found');
          check(doc.user_id === u.id || u.role === 'admin', 403, 'You do not have permission to delete this document');
          check(!doc.shipment_id || u.role === 'admin', 409, 'Delivery evidence is part of the shipment record and cannot be deleted. Contact YYC if it is wrong.');

          await documents.deleteDocument(documentId);
          if (store.COMPLIANCE_TYPES.includes(doc.type)) await announceRevocation(doc.user_id, `${doc.type} was deleted`, await store.recheckDriverCompliance(doc.user_id, `${doc.type} deleted`, u.role === 'admin' ? u.id : null));

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
          // Location is shared from pickup to delivery only, never while the driver is off-job.
          check(shipment.status === 'In transit', 400, 'Location sharing starts when goods are picked up.');

          let location;
          try {
            location = await gpsLocation.recordLocation({
              shipmentId,
              driverId: u.id,
              latitude,
              longitude,
              accuracy,
              speed,
              heading,
              altitude
            });
          } catch (error) {
            if (error instanceof RangeError) throw new AppError(400, `Invalid location: ${error.message}.`);
            throw error;
          }

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

          // Non-brokers see the driver only between pickup and delivery.
          if (u.role !== 'admin' && shipment.status !== 'In transit') return json(res, 200, { location: null });
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

          const limit = Number(url.searchParams.get('limit') || 100);
          let since = url.searchParams.get('since') || null;
          check(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 400, 'limit must be a whole number from 1 to 1000.');
          check(since == null || Number.isFinite(Date.parse(since)), 400, 'since must be a valid date.');
          if (u.role !== 'admin') {
            // Stores and drivers only see the route after pickup.
            if (!['In transit', 'Delivered'].includes(shipment.status) || !shipment.data.pickedUpAt) return json(res, 200, { history: [] });
            if (!since || Date.parse(since) < Date.parse(shipment.data.pickedUpAt)) since = shipment.data.pickedUpAt;
          }

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
          // The customer invoice shows the store's price and billing details, so drivers cannot open it.
          check(await store.hasStorePermission(u, shipment.store_id, 'billing.read'), 403, 'You do not have billing access to this shipment');
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
          check(shipment.data.claim?.status !== 'open', 409, 'Payment is on hold while a delivery claim is open. YYC will update the amount once it is decided.');
          check(!['succeeded', 'refunded'].includes(shipment.payment_status), 400, 'Payment has already been completed');

          // Same totals as the invoice, including any claim credits.
          const { total: amount } = billingTotals(shipment.data);
          if (amount < STRIPE_MINIMUM_CAD) {
            await settleIfNothingToCharge(shipmentId, u.id);
            return json(res, 200, { settled: true, message: amount === 0 ? 'Nothing is owed on this delivery after credits.' : `The remaining $${amount.toFixed(2)} is below the card minimum and has been waived.` });
          }

          if (shipment.payment_intent_id) {
            const existingIntent = await stripePayments.getPaymentIntent(shipment.payment_intent_id);
            check(existingIntent.status !== 'succeeded', 400, 'Payment has already succeeded');
            if (Math.round(existingIntent.amount * 100) === Math.round(amount * 100) && existingIntent.status !== 'canceled') {
              return json(res, 200, { paymentIntent: existingIntent });
            }
            // The amount changed (e.g. a claim credit): replace the unpaid intent.
            if (existingIntent.status !== 'canceled') await stripePayments.cancelPaymentIntent(existingIntent.id);
          }

          const paymentIntent = await stripePayments.createPaymentIntent(amount, 'cad', {
            shipmentId,
            storeId: shipment.store_id
          });

          // Update shipment with payment intent ID
          await pgQuery(
            // Stays 'pending' until Stripe reports the customer's payment as processing or complete.
            'UPDATE shipments SET payment_intent_id = $1, payment_status = $2, payment_amount = $3 WHERE id = $4',
            [paymentIntent.paymentIntentId, 'pending', amount, shipmentId]
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

          const canSeeCharge = await store.hasStorePermission(u, shipment.store_id, 'billing.read');
          return json(res, 200, {
            paymentStatus: shipment.payment_status,
            ...(canSeeCharge ? { paymentAmount: shipment.payment_amount, paymentIntentId: shipment.payment_intent_id } : {}),
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
          // Send drivers back to the origin they are actually using (e.g. localhost:3001 in Docker).
          const browserOrigin = publicOrigin || `${secure ? 'https' : 'http'}://${req.headers.host}`;
          const refreshUrl = `${browserOrigin}/driver?stripe=refresh`;
          const returnUrl = `${browserOrigin}/driver?stripe=success`;

          const onboardingUrl = await stripePayments.createAccountLink(accountId, refreshUrl, returnUrl);

          return json(res, 200, { onboardingUrl });
        }

        // Stripe Connect: Complete onboarding
        if (path === '/api/payments/connect/complete' && req.method === 'POST') {
          check(u.role === 'driver', 403, 'Only drivers can complete Stripe Connect onboarding');
          check(u.stripe_account_id, 400, 'No Stripe account found. Please start onboarding first.');
          check(stripePayments.isConfigured(), 503, 'Payment processing is not configured. Contact administrator.');

          // Only trust Stripe's view of the account, not the driver's claim.
          const connectStatus = await stripePayments.getConnectAccountStatus(u.stripe_account_id);
          check(connectStatus.ready, 409, connectStatus.detailsSubmitted
            ? 'Stripe is still verifying your account. Try again once transfers are enabled.'
            : 'Stripe onboarding is not finished yet. Complete every step in the Stripe form first.');

          // Mark user as onboarded
          await pgQuery(
            'UPDATE users SET stripe_onboarded = true WHERE id = $1',
            [u.id]
          );

          return json(res, 200, { success: true, message: 'Stripe Connect onboarding completed!' });
        }

        // Admin: retry claim-credit refunds and hand-off payouts that failed
        let retryMoneyMatch = path.match(/^\/api\/admin\/shipments\/(YYC-\d+)\/retry-payments$/);
        if (retryMoneyMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          await body(req);
          const record = await store.getShipment(retryMoneyMatch[1]);
          check(record, 404, 'Shipment not found');
          const credits = (record.data.credits || []).map(c => c.refund === 'failed' ? { ...c, refund: 'pending' } : c);
          await pgQuery("UPDATE shipments SET data = data || jsonb_build_object('credits', $1::jsonb) WHERE id = $2", [JSON.stringify(credits), record.id]);
          await refundPendingCredits(record.id);
          await reconcileRefunds(record.id);
          const handoffResults = record.payout_status === 'paid' ? await payHandoffShares(record.id, u.id) : [];
          const after = await store.getShipment(record.id);
          return json(res, 200, { credits: after.data.credits || [], handoffs: after.data.handoffs || [], handoffResults });
        }

        // Admin: Create payout for completed delivery
        let payoutMatch = path.match(/^\/api\/admin\/shipments\/(YYC-\d+)\/payout$/);
        if (payoutMatch && req.method === 'POST') {
          check(u.role === 'admin', 403, 'Admin access required');
          check(stripePayments.isConfigured(), 503, 'Payment processing is not configured. Contact administrator.');

          const shipmentId = payoutMatch[1];
          const shipment = await store.getShipment(shipmentId);

          check(shipment, 404, 'Shipment not found');
          check(shipment.status === 'Delivered', 400, 'Payout can only be created for delivered shipments');
          // A payment fully refunded because claim credits cover the price still settles the
          // delivery: the credit is the broker's cost, and the driver did the work.
          const settledByCredit = shipment.payment_status === 'refunded' && billingTotals(shipment.data).total < 0.01;
          check(!shipment.data.dispute || ['won', 'lost', 'warning_closed'].includes(shipment.data.dispute.status), 409, 'The card payment is under dispute. The driver payout is on hold until it is resolved.');
          check(shipment.payment_status === 'succeeded' || settledByCredit, 400, 'Payment must be successful before creating payout');
          check(!shipment.payout_transfer_id, 400, 'Payout already exists for this shipment');
          check(shipment.driver_id, 400, 'No driver assigned to this shipment');
          const payoutInput = await body(req);
          check(shipment.data.claim?.status !== 'open', 409, 'Resolve the open delivery claim before paying the driver.');
          check(shipment.data.deliveryOutcome !== 'partial_or_damaged' || shipment.data.claim || payoutInput.confirmPartial === true, 409, 'Delivery recorded shortage, damage or refusal. Confirm the payout (and any adjustment) explicitly.');

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
          // Drivers who handed the load off mid-delivery are paid their agreed share at the same time.
          const dueHandoffs = (shipment.data.handoffs || []).filter(h => h.payout === 'due' || h.payout === 'failed');
          const handoffTotal = dueHandoffs.reduce((sum, h) => sum + h.payAmount, 0);
          check(Math.round(payoutAmount * 100) + Math.round(handoffTotal * 100) <= Math.round(Number(shipment.data.price) * 100), 400, 'Driver payouts including hand-off shares cannot exceed the shipment subtotal.');
          for (const handoff of dueHandoffs) {
            const handoffDriver = (await pgQuery('SELECT name, stripe_account_id, stripe_onboarded FROM users WHERE id = $1', [handoff.driverId])).rows[0];
            check(handoffDriver?.stripe_account_id && handoffDriver.stripe_onboarded, 400, `${handoffDriver?.name || 'A previous driver'} (hand-off share $${handoff.payAmount.toFixed(2)}) has not completed Stripe Connect onboarding.`);
          }

          // Claim the payout atomically so two concurrent requests cannot both pay the driver.
          // A claim left in 'processing' for 10+ minutes (e.g. the server crashed mid-transfer)
          // may be retried, but only for the same amount: Stripe's idempotency key is per
          // shipment and amount, so a retry returns the original transfer instead of paying twice.
          const staleClaim = shipment.payout_status === 'processing' && shipment.data.payoutClaim;
          if (staleClaim) {
            check(Date.now() - Date.parse(staleClaim.claimedAt) >= 10 * 60000, 409, 'A payout for this shipment is already in progress. Try again in a few minutes if it does not complete.');
            check(Number(staleClaim.amount) === payoutAmount, 409, `An earlier payout attempt of $${Number(staleClaim.amount).toFixed(2)} did not finish. Retry with that same amount so the driver is not paid twice.`);
          }
          const claim = JSON.stringify({ amount: payoutAmount, claimedAt: new Date().toISOString(), by: u.id });
          const claimed = await pgQuery(
            `UPDATE shipments SET payout_status='processing', data = data || jsonb_build_object('payoutClaim', $2::jsonb)
             WHERE id=$1 AND payout_transfer_id IS NULL AND payout_status IS DISTINCT FROM 'paid'
               AND (payout_status IS DISTINCT FROM 'processing'
                    OR ((data->'payoutClaim'->>'claimedAt')::timestamptz <= NOW() - INTERVAL '10 minutes'
                        AND (data->'payoutClaim'->>'amount')::numeric = $3))
             RETURNING id`,
            [shipmentId, claim, payoutAmount]
          );
          check(claimed.rowCount === 1, 409, 'A payout for this shipment is already in progress or complete.');

          let transfer;
          try {
            // Each payout attempt (a new one after a reversal) has its own key; retries of the
            // same attempt reuse it so a crash can never pay twice.
            const attempt = (shipment.data.payoutHistory || []).filter(h => h.full).length;
            transfer = await stripePayments.createPayout(driverData.stripe_account_id, payoutAmount, {
              shipmentId,
              driverId: shipment.driver_id,
              driverName: driverData.name,
              idempotencyKey: `yyc-shipment-payout-${shipmentId}-${Math.round(payoutAmount * 100)}-a${attempt}`
            });
          } catch (error) {
            await pgQuery("UPDATE shipments SET payout_status='failed' WHERE id=$1 AND payout_transfer_id IS NULL", [shipmentId]);
            throw error;
          }

          // Merge the breakdown into the current data (not a stale copy) and bump the version
          // so concurrent shipment edits are kept and open clients refresh.
          const payoutBreakdown = { baseAmount, adjustment, adjustmentReason, total: payoutAmount, currency: 'CAD', transferId: transfer.transferId, createdAt: new Date().toISOString() };
          const updated = await pgQuery(
            "UPDATE shipments SET payout_transfer_id=$1,payout_status='paid',payout_amount=$2,data=data || jsonb_build_object('payoutBreakdown', $3::jsonb),version=version+1,updated_at=NOW() WHERE id=$4 RETURNING version,status",
            [transfer.transferId, payoutAmount, JSON.stringify(payoutBreakdown), shipmentId]
          );
          broadcastShipmentUpdate(shipmentId, { version: updated.rows[0].version, status: updated.rows[0].status });
          await pgQuery('INSERT INTO audit(shipment_id,actor_id,event) VALUES($1,$2,$3)', [shipmentId, u.id, `Driver payout issued: $${payoutAmount.toFixed(2)} CAD (base $${baseAmount.toFixed(2)}, adjustment $${adjustment.toFixed(2)})`]);
          await notifyShipmentInbox(shipment.driver_id, shipmentId, `Payout sent for ${shipmentId}`, `YYC sent you $${payoutAmount.toFixed(2)} CAD for ${shipmentId}${adjustment ? ` (includes an adjustment of $${adjustment.toFixed(2)}: ${adjustmentReason})` : ''}. It arrives in your Stripe account per your payout schedule.`);
          const handoffResults = await payHandoffShares(shipmentId, u.id);

          return json(res, 201, { transfer, payoutAmount, handoffResults });
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
          const isValid = await verifyTotpOnce(u.id, secret, code);
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
          check(!adminMfaRequired({ ...u, mfa_enabled: false }), 400, 'Broker accounts must keep two-step sign-in. Regenerate backup codes instead, or ask another broker to reset it.');

          let data = await body(req);
          const { code, password } = data;

          check(code && password, 400, 'TOTP code and password are required');

          // Verify password
          const passwordValid = await store.verifyPassword(password, u.password_hash);
          check(passwordValid, 401, 'Invalid password');

          // Verify TOTP code or backup code
          const isValid = await verifyTotpOnce(u.id, u.mfa_secret, code);
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
          const isValid = await verifyTotpOnce(u.id, u.mfa_secret, code);
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
            mfaEnforced: u.role === 'admin' && process.env.ADMIN_MFA_OPTIONAL !== 'true'
          });
        }

        // Notifications: Register device token
        if (path === '/api/notifications/inbox' && req.method === 'GET') {
          const result = await pgQuery('SELECT id, shipment_id, title, message, read_at, created_at FROM user_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [u.id]);
          const unread = await pgQuery('SELECT COUNT(*)::int AS n FROM user_notifications WHERE user_id = $1 AND read_at IS NULL', [u.id]);
          return json(res, 200, { notifications: result.rows, unread: unread.rows[0].n });
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

      // React SPA routing: serve React app for main routes
      // Demo routes still use old vanilla JS app for comparison
      const demoAppPaths = ['/demo', '/demo/owner', '/demo/store', '/demo/driver', '/demo/broker'];
      const trimmedPath = path.replace(/\/+$/, '');

      if (path !== trimmedPath && (trimmedPath === '/' || demoAppPaths.includes(trimmedPath))) {
        res.writeHead(302, { Location: trimmedPath });
        return res.end();
      }

      let filePath;
      try {
        let decoded = decodeURIComponent(path);
        check(!decoded.includes('\0') && !decoded.includes('\\'), 404, 'Not found.');

        // Check if this is a demo path or asset request
        const isDemoPath = decoded.startsWith('/demo');
        const hasExtension = extname(decoded) !== '';

        filePath = resolve(
          publicDir,
          '.' + (
            // Demo app routes (old vanilla JS for comparison)
            decoded === '/demo' || decoded === '/demo/' ? '/demo/index.html' :
            demoAppPaths.includes(decoded) ? '/demo/index.html' :
            // Static assets from /assets or /dist/assets
            hasExtension ? decoded :
            // React SPA - serve index.html for all other routes (client-side routing)
            !isDemoPath ? '/dist/index.html' :
            // Default
            decoded
          )
        );
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(404, 'Not found.');
      }

      check(filePath.startsWith(publicDir + sep), 404, 'Not found.');

      // Vite emits hashed bundles to public/dist/assets but index.html references
      // them as /assets/*. Prefer the build output, fall back to public/assets.
      if (/^\/assets\//.test(path)) {
        const distFile = resolve(publicDir, 'dist', '.' + filePath.slice(publicDir.length));
        if (distFile.startsWith(publicDir + sep) && await stat(distFile).then(s => s.isFile(), () => false)) {
          filePath = distFile;
        }
      }

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
        error: status === 500 ? 'An unexpected server error occurred.' : e.message,
        ...(status !== 500 && e.code ? { code: e.code } : {})
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

    // Expire quotes/offers and reopen empty bid windows even when nobody is loading the app.
    const expiryTimer = setInterval(() => {
      store.expireStaleDispatch().then(async ({ changed, stale }) => {
        for (const shipmentId of changed) await pushShipmentChange(shipmentId);
        for (const shipmentId of stale) await notifyPickupDatePassed(shipmentId);
      }).catch(error => console.warn('[Dispatch] Expiry sweep failed:', error.message));
      documents.expireDocuments().then(async expired => {
        const drivers = new Set(expired.filter(doc => store.COMPLIANCE_TYPES.includes(doc.type)).map(doc => doc.user_id));
        for (const driverId of drivers) await announceRevocation(driverId, 'document expired', await store.recheckDriverCompliance(driverId, 'document expired'));
      }).catch(error => console.warn('[Documents] Expiry sweep failed:', error.message));
    }, 60000);
    expiryTimer.unref();

    // Hourly: remind drivers about documents expiring in 30 and 7 days (each reminder sent once).
    const reminderTimer = setInterval(() => { sendExpiryReminders().catch(error => console.warn('[Documents] Reminder sweep failed:', error.message)); }, 3600000);
    reminderTimer.unref();
    setTimeout(() => { sendExpiryReminders().catch(() => {}); }, 60000).unref();

    // Daily retention: drop GPS points older than 90 days and stale device tokens.
    const retentionTimer = setInterval(() => {
      gpsLocation.cleanupOldLocations(90).catch(error => console.warn('[GPS] Cleanup failed:', error.message));
      notifications.cleanupOldTokens().catch(error => console.warn('[Notifications] Token cleanup failed:', error.message));
    }, 24 * 3600000);
    retentionTimer.unref();

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
