import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { Pool } = pg;

/**
 * PostgreSQL connection pool for YYC Brokers
 * Replaces SQLite DatabaseSync for production scalability
 */

// Database connection URL from environment
// Format: postgresql://user:password@host:port/database
// Render provides this as DATABASE_URL
const connectionString = process.env.DATABASE_URL || 'postgresql://localhost:5432/yyc_dev';

// Create connection pool
const pool = new Pool({
  connectionString,
  min: 2,          // Minimum connections
  max: 10,         // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  process.exit(-1);
});

/**
 * Initialize database schema
 * Runs schema.sql to create tables and indexes
 */
export async function initSchema() {
  const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('PostgreSQL schema initialized successfully');
  } finally {
    client.release();
  }
}

/**
 * Execute a query with parameters
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;

  // Log slow queries (> 100ms)
  if (duration > 100) {
    console.warn('Slow query:', { text, duration, rows: res.rowCount });
  }

  return res;
}

/**
 * Get a single row
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|null>} Single row or null
 */
export async function queryOne(text, params) {
  const res = await query(text, params);
  return res.rows[0] || null;
}

/**
 * Get all rows
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Array of rows
 */
export async function queryAll(text, params) {
  const res = await query(text, params);
  return res.rows;
}

/**
 * Execute a transaction
 * @param {Function} callback - Async function that receives a client
 * @returns {Promise<any>} Result of the callback
 */
export async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Close the connection pool
 * Call this on server shutdown
 */
export async function close() {
  await pool.end();
  console.log('PostgreSQL connection pool closed');
}

// Export pool for direct access if needed
export { pool };
