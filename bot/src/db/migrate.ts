import { loadConfig, loadDotEnv } from '../config.ts';
import { configureLogger, logger } from '../logger.ts';
import { migrate, openDatabase } from './index.ts';

function main(): void {
  loadDotEnv();
  const config = loadConfig();
  configureLogger(config.logLevel, [config.discordToken]);
  const db = openDatabase(config.databasePath);
  const applied = migrate(db);
  const version = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v;
  db.close();
  logger.info('Database ready', { path: config.databasePath, applied, version });
}

try {
  main();
} catch (error) {
  logger.error('Migration failed', { error });
  process.exitCode = 1;
}
