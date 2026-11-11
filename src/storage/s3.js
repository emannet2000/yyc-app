import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';

/**
 * AWS S3 Storage Module for YYC Brokers
 * Handles document uploads with pre-signed URLs
 */

const region = process.env.AWS_REGION || 'us-east-1';
const bucket = process.env.AWS_S3_BUCKET || 'yyc-documents';

// Initialize S3 client
let s3Client = null;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  console.log(`[S3] Initialized with bucket: ${bucket}, region: ${region}`);
} else {
  console.warn('[S3] AWS credentials not configured. Document upload features will be disabled.');
}

/**
 * Generate a pre-signed upload URL
 * @param {string} userId - User ID uploading the document
 * @param {string} documentType - Type of document (license, insurance, registration, pod)
 * @param {string} fileExtension - File extension (pdf, jpg, png)
 * @returns {Promise<{uploadUrl: string, key: string}>}
 */
export async function getUploadUrl(userId, documentType, fileExtension) {
  if (!s3Client) {
    throw new Error('S3 not configured. Set AWS credentials in environment variables.');
  }

  // Validate document type
  const validTypes = ['license', 'insurance', 'registration', 'pod', 'invoice', 'receipt'];
  if (!validTypes.includes(documentType)) {
    throw new Error(`Invalid document type. Must be one of: ${validTypes.join(', ')}`);
  }

  // Validate file extension
  const validExtensions = ['pdf', 'jpg', 'jpeg', 'png'];
  const ext = fileExtension.toLowerCase();
  if (!validExtensions.includes(ext)) {
    throw new Error(`Invalid file extension. Must be one of: ${validExtensions.join(', ')}`);
  }

  // Generate unique key: documents/{userId}/{documentType}/{timestamp}-{random}.{ext}
  const timestamp = Date.now();
  const random = crypto.randomBytes(8).toString('hex');
  const key = `documents/${userId}/${documentType}/${timestamp}-${random}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: getContentType(ext),
    // Metadata
    Metadata: {
      userId,
      documentType,
      uploadedAt: new Date().toISOString()
    }
  });

  // Generate pre-signed URL valid for 15 minutes
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

  return { uploadUrl, key };
}

/**
 * Generate a pre-signed download URL
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL expiry in seconds (default: 1 hour)
 * @returns {Promise<string>}
 */
export async function getDownloadUrl(key, expiresIn = 3600) {
  if (!s3Client) {
    throw new Error('S3 not configured. Set AWS credentials in environment variables.');
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });

  return await getSignedUrl(s3Client, command, { expiresIn });
}

/**
 * Delete a document from S3
 * @param {string} key - S3 object key
 * @returns {Promise<void>}
 */
export async function deleteDocument(key) {
  if (!s3Client) {
    throw new Error('S3 not configured. Set AWS credentials in environment variables.');
  }

  const command = new DeleteObjectCommand({
    Bucket: bucket,
    Key: key
  });

  await s3Client.send(command);
  console.log(`[S3] Deleted document: ${key}`);
}

/**
 * Get content type based on file extension
 * @param {string} extension - File extension
 * @returns {string}
 */
function getContentType(extension) {
  const contentTypes = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png'
  };
  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
}

/**
 * Check if S3 is configured
 * @returns {boolean}
 */
export function isConfigured() {
  return s3Client !== null;
}

export async function verifyConnection() {
  if (!s3Client) throw new Error('AWS credentials are not configured');
  await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
  return { connected: true, bucket, region };
}
