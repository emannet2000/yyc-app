import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { session, getShipment } from '../store.js';
import { authorizeShipment } from './authorization.js';

/**
 * WebSocket Server for YYC Brokers
 * Real-time updates for shipments, GPS, payments, and notifications
 */

let io = null;
let pubClient = null;
let subClient = null;

/**
 * Initialize Socket.io server with Redis adapter
 * @param {http.Server} httpServer - HTTP server instance
 * @param {Object} options - Configuration options
 * @returns {Server} Socket.io server instance
 */
export async function initializeWebSocket(httpServer, options = {}) {
  const { secure = process.env.NODE_ENV === 'production', publicOrigin = process.env.PUBLIC_ORIGIN || '' } = options;

  // Create Socket.io server
  io = new Server(httpServer, {
    cors: {
      origin: publicOrigin || (secure ? 'https://localhost:3000' : 'http://localhost:3000'),
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  // Set up Redis adapter for multi-instance support
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  try {
    pubClient = new Redis(redisUrl, { lazyConnect: true, retryStrategy: () => null });
    pubClient.on('error', () => {});
    subClient = pubClient.duplicate();
    subClient.on('error', () => {});

    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));

    console.log('[WebSocket] Redis adapter initialized');
  } catch (err) {
    pubClient?.disconnect();
    subClient?.disconnect();
    pubClient = subClient = null;
    console.warn('[WebSocket] Failed to initialize Redis adapter:', err.message);
    console.warn('[WebSocket] Running without Redis adapter (single instance only)');
  }

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      // Extract session token from cookie or auth header
      const cookies = socket.handshake.headers.cookie || '';
      const tokenMatch = cookies.match(/yyc_session=([a-f0-9]{64})/);
      const token = tokenMatch?.[1] || socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      // Verify session
      const authenticated = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) ? await session(token) : null;

      if (!authenticated) {
        return next(new Error('Invalid or expired session'));
      }

      // Attach user info to socket
      socket.userId = authenticated.user.id;
      socket.userRole = authenticated.user.role;
      socket.sessionToken = token;

      console.log(`[WebSocket] User ${session.user_id} connected (${socket.id})`);

      next();
    } catch (err) {
      console.error('[WebSocket] Authentication error:', err);
      next(new Error('Authentication failed'));
    }
  });

  // Connection handling
  io.on('connection', (socket) => {
    // Join user-specific room
    socket.join(`user:${socket.userId}`);

    // Join role-specific room
    socket.join(`role:${socket.userRole}`);

    console.log(`[WebSocket] ${socket.userId} joined rooms: user:${socket.userId}, role:${socket.userRole}`);

    // Handle custom events
    socket.on('join:shipment', async (shipmentId, acknowledge) => {
      try {
        await authorizeShipment(socket.sessionToken, shipmentId, { session, getShipment });
        await socket.join(`shipment:${shipmentId}`);
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      } catch {
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: 'Shipment access denied' });
      }
    });

    socket.on('leave:shipment', (shipmentId) => {
      socket.leave(`shipment:${shipmentId}`);
      console.log(`[WebSocket] ${socket.userId} left shipment:${shipmentId}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[WebSocket] ${socket.userId} disconnected (${socket.id}): ${reason}`);
    });

    socket.on('error', (err) => {
      console.error(`[WebSocket] Socket error for ${socket.userId}:`, err);
    });
  });

  console.log('[WebSocket] Server initialized');

  return io;
}

/**
 * Broadcast shipment update to relevant users
 * @param {string} shipmentId - Shipment ID
 * @param {Object} data - Update data
 */
export function broadcastShipmentUpdate(shipmentId, data) {
  if (!io) {
    console.warn('[WebSocket] Server not initialized');
    return;
  }

  io.to(`shipment:${shipmentId}`).emit('shipment:update', {
    shipmentId,
    ...data,
    timestamp: new Date().toISOString()
  });

  console.log(`[WebSocket] Broadcasted shipment:update for ${shipmentId}`);
}

/**
 * Broadcast GPS location update
 * @param {string} shipmentId - Shipment ID
 * @param {Object} location - GPS location data
 */
export function broadcastGPSUpdate(shipmentId, location) {
  if (!io) return;

  io.to(`shipment:${shipmentId}`).emit('gps:update', {
    shipmentId,
    location,
    timestamp: new Date().toISOString()
  });
}

/**
 * Broadcast payment update
 * @param {string} shipmentId - Shipment ID
 * @param {Object} paymentData - Payment status data
 */
export function broadcastPaymentUpdate(shipmentId, paymentData) {
  if (!io) return;

  io.to(`shipment:${shipmentId}`).emit('payment:update', {
    shipmentId,
    ...paymentData,
    timestamp: new Date().toISOString()
  });

  console.log(`[WebSocket] Broadcasted payment:update for ${shipmentId}`);
}

/**
 * Send notification to specific user
 * @param {string} userId - User ID
 * @param {Object} notification - Notification data
 */
export function sendUserNotification(userId, notification) {
  if (!io) return;

  io.to(`user:${userId}`).emit('notification', {
    ...notification,
    timestamp: new Date().toISOString()
  });

  console.log(`[WebSocket] Sent notification to user ${userId}`);
}

/**
 * Broadcast to all admins
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
export function broadcastToAdmins(event, data) {
  if (!io) return;

  io.to('role:admin').emit(event, {
    ...data,
    timestamp: new Date().toISOString()
  });

  console.log(`[WebSocket] Broadcasted ${event} to admins`);
}

/**
 * Broadcast to all drivers
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
export function broadcastToDrivers(event, data) {
  if (!io) return;

  io.to('role:driver').emit(event, {
    ...data,
    timestamp: new Date().toISOString()
  });

  console.log(`[WebSocket] Broadcasted ${event} to drivers`);
}

/**
 * Get connected clients count
 * @returns {Promise<number>}
 */
export async function getConnectedClients() {
  if (!io) return 0;

  const sockets = await io.fetchSockets();
  return sockets.length;
}

/**
 * Close WebSocket server
 */
export async function closeWebSocket() {
  if (io) {
    io.close();
    console.log('[WebSocket] Server closed');
  }

  if (pubClient) {
    await pubClient.quit();
  }

  if (subClient) {
    await subClient.quit();
  }
}

/**
 * Get Socket.io instance
 * @returns {Server|null}
 */
export function getIO() {
  return io;
}
