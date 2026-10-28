import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { ASSETS, ASSET_ORDER, assetNetworkLabel, assetTicker, isAssetSymbol, type AssetSymbol } from '../../core/assets.ts';
import { AppError, ValidationError } from '../../core/errors.ts';
import { formatUnits, parseUnits } from '../../core/money.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate, requireGuild } from '../context.ts';
import { addAssetOption, guildOnly, installable } from '../builders.ts';
import { COLORS, baseEmbed, errorEmbed, fiatFromUsd, fxNote, statusBadge, timestamp } from '../embeds.ts';
import { sendPrivateMessage } from '../notifier.ts';
import { views, type PageContent } from '../pagination.ts';
import { rainEmbed, receiptViewEmbed, transferEmbed } from '../receipt-view.ts';
import type { Command } from '../types.ts';
import { rateFor, walletSnapshot } from '../views.ts';

function flags(ctx: CommandContext) {
  return { simulated: ctx.services.provider.isSimulated };
}

function requireAsset(interaction: ChatInputCommandInteraction): AssetSymbol {
  const raw = interaction.options.getString('asset', true);
  if (!isAssetSymbol(raw)) throw new ValidationError('Unsupported asset.');
  return raw;
}

function amountText(asset: AssetSymbol, base: bigint): string {
  return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
}

async function notifyRecipient(
  ctx: CommandContext,
  userId: string,
  content: string,
  embed: ReturnType<typeof transferEmbed>,
): Promise<void> {
  const prefs = ctx.services.users.notifications(userId);
  if (!prefs.dm || !prefs.tips) return;
  await sendPrivateMessage(ctx.client, userId, { content, embeds: [embed] });
}

async function sendTransfer(
  ctx: CommandContext,
  kind: 'tip' | 'send',
): Promise<void> {
  await deferPrivate(ctx.interaction);
  const interaction = ctx.interaction;
  const target = interaction.options.getUser('user', true);
  const asset = requireAsset(interaction);
  if (target.id === ctx.userId) throw new ValidationError('You cannot send a transfer to yourself.');
  if (target.bot) throw new ValidationError('Bots cannot receive tips.');
  if (ctx.guildId) {
    const settings = ctx.services.servers.get(ctx.guildId);
    if (settings.disabled) throw new ValidationError('FluxTip is disabled in this server by an administrator.');
    if (!settings.tipsEnabled) throw new ValidationError('Tips are disabled in this server by an administrator.');
  }
  const amountBase = parseUnits(interaction.options.getString('amount', true), ASSETS[asset].decimals);
  const note = interaction.options.getString('note');

  const receipt = await ctx.services.transfers.send({
    kind,
    fromUserId: ctx.userId,
    toUserIds: [target.id],
    asset,
    grossBase: amountBase,
    note,
    serverId: ctx.guildId,
    interactionId: interaction.id,
  });
  const rate = await rateFor(ctx.services, ctx.userId);
  const embed = transferEmbed(flags(ctx), receipt, rate);

  await replyPrivate(interaction, {
    content: `${kind === 'tip' ? 'Tip' : 'Transfer'} sent to ${target}.`,
    embeds: [embed],
  });

  await notifyRecipient(
    ctx,
    target.id,
    `You received ${amountText(asset, receipt.netBase)} from ${interaction.user}.`,
    transferEmbed(flags(ctx), receipt, rate),
  );

  if (ctx.guildId) {
    const settings = ctx.services.servers.get(ctx.guildId);
    if (settings.notifyTipsChannel && settings.notificationsChannelId) {
      const channel = await ctx.client.channels.fetch(settings.notificationsChannelId).catch(() => null);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await channel
          .send({
            embeds: [
              baseEmbed(flags(ctx), COLORS.brand)
                .setTitle('Tip sent')
                .setDescription(`${interaction.user} tipped ${target} ${amountText(asset, receipt.netBase)}`)
                .setFooter({ text: 'Server tip notifications are enabled by an administrator' }),
            ],
          })
          .catch(() => undefined);
      }
    }
  }
}

const tipCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('tip')
      .setDescription('Tip another Discord user from your FluxTip wallet')
      .addUserOption((option) => option.setName('user').setDescription('Who to tip').setRequired(true))
      .addStringOption((option) => option.setName('amount').setDescription('Amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) => option.setName('note').setDescription('Optional note on the receipt').setMaxLength(200)),
  ),
  async execute(ctx) {
    await sendTransfer(ctx, 'tip');
  },
};

const sendCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send crypto from your FluxTip balance to another user')
      .addUserOption((option) => option.setName('user').setDescription('Recipient').setRequired(true))
      .addStringOption((option) => option.setName('amount').setDescription('Amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) => option.setName('note').setDescription('Optional note').setMaxLength(200)),
  ),
  async execute(ctx) {
    await sendTransfer(ctx, 'send');
  },
};

const splitCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('split')
      .setDescription('Split a payment evenly between up to 10 users (one fee)')
      .addStringOption((option) => option.setName('amount').setDescription('Total amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) =>
        option
          .setName('recipients')
          .setDescription('Mentions or user IDs separated by spaces, e.g. @alice @bob')
          .setRequired(true)
          .setMaxLength(400),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    if (!ctx.guildId) throw new ValidationError('Splits need at least one recipient; use `/send` in a DM instead.');
    const asset = requireAsset(ctx.interaction);
    const raw = ctx.interaction.options.getString('recipients', true);
    const ids = [...raw.matchAll(/<@!?(\d{17,20})>|\b(\d{17,20})\b/g)]
      .map((match) => match[1] ?? match[2])
      .filter((id): id is string => Boolean(id));
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new ValidationError('Mention at least one recipient.');
    if (unique.length > 10) throw new ValidationError('A split can include at most 10 recipients.');
    if (unique.includes(ctx.userId)) throw new ValidationError('You cannot include yourself in a split.');

    const amountBase = parseUnits(ctx.interaction.options.getString('amount', true), ASSETS[asset].decimals);
    const receipt = await ctx.services.transfers.send({
      kind: 'split',
      fromUserId: ctx.userId,
      toUserIds: unique,
      asset,
      grossBase: amountBase,
      serverId: ctx.guildId,
      interactionId: ctx.interaction.id,
    });
    const rate = await rateFor(ctx.services, ctx.userId);
    await replyPrivate(ctx.interaction, {
      content: 'Split completed. One application fee was charged for the whole split.',
      embeds: [transferEmbed(flags(ctx), receipt, rate)],
    });
    for (const recipient of receipt.recipients) {
      const prefs = ctx.services.users.notifications(recipient.userId);
      if (prefs.dm && prefs.tips) {
        await sendPrivateMessage(ctx.client, recipient.userId, {
          content: `You received ${amountText(asset, recipient.netBase)} from a split by ${ctx.interaction.user}.`,
        });
      }
    }
  },
};

