import {
  ActionRowBuilder,
  AttachmentBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import QRCode from 'qrcode';
import { APP_FEE_USD, ASSETS, ASSET_ORDER, assetNetworkLabel, assetTicker, isAssetSymbol, type AssetSymbol } from '../../core/assets.ts';
import { AppError, ValidationError } from '../../core/errors.ts';
import { FIAT_CURRENCIES, FIAT_CODES, formatFiat, type FiatCode } from '../../core/fiat.ts';
import { formatUnits, parseUnits } from '../../core/money.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate } from '../context.ts';
import {
  COLORS,
  baseEmbed,
  cryptoAmount,
  errorEmbed,
  feeLine,
  fiatFromUsd,
  fxNote,
  statusBadge,
  successEmbed,
  timestamp,
} from '../embeds.ts';
import { assetFromOption, addAssetOption, guildOnly, installable } from '../builders.ts';
import { views, type PageContent } from '../pagination.ts';
import type { Command } from '../types.ts';
import { allocationBar, rateFor, walletSnapshot } from '../views.ts';
import { displayName } from '../views.ts';


const PAGE_SIZE = 5;

function requireAsset(interaction: ChatInputCommandInteraction): AssetSymbol {
  const raw = interaction.options.getString('asset', true);
  if (!isAssetSymbol(raw)) throw new ValidationError('Unsupported asset.');
  return raw;
}

function simulated(ctx: CommandContext): boolean {
  return ctx.services.provider.isSimulated;
}

async function replyError(ctx: CommandContext, error: unknown): Promise<void> {
  const message = error instanceof AppError ? error.userMessage : 'That could not be completed. Please try again.';
  await replyPrivate(ctx.interaction, { embeds: [errorEmbed({ simulated: simulated(ctx) }, message)] });
}

async function priceMap(ctx: CommandContext): Promise<Partial<Record<AssetSymbol, number>>> {
  try {
    return (await ctx.services.prices.snapshot()).prices;
  } catch {
    return {};
  }
}

const walletCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('wallet')
      .setDescription('Your FluxTip wallet: balances, activity and value')
      .addSubcommand((sub) => sub.setName('view').setDescription('Balances with fiat estimates'))
      .addSubcommand((sub) => sub.setName('activity').setDescription('Recent wallet activity')),
  ),
  async execute(ctx) {
    const sub = ctx.subcommand ?? 'view';
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const rate = await rateFor(ctx.services, ctx.userId);
    const snapshot = await walletSnapshot(ctx.services, ctx.userId);

    if (sub === 'activity') {
      const total = ctx.services.ledger.count(ctx.userId);
      const totalPages = Math.max(1, Math.ceil(total / 10));
      const viewId = views.create(ctx.userId, async (page) => {
        const rows = ctx.services.ledger.history(ctx.userId, { limit: 10, offset: page * 10 });
        const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
          .setTitle('Wallet activity')
          .setDescription(
            rows.length === 0
              ? 'No activity yet. Your tips, transfers and withdrawals will appear here.'
              : rows
                  .map((row) => {
                    const asset = row.asset as AssetSymbol;
                    const delta = BigInt(row.delta);
                    const sign = delta > 0n ? '+' : '';
                    return `${sign}**${formatUnits(delta, ASSETS[asset].decimals)} ${assetTicker(asset)}** · ${row.entry_type.replaceAll('_', ' ')} · ${timestamp(row.created_at)} · \`${row.ref_id ?? '—'}\``;
                  })
                  .join('\n'),
          )
          .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
        return { embeds: [embed], totalPages };
      });
      const first = await (async () => {
        const rows = ctx.services.ledger.history(ctx.userId, { limit: 10, offset: 0 });
        const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
          .setTitle('Wallet activity')
          .setDescription(
            rows.length === 0
              ? 'No activity yet. Your tips, transfers and withdrawals will appear here.'
              : rows
                  .map((row) => {
                    const asset = row.asset as AssetSymbol;
                    const delta = BigInt(row.delta);
                    const sign = delta > 0n ? '+' : '';
                    return `${sign}**${formatUnits(delta, ASSETS[asset].decimals)} ${assetTicker(asset)}** · ${row.entry_type.replaceAll('_', ' ')} · ${timestamp(row.created_at)} · \`${row.ref_id ?? '—'}\``;
                  })
                  .join('\n'),
          )
          .setFooter({ text: `Page 1 of ${totalPages}` });
        return { embeds: [embed], totalPages };
      })();
      await replyPrivate(ctx.interaction, {
        embeds: first.embeds,
        components: totalPages > 1 ? [views.row(viewId, 0, totalPages)] : [],
      });
      return;
    }

    // Wallet is private financial info - always use ephemeral
    await deferPrivate(ctx.interaction);
    
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
      .setTitle(`<:briefcase:1543629336861479044> ${displayName(ctx.interaction)}'s Wallet`)
      .addFields({
        name: 'Balances',
        value:
          snapshot.lines.length === 0
            ? 'No funds yet. Use `/deposit` to get an address for BTC, LTC, ETH, SOL or USDT (TRC-20).'
            : snapshot.lines
                .map(
                  (line) => {
                    const asset = line.asset;
                    const emoji = asset === 'BTC' ? '₿' : asset === 'ETH' ? '⟠' : asset === 'SOL' ? '◎' : asset === 'USDT_TRC20' ? '₮' : '●';
                    return `${emoji} **${formatUnits(line.base, ASSETS[line.asset].decimals)} ${assetTicker(line.asset)}** · ${ASSETS[line.asset].networkLabel} · ${line.usd === null ? 'price unavailable' : `≈ ${fiatFromUsd(line.usd, rate)}`}`;
                  }
                )
                .join('\n'),
      })
      .addFields({
        name: '🏆 Portfolio Total',
        value: snapshot.partial
          ? `${fiatFromUsd(snapshot.totalUsd, rate)} (some assets have no verified price right now)`
          : `${fiatFromUsd(snapshot.totalUsd, rate)}`,
        inline: true,
      })
      .addFields({ name: 'Display currency', value: `${rate.displayCode} · \`/currency\``, inline: true })
      .setFooter({ text: '⚡ FluxTip' });

    await replyPrivate(ctx.interaction, {
      embeds: [embed],
      components: [],
    });
  },
};

