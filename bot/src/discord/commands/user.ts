import {
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { APP_FEE_USD, ASSETS, assetTicker, type AssetSymbol } from '../../core/assets.ts';
import { FIAT_CURRENCIES } from '../../core/fiat.ts';
import { formatUnits } from '../../core/money.ts';
import { installable } from '../builders.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate } from '../context.ts';
import { COLORS, baseEmbed, fiatFromUsd, fxNote, timestamp } from '../embeds.ts';
import { views, type PageContent } from '../pagination.ts';
import type { Command } from '../types.ts';
import { rateFor } from '../views.ts';

function flags(ctx: CommandContext) {
  return { simulated: ctx.services.provider.isSimulated };
}

function uptimeText(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
}

const profileCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Your FluxTip profile and activity')
      .addUserOption((option) => option.setName('user').setDescription('Defaults to you')),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const target = ctx.interaction.options.getUser('user') ?? ctx.interaction.user;
    const overview = ctx.services.stats.userOverview(target.id, ctx.guildId ?? undefined);
    const rate = await rateFor(ctx.services, target.id);
    const prefs = ctx.services.users.notifications(target.id);
    const embed = baseEmbed(flags(ctx), COLORS.brand)
      .setTitle(`Profile · ${target.username}`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Member since', value: timestamp(overview.joinedAt), inline: true },
        { name: 'Display currency', value: FIAT_CURRENCIES[ctx.services.users.currency(target.id)].label, inline: true },
        { name: 'Notifications', value: prefs.dm ? 'DMs enabled' : 'DMs disabled', inline: true },
        { name: 'Tips sent', value: String(overview.tipsSent), inline: true },
        { name: 'Tips received', value: String(overview.tipsReceived), inline: true },
        { name: 'Requests paid', value: String(overview.requestsPaid), inline: true },
        {
          name: 'Holdings',
          value:
            overview.balances.length === 0
              ? 'No funds yet'
              : overview.balances
                  .map((row) => `${formatUnits(row.amount, ASSETS[row.asset].decimals)} ${assetTicker(row.asset)}`)
                  .join('\n'),
        },
      )
      .setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const statsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('stats').setDescription('FluxTip platform and personal statistics')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const platform = ctx.services.stats.platform();
    const mine = ctx.services.stats.userOverview(ctx.userId, ctx.guildId ?? undefined);
    const rate = await rateFor(ctx.services, ctx.userId);
    const embed = baseEmbed(flags(ctx), COLORS.brand)
      .setTitle('FluxTip statistics')
      .addFields(
        { name: 'Users', value: String(platform.users), inline: true },
        { name: 'Funded wallets', value: String(platform.wallets), inline: true },
        { name: 'Tips / splits / rain', value: String(platform.transfers), inline: true },
        { name: 'Deposits', value: String(platform.deposits), inline: true },
        { name: 'Withdrawals', value: String(platform.withdrawals), inline: true },
        { name: 'Completed fees', value: `${platform.feeCount} · ${fiatFromUsd(platform.revenueUsd, rate)}`, inline: true },
        { name: 'Your tips sent', value: String(mine.tipsSent), inline: true },
        { name: 'Your tips received', value: String(mine.tipsReceived), inline: true },
        { name: 'Your deposits', value: String(mine.deposits), inline: true },
      )
      .setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const rankCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Your tipper rank in this server or globally')
      .addStringOption((option) =>
        option
          .setName('scope')
          .setDescription('Leaderboard scope')
          .addChoices({ name: 'This server', value: 'server' }, { name: 'Global', value: 'global' }),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const requested = ctx.interaction.options.getString('scope');
    const scope = !ctx.guildId || requested === 'global' ? 'global' : 'server';
    const rows = ctx.services.transfers.leaderboard({
      serverId: scope === 'server' ? (ctx.guildId as string) : undefined,
      limit: 25,
    });
    const index = rows.findIndex((row) => row.userId === ctx.userId);
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.brand)
          .setTitle(`Your rank · ${scope}`)
          .setDescription(
            index === -1
              ? 'You are not on the tipping leaderboard yet. Try `/tip` to get started.'
              : `**#${index + 1}** of ${rows.length} ranked tippers with **${rows[index]?.count ?? 0}** tips.`,
          ),
      ],
    });
  },
};

const settingsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('settings').setDescription('Your FluxTip preferences')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const prefs = ctx.services.users.notifications(ctx.userId);
    const currency = ctx.services.users.currency(ctx.userId);
    const rate = await rateFor(ctx.services, ctx.userId);
    const onOff = (value: boolean) => (value ? 'on' : 'off');
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('Your settings')
          .setDescription(
            [
              `**Display currency:** ${currency} (${FIAT_CURRENCIES[currency].label}) — \`/currency\``,
              `**Notifications:** deposits ${onOff(prefs.deposits)}, withdrawals ${onOff(prefs.withdrawals)}, tips ${onOff(prefs.tips)}, prices ${onOff(prefs.prices)}, receipts ${onOff(prefs.receipts)}`,
              `**DMs:** ${onOff(prefs.dm)} — \`/notify settings enabled:${!prefs.dm}\` to ${prefs.dm ? 'disable' : 'enable'}`,
              '**Privacy:** balances, addresses and receipts are ephemeral by default.',
              '',
              'These settings follow your Discord account across every server and DM.',
            ].join('\n'),
          )
          .setFooter({ text: fxNote(rate) }),
      ],
    });
  },
};

const privacyCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('privacy').setDescription('What FluxTip stores and how to control it')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('Privacy')
          .setDescription(
            [
              'FluxTip stores only what it needs to run your wallet:',
              '• your Discord user ID (never usernames)',
              '• balances and a full ledger of every balance change',
              '• deposit addresses and provider transaction references',
              '• your display currency and notification preferences',
              '• server settings keyed by server ID',
              '',
              'What it never does:',
              '• show balances, addresses or receipts publicly by default',
              '• log tokens, API keys or webhook secrets',
              '• share one server\'s settings with another',
              '',
              'You can download everything with `/export`. For deletion, open a `/report` and staff will process it after checking for a zero balance and open withdrawals.',
            ].join('\n'),
          )
          .setFooter({ text: 'Server administrators cannot access your wallet or funds.' }),
      ],
    });
  },
};

const exportCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('export').setDescription('Download your FluxTalk data as JSON')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const db = ctx.services.db;
    const payload = {
      exportedAt: new Date().toISOString(),
      discordUserId: ctx.userId,
      user: db.prepare('SELECT * FROM users WHERE user_id = ?').get(ctx.userId) ?? null,
      wallets: db.prepare('SELECT asset, network, available FROM wallets WHERE user_id = ?').all(ctx.userId),
      ledger: db.prepare('SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY id ASC').all(ctx.userId),
      deposits: db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY id ASC').all(ctx.userId),
      withdrawals: db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id ASC').all(ctx.userId),
      transfers: db
        .prepare('SELECT * FROM transfers WHERE from_user_id = ? OR to_user_id = ? ORDER BY id ASC')
        .all(ctx.userId, ctx.userId),
      requests: db
        .prepare('SELECT * FROM payment_requests WHERE requester_id = ? OR payer_id = ? ORDER BY created_at ASC')
        .all(ctx.userId, ctx.userId),
      alerts: db.prepare('SELECT * FROM price_alerts WHERE user_id = ?').all(ctx.userId),
      depositAddresses: db
        .prepare('SELECT asset, network, address, created_at FROM deposit_addresses WHERE user_id = ?')
        .all(ctx.userId),
    };
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
      name: `fluxtip-export-${ctx.userId}.json`,
    });
    await replyPrivate(ctx.interaction, {
      content: 'Your data export is attached. Keep it private.',
      files: [file],
    });
  },
};

const supportCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('support').setDescription('Get help with FluxTip')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const url = ctx.services.config.supportServerUrl;
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('FluxTip support')
          .setDescription(
            [
              url ? `Support server: ${url}` : 'No support server is configured for this deployment.',
              'Use `/report` to send a report to the bot operators with the details they need.',
              'For a stuck withdrawal, include the `w_` reference from `/withdrawals`. For a deposit, include the transaction hash.',
              'Never share API keys, seed phrases or private keys with anyone, including staff.',
            ].join('\n\n'),
          ),
      ],
    });
  },
};

const helpCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('help').setDescription('How FluxTip works, plus the full command list')),
  async execute(ctx) {
    // Help is public in servers (non-sensitive information)
    const isPublic = ctx.interaction.inGuild();
    
    if (isPublic) {
      // Public reply in guild - no ephemeral flag
      await ctx.interaction.reply({
        embeds: [await buildHelpEmbed(ctx)],
      });
    } else {
      // Private in DMs - use ephemeral flag
      await deferPrivate(ctx.interaction);
      await ctx.interaction.editReply({ embeds: [await buildHelpEmbed(ctx)] });
    }
  },
};

async function buildHelpEmbed(ctx: CommandContext): Promise<import('discord.js').EmbedBuilder> {
  const { commandsByCategory } = await import('../registry.ts');
  const isAdmin = ctx.services.config.adminUserIds.has(ctx.userId);
  const categories = commandsByCategory(isAdmin);
  
  // Map registry categories to original FluxTip categories
  const walletCmds = categories.find(c => c.name === 'Wallet')?.commands ?? [];
  const transferCmds = categories.find(c => c.name === 'Tips & transfers')?.commands ?? [];
  const accountCmds = categories.find(c => c.name === 'Account')?.commands ?? [];
  const marketCmds = categories.find(c => c.name === 'Market')?.commands ?? [];
  
  // Build the five original categories
  const embed = baseEmbed(flags(ctx), COLORS.brand)
    .setTitle('<:Wallet:1543646214275203163> FluxTip Help')
    .setDescription(
      [
        'FluxTip is a global, multi-server crypto wallet and tipping bot. Your wallet, history and settings follow your **Discord account**, not a server.',
        '',
        '**Quick Start**',
        '1. `$deposit BTC` — get your own address and QR code',
        '2. Wait for the provider to credit the deposit',
        '3. `$tip @user 0.001 USDT_TRC20` — tip a friend',
        '4. `$currency` to pick how fiat estimates are displayed',
        '',
        '**Fees:** $0.05 flat per completed transaction; `$fees` for the full policy.',
        '**Privacy:** balances, addresses and receipts are private by default.',
        '**Commands:** `$cmds` for the paginated, registered list.',
        '',
        'Prefix commands work with `$` in addition to `/`. For example: `$wallet` = `/wallet`, `$bal` = `/balance`.',
      ].join('\n'),
    )
    .addFields(
      // 1. Wallet
      {
        name: '<:Wallet:1543646214275203163> Wallet',
        value: [
          '`/wallet` · `/balance` · `/deposit`',
          '`/addresses` · `/addy` · `/address`',
          '`/withdraw` · `/withdrawals`',
          '`/fees` · `/limits` · `/currency`',
          '`/convert` · `/portfolio` · `/allocation`',
          '`/networth` · `/qr`',
        ].join('\n'),
        inline: false,
      },
      // 2. Transfers
      {
        name: '<:transfers:1543646350355341434> Transfers',
        value: [
          '`/tip` · `/send` · `/split`',
          '`/rain` · `/request` · `/pay`',
          '`/cancel request`',
          '`/transactions` · `/transaction`',
          '`/receipt` · `/tipstats`',
          '`/tipleaderboard`',
        ].join('\n'),
        inline: false,
      },
      // 3. History
      {
        name: '📜 History',
        value: [
          '`/wallet activity`',
          '`/deposits` · `/withdrawals`',
          '`/transactions` · `/transaction`',
          '`/receipt`',
        ].join('\n'),
        inline: false,
      },
      // 4. Utility
      {
        name: '🔧 Utility',
        value: [
          '`/help` · `/cmds` · `/ping`',
          '`/uptime` · `/status` · `/about`',
          '`/invite` · `/changelog`',
          '`/profile` · `/stats` · `/rank`',
          '`/settings` · `/privacy` · `/export`',
          '`/support` · `/report`',
          '`/notifications` · `/notify`',
          '`/server stats` · `/server settings`',
          '`/server leaderboard` · `/server fees`',
          '`/server notifications` · `/server disable`',
        ].join('\n'),
        inline: false,
      },
      // 5. Supported Assets
      {
        name: '💎 Supported Assets',
        value: [
          '`BTC` — Bitcoin (Bitcoin network)',
          '`LTC` — Litecoin (Litecoin network)',
          '`ETH` — Ethereum (Ethereum network)',
          '`SOL` — Solana (Solana network)',
          '`USDT_TRC20` — Tether USD (TRON TRC-20)',
          '',
          'USDT is only supported on TRON (TRC-20).',
          'It is never confused with USDT on Ethereum or Solana.',
        ].join('\n'),
        inline: false,
      },
    )
    .setFooter({ text: '⚡ FluxTip · Prefix commands: use $ instead of /' });
  
  return embed;
}

const cmdsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('cmds').setDescription('All registered FluxTip commands, paginated')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const { registeredCommands } = await import('../registry.ts');
    const all = registeredCommands(ctx.services.config.adminUserIds.has(ctx.userId));
    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    const render = async (page: number): Promise<PageContent> => {
      const slice = all.slice(page * pageSize, page * pageSize + pageSize);
      const embed = baseEmbed(flags(ctx), COLORS.neutral)
        .setTitle('Command list')
        .setDescription(
          slice
            .map((command) => {
              const json = command.data.toJSON();
              const subs = (json.options ?? [])
                .filter((option) => option.type === 1 || option.type === 2)
                .map((option) => option.name);
              return `**/${json.name}** — ${json.description}${subs.length ? `\n> ${subs.map((name) => `${json.name} ${name}`).join(' · ')}` : ''}`;
            })
            .join('\n'),
        )
        .setFooter({ text: `Page ${page + 1} of ${totalPages} · ${all.length} commands registered globally` });
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

const pingCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('ping').setDescription('Check bot latency')),
  async execute(ctx) {
    const sent = Date.now();
    // Ping is public in servers, private in DMs
    if (ctx.interaction.inGuild()) {
      await ctx.interaction.reply({ content: 'Pinging…' });
    } else {
      await ctx.interaction.reply({ content: 'Pinging…', flags: MessageFlags.Ephemeral });
    }
    const roundTrip = Date.now() - sent;
    const dbStart = performance.now();
    ctx.services.stats.platform();
    const dbMs = performance.now() - dbStart;
    await ctx.interaction.editReply({
      embeds: [
        baseEmbed(flags(ctx), COLORS.success)
          .setTitle('Pong')
          .setDescription(
            `Round trip: **${roundTrip}ms**\nWebSocket: **${Math.round(ctx.client.ws.ping)}ms**\nDatabase: **${dbMs.toFixed(1)}ms**`,
          ),
      ],
    });
  },
};

const uptimeCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('uptime').setDescription('How long FluxTip has been running')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const started = Date.now() - process.uptime() * 1000;
    await replyPrivate(ctx.interaction, {
      content: `Online for **${uptimeText(process.uptime())}** (since ${timestamp(started)}).`,
    });
  },
};

const statusCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('status').setDescription('Live service and provider status')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const health = await ctx.services.stats.health();
    const platform = ctx.services.stats.platform();
    const withdrawMode = ctx.services.provider.isSimulated
      ? 'simulated provider (no real payouts)'
      : ctx.services.config.withdrawalsLive
        ? 'live, provider-confirmed'
        : 'live withdrawals disabled';
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), health.ok ? COLORS.success : COLORS.warning)
          .setTitle('FluxTip status')
          .addFields(
            { name: 'Bot', value: `online · ${uptimeText(process.uptime())}`, inline: true },
            { name: 'Provider', value: health.ok ? 'reachable' : 'degraded', inline: true },
            { name: 'Transfers', value: platform.paused ? 'paused (read-only)' : 'enabled', inline: true },
            { name: 'Withdrawals', value: withdrawMode, inline: false },
            { name: 'Provider detail', value: health.detail.slice(0, 200), inline: false },
            { name: 'Open requests', value: String(platform.openRequests), inline: true },
            { name: 'Active alerts', value: String(platform.activeAlerts), inline: true },
            { name: 'Database', value: `${(platform.databaseBytes / 1024 / 1024).toFixed(1)} MB`, inline: true },
          )
          .setFooter({ text: ctx.services.config.statusPageUrl ?? 'No status page configured' }),
      ],
    });
  },
};

const aboutCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('about').setDescription('About FluxTip')),
  async execute(ctx) {
    // About is public in servers, private in DMs
    const isPublic = ctx.interaction.inGuild();
    
    if (isPublic) {
      await ctx.interaction.reply({
        embeds: [
          baseEmbed(flags(ctx), COLORS.brand)
            .setTitle('About FluxTip')
            .setDescription(
              [
                'A global Discord crypto wallet and tipping bot for **BTC, LTC, ETH, SOL and USDT (TRC-20)**.',
                '',
                `• Flat **$${APP_FEE_USD.toFixed(2)}** application fee per completed transaction`,
                '• One wallet per Discord account, usable in every server and DM',
                '• Deposits and withdrawals settled through the OrbChain gateway',
                '• Ledger-based accounting with idempotent, atomic writes',
                '• Ephemeral responses for anything private',
                '',
                'FluxTip is a custodial tipping service, not a bank or exchange. Fiat values are estimates, never execution prices.',
              ].join('\n'),
            )
            .setFooter({ text: `Version ${process.env.npm_package_version ?? '1.0.0'} · global commands may take time to appear after a deploy` }),
        ],
      });
    } else {
      await deferPrivate(ctx.interaction);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.brand)
            .setTitle('About FluxTip')
            .setDescription(
              [
                'A global Discord crypto wallet and tipping bot for **BTC, LTC, ETH, SOL and USDT (TRC-20)**.',
                '',
                `• Flat **$${APP_FEE_USD.toFixed(2)}** application fee per completed transaction`,
                '• One wallet per Discord account, usable in every server and DM',
                '• Deposits and withdrawals settled through the OrbChain gateway',
                '• Ledger-based accounting with idempotent, atomic writes',
                '• Ephemeral responses for anything private',
                '',
                'FluxTip is a custodial tipping service, not a bank or exchange. Fiat values are estimates, never execution prices.',
              ].join('\n'),
            )
            .setFooter({ text: `Version ${process.env.npm_package_version ?? '1.0.0'} · global commands may take time to appear after a deploy` }),
        ],
      });
    }
  },
};

const inviteCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('invite').setDescription('Add FluxTip to a server or install it for your account')),
  async execute(ctx) {
    // Invite is public in servers, private in DMs
    const isPublic = ctx.interaction.inGuild();
    const clientId = ctx.client.user?.id ?? ctx.services.config.discordClientId;
    const guildInvite = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=379904&scope=bot%20applications.commands`;
    const userInstall = `https://discord.com/oauth2/authorize?client_id=${clientId}&integration_type=1&scope=applications.commands`;
    
    if (isPublic) {
      await ctx.interaction.reply({
        embeds: [
          baseEmbed(flags(ctx), COLORS.brand)
            .setTitle('Invite FluxTip')
            .setDescription(
              [
                `[Add to a server](${guildInvite}) — scopes: \`bot\` + \`applications.commands\`, minimum permissions for embeds, attachments and replies.`,
                '',
                `[Install for your account](${userInstall}) — use wallet, tipping and price commands in DMs where Discord permits it.`,
                '',
                'Commands are registered **globally**, so a newly invited server may need up to an hour to see them. FluxTip is not required to be in a server for you to use your wallet.',
              ].join('\n'),
            )
            .setFooter({ text: 'Server admins control server-only features; they never get access to your wallet.' }),
        ],
      });
    } else {
      await deferPrivate(ctx.interaction);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed(flags(ctx), COLORS.brand)
            .setTitle('Invite FluxTip')
            .setDescription(
              [
                `[Add to a server](${guildInvite}) — scopes: \`bot\` + \`applications.commands\`, minimum permissions for embeds, attachments and replies.`,
                '',
                `[Install for your account](${userInstall}) — use wallet, tipping and price commands in DMs where Discord permits it.`,
                '',
                'Commands are registered **globally**, so a newly invited server may need up to an hour to see them. FluxTip is not required to be in a server for you to use your wallet.',
              ].join('\n'),
            )
            .setFooter({ text: 'Server admins control server-only features; they never get access to your wallet.' }),
        ],
      });
    }
  },
};

const changelogCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('changelog').setDescription('Recent FluxTip changes')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('Changelog')
          .setDescription(
            [
              '**1.0.0 — initial release**',
              '• Global slash commands with server, DM and user-install contexts',
              '• Per-user wallets with BTC, LTC, ETH, SOL and USDT (TRC-20)',
              '• OrbChain static deposit addresses, verified webhooks and polling backstop',
              '• Withdrawals with provider idempotency, confirmation tracking and automatic refunds',
              '• Tips, sends, splits, rain, payment requests and private receipts',
              '• Flat $0.05 application fee with ledger-backed revenue reporting',
              '• 16 display currencies, market tools, price alerts and notifications',
              '• Admin tooling: pause/resume, reconciliation, health and audit logs',
            ].join('\n'),
          )
          .setFooter({ text: 'Simulated provider data is always labelled as simulated.' }),
      ],
    });
  },
};

const reportCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('report')
      .setDescription('Report a problem to the FluxTip operators')
      .addStringOption((option) => option.setName('message').setDescription('What went wrong?').setRequired(true).setMaxLength(1000))
      .addStringOption((option) =>
        option
          .setName('category')
          .setDescription('Report category')
          .addChoices(
            { name: 'Deposit', value: 'deposit' },
            { name: 'Withdrawal', value: 'withdrawal' },
            { name: 'Tip or transfer', value: 'transfer' },
            { name: 'Bug', value: 'bug' },
            { name: 'Privacy', value: 'privacy' },
            { name: 'Other', value: 'other' },
          ),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const message = ctx.interaction.options.getString('message', true);
    const category = ctx.interaction.options.getString('category') ?? 'other';
    ctx.services.db
      .prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(
        ctx.userId,
        'user_report',
        ctx.userId,
        JSON.stringify({
          category,
          message,
          guildId: ctx.guildId,
          channelId: ctx.interaction.channelId,
        }),
        Date.now(),
      );
    await replyPrivate(ctx.interaction, {
      content: `Report recorded (${category}). The operators can review it with \`/admin logs\`. Never include secrets in a report.`,
    });
  },
};

const notificationsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('notifications').setDescription('Your notification preferences')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const prefs = ctx.services.users.notifications(ctx.userId);
    const onOff = (value: boolean) => (value ? '✅ on' : '⚫ off');
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed(flags(ctx), COLORS.neutral)
          .setTitle('Notifications')
          .setDescription(
            [
              `Deposits: ${onOff(prefs.deposits)}`,
              `Withdrawals: ${onOff(prefs.withdrawals)}`,
              `Tips: ${onOff(prefs.tips)}`,
              `Price alerts: ${onOff(prefs.prices)}`,
              `Receipts: ${onOff(prefs.receipts)}`,
              `Direct messages: ${onOff(prefs.dm)}`,
              '',
              'Change any of these with `/notify`. If your DMs are closed, FluxTip simply skips the message and everything remains available with `/transactions`.',
            ].join('\n'),
          ),
      ],
    });
  },
};

const notifyCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('notify')
      .setDescription('Configure FluxTip notifications')
      .addSubcommand((sub) =>
        sub
          .setName('deposits')
          .setDescription('Deposit notifications')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Leave empty to toggle')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('withdrawals')
          .setDescription('Withdrawal notifications')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Leave empty to toggle')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('tips')
          .setDescription('Tip notifications')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Leave empty to toggle')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('prices')
          .setDescription('Price alert notifications')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Leave empty to toggle')),
      )
      .addSubcommand((sub) =>
        sub
          .setName('settings')
          .setDescription('All notifications and DM delivery')
          .addBooleanOption((option) => option.setName('enabled').setDescription('Enable or disable DMs')),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const sub = ctx.subcommand ?? 'settings';
    const key = sub === 'settings' ? 'dm' : (sub as 'deposits' | 'withdrawals' | 'tips' | 'prices');
    const explicit = ctx.interaction.options.getBoolean('enabled') ?? undefined;
    const next = ctx.services.users.toggleNotification(ctx.userId, key, explicit);
    await replyPrivate(ctx.interaction, {
      content: `${key === 'dm' ? 'Direct messages' : `${key} notifications`} are now **${next ? 'on' : 'off'}**.`,
    });
  },
};

export const userCommands: Command[] = [
  profileCommand,
  statsCommand,
  rankCommand,
  settingsCommand,
  privacyCommand,
  exportCommand,
  supportCommand,
  helpCommand,
  cmdsCommand,
  pingCommand,
  uptimeCommand,
  statusCommand,
  aboutCommand,
  inviteCommand,
  changelogCommand,
  reportCommand,
  notificationsCommand,
  notifyCommand,
];
