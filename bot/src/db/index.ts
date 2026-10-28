import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../logger.ts';
import { MIGRATIONS } from './migrations.ts';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');
  return db;
}

/** Applies pending migrations. Safe to call on every boot. */
export function migrate(db: DB): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(appliedRows.map((row) => row.version));
  let count = 0;

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    run.immediate();
    count += 1;
    logger.info('Applied migration', { version: migration.version, name: migration.name });
  }
  return count;
}

/**
 * Runs `fn` in an immediate (write-locked) transaction. better-sqlite3 is
 * synchronous, so writes from this process are serialized; BEGIN IMMEDIATE also
 * protects against a second process (e.g. a CLI tool) writing concurrently.
 */
export function transaction<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function getState(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function isPaused(db: DB): boolean {
  return getState(db, 'paused') === '1';
}

export function setPaused(db: DB, paused: boolean, actorId: string): void {
  setState(db, 'paused', paused ? '1' : '0');
  db.prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
    actorId,
    paused ? 'pause' : 'resume',
    'system',
    paused ? 'New transfers and withdrawals paused' : 'Transfers and withdrawals resumed',
    Date.now(),
  );
}

export function countRows(db: DB, table: string): number {
  // Table names are internal constants, never user input.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function audit(db: DB, actorId: string, action: string, target: string | null, details?: unknown): void {
  db.prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
    actorId,
    action,
    target,
    details === undefined ? null : JSON.stringify(details),
    Date.now(),
  );
}
