import type { AssetSymbol } from '../core/assets.ts';

export interface ProviderCurrencyInfo {
  symbol: string;
  name: string;
  network: string;
  decimals: number;
  confirmations: number;
  minPayout: string;
}

export interface ProviderPriceSnapshot {
  /** USD price per whole coin, keyed by provider symbol. */
  prices: Record<string, number>;
  timestamp: number;
  source: string;
}

export interface ProviderDeposit {
  txHash: string;
  coin: string;
  network: string;
  amount: string;
  confirmations: number;
  requiredConfirmations: number;
  /** Raw provider status: PENDING, CONFIRMED, CREDITED, FAILED or payment status. */
  status: string;
  credited: boolean;
  address: string | null;
  trackId: string | null;
  createdAt: number;
}

export interface ProviderPayoutStatus {
  trackId: string;
  status: 'Confirming' | 'Confirmed' | 'Failed' | 'Unknown';
  txHash: string | null;
  failureReason: string | null;
}

export interface Provider {
  readonly name: string;
  readonly isSimulated: boolean;
  getCurrencies(): Promise<ProviderCurrencyInfo[]>;
  getPrices(): Promise<ProviderPriceSnapshot>;
  getOrCreateAddress(input: { userId: string; asset: AssetSymbol; description?: string }): Promise<{
    address: string;
    trackId: string | null;
  }>;
  listDeposits(input: { sinceSeconds: number; limit?: number; address?: string }): Promise<ProviderDeposit[]>;
  createPayout(input: {
    asset: AssetSymbol;
    address: string;
    /** Amount in whole coin units, already net of FluxTip's application fee. */
    amount: string;
    idempotencyKey: string;
    description?: string;
  }): Promise<{ trackId: string; status: string }>;
  getPayout(trackId: string): Promise<ProviderPayoutStatus>;
  getBalances(): Promise<Record<string, string>>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
