import twilio from 'twilio';

/**
 * Twilio SMS Integration for YYC Brokers
 * Handles SMS notifications as fallback or alternative to push notifications
 */

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_FROM_NUMBER;

let twilioClient = null;

if (accountSid && authToken && fromNumber) {
  twilioClient = twilio(accountSid, authToken);
  console.log('[Twilio] Initialized');
} else {
  console.warn('[Twilio] Not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER environment variables.');
}

/**
 * Send SMS message
 * @param {string} to - Recipient phone number (E.164 format: +1234567890)
 * @param {string} message - SMS message body (max 1600 chars)
 * @returns {Promise<Object>} Twilio message response
 */
export async function sendSMS(to, message) {
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }

  try {
    const response = await twilioClient.messages.create({
      body: message,
      from: fromNumber,
      to
    });

    console.log(`[Twilio] SMS sent to ${to}: ${response.sid}`);

    return {
      sid: response.sid,
      status: response.status,
      to: response.to,
      from: response.from
    };
  } catch (err) {
    console.error('[Twilio] Failed to send SMS:', err);
    throw err;
  }
}

/**
 * Send SMS notification for shipment update
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} shipmentId - Shipment ID
 * @param {string} event - Event description
 * @returns {Promise<Object>}
 */
export async function sendShipmentUpdateSMS(phoneNumber, shipmentId, event) {
  const message = `YYC Brokers: Shipment ${shipmentId} - ${event}. Check the app for details.`;
  return await sendSMS(phoneNumber, message);
}

/**
 * Send SMS notification for job offer
 * @param {string} phoneNumber - Driver phone number
 * @param {string} shipmentId - Shipment ID
 * @param {string} destination - Delivery destination
 * @param {number} rate - Driver rate
 * @returns {Promise<Object>}
 */
export async function sendJobOfferSMS(phoneNumber, shipmentId, destination, rate) {
  const message = `YYC Brokers: New job offer! ${shipmentId} to ${destination}. Rate: $${rate.toFixed(2)}. Open app to accept.`;
  return await sendSMS(phoneNumber, message);
}

/**
 * Send SMS notification for delivery completion
 * @param {string} phoneNumber - Store owner phone number
 * @param {string} shipmentId - Shipment ID
 * @returns {Promise<Object>}
 */
export async function sendDeliveryCompletedSMS(phoneNumber, shipmentId) {
  const message = `YYC Brokers: Your delivery ${shipmentId} has been completed! Check the app for proof of delivery.`;
  return await sendSMS(phoneNumber, message);
}

/**
 * Send verification code via SMS
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} code - Verification code
 * @returns {Promise<Object>}
 */
export async function sendVerificationCodeSMS(phoneNumber, code) {
  const message = `Your YYC Brokers verification code is: ${code}. This code expires in 15 minutes.`;
  return await sendSMS(phoneNumber, message);
}

/**
 * Send MFA code via SMS
 * @param {string} phoneNumber - Recipient phone number
 * @param {string} code - MFA code
 * @returns {Promise<Object>}
 */
export async function sendMFACodeSMS(phoneNumber, code) {
  const message = `Your YYC Brokers login code is: ${code}. Do not share this code with anyone.`;
  return await sendSMS(phoneNumber, message);
}

/**
 * Check if Twilio is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return twilioClient !== null;
}

export async function verifyConnection() {
  if (!twilioClient) throw new Error('Twilio credentials are not configured');
  const account = await twilioClient.api.v2010.accounts(accountSid).fetch();
  if (account.status !== 'active') throw new Error(`Twilio account is ${account.status}`);
  return { connected: true, accountStatus: account.status };
}
