import { query, queryOne, queryAll } from '../db/postgres.js';
import { randomUUID } from 'node:crypto';
import * as firebase from './firebase.js';
import * as sms from './sms.js';
import * as emailClient from '../email/client.js';

export const smsConfigured = () => sms.isConfigured();
export const pushConfigured = () => firebase.isConfigured();
export const verifySMSProvider = () => sms.verifyConnection();

/**
 * Notification Manager for YYC Brokers
 * Unified interface for push notifications and SMS
 */

/**
 * Register notification token for a user
 * @param {string} userId - User ID
 * @param {string} token - FCM device token
 * @param {string} platform - Platform (ios, android, web)
 * @param {Object} deviceInfo - Optional device information
 * @returns {Promise<Object>}
 */
export async function registerToken(userId, token, platform, deviceInfo = {}) {
  const id = randomUUID();

  await query(
    `INSERT INTO notification_tokens (id, user_id, token, platform, device_info, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (user_id, token)
     DO UPDATE SET last_used_at = NOW(), device_info = $5`,
    [id, userId, token, platform, JSON.stringify(deviceInfo)]
  );

  console.log(`[Notifications] Token registered for user ${userId} (${platform})`);

  return { success: true };
}

/**
 * Unregister notification token
 * @param {string} userId - User ID
 * @param {string} token - FCM device token
 * @returns {Promise<void>}
 */
export async function unregisterToken(userId, token) {
  await query(
    'DELETE FROM notification_tokens WHERE user_id = $1 AND token = $2',
    [userId, token]
  );

  console.log(`[Notifications] Token unregistered for user ${userId}`);
}

/**
 * Get all tokens for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>}
 */
export async function getUserTokens(userId) {
  return await queryAll(
    'SELECT * FROM notification_tokens WHERE user_id = $1',
    [userId]
  );
}

/**
 * Send notification to a user (all their devices)
 * @param {string} userId - User ID
 * @param {Object} notification - Notification payload
 * @param {Object} data - Custom data
 * @returns {Promise<Object>}
 */
export async function sendToUser(userId, notification, data = {}) {
  const tokens = await getUserTokens(userId);

  if (tokens.length === 0) {
    console.log(`[Notifications] No tokens found for user ${userId}`);
    return { sent: 0, failed: 0 };
  }

  const tokenStrings = tokens.map(t => t.token);

  try {
    if (firebase.isConfigured()) {
      const response = await firebase.sendMulticastNotification(tokenStrings, notification, data);
      return {
        sent: response.successCount,
        failed: response.failureCount
      };
    } else {
      console.warn('[Notifications] Firebase not configured, skipping push notification');
      return { sent: 0, failed: 0 };
    }
  } catch (err) {
    console.error('[Notifications] Failed to send to user:', err);
    return { sent: 0, failed: tokens.length };
  }
}

/**
 * Send notification with SMS fallback
 * @param {string} userId - User ID
 * @param {string} phoneNumber - User phone number
 * @param {Object} notification - Notification payload
 * @param {Object} data - Custom data
 * @param {string} smsMessage - SMS message (if push fails or unavailable)
 * @returns {Promise<Object>}
 */
export async function sendWithSMSFallback(userId, phoneNumber, notification, data, smsMessage) {
  // Try push notification first
  const pushResult = await sendToUser(userId, notification, data);

  // If push failed or no tokens, try SMS
  if (pushResult.sent === 0 && phoneNumber && sms.isConfigured()) {
    try {
      await sms.sendSMS(phoneNumber, smsMessage);
      console.log(`[Notifications] SMS fallback sent to user ${userId}`);
      return { method: 'sms', success: true };
    } catch (err) {
      console.error('[Notifications] SMS fallback failed:', err);
      return { method: 'none', success: false };
    }
  }

  return { method: 'push', ...pushResult };
}

/**
 * Send shipment update notification
 * @param {string} userId - User ID
 * @param {string} phoneNumber - User phone number
 * @param {string} shipmentId - Shipment ID
 * @param {string} event - Event description
 * @returns {Promise<Object>}
 */
export async function notifyShipmentUpdate(userId, phoneNumber, shipmentId, event) {
  const notification = {
    title: `Shipment ${shipmentId}`,
    body: event
  };

  const data = {
    type: 'shipment_update',
    shipmentId,
    event
  };

  const smsMessage = `YYC Brokers: Shipment ${shipmentId} - ${event}`;

  const row = await queryOne('SELECT notification_preferences FROM users WHERE id = $1', [userId]);
  const preferences = row?.notification_preferences || { push: true, sms: false, email: true };
  const results = {};
  // Each channel is independent: a failed SMS (e.g. bad number) must not cancel the email.
  const attempt = async (channel, send) => {
    try { results[channel] = await send(); }
    catch (error) { results[channel] = { error: error.message }; console.warn(`[Notifications] ${channel} failed for ${userId}:`, error.message); }
  };
  if (preferences.push && firebase.isConfigured()) await attempt('push', () => sendToUser(userId, notification, data));
  if (preferences.sms && phoneNumber && sms.isConfigured()) await attempt('sms', () => sms.sendSMS(phoneNumber, smsMessage));
  if (preferences.email && emailClient.isConfigured()) {
    await attempt('email', async () => {
      const account = await queryOne('SELECT email FROM users WHERE id = $1', [userId]);
      return account?.email ? await emailClient.sendEmail({ to: account.email, subject: notification.title, text: notification.body }) : null;
    });
  }
  return results;
}

