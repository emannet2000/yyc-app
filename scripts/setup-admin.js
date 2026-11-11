#!/usr/bin/env node
/**
 * Setup Admin/Broker Account for YYC Brokers
 * Creates an admin account with hidden password input
 */

import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import * as store from '../src/store.js';
import { close as closePg } from '../src/db/postgres.js';
import { close as closeRedis } from '../src/redis.js';

let muted = false;

const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  }
});

output.isTTY = process.stdout.isTTY;
output.columns = process.stdout.columns;

const rl = createInterface({
  input: process.stdin,
  output,
  terminal: !!process.stdin.isTTY
});

async function main() {
  try {
    if (!process.stdin.isTTY) {
      throw new Error('Run setup-admin interactively in your terminal.');
    }

    console.log('YYC Brokers - Create Admin/Broker Account');
    console.log('Password input is hidden.\n');

    // Initialize database
    await store.initStore();

    // Get admin details
    const name = await rl.question('Name: ');
    const email = await rl.question('Email: ');

    // Get password (hidden)
    let waiting = rl.question('Password (12+ characters): ');
    muted = true;
    let password = await waiting;
    muted = false;
    process.stdout.write('\n');

    // Confirm password (hidden)
    waiting = rl.question('Confirm password: ');
    muted = true;
    let confirm = await waiting;
    muted = false;
    process.stdout.write('\n');

    // Validate passwords match
    if (password !== confirm) {
      throw new Error('Passwords do not match.');
    }

    // Create admin account
    await store.createUser(
      {
        name,
        email,
        password,
        role: 'admin'
      },
      true // allowAdmin flag
    );

    console.log('\n✅ Broker account created successfully!');
    console.log('Log in through the YYC login screen.');

  } catch (e) {
    muted = false;
    console.error('\n❌ Error:', e.message);
    process.exitCode = 1;
  } finally {
    rl.close();
    await closePg();
    await closeRedis();
    process.exit();
  }
}

main();
