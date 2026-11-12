import { query, queryOne, queryAll } from '../db/postgres.js';
import { randomUUID } from 'node:crypto';
import { getUploadUrl, getDownloadUrl, deleteDocument as deleteFromS3, headObject } from './s3.js';

/**
 * Documents Module for YYC Brokers
 * Handles document CRUD operations and approval workflow
 */

/**
 * Generate pre-signed upload URL for a document
 * @param {string} userId - User ID uploading the document
 * @param {string} documentType - Type of document
 * @param {string} fileExtension - File extension
 * @returns {Promise<{uploadUrl: string, uploadId: string}>}
 */
export async function createUploadUrl(userId, documentType, fileExtension) {
  const { uploadUrl, key } = await getUploadUrl(userId, documentType, fileExtension);

  // Store temporary upload ID in a Map (or Redis) for verification after upload
  const uploadId = randomUUID();

  return { uploadUrl, uploadId, s3Key: key };
}

/**
 * Remove an uploaded file that will not be recorded (e.g. too large).
 * @param {string} s3Key - Object key
 */
export async function discardUpload(s3Key) {
  await deleteFromS3(s3Key);
}

/**
 * Confirm an uploaded file exists in storage.
 * @param {string} s3Key - Object key returned with the upload URL
 * @returns {Promise<{size: number|null, contentType: string|null}|null>}
 */
export async function storedObject(s3Key) {
  return await headObject(s3Key);
}

/**
 * Create document record after successful upload
 * @param {Object} data - Document data
 * @returns {Promise<Object>} Created document
 */
export async function createDocument(data) {
  const {
    userId,
    shipmentId = null,
    type,
    s3Key,
    filename,
    fileSize = null,
    contentType = null,
    expiryDate = null
  } = data;

  const id = randomUUID();

  await query(
    `INSERT INTO documents (id, user_id, shipment_id, type, s3_key, filename, file_size, content_type, expiry_date, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [id, userId, shipmentId, type, s3Key, filename, fileSize, contentType, expiryDate, 'pending']
  );

  return await getDocument(id);
}

/**
 * Get document by ID
 * @param {string} documentId - Document ID
 * @returns {Promise<Object|null>}
 */
export async function getDocument(documentId) {
  return await queryOne('SELECT * FROM documents WHERE id = $1', [documentId]);
}

/**
 * Get all documents for a user
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>}
 */
export async function getUserDocuments(userId, options = {}) {
  const { type = null, status = null } = options;

  let sql = 'SELECT * FROM documents WHERE user_id = $1';
  const params = [userId];

  if (type) {
    sql += ' AND type = $2';
    params.push(type);
  }

  if (status) {
    sql += ` AND status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ' ORDER BY created_at DESC';

  return await queryAll(sql, params);
}

/**
 * Get all documents for a shipment
 * @param {string} shipmentId - Shipment ID
 * @returns {Promise<Array>}
 */
export async function getShipmentDocuments(shipmentId) {
  return await queryAll(
    'SELECT * FROM documents WHERE shipment_id = $1 ORDER BY created_at DESC',
    [shipmentId]
  );
}

/**
 * Get all pending documents (for admin review)
 * @returns {Promise<Array>}
 */
export async function getPendingDocuments() {
  return await queryAll(
    `SELECT d.*, u.name as user_name, u.email as user_email, u.role as user_role
     FROM documents d
     JOIN users u ON d.user_id = u.id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC`
  );
}

/**
 * Get expiring documents (within next 30 days)
 * @returns {Promise<Array>}
 */
export async function getExpiringDocuments() {
  return await queryAll(
    `SELECT d.*, u.name as user_name, u.email as user_email, u.role as user_role
     FROM documents d
     JOIN users u ON d.user_id = u.id
     WHERE d.expiry_date IS NOT NULL
       AND d.expiry_date <= (NOW() AT TIME ZONE 'America/Edmonton')::date + 30
       AND d.expiry_date > (NOW() AT TIME ZONE 'America/Edmonton')::date
       AND d.status = 'approved'
     ORDER BY d.expiry_date ASC`
  );
}

/**
 * Approve a document
 * @param {string} documentId - Document ID
 * @param {string} adminId - Admin user ID
 * @param {string} notes - Optional review notes
 * @returns {Promise<Object>}
 */
export async function approveDocument(documentId, adminId, notes = null) {
  // Only pending documents can be approved; an expired one must be re-uploaded.
  const result = await query(
    `UPDATE documents
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(), notes = $2
     WHERE id = $3 AND status = 'pending' AND (expiry_date IS NULL OR expiry_date >= (NOW() AT TIME ZONE 'America/Edmonton')::date)
     RETURNING id`,
    [adminId, notes, documentId]
  );
  return result.rowCount ? await getDocument(documentId) : null;
}

/**
 * Reject a document
 * @param {string} documentId - Document ID
 * @param {string} adminId - Admin user ID
 * @param {string} notes - Rejection reason
 * @returns {Promise<Object>}
 */
export async function rejectDocument(documentId, adminId, notes) {
  // Pending documents can be rejected, and approved ones revoked (e.g. found invalid later).
  const result = await query(
    `UPDATE documents
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), notes = $2
     WHERE id = $3 AND status IN ('pending', 'approved')
     RETURNING id`,
    [adminId, notes, documentId]
  );
  return result.rowCount ? await getDocument(documentId) : null;
}

/**
 * Mark every approved document past its expiry date as expired.
 * @returns {Promise<Array<{id: string, user_id: string, type: string}>>} the expired documents
 */
export async function expireDocuments() {
  const result = await query(
    `UPDATE documents SET status = 'expired'
     -- Calgary's date, not the database's UTC date: a document is valid through its whole last day.
     WHERE status IN ('approved', 'pending') AND expiry_date IS NOT NULL AND expiry_date < (NOW() AT TIME ZONE 'America/Edmonton')::date
     RETURNING id, user_id, type`
  );
  return result.rows;
}

/**
 * Mark document as expired
 * @param {string} documentId - Document ID
 * @returns {Promise<Object>}
 */
export async function markExpired(documentId) {
  await query(
    'UPDATE documents SET status = $1 WHERE id = $2',
    ['expired', documentId]
  );

  return await getDocument(documentId);
}

/**
 * Delete a document
 * @param {string} documentId - Document ID
 * @returns {Promise<void>}
 */
export async function deleteDocument(documentId) {
  const doc = await getDocument(documentId);

  if (!doc) {
    throw new Error('Document not found');
  }

  // Delete from S3
  try {
    await deleteFromS3(doc.s3_key);
  } catch (err) {
    console.error('[Documents] Failed to delete from S3:', err);
    // Continue with database deletion even if S3 fails
  }

  // Delete from database
  await query('DELETE FROM documents WHERE id = $1', [documentId]);
}

/**
 * Get download URL for a document
 * @param {string} documentId - Document ID
 * @param {number} expiresIn - URL expiry in seconds
 * @returns {Promise<string>}
 */
export async function getDocumentDownloadUrl(documentId, expiresIn = 3600) {
  const doc = await getDocument(documentId);

  if (!doc) {
    throw new Error('Document not found');
  }

  return await getDownloadUrl(doc.s3_key, expiresIn);
}
