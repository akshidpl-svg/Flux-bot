import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { ASSETS, ASSET_ORDER, assetNetworkLabel, assetTicker, isAssetSymbol, type AssetSymbol } from '../../core/assets.ts';
import { AppError, ValidationError } from '../../core/errors.ts';
import { FIAT_CODES, formatFiat, isFiatCode, type FiatCode } from '../../core/fiat.ts';
import { formatUnits, parseUnits } from '../../core/money.ts';
import { addAssetOption, installable } from '../builders.ts';
import type { CommandContext } from '../context.ts';
import { deferPrivate, replyPrivate } from '../context.ts';
import { COLORS, baseEmbed, fiatFromUsd, fxNote, timestamp } from '../embeds.ts';
import type { Command } from '../types.ts';
import { rateFor } from '../views.ts';

function requireAsset(interaction: ChatInputCommandInteraction): AssetSymbol {
  const raw = interaction.options.getString('asset', true);
  if (!isAssetSymbol(raw)) throw new ValidationError('Unsupported asset.');
  return raw;
}

function simulated(ctx: CommandContext): boolean {
  return ctx.services.provider.isSimulated;
}

function usd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value === 0) return '$0.00';
  return `$${value.toPrecision(4)}`;
}

function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return usd(value);
}

function sparkline(points: { priceUsd: number }[], width = 40): string {
  if (points.length === 0) return '';
  const sampled: number[] = [];
  const step = Math.max(1, Math.floor(points.length / width));
  for (let index = 0; index < points.length; index += step) {
    const point = points[index];
    if (point) sampled.push(point.priceUsd);
  }
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (max === min) return blocks[3]?.repeat(sampled.length) ?? '';
  return sampled
    .map((value) => blocks[Math.min(blocks.length - 1, Math.floor(((value - min) / (max - min)) * (blocks.length - 1)))] ?? '▄')
    .join('');
}

const priceCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('price')
      .setDescription('Current USD price and 24h change for one asset')
      .addStringOption((option) => addAssetOption(option, true)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const asset = requireAsset(ctx.interaction);
    const quote = await ctx.services.prices.quote(asset);
    const rate = await rateFor(ctx.services, ctx.userId);
    const markets = await ctx.services.market.markets().catch(() => null);
    const row = markets?.rows.find((entry) => entry.asset === asset);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
      .setTitle(`${assetNetworkLabel(asset)} price`)
      .setDescription(`**${formatUsdPrice(quote.priceUsd)}** per ${assetTicker(asset)}`)
      .addFields(
        {
          name: 'USD value',
          value: quote.source === 'simulated' ? 'simulated price (not market data)' : `${usd(quote.priceUsd)}`,
          inline: true,
        },
        {
          name: '24h change',
          value: row?.change24h === null || row?.change24h === undefined ? 'unavailable' : `${row.change24h > 0 ? '+' : ''}${row.change24h.toFixed(2)}%`,
          inline: true,
        },
        { name: 'Source', value: row ? `${quote.source} + coingecko` : quote.source, inline: true },
        ...(rate.displayCode === 'USD'
          ? []
          : [{ name: `In ${rate.displayCode}`, value: fiatFromUsd(quote.priceUsd, rate), inline: true }]),
      )
      .setFooter({ text: `Price observed ${timestamp(quote.timestamp)} · ${fxNote(rate)}` });
    if (row?.marketCapUsd) embed.addFields({ name: 'Market cap', value: compactUsd(row.marketCapUsd), inline: true });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

function formatUsdPrice(value: number): string {
  return value >= 1 ? usd(value) : `$${value.toPrecision(6)}`;
}

const pricesCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('prices').setDescription('Prices for every supported asset')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const snapshot = await ctx.services.prices.snapshot();
    const rate = await rateFor(ctx.services, ctx.userId);
    const markets = await ctx.services.market.markets().catch(() => null);
    const showFiat = rate.displayCode !== 'USD';
    const lines = ASSET_ORDER.map((asset) => {
      const price = snapshot.prices[asset];
      if (!price) return `${assetTicker(asset).padEnd(6)} price unavailable`;
      const change = markets?.rows.find((row) => row.asset === asset)?.change24h;
      const converted = showFiat ? ` · ${fiatFromUsd(price, rate)}` : '';
      return `${assetTicker(asset).padEnd(6)} ${formatUsdPrice(price).padStart(12)}${converted}${change === null || change === undefined ? '' : ` · ${change > 0 ? '+' : ''}${change.toFixed(2)}% 24h`}`;
    });
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
          .setTitle('Market prices')
          .setDescription(`\`\`\`\n${lines.join('\n')}\n\`\`\``)
          .setFooter({
            text: `Source: ${snapshot.source} · observed ${new Date(snapshot.timestamp).toISOString().slice(11, 16)} UTC · ${fxNote(rate)}`,
          }),
      ],
    });
  },
};

const chartCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('chart')
      .setDescription('Simple price chart from historical market data')
      .addStringOption((option) => addAssetOption(option, true))
      .addIntegerOption((option) =>
        option.setName('days').setDescription('Period in days (1-90, default 7)').setMinValue(1).setMaxValue(90),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const asset = requireAsset(ctx.interaction);
    const days = ctx.interaction.options.getInteger('days') ?? 7;
    const chart = await ctx.services.market.chart(asset, days);
    const first = chart.points[0]?.priceUsd ?? 0;
    const last = chart.points[chart.points.length - 1]?.priceUsd ?? 0;
    const min = Math.min(...chart.points.map((point) => point.priceUsd));
    const max = Math.max(...chart.points.map((point) => point.priceUsd));
    const change = first > 0 ? ((last - first) / first) * 100 : 0;
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
          .setTitle(`${assetTicker(asset)} · ${days}d chart`)
          .setDescription(`\`\`\`\n${sparkline(chart.points)}\n\`\`\``)
          .addFields(
            { name: 'Last', value: formatUsdPrice(last), inline: true },
            { name: 'Change', value: `${change > 0 ? '+' : ''}${change.toFixed(2)}%`, inline: true },
            { name: 'Range', value: `${formatUsdPrice(min)} – ${formatUsdPrice(max)}`, inline: true },
          )
          .setFooter({ text: `Source: coingecko · fetched ${timestamp(chart.timestamp)} · historical estimate, not an execution price` }),
      ],
    });
  },
};

const calculatorCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('calculator')
      .setDescription('Value a crypto amount in your display currency')
      .addStringOption((option) => option.setName('amount').setDescription('Amount in coin units').setRequired(true).setMaxLength(32))
      .addStringOption((option) => addAssetOption(option, true)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const asset = requireAsset(ctx.interaction);
    const amountBase = parseUnits(ctx.interaction.options.getString('amount', true), ASSETS[asset].decimals);
    const quote = await ctx.services.prices.quote(asset);
    const rate = await rateFor(ctx.services, ctx.userId);
    const whole = Number(formatUnits(amountBase, ASSETS[asset].decimals));
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
          .setTitle('Value estimate')
          .setDescription(
            `**${formatUnits(amountBase, ASSETS[asset].decimals)} ${assetTicker(asset)}**\n` +
              `${fiatFromUsd(whole * quote.priceUsd, rate)} · at ${formatUsdPrice(quote.priceUsd)} per ${assetTicker(asset)}`,
          )
          .setFooter({ text: `Rate observed ${timestamp(quote.timestamp)} · ${fxNote(rate)} · estimates only` }),
      ],
    });
  },
};

const converterCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('converter')
      .setDescription('Convert between any supported crypto or fiat currency (estimate)')
      .addStringOption((option) => option.setName('amount').setDescription('Amount to convert').setRequired(true).setMaxLength(32))
      .addStringOption((option) =>
        option
          .setName('from')
          .setDescription('Source: BTC, LTC, ETH, SOL, USDT or a fiat code like USD')
          .setRequired(true)
          .setMaxLength(12),
      )
      .addStringOption((option) =>
        option.setName('to').setDescription('Target: BTC, LTC, ETH, SOL, USDT or a fiat code').setRequired(true).setMaxLength(12),
      ),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const rawFrom = ctx.interaction.options.getString('from', true).toUpperCase();
    const rawTo = ctx.interaction.options.getString('to', true).toUpperCase();
    const from = normalizeCurrency(rawFrom);
    const to = normalizeCurrency(rawTo);
    if (!from || !to) throw new ValidationError('Use BTC, LTC, ETH, SOL, USDT or one of: ' + FIAT_CODES.join(', '));
    const snapshot = await ctx.services.prices.snapshot();
    const amountRaw = ctx.interaction.options.getString('amount', true);
    const amountValue = Number(amountRaw.replace(/,/g, '').trim());
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      throw new ValidationError('Enter a positive number, for example `250` or `0.015`.');
    }

    let usdValue: number;
    if (from.kind === 'fiat') {
      const fromRate = await ctx.services.fx.rateFor(from.code as FiatCode);
      if (!fromRate) throw new ValidationError(`No FX rate is available for ${from.code} right now, so this conversion cannot be estimated.`);
      usdValue = amountValue / fromRate;
    } else {
      const price = snapshot.prices[from.asset];
      if (!price) throw new AppError('price_unavailable', `No verified price for ${assetTicker(from.asset)} right now.`);
      usdValue = amountValue * price;
    }

    let output: string;
    if (to.kind === 'fiat') {
      const toRate = await ctx.services.fx.rateFor(to.code as FiatCode);
      if (!toRate) throw new ValidationError(`No FX rate is available for ${to.code} right now, so this conversion cannot be estimated.`);
      output = formatFiat(usdValue * toRate, to.code as FiatCode);
    } else {
      const price = snapshot.prices[to.asset];
      if (!price) throw new AppError('price_unavailable', `No verified price for ${assetTicker(to.asset)} right now.`);
      const fixed = (usdValue / price).toFixed(Math.min(ASSETS[to.asset].decimals, 8));
      output = `${fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed} ${assetTicker(to.asset)}`;
    }

    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
          .setTitle('Conversion estimate')
          .setDescription(`**${amountRaw} ${displayCurrency(from)}** ≈ **${output}**`)
          .setFooter({
            text: `Prices ${snapshot.source} observed ${timestamp(snapshot.timestamp)} · informational only, no swap is executed`,
          }),
      ],
    });
  },
};

type CurrencyInput = { kind: 'asset'; asset: AssetSymbol } | { kind: 'fiat'; code: string };

function normalizeCurrency(value: string): CurrencyInput | null {
  if (isAssetSymbol(value)) return { kind: 'asset', asset: value };
  if (value === 'USDT') return { kind: 'asset', asset: 'USDT_TRC20' };
  if (isFiatCode(value)) return { kind: 'fiat', code: value };
  return null;
}

function displayCurrency(input: CurrencyInput): string {
  return input.kind === 'asset' ? assetTicker(input.asset) : input.code;
}

const gasCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('gas').setDescription('Live Ethereum gas price')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const gas = await ctx.services.market.ethereumGas();
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
          .setTitle('Ethereum gas')
          .setDescription(`**${gas.gasPriceGwei.toFixed(2)} gwei**\nBlock #${gas.blockNumber.toLocaleString('en-US')}`)
          .setFooter({ text: `${gas.source} · ${timestamp(gas.timestamp)} · network fee only; FluxTip's $0.05 fee is separate` }),
      ],
    });
  },
};

const networkCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('network')
      .setDescription('Network and confirmation details for an asset')
      .addStringOption((option) => addAssetOption(option, true)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const asset = requireAsset(ctx.interaction);
    const currencies = await ctx.services.provider.getCurrencies().catch(() => []);
    const info = currencies.find((currency) => currency.symbol === ASSETS[asset].providerSymbol);
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
      .setTitle(`${assetNetworkLabel(asset)} network`)
      .addFields(
        { name: 'Provider symbol', value: ASSETS[asset].providerSymbol, inline: true },
        { name: 'Decimals', value: String(ASSETS[asset].decimals), inline: true },
        { name: 'Explorer', value: ASSETS[asset].explorerAddress, inline: false },
      );
    if (info) {
      embed.addFields(
        { name: 'Required confirmations', value: String(info.confirmations), inline: true },
        { name: 'Provider minimum payout', value: `${info.minPayout} ${assetTicker(asset)}`, inline: true },
      );
    } else {
      embed.addFields({ name: 'Provider metadata', value: 'Unavailable right now — nothing is assumed.', inline: false });
    }
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

const explorerCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('explorer')
      .setDescription('Link a transaction or address on a block explorer')
      .addStringOption((option) => addAssetOption(option, true))
      .addStringOption((option) => option.setName('value').setDescription('Transaction hash or address').setMaxLength(128)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const asset = requireAsset(ctx.interaction);
    const value = ctx.interaction.options.getString('value')?.trim();
    const saved = value ? null : ctx.services.addresses.find(ctx.userId, asset)?.address;
    if (!value && !saved) {
      throw new ValidationError('Provide a transaction hash or address, or run `/deposit` first to create an address.');
    }
    const base = value
      ? ASSETS[asset].explorerTx + encodeURIComponent(value)
      : `${ASSETS[asset].explorerAddress}${encodeURIComponent(saved as string)}`;
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
          .setTitle(`Explorer · ${assetTicker(asset)}`)
          .setDescription(value ? `[Open transaction](${base})` : `[Open your deposit address](${base})`)
          .setFooter({ text: 'Links open the public block explorer. FluxTip does not verify explorer pages.' }),
      ],
    });
  },
};

const confirmationsCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('confirmations')
      .setDescription('Confirmation progress for your deposits')
      .addStringOption((option) => option.setName('tx_hash').setDescription('Specific transaction hash').setMaxLength(128)),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const hash = ctx.interaction.options.getString('tx_hash')?.trim();
    if (hash) {
      const deposit = ctx.services.deposits.getForUser(ctx.userId, hash);
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
            .setTitle(`Confirmations · ${deposit.asset}`)
            .setDescription(
              `${deposit.confirmations}${deposit.required_confirmations ? ` / ${deposit.required_confirmations}` : ''} confirmations\nStatus: **${deposit.status}**`,
            )
            .setFooter({ text: `Provider-reported data only. Reference d_${deposit.id}` }),
        ],
      });
      return;
    }
    const rows = ctx.services.deposits.history(ctx.userId, { limit: 10 });
    await replyPrivate(ctx.interaction, {
      embeds: [
        baseEmbed({ simulated: simulated(ctx) }, COLORS.neutral)
          .setTitle('Recent deposit confirmations')
          .setDescription(
            rows.length === 0
              ? 'No deposits found.'
              : rows
                  .map((row) => {
                    const asset = row.asset as AssetSymbol;
                    return `\`${row.tx_hash.slice(0, 12)}…\` · ${formatUnits(BigInt(row.amount), ASSETS[asset].decimals)} ${assetTicker(asset)} · ${row.status} · ${row.confirmations}${row.required_confirmations ? `/${row.required_confirmations}` : ''} confirmations`;
                  })
                  .join('\n'),
          ),
      ],
    });
  },
};

const marketCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('market').setDescription('Market overview for supported assets')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    const [markets, global] = await Promise.all([
      ctx.services.market.markets(),
      ctx.services.market.global().catch(() => null),
    ]);
    const rate = await rateFor(ctx.services, ctx.userId);
    const lines = markets.rows
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
      .map((row) => {
        const change = row.change24h === null ? '—' : `${row.change24h > 0 ? '+' : ''}${row.change24h.toFixed(1)}%`;
        return `${assetTicker(row.asset).padEnd(6)} ${formatUsdPrice(row.priceUsd).padStart(12)} ${change.padStart(8)} ${compactUsd(row.marketCapUsd ?? 0).padStart(10)}`;
      });
    const embed = baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
      .setTitle('Market overview')
      .setDescription(`\`\`\`\n${lines.join('\n')}\n\`\`\``);
    if (global) {
      embed.addFields(
        { name: 'Total market cap', value: compactUsd(global.marketCapUsd), inline: true },
        { name: '24h volume', value: compactUsd(global.volume24hUsd), inline: true },
        { name: 'BTC dominance', value: `${global.btcDominance.toFixed(1)}%`, inline: true },
      );
    }
    embed.setFooter({
      text: `Source: coingecko · fetched ${timestamp(markets.timestamp)} · ${fxNote(rate)} · estimates, not execution prices`,
    });
    await replyPrivate(ctx.interaction, { embeds: [embed] });
  },
};

