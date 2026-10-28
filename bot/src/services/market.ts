import { ASSETS, type AssetSymbol } from '../core/assets.ts';
import { AppError } from '../core/errors.ts';
import { logger } from '../logger.ts';

const COINGECKO_IDS: Record<AssetSymbol, string> = {
  BTC: 'bitcoin',
  LTC: 'litecoin',
  ETH: 'ethereum',
  SOL: 'solana',
  USDT_TRC20: 'tether',
};

const SYMBOL_BY_ID = new Map(Object.entries(COINGECKO_IDS).map(([asset, id]) => [id, asset as AssetSymbol]));

export interface MarketRow {
  asset: AssetSymbol;
  priceUsd: number;
  change24h: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
}

export interface ChartPoint {
  timestamp: number;
  priceUsd: number;
}

/**
 * Market data for charts, movers and gas. Uses CoinGecko's public API and a
 * public Ethereum JSON-RPC endpoint, both unauthenticated. Every response is
 * timestamped and labelled; nothing is synthesized when a provider is down.
 */
export class MarketService {
  private cache = new Map<string, { at: number; value: unknown }>();

  private readonly options: {
    fetchImpl?: typeof fetch;
    coingeckoBaseUrl?: string;
    ethereumRpcUrl?: string;
    now?: () => number;
  };

  constructor(options: {
    fetchImpl?: typeof fetch;
    coingeckoBaseUrl?: string;
    ethereumRpcUrl?: string;
    now?: () => number;
  } = {}) {
    this.options = options;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now - hit.at < ttlMs) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: this.now, value });
    return value;
  }

  private async coingecko<T>(path: string): Promise<T> {
    const base = this.options.coingeckoBaseUrl ?? 'https://api.coingecko.com/api/v3';
    try {
      const response = await this.fetchImpl(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      logger.warn('Market data request failed', { path, error });
      throw new AppError(
        'market_unavailable',
        'Live market data is unavailable right now. FluxTip will not show made-up prices.',
        { retryable: true },
      );
    }
  }

  async markets(): Promise<{ rows: MarketRow[]; timestamp: number; source: string }> {
    const ids = Object.values(COINGECKO_IDS).join(',');
    const timestamp = this.now;
    const rows = await this.cached('markets', 60_000, () =>
      this.coingecko<
        {
          id: string;
          current_price: number | null;
          price_change_percentage_24h: number | null;
          market_cap: number | null;
          total_volume: number | null;
        }[]
      >(`/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=20&page=1&sparkline=false`),
    );
    const mapped: MarketRow[] = [];
    for (const row of rows) {
      const asset = SYMBOL_BY_ID.get(row.id);
      if (!asset || typeof row.current_price !== 'number') continue;
      mapped.push({
        asset,
        priceUsd: row.current_price,
        change24h: row.price_change_percentage_24h ?? null,
        marketCapUsd: row.market_cap ?? null,
        volume24hUsd: row.total_volume ?? null,
      });
    }
    return { rows: mapped, timestamp, source: 'coingecko' };
  }

  async chart(asset: AssetSymbol, days: number): Promise<{ points: ChartPoint[]; source: string; timestamp: number }> {
    const clamped = Math.min(Math.max(days, 1), 90);
    const id = COINGECKO_IDS[asset];
    const data = await this.cached(`chart:${asset}:${clamped}`, 300_000, () =>
      this.coingecko<{ prices?: [number, number][] }>(
        `/coins/${id}/market_chart?vs_currency=usd&days=${clamped}&interval=${clamped > 2 ? 'daily' : 'hourly'}`,
      ),
    );
    const points = (data.prices ?? [])
      .filter((pair) => Array.isArray(pair) && typeof pair[0] === 'number' && typeof pair[1] === 'number')
      .map((pair) => ({ timestamp: pair[0], priceUsd: pair[1] }));
    if (points.length < 2) {
      throw new AppError('market_unavailable', 'Not enough historical data was returned to draw a chart.');
    }
    return { points, source: 'coingecko', timestamp: this.now };
  }

  async global(): Promise<{ marketCapUsd: number; volume24hUsd: number; btcDominance: number; source: string }> {
    const data = await this.cached('global', 120_000, () =>
      this.coingecko<{
        data?: {
          total_market_cap?: Record<string, number>;
          total_volume?: Record<string, number>;
          market_cap_percentage?: Record<string, number>;
        };
      }>('/global'),
    );
    const body = data.data;
    if (!body?.total_market_cap?.usd) {
      throw new AppError('market_unavailable', 'Global market data is unavailable right now.');
    }
    return {
      marketCapUsd: body.total_market_cap.usd,
      volume24hUsd: body.total_volume?.usd ?? 0,
      btcDominance: body.market_cap_percentage?.btc ?? 0,
      source: 'coingecko',
    };
  }

  async ethereumGas(): Promise<{ gasPriceGwei: number; blockNumber: number; source: string; timestamp: number }> {
    const url = this.options.ethereumRpcUrl ?? 'https://ethereum-rpc.publicnode.com';
    try {
      const [gas, block] = await Promise.all([
        this.rpc<string>(url, 'eth_gasPrice'),
        this.rpc<string>(url, 'eth_blockNumber'),
      ]);
      const gasPriceWei = Number.parseInt(gas, 16);
      if (!Number.isFinite(gasPriceWei)) throw new Error('invalid gas price');
      return {
        gasPriceGwei: gasPriceWei / 1e9,
        blockNumber: Number.parseInt(block, 16),
        source: 'ethereum public RPC',
        timestamp: this.now,
      };
    } catch (error) {
      logger.warn('Gas lookup failed', { error });
      throw new AppError('market_unavailable', 'Live Ethereum gas data is unavailable right now.', { retryable: true });
    }
  }

  private async rpc<T>(url: string, method: string): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.result === undefined) throw new Error(payload.error?.message ?? 'RPC error');
    return payload.result;
  }

  isSupported(asset: string): asset is AssetSymbol {
    return Object.hasOwn(ASSETS, asset);
  }
}
