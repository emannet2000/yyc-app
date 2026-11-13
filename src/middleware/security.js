import helmet from 'helmet';
import compression from 'compression';

/**
 * Security middleware for production
 * Adds various security headers and optimizations
 */

/**
 * Get helmet configuration based on environment
 */
export function getHelmetConfig() {
  const isDevelopment = process.env.NODE_ENV === 'development';

  return helmet({
    // Content Security Policy
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Allow inline scripts in development for HMR
          ...(isDevelopment ? ["'unsafe-inline'"] : []),
        ],
        styleSrc: ["'self'", "'unsafe-inline'"], // Inline styles needed for React
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: [
          "'self'",
          // Stripe
          'https://api.stripe.com',
          // Sentry
          'https://*.sentry.io',
          // Socket.io in development
          ...(isDevelopment ? ['ws://localhost:*', 'http://localhost:*'] : []),
        ],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: [
          "'self'",
          // Stripe
          'https://js.stripe.com',
          'https://hooks.stripe.com',
        ],
        workerSrc: ["'self'", 'blob:'],
      },
    },

    // Prevent clickjacking
    frameguard: {
      action: 'deny',
    },

    // Hide X-Powered-By header
    hidePoweredBy: true,

    // Enable HSTS (HTTP Strict Transport Security)
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },

    // Prevent MIME type sniffing
    noSniff: true,

    // Referrer Policy
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin',
    },

    // XSS Protection (legacy browsers)
    xssFilter: true,
  });
}

/**
 * Compression middleware
 * Gzip compression for responses
 */
export function getCompressionMiddleware() {
  return compression({
    filter: (req, res) => {
      if (req.headers['x-no-compression']) {
        return false;
      }
      return compression.filter(req, res);
    },
    level: 6, // Default compression level (0-9)
    threshold: 1024, // Only compress responses larger than 1KB
  });
}

/**
 * Apply security middleware to HTTP request
 * This is a wrapper to use helmet and compression with raw HTTP server
 */
export async function applySecurityMiddleware(req, res) {
  return new Promise((resolve, reject) => {
    // Create a minimal Express-like API for helmet
    const next = (err) => {
      if (err) reject(err);
      else resolve();
    };

    // Apply helmet
    const helmetMiddleware = getHelmetConfig();
    helmetMiddleware(req, res, next);
  });
}

/**
 * Additional security headers for specific routes
 */
export function setAdditionalHeaders(res, options = {}) {
  const {
    noCache = false,
    cors = false,
    corsOrigin = '*',
  } = options;

  // Cache control
  if (noCache) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  // CORS headers (if needed)
  if (cors) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Permissions Policy (formerly Feature Policy)
  res.setHeader('Permissions-Policy', [
    'accelerometer=()',
    'camera=()',
    'geolocation=(self)',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=()',
    'payment=(self)',
    'usb=()',
  ].join(', '));

  return res;
}

/**
 * Validate request origin for CSRF protection
 */
export function validateOrigin(req, allowedOrigins = []) {
  const origin = req.headers.origin || req.headers.referer;

  if (!origin) {
    // Allow requests without origin (e.g., server-to-server)
    return true;
  }

  const isAllowed = allowedOrigins.some(allowed => {
    if (allowed === '*') return true;
    return origin.startsWith(allowed);
  });

  return isAllowed;
}

/**
 * Rate limiting helper (works with existing rate limit middleware)
 */
export function getRateLimitConfig(type) {
  const configs = {
    auth: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 5, // 5 requests per window
    },
    api: {
      windowMs: 1 * 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute
    },
    upload: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 10, // 10 uploads per hour
    },
  };

  return configs[type] || configs.api;
}

export default {
  getHelmetConfig,
  getCompressionMiddleware,
  applySecurityMiddleware,
  setAdditionalHeaders,
  validateOrigin,
  getRateLimitConfig,
};
