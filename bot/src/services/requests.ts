import { randomBytes } from 'node:crypto';
import { ASSETS, type AssetSymbol } from '../core/assets.ts';
import { AppError, NotFoundError, ValidationError } from '../core/errors.ts';
import { planOutgoing } from '../core/fees.ts';
import { isPaused, transaction, type DB } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { LedgerService } from './ledger.ts';
import type { PriceService } from './prices.ts';
import type { TransfersService, TransferReceipt } from './transfers.ts';
import type { UsersService } from './users.ts';

export interface PaymentRequestRow {
  id: string;
  requester_id: string;
  payer_id: string;
  asset: string;
  network: string;
  amount: string;
  note: string | null;
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  group_id: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

const OPEN_STATUS = 'open';

/**
 * Payment requests: a requester asks a specific Discord user for an amount.
 * Requests are paid at most once (guarded status transition), and expire.
 */
interface RequestsDeps {
  ledger: LedgerService;
  users: UsersService;
  prices: PriceService;
  transfers: TransfersService;
}

export class RequestsService {
  private readonly db: DB;
  private readonly deps: RequestsDeps;

  constructor(db: DB, deps: RequestsDeps) {
    this.db = db;
    this.deps = deps;
  }

  private newId(): string {
    return randomBytes(4).toString('hex').toUpperCase();
  }

