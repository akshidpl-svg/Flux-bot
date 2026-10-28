import type { AssetSymbol } from '../core/assets.ts';
import { getAsset } from '../core/assets.ts';
import { ProviderError } from '../core/errors.ts';
import { logger } from '../logger.ts';
import type {
  Provider,
  ProviderCurrencyInfo,
  ProviderDeposit,
  ProviderPayoutStatus,
  ProviderPriceSnapshot,
} from './types.ts';

interface OrbChainEnvelope<T> {
  data?: T;
  message?: string;
  error?: { type?: string; message?: string } | string | null;
  status?: number;
}

interface RawCurrency {
  symbol: string;
  name?: string;
  network?: string;
  decimals?: number;
  confirmations?: number;
  min_payout?: string;
}

interface RawDeposit {
  tx_hash?: string;
  coin?: string;
  network?: string;
  amount?: string;
  confirmations?: number;
  status?: string;
  credited?: boolean;
  address?: string | null;
  track_id?: string | null;
  created_at?: number;
}

/**
 * Thin, typed client for the documented OrbChain v2 API
 * (https://docs.orbchain.io). No endpoint here is guessed: each path, header
 * and field name comes from that reference.
 */
export class OrbChainProvider implements Provider {
  readonly name = 'orbchain';
  readonly isSimulated = false;

  private currencyCache: { at: number; value: ProviderCurrencyInfo[] } | null = null;

  private readonly options: {
    baseUrl: string;
    merchantApiKey: string;
    payoutApiKey: string;
    generalApiKey: string;
    /** Public webhook URL sent as callback_url on address creation. */
    webhookUrl?: string | null;
    timeoutMs?: number;
  };

  constructor(options: {
    baseUrl: string;
    merchantApiKey: string;
    payoutApiKey: string;
    generalApiKey: string;
    /** Public webhook URL sent as callback_url on address creation. */
    webhookUrl?: string | null;
    timeoutMs?: number;
  }) {
    this.options = options;
  }

