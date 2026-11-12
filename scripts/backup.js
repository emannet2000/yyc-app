#!/usr/bin/env node
/**
 * PostgreSQL backup for YYC Brokers.
 * Writes a compressed custom-format dump (restore with pg_restore) to ./backups.
 * Needs the pg_dump client on PATH. In the local Docker stack, use ./backup-yyc.sh instead,
 * which runs pg_dump inside the postgres container.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync, createWriteStream, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Point it at the PostgreSQL database to back up.');
  process.exit(1);
}

const directory = resolve(process.env.YYC_BACKUP_DIR || 'backups');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const target = resolve(directory, `yyc-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);

const out = createWriteStream(target, { mode: 0o600 });
// Pass the URL through the environment so the password does not appear in the process list.
const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--dbname', databaseUrl.replace(/:[^:@/]*@/, '@')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PGPASSWORD: decodeURIComponent(new URL(databaseUrl).password || '') }
});
dump.stdout.pipe(out);

dump.on('error', error => {
  out.destroy();
  try { unlinkSync(target); } catch {}
  console.error(error.code === 'ENOENT'
    ? 'pg_dump is not installed here. Install the PostgreSQL client, or run ./backup-yyc.sh for the Docker stack.'
    : `Backup failed: ${error.message}`);
  process.exit(1);
});

dump.on('close', code => {
  out.end(() => {
    if (code !== 0) {
      try { unlinkSync(target); } catch {}
      console.error(`pg_dump exited with code ${code}; no backup was written.`);
      process.exit(1);
    }
    chmodSync(target, 0o600);
    console.log(`Backup created: ${target} (${statSync(target).size} bytes)`);
  });
});