/**
 * Notify a user about their account (approvals, documents, team access, payouts).
 * Respects their channel preferences; each channel is attempted independently.
 * @param {string} userId - Recipient
 * @param {string} title - Short title
 * @param {string} body - Message
 * @param {Object} options - { email } to send to an address other than the account's
 */
export async function notifyAccount(userId, title, body, options = {}) {
  const row = await queryOne('SELECT email, profile, notification_preferences FROM users WHERE id = $1', [userId]);
  if (!row) return {};
  const preferences = row.notification_preferences || { push: true, sms: false, email: true };
  const results = {};
  const attempt = async (channel, send) => {
    try { results[channel] = await send(); }
    catch (error) { results[channel] = { error: error.message }; console.warn(`[Notifications] ${channel} failed for ${userId}:`, error.message); }
  };
  if (preferences.push && firebase.isConfigured()) await attempt('push', () => sendToUser(userId, { title, body }, { type: 'account' }));
  const phone = row.profile?.phone;
  if (preferences.sms && phone && sms.isConfigured()) await attempt('sms', () => sms.sendSMS(phone, `YYC Brokers: ${body}`));
  const to = options.email || row.email;
  if ((preferences.email || options.email) && to && emailClient.isConfigured()) await attempt('email', () => emailClient.sendEmail({ to, subject: title, text: body }));
  return results;
}

/**
 * Send job offer notification to driver
 * @param {string} driverId - Driver user ID
 * @param {string} phoneNumber - Driver phone number
 * @param {string} shipmentId - Shipment ID
 * @param {string} destination - Delivery destination
 * @param {number} rate - Driver rate
 * @returns {Promise<Object>}
 */
export async function notifyJobOffer(driverId, phoneNumber, shipmentId, destination, rate) {
  const notification = {
    title: 'New Job Offer!',
    body: `${shipmentId} to ${destination}. Rate: $${rate.toFixed(2)}`
  };

  const data = {
    type: 'job_offer',
    shipmentId,
    destination,
    rate: rate.toString()
  };

  const smsMessage = `YYC Brokers: New job offer! ${shipmentId} to ${destination}. Rate: $${rate.toFixed(2)}. Open app to accept.`;

  return await sendWithSMSFallback(driverId, phoneNumber, notification, data, smsMessage);
}

/**
 * Send delivery completed notification
 * @param {string} storeId - Store owner user ID
 * @param {string} phoneNumber - Store owner phone number
 * @param {string} shipmentId - Shipment ID
 * @returns {Promise<Object>}
 */
export async function notifyDeliveryCompleted(storeId, phoneNumber, shipmentId) {
  const notification = {
    title: 'Delivery Completed!',
    body: `Shipment ${shipmentId} has been delivered`
  };

  const data = {
    type: 'delivery_completed',
    shipmentId
  };

  const smsMessage = `YYC Brokers: Your delivery ${shipmentId} has been completed! Check the app for proof of delivery.`;

  return await sendWithSMSFallback(storeId, phoneNumber, notification, data, smsMessage);
}

/**
 * Send quote ready notification
 * @param {string} storeId - Store owner user ID
 * @param {string} phoneNumber - Store owner phone number
 * @param {string} shipmentId - Shipment ID
 * @param {number} price - Quote price
 * @returns {Promise<Object>}
 */
export async function notifyQuoteReady(storeId, phoneNumber, shipmentId, price) {
  const notification = {
    title: 'Quote Ready!',
    body: `Your quote for ${shipmentId}: $${price.toFixed(2)}`
  };

  const data = {
    type: 'quote_ready',
    shipmentId,
    price: price.toString()
  };

  const smsMessage = `YYC Brokers: Quote ready for ${shipmentId}: $${price.toFixed(2)}. Log in to review and accept.`;

  return await sendWithSMSFallback(storeId, phoneNumber, notification, data, smsMessage);
}

/**
 * Clean up old tokens (inactive for 90+ days)
 * @returns {Promise<number>} Number of tokens deleted
 */
export async function cleanupOldTokens() {
  const result = await query(
    `DELETE FROM notification_tokens
     WHERE last_used_at < NOW() - INTERVAL '90 days'`
  );

  const deletedCount = result.rowCount || 0;
  console.log(`[Notifications] Cleaned up ${deletedCount} old tokens`);

  return deletedCount;
}
