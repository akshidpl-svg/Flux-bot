import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { AppError } from '../core/errors.ts';
import { logger } from '../logger.ts';
import type { Services } from '../services/index.ts';
import { commandMap } from './registry.ts';
import { views } from './pagination.ts';
import { rateFor } from './views.ts';
import { transferEmbed } from './receipt-view.ts';
import { sendPrivateMessage } from './notifier.ts';
import { errorEmbed, baseEmbed, COLORS, statusBadge, timestamp } from './embeds.ts';
import { replyPrivate } from './context.ts';

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 10;

/** Discord clients only: no message-content or member intents are required. */
export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

const buckets = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (buckets.get(userId) ?? []).filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  buckets.set(userId, recent);
  if (buckets.size > 5000) {
    for (const [id, entries] of buckets) {
      if (entries.every((entry) => now - entry > RATE_LIMIT_WINDOW_MS)) buckets.delete(id);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

const DISABLED_SERVER_ALLOWLIST = new Set([
  'server',
  'admin',
  'help',
  'cmds',
  'support',
  'about',
  'invite',
  'privacy',
  'ping',
  'status',
]);

function simulated(services: Services): boolean {
  return services.provider.isSimulated;
}

async function fatal(interaction: Interaction, services: Services, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload: InteractionReplyOptions = {
    embeds: [errorEmbed({ simulated: simulated(services) }, message)],
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // Interaction token expired; nothing else to do.
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction, services: Services, client: Client): Promise<void> {
  const command = commandMap.get(interaction.commandName);
  if (!command) {
    await fatal(interaction, services, 'That command is not part of this build. Run `/cmds` to see what is registered.');
    return;
  }
  if (isRateLimited(interaction.user.id)) {
    await fatal(interaction, services, 'Slow down a little — too many commands in a short window.');
    return;
  }
  if (command.guildOnly && !interaction.inGuild()) {
    await fatal(interaction, services, 'This command only works inside a Discord server.');
    return;
  }
  if (command.adminOnly && !services.config.adminUserIds.has(interaction.user.id)) {
    logger.warn('Unauthorized admin command attempt', { userId: interaction.user.id, command: interaction.commandName });
    await fatal(interaction, services, 'This command is restricted to configured FluxTip administrators.');
    return;
  }

  const guildId = interaction.guildId;
  if (guildId) {
    const settings = services.servers.get(guildId);
    if (settings.disabled && !DISABLED_SERVER_ALLOWLIST.has(interaction.commandName)) {
      await fatal(interaction, services, 'FluxTip is disabled in this server by an administrator. Your wallet is unaffected — use `/wallet` in a DM.');
      return;
    }
    services.servers.recordActivity(guildId, interaction.user.id, interaction.commandName);
  }

  try {
    await command.execute({
      interaction,
      client,
      services,
      userId: interaction.user.id,
      guildId: guildId ?? null,
      commandName: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      subcommandGroup: interaction.options.getSubcommandGroup(false),
    });
  } catch (error) {
    const reference = `ref-${interaction.id.slice(-8)}`;
    if (error instanceof AppError) {
      logger.info('Command rejected', { command: interaction.commandName, code: error.code, userId: interaction.user.id });
      await replyPrivate(interaction, { embeds: [errorEmbed({ simulated: simulated(services) }, error.userMessage)] });
      return;
    }
    logger.error('Command failed', { command: interaction.commandName, userId: interaction.user.id, error, reference });
    await replyPrivate(interaction, {
      embeds: [
        errorEmbed(
          { simulated: simulated(services) },
          `Something went wrong while running this command. Nothing was charged twice.\nReference: \`${reference}\``,
        ),
      ],
    });
  }
}

async function handleCurrencySelect(interaction: StringSelectMenuInteraction, services: Services): Promise<void> {
  const code = interaction.values[0];
  if (!code) return;
  services.users.ensure(interaction.user.id);
  services.users.setCurrency(interaction.user.id, code);
  const rate = await rateFor(services, interaction.user.id);
  const current = services.users.currency(interaction.user.id);
  await interaction.update({
    embeds: [
      baseEmbed({ simulated: simulated(services) }, COLORS.success)
        .setTitle('Display currency updated')
        .setDescription(
          `Your estimates will now use **${current}**${rate.fellBackToUsd ? ' — live FX rates are unavailable, so amounts show in USD for now' : ''}.\n\nYour crypto balances, assets and transaction amounts are unchanged; this is display only.`,
        ),
    ],
    components: [],
  });
}

async function handleRequestPay(interaction: ButtonInteraction, services: Services, client: Client): Promise<void> {
  const requestId = interaction.customId.split(':')[2];
  if (!requestId) return;
  await interaction.deferReply({ flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined });
  try {
    const request = services.requests.getById(requestId);
    if (request.payer_id !== interaction.user.id) {
      await interaction.editReply({ content: 'Only the user named in this request can pay it.' });
      return;
    }
    const receipt = await services.requests.pay({
      requestId,
      payerId: interaction.user.id,
      interactionId: interaction.id,
    });
    const rate = await rateFor(services, interaction.user.id);
    await interaction.editReply({
      content: 'Request paid.',
      embeds: [transferEmbed({ simulated: simulated(services) }, receipt, rate)],
    });
    await sendPrivateMessage(client, request.requester_id, {
      content: `✅ ${interaction.user} paid your request \`${request.id}\`.`,
    });
  } catch (error) {
    const message = error instanceof AppError ? error.userMessage : 'This request could not be paid. Nothing was charged twice.';
    await interaction.editReply({ embeds: [errorEmbed({ simulated: simulated(services) }, message)] }).catch(() => undefined);
  }
}

async function handleComponent(interaction: Interaction, services: Services, client: Client): Promise<void> {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('view:')) {
      await views.handle(interaction);
      return;
    }
    if (interaction.customId.startsWith('req:pay:')) {
      await handleRequestPay(interaction, services, client);
      return;
    }
    await interaction
      .reply({ content: 'That control expired. Run the command again.', flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'currency:select') {
    await handleCurrencySelect(interaction, services);
    return;
  }
  if (interaction.isStringSelectMenu()) {
    await interaction
      .reply({ content: 'That menu expired. Run the command again.', flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }
}

export function attachInteractionHandler(client: Client, services: Services): void {
  client.on('interactionCreate', (interaction) => {
    void (async () => {
      try {
        if (interaction.isChatInputCommand()) {
          await handleCommand(interaction, services, client);
        } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
          await handleComponent(interaction, services, client);
        }
      } catch (error) {
        logger.error('Interaction handler crashed', { error, interactionId: interaction.id });
        if (interaction.isRepliable()) {
          await fatal(interaction, services, 'The interaction could not be completed. Please try again.');
        }
      }
    })();
  });

  client.on('guildCreate', (guild) => {
    if (!guild.available) return;
    services.servers.ensure(guild.id);
    logger.info('Joined server', { guildId: guild.id, members: guild.memberCount });
  });

  client.on('guildDelete', (guild) => {
    // The wallet is per user; leaving a server only affects server-scoped settings.
    logger.info('Removed from server', { guildId: guild.id });
  });

  client.on('error', (error) => logger.error('Discord client error', { error }));
  client.on('warn', (message) => logger.warn('Discord client warning', { message }));
}

/** Small helper used by admin/ops output. */
export function describeStatus(status: string): string {
  return `${statusBadge(status)} · ${timestamp(Date.now())}`;
}
