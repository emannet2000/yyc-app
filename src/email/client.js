import { Resend } from 'resend';

/**
 * Email client for YYC Brokers
 * Uses Resend for transactional emails
 */

const resendApiKey = process.env.RESEND_API_KEY;

if (!resendApiKey && process.env.NODE_ENV === 'production') {
  console.warn('Warning: RESEND_API_KEY not set. Email features will be disabled.');
}

// Initialize Resend client
const resend = resendApiKey ? new Resend(resendApiKey) : null;

// Default "from" address
const FROM_EMAIL = process.env.FROM_EMAIL || 'YYC Brokers <noreply@yycbrokers.com>';
export function isConfigured() { return resend !== null; }
export async function verifyConnection() {
  if (!resendApiKey) throw new Error('Resend credentials are not configured');
  const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${resendApiKey}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  return { connected: true };
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content (optional)
 * @returns {Promise<Object>} Resend response
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!resend) {
    console.log('[Email] Skipping email send (RESEND_API_KEY not configured)');
    console.log(`[Email] Would send to: ${to}`);
    console.log(`[Email] Subject: ${subject}`);
    return { id: 'dev-mode', success: true };
  }

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      text: text || stripHtml(html)
    });

    console.log(`[Email] Sent to ${to}: ${subject}`);
    return result;
  } catch (error) {
    console.error('[Email] Failed to send:', error);
    throw error;
  }
}

/**
 * Strip HTML tags for plain text fallback
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Email templates
 */

/**
 * Send verification code email
 * @param {string} to - Recipient email
 * @param {string} code - 6-digit verification code
 * @param {string} name - User name
 */
export async function sendVerificationEmail(to, code, name) {
  const subject = 'Verify your YYC Brokers account';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1c3554 0%, #2d5177 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
        .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1c3554; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 30px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        .button { display: inline-block; padding: 12px 30px; background: #ca3b45; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>YYC BROKERS</h1>
          <p>Trucking & Delivery Platform</p>
        </div>
        <div class="content">
          <h2>Welcome, ${name}!</h2>
          <p>Thank you for registering with YYC Brokers. To complete your account setup, please verify your email address.</p>

          <p><strong>Your verification code is:</strong></p>
          <div class="code">${code}</div>

          <p>This code will expire in <strong>15 minutes</strong>.</p>

          <p>If you didn't create an account with YYC Brokers, you can safely ignore this email.</p>
        </div>
        <div class="footer">
          <p>YYC Brokers &copy; ${new Date().getFullYear()}</p>
          <p>Calgary, Alberta</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}

/**
 * Send password reset email
 * @param {string} to - Recipient email
 * @param {string} token - Reset token
 * @param {string} name - User name
 */
export async function sendPasswordResetEmail(to, token, name) {
  const resetUrl = `${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/reset-password?token=${token}`;
  const subject = 'Reset your YYC Brokers password';
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1c3554 0%, #2d5177 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
        .button { display: inline-block; padding: 12px 30px; background: #ca3b45; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>YYC BROKERS</h1>
          <p>Password Reset Request</p>
        </div>
        <div class="content">
          <h2>Hi ${name},</h2>
          <p>We received a request to reset your password for your YYC Brokers account.</p>

          <p style="text-align: center;">
            <a href="${resetUrl}" class="button">Reset Password</a>
          </p>

          <p>Or copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666; font-size: 14px;">${resetUrl}</p>

          <div class="warning">
            <strong>Security Note:</strong> This link will expire in <strong>1 hour</strong>. If you didn't request this password reset, please ignore this email and your password will remain unchanged.
          </div>
        </div>
        <div class="footer">
          <p>YYC Brokers &copy; ${new Date().getFullYear()}</p>
          <p>Calgary, Alberta</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}

/**
 * Send quote notification email to store owner
 * @param {string} to - Store owner email
 * @param {string} shipmentId - Shipment ID
 * @param {number} price - Quote amount
 * @param {string} storeName - Store name
 */
export async function sendQuoteReadyEmail(to, shipmentId, price, storeName) {
  const shipmentUrl = `${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}`;
  const subject = `Quote ready for ${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1c3554 0%, #2d5177 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
        .price { font-size: 36px; font-weight: bold; color: #1c3554; text-align: center; margin: 20px 0; }
        .button { display: inline-block; padding: 12px 30px; background: #ca3b45; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Quote Ready</h1>
          <p>${shipmentId}</p>
        </div>
        <div class="content">
          <h2>Hi ${storeName},</h2>
          <p>Your YYC Brokers quotation is ready for review.</p>

          <p><strong>Quote Amount:</strong></p>
          <div class="price">$${price.toFixed(2)} CAD</div>

          <p>Log in to your YYC Brokers account to review and accept this quote.</p>

          <p style="text-align: center;">
            <a href="${shipmentUrl}" class="button">View Quote</a>
          </p>
        </div>
        <div class="footer">
          <p>YYC Brokers &copy; ${new Date().getFullYear()}</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}

/**
 * Send job offer notification to driver
 * @param {string} to - Driver email
 * @param {string} shipmentId - Shipment ID
 * @param {number} rate - Driver rate
 * @param {string} driverName - Driver name
 * @param {string} destination - Delivery destination
 */
export async function sendJobOfferEmail(to, shipmentId, rate, driverName, destination) {
  const subject = `New job offer: ${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1c3554 0%, #2d5177 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
        .rate { font-size: 36px; font-weight: bold; color: #2d5177; text-align: center; margin: 20px 0; }
        .button { display: inline-block; padding: 12px 30px; background: #ca3b45; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>New Job Offer</h1>
          <p>${shipmentId}</p>
        </div>
        <div class="content">
          <h2>Hi ${driverName},</h2>
          <p>You have a new job offer from YYC Brokers.</p>

          <p><strong>Destination:</strong> ${destination}</p>

          <p><strong>Your Rate:</strong></p>
          <div class="rate">$${rate.toFixed(2)} CAD</div>

          <p>Log in to view full details and accept this job offer.</p>

          <p style="text-align: center;">
            <a href="${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}" class="button">View Job Offer</a>
          </p>
        </div>
        <div class="footer">
          <p>YYC Brokers &copy; ${new Date().getFullYear()}</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}

/**
 * Send delivery completed notification
 * @param {string} to - Store owner email
 * @param {string} shipmentId - Shipment ID
 * @param {string} pod - Proof of delivery reference
 * @param {string} storeName - Store name
 */
export async function sendDeliveryCompletedEmail(to, shipmentId, pod, storeName) {
  const subject = `Delivery completed: ${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #2d5177 0%, #4a8f6e 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: white; padding: 40px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 8px 8px; }
        .success { background: #d4edda; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0; }
        .button { display: inline-block; padding: 12px 30px; background: #28a745; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>✓ Delivery Completed</h1>
          <p>${shipmentId}</p>
        </div>
        <div class="content">
          <h2>Hi ${storeName},</h2>

          <div class="success">
            <strong>Your delivery has been completed successfully!</strong>
          </div>

          <p><strong>Proof of Delivery:</strong> ${pod}</p>

          <p>You can view the full delivery details and receipt in your YYC Brokers account.</p>

          <p style="text-align: center;">
            <a href="${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}" class="button">View Details</a>
          </p>
        </div>
        <div class="footer">
          <p>YYC Brokers &copy; ${new Date().getFullYear()}</p>
          <p>Thank you for using YYC Brokers!</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendEmail({ to, subject, html });
}