  private async request<T>(input: {
    method: 'GET' | 'POST';
    path: string;
    key: 'merchant' | 'payout' | 'general' | 'none';
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  }): Promise<T> {
    const url = new URL(`${this.options.baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    const keyValue =
      input.key === 'merchant'
        ? this.options.merchantApiKey
        : input.key === 'payout'
          ? this.options.payoutApiKey
          : input.key === 'general'
            ? this.options.generalApiKey
            : '';
    if (input.key === 'merchant') headers.merchant_api_key = keyValue;
    if (input.key === 'payout') headers.payout_api_key = keyValue;
    if (input.key === 'general') headers.general_api_key = keyValue;
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      // Path only: never log headers, query strings or bodies (they can carry keys).
      logger.warn('OrbChain request failed', { path: input.path, error });
      throw new ProviderError('Could not reach the payment provider. Please try again shortly.', {
        retryable: true,
        cause: error,
      });
    }

    let payload: OrbChainEnvelope<T> | null = null;
    const text = await response.text();
    try {
      payload = text ? (JSON.parse(text) as OrbChainEnvelope<T>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok || (payload && payload.error)) {
      const message =
        (typeof payload?.error === 'object' && payload.error?.message) ||
        (typeof payload?.error === 'string' ? payload.error : '') ||
        payload?.message ||
        `HTTP ${response.status}`;
      logger.warn('OrbChain returned an error', { path: input.path, status: response.status, message });
      throw new ProviderError(cleanProviderMessage(message), {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    if (!payload || payload.data === undefined) {
      throw new ProviderError('The payment provider returned an unexpected response.', { retryable: true });
    }
    return payload.data;
  }

  async getCurrencies(): Promise<ProviderCurrencyInfo[]> {
    if (this.currencyCache && Date.now() - this.currencyCache.at < 10 * 60_000) {
      return this.currencyCache.value;
    }
    const data = await this.request<RawCurrency[]>({ method: 'GET', path: '/v1/common/currencies', key: 'none' });
    const value = data.map((currency) => ({
      symbol: currency.symbol,
      name: currency.name ?? currency.symbol,
      network: currency.network ?? '',
      decimals: currency.decimals ?? 8,
      confirmations: currency.confirmations ?? 1,
      minPayout: currency.min_payout ?? '0',
    }));
    this.currencyCache = { at: Date.now(), value };
    return value;
  }

  async getPrices(): Promise<ProviderPriceSnapshot> {
    const data = await this.request<Record<string, number>>({ method: 'GET', path: '/v1/common/prices', key: 'none' });
    // The docs state a coin's value is 0 when its price could not be fetched.
    const prices: Record<string, number> = {};
    for (const [symbol, price] of Object.entries(data)) {
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) prices[symbol] = price;
    }
    return { prices, timestamp: Date.now(), source: 'orbchain' };
  }

  async getOrCreateAddress(input: { userId: string; asset: AssetSymbol; description?: string }): Promise<{
    address: string;
    trackId: string | null;
  }> {
    const asset = getAsset(input.asset);
    const body: Record<string, string> = {
      currency: asset.providerSymbol,
      user_id: input.userId,
      description: input.description ?? 'FluxTip wallet deposit address',
    };
    if (this.options.webhookUrl) body.callback_url = this.options.webhookUrl;
    const data = await this.request<{ address?: string; track_id?: string | null }>({
      method: 'POST',
      path: '/v1/payment/static-address',
      key: 'merchant',
      body,
    });
    if (!data.address) {
      throw new ProviderError('The payment provider did not return a deposit address. Nothing was saved.');
    }
    return { address: data.address, trackId: data.track_id ?? null };
  }

  async listDeposits(input: { sinceSeconds: number; limit?: number; address?: string }): Promise<ProviderDeposit[]> {
    const data = await this.request<{ deposits?: RawDeposit[] }>({
      method: 'GET',
      path: '/v1/deposits',
      key: 'merchant',
      query: {
        since: input.sinceSeconds,
        limit: input.limit ?? 100,
        sort_order: 'asc',
        ...(input.address ? { address: input.address } : {}),
      },
    });
    return (data.deposits ?? [])
      .filter((deposit) => typeof deposit.tx_hash === 'string' && typeof deposit.coin === 'string')
      .map((deposit) => ({
        txHash: deposit.tx_hash as string,
        coin: deposit.coin as string,
        network: deposit.network ?? '',
        amount: deposit.amount ?? '0',
        confirmations: deposit.confirmations ?? 0,
        requiredConfirmations: 0,
        status: deposit.status ?? 'PENDING',
        credited: deposit.credited === true || (deposit.status ?? '').toUpperCase() === 'CREDITED',
        address: deposit.address ?? null,
        trackId: deposit.track_id ?? null,
        createdAt: deposit.created_at ?? Math.floor(Date.now() / 1000),
      }));
  }

  async createPayout(input: {
    asset: AssetSymbol;
    address: string;
    amount: string;
    idempotencyKey: string;
    description?: string;
  }): Promise<{ trackId: string; status: string }> {
    const asset = getAsset(input.asset);
    const data = await this.request<{ track_id?: string; status?: string }>({
      method: 'POST',
      path: '/v1/payout',
      key: 'payout',
      body: {
        currency: asset.providerSymbol,
        address: input.address,
        amount: input.amount,
        description: input.description ?? 'FluxTip withdrawal',
        idempotency_key: input.idempotencyKey,
      },
    });
    if (!data.track_id) {
      throw new ProviderError('The payment provider did not confirm the payout submission.', { retryable: true });
    }
    return { trackId: data.track_id, status: data.status ?? 'Confirming' };
  }

  async getPayout(trackId: string): Promise<ProviderPayoutStatus> {
    const data = await this.request<{
      track_id?: string;
      status?: string;
      tx_hash?: string | null;
      failure_reason?: string | null;
    }>({
      method: 'GET',
      path: `/v1/payout/${encodeURIComponent(trackId)}`,
      key: 'payout',
    });
    const status = data.status;
    return {
      trackId: data.track_id ?? trackId,
      status: status === 'Confirmed' ? 'Confirmed' : status === 'Failed' ? 'Failed' : status === 'Confirming' ? 'Confirming' : 'Unknown',
      txHash: data.tx_hash ?? null,
      failureReason: data.failure_reason ?? null,
    };
  }

  async getBalances(): Promise<Record<string, string>> {
    const data = await this.request<{ balances?: { coin: string; amount: string }[] }>({
      method: 'GET',
      path: '/v1/general/account/balance',
      key: 'general',
    });
    const balances: Record<string, string> = {};
    for (const entry of data.balances ?? []) balances[entry.coin] = entry.amount;
    return balances;
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(`${this.options.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return {
        ok: response.ok && body?.ok === true,
        detail: response.ok ? 'orbchain /health ok' : `orbchain /health HTTP ${response.status}`,
      };
    } catch (error) {
      logger.warn('OrbChain health check failed', { error });
      return { ok: false, detail: 'orbchain unreachable' };
    }
  }
}

function cleanProviderMessage(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').slice(0, 200);
  return trimmed.length > 0 ? trimmed : 'The payment provider rejected the request.';
}
