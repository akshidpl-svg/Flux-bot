import { ASSETS, assetTicker, getAsset, type AssetSymbol } from '../core/assets.ts';
import { AppError, NotFoundError, ProviderError, ValidationError } from '../core/errors.ts';
import { planWithdrawal, type FeeQuote } from '../core/fees.ts';
import { formatUnits, parseUnits } from '../core/money.ts';
import { isPaused, transaction, type DB } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { Provider } from '../providers/types.ts';
import type { LedgerService } from './ledger.ts';
import type { PriceService } from './prices.ts';
import type { UsersService } from './users.ts';

export type WithdrawalStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'cancelled';

export interface WithdrawalRow {
  id: number;
  user_id: string;
  asset: string;
  network: string;
  address: string;
  amount: string;
  fee: string;
  net: string;
  provider_fee: string | null;
  status: WithdrawalStatus;
  provider_track_id: string | null;
  provider_tx_hash: string | null;
  idempotency_key: string;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface WithdrawalQuote {
  asset: AssetSymbol;
  amountBase: bigint;
  feeBase: bigint;
  netBase: bigint;
  feeQuote: FeeQuote;
  amountUsd: number;
  netUsd: number;
  providerMinPayoutBase: bigint | null;
  providerNetworkFeeNote: string;
}

export interface CreateWithdrawalInput {
  userId: string;
  asset: AssetSymbol;
  amountBase: bigint;
  address: string;
  interactionId: string;
}

const ADDRESS_PATTERNS: Record<AssetSymbol, { pattern: RegExp; hint: string }> = {
  BTC: {
    pattern: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    hint: 'a Bitcoin address starting with bc1, 1 or 3',
  },
  LTC: {
    pattern: /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    hint: 'a Litecoin address starting with ltc1, L, M or 3',
  },
  ETH: { pattern: /^0x[a-fA-F0-9]{40}$/, hint: 'a 0x-prefixed 40 character Ethereum address' },
  SOL: { pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, hint: 'a base58 Solana address (32-44 characters)' },
  USDT_TRC20: { pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, hint: 'a TRON address starting with T (TRC-20 only)' },
};

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '11111111111111111111111111111111',
]);

export function validateDestination(asset: AssetSymbol, address: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = address.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return { ok: false, reason: 'Address length looks wrong.' };
  if (trimmed.toLowerCase().startsWith('sim:')) {
    return { ok: false, reason: 'That is a simulated address, not a real on-chain destination.' };
  }
  if (BURN_ADDRESSES.has(trimmed) || BURN_ADDRESSES.has(trimmed.toLowerCase())) {
    return { ok: false, reason: 'That is a known burn address. Funds sent there are unrecoverable.' };
  }
  const { pattern, hint } = ADDRESS_PATTERNS[asset];
  if (!pattern.test(trimmed)) {
    return { ok: false, reason: `Expected ${hint} for ${assetTicker(asset)}.` };
  }
  return { ok: true };
}

/**
 * Withdrawals debit the user's wallet immediately (net + fee), then ask the
 * provider for a payout. A provider failure refunds both entries, so failed
 * transfers never keep the fee. Live payouts require WITHDRAWALS_LIVE=true.
 */
interface WithdrawalsDeps {
  ledger: LedgerService;
  users: UsersService;
  provider: Provider;
  prices: PriceService;
  limits: { minWithdrawUsd: number; maxWithdrawUsd: number; withdrawalsLive: boolean };
}

export class WithdrawalsService {
  private readonly db: DB;
  private readonly deps: WithdrawalsDeps;

  constructor(db: DB, deps: WithdrawalsDeps) {
    this.db = db;
    this.deps = deps;
  }

  private async providerMinPayout(asset: AssetSymbol): Promise<bigint | null> {
    try {
      const currencies = await this.deps.provider.getCurrencies();
      const info = currencies.find((currency) => currency.symbol === getAsset(asset).providerSymbol);
      if (!info) return null;
      return parseUnits(info.minPayout, ASSETS[asset].decimals);
    } catch {
      return null;
    }
  }

