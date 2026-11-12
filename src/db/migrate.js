#!/usr/bin/env node
/**
 * SQLite to PostgreSQL Migration Script
 *
 * Migrates all data from the existing SQLite database to PostgreSQL
 * Run this once during the transition to production
 *
 * Usage: npm run migrate
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { initSchema, transaction, queryOne, queryAll } from './postgres.js';

const sqliteFile = resolve(process.env.YYC_DATA_DIR || 'data', 'yyc.sqlite');

async function migrate() {
  console.log('🚀 Starting SQLite → PostgreSQL migration...\n');

  // Open SQLite database
  let sqliteDb;
  try {
    // DatabaseSync silently creates an empty file when it is missing, so check first.
    if (!existsSync(sqliteFile)) throw new Error('not found');
    sqliteDb = new DatabaseSync(sqliteFile, { readOnly: true });
    console.log(`✓ Connected to SQLite: ${sqliteFile}`);
  } catch (err) {
    console.log(`ℹ No existing SQLite database found at ${sqliteFile}`);
    console.log('Starting fresh with PostgreSQL schema...\n');

    // Initialize PostgreSQL schema
    await initSchema();
    console.log('✓ PostgreSQL schema initialized');
    console.log('\n✅ Migration complete - ready for production!\n');
    process.exit(0);
  }

  try {
    // Initialize PostgreSQL schema
    console.log('Initializing PostgreSQL schema...');
    await initSchema();
    console.log('✓ PostgreSQL schema created\n');

    // Migrate data in a transaction
    await transaction(async (client) => {
      // 1. Migrate users
      console.log('Migrating users...');
      const users = sqliteDb.prepare('SELECT * FROM users').all();
      let userCount = 0;

      for (const user of users) {
        await client.query(
          // Accounts from the SQLite app were already in use, so treat their email as verified;
          // otherwise every migrated store and driver is locked out at login.
          `INSERT INTO users (id, email, password_hash, role, name, profile, approved, disabled, email_verified, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            user.id,
            user.email,
            user.password_hash,
            user.role,
            user.name,
            user.profile,
            user.approved === 1,
            user.disabled === 1,
            user.created_at
          ]
        );
        userCount++;
      }
      console.log(`✓ Migrated ${userCount} users`);

      // 2. Migrate trucks
      console.log('Migrating trucks...');
      const trucks = sqliteDb.prepare('SELECT * FROM trucks').all();
      let truckCount = 0;

      for (const truck of trucks) {
        await client.query(
          `INSERT INTO trucks (id, driver_id, plate, profile, approved)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [
            truck.id,
            truck.driver_id,
            truck.plate,
            truck.profile,
            truck.approved === 1
          ]
        );
        truckCount++;
      }
      console.log(`✓ Migrated ${truckCount} trucks`);

      // 3. Migrate sessions (optional, they'll expire anyway)
      // Sessions now live in Redis; SQLite sessions are not carried over and everyone signs in again.
      console.log('ℹ Sessions are not migrated (they now live in Redis). Everyone must sign in again.');

      console.log('Migrating shipments...');
      const shipments = sqliteDb.prepare('SELECT * FROM shipments').all();
      let shipmentCount = 0;

      for (const shipment of shipments) {
        await client.query(
          `INSERT INTO shipments (id, store_id, driver_id, offered_to, status, version, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING`,
          [
            shipment.id,
            shipment.store_id,
            shipment.driver_id,
            shipment.offered_to,
            shipment.status,
            shipment.version,
            shipment.data,
            shipment.created_at,
            shipment.updated_at
          ]
        );
        shipmentCount++;
      }
      console.log(`✓ Migrated ${shipmentCount} shipments`);

      // 5. Migrate audit logs
      console.log('Migrating audit logs...');
      const audits = sqliteDb.prepare('SELECT * FROM audit ORDER BY id').all();
      let auditCount = 0;

      for (const audit of audits) {
        await client.query(
          // Re-running the migration must not duplicate history.
          `INSERT INTO audit (shipment_id, actor_id, event, created_at)
           SELECT $1::text, $2::uuid, $3::text, $4::timestamptz
           WHERE NOT EXISTS (
             SELECT 1 FROM audit WHERE shipment_id IS NOT DISTINCT FROM $1::text AND actor_id IS NOT DISTINCT FROM $2::uuid
               AND event = $3::text AND created_at = $4::timestamptz)`,
          [
            audit.shipment_id,
            audit.actor_id,
            audit.event,
            audit.created_at
          ]
        );
        auditCount++;
      }
      console.log(`✓ Processed ${auditCount} audit records (already-migrated ones skipped)`);

      // 6. Migrate counters
      console.log('Migrating counters...');
      const counters = sqliteDb.prepare('SELECT * FROM counters').all();
      let counterCount = 0;

      for (const counter of counters) {
        await client.query(
          // Never move a counter backwards: that would reissue existing shipment IDs.
          `INSERT INTO counters (name, value)
           VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
          [counter.name, counter.value]
        );
        counterCount++;
      }
      // Also keep the shipment counter ahead of every shipment already in PostgreSQL.
      await client.query(
        `UPDATE counters SET value = GREATEST(value, COALESCE((SELECT MAX(CAST(substr(id, 5) AS INTEGER)) FROM shipments WHERE id ~ '^YYC-[0-9]+$'), 0))
         WHERE name = 'shipment'`
      );
      console.log(`✓ Migrated ${counterCount} counters`);
    });

    // Verify migration
    console.log('\nVerifying migration...');
    const pgUserCount = await queryOne('SELECT COUNT(*) as count FROM users');
    const pgShipmentCount = await queryOne('SELECT COUNT(*) as count FROM shipments');

    console.log(`✓ PostgreSQL users: ${pgUserCount.count}`);
    console.log(`✓ PostgreSQL shipments: ${pgShipmentCount.count}`);

    console.log('\n✅ Migration completed successfully!\n');
    console.log('Next steps:');
    console.log('1. Test the application with PostgreSQL');
    console.log('2. Backup the SQLite database as a safety measure');
    console.log('3. Deploy to Render with DATABASE_URL configured\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    sqliteDb.close();
    process.exit(0);
  }
}

// Run migration
migrate();
