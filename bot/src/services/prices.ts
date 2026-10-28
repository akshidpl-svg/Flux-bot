import type { AssetSymbol } from '../core/assets.ts';
import { ASSETS, ASSET_SYMBOLS } from '../core/assets.ts';
import { AppError } from '../core/errors.ts';
import { quoteFee, type FeeQuote } from '../core/fees.ts';
import type { Provider } from '../providers/types.ts';

export interface PriceSnapshot {
  prices: Partial<Record<AssetSymbol, number>>;
  timestamp: number;
  source: string;
}

export interface PriceQuote {
  asset: AssetSymbol;
  priceUsd: number;
  timestamp: number;
  source: string;
}

/**
 * USD price service backed by the payment provider's documented price endpoint,
 * cached briefly so a burst of commands does not hammer it. If a price is not
 * available we raise an error instead of inventing a number.
 */
export class PriceService {
  private cache: PriceSnapshot | null = null;
  private inflight: Promise<PriceSnapshot> | null = null;

  private readonly provider: Provider;
  private readonly options: { ttlMs?: number; now?: () => number };

  constructor(provider: Provider, options: { ttlMs?: number; now?: () => number } = {}) {
    this.provider = provider;
    this.options = options;
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  async snapshot(force = false): Promise<PriceSnapshot> {
    const ttl = this.options.ttlMs ?? 60_000;
    if (!force && this.cache && this.now - this.cache.timestamp < ttl) return this.cache;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const raw = await this.provider.getPrices();
        const prices: Partial<Record<AssetSymbol, number>> = {};
        for (const symbol of ASSET_SYMBOLS) {
          const value = raw.prices[ASSETS[symbol].providerSymbol];
          if (typeof value === 'number' && Number.isFinite(value) && value > 0) prices[symbol] = value;
        }
        const snapshot: PriceSnapshot = {
          prices,
          timestamp: raw.timestamp || this.now,
          source: raw.source,
        };
        this.cache = snapshot;
        return snapshot;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async quote(asset: AssetSymbol): Promise<PriceQuote> {
    const snapshot = await this.snapshot();
    const priceUsd = snapshot.prices[asset];
    if (!priceUsd) {
      throw new AppError(
        'price_unavailable',
        `No verified USD price is available for ${asset} right now. FluxTip will not estimate fees or value from an invented price.`,
        { retryable: true },
      );
    }
    return { asset, priceUsd, timestamp: snapshot.timestamp, source: snapshot.source };
  }

  async quoteFee(asset: AssetSymbol): Promise<FeeQuote> {
    const price = await this.quote(asset);
    return quoteFee({
      decimals: ASSETS[asset].decimals,
      priceUsd: price.priceUsd,
      priceTimestamp: price.timestamp,
      priceSource: price.source,
    });
  }

  /** USD value of a whole-coin amount, for display estimates only. */
  async usdValue(asset: AssetSymbol, wholeCoins: number): Promise<{ usd: number; timestamp: number; source: string } | null> {
    try {
      const snapshot = await this.snapshot();
      const price = snapshot.prices[asset];
      if (!price) return null;
      return { usd: price * wholeCoins, timestamp: snapshot.timestamp, source: snapshot.source };
    } catch {
      return null;
    }
  }
}
