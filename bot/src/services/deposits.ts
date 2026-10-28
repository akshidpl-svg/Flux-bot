import { ASSETS, getAsset, type AssetSymbol } from '../core/assets.ts';
import { AppError } from '../core/errors.ts';
import { planDeposit, type FeeQuote } from '../core/fees.ts';
import { formatUnits, parseUnits } from '../core/money.ts';
import { transaction, type DB } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { Provider, ProviderDeposit } from '../providers/types.ts';
import type { AddressService } from './addresses.ts';
import type { LedgerService } from './ledger.ts';
import type { PriceService } from './prices.ts';
import type { UsersService } from './users.ts';

export type DepositStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'rejected';

export interface DepositRow {
  id: number;
  user_id: string;
  asset: string;
  network: string;
  tx_hash: string;
  address: string | null;
  provider_track_id: string | null;
  amount: string;
  fee: string;
  net: string;
  usd_price: number | null;
  rate_timestamp: number | null;
  rate_source: string | null;
  confirmations: number;
  required_confirmations: number;
  status: DepositStatus;
  failure_reason: string | null;
  raw: string | null;
  created_at: number;
  credited_at: number | null;
}

export interface PaymentWebhookPayload {
  type?: string;
  status?: string;
  currency?: string;
  address?: string;
  track_id?: string;
  transactions?: {
    tx_hash?: string;
    coin?: string;
    amount?: string;
    confirmations?: number;
    status?: string;
  }[];
}

export type DepositProcessResult =
  | { outcome: 'credited'; txHash: string }
  | { outcome: 'pending' | 'confirming' | 'duplicate' | 'failed' | 'rejected' | 'ignored'; txHash: string };

export function coinToAsset(coin: string): AssetSymbol | null {
  const found = (Object.keys(ASSETS) as AssetSymbol[]).find((symbol) => ASSETS[symbol].providerSymbol === coin);
  return found ?? null;
}

function normalizeStatus(status: string, credited: boolean): { status: DepositStatus; credit: boolean } {
  const upper = status.toUpperCase();
  if (upper === 'FAILED' || upper === 'REJECTED') return { status: 'failed', credit: false };
  if (credited || upper === 'CREDITED' || upper === 'PAID') return { status: 'confirmed', credit: true };
  if (upper === 'CONFIRMED' || upper === 'CONFIRMING' || upper === 'PAYING') {
    return { status: 'confirming', credit: false };
  }
  return { status: 'pending', credit: false };
}

/**
 * Credits deposits only after the provider reports them as credited. Everything
 * is keyed on tx_hash, so webhooks, polling and retries can never double-credit.
 */
interface DepositsDeps {
  ledger: LedgerService;
  users: UsersService;
  addresses: AddressService;
  provider: Provider;
  prices: PriceService;
}

export class DepositsService {
  private readonly db: DB;
  private readonly deps: DepositsDeps;

  constructor(db: DB, deps: DepositsDeps) {
    this.db = db;
    this.deps = deps;
  }

  private async confirmationsFor(asset: AssetSymbol): Promise<number> {
    try {
      const currencies = await this.deps.provider.getCurrencies();
      const info = currencies.find((currency) => currency.symbol === getAsset(asset).providerSymbol);
      return info?.confirmations ?? 0;
    } catch {
      return 0;
    }
  }

