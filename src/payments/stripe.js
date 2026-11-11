import Stripe from 'stripe';

/**
 * Stripe Payment Integration for YYC Brokers
 * Handles customer payments and driver payouts via Stripe Connect
 */

const secretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

let stripe = null;

if (secretKey) {
  stripe = new Stripe(secretKey, {
    apiVersion: '2024-11-20.acacia'
  });
  console.log('[Stripe] Initialized');
} else {
  console.warn('[Stripe] Secret key not configured. Payment features will be disabled.');
}

/**
 * Create a PaymentIntent for a customer quote
 * @param {number} amount - Amount in dollars
 * @param {string} currency - Currency code (default: CAD)
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>}
 */
export async function createPaymentIntent(amount, currency = 'cad', metadata = {}) {
  if (!stripe) {
    throw new Error('Stripe not configured. Set STRIPE_SECRET_KEY in environment variables.');
  }

  // Convert dollars to cents
  const amountCents = Math.round(amount * 100);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: currency.toLowerCase(),
    automatic_payment_methods: {
      enabled: true
    },
    metadata: {
      ...metadata,
      platform: 'YYC Brokers'
    }
  }, metadata.shipmentId ? { idempotencyKey: `yyc-shipment-payment-${metadata.shipmentId}` } : undefined);

  return {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
    amount: paymentIntent.amount / 100,
    currency: paymentIntent.currency,
    status: paymentIntent.status
  };
}

/**
 * Retrieve a PaymentIntent
 * @param {string} paymentIntentId - PaymentIntent ID
 * @returns {Promise<Object>}
 */
export async function getPaymentIntent(paymentIntentId) {
  if (!stripe) {
    throw new Error('Stripe not configured.');
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  return {
    id: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    amount: paymentIntent.amount / 100,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    metadata: paymentIntent.metadata,
    created: paymentIntent.created
  };
}

/**
 * Create a Stripe Connect Express account for a driver
 * @param {string} email - Driver email
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<string>} Account ID
 */
export async function createConnectAccount(email, metadata = {}) {
  if (!stripe) {
    throw new Error('Stripe not configured.');
  }

  const account = await stripe.accounts.create({
    type: 'express',
    country: 'CA',
    email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true }
    },
    business_type: 'individual',
    metadata: {
      ...metadata,
      platform: 'YYC Brokers'
    }
  });

  return account.id;
}

/**
 * Create an account link for Connect onboarding
 * @param {string} accountId - Stripe Connect account ID
 * @param {string} refreshUrl - URL to redirect if refresh needed
 * @param {string} returnUrl - URL to redirect after completion
 * @returns {Promise<string>} Onboarding URL
 */
export async function createAccountLink(accountId, refreshUrl, returnUrl) {
  if (!stripe) {
    throw new Error('Stripe not configured.');
  }

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding'
  });

  return accountLink.url;
}

/**
 * Create a payout/transfer to a driver's Connect account
 * @param {string} accountId - Driver's Stripe Connect account ID
 * @param {number} amount - Amount in dollars
 * @param {Object} metadata - Additional metadata
 * @returns {Promise<Object>}
 */
export async function createPayout(accountId, amount, metadata = {}) {
  if (!stripe) {
    throw new Error('Stripe not configured.');
  }

  // Convert dollars to cents
  const amountCents = Math.round(amount * 100);

  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'cad',
    destination: accountId,
    metadata: {
      ...metadata,
      platform: 'YYC Brokers'
    }
  });

  return {
    transferId: transfer.id,
    amount: transfer.amount / 100,
    currency: transfer.currency,
    destination: transfer.destination,
    created: transfer.created
  };
}

/**
 * Verify webhook signature
 * @param {string} payload - Webhook payload (raw body)
 * @param {string} signature - Stripe-Signature header
 * @returns {Object} Parsed event
 */
export function constructWebhookEvent(payload, signature) {
  if (!stripe || !webhookSecret) {
    throw new Error('Stripe webhook secret not configured.');
  }

  try {
    const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    return event;
  } catch (err) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }
}

/**
 * Check if Stripe is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return stripe !== null;
}

/**
 * Check if webhooks are configured
 * @returns {boolean}
 */
export function webhooksConfigured() {
  return stripe !== null && webhookSecret !== null;
}

export async function verifyConnection() {
  if (!stripe) throw new Error('Stripe credentials are not configured');
  const balance = await stripe.balance.retrieve();
  return { connected: true, liveMode: balance.livemode, currencies: [...new Set([...balance.available, ...balance.pending].map(x => x.currency))] };
}
