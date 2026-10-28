import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type Message,
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

/**
 * Requires MessageContent intent in code and in the Discord Developer Portal
 * (Privileged Gateway Intents -> Message Content Intent) for prefix commands.
 */
export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
}

/** Prefix command aliases for the "$" handler. */
export const ALIASES: ReadonlyMap<string, string> = new Map([
  ['help', 'h'],
  ['wallet', 'wal'],
  ['balance', 'bal'],
  ['deposit', 'dep'],
  ['address', 'addr'],
  ['withdraw', 'wd'],
]);

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

/** Commands that should be public in servers for prefix usage. */
const PUBLIC_PREFIX_COMMANDS = new Set([
  'help',
  'cmds',
  'ping',
  'uptime',
  'status',
  'about',
  'invite',
  'support',
  'changelog',
  'privacy',
  'fees',
  'limits',
  'currency',
  'convert',
  'price',
  'prices',
  'chart',
  'calculator',
  'converter',
  'gas',
  'network',
  'explorer',
  'confirmations',
  'market',
  'gainers',
  'losers',
  'alert',
  'alerts',
  'rank',
  'stats',
]);

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

  client.on('messageCreate', (message) => {
    void handleMessage(message, services, client);
  });
}

const PREFIX = '$';

async function handleMessage(message: Message, services: Services, client: Client): Promise<void> {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const trimmed = message.content.slice(PREFIX.length).trimStart();
  if (trimmed.length === 0) return;

  const parts = trimmed.split(/\s+/);
  const rawName = parts[0].toLowerCase();
  const args = parts.slice(1);

  const aliased = ALIASES.get(rawName);
  const commandName = aliased ?? rawName;

  const command = commandMap.get(commandName);
  if (!command) {
    try {
      await message.reply({
        embeds: [
          baseEmbed({ simulated: services.provider.isSimulated }, COLORS.warning)
            .setTitle('Unknown command')
            .setDescription(`\`${PREFIX}${commandName}\` is not a FluxTip command. Try \`${PREFIX}help\`.`),
        ],
      });
    } catch {
      // Cannot reply (blocked DMs, deleted channel, etc.)
    }
    return;
  }

  if (command.guildOnly && (!message.guild || message.channel.type !== 0)) {
    try {
      await message.reply({
        embeds: [
          errorEmbed({ simulated: services.provider.isSimulated }, 'This command only works inside a Discord server.'),
        ],
      });
    } catch {
      // Cannot reply
    }
    return;
  }

  if (command.adminOnly && !services.config.adminUserIds.has(message.author.id)) {
    logger.warn('Unauthorized admin command attempt (prefix)', { userId: message.author.id, command: commandName });
    try {
      await message.reply({
        embeds: [
          errorEmbed({ simulated: services.provider.isSimulated }, 'This command is restricted to configured FluxTip administrators.'),
        ],
      });
    } catch {
      // Cannot reply
    }
    return;
  }

  const guildId = message.guild?.id ?? null;
  if (guildId) {
    const settings = services.servers.get(guildId);
    if (settings.disabled && !DISABLED_SERVER_ALLOWLIST.has(commandName)) {
      try {
        await message.reply({
          embeds: [
            errorEmbed({ simulated: services.provider.isSimulated }, 'FluxTip is disabled in this server by an administrator. Your wallet is unaffected — use $wallet in a DM.'),
          ],
        });
      } catch {
        // Cannot reply
      }
      return;
    }
    services.servers.recordActivity(guildId, message.author.id, commandName);
  }

  try {
    // Build a minimal interaction-like object for the command
    const fakeInteraction = createPrefixInteraction(message, commandName, args, services, client);
    await command.execute({
      interaction: fakeInteraction,
      client,
      services,
      userId: message.author.id,
      guildId,
      commandName,
      subcommand: null,
      subcommandGroup: null,
    });
  } catch (error) {
    const reference = `ref-${Date.now().toString(36).slice(-8)}`;
    logger.error('Prefix command failed', { command: commandName, userId: message.author.id, error, reference });
    try {
      await message.reply({
        embeds: [
          errorEmbed(
            { simulated: services.provider.isSimulated },
            `Something went wrong while running this command. Nothing was charged twice.\nReference: \`${reference}\``,
          ),
        ],
      });
    } catch {
      // Cannot reply
    }
  }
}

interface PrefixInteractionOptions {
  getString: (name: string, required?: boolean) => string | null;
  getInteger: (name: string, required?: boolean) => number | null;
  getNumber: (name: string, required?: boolean) => number | null;
  getBoolean: (name: string, required?: boolean) => boolean | null;
  getSubcommand: (group?: string) => string | null;
  getSubcommandGroup: () => string | null;
  getChannel: (name: string, required?: boolean) => import('discord.js').Channel | null;
  getAttachment: (name: string, required?: boolean) => import('discord.js').Attachment | null;
  getMention: (name: string, required?: boolean) => import('discord.js').User | null;
  isTts: () => boolean;
  wouldRecommend: () => boolean;
}

