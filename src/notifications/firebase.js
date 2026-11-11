import admin from 'firebase-admin';

/**
 * Firebase Cloud Messaging Integration for YYC Brokers
 * Handles push notifications to iOS, Android, and Web
 */

let firebaseApp = null;

// Initialize Firebase Admin SDK
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    console.log('[Firebase] Initialized');
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
    console.warn('[Firebase] Push notifications will be disabled');
  }
} else {
  console.warn('[Firebase] Service account not configured. Set FIREBASE_SERVICE_ACCOUNT environment variable.');
}

/**
 * Send push notification to a specific device token
 * @param {string} token - FCM device token
 * @param {Object} notification - Notification payload
 * @param {Object} data - Custom data payload
 * @returns {Promise<string>} Message ID
 */
export async function sendNotification(token, notification, data = {}) {
  if (!firebaseApp) {
    throw new Error('Firebase not configured');
  }

  const message = {
    token,
    notification: {
      title: notification.title,
      body: notification.body,
      imageUrl: notification.imageUrl || undefined
    },
    data: {
      ...data,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      }
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1
        }
      }
    }
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log(`[Firebase] Notification sent: ${messageId}`);
    return messageId;
  } catch (err) {
    console.error('[Firebase] Failed to send notification:', err);
    throw err;
  }
}

/**
 * Send push notification to multiple device tokens
 * @param {Array<string>} tokens - Array of FCM device tokens
 * @param {Object} notification - Notification payload
 * @param {Object} data - Custom data payload
 * @returns {Promise<Object>} Batch response
 */
export async function sendMulticastNotification(tokens, notification, data = {}) {
  if (!firebaseApp) {
    throw new Error('Firebase not configured');
  }

  if (tokens.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [] };
  }

  const message = {
    tokens,
    notification: {
      title: notification.title,
      body: notification.body,
      imageUrl: notification.imageUrl || undefined
    },
    data: {
      ...data,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high'
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1
        }
      }
    }
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[Firebase] Multicast sent: ${response.successCount} succeeded, ${response.failureCount} failed`);

    // Handle failed tokens
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
          console.error(`[Firebase] Token ${tokens[idx]} failed:`, resp.error);
        }
      });
    }

    return response;
  } catch (err) {
    console.error('[Firebase] Failed to send multicast:', err);
    throw err;
  }
}

/**
 * Send data-only notification (silent push)
 * @param {string} token - FCM device token
 * @param {Object} data - Data payload
 * @returns {Promise<string>} Message ID
 */
export async function sendDataMessage(token, data) {
  if (!firebaseApp) {
    throw new Error('Firebase not configured');
  }

  const message = {
    token,
    data: {
      ...data,
      timestamp: new Date().toISOString()
    },
    android: {
      priority: 'high'
    },
    apns: {
      headers: {
        'apns-priority': '10'
      },
      payload: {
        aps: {
          contentAvailable: true
        }
      }
    }
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log(`[Firebase] Data message sent: ${messageId}`);
    return messageId;
  } catch (err) {
    console.error('[Firebase] Failed to send data message:', err);
    throw err;
  }
}

/**
 * Send notification to a topic
 * @param {string} topic - Topic name
 * @param {Object} notification - Notification payload
 * @param {Object} data - Data payload
 * @returns {Promise<string>} Message ID
 */
export async function sendToTopic(topic, notification, data = {}) {
  if (!firebaseApp) {
    throw new Error('Firebase not configured');
  }

  const message = {
    topic,
    notification: {
      title: notification.title,
      body: notification.body
    },
    data: {
      ...data,
      timestamp: new Date().toISOString()
    }
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log(`[Firebase] Topic notification sent to ${topic}: ${messageId}`);
    return messageId;
  } catch (err) {
    console.error('[Firebase] Failed to send topic notification:', err);
    throw err;
  }
}

/**
 * Subscribe tokens to a topic
 * @param {Array<string>} tokens - Device tokens
 * @param {string} topic - Topic name
 * @returns {Promise<void>}
 */
export async function subscribeToTopic(tokens, topic) {
  if (!firebaseApp) {
    throw new Error('Firebase not configured');
  }

  try {
    await admin.messaging().subscribeToTopic(tokens, topic);
    console.log(`[Firebase] ${tokens.length} tokens subscribed to topic: ${topic}`);
  } catch (err) {
    console.error('[Firebase] Failed to subscribe to topic:', err);
    throw err;
  }
}

/**
 * Check if Firebase is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return firebaseApp !== null;
}
