import { SlashCommandBuilder } from 'discord.js';
import { APP_FEE_USD, ASSETS, ASSET_ORDER, assetTicker } from '../../core/assets.ts';
import { ForbiddenError } from '../../core/errors.ts';
import { formatUnits } from '../../core/money.ts';
import { isPaused, setPaused } from '../../db/index.ts';
import { installable } from '../builders.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate } from '../context.ts';
import { COLORS, baseEmbed, fiatFromUsd, statusBadge, timestamp } from '../embeds.ts';
import type { Command } from '../types.ts';
import { rateFor } from '../views.ts';

function flags(ctx: CommandContext) {
  return { simulated: ctx.services.provider.isSimulated };
}

/** Authorization is ID-based and re-checked here, never by username. */
function requireAdmin(ctx: CommandContext): void {
  if (!ctx.services.config.adminUserIds.has(ctx.userId)) {
    throw new ForbiddenError('This command is restricted to configured FluxTip administrators.');
  }
}

const adminCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Operator tools (restricted by ADMIN_USER_IDS)')
      .addSubcommand((sub) => sub.setName('stats').setDescription('Platform statistics'))
      .addSubcommand((sub) =>
        sub
          .setName('user')
          .setDescription('Inspect one user')
          .addStringOption((option) =>
            option.setName('discord_id').setDescription('Discord user ID').setRequired(true).setMinLength(17).setMaxLength(20),
          ),
      )
      .addSubcommand((sub) => sub.setName('transactions').setDescription('Recent ledger entries'))
      .addSubcommand((sub) => sub.setName('deposits').setDescription('Recent deposits'))
      .addSubcommand((sub) => sub.setName('withdrawals').setDescription('Recent withdrawals'))
      .addSubcommand((sub) => sub.setName('revenue').setDescription('Application fee revenue'))
      .addSubcommand((sub) => sub.setName('fees').setDescription('Recent fee records'))
      .addSubcommand((sub) => sub.setName('limits').setDescription('Active limits and provider requirements'))
      .addSubcommand((sub) =>
        sub
          .setName('pause')
          .setDescription('Pause new transfers and withdrawals')
          .addStringOption((option) => option.setName('reason').setDescription('Why (audited)').setMaxLength(200)),
      )
      .addSubcommand((sub) => sub.setName('resume').setDescription('Resume transfers and withdrawals'))
      .addSubcommand((sub) => sub.setName('reconcile').setDescription('Ledger, liability and provider balance check'))
      .addSubcommand((sub) => sub.setName('health').setDescription('Database and provider health'))
      .addSubcommand((sub) => sub.setName('logs').setDescription('Recent audit log entries')),
  ),
  adminOnly: true,
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    requireAdmin(ctx);
    const sub = ctx.subcommand ?? 'stats';
    const db = ctx.services.db;
    const rate = await rateFor(ctx.services, ctx.userId);
    const embedCtx = flags(ctx);

    if (sub === 'stats') {
      const platform = ctx.services.stats.platform();
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Platform statistics')
            .addFields(
              { name: 'Users', value: String(platform.users), inline: true },
              { name: 'Funded wallets', value: String(platform.wallets), inline: true },
              { name: 'Paused', value: platform.paused ? 'yes (read-only)' : 'no', inline: true },
              { name: 'Deposits', value: String(platform.deposits), inline: true },
              { name: 'Withdrawals', value: String(platform.withdrawals), inline: true },
              { name: 'Rains', value: String(platform.rains), inline: true },
              { name: 'Completed fees', value: String(platform.feeCount), inline: true },
              { name: 'Revenue (USD)', value: fiatFromUsd(platform.revenueUsd, rate), inline: true },
              { name: 'DB size', value: `${(platform.databaseBytes / 1024 / 1024).toFixed(2)} MB`, inline: true },
              { name: 'Open requests', value: String(platform.openRequests), inline: true },
              { name: 'Active alerts', value: String(platform.activeAlerts), inline: true },
              { name: 'Uptime', value: `${Math.floor(platform.uptimeSeconds / 60)} min`, inline: true },
            )
            .setFooter({ text: `Provider mode: ${ctx.services.provider.isSimulated ? 'simulated' : 'live'} · withdrawals ${ctx.services.config.withdrawalsLive ? 'enabled' : 'disabled'}` }),
        ],
      });
      return;
    }

    if (sub === 'user') {
      const id = ctx.interaction.options.getString('discord_id', true);
      const view = ctx.services.stats.userAdminView(id);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle(`User ${view.user.userId}`)
            .addFields(
              { name: 'Currency', value: view.user.currency, inline: true },
              { name: 'Joined', value: timestamp(view.user.createdAt), inline: true },
              { name: 'Deposits / withdrawals', value: `${view.deposits} / ${view.withdrawals}`, inline: true },
              { name: 'Open requests', value: String(view.openRequests), inline: true },
              {
                name: 'Balances',
                value:
                  view.balances.length === 0
                    ? 'no funds'
                    : view.balances.map((row) => `${row.amount} ${assetTicker(row.asset)}`).join('\n'),
              },
            )
            .setFooter({ text: 'Balances are read-only here. Admin commands never expose keys or move user funds.' }),
        ],
      });
      return;
    }

    if (sub === 'transactions') {
      const rows = ctx.services.stats.recentLedger(20);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Recent ledger entries')
            .setDescription(
              rows
                .map((row) => {
                  const asset = row.asset as keyof typeof ASSETS;
                  const decimals = ASSETS[asset]?.decimals ?? 8;
                  return `\`${row.id}\` · <@${row.userId}> · ${BigInt(row.delta) >= 0n ? '+' : ''}${formatUnits(BigInt(row.delta), decimals)} ${assetTicker(asset)} · ${row.type} · \`${row.ref ?? '—'}\` · ${timestamp(row.createdAt)}`;
                })
                .join('\n') || 'None',
            )
            .setFooter({ text: 'Amounts are raw base units formatted per asset.' }),
        ],
      });
      return;
    }

    if (sub === 'deposits') {
      const rows = db.prepare('SELECT * FROM deposits ORDER BY id DESC LIMIT 15').all() as {
        id: number;
        user_id: string;
        asset: string;
        amount: string;
        status: string;
        tx_hash: string;
        created_at: number;
      }[];
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Recent deposits')
            .setDescription(
              rows
                .map((row) => {
                  const asset = row.asset as keyof typeof ASSETS;
                  return `\`d_${row.id}\` · <@${row.user_id}> · ${formatUnits(BigInt(row.amount), ASSETS[asset]?.decimals ?? 8)} ${assetTicker(asset)} · ${statusBadge(row.status)} · \`${row.tx_hash.slice(0, 12)}…\` · ${timestamp(row.created_at)}`;
                })
                .join('\n') || 'None',
            ),
        ],
      });
      return;
    }

    if (sub === 'withdrawals') {
      const rows = db.prepare('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 15').all() as {
        id: number;
        user_id: string;
        asset: string;
        amount: string;
        fees: string;
        status: string;
        address: string;
        created_at: number;
      }[];
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Recent withdrawals')
            .setDescription(
              rows
                .map((row) => {
                  const asset = row.asset as keyof typeof ASSETS;
                  return `\`w_${row.id}\` · <@${row.user_id}> · ${formatUnits(BigInt(row.amount), ASSETS[asset]?.decimals ?? 8)} ${assetTicker(asset)} · ${statusBadge(row.status)} · to \`${row.address.slice(0, 8)}…\` · ${timestamp(row.created_at)}`;
                })
                .join('\n') || 'None',
            )
            .setFooter({ text: `Live withdrawals: ${ctx.services.config.withdrawalsLive ? 'enabled' : 'disabled'}` }),
        ],
      });
      return;
    }

    if (sub === 'revenue') {
      const revenue = ctx.services.stats.revenue();
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Application fee revenue')
            .addFields(
              { name: 'Completed fees', value: String(revenue.completedCount), inline: true },
              { name: 'Revenue (USD)', value: `$${revenue.revenueUsd.toFixed(2)}`, inline: true },
              { name: 'Pending / voided', value: `${revenue.pendingCount} / ${revenue.voidedCount}`, inline: true },
              {
                name: 'By source',
                value: revenue.bySource.map((row) => `${row.refType}: ${row.count} · $${row.usd.toFixed(2)}`).join('\n') || '—',
              },
              {
                name: 'By asset',
                value: revenue.byAsset.map((row) => `${row.asset}: ${row.amount} (${row.count})`).join('\n') || '—',
              },
            )
            .setFooter({ text: 'Revenue is before provider costs, refunds and other expenses. Failed transactions are voided.' }),
        ],
      });
      return;
    }

    if (sub === 'fees') {
      const rows = ctx.services.stats.recentFees(15);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Recent fees')
            .setDescription(
              rows
                .map((row) => {
                  const asset = row.asset as keyof typeof ASSETS;
                  return `#${row.id} · ${row.refType} \`${row.refId}\` · <@${row.userId}> · ${formatUnits(BigInt(row.amount), ASSETS[asset]?.decimals ?? 8)} ${assetTicker(asset)} · $${row.usd.toFixed(2)} · ${row.status}`;
                })
                .join('\n') || 'None',
            )
            .setFooter({ text: `Flat application fee: $${APP_FEE_USD.toFixed(2)} per completed transaction` }),
        ],
      });
      return;
    }

    if (sub === 'limits') {
      const currencies = await ctx.services.provider.getCurrencies().catch(() => []);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Active limits')
            .setDescription(
              [
                `Min/Max withdrawal notional: $${ctx.services.config.minWithdrawUsd} / $${ctx.services.config.maxWithdrawUsd}`,
                `Rain recipients: ${ctx.services.config.maxRainRecipients}`,
                `App fee: $${APP_FEE_USD.toFixed(2)}`,
                `Withdrawals: ${ctx.services.config.withdrawalsLive ? 'LIVE' : 'disabled'}`,
                `Provider: ${ctx.services.provider.name}${ctx.services.provider.isSimulated ? ' (simulated)' : ''}`,
              ].join('\n'),
            )
            .addFields({
              name: 'Provider requirements',
              value:
                currencies
                  .filter((currency) => ASSET_ORDER.some((asset) => ASSETS[asset].providerSymbol === currency.symbol))
                  .map((currency) => `${currency.symbol}: min payout ${currency.minPayout}, ${currency.confirmations} confirmations`)
                  .join('\n') || 'unavailable',
            }),
        ],
      });
      return;
    }

    if (sub === 'pause') {
      const reason = ctx.interaction.options.getString('reason') ?? 'manual pause';
      setPaused(db, true, ctx.userId);
      db.prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)').run(
        ctx.userId,
        'pause_reason',
        'system',
        reason,
        Date.now(),
      );
      await replyPrivate(ctx.interaction, {
        content: 'Emergency pause engaged: new transfers and withdrawals are refused. History, balances and receipts remain available.',
      });
      return;
    }

    if (sub === 'resume') {
      setPaused(db, false, ctx.userId);
      await replyPrivate(ctx.interaction, { content: 'Transfers and withdrawals resumed.' });
      return;
    }

    if (sub === 'reconcile') {
      const report = await ctx.services.stats.reconcile();
      const embed = baseEmbed(embedCtx, report.ledgerOk ? COLORS.success : COLORS.danger)
        .setTitle('Reconciliation')
        .addFields(
          { name: 'Ledger integrity', value: report.ledgerOk ? 'OK (wallets match ledger)' : `PROBLEMS (${report.ledgerProblems.length})`, inline: false },
          {
            name: 'User liabilities',
            value: report.liabilities.map((row) => `${assetTicker(row.asset)}: ${row.amount}`).join('\n') || 'none',
            inline: false,
          },
          {
            name: 'Provider merchant balance',
            value: report.providerError
              ? report.providerError
              : Object.entries(report.providerBalances ?? {})
                  .map(([coin, amount]) => `${coin}: ${amount}`)
                  .join('\n') || 'nothing reported',
            inline: false,
          },
          {
            name: 'Open operations',
            value: [
              `pending withdrawals: ${report.pendingWithdrawals}`,
              `confirming withdrawals: ${report.confirmingWithdrawals}`,
              `pending deposits: ${report.pendingDeposits}`,
              `unprocessed webhooks: ${report.unprocessedWebhooks}`,
            ].join('\n'),
            inline: false,
          },
        )
        .setFooter({ text: `Provider: ${report.simulated ? 'simulated (balances not comparable)' : 'live'} · ledger mismatches are reported, never auto-corrected` });
      if (report.ledgerProblems.length > 0) {
        embed.addFields({ name: 'Ledger problems', value: report.ledgerProblems.slice(0, 5).join('\n').slice(0, 1000) });
      }
      await replyPrivate(ctx.interaction, { embeds: [embed] });
      return;
    }

    if (sub === 'health') {
      const health = await ctx.services.stats.health();
      const integrity = ctx.services.ledger.verifyIntegrity();
      const paused = isPaused(db);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, health.ok && integrity.ok ? COLORS.success : COLORS.warning)
            .setTitle('Health')
            .addFields(
              { name: 'Provider', value: health.ok ? 'ok' : 'degraded', inline: true },
              { name: 'Ledger', value: integrity.ok ? 'ok' : 'mismatch', inline: true },
              { name: 'Paused', value: paused ? 'yes' : 'no', inline: true },
              { name: 'Provider detail', value: health.detail.slice(0, 200) },
              { name: 'Node', value: `${process.version} · heap ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: false },
            ),
        ],
      });
      return;
    }

    if (sub === 'logs') {
      const rows = ctx.services.stats.auditLogs(20);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(embedCtx, COLORS.neutral)
            .setTitle('Audit log')
            .setDescription(
              rows
                .map((row) => `${timestamp(row.createdAt)} · **${row.action}** · \`${row.actorId}\`${row.target ? ` → \`${row.target}\`` : ''}${row.details ? ` · ${row.details.slice(0, 120)}` : ''}`)
                .join('\n') || 'No entries yet.',
            )
            .setFooter({ text: 'Reports and administrative actions are appended here. Secrets are never logged.' }),
        ],
      });
    }
  },
};

export const adminCommands: Command[] = [adminCommand];
