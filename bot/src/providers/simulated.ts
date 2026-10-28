import type { AssetSymbol } from '../core/assets.ts';
import { ASSETS, ASSET_SYMBOLS } from '../core/assets.ts';
import type {
  Provider,
  ProviderCurrencyInfo,
  ProviderDeposit,
  ProviderPayoutStatus,
  ProviderPriceSnapshot,
} from './types.ts';

const SIM_PRICES: Record<string, number> = {
  BTC: 60000,
  LTC: 80,
  ETH: 3000,
  SOL: 150,
  USDT_TRC20: 1,
};

const SIM_MIN_PAYOUT: Record<string, string> = {
  BTC: '0.0001',
  LTC: '0.01',
  ETH: '0.002',
  SOL: '0.01',
  USDT_TRC20: '1',
};

interface SimPayout {
  trackId: string;
  asset: AssetSymbol;
  address: string;
  amount: string;
  status: 'Confirming' | 'Confirmed' | 'Failed';
  txHash: string | null;
  failureReason: string | null;
  createdAt: number;
  confirmAfterMs: number;
}

/**
 * In-process fake provider used for development and automated tests. Everything
 * it returns is marked `simulated` so the UI can never present it as a real
 * blockchain or market event.
 */
export class SimulatedProvider implements Provider {
  readonly name = 'simulated';
  readonly isSimulated = true;

  private deposits: ProviderDeposit[] = [];
  private payouts = new Map<string, SimPayout>();
  private sequence = 0;

  private readonly options: { confirmAfterMs?: number };

  constructor(options: { confirmAfterMs?: number } = {}) {
    this.options = options;
  }

  async getCurrencies(): Promise<ProviderCurrencyInfo[]> {
    return ASSET_SYMBOLS.map((symbol) => {
      const asset = ASSETS[symbol];
      return {
        symbol: asset.providerSymbol,
        name: asset.name,
        network: asset.network,
        decimals: asset.decimals,
        confirmations: symbol === 'USDT_TRC20' ? 19 : 2,
        minPayout: SIM_MIN_PAYOUT[symbol] ?? '0',
      };
    });
  }

  async getPrices(): Promise<ProviderPriceSnapshot> {
    return { prices: { ...SIM_PRICES }, timestamp: Date.now(), source: 'simulated' };
  }

  async getOrCreateAddress(input: { userId: string; asset: AssetSymbol }): Promise<{ address: string; trackId: string | null }> {
    const asset = ASSETS[input.asset];
    // Deliberately not a valid on-chain address format.
    return { address: `sim:${asset.network}:${input.userId}`, trackId: `simaddr_${input.asset}_${input.userId}` };
  }

  async listDeposits(input: { sinceSeconds: number; limit?: number; address?: string }): Promise<ProviderDeposit[]> {
    return this.deposits
      .filter((deposit) => deposit.createdAt >= input.sinceSeconds)
      .filter((deposit) => !input.address || deposit.address === input.address)
      .slice(0, input.limit ?? 100)
      .map((deposit) => ({ ...deposit }));
  }

  async createPayout(input: {
    asset: AssetSymbol;
    address: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<{ trackId: string; status: string }> {
    const existing = [...this.payouts.values()].find((payout) => payout.trackId === `simpay_${input.idempotencyKey}`);
    if (existing) return { trackId: existing.trackId, status: existing.status };

    this.sequence += 1;
    const trackId = `simpay_${input.idempotencyKey}`;
    this.payouts.set(trackId, {
      trackId,
      asset: input.asset,
      address: input.address,
      amount: input.amount,
      status: 'Confirming',
      txHash: null,
      failureReason: null,
      createdAt: Date.now(),
      confirmAfterMs: this.options.confirmAfterMs ?? 2_000,
    });
    return { trackId, status: 'Confirming' };
  }

  async getPayout(trackId: string): Promise<ProviderPayoutStatus> {
    const payout = this.payouts.get(trackId);
    if (!payout) return { trackId, status: 'Unknown', txHash: null, failureReason: null };
    if (payout.status === 'Confirming' && Date.now() - payout.createdAt >= payout.confirmAfterMs) {
      payout.status = 'Confirmed';
      payout.txHash = `simtx_${trackId}`;
    }
    return {
      trackId,
      status: payout.status,
      txHash: payout.txHash,
      failureReason: payout.failureReason,
    };
  }

  async getBalances(): Promise<Record<string, string>> {
    return {};
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'simulated provider (no blockchain contact)' };
  }

  /** Test/dev helper: queues a fake on-chain deposit. */
  simulateDeposit(input: {
    userId: string;
    asset: AssetSymbol;
    amount: string;
    address: string;
    status?: 'PENDING' | 'CONFIRMED' | 'CREDITED' | 'FAILED';
    confirmations?: number;
  }): ProviderDeposit {
    this.sequence += 1;
    const deposit: ProviderDeposit = {
      txHash: `simtx_deposit_${this.sequence}_${input.asset}`,
      coin: ASSETS[input.asset].providerSymbol,
      network: ASSETS[input.asset].network,
      amount: input.amount,
      confirmations: input.confirmations ?? 3,
      requiredConfirmations: 2,
      status: input.status ?? 'CREDITED',
      credited: (input.status ?? 'CREDITED') === 'CREDITED',
      address: input.address,
      trackId: null,
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.deposits.push(deposit);
    return deposit;
  }

  /** Test/dev helper: move a queued fake deposit to a later provider status. */
  setDepositStatus(
    txHash: string,
    status: 'PENDING' | 'CONFIRMED' | 'CREDITED' | 'FAILED',
    confirmations?: number,
  ): void {
    const deposit = this.deposits.find((entry) => entry.txHash === txHash);
    if (!deposit) return;
    deposit.status = status;
    deposit.credited = status === 'CREDITED';
    if (confirmations !== undefined) deposit.confirmations = confirmations;
  }

  /** Test/dev helper: force a payout outcome. */
  setPayoutStatus(trackId: string, status: 'Confirmed' | 'Failed', reason?: string): void {
    const payout = this.payouts.get(trackId);
    if (!payout) return;
    payout.status = status;
    payout.failureReason = reason ?? (status === 'Failed' ? 'simulated_failure' : null);
    payout.txHash = status === 'Confirmed' ? `simtx_${trackId}` : null;
  }
}
