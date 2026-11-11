import { query, queryOne, queryAll } from '../db/postgres.js';
import { randomUUID } from 'node:crypto';

/**
 * GPS Location Tracking Module for YYC Brokers
 * Handles real-time driver location tracking
 */

/**
 * Record GPS location
 * @param {Object} data - GPS location data
 * @returns {Promise<Object>}
 */
export async function recordLocation(data) {
  const {
    shipmentId,
    driverId,
    latitude,
    longitude,
    accuracy = null,
    speed = null,
    heading = null,
    altitude = null
  } = data;

  const id = randomUUID();

  await query(
    `INSERT INTO gps_locations (id, shipment_id, driver_id, latitude, longitude, accuracy, speed, heading, altitude, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [id, shipmentId, driverId, latitude, longitude, accuracy, speed, heading, altitude]
  );

  return await queryOne('SELECT * FROM gps_locations WHERE id = $1', [id]);
}

/**
 * Get latest location for a shipment
 * @param {string} shipmentId - Shipment ID
 * @returns {Promise<Object|null>}
 */
export async function getLatestLocation(shipmentId) {
  return await queryOne(
    `SELECT * FROM gps_locations
     WHERE shipment_id = $1
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [shipmentId]
  );
}

/**
 * Get location history for a shipment
 * @param {string} shipmentId - Shipment ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>}
 */
export async function getLocationHistory(shipmentId, options = {}) {
  const { limit = 100, since = null } = options;

  let sql = `SELECT * FROM gps_locations WHERE shipment_id = $1`;
  const params = [shipmentId];

  if (since) {
    sql += ` AND recorded_at > $2`;
    params.push(since);
  }

  sql += ` ORDER BY recorded_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  return await queryAll(sql, params);
}

/**
 * Get all active shipments with latest GPS locations
 * @returns {Promise<Array>}
 */
export async function getActiveShipmentLocations() {
  return await queryAll(
    `SELECT DISTINCT ON (gl.shipment_id)
       gl.*,
       s.status as shipment_status,
       s.store_id,
       s.driver_id,
       s.data as shipment_data
     FROM gps_locations gl
     JOIN shipments s ON gl.shipment_id = s.id
     WHERE s.status IN ('in_transit', 'picked_up')
     ORDER BY gl.shipment_id, gl.recorded_at DESC`
  );
}

/**
 * Delete old GPS data (privacy/retention policy)
 * @param {number} daysToKeep - Number of days to retain data
 * @returns {Promise<number>} Number of records deleted
 */
export async function cleanupOldLocations(daysToKeep = 90) {
  const result = await query(
    `DELETE FROM gps_locations
     WHERE recorded_at < NOW() - INTERVAL '${daysToKeep} days'`
  );

  const deletedCount = result.rowCount || 0;
  console.log(`[GPS] Deleted ${deletedCount} location records older than ${daysToKeep} days`);

  return deletedCount;
}

/**
 * Calculate distance between two GPS coordinates (Haversine formula)
 * @param {number} lat1 - Latitude 1
 * @param {number} lon1 - Longitude 1
 * @param {number} lat2 - Latitude 2
 * @param {number} lon2 - Longitude 2
 * @returns {number} Distance in kilometers
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;

  return distance;
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}
