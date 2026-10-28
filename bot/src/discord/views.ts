import { ASSETS, ASSET_ORDER, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { formatUnits } from '../core/money.ts';
import type { Services } from '../services/index.ts';
import type { RateQuote } from '../services/fx.ts';

export async function rateFor(services: Services, userId: string): Promise<RateQuote> {
  const code = services.users.currency(userId);
  return services.fx.quote(code);
}

export interface WalletLine {
  asset: AssetSymbol;
  base: bigint;
  usd: number | null;
}

export interface WalletSnapshot {
  lines: WalletLine[];
  totalUsd: number;
  partial: boolean;
  priceTimestamp: number | null;
  priceSource: string | null;
}

/** Balances plus USD estimates from the verified price snapshot (no invented values). */
export async function walletSnapshot(services: Services, userId: string): Promise<WalletSnapshot> {
  const balances = services.ledger.balances(userId);
  let prices: Partial<Record<AssetSymbol, number>> = {};
  let priceTimestamp: number | null = null;
  let priceSource: string | null = null;
  try {
    const snapshot = await services.prices.snapshot();
    prices = snapshot.prices;
    priceTimestamp = snapshot.timestamp;
    priceSource = snapshot.source;
  } catch {
    prices = {};
  }

  const lines: WalletLine[] = [];
  let totalUsd = 0;
  let partial = false;
  for (const asset of ASSET_ORDER) {
    const base = balances.get(asset) ?? 0n;
    if (base === 0n) continue;
    const price = prices[asset];
    const whole = Number(formatUnits(base, ASSETS[asset].decimals));
    if (typeof price === 'number' && price > 0) {
      const usd = whole * price;
      totalUsd += usd;
      lines.push({ asset, base, usd });
    } else {
      partial = true;
      lines.push({ asset, base, usd: null });
    }
  }
  return { lines, totalUsd, partial, priceTimestamp, priceSource };
}

export function allocationBar(fraction: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function assetSummaryLines(snapshot: WalletSnapshot): string[] {
  return snapshot.lines.map((line) => {
    const amount = `${formatUnits(line.base, ASSETS[line.asset].decimals)} ${assetTicker(line.asset)}`;
    const value = line.usd === null ? 'price unavailable' : `≈ $${line.usd.toFixed(2)}`;
    return `• **${amount}** · ${value}`;
  });
}