function createPrefixInteraction(
  message: Message,
  commandName: string,
  args: string[],
  services: Services,
  client: Client,
): any {
  const parsed = parseArgs(args);

  return {
    id: `prefix_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    token: '',
    type: 2,
    version: 1,
    applicationId: services.config.discordClientId,
    messageFlags: message.guild ? MessageFlags.Ephemeral : 0,
    deferred: false,
    replied: false,
    repliedMessage: null,
    channelId: message.channel.id,
    guildId: message.guild?.id ?? null,
    member: message.member ?? null,
    user: message.author,
    memberPermissions: message.guild?.members.me?.permissions ?? null,
    locale: (message as any).locale ?? 'en-US',
    guildLocale: message.guild?.preferredLocale ?? null,
    inGuild: () => message.guild !== null,
    isRepliable: () => true,
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModal: () => false,
    isMessageComponent: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    channel: message.channel,
    guild: message.guild ?? null,
    commandName,
    options: {
      getString: ((name: string, required?: boolean): string | null => {
        const val = parsed[name];
        if (val !== undefined && val !== null) return String(val);
        if (name === 'user') {
          const mentionArg = args.find(a => a.startsWith('@'))?.slice(1) ?? args.find(a => /^\d{17,20}$/.test(a));
          if (mentionArg) {
            const user = message.guild?.members.cache.get(mentionArg) ?? client.users.cache.get(mentionArg);
            if (user) return (user as import('discord.js').User).toString();
          }
          if (!required) return null;
          throw new Error(`Missing required argument: user`);
        }
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      getInteger: ((name: string, required?: boolean): number | null => {
        const val = parsed[name];
        if (val !== undefined && val !== null && !isNaN(Number(val))) return Number(val);
        const numericArg = args.find(a => /^\d+$/.test(a) && !a.startsWith('-'));
        if (numericArg) return parseInt(numericArg, 10);
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      getNumber: ((name: string, required?: boolean): number | null => {
        const val = parsed[name];
        if (val !== undefined && val !== null && !isNaN(Number(val))) return Number(val);
        const numArg = args.find(a => /^\d+(\.\d+)?$/.test(a));
        if (numArg) return parseFloat(numArg);
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      getBoolean: ((name: string, required?: boolean): boolean | null => {
        const val = parsed[name];
        if (val !== undefined && val !== null) return Boolean(val);
        const boolArg = args.find(a => a.toLowerCase() === 'true' || a.toLowerCase() === 'false' || a === '1' || a === '0');
        if (boolArg) return boolArg.toLowerCase() === 'true' || boolArg === '1';
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      getSubcommand: ((_group?: string): string | null => null) as any,
      getSubcommandGroup: ((): string | null => null) as any,
      getChannel: ((name: string, required?: boolean): import('discord.js').Channel | null => {
        const val = parsed[name];
        if (val !== undefined && val !== null) {
          return message.guild?.channels.cache.get(String(val)) ?? null;
        }
        const channelId = args.find(a => /^\d{17,20}$/.test(a));
        if (channelId) return message.guild?.channels.cache.get(channelId) ?? null;
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      getAttachment: ((_name: string, _required?: boolean): import('discord.js').Attachment | null => {
        if (!_required) return null;
        throw new Error(`Attachments not supported in prefix commands`);
      }) as any,
      getMention: ((name: string, required?: boolean): import('discord.js').User | null => {
        const mentionArg = args.find(a => a.startsWith('@'))?.slice(1) ?? args.find(a => /^\d{17,20}$/.test(a));
        if (mentionArg) {
          const user = message.guild?.members.cache.get(mentionArg) ?? client.users.cache.get(mentionArg);
          if (user) return user as import('discord.js').User;
        }
        if (!required) return null;
        throw new Error(`Missing required argument: ${name}`);
      }) as any,
      isTts: ((): boolean => false) as any,
      wouldRecommend: ((): boolean => false) as any,
    } as any,
    reply: async (options: any) => {
      await message.reply(options);
      return { editReply: async () => {}, fetchReply: async () => ({}) };
    },
    editReply: async (options: any) => {
      await message.edit(options);
    },
    fetchReply: async () => ({}),
    deleteReply: async () => {},
    followUp: async (options: any) => {
      await message.reply(options);
      return {};
    },
    deferReply: async () => {
      // Prefix commands reply immediately; no deferral needed.
    },
    editMessage: async (_msg: any, options: any) => {
      await message.edit(options);
    },
    delete: async () => {},
    fetch: async () => message,
    toString: () => message.toString(),
    replyOptions: {},
  };
}

interface ParsedArgs {
  [key: string]: string | number | boolean | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Handle --key=value or --key value
    if (arg.startsWith('--')) {
      const fullKey = arg.slice(2);
      const eqIdx = fullKey.indexOf('=');
      let key: string;
      let val: string | undefined;

      if (eqIdx >= 0) {
        key = fullKey.slice(0, eqIdx);
        val = fullKey.slice(eqIdx + 1);
      } else {
        key = fullKey;
        val = args[i + 1];
        if (val && !val.startsWith('-')) {
          i++; // consume the value
        } else {
          val = 'true';
        }
      }

      // Try to parse as number
      if (/^\d+$/.test(val!)) {
        parsed[key] = parseInt(val!, 10);
      } else if (/^\d+(\.\d+)?$/.test(val!)) {
        parsed[key] = parseFloat(val!);
      } else if (val!.toLowerCase() === 'true') {
        parsed[key] = true;
      } else if (val!.toLowerCase() === 'false') {
        parsed[key] = false;
      } else {
        parsed[key] = val;
      }
    }
    // Handle -k value (short form)
    else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg[1];
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        parsed[key] = val;
        i++; // consume the value
      } else {
        parsed[key] = true;
      }
    }
    // Handle @mentions
    else if (arg.startsWith('@')) {
      // Store mention for user lookup
      parsed['_mention'] = arg.slice(1);
    }
  }

  return parsed;
}

/** Small helper used by admin/ops output. */
export function describeStatus(status: string): string {
  return `${statusBadge(status)} · ${timestamp(Date.now())}`;
}
