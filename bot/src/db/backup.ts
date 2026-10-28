import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.ts';
import type { DB } from './index.ts';

/**
 * Consistent online backup using SQLite's VACUUM INTO (safe while the bot runs).
 * Old backups are pruned; restores are documented in README (stop bot, copy file,
 * open, verify `/admin reconcile`, start bot).
 */
export function backupDatabase(db: DB, directory: string, options: { keep?: number; now?: number } = {}): string {
  const keep = Math.max(1, options.keep ?? 7);
  const now = options.now ?? Date.now();
  mkdirSync(directory, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = join(directory, `fluxtip-${stamp}.db`);

  db.pragma('wal_checkpoint(TRUNCATE)');
  const escaped = target.replaceAll('\\', '\\\\').replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  const files = readdirSync(directory)
    .filter((file) => file.startsWith('fluxtip-') && file.endsWith('.db'))
    .map((file) => ({ file, mtime: statSync(join(directory, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of files.slice(keep)) {
    try {
      unlinkSync(join(directory, old.file));
    } catch {
      logger.warn('Could not prune old backup', { file: old.file });
    }
  }
  logger.info('Database backup written', { target, kept: Math.min(files.length, keep) });
  return target;
}
