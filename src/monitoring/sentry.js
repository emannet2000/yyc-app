import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

/**
 * Initialize Sentry for error tracking and performance monitoring
 */
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Sentry] Warning: SENTRY_DSN not configured. Error tracking disabled.');
    }
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',

    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

    // Profiling
    profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    integrations: [
      nodeProfilingIntegration(),
    ],

    // Error filtering
    beforeSend(event, hint) {
      // Don't send errors in development unless explicitly enabled
      if (process.env.NODE_ENV === 'development' && !process.env.SENTRY_ENABLE_DEV) {
        return null;
      }

      // Filter out known non-critical errors
      const error = hint.originalException;
      if (error && error.message) {
        // Ignore expected errors
        if (error.message.includes('Session expired')) {
          return null;
        }
        if (error.message.includes('Not found')) {
          return null;
        }
      }

      return event;
    },

    // Additional context
    initialScope: {
      tags: {
        component: 'backend',
      },
    },
  });

  console.log('[Sentry] Error tracking initialized');
}

/**
 * Capture an exception with Sentry
 */
export function captureException(error, context = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error, {
      extra: context,
    });
  }

  // Always log to console as well
  console.error('[Error]', error);
}

/**
 * Capture a message with Sentry
 */
export function captureMessage(message, level = 'info', context = {}) {
  if (process.env.SENTRY_DSN) {
    Sentry.captureMessage(message, {
      level,
      extra: context,
    });
  }

  console.log(`[${level.toUpperCase()}]`, message);
}

/**
 * Add user context to Sentry
 */
export function setUser(user) {
  if (process.env.SENTRY_DSN && user) {
    Sentry.setUser({
      id: user.id,
      email: user.email,
      role: user.role,
    });
  }
}

/**
 * Clear user context
 */
export function clearUser() {
  if (process.env.SENTRY_DSN) {
    Sentry.setUser(null);
  }
}

/**
 * Start a performance transaction
 */
export function startTransaction(name, op) {
  if (process.env.SENTRY_DSN) {
    return Sentry.startTransaction({ name, op });
  }
  return null;
}

export default Sentry;
