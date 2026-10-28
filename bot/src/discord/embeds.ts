import { EmbedBuilder } from 'discord.js';
import { APP_FEE_USD, ASSETS, assetNetworkLabel, assetTicker, type AssetSymbol } from '../core/assets.ts';
import type { FiatCode } from '../core/fiat.ts';
import { formatFiatEstimate } from '../core/fiat.ts';
import { formatUnits } from '../core/money.ts';
import type { RateQuote } from '../services/fx.ts';

export const COLORS = {
  brand: 0x35f0b4,
  success: 0x3ddc97,
  warning: 0xf2c14e,
  danger: 0xff6b6b,
  neutral: 0x2b3a42,
  market: 0x6ee7ff,
} as const;

export interface EmbedContext {
  simulated: boolean;
}

export function baseEmbed(ctx: EmbedContext, color: number = COLORS.brand): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(color).setFooter({
    text: ctx.simulated
      ? 'FluxTip · SIMULATED provider — no real blockchain activity'
      : 'FluxTip · balances are custodial, backed by the OrbChain merchant balance',
  });
  return embed;
}

export function errorEmbed(ctx: EmbedContext, message: string): EmbedBuilder {
  return baseEmbed(ctx, COLORS.danger).setTitle('Something needs your attention').setDescription(message);
}

export function successEmbed(ctx: EmbedContext, title: string, description?: string): EmbedBuilder {
  const embed = baseEmbed(ctx, COLORS.success).setTitle(title);
  if (description) embed.setDescription(description);
  return embed;
}

/** "0.0125 BTC" with the asset's real decimals, never a float. */
export function cryptoAmount(asset: AssetSymbol, base: bigint): string {
  return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
}

export function cryptoWithNetwork(asset: AssetSymbol): string {
  return assetNetworkLabel(asset);
}

/** Converts a USD estimate into the user's chosen fiat currency and formats it. */
export function fiatFromUsd(usd: number, quote: RateQuote): string {
  return formatFiatEstimate(usd * quote.rate, quote.displayCode as FiatCode);
}

export function fiatWithCode(usd: number, quote: RateQuote): string {
  const value = formatFiatEstimate(usd * quote.rate, quote.displayCode as FiatCode);
  return quote.fellBackToUsd ? `${value} USD` : value;
}

export function fxNote(quote: RateQuote): string {
  if (quote.fellBackToUsd) return 'FX rates unavailable, showing USD.';
  if (!quote.asOf) return 'Display currency: USD.';
  return `Display rate ${quote.displayCode} ${quote.rate.toFixed(4)} · ${new Date(quote.asOf).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${quote.source}`;
}

export function feeLine(asset: AssetSymbol, feeBase: bigint, quote?: RateQuote): string {
  const fee = `${formatUnits(feeBase, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
  return quote ? `$${APP_FEE_USD.toFixed(2)} fee (≈ ${fee})` : `$${APP_FEE_USD.toFixed(2)} fee (${fee})`;
}

export function timestamp(unixMs: number): string {
  return `<t:${Math.floor(unixMs / 1000)}:R>`;
}

export function shortRef(ref: string): string {
  return ref.length > 24 ? `${ref.slice(0, 10)}…${ref.slice(-6)}` : ref;
}

export function statusBadge(status: string): string {
  const map: Record<string, string> = {
    confirmed: '✅ confirmed',
    completed: '✅ completed',
    confirming: '⏳ confirming',
    pending: '🕒 pending',
    failed: '❌ failed',
    rejected: '🚫 rejected',
    cancelled: '⚪ cancelled',
    open: '🟡 open',
    paid: '✅ paid',
    expired: '⚪ expired',
    triggered: '🔔 triggered',
  };
  return map[status.toLowerCase()] ?? status;
}