function moversCommand(direction: 'gainers' | 'losers'): Command {
  return {
    data: installable(
      new SlashCommandBuilder()
        .setName(direction)
        .setDescription(`Top ${direction} among FluxTip's supported assets over 24h`),
    ),
    async execute(ctx) {
      await deferPrivate(ctx.interaction);
      const markets = await ctx.services.market.markets();
      const filtered = markets.rows
        .filter((row) => row.change24h !== null)
        .sort((a, b) => (direction === 'gainers' ? (b.change24h ?? 0) - (a.change24h ?? 0) : (a.change24h ?? 0) - (b.change24h ?? 0)));
      await replyPrivate(ctx.interaction, {
        embeds: [
          baseEmbed({ simulated: simulated(ctx) }, COLORS.market)
            .setTitle(`${direction === 'gainers' ? 'Gainers' : 'Losers'} · 24h`)
            .setDescription(
              filtered.length === 0
                ? 'No 24h change data is available right now.'
                : filtered
                    .map(
                      (row, index) =>
                        `**${index + 1}. ${assetTicker(row.asset)}** ${formatUsdPrice(row.priceUsd)} · ${row.change24h! > 0 ? '+' : ''}${row.change24h!.toFixed(2)}%`,
                    )
                    .join('\n'),
            )
            .setFooter({ text: `Source: coingecko · fetched ${timestamp(markets.timestamp)}` }),
        ],
      });
    },
  };
}

function alertsEmbed(
  rows: { id: number; asset: string; direction: string; target_usd: number; status: string; last_price: number | null }[],
  simulated: boolean,
) {
  return baseEmbed({ simulated }, COLORS.neutral)
    .setTitle('Your price alerts')
    .setDescription(
      rows.length === 0
        ? 'No alerts. Create one with `/alert add`.'
        : rows
            .map(
              (alert) =>
                `#${alert.id} · **${assetTicker(alert.asset as AssetSymbol)}** ${alert.direction} $${alert.target_usd} · ${alert.status}${alert.last_price ? ` · last $${alert.last_price}` : ''}`,
            )
            .join('\n'),
    );
}

const alertCommand: Command = {
  data: installable(
    new SlashCommandBuilder()
      .setName('alert')
      .setDescription('Manage price alerts sent to you by DM')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Create a price alert')
          .addStringOption((option) => addAssetOption(option, true))
          .addStringOption((option) =>
            option
              .setName('direction')
              .setDescription('Trigger when price goes above or below')
              .setRequired(true)
              .addChoices({ name: 'Above', value: 'above' }, { name: 'Below', value: 'below' }),
          )
          .addNumberOption((option) =>
            option.setName('target_usd').setDescription('Target price in USD').setRequired(true).setMinValue(0.000001),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove one of your alerts')
          .addIntegerOption((option) => option.setName('id').setDescription('Alert ID from /alert list').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('List your alerts')),
  ),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ctx.services.users.ensure(ctx.userId);
    const sub = ctx.subcommand ?? 'list';
    if (sub === 'add') {
      const asset = requireAsset(ctx.interaction);
      const direction = ctx.interaction.options.getString('direction', true) as 'above' | 'below';
      const target = ctx.interaction.options.getNumber('target_usd', true);
      const alert = ctx.services.alerts.add(ctx.userId, asset, direction, target);
      await replyPrivate(ctx.interaction, {
        content: `Alert #${alert.id} created: ${assetTicker(asset)} ${direction} $${target}. I will DM you when it triggers.`,
      });
      return;
    }
    if (sub === 'remove') {
      const id = ctx.interaction.options.getInteger('id', true);
      ctx.services.alerts.remove(ctx.userId, id);
      await replyPrivate(ctx.interaction, { content: `Alert #${id} removed.` });
      return;
    }
    const alerts = ctx.services.alerts.list(ctx.userId);
    await replyPrivate(ctx.interaction, { embeds: [alertsEmbed(alerts, simulated(ctx))] });
  },
};

const alertsCommand: Command = {
  data: installable(new SlashCommandBuilder().setName('alerts').setDescription('List your price alerts')),
  async execute(ctx) {
    await deferPrivate(ctx.interaction);
    ctx.services.users.ensure(ctx.userId);
    await replyPrivate(ctx.interaction, {
      embeds: [alertsEmbed(ctx.services.alerts.list(ctx.userId), simulated(ctx))],
    });
  },
};

export const marketCommands: Command[] = [
  priceCommand,
  pricesCommand,
  chartCommand,
  calculatorCommand,
  converterCommand,
  gasCommand,
  networkCommand,
  explorerCommand,
  confirmationsCommand,
  marketCommand,
  moversCommand('gainers'),
  moversCommand('losers'),
  alertCommand,
  alertsCommand,
];
