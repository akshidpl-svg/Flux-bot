import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { APP_FEE_USD, ASSETS, assetTicker, type AssetSymbol } from '../../core/assets.ts';
import { ForbiddenError } from '../../core/errors.ts';
import { formatUnits } from '../../core/money.ts';
import { audit } from '../../db/index.ts';
import { guildOnly } from '../builders.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate, requireGuild } from '../context.ts';
import { COLORS, baseEmbed, fiatFromUsd, fxNote, timestamp } from '../embeds.ts';
import type { Command } from '../types.ts';
import { rateFor } from '../views.ts';

function flags(ctx: CommandContext) {
  return { simulated: ctx.services.provider.isSimulated };
}

function requireManager(ctx: CommandContext): string {
  const guildId = requireGuild(ctx);
  const permissions = ctx.interaction.memberPermissions;
  if (!permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new ForbiddenError('You need the **Manage Server** permission to change FluxTip settings.');
  }
  return guildId;
}

function requireTextChannel(interaction: ChatInputCommandInteraction, name: string) {
  const channel = interaction.options.getChannel(name);
  if (!channel) return undefined;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    throw new ForbiddenError('Choose a standard text or announcement channel in this server.');
  }
  return channel;
}

const serverCommand: Command = {
  data: guildOnly(
    new SlashCommandBuilder()
      .setName('server')
      .setDescription('Server statistics and settings')
      .addSubcommand((sub) => sub.setName('stats').setDescription('Activity and totals for this server'))
      .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Top tippers in this server'))
      .addSubcommand((sub) => sub.setName('settings').setDescription('Current server settings'))
      .addSubcommand((sub) =>
        sub
          .setName('notifications')
          .setDescription('Set the server tip notification channel')
          .addChannelOption((option) => option.setName('channel').setDescription('Channel for tip announcements'))
          .addBooleanOption((option) => option.setName('tips').setDescription('Announce tips in that channel')),
      )
      .addSubcommand((sub) => sub.setName('fees').setDescription('Fee policy as applied in this server'))
      .addSubcommand((sub) =>
        sub
          .setName('disable')
          .setDescription('Enable or disable FluxTip features in this server')
          .addBooleanOption((option) =>
            option.setName('enabled').setDescription('true enables FluxTip, false disables it').setRequired(true),
          ),
      ),
  ),
  guildOnly: true,
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const guildId = requireGuild(ctx);
    const sub = ctx.subcommand ?? 'stats';

    if (sub === 'stats') {
      const settings = ctx.services.servers.get(guildId);
      const stats = ctx.services.servers.stats(guildId);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.neutral)
            .setTitle(`FluxTip in ${ctx.interaction.guild?.name ?? 'this server'}`)
            .addFields(
              { name: 'Members who used FluxTip', value: String(stats.users), inline: true },
              { name: 'Commands used', value: String(stats.commands), inline: true },
              { name: 'Tip transactions', value: String(stats.tipsVolumeGroups), inline: true },
              { name: 'Status', value: settings.disabled ? 'disabled' : 'enabled', inline: true },
              { name: 'Tips', value: settings.tipsEnabled ? 'enabled' : 'disabled', inline: true },
              { name: 'Rain', value: settings.rainEnabled ? 'enabled' : 'disabled', inline: true },
            )
            .setFooter({ text: 'Server settings never grant access to user wallets.' }),
        ],
      });
      return;
    }

    if (sub === 'leaderboard') {
      const rows = ctx.services.transfers.leaderboard({ serverId: guildId, limit: 10 });
      const prices = await ctx.services.prices
        .snapshot()
        .then((snapshot) => snapshot.prices)
        .catch(() => ({} as Partial<Record<AssetSymbol, number>>));
      const rate = await rateFor(ctx.services, ctx.userId);
      const lines = rows.map((row, index) => {
        const amounts = [...row.perAsset.entries()]
          .map(([asset, base]) => `${formatUnits(base, ASSETS[asset as AssetSymbol].decimals)} ${assetTicker(asset as AssetSymbol)}`)
          .join(' + ');
        const usd = [...row.perAsset.entries()].reduce((acc, [asset, base]) => {
          const price = prices[asset as AssetSymbol];
          if (!price) return acc;
          return acc + Number(formatUnits(base, ASSETS[asset as AssetSymbol].decimals)) * price;
        }, 0);
        return `**${index + 1}.** <@${row.userId}> · ${row.count} tips · ${amounts}${usd > 0 ? ` (≈ ${fiatFromUsd(usd, rate)})` : ''}`;
      });
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.brand)
            .setTitle('Server tip leaderboard')
            .setDescription(lines.join('\n') || 'No tips recorded in this server yet.')
            .setFooter({ text: fxNote(rate) }),
        ],
      });
      return;
    }

    if (sub === 'settings') {
      const settings = ctx.services.servers.get(guildId);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.neutral)
            .setTitle('Server settings')
            .setDescription(
              [
                `FluxTip: **${settings.disabled ? 'disabled' : 'enabled'}**`,
                `Tips: **${settings.tipsEnabled ? 'enabled' : 'disabled'}**`,
                `Rain: **${settings.rainEnabled ? 'enabled' : 'disabled'}**`,
                `Tip announcements: **${settings.notifyTipsChannel ? 'on' : 'off'}** in ${settings.notificationsChannelId ? `<#${settings.notificationsChannelId}>` : 'no channel'}`,
                `Last updated: ${timestamp(settings.updatedAt)}`,
                '',
                'Change with `/server notifications` or `/server disable`. Requires **Manage Server**.',
                'Settings are isolated per server ID and never touch wallet data.',
              ].join('\n'),
            ),
        ],
      });
      return;
    }

    if (sub === 'notifications') {
      requireManager(ctx);
      const channel = requireTextChannel(ctx.interaction, 'channel');
      const tips = ctx.interaction.options.getBoolean('tips');
      if (!channel && tips === null) {
        throw new ForbiddenError('Provide a channel or a tips setting to change.');
      }
      const settings = ctx.services.servers.update(guildId, {
        ...(channel ? { notificationsChannelId: channel.id } : {}),
        // Turning announcements off must never change whether tipping itself works.
        ...(tips === null ? {} : { notifyTipsChannel: tips, ...(tips ? { tipsEnabled: true } : {}) }),
      });
      audit(ctx.services.db, ctx.userId, 'server_notifications', guildId, { channelId: channel?.id, tips });
      await replyPrivate(ctx.interaction, {
        content: `Updated. Tip announcements are **${settings.notifyTipsChannel ? 'on' : 'off'}**${settings.notificationsChannelId ? ` in <#${settings.notificationsChannelId}>` : ''}.`,
      });
      return;
    }

    if (sub === 'fees') {
      const rate = await rateFor(ctx.services, ctx.userId);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.neutral)
            .setTitle('Fee policy in this server')
            .setDescription(
              `FluxTip charges a flat **$${APP_FEE_USD.toFixed(2)} USD** application fee per completed transaction (≈ ${fiatFromUsd(APP_FEE_USD, rate)}).\n\n` +
                'This applies to deposits, withdrawals, tips, sends, splits and rain. Rain is charged once per rain, not per recipient. Failed, rejected and cancelled transactions are never charged.\n\n' +
                'Server administrators cannot change, waive or collect fees, and never see user balances.',
            )
            .setFooter({ text: fxNote(rate) }),
        ],
      });
      return;
    }

    if (sub === 'disable') {
      requireManager(ctx);
      const enabled = ctx.interaction.options.getBoolean('enabled', true);
      ctx.services.servers.update(guildId, { disabled: !enabled, tipsEnabled: enabled, rainEnabled: enabled });
      audit(ctx.services.db, ctx.userId, enabled ? 'server_enable' : 'server_disable', guildId, { enabled });
      await replyPrivate(ctx.interaction, {
        content: enabled
          ? 'FluxTip features are now **enabled** in this server.'
          : 'FluxTip features are now **disabled** in this server. User wallets and history remain intact; run the command again with `enabled:true` to re-enable.',
      });
    }
  },
};

export const serverCommands: Command[] = [serverCommand];