  async quote(userId: string, asset: AssetSymbol, amountBase: bigint): Promise<WithdrawalQuote> {
    if (amountBase <= 0n) throw new ValidationError('Withdrawal amount must be greater than zero.');
    const price = await this.deps.prices.quote(asset);
    const feeQuote = await this.deps.prices.quoteFee(asset);
    const { netBase, feeBase } = planWithdrawal(amountBase, feeQuote.feeBase);

    const whole = Number(formatUnits(amountBase, ASSETS[asset].decimals));
    const amountUsd = whole * price.priceUsd;
    const providerMin = await this.providerMinPayout(asset);

    if (amountUsd < this.deps.limits.minWithdrawUsd) {
      throw new ValidationError(
        `Minimum withdrawal is $${this.deps.limits.minWithdrawUsd.toFixed(2)} notional, which is about ${(
          this.deps.limits.minWithdrawUsd / price.priceUsd
        ).toFixed(8)} ${assetTicker(asset)} at the current rate.`,
      );
    }
    if (amountUsd > this.deps.limits.maxWithdrawUsd) {
      throw new ValidationError(
        `Maximum withdrawal per transaction is $${this.deps.limits.maxWithdrawUsd.toFixed(2)} notional.`,
      );
    }
    if (providerMin !== null && netBase < providerMin) {
      throw new ValidationError(
        `The provider's minimum ${assetTicker(asset)} payout is ${formatUnits(providerMin, ASSETS[asset].decimals)}, and your net amount after the fee would be ${formatUnits(netBase, ASSETS[asset].decimals)}. Increase the amount.`,
      );
    }
    return {
      asset,
      amountBase,
      feeBase,
      netBase,
      feeQuote,
      amountUsd,
      netUsd: Number(formatUnits(netBase, ASSETS[asset].decimals)) * price.priceUsd,
      providerMinPayoutBase: providerMin,
      providerNetworkFeeNote:
        'Provider and blockchain network fees are charged separately by OrbChain from the merchant balance; they are not part of the FluxTip application fee.',
    };
  }

