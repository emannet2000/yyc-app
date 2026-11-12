import Redis from 'ioredis';

/**
 * Redis connection for YYC Brokers
 * Used for: sessions, rate limiting, WebSocket pub/sub
 *
 * Render provides REDIS_URL environment variable
 * Format: redis://user:password@host:port
 */

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis client
const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    if (targetErrors.some(e => err.message.includes(e))) {
      // Reconnect on specific errors
      return true;
    }
    return false;
  }
});

// Log connection events
redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('ready', () => {
  console.log('Redis ready');
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.on('close', () => {
  console.log('Redis connection closed');
});

redis.on('reconnecting', () => {
  console.log('Redis reconnecting...');
});

/**
 * Session operations
 */

/**
 * Store a session in Redis
 * @param {string} token - Session token (will be hashed)
 * @param {Object} data - Session data (user_id, csrf)
 * @param {number} ttl - Time to live in seconds (default: 12 hours)
 */
export async function setSession(token, data, ttl = 43200) {
  const key = `session:${token}`;
  await redis.setex(key, ttl, JSON.stringify(data));
}

/**
 * Get a session from Redis
 * @param {string} token - Session token
 * @returns {Promise<Object|null>} Session data or null
 */
export async function getSession(token) {
  const key = `session:${token}`;
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}

/**
 * Delete a session from Redis
 * @param {string} token - Session token
 */
export async function deleteSession(token) {
  const key = `session:${token}`;
  await redis.del(key);
}

/**
 * Invalidate every session a user created before now (e.g. after a password reset).
 * Kept for the 7-day maximum session lifetime.
 * @param {string} userId - User ID
 */
export async function revokeUserSessions(userId) {
  // Kept for the 7-day maximum session lifetime, so every older session stays revoked.
  await redis.setex(`sessions_revoked_before:${userId}`, 7 * 24 * 3600, String(Date.now()));
}

/**
 * @param {string} userId - User ID
 * @returns {Promise<number|null>} epoch ms before which this user's sessions are invalid
 */
export async function getSessionsRevokedAt(userId) {
  const value = await redis.get(`sessions_revoked_before:${userId}`);
  return value ? Number(value) : null;
}

/**
 * Clean up expired sessions (handled automatically by Redis TTL)
 * This is a no-op but kept for API compatibility
 */
export async function cleanupSessions() {
  // Redis handles expiry automatically with TTL
  return 0;
}

/**
 * Rate limiting operations
 */

/**
 * Check and increment rate limit
 * @param {string} key - Rate limit key (e.g., "ratelimit:127.0.0.1")
 * @param {number} limit - Maximum requests allowed
 * @param {number} window - Time window in seconds
 * @returns {Promise<{allowed: boolean, current: number, remaining: number}>}
 */
export async function checkRateLimit(key, limit, window) {
  const current = await redis.incr(key);

  // Set expiry on first request
  if (current === 1) {
    await redis.expire(key, window);
  }

  const allowed = current <= limit;
  const remaining = Math.max(0, limit - current);

  return { allowed, current, remaining };
}

/**
 * Reset rate limit for a key
 * @param {string} key - Rate limit key
 */
export async function resetRateLimit(key) {
  await redis.del(key);
}

/**
 * Email verification code operations
 */

/**
 * Store email verification code
 * @param {string} userId - User ID
 * @param {string} code - 6-digit verification code
 * @param {number} ttl - Time to live in seconds (default: 15 minutes)
 */
export async function setVerificationCode(userId, code, ttl = 900) {
  const key = `email_verify:${userId}`;
  await redis.setex(key, ttl, code);
}

/**
 * Get email verification code
 * @param {string} userId - User ID
 * @returns {Promise<string|null>} Verification code or null
 */
export async function getVerificationCode(userId) {
  const key = `email_verify:${userId}`;
  return await redis.get(key);
}

/**
 * Delete verification code
 * @param {string} userId - User ID
 */
export async function deleteVerificationCode(userId) {
  const key = `email_verify:${userId}`;
  await redis.del(key);
}

/**
 * Password reset token operations
 */

/**
 * Store password reset token
 * @param {string} token - Reset token
 * @param {string} userId - User ID
 * @param {number} ttl - Time to live in seconds (default: 1 hour)
 */
export async function setResetToken(token, userId, ttl = 3600) {
  const key = `reset_token:${token}`;
  await redis.setex(key, ttl, userId);
}

/**
 * Get user ID from reset token
 * @param {string} token - Reset token
 * @returns {Promise<string|null>} User ID or null
 */
export async function getResetToken(token) {
  const key = `reset_token:${token}`;
  return await redis.get(key);
}

/**
 * Delete reset token
 * @param {string} token - Reset token
 */
export async function deleteResetToken(token) {
  const key = `reset_token:${token}`;
  await redis.del(key);
}

/**
 * Health check
 * @returns {Promise<boolean>} True if Redis is healthy
 */
export async function healthCheck() {
  try {
    await redis.ping();
    return true;
  } catch (err) {
    console.error('Redis health check failed:', err);
    return false;
  }
}

/**
 * Close Redis connection
 * Call this on server shutdown
 */
export async function close() {
  await redis.quit();
  console.log('Redis connection closed');
}

// Export redis client for direct access if needed
export { redis };
export default redis;
