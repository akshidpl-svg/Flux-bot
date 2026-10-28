import { once } from 'node:events';
import { Client, Events } from 'discord.js';
import { configSecrets, loadConfig, loadDotEnv } from './config.ts';
import { configureLogger, logger } from './logger.ts';
import { createServices } from './services/index.ts';
import { attachInteractionHandler, createDiscordClient } from './discord/client.ts';
import { startWebhookServer, type WebhookServer } from './webhooks/server.ts';
import { startJobs, type JobRunner } from './jobs/index.ts';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  configureLogger(config.logLevel, configSecrets(config));

  const services = createServices(config);
  const integrity = services.ledger.verifyIntegrity();
  if (!integrity.ok) {
    logger.error('Ledger integrity check failed at startup', { problems: integrity.problems.slice(0, 10) });
  } else {
    logger.info('Ledger integrity check passed', { wallets: integrity.wallets });
  }

  const client = createDiscordClient();
  attachInteractionHandler(client, services);
  client.once(Events.ClientReady, (ready) => {
    logger.info('Discord client ready', {
      user: ready.user.tag,
      applicationId: ready.application?.id ?? config.discordClientId,
      guilds: ready.guilds.cache.size,
      provider: config.providerMode,
      withdrawalsLive: config.withdrawalsLive,
    });
  });

  await client.login(config.discordToken);
  await once(client, Events.ClientReady);

  let webhook: WebhookServer | null = null;
  try {
    webhook = startWebhookServer({ services, client });
  } catch (error) {
    logger.error('Webhook server failed to start', { error });
  }

  const jobs: JobRunner = startJobs({ services, client });
  await jobs.runOnce().catch((error) => logger.warn('Initial job pass failed', { error }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    jobs.stop();
    await webhook?.close().catch(() => undefined);
    client.destroy();
    services.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception — exiting so the supervisor can restart cleanly', { error });
    // Every financial write is transactional, so an exit cannot leave a half-applied ledger.
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('FluxTip failed to start', {
    error: error instanceof Error ? { name: error.name, message: error.message } : error,
  });
  process.exit(1);
});