  async create(input: CreateWithdrawalInput): Promise<WithdrawalRow> {
    if (isPaused(this.db)) {
      throw new AppError('paused', 'New withdrawals are paused right now. Your balance is unchanged and history is available.');
    }
    if (!this.deps.provider.isSimulated && !this.deps.limits.withdrawalsLive) {
      throw new AppError(
        'withdrawals_disabled',
        'Live withdrawals are disabled on this deployment until the OrbChain integration has been reviewed. No funds were moved.',
      );
    }
    const destination = validateDestination(input.asset, input.address);
    if (!destination.ok) throw new ValidationError(destination.reason);

    const quote = await this.quote(input.userId, input.asset, input.amountBase);
    const idempotencyKey = `discord:${input.interactionId}`;
    const id = transaction(this.db, () => {
      const replay = this.db
        .prepare('SELECT * FROM withdrawals WHERE idempotency_key = ?')
        .get(idempotencyKey) as WithdrawalRow | undefined;
      if (replay) return replay.id;

      this.deps.users.ensure(input.userId);
      const balance = this.deps.ledger.balance(input.userId, input.asset);
      if (balance < input.amountBase) {
        throw new AppError(
          'insufficient_funds',
          `Insufficient ${assetTicker(input.asset)} balance. You need the withdrawal amount plus the application fee.`,
        );
      }
      const now = Date.now();
      const info = this.db
        .prepare(
          `INSERT INTO withdrawals
           (user_id, asset, network, address, amount, fee, net, status, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          input.userId,
          input.asset,
          ASSETS[input.asset].network,
          input.address.trim(),
          input.amountBase.toString(),
          quote.feeBase.toString(),
          quote.netBase.toString(),
          idempotencyKey,
          now,
          now,
        );
      const withdrawalId = Number(info.lastInsertRowid);

      this.deps.ledger.post({
        userId: input.userId,
        asset: input.asset,
        delta: -quote.netBase,
        type: 'withdrawal_out',
        refType: 'withdrawal',
        refId: String(withdrawalId),
        memo: `Withdrawal to ${shortAddress(input.address)}`,
      });
      this.deps.ledger.post({
        userId: input.userId,
        asset: input.asset,
        delta: -quote.feeBase,
        type: 'app_fee',
        refType: 'withdrawal',
        refId: String(withdrawalId),
        memo: 'Application fee',
      });
      this.db
        .prepare(
          `INSERT INTO fees (ref_type, ref_id, user_id, asset, network, amount, usd_amount, usd_price, rate_timestamp, rate_source, status, created_at)
           VALUES ('withdrawal', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          String(withdrawalId),
          input.userId,
          input.asset,
          ASSETS[input.asset].network,
          quote.feeBase.toString(),
          quote.feeQuote.feeUsd,
          quote.feeQuote.priceUsd,
          quote.feeQuote.priceTimestamp,
          quote.feeQuote.priceSource,
          now,
        );
      return withdrawalId;
    });

    const row = this.getById(id);
    logger.info('Withdrawal requested', { userId: input.userId, asset: input.asset, withdrawalId: id });
    return this.submit(row);
  }

  /** Submits a pending row to the provider using a stable provider idempotency key. */
  private async submit(row: WithdrawalRow): Promise<WithdrawalRow> {
    if (row.status !== 'pending') return row;
    const asset = row.asset as AssetSymbol;
    try {
      const result = await this.deps.provider.createPayout({
        asset,
        address: row.address,
        amount: formatUnits(BigInt(row.net), ASSETS[asset].decimals),
        idempotencyKey: `fluxtip-wd-${row.id}`,
        description: `FluxTip withdrawal #${row.id}`,
      });
      this.db
        .prepare(
          `UPDATE withdrawals SET status = 'confirming', provider_track_id = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(result.trackId, Date.now(), row.id);
      logger.info('Withdrawal submitted to provider', { withdrawalId: row.id, providerStatus: result.status });
      return this.getById(row.id);
    } catch (error) {
      if (error instanceof ProviderError && error.retryable) {
        // Keep it pending: the job retries with the same provider idempotency key,
        // so a timeout can never produce a second payout.
        logger.warn('Withdrawal submission will be retried', { withdrawalId: row.id });
        return this.getById(row.id);
      }
      const reason = error instanceof AppError ? error.userMessage : 'provider rejected the payout';
      this.failAndRefund(row.id, reason);
      return this.getById(row.id);
    }
  }

  async retryPending(limit = 10): Promise<number> {
    const rows = this.db
      .prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id ASC LIMIT ?")
      .all(limit) as WithdrawalRow[];
    let submitted = 0;
    for (const row of rows) {
      const updated = await this.submit(row);
      if (updated.status !== 'pending') submitted += 1;
    }
    return submitted;
  }

  async syncPending(limit = 25): Promise<{
    checked: number;
    confirmed: number;
    failed: number;
    confirmedIds: number[];
    failedIds: number[];
  }> {
    const rows = this.db
      .prepare("SELECT * FROM withdrawals WHERE status = 'confirming' AND provider_track_id IS NOT NULL ORDER BY id ASC LIMIT ?")
      .all(limit) as WithdrawalRow[];
    const confirmedIds: number[] = [];
    const failedIds: number[] = [];
    for (const row of rows) {
      try {
        const status = await this.deps.provider.getPayout(row.provider_track_id as string);
        if (status.status === 'Confirmed') {
          this.markConfirmed(row.id, status.txHash);
          confirmedIds.push(row.id);
        } else if (status.status === 'Failed') {
          this.failAndRefund(row.id, status.failureReason ?? 'payout failed at provider');
          failedIds.push(row.id);
        }
      } catch {
        logger.warn('Could not refresh payout status', { withdrawalId: row.id });
      }
    }
    return {
      checked: rows.length,
      confirmed: confirmedIds.length,
      failed: failedIds.length,
      confirmedIds,
      failedIds,
    };
  }

  handlePayoutWebhook(payload: {
    type?: string;
    status?: string;
    track_id?: string;
    tx_hash?: string | null;
    failure_reason?: string | null;
  }): { outcome: 'confirmed' | 'failed' | 'ignored'; withdrawalId: number | null } {
    if (!payload.track_id) return { outcome: 'ignored', withdrawalId: null };
    const row = this.db
      .prepare('SELECT * FROM withdrawals WHERE provider_track_id = ?')
      .get(payload.track_id) as WithdrawalRow | undefined;
    if (!row) return { outcome: 'ignored', withdrawalId: null };
    if (payload.status === 'Confirmed') {
      this.markConfirmed(row.id, payload.tx_hash ?? null);
      return { outcome: 'confirmed', withdrawalId: row.id };
    }
    if (payload.status === 'Failed') {
      this.failAndRefund(row.id, payload.failure_reason ?? 'payout failed at provider');
      return { outcome: 'failed', withdrawalId: row.id };
    }
    return { outcome: 'ignored', withdrawalId: row.id };
  }

  private markConfirmed(id: number, txHash: string | null): void {
    transaction(this.db, () => {
      const row = this.getById(id);
      if (row.status === 'confirmed' || row.status === 'failed') return;
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE withdrawals SET status = 'confirmed', provider_tx_hash = COALESCE(?, provider_tx_hash),
           updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(txHash, now, now, id);
      this.db
        .prepare("UPDATE fees SET status = 'completed' WHERE ref_type = 'withdrawal' AND ref_id = ?")
        .run(String(id));
    });
  }

  /** Refunds the full debited amount (net + fee) exactly once. */
  failAndRefund(id: number, reason: string): void {
    transaction(this.db, () => {
      const row = this.getById(id);
      if (row.status === 'failed' || row.status === 'confirmed' || row.status === 'cancelled') return;
      const asset = row.asset as AssetSymbol;
      const net = BigInt(row.net);
      const fee = BigInt(row.fee);
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE withdrawals SET status = 'failed', failure_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(reason.slice(0, 200), now, now, id);
      if (net > 0n) {
        this.deps.ledger.post({
          userId: row.user_id,
          asset,
          delta: net,
          type: 'withdrawal_refund',
          refType: 'withdrawal',
          refId: String(id),
          memo: 'Withdrawal failed: amount returned',
        });
      }
      if (fee > 0n) {
        this.deps.ledger.post({
          userId: row.user_id,
          asset,
          delta: fee,
          type: 'app_fee_refund',
          refType: 'withdrawal',
          refId: String(id),
          memo: 'Withdrawal failed: application fee returned',
        });
      }
      this.db
        .prepare("UPDATE fees SET status = 'voided' WHERE ref_type = 'withdrawal' AND ref_id = ?")
        .run(String(id));
      this.db
        .prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('system', 'withdrawal_failed', String(id), JSON.stringify({ reason }), now);
    });
    logger.warn('Withdrawal failed and refunded', { withdrawalId: id, reason });
  }

  getById(id: number): WithdrawalRow {
    const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id) as WithdrawalRow | undefined;
    if (!row) throw new NotFoundError(`Withdrawal #${id} was not found.`);
    return row;
  }

  getForUser(userId: string, id: number): WithdrawalRow {
    const row = this.getById(id);
    if (row.user_id !== userId) throw new NotFoundError(`Withdrawal #${id} was not found.`);
    return row;
  }

  history(userId: string, options: { limit?: number; beforeId?: number; offset?: number } = {}): WithdrawalRow[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 25);
    if (options.beforeId) {
      return this.db
        .prepare('SELECT * FROM withdrawals WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(userId, options.beforeId, limit) as WithdrawalRow[];
    }
    return this.db
      .prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(userId, limit, Math.max(options.offset ?? 0, 0)) as WithdrawalRow[];
  }

  count(userId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?').get(userId) as { n: number }
    ).n;
  }

  countByStatus(status: WithdrawalStatus): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM withdrawals WHERE status = ?').get(status) as { n: number }
    ).n;
  }
}

export function shortAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-6)}`;
}

export function withdrawalReference(id: number): string {
  return `w_${id}`;
}
