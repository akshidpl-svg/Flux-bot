import { loadConfig, loadDotEnv } from '../config.ts';
import { backupDatabase } from '../db/backup.ts';
import { openDatabase } from '../db/index.ts';
import { configureLogger, logger } from '../logger.ts';

/** CLI backup entry point (systemd timer or cron). Never prints secrets. */
function main(): void {
  loadDotEnv();
  const config = loadConfig();
  configureLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  const target = backupDatabase(db, config.backupDir, { keep: 7 });
  db.close();
  process.stdout.write(`${target}\n`);
}

try {
  main();
} catch (error) {
  logger.error('Backup failed', { error });
  process.exitCode = 1;
}
