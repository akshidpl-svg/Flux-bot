import { getFiat, type FiatCode } from '../core/fiat.ts';
import { logger } from '../logger.ts';

export interface RateQuote {
  /** Currency actually used for formatting. */
  displayCode: FiatCode;
  rate: number;
  asOf: number | null;
  source: string;
  /** True when the requested currency could not be fetched and USD is shown. */
  fellBackToUsd: boolean;
}

interface CachedRates {
  rates: Record<string, number>;
  asOf: number;
  fetchedAt: number;
}

/**
 * Fiat conversion rates from open.er-api.com (free, no key). Display-only:
 * crypto amounts never change when a user switches display currency.
 */
export class FxService {
  private cache: CachedRates | null = null;
  private inflight: Promise<CachedRates> | null = null;

  private readonly options: {
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    url?: string;
    now?: () => number;
  };

  constructor(options: {
    fetchImpl?: typeof fetch;
    ttlMs?: number;
    url?: string;
    now?: () => number;
  } = {}) {
    this.options = options;
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async load(): Promise<CachedRates> {
    const ttl = this.options.ttlMs ?? 30 * 60_000;
    if (this.cache && this.now - this.cache.fetchedAt < ttl) return this.cache;
    if (this.inflight) return this.inflight;

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = this.options.url ?? 'https://open.er-api.com/v6/latest/USD';
    this.inflight = (async () => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`FX HTTP ${response.status}`);
        const payload = (await response.json()) as {
          result?: string;
          rates?: Record<string, number>;
          time_last_update_unix?: number;
        };
        if (payload.result !== 'success' || !payload.rates) throw new Error('FX payload invalid');
        const rates = payload.rates;
        if (typeof rates.USD !== 'number') rates.USD = 1;
        const cached: CachedRates = {
          rates,
          asOf: (payload.time_last_update_unix ?? Math.floor(this.now / 1000)) * 1000,
          fetchedAt: this.now,
        };
        this.cache = cached;
        return cached;
      } catch (error) {
        logger.warn('FX rates unavailable', { error });
        if (this.cache) return this.cache;
        throw error;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async quote(code: FiatCode): Promise<RateQuote> {
    if (code === 'USD') {
      return { displayCode: 'USD', rate: 1, asOf: null, source: 'fixed', fellBackToUsd: false };
    }
    try {
      const cached = await this.load();
      const rate = cached.rates[code];
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        return { displayCode: code, rate, asOf: cached.asOf, source: 'open.er-api.com', fellBackToUsd: false };
      }
    } catch {
      // fall through to USD
    }
    return { displayCode: 'USD', rate: 1, asOf: null, source: 'unavailable', fellBackToUsd: true };
  }

  /**
   * Conversion rate for any supported currency, independent of the caller's
   * display preference. Returns null when no verified rate is available.
   */
  async rateFor(code: FiatCode): Promise<number | null> {
    if (code === 'USD') return 1;
    try {
      const cached = await this.load();
      const rate = cached.rates[code];
      return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
    } catch {
      return null;
    }
  }

  getFiatMeta(code: FiatCode) {
    return getFiat(code);
  }
}