function ensureUser(ctx: CommandContext): void {
  ctx.services.users.ensure(ctx.userId);
}

const balanceCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('balance')
      .setDescription('Show your balance for one asset or all assets')
      .addStringOption((option) => addAssetOption(option, false)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const rate = await rateFor(ctx.services, ctx.userId);
    const selected = ctx.interaction.options.getString('asset');
    const prices = await priceMap(ctx);

    if (selected) {
      if (!isAssetSymbol(selected)) throw new ValidationError('Unsupported asset.');
      const base = ctx.services.ledger.balance(ctx.userId, selected);
      const price = prices[selected];
      const usd = typeof price === 'number' ? Number(formatUnits(base, ASSETS[selected].decimals)) * price : null;
      const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
        .setTitle(`${assetTicker(selected)} balance`)
        .setDescription(`**${formatUnits(base, ASSETS[selected].decimals)} ${assetTicker(selected)}**`)
        .addFields({ name: 'Network', value: ASSETS[selected].networkLabel, inline: true })
        .addFields({
          name: 'Estimate',
          value: usd === null ? 'No verified price available' : fiatFromUsd(usd, rate),
          inline: true,
        })
        .setFooter({ text: fxNote(rate) });
      await replyPrivate(ctx.interaction, { embeds: [embed] });
      return;
    }

    const balances = ASSET_ORDER.map((asset) => {
      const base = ctx.services.ledger.balance(ctx.userId, asset);
      return `${assetTicker(asset).padEnd(6)} ${formatUnits(base, ASSETS[asset].decimals)}`;
    });
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
      .setTitle('Balances')
      .setDescription(`\`\`\`\n${balances.join('\n')}\n\`\`\``)
      .setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const depositCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('deposit')
      .setDescription('Get your personal deposit address and QR code')
      .addStringOption((option) => addAssetOption(option, true)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const asset = requireAsset(ctx.interaction);
    const address = await ctx.services.addresses.ensure(ctx.userId, asset);
    const currencies = await ctx.services.provider.getCurrencies().catch(() => []);
    const info = currencies.find((currency) => currency.symbol === ASSETS[asset].providerSymbol);
    const qr = await QRCode.toBuffer(address.address, { type: 'png', width: 320, margin: 1, errorCorrectionLevel: 'M' });
    const attachment = new AttachmentBuilder(qr, { name: 'flux-deposit-qr.png' });

    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.success)
      .setTitle(`${assetNetworkLabel(asset)} deposit`)
      .setDescription(
        [
          `Send only **${assetTicker(asset)} on ${ASSETS[asset].networkLabel}** to this address:`,
          `\`\`\`\n${address.address}\n\`\`\``,
          'Deposits are credited automatically after the provider reports them as credited. A $0.05 application fee is taken from the credited amount.',
          info ? `Provider confirmation requirement: **${info.confirmations}** confirmations.` : '',
          info ? `Provider minimum payout for this asset: **${info.minPayout} ${assetTicker(asset)}**.` : '',
          'Sending the wrong asset or network to this address can result in permanent loss. FluxTip never credits a deposit from a screenshot or transaction hash alone.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
      .setImage('attachment://flux-deposit-qr.png')
      .setFooter({ text: 'Address is bound to your Discord user ID and belongs to you in every server.' });

    await replyPrivate(ctx.interaction, { embeds: [embed], files: [attachment] });
  },
};

const depositsCommand: Command = {
  data: installable(
    new SlashCommandBuilder().setName('deposits').setDescription('Your deposit history and confirmation status'),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const total = ctx.services.deposits.count(ctx.userId);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const render = async (page: number): Promise<PageContent> => {
      const rows = ctx.services.deposits.history(ctx.userId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
        .setTitle('Deposit history')
        .setDescription(
          rows.length === 0
            ? 'No deposits yet. Use `/deposit` to get an address.'
            : rows
                .map((row) => {
                  const asset = row.asset as AssetSymbol;
                  return [
                    `\`d_${row.id}\` · **${formatUnits(BigInt(row.amount), ASSETS[asset].decimals)} ${assetTicker(asset)}** · ${statusBadge(row.status)}`,
                    `Net credited: ${formatUnits(BigInt(row.net), ASSETS[asset].decimals)} ${assetTicker(asset)} · confirmations ${row.confirmations}/${row.required_confirmations || '—'} · ${timestamp(row.created_at)}`,
                    row.failure_reason ? `Reason: ${row.failure_reason}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n');
                })
                .join('\n\n'),
        )
        .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
      return { embeds: [embed], totalPages };
    };
    const first = await render(0);
    const viewId = views.create(ctx.userId, render);
    await replyPrivate(ctx.interaction, {
      embeds: first.embeds,        components: totalPages > 1 ? [views.row(viewId, 0, totalPages)] : [],
    });
  },
};

async function addressesReply(ctx: CommandContext): Promise<void> {
  await deferPrivate(ctx.interaction);
  ensureUser(ctx);
  const rows = ctx.services.addresses.list(ctx.userId);
  if (rows.length === 0) {
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
          .setTitle('No deposit addresses yet')
          .setDescription('Run `/deposit asset:<coin>` to generate your first address. Only addresses returned by the provider are shown.'),
      ],
    });
    return;
  }
  const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
    .setTitle('Your deposit addresses')
    .setDescription('Each address belongs to your Discord user ID and works in every server. Only generated addresses are listed.');
  for (const row of rows) {
    const asset = row.asset as AssetSymbol;
    embed.addFields({
      name: `${assetTicker(asset)} · ${ASSETS[asset].networkLabel}`,
      value: `\`${row.address}\`\nAdded ${timestamp(row.created_at)}`,
    });
  }
  await replyPrivate(ctx.interaction, { embeds: [embed] });
}

const addressesCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('addresses').setDescription('List all your deposit addresses')),
  execute: addressesReply,
};

const addressCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('address').setDescription('Alias for /addresses')),
  execute: addressesReply,
};

const addyCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('addy').setDescription('Show all your deposit addresses')),
  execute: addressesReply,
};

const withdrawCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('withdraw')
      .setDescription('Send crypto from your FluxTip balance to an external address')
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) =>
        option.setName('amount').setDescription('Amount in coin units, e.g. 0.005').setRequired(true).setMaxLength(32),
      )
      .addStringOption((option) =>
        option.setName('address').setDescription('Destination on-chain address').setRequired(true).setMaxLength(128),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const asset = requireAsset(ctx.interaction);
    const amountRaw = ctx.interaction.options.getString('amount', true);
    const address = ctx.interaction.options.getString('address', true);
    const amountBase = parseUnits(amountRaw, ASSETS[asset].decimals);

    const quote = await ctx.services.withdrawals.quote(ctx.userId, asset, amountBase);
    const row = await ctx.services.withdrawals.create({
      userId: ctx.userId,
      asset,
      amountBase,
      address,
      interactionId: ctx.interaction.id,
    });
    const rate = await rateFor(ctx.services, ctx.userId);
    const embed = successEmbed(
      { simulated: simulated(ctx) },
      row.status === 'failed' ? 'Withdrawal failed — funds returned' : 'Withdrawal submitted',
    )
      .setDescription(
        [
          `**Amount:** ${formatUtils(asset, BigInt(row.amount))}`,
          `**Application fee:** ${formatUtils(asset, BigInt(row.fee))} ($${APP_FEE_USD.toFixed(2)})`,
          `**Net payout:** ${formatUtils(asset, BigInt(row.net))}`,
          `**Network:** ${ASSETS[asset].networkLabel}`,
          `**To:** \`${row.address}\``,
          `**Status:** ${statusBadge(row.status)}`,
          row.provider_track_id ? `**Provider reference:** \`${row.provider_track_id}\`` : '',
          row.provider_tx_hash ? `**Transaction:** \`${row.provider_tx_hash}\`` : '',
          row.failure_reason ? `**Reason:** ${row.failure_reason}` : '',
          '',
          quote.providerNetworkFeeNote,
          'A withdrawal is only complete once the provider confirms it on-chain.',
        ]
          .filter((line) => line !== null)
          .join('\n'),
      )
      .setFooter({ text: fxNote(rate) + ' · withdrawals are not shown publicly' });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

function formatUtils(asset: AssetSymbol, base: bigint): string {
  return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
}

const withdrawalsCommand: Command = {
  data: installable(
    new SlashCommandBuilder().setName('withdrawals').setDescription('Your withdrawal history'),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const total = ctx.services.withdrawals.count(ctx.userId);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const render = async (page: number): Promise<PageContent> => {
      const rows = ctx.services.withdrawals.history(ctx.userId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
        .setTitle('Withdrawal history')
        .setDescription(
          rows.length === 0
            ? 'No withdrawals yet.'
            : rows
                .map((row) => {
                  const asset = row.asset as AssetSymbol;
                  return [
                    `\`w_${row.id}\` · **${formatUtils(asset, BigInt(row.amount))}** · ${statusBadge(row.status)}`,
                    `Net ${formatUtils(asset, BigInt(row.net))} · fee ${formatUtils(asset, BigInt(row.fee))} · to \`${row.address.slice(0, 8)}…${row.address.slice(-6)}\` · ${timestamp(row.created_at)}`,
                    row.failure_reason ? `Reason: ${row.failure_reason}` : '',
                  ]
                    .filter(Boolean)
                    .join('\n');
                })
                .join('\n\n'),
        )
        .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
      return { embeds: [embed], totalPages };
    };
    const first = await render(0);
    const viewId = views.create(ctx.userId, render);
    await replyPrivate(ctx.interaction, {
      embeds: first.embeds,        components: totalPages > 1 ? [views.row(viewId, 0, totalPages)] : [],
    });
  },
};

const feesCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('fees').setDescription('How FluxTip application fees work')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const rate = await rateFor(ctx.services, ctx.userId);
    const fee = rate.fellBackToUsd ? `$${APP_FEE_USD.toFixed(2)}` : `${formatFiat(APP_FEE_USD * rate.rate, rate.displayCode as FiatCode, { decimals: 2 })} ($${APP_FEE_USD.toFixed(2)})`;
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
      .setTitle('FluxTip fee policy')
      .setDescription(
        [
          `**Flat application fee: $${APP_FEE_USD.toFixed(2)} per completed transaction** — about ${fee} in your display currency.`,
          '',
          '**Charged on** deposits, withdrawals, tips, sends and rain. Rain is charged once per rain, not per recipient. Splits are charged once.',
          '',
          '**How it is taken**',
          '• Deposit: withheld from the credited amount.',
          '• Withdrawal: included in the amount you request; the payout is the net amount.',
          '• Tip / send / split / rain: taken from your balance on top of the amount. If your balance cannot cover both, the fee is deducted from the amount being sent and the recipient receives the net amount.',
          '',
          '**Never charged** on failed, rejected or cancelled transactions. Provider and blockchain network fees are separate and are not FluxTip revenue.',
          'Fees are converted at the verified USD rate at the time of the transaction; the rate and timestamp are stored with each fee.',
        ].join('\n'),
      )
      .setFooter({ text: fxNote(rate) + ' · no fee confirmation prompts' });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const limitsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('limits').setDescription('Deposit, withdrawal and fee limits')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const currencies = await ctx.services.provider.getCurrencies().catch(() => []);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
      .setTitle('Limits and requirements')
      .setDescription(
        [
          `Minimum withdrawal notional: **$${ctx.services.config.minWithdrawUsd.toFixed(2)}**`,
          `Maximum withdrawal notional for one transaction: **$${ctx.services.config.maxWithdrawUsd.toFixed(2)}**`,
          `Application fee: **$${APP_FEE_USD.toFixed(2)}** flat per completed transaction`,
          `Rain recipients: up to **${ctx.services.config.maxRainRecipients}** users from this server's FluxTip rain pool`,
          'Live withdrawals: ' +
            (ctx.services.provider.isSimulated
              ? '**simulated provider** — no real payouts are possible in this deployment'
              : ctx.services.config.withdrawalsLive
                ? '**enabled** (provider-confirmed only)'
                : '**disabled** pending integration review'),
        ].join('\n'),
      )
      .addFields({
        name: 'Per-asset provider requirements',
        value:
          currencies.length === 0
            ? 'Provider currency metadata is unavailable right now. No limits are guessed.'
            : ASSET_ORDER.map((asset) => {
                const info = currencies.find((currency) => currency.symbol === ASSETS[asset].providerSymbol);
                if (!info) return `${assetTicker(asset)}: not enabled by the provider`;
                return `${assetTicker(asset)} (${ASSETS[asset].networkLabel}): min payout **${info.minPayout}**, **${info.confirmations}** confirmations`;
              }).join('\n'),
      });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const currencyCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('currency').setDescription('Choose your personal fiat display currency')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const current = ctx.services.users.currency(ctx.userId);
    const menu = new StringSelectMenuBuilder()
      .setCustomId('currency:select')
      .setPlaceholder(`Current: ${current} — choose a display currency`)
      .addOptions(
        FIAT_CODES.map((code) => {
          const meta = FIAT_CURRENCIES[code];
          return {
            label: `${code} — ${meta.label}`,
            value: code,
            description: `${meta.symbol.trim()} · display only, never changes your crypto`,
            default: code === current,
          };
        }),
      );
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
      .setTitle('Display currency')
      .setDescription(
        'Pick the fiat currency used for estimates in your wallet, market views and fees. Your crypto balances, assets and transaction amounts never change.',
      );
    await replyPrivate(ctx.interaction, {
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
  },
};

const qrCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('qr')
      .setDescription('Generate a QR code for a deposit address')
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) =>
        option.setName('address').setDescription('Optional address to encode instead of your saved one').setMaxLength(128),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const asset = requireAsset(ctx.interaction);
    const override = ctx.interaction.options.getString('address');
    let value = override?.trim() ?? '';
    if (!value) {
      const saved = await ctx.services.addresses.ensure(ctx.userId, asset);
      value = saved.address;
    }
    const qr = await QRCode.toBuffer(value, { type: 'png', width: 320, margin: 1 });
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
      .setTitle(`QR · ${assetNetworkLabel(asset)}`)
      .setDescription(`\`${value}\``)
      .setImage('attachment://flux-qr.png');
    await replyPrivate(ctx.interaction, {
      embeds: [embed],
      files: [new AttachmentBuilder(qr, { name: 'flux-qr.png' })],
    });
  },
};

const convertCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('convert')
      .setDescription('Estimate one crypto amount in another asset (no swap is executed)')
      .addStringOption((option) => option.setName('amount').setDescription('Amount in the source asset').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) =>
        option
          .setName('to')
          .setDescription('Target asset')
          .setRequired(true)
          .addChoices(...ASSET_ORDER.map((asset) => ({ name: assetNetworkLabel(asset), value: asset }))),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const from = requireAsset(ctx.interaction);
    const toRaw = ctx.interaction.options.getString('to', true);
    if (!isAssetSymbol(toRaw)) throw new ValidationError('Unsupported target asset.');
    const amountBase = parseUnits(ctx.interaction.options.getString('amount', true), ASSETS[from].decimals);
    if (amountBase <= 0n) throw new ValidationError('Amount must be greater than zero.');
    const prices = await priceMap(ctx);
    const fromPrice = prices[from];
    const toPrice = prices[toRaw];
    if (!fromPrice || !toPrice) {
      throw new AppError('price_unavailable', 'A verified price is missing for one of those assets right now, so no estimate is possible.');
    }
    const whole = Number(formatUnits(amountBase, ASSETS[from].decimals));
    const outputBase = parseUnits(((whole * fromPrice) / toPrice).toFixed(ASSETS[toRaw].decimals), ASSETS[toRaw].decimals);
    const rate = await rateFor(ctx.services, ctx.userId);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
      .setTitle('Conversion estimate')
      .setDescription(
        `**${formatUtils(from, amountBase)}** ≈ **${formatUtils(toRaw, outputBase)}**\n\n` +
          `USD value: ${fiatFromUsd(whole * fromPrice, rate)}\n\n` +
          'This is an informational price estimate based on the provider\'s last verified prices. FluxTip does not execute swaps, and no balance changes.',
      )
      .setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const portfolioCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('portfolio').setDescription('Your holdings valued in your display currency')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const rate = await rateFor(ctx.services, ctx.userId);
    const snapshot = await walletSnapshot(ctx.services, ctx.userId);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand).setTitle('Portfolio');
    if (snapshot.lines.length === 0) {
      embed.setDescription('Your portfolio is empty. `/deposit` to add funds.');
    } else {
      embed.setDescription(
        snapshot.lines
          .map((line) => {
            const whole = `${formatUtils(line.asset, line.base)}`;
            const value = line.usd === null ? 'no verified price' : fiatFromUsd(line.usd, rate);
            const share = snapshot.totalUsd > 0 && line.usd !== null ? ` · ${((line.usd / snapshot.totalUsd) * 100).toFixed(1)}%` : '';
            return `**${whole}**\n${value}${share}`;
          })
          .join('\n\n'),
      );
      embed.addFields({
        name: 'Estimated total',
        value: fiatFromUsd(snapshot.totalUsd, rate) + (snapshot.partial ? ' (partial: a price is missing)' : ''),
      });
    }
    embed.setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const allocationCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('allocation').setDescription('How your portfolio is allocated')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const rate = await rateFor(ctx.services, ctx.userId);
    const snapshot = await walletSnapshot(ctx.services, ctx.userId);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand).setTitle('Allocation');
    if (snapshot.lines.length === 0 || snapshot.totalUsd <= 0) {
      embed.setDescription('Not enough priced holdings to calculate an allocation.');
    } else {
      const sorted = [...snapshot.lines].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
      embed.setDescription(
        sorted
          .map((line) => {
            const fraction = (line.usd ?? 0) / snapshot.totalUsd;
            return `${assetTicker(line.asset).padEnd(10)} ${allocationBar(fraction)} ${(fraction * 100).toFixed(1)}%\n${fiatFromUsd(line.usd ?? 0, rate)}`;
          })
          .join('\n\n'),
      );
      if (snapshot.partial) embed.addFields({ name: 'Note', value: 'Assets without a verified price are excluded from the percentages.' });
    }
    embed.setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const networthCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('networth').setDescription('Total estimated value of your FluxTip wallet')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ensureUser(ctx);
    const rate = await rateFor(ctx.services, ctx.userId);
    const snapshot = await walletSnapshot(ctx.services, ctx.userId);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.brand)
      .setTitle('Estimated net worth')
      .setDescription(
        `${fiatFromUsd(snapshot.totalUsd, rate)}\n\n${snapshot.lines.length} asset${snapshot.lines.length === 1 ? '' : 's'} with a balance${snapshot.partial ? ' (one or more assets lack a verified price)' : ''}.`,
      )
      .setFooter({ text: fxNote(rate) });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

export const walletCommands: Command[] = [
  walletCommand,
  balanceCommand,
  depositCommand,
  depositsCommand,
  addressCommand,
  addressesCommand,
  addyCommand,
  withdrawCommand,
  withdrawalsCommand,
  feesCommand,
  limitsCommand,
  currencyCommand,
  qrCommand,
  convertCommand,
  portfolioCommand,
  allocationCommand,
  networthCommand,
];
