import { REST, Routes } from 'discord.js';
import { loadConfig, loadDotEnv } from '../config.ts';
import { configureLogger, logger } from '../logger.ts';
import { commandPayloads } from './registry.ts';

/**
 * Registers every command globally (no DISCORD_GUILD_ID, no test guild).
 * Global propagation can take up to an hour after a deploy.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  configureLogger(config.logLevel, [config.discordToken]);

  const body = commandPayloads();
  const names = body.map((command) => command.name);
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate command names detected: ${[...new Set(duplicates)].join(', ')}`);
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationCommands(config.discordClientId), { body });

  logger.info('Global application commands registered', {
    applicationId: config.discordClientId,
    count: body.length,
    commands: names,
  });
  process.stdout.write(
    `\nRegistered ${body.length} global commands for application ${config.discordClientId}.\n` +
      'Discord may take up to an hour to show them everywhere; there is no guild-specific registration.\n' +
      'If you removed commands, they disappear from servers after Discord refreshes the global command cache.\n',
  );
}

main().catch((error) => {
  logger.error('Command registration failed', { error });
  process.exitCode = 1;
});