  async processProviderDeposit(deposit: ProviderDeposit): Promise<DepositProcessResult> {
    const asset = coinToAsset(deposit.coin);
    if (!asset) {
      logger.warn('Ignoring deposit in unsupported coin', { coin: deposit.coin });
      return { outcome: 'ignored', txHash: deposit.txHash };
    }

    const existing = this.db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(deposit.txHash) as
      | DepositRow
      | undefined;
    if (existing?.status === 'confirmed') {
      return { outcome: 'duplicate', txHash: deposit.txHash };
    }
    if (existing?.status === 'rejected') {
      return { outcome: 'rejected', txHash: deposit.txHash };
    }

    const normalized = normalizeStatus(deposit.status, deposit.credited);
    const requiredConfirmations = await this.confirmationsFor(asset);
    const addressRow = deposit.address ? this.deps.addresses.findByAddress(deposit.address, asset) : null;
    const userId = existing?.user_id ?? addressRow?.user_id ?? null;

    if (!userId) {
      // Unknown address: record the event for reconciliation but never credit it.
      logger.warn('Deposit to an address FluxTip does not own', { coin: deposit.coin, trackId: deposit.trackId });
      return { outcome: 'ignored', txHash: deposit.txHash };
    }
    const user = this.deps.users.find(userId);
    if (!user) {
      logger.warn('Deposit for unknown FluxTip user', { userId, coin: deposit.coin });
      return { outcome: 'ignored', txHash: deposit.txHash };
    }

    const amountBase = safeParse(deposit.amount, ASSETS[asset].decimals);
    if (amountBase === null || amountBase <= 0n) {
      logger.warn('Deposit with invalid amount', { txHash: deposit.txHash, coin: deposit.coin });
      return { outcome: 'ignored', txHash: deposit.txHash };
    }

    if (!normalized.credit) {
      this.upsertPending({ deposit, asset, userId, amountBase, normalized, requiredConfirmations });
      return {
        outcome: normalized.status === 'failed' ? 'failed' : normalized.status === 'confirming' ? 'confirming' : 'pending',
        txHash: deposit.txHash,
      };
    }

    // A credit needs a verified rate for the application fee. If no rate exists we
    // keep the deposit pending and retry later - we never guess a fee or a value.
    let feeQuote: FeeQuote;
    try {
      feeQuote = await this.deps.prices.quoteFee(asset);
    } catch (error) {
      logger.warn('Delaying deposit credit until a verified price is available', { txHash: deposit.txHash });
      this.upsertPending({ deposit, asset, userId, amountBase, normalized: { status: 'confirming', credit: false }, requiredConfirmations });
      return { outcome: 'confirming', txHash: deposit.txHash };
    }

    let credited: { netBase: bigint; feeBase: bigint };
    try {
      credited = planDeposit(amountBase, feeQuote.feeBase);
    } catch {
      this.rejectDeposit({ deposit, asset, userId, amountBase, reason: 'below_app_fee', requiredConfirmations });
      return { outcome: 'rejected', txHash: deposit.txHash };
    }

    const outcome = transaction(this.db, (): DepositProcessResult => {
      const current = this.db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(deposit.txHash) as
        | DepositRow
        | undefined;
      if (current?.status === 'confirmed') return { outcome: 'duplicate', txHash: deposit.txHash };

      const now = Date.now();
      if (!current) {
        this.db
          .prepare(
            `INSERT INTO deposits
             (user_id, asset, network, tx_hash, address, provider_track_id, amount, fee, net, usd_price, rate_timestamp,
              rate_source, confirmations, required_confirmations, status, raw, created_at, credited_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
          )
          .run(
            userId,
            asset,
            ASSETS[asset].network,
            deposit.txHash,
            deposit.address,
            deposit.trackId,
            amountBase.toString(),
            credited.feeBase.toString(),
            credited.netBase.toString(),
            feeQuote.priceUsd,
            feeQuote.priceTimestamp,
            feeQuote.priceSource,
            deposit.confirmations,
            requiredConfirmations,
            JSON.stringify(deposit),
            now,
            now,
          );
      } else {
        this.db
          .prepare(
            `UPDATE deposits SET status = 'confirmed', fee = ?, net = ?, usd_price = ?, rate_timestamp = ?, rate_source = ?,
             confirmations = ?, required_confirmations = ?, credited_at = ? WHERE tx_hash = ?`,
          )
          .run(
            credited.feeBase.toString(),
            credited.netBase.toString(),
            feeQuote.priceUsd,
            feeQuote.priceTimestamp,
            feeQuote.priceSource,
            deposit.confirmations,
            requiredConfirmations,
            now,
            deposit.txHash,
          );
      }

      this.deps.ledger.post({
        userId,
        asset,
        delta: credited.netBase,
        type: 'deposit',
        refType: 'deposit',
        refId: deposit.txHash,
        memo: `Deposit ${formatUnits(amountBase, ASSETS[asset].decimals)} ${asset}`,
      });
      // Fee is withheld from the deposit itself: record it in the ledger with a
      // zero delta so fee history and revenue stay auditable.
      this.deps.ledger.post({
        userId,
        asset,
        delta: 0n,
        type: 'app_fee',
        refType: 'deposit_fee',
        refId: deposit.txHash,
        memo: `Application fee withheld (${formatUnits(credited.feeBase, ASSETS[asset].decimals)} ${asset})`,
      });
      this.db
        .prepare(
          `INSERT INTO fees (ref_type, ref_id, user_id, asset, network, amount, usd_amount, usd_price, rate_timestamp, rate_source, status, created_at)
           VALUES ('deposit', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
           ON CONFLICT(ref_type, ref_id) DO NOTHING`,
        )
        .run(
          deposit.txHash,
          userId,
          asset,
          ASSETS[asset].network,
          credited.feeBase.toString(),
          feeQuote.feeUsd,
          feeQuote.priceUsd,
          feeQuote.priceTimestamp,
          feeQuote.priceSource,
          now,
        );
      return { outcome: 'credited', txHash: deposit.txHash };
    });

    if (outcome.outcome === 'credited') {
      logger.info('Deposit credited', { userId, asset, txHash: deposit.txHash });
    }
    return outcome;
  }

  private upsertPending(input: {
    deposit: ProviderDeposit;
    asset: AssetSymbol;
    userId: string;
    amountBase: bigint;
    normalized: { status: DepositStatus; credit: boolean };
    requiredConfirmations: number;
  }): void {
    const { deposit, asset, userId, amountBase, normalized, requiredConfirmations } = input;
    this.db
      .prepare(
        `INSERT INTO deposits
         (user_id, asset, network, tx_hash, address, provider_track_id, amount, confirmations, required_confirmations, status, raw, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tx_hash) DO UPDATE SET
           confirmations = excluded.confirmations,
           required_confirmations = excluded.required_confirmations,
           status = excluded.status,
           raw = excluded.raw`,
      )
      .run(
        userId,
        asset,
        ASSETS[asset].network,
        deposit.txHash,
        deposit.address,
        deposit.trackId,
        amountBase.toString(),
        deposit.confirmations,
        requiredConfirmations,
        normalized.status,
        JSON.stringify(deposit),
        Date.now(),
      );
  }

  private rejectDeposit(input: {
    deposit: ProviderDeposit;
    asset: AssetSymbol;
    userId: string;
    amountBase: bigint;
    reason: string;
    requiredConfirmations: number;
  }): void {
    const { deposit, asset, userId, amountBase, reason, requiredConfirmations } = input;
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO deposits
           (user_id, asset, network, tx_hash, address, provider_track_id, amount, confirmations, required_confirmations, status, failure_reason, raw, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)
           ON CONFLICT(tx_hash) DO UPDATE SET status = 'rejected', failure_reason = excluded.failure_reason`,
        )
        .run(
          userId,
          asset,
          ASSETS[asset].network,
          deposit.txHash,
          deposit.address,
          deposit.trackId,
          amountBase.toString(),
          deposit.confirmations,
          requiredConfirmations,
          reason,
          JSON.stringify(deposit),
          Date.now(),
        );
      this.db
        .prepare('INSERT INTO admin_audit (actor_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('system', 'deposit_rejected', deposit.txHash, JSON.stringify({ userId, asset, reason }), Date.now());
    });
  }

  /** Handles the documented payment webhook shape (payment.paid / payment webhook). */
  async handlePaymentWebhook(payload: PaymentWebhookPayload): Promise<DepositProcessResult[]> {
    const results: DepositProcessResult[] = [];
    const transactions = payload.transactions ?? [];
    for (const entry of transactions) {
      if (!entry.tx_hash || !entry.coin || !entry.amount) continue;
      const status = entry.status ?? payload.status ?? 'PENDING';
      const credited =
        entry.status?.toUpperCase() === 'CREDITED' ||
        (entry.status === undefined && payload.status?.toUpperCase() === 'Paid');
      results.push(
        await this.processProviderDeposit({
          txHash: entry.tx_hash,
          coin: entry.coin,
          network: '',
          amount: entry.amount,
          confirmations: entry.confirmations ?? 0,
          requiredConfirmations: 0,
          status,
          credited,
          address: payload.address ?? null,
          trackId: payload.track_id ?? null,
          createdAt: Math.floor(Date.now() / 1000),
        }),
      );
    }
    return results;
  }

  /** Pull-based backstop for webhooks that were missed. */
  async poll(sinceSeconds: number): Promise<{ processed: number; credited: number; creditedHashes: string[] }> {
    const deposits = await this.deps.provider.listDeposits({ sinceSeconds, limit: 200 });
    let processed = 0;
    const creditedHashes: string[] = [];
    for (const deposit of deposits) {
      const result = await this.processProviderDeposit(deposit);
      processed += 1;
      if (result.outcome === 'credited') creditedHashes.push(deposit.txHash);
    }
    return { processed, credited: creditedHashes.length, creditedHashes };
  }

  /**
   * Re-checks deposits that are still open, e.g. because the price feed was
   * briefly unavailable when the provider first reported the credit. Scoped to
   * FluxTip-owned addresses, so it can never touch anyone else's funds.
   */
  async refreshOpen(limit = 10): Promise<{ addresses: number; credited: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT address, MIN(created_at) AS oldest FROM deposits
         WHERE status IN ('pending', 'confirming') AND address IS NOT NULL
         GROUP BY address ORDER BY oldest ASC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 25)) as { address: string; oldest: number }[];
    const credited: string[] = [];
    for (const row of rows) {
      let deposits: ProviderDeposit[];
      try {
        deposits = await this.deps.provider.listDeposits({
          sinceSeconds: Math.max(0, Math.floor(row.oldest / 1000) - 3_600),
          limit: 100,
          address: row.address,
        });
      } catch (error) {
        logger.warn('Could not refresh open deposits', { error });
        continue;
      }
      for (const deposit of deposits) {
        const result = await this.processProviderDeposit(deposit);
        if (result.outcome === 'credited') credited.push(result.txHash);
      }
    }
    return { addresses: rows.length, credited };
  }

  history(userId: string, options: { limit?: number; beforeId?: number; offset?: number } = {}): DepositRow[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 25);
    if (options.beforeId) {
      return this.db
        .prepare('SELECT * FROM deposits WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(userId, options.beforeId, limit) as DepositRow[];
    }
    return this.db
      .prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(userId, limit, Math.max(options.offset ?? 0, 0)) as DepositRow[];
  }

  count(userId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM deposits WHERE user_id = ?').get(userId) as { n: number }
    ).n;
  }

  byTxHash(txHash: string): DepositRow | null {
    return (this.db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(txHash) as DepositRow | undefined) ?? null;
  }

  getForUser(userId: string, txHash: string): DepositRow {
    const row = this.byTxHash(txHash);
    if (!row || row.user_id !== userId) {
      throw new AppError('not_found', 'No deposit with that transaction hash belongs to your account.');
    }
    return row;
  }
}

function safeParse(value: string, decimals: number): bigint | null {
  try {
    return parseUnits(value, decimals);
  } catch {
    return null;
  }
}