  create(input: {
    requesterId: string;
    payerId: string;
    asset: AssetSymbol;
    amountBase: bigint;
    note?: string | null;
    expiresInHours?: number;
    interactionId: string;
  }): PaymentRequestRow {
    if (isPaused(this.db)) throw new AppError('paused', 'Payment requests are paused in emergency read-only mode.');
    if (input.requesterId === input.payerId) throw new ValidationError('You cannot request a payment from yourself.');
    if (input.amountBase <= 0n) throw new ValidationError('Requested amount must be greater than zero.');
    const hours = Math.min(Math.max(input.expiresInHours ?? 24, 1), 168);
    const now = Date.now();

    const id = transaction(this.db, () => {
      const replay = this.db
        .prepare('SELECT result FROM idempotency_keys WHERE key = ?')
        .get(`discord:${input.interactionId}`) as { result: string | null } | undefined;
      if (replay?.result) return replay.result;

      this.deps.users.ensure(input.requesterId);
      this.deps.users.ensure(input.payerId);
      let requestId = this.newId();
      while (this.db.prepare('SELECT 1 FROM payment_requests WHERE id = ?').get(requestId)) {
        requestId = this.newId();
      }
      this.db
        .prepare(
          `INSERT INTO payment_requests (id, requester_id, payer_id, asset, network, amount, note, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          requestId,
          input.requesterId,
          input.payerId,
          input.asset,
          ASSETS[input.asset].network,
          input.amountBase.toString(),
          input.note ?? null,
          now,
          now + hours * 3_600_000,
        );
      this.db
        .prepare('INSERT INTO idempotency_keys (key, user_id, scope, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`discord:${input.interactionId}`, input.requesterId, 'request_create', requestId, now);
      return requestId;
    });

    return this.getById(id);
  }

  getById(id: string): PaymentRequestRow {
    const row = this.db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id.toUpperCase()) as
      | PaymentRequestRow
      | undefined;
    if (!row) throw new NotFoundError(`Payment request ${id.toUpperCase()} was not found.`);
    return row;
  }

  listOpenFor(userId: string): PaymentRequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM payment_requests WHERE payer_id = ? AND status = 'open' AND expires_at > ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all(userId, Date.now()) as PaymentRequestRow[];
  }

  listFor(userId: string, limit = 10): PaymentRequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM payment_requests WHERE requester_id = ? OR payer_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, userId, Math.min(Math.max(limit, 1), 25)) as PaymentRequestRow[];
  }

  async pay(input: { requestId: string; payerId: string; interactionId: string }): Promise<TransferReceipt> {
    if (isPaused(this.db)) throw new AppError('paused', 'Transfers are paused in emergency read-only mode.');
    const request = this.getById(input.requestId);
    if (request.payer_id !== input.payerId) {
      throw new ValidationError('Only the user named in this request can pay it.');
    }
    if (request.status !== OPEN_STATUS) throw new ValidationError(`This request is already ${request.status}.`);
    if (request.expires_at <= Date.now()) {
      this.db.prepare("UPDATE payment_requests SET status = 'expired' WHERE id = ? AND status = 'open'").run(request.id);
      throw new ValidationError('This payment request has expired.');
    }

    const replay = this.db
      .prepare('SELECT result FROM idempotency_keys WHERE key = ?')
      .get(`discord:${input.interactionId}`) as { result: string | null } | undefined;
    if (replay?.result) return this.deps.transfers.getReceipt(replay.result);

    const asset = request.asset as AssetSymbol;
    const amountBase = BigInt(request.amount);
    const fee = await this.deps.prices.quoteFee(asset);
    const balance = this.deps.ledger.balance(input.payerId, asset);
    const plan = planOutgoing(amountBase, fee.feeBase, balance);
    const groupId = `req_${request.id}`;
    const now = Date.now();

    transaction(this.db, () => {
      const claimed = this.db
        .prepare(
          `UPDATE payment_requests SET status = 'paid', group_id = ?, paid_at = ? WHERE id = ? AND status = 'open'`,
        )
        .run(groupId, now, request.id);
      if (claimed.changes !== 1) throw new ValidationError('This request was already paid or cancelled.');

      const fresh = this.deps.ledger.balance(input.payerId, asset);
      if (fresh < plan.debitBase) {
        throw new AppError('insufficient_funds', 'Your balance changed; please try again.');
      }
      this.deps.ledger.post({
        userId: input.payerId,
        asset,
        delta: -plan.netBase,
        type: 'request_out',
        refType: 'transfer',
        refId: groupId,
        memo: request.note ?? undefined,
      });
      this.deps.ledger.post({
        userId: input.payerId,
        asset,
        delta: -plan.feeBase,
        type: 'app_fee',
        refType: 'transfer',
        refId: groupId,
        memo: 'Application fee',
      });
      this.deps.ledger.post({
        userId: request.requester_id,
        asset,
        delta: plan.netBase,
        type: 'request_in',
        refType: 'transfer',
        refId: groupId,
        memo: request.note ?? undefined,
      });
      this.db
        .prepare(
          `INSERT INTO transfers (group_id, kind, from_user_id, to_user_id, asset, network, amount, net, note, status, server_id, created_at)
           VALUES (?, 'request', ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?)`,
        )
        .run(
          groupId,
          input.payerId,
          request.requester_id,
          asset,
          ASSETS[asset].network,
          plan.amountBase.toString(),
          plan.netBase.toString(),
          request.note ?? null,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO fees (ref_type, ref_id, user_id, asset, network, amount, usd_amount, usd_price, rate_timestamp, rate_source, status, created_at)
           VALUES ('transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
        )
        .run(
          groupId,
          input.payerId,
          asset,
          ASSETS[asset].network,
          plan.feeBase.toString(),
          fee.feeUsd,
          fee.priceUsd,
          fee.priceTimestamp,
          fee.priceSource,
          now,
        );
      this.db
        .prepare('INSERT INTO idempotency_keys (key, user_id, scope, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(`discord:${input.interactionId}`, input.payerId, 'request_pay', groupId, now);
    });

    logger.info('Payment request paid', { requestId: request.id, payer: input.payerId });
    return this.deps.transfers.getReceipt(groupId);
  }

  cancel(requestId: string, requesterId: string): PaymentRequestRow {
    const request = this.getById(requestId);
    if (request.requester_id !== requesterId) {
      throw new ValidationError('Only the requester can cancel this request.');
    }
    if (request.status !== OPEN_STATUS) throw new ValidationError(`This request is already ${request.status}.`);
    this.db
      .prepare("UPDATE payment_requests SET status = 'cancelled' WHERE id = ? AND status = 'open'")
      .run(request.id);
    return this.getById(request.id);
  }

  expireStale(): number {
    const result = this.db
      .prepare("UPDATE payment_requests SET status = 'expired' WHERE status = 'open' AND expires_at <= ?")
      .run(Date.now());
    return result.changes;
  }
}