const rainCommand: Command = {
  data: guildOnly(
    new SlashCommandBuilder()
      .setName('rain')
      .setDescription('Rain crypto on random FluxTip users in this server (one fee)')
      .addStringOption((option) => option.setName('amount').setDescription('Total amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addIntegerOption((option) =>
        option.setName('count').setDescription('Number of recipients (default 5)').setMinValue(1).setMaxValue(25),
      ),
  ),
  guildOnly: true,
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const guildId = requireGuild(ctx);
    const settings = ctx.services.servers.get(guildId);
    if (settings.disabled) throw new ValidationError('FluxTip is disabled in this server.');
    if (!settings.rainEnabled) throw new ValidationError('Rain is disabled in this server by an administrator.');
    const asset = requireAsset(ctx.interaction);
    const amountBase = parseUnits(ctx.interaction.options.getString('amount', true), ASSETS[asset].decimals);
    const count = ctx.interaction.options.getInteger('count') ?? 5;
    const result = await ctx.services.transfers.rain({
      hostUserId: ctx.userId,
      serverId: guildId,
      channelId: ctx.interaction.channelId,
      asset,
      totalBase: amountBase,
      count,
      interactionId: ctx.interaction.id,
    });
    const rate = await rateFor(ctx.services, ctx.userId);
    await replyPrivate(ctx.interaction, { embeds: [rainEmbed(flags(ctx), result, rate)] });
    for (const recipient of result.recipients) {
      const prefs = ctx.services.users.notifications(recipient.userId);
      if (prefs.dm && prefs.tips) {
        await sendPrivateMessage(ctx.client, recipient.userId, {
          content: `🌧️ You received ${amountText(asset, recipient.netBase)} from a rain by ${ctx.interaction.user}.`,
        });
      }
    }
  },
};

const requestCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('request')
      .setDescription('Ask another user for a crypto payment')
      .addUserOption((option) => option.setName('user').setDescription('Who should pay').setRequired(true))
      .addStringOption((option) => option.setName('amount').setDescription('Amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) => option.setName('note').setDescription('What is this for?').setMaxLength(200))
      .addIntegerOption((option) =>
        option.setName('expires_hours').setDescription('Hours until it expires (1-168, default 24)').setMinValue(1).setMaxValue(168),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const payer = ctx.interaction.options.getUser('user', true);
    if (payer.bot) throw new ValidationError('Bots cannot pay requests.');
    if (payer.id === ctx.userId) throw new ValidationError('You cannot request a payment from yourself.');
    const asset = requireAsset(ctx.interaction);
    const amountBase = parseUnits(ctx.interaction.options.getString('amount', true), ASSETS[asset].decimals);
    const note = ctx.interaction.options.getString('note');
    const row = ctx.services.requests.create({
      requesterId: ctx.userId,
      payerId: payer.id,
      asset,
      amountBase,
      note,
      expiresInHours: ctx.interaction.options.getInteger('expires_hours') ?? 24,
      interactionId: ctx.interaction.id,
    });

    const delivered = await sendPrivateMessage(ctx.client, payer.id, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.brand)
          .setTitle('Payment request')
          .setDescription(
            [
              `**${ctx.interaction.user}** requested **${amountText(asset, amountBase)}**`,
              `Network: ${assetNetworkLabel(asset)}`,
              note ? `Note: ${note}` : '',
              `Request \`${row.id}\` · expires ${timestamp(row.expires_at)}`,
              'Paying this adds the flat $0.05 application fee. You can also run `/pay request_id:' + row.id + '`.',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`req:pay:${row.id}`).setLabel('Pay request').setStyle(ButtonStyle.Success),
        ),
      ],
    });

    await replyPrivate(ctx.interaction, {
      content: delivered
        ? `Request \`${row.id}\` sent to ${payer}.`
        : `Request \`${row.id}\` created, but ${payer} could not be messaged (DMs closed). Share the ID so they can run \`/pay request_id:${row.id}\`.`,
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle(`Payment request ${row.id}`)
          .setDescription(
            `**${amountText(asset, amountBase)}** from ${payer} · ${statusBadge(row.status)}\nExpires ${timestamp(row.expires_at)}`,
          ),
      ],
    });
  },
};

const payCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('pay')
      .setDescription('Pay a FluxTip payment request')
      .addStringOption((option) =>
        option.setName('request_id').setDescription('The request ID from /request').setRequired(true).setMaxLength(16),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const receipt = await ctx.services.requests.pay({
      requestId: ctx.interaction.options.getString('request_id', true),
      payerId: ctx.userId,
      interactionId: ctx.interaction.id,
    });
    const rate = await rateFor(ctx.services, ctx.userId);
    await replyPrivate(ctx.interaction, {
      content: 'Request paid.',
      embeds: [transferEmbed(flags(ctx), receipt, rate)],
    });
    for (const recipient of receipt.recipients) {
      await sendPrivateMessage(ctx.client, recipient.userId, {
        content: `✅ ${ctx.interaction.user} paid your request ${receipt.groupId.replace('req_', '')}. Received ${amountText(receipt.asset, recipient.netBase)}.`,
      });
    }
  },
};

const cancelCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('cancel')
      .setDescription('Cancel something you created')
      .addSubcommand((sub) =>
        sub
          .setName('request')
          .setDescription('Cancel an open payment request')
          .addStringOption((option) =>
            option.setName('request_id').setDescription('Request ID').setRequired(true).setMaxLength(16),
          ),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const id = ctx.interaction.options.getString('request_id', true);
    const row = ctx.services.requests.cancel(id, ctx.userId);
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('Request cancelled')
          .setDescription(`\`${row.id}\` is now **${row.status}**. No fee was charged.`),
      ],
    });
  },
};

const tipStatsCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('tipstats')
      .setDescription('Tip statistics for you or another user')
      .addUserOption((option) => option.setName('user').setDescription('Defaults to you')),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const target = ctx.interaction.options.getUser('user') ?? ctx.interaction.user;
    ctx.services.users.ensure(target.id);
    const stats = ctx.services.transfers.tipStats(target.id, ctx.guildId ?? undefined);
    const priceMap = await ctx.services.prices
      .snapshot()
      .then((snapshot) => snapshot.prices)
      .catch(() => ({} as Partial<Record<AssetSymbol, number>>));
    const rate = await rateFor(ctx.services, target.id);
    const render = (values: Map<AssetSymbol, bigint>) =>
      values.size === 0
        ? 'none'
        : [...values.entries()]
            .map(([asset, base]) => {
              const whole = Number(formatUnits(base, ASSETS[asset].decimals));
              const price = priceMap[asset];
              return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}${price ? ` (${fiatFromUsd(whole * price, rate)})` : ''}`;
            })
            .join('\n');
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.brand)
          .setTitle(`Tip stats · ${target.username}`)
          .addFields(
            { name: `Sent (${stats.sentCount})`, value: render(stats.sentBase), inline: true },
            { name: `Received (${stats.receivedCount})`, value: render(stats.receivedBase), inline: true },
          )
          .setFooter({ text: fxNote(rate) + (ctx.guildId ? ' · this server' : '') }),
      ],
    });
  },
};

const tipLeaderboardCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('tipleaderboard')
      .setDescription('Top tippers in this server or globally')
      .addStringOption((option) =>
        option
          .setName('scope')
          .setDescription('Server or global tipping leaderboard')
          .addChoices({ name: 'This server', value: 'server' }, { name: 'Global', value: 'global' }),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const requested = ctx.interaction.options.getString('scope');
    const scope = !ctx.guildId || requested === 'global' ? 'global' : 'server';
    const rows = ctx.services.transfers.leaderboard({
      serverId: scope === 'server' ? (ctx.guildId as string) : undefined,
      limit: 10,
    });
    const rate = await rateFor(ctx.services, ctx.userId);
    const prices = await ctx.services.prices
      .snapshot()
      .then((snapshot) => snapshot.prices)
      .catch(() => ({} as Partial<Record<AssetSymbol, number>>));
    const lines = rows.map((row, index) => {
      const totalUsd = [...row.perAsset.entries()].reduce((acc, [asset, base]) => {
        const price = prices[asset];
        if (!price) return acc;
        return acc + Number(formatUnits(base, ASSETS[asset].decimals)) * price;
      }, 0);
      const amounts = [...row.perAsset.entries()]
        .map(([asset, base]) => `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`)
        .join(' + ');
      return `**${index + 1}.** <@${row.userId}> · ${row.count} tip${row.count === 1 ? '' : 's'} · ${amounts}${totalUsd > 0 ? ` (≈ ${fiatFromUsd(totalUsd, rate)})` : ''}`;
    });
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.brand)
          .setTitle(`Tip leaderboard · ${scope}`)
          .setDescription(lines.length === 0 ? 'No tips recorded yet.' : lines.join('\n'))
          .setFooter({ text: fxNote(rate) }),
      ],
    });
  },
};

const transactionsCommand: Command = {
  data: installable(
    new SlashCommandBuilder().setName('transactions').setDescription('Your tips, transfers, splits, rain and requests'),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const total = ctx.services.transfers.countGroups(ctx.userId);
    const totalPages = Math.max(1, Math.ceil(total / 5));
    const render = async (page: number): Promise<PageContent> => {
      const groups = ctx.services.transfers.listGroups(ctx.userId, { limit: 5, offset: page * 5 });
      const rate = await rateFor(ctx.services, ctx.userId);
      const blocks = groups.map((groupId) => {
        const receipt = ctx.services.transfers.getReceipt(groupId);
        const direction = receipt.fromUserId === ctx.userId ? 'sent' : 'received';
        const count = receipt.recipients.length;
        const counterparty =
          direction === 'sent'
            ? receipt.recipients.slice(0, 3).map((row) => `<@${row.userId}>`).join(', ') +
              (count > 3 ? ` +${count - 3}` : '')
            : `<@${receipt.fromUserId}>`;
        return [
          `\`${receipt.groupId}\` · **${direction}** · ${receipt.kind}`,
          `${amountText(receipt.asset, direction === 'sent' ? receipt.grossBase : receipt.netBase)} · ${counterparty} · ${statusBadge(receipt.status)} · ${timestamp(receipt.createdAt)}`,
        ].join('\n');
      });
      const embed = baseEmbed(flags(ctx), COLORS.neutral)
        .setTitle('Transactions')
        .setDescription(blocks.join('\n\n') || 'No transfers yet. Try `/tip`.')
        .setFooter({ text: `Page ${page + 1} of ${totalPages} · ${fxNote(rate)}` });
      return { embeds: [embed], totalPages };
    };
    const first = await render(0);
    const viewId = views.create(ctx.userId, render);
    await replyPrivate(ctx.interaction, {
      embeds: first.embeds,
      components: totalPages > 1 ? [views.row(viewId, 0, totalPages)] : [],
    });
  },
};

const transactionCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('transaction')
      .setDescription('Look up one transaction by reference')
      .addStringOption((option) =>
        option.setName('reference').setDescription('e.g. tip_1A2B3C4D, w_12, d_3').setRequired(true).setMaxLength(80),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const view = ctx.services.receipts.find(ctx.userId, ctx.interaction.options.getString('reference', true));
    const rate = await rateFor(ctx.services, ctx.userId);
    await replyPrivate(ctx.interaction, { embeds: [receiptViewEmbed(flags(ctx), view, rate)] });
  },
};

const receiptCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('receipt')
      .setDescription('Show a private receipt for one of your transactions')
      .addStringOption((option) =>
        option.setName('reference').setDescription('Reference shown in /transactions').setRequired(true).setMaxLength(80),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const view = ctx.services.receipts.find(ctx.userId, ctx.interaction.options.getString('reference', true));
    const rate = await rateFor(ctx.services, ctx.userId);
    await replyPrivate(ctx.interaction, {
      content: 'Receipt (visible only to you).',
      embeds: [receiptViewEmbed(flags(ctx), view, rate)],
    });
  },
};

export const socialCommands: Command[] = [
  tipCommand,
  sendCommand,
  splitCommand,
  rainCommand,
  requestCommand,
  payCommand,
  cancelCommand,
  tipStatsCommand,
  tipLeaderboardCommand,
  transactionsCommand,
  transactionCommand,
  receiptCommand,
];
