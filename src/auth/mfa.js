import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { randomBytes, createHash } from 'node:crypto';
import { query, queryOne } from '../db/postgres.js';

/**
 * Multi-Factor Authentication (MFA) Module for YYC Brokers
 * Implements TOTP (Time-based One-Time Password) and backup codes
 */

/**
 * Generate TOTP secret for a user
 * @param {string} userEmail - User email address
 * @returns {Object} Secret and OTP Auth URL
 */
export function generateTOTPSecret(userEmail) {
  const secret = new Secret({ size: 20 });

  const totp = new TOTP({
    issuer: 'YYC Brokers',
    label: userEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret
  });

  return {
    secret: secret.base32,
    uri: totp.toString()
  };
}

/**
 * Generate QR code as data URL for TOTP enrollment
 * @param {string} otpAuthUrl - OTP Auth URL
 * @returns {Promise<string>} QR code data URL
 */
export async function generateQRCode(otpAuthUrl) {
  try {
    const dataUrl = await QRCode.toDataURL(otpAuthUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 250
    });
    return dataUrl;
  } catch (err) {
    throw new Error(`Failed to generate QR code: ${err.message}`);
  }
}

/**
 * Verify TOTP code
 * @param {string} secret - Base32 encoded secret
 * @param {string} token - 6-digit TOTP code
 * @param {number} window - Time window tolerance (default: 1 = ±30 seconds)
 * @returns {number|false} The matched time step, or false when invalid
 */
export function verifyTOTP(secret, token, window = 1) {
  try {
    const totp = new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret)
    });

    const currentTime = Math.floor(Date.now() / 1000);

    // Check current time window and adjacent windows
    for (let i = -window; i <= window; i++) {
      const timeOffset = currentTime + i * 30;
      const expectedToken = totp.generate({ timestamp: timeOffset * 1000 });

      if (expectedToken === token) {
        // Return the matched 30-second step (always > 0) so callers can reject replays.
        return Math.floor(timeOffset / 30);
      }
    }

    return false;
  } catch (err) {
    console.error('[MFA] TOTP verification error:', err);
    return false;
  }
}

/**
 * Generate backup codes
 * @param {number} count - Number of backup codes to generate (default: 10)
 * @returns {Array<string>} Array of backup codes
 */
export function generateBackupCodes(count = 10) {
  const codes = [];

  for (let i = 0; i < count; i++) {
    // Generate 8-character alphanumeric code
    const code = randomBytes(4).toString('hex').toUpperCase();
    codes.push(code);
  }

  return codes;
}

/**
 * Hash backup code for storage
 * @param {string} code - Backup code
 * @returns {string} SHA-256 hash of the code
 */
export function hashBackupCode(code) {
  return createHash('sha256').update(code.toUpperCase()).digest('hex');
}

/**
 * Enroll user in MFA
 * @param {string} userId - User ID
 * @param {string} secret - TOTP secret
 * @param {Array<string>} backupCodes - Backup codes (unhashed)
 * @returns {Promise<void>}
 */
export async function enrollMFA(userId, secret, backupCodes) {
  // Hash backup codes before storage
  const hashedCodes = backupCodes.map(hashBackupCode);

  await query(
    `UPDATE users
     SET mfa_enabled = true,
         mfa_secret = $1,
         backup_codes = $2
     WHERE id = $3`,
    [secret, JSON.stringify(hashedCodes), userId]
  );

  console.log(`[MFA] User ${userId} enrolled in MFA`);
}

/**
 * Disable MFA for a user
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
export async function disableMFA(userId) {
  await query(
    `UPDATE users
     SET mfa_enabled = false,
         mfa_secret = NULL,
         backup_codes = NULL
     WHERE id = $1`,
    [userId]
  );

  console.log(`[MFA] MFA disabled for user ${userId}`);
}

/**
 * Verify backup code and mark as used
 * @param {string} userId - User ID
 * @param {string} code - Backup code to verify
 * @returns {Promise<boolean>} Whether the code was valid
 */
export async function verifyBackupCode(userId, code) {
  const user = await queryOne('SELECT backup_codes FROM users WHERE id = $1', [userId]);

  if (!user || !user.backup_codes) {
    return false;
  }

  const hashedCodes = JSON.parse(user.backup_codes);
  const codeHash = hashBackupCode(code);

  // Check if code exists
  const index = hashedCodes.indexOf(codeHash);

  if (index === -1) {
    return false;
  }

  // Remove used code, but only if nobody else consumed a code since we read the list:
  // two simultaneous logins with the same code cannot both succeed.
  hashedCodes.splice(index, 1);

  const updated = await query(
    'UPDATE users SET backup_codes = $1 WHERE id = $2 AND backup_codes = $3',
    [JSON.stringify(hashedCodes), userId, user.backup_codes]
  );
  if (!updated.rowCount) return false;

  console.log(`[MFA] Backup code used for user ${userId}, ${hashedCodes.length} codes remaining`);

  return true;
}

/**
 * Get remaining backup codes count
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of remaining backup codes
 */
export async function getRemainingBackupCodesCount(userId) {
  const user = await queryOne('SELECT backup_codes FROM users WHERE id = $1', [userId]);

  if (!user || !user.backup_codes) {
    return 0;
  }

  const hashedCodes = JSON.parse(user.backup_codes);
  return hashedCodes.length;
}

/**
 * Regenerate backup codes
 * @param {string} userId - User ID
 * @param {number} count - Number of codes to generate
 * @returns {Promise<Array<string>>} New backup codes (unhashed)
 */
export async function regenerateBackupCodes(userId, count = 10) {
  const newCodes = generateBackupCodes(count);
  const hashedCodes = newCodes.map(hashBackupCode);

  await query(
    'UPDATE users SET backup_codes = $1 WHERE id = $2',
    [JSON.stringify(hashedCodes), userId]
  );

  console.log(`[MFA] Backup codes regenerated for user ${userId}`);

  return newCodes;
}
