import { checkRateLimit } from '../redis.js';
import { AppError } from '../store.js';

/**
 * Redis-backed rate limiter middleware
 * Replaces in-memory Map for distributed rate limiting across multiple instances
 */

/**
 * Rate limit configuration for different endpoint types
 */
const RATE_LIMITS = {
  // Authentication endpoints (login, register)
  auth: {
    limit: 60,          // 60 requests per client address (accounts have their own limit)
    window: 900,        // per 15 minutes (900 seconds)
    message: 'Too many account attempts. Try again in 15 minutes.'
  },
  // API endpoints (general)
  api: {
    limit: 1000,        // 1000 requests
    window: 3600,       // per hour
    message: 'Rate limit exceeded. Try again later.'
  },
  // GPS location updates (high frequency)
  gps: {
    limit: 1000,        // 1000 updates
    window: 3600,       // per hour
    message: 'GPS update rate limit exceeded.'
  },
  // Email sending
  email: {
    limit: 10,          // 10 emails
    window: 3600,       // per hour
    message: 'Email rate limit exceeded. Try again later.'
  }
};

/**
 * Create a rate limiter middleware
 * @param {string} type - Rate limit type ('auth', 'api', 'gps', 'email')
 * @param {Function} keyFn - Optional function to generate custom key (receives req)
 * @returns {Function} Express middleware
 */
/**
 * The client's IP. Behind a reverse proxy or load balancer set TRUST_PROXY to the number
 * of proxies in front of the app (or "true" for one); otherwise every client shares the
 * proxy's address. Only the proxy-appended entries of X-Forwarded-For are trusted.
 */
export function clientIp(req) {
  const setting = process.env.TRUST_PROXY;
  const hops = setting === 'true' ? 1 : Number.parseInt(setting || '0', 10) || 0;
  const remote = req.socket.remoteAddress || 'unknown';
  if (hops < 1) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
  return forwarded[forwarded.length - hops] || remote;
}

export function createRateLimiter(type = 'api', keyFn = null) {
  const config = RATE_LIMITS[type] || RATE_LIMITS.api;

  return async (req, res, next) => {
    try {
      // Generate rate limit key
      const ip = clientIp(req);
      const customKey = keyFn ? keyFn(req) : null;
      const key = `ratelimit:${type}:${customKey || ip}`;

      // Check rate limit
      const { allowed, remaining } = await checkRateLimit(
        key,
        config.limit,
        config.window
      );

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', config.limit);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Date.now() + (config.window * 1000));

      if (!allowed) {
        throw new AppError(429, config.message);
      }

      next();
    } catch (err) {
      if (err instanceof AppError) {
        throw err;
      }
      // If Redis is down, log error but don't block requests
      console.error('Rate limit check failed:', err.message);
      next();
    }
  };
}

/**
 * Rate limiter for authentication endpoints (login, register)
 */
export const authRateLimiter = createRateLimiter('auth');

/**
 * Rate limiter for general API endpoints
 */
export const apiRateLimiter = createRateLimiter('api');

/**
 * Rate limiter for GPS location updates
 * Uses user ID as key instead of IP
 */
export const gpsRateLimiter = createRateLimiter('gps', (req) => {
  return req.user?.id || req.socket.remoteAddress;
});

/**
 * Rate limiter for email sending
 * Uses user ID as key
 */
export const emailRateLimiter = createRateLimiter('email', (req) => {
  return req.user?.id || req.socket.remoteAddress;
});
