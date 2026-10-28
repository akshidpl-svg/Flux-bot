import { randomBytes } from 'node:crypto';
import { APP_FEE_USD, ASSETS, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { AppError, NotFoundError, ValidationError } from '../core/errors.ts';
import { planOutgoing, type FeeQuote } from '../core/fees.ts';
import { formatUnits } from '../core/money.ts';
import { isPaused, transaction, type DB } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { LedgerService } from './ledger.ts';
import type { PriceService } from './prices.ts';
import type { UsersService } from './users.ts';

export type TransferKind = 'tip' | 'send' | 'split' | 'request' | 'rain';

export interface TransferRow {
  id: number;
  group_id: string;
  kind: TransferKind;
  from_user_id: string;
  to_user_id: string;
  asset: string;
  network: string;
  amount: string;
  net: string;
  note: string | null;
  status: string;
  server_id: string | null;
  created_at: number;
}

export interface TransferReceipt {
  groupId: string;
  kind: TransferKind;
  fromUserId: string;
  asset: AssetSymbol;
  grossBase: bigint;
  netBase: bigint;
  feeBase: bigint;
  feeQuote: FeeQuote | null;
  note: string | null;
  status: string;
  createdAt: number;
  recipients: { userId: string; amountBase: bigint; netBase: bigint }[];
}

export interface RainResult extends TransferReceipt {
  rainId: number;
  serverId: string;
}

interface FeeRow {
  amount: string;
  usd_price: number;
  rate_timestamp: number;
  rate_source: string;
}

function newGroupId(kind: TransferKind): string {
  return `${kind}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

function splitEvenly(total: bigint, count: number): bigint[] {
  if (count <= 0) throw new ValidationError('There must be at least one recipient.');
  const base = total / BigInt(count);
  if (base <= 0n) throw new ValidationError('The amount is too small to split between that many recipients.');
  const remainder = total - base * BigInt(count);
  const shares = new Array<bigint>(count).fill(base);
  for (let index = 0; index < Number(remainder); index += 1) {
    shares[index] = (shares[index] ?? 0n) + 1n;
  }
  return shares;
}

/**
 * Internal transfers (tips, sends, splits, rain, paid requests). Every group is
 * one atomic transaction: the sender is debited once, each recipient credited
 * once, the fee recorded once, and an idempotency key prevents replays.
 */
interface TransfersDeps {
  ledger: LedgerService;
  users: UsersService;
  prices: PriceService;
  maxRainRecipients: number;
}

export class TransfersService {
  private readonly db: DB;
  private readonly deps: TransfersDeps;

  constructor(db: DB, deps: TransfersDeps) {
    this.db = db;
    this.deps = deps;
  }

  private replayKey(interactionId: string): string {
    return `discord:${interactionId}`;
  }

  private findReplay(interactionId: string): { scope: string; result: string } | null {
    const row = this.db
      .prepare('SELECT scope, result FROM idempotency_keys WHERE key = ?')
      .get(this.replayKey(interactionId)) as { scope: string; result: string | null } | undefined;
    if (!row?.result) return null;
    return { scope: row.scope, result: row.result };
  }

  async send(input: {
    kind: 'tip' | 'send' | 'split' | 'request';
    fromUserId: string;
    toUserIds: string[];
    asset: AssetSymbol;
    grossBase: bigint;
    note?: string | null;
    serverId?: string | null;
    interactionId: string;
  }): Promise<TransferReceipt> {
    if (isPaused(this.db)) throw new AppError('paused', 'Transfers are paused in emergency read-only mode.');
    if (input.toUserIds.length === 0) throw new ValidationError('Choose at least one recipient.');
    if (input.toUserIds.includes(input.fromUserId)) {
      throw new ValidationError('You cannot send a transfer to yourself.');
    }
    if (new Set(input.toUserIds).size !== input.toUserIds.length) {
      throw new ValidationError('Each recipient can only appear once.');
    }
    if (input.grossBase <= 0n) throw new ValidationError('Amount must be greater than zero.');

    const replay = this.findReplay(input.interactionId);
    if (replay) return this.getReceipt(replay.result);

    const fee = await this.deps.prices.quoteFee(input.asset);
    const balance = this.deps.ledger.balance(input.fromUserId, input.asset);
    const plan = planOutgoing(input.grossBase, fee.feeBase, balance);
    if (plan.netBase <= 0n) throw new ValidationError('The amount is too small to cover the application fee.');
    const shares = splitEvenly(plan.netBase, input.toUserIds.length);
    const grossShares = splitEvenly(input.grossBase, input.toUserIds.length);
    const groupId = newGroupId(input.kind);

    transaction(this.db, () => {
      const existing = this.findReplay(input.interactionId);
      if (existing) return;

      this.deps.users.ensure(input.fromUserId);
      const freshBalance = this.deps.ledger.balance(input.fromUserId, input.asset);
      if (freshBalance < plan.debitBase) {
        throw new AppError('insufficient_funds', 'Your balance changed while preparing this transfer. Please try again.');
      }

      this.deps.ledger.post({
        userId: input.fromUserId,
        asset: input.asset,
        delta: -plan.netBase,
        type: `${input.kind}_out`,
        refType: 'transfer',
        refId: groupId,
        memo: input.note ?? undefined,
      });
      this.deps.ledger.post({
        userId: input.fromUserId,
        asset: input.asset,
        delta: -plan.feeBase,
        type: 'app_fee',
        refType: 'transfer',
        refId: groupId,
        memo: 'Application fee',
      });

      const now = Date.now();
      input.toUserIds.forEach((toUserId, index) => {
        const share = shares[index] ?? 0n;
        this.deps.users.ensure(toUserId);
        this.deps.ledger.post({
          userId: toUserId,
          asset: input.asset,
          delta: share,
          type: `${input.kind}_in`,
          refType: 'transfer',
          refId: groupId,
          memo: input.note ?? undefined,
        });
        this.db
          .prepare(
            `INSERT INTO transfers (group_id, kind, from_user_id, to_user_id, asset, network, amount, net, note, status, server_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
          )
          .run(
            groupId,
            input.kind,
            input.fromUserId,
            toUserId,
            input.asset,
            ASSETS[input.asset].network,
            (grossShares[index] ?? 0n).toString(),
            share.toString(),
            input.note ?? null,
            input.serverId ?? null,
            now,
          );
      });

      this.db
        .prepare(
          `INSERT INTO fees (ref_type, ref_id, user_id, asset, network, amount, usd_amount, usd_price, rate_timestamp, rate_source, status, created_at)
           VALUES ('transfer', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
        )
        .run(
          groupId,
          input.fromUserId,
          input.asset,
          ASSETS[input.asset].network,
          plan.feeBase.toString(),
          fee.feeUsd,
          fee.priceUsd,
          fee.priceTimestamp,
          fee.priceSource,
          now,
        );

      this.db
        .prepare(
          `INSERT INTO idempotency_keys (key, user_id, scope, result, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(this.replayKey(input.interactionId), input.fromUserId, input.kind, groupId, now);
    });

    logger.info('Transfer completed', {
      groupId,
      kind: input.kind,
      from: input.fromUserId,
      recipients: input.toUserIds.length,
      asset: input.asset,
    });
    return this.getReceipt(groupId);
  }

  async rain(input: {
    hostUserId: string;
    serverId: string;
    channelId: string | null;
    asset: AssetSymbol;
    totalBase: bigint;
    count: number;
    interactionId: string;
  }): Promise<RainResult> {
    if (isPaused(this.db)) throw new AppError('paused', 'Rain is paused in emergency read-only mode.');
    if (input.totalBase <= 0n) throw new ValidationError('Rain amount must be greater than zero.');
    if (input.count < 1 || input.count > this.deps.maxRainRecipients) {
      throw new ValidationError(`Choose between 1 and ${this.deps.maxRainRecipients} recipients.`);
    }

    const replay = this.findReplay(input.interactionId);
    if (replay) {
      const row = this.db.prepare('SELECT id FROM rains WHERE id = ?').get(Number(replay.result)) as
        | { id: number }
        | undefined;
      if (row) return this.getRain(row.id);
    }

    const pool = this.db
      .prepare(
        `SELECT user_id FROM server_activity
         WHERE server_id = ? AND user_id != ? AND last_used_at >= ?
         GROUP BY user_id ORDER BY RANDOM() LIMIT ?`,
      )
      .all(input.serverId, input.hostUserId, Date.now() - 30 * 86_400_000, input.count) as { user_id: string }[];
    if (pool.length === 0) {
      throw new ValidationError(
        'Nobody else has used FluxTip in this server yet, so there is no rain pool. Ask people to run /wallet first.',
      );
    }

    const fee = await this.deps.prices.quoteFee(input.asset);
    const balance = this.deps.ledger.balance(input.hostUserId, input.asset);
    const plan = planOutgoing(input.totalBase, fee.feeBase, balance);
    const shares = splitEvenly(plan.netBase, pool.length);
    const recipients = pool.map((row, index) => ({ userId: row.user_id, share: shares[index] ?? 0n }));

    const rainId = transaction(this.db, () => {
      const existing = this.findReplay(input.interactionId);
      if (existing?.result) return Number(existing.result);

      this.deps.users.ensure(input.hostUserId);
      const fresh = this.deps.ledger.balance(input.hostUserId, input.asset);
      if (fresh < plan.debitBase) throw new AppError('insufficient_funds', 'Your balance changed; please try again.');
      const now = Date.now();

      const info = this.db
        .prepare(
          `INSERT INTO rains (server_id, channel_id, host_user_id, asset, network, total, fee, per_recipient, recipient_count, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
        )
        .run(
          input.serverId,
          input.channelId,
          input.hostUserId,
          input.asset,
          ASSETS[input.asset].network,
          plan.amountBase.toString(),
          plan.feeBase.toString(),
          (shares[0] ?? 0n).toString(),
          recipients.length,
          now,
        );
      const id = Number(info.lastInsertRowid);

      this.deps.ledger.post({
        userId: input.hostUserId,
        asset: input.asset,
        delta: -plan.netBase,
        type: 'rain_out',
        refType: 'rain',
        refId: String(id),
      });
      this.deps.ledger.post({
        userId: input.hostUserId,
        asset: input.asset,
        delta: -plan.feeBase,
        type: 'app_fee',
        refType: 'rain',
        refId: String(id),
        memo: 'Application fee (one per rain)',
      });
      for (const recipient of recipients) {
        this.deps.users.ensure(recipient.userId);
        this.deps.ledger.post({
          userId: recipient.userId,
          asset: input.asset,
          delta: recipient.share,
          type: 'rain_in',
          refType: 'rain',
          refId: String(id),
        });
        this.db
          .prepare('INSERT INTO rain_recipients (rain_id, user_id, amount, created_at) VALUES (?, ?, ?, ?)')
          .run(id, recipient.userId, recipient.share.toString(), now);
        this.db
          .prepare(
            `INSERT INTO transfers (group_id, kind, from_user_id, to_user_id, asset, network, amount, net, note, status, server_id, created_at)
             VALUES (?, 'rain', ?, ?, ?, ?, ?, ?, NULL, 'completed', ?, ?)`,
          )
          .run(
            `rain_${id}`,
            input.hostUserId,
            recipient.userId,
            input.asset,
            ASSETS[input.asset].network,
            recipient.share.toString(),
            recipient.share.toString(),
            input.serverId,
            now,
          );
      }
      this.db
        .prepare(
          `INSERT INTO fees (ref_type, ref_id, user_id, asset, network, amount, usd_amount, usd_price, rate_timestamp, rate_source, status, created_at)
           VALUES ('rain', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`,
        )
        .run(
          String(id),
          input.hostUserId,
          input.asset,
          ASSETS[input.asset].network,
          plan.feeBase.toString(),
          fee.feeUsd,
          fee.priceUsd,
          fee.priceTimestamp,
          fee.priceSource,
          now,
        );
      this.db
        .prepare('INSERT INTO idempotency_keys (key, user_id, scope, result, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(this.replayKey(input.interactionId), input.hostUserId, 'rain', String(id), now);
      return id;
    });

    logger.info('Rain completed', { rainId, host: input.hostUserId, recipients: recipients.length, asset: input.asset });
    return this.getRain(rainId);
  }

  getRain(rainId: number): RainResult {
    const rain = this.db.prepare('SELECT * FROM rains WHERE id = ?').get(rainId) as
      | {
          id: number;
          server_id: string;
          host_user_id: string;
          asset: string;
          total: string;
          fee: string;
          per_recipient: string;
          recipient_count: number;
          status: string;
          created_at: number;
        }
      | undefined;
    if (!rain) throw new NotFoundError('That rain could not be found.');
    const recipients = this.db
      .prepare('SELECT user_id, amount FROM rain_recipients WHERE rain_id = ?')
      .all(rainId) as { user_id: string; amount: string }[];
    const feeRow = this.feeRow('rain', String(rainId));
    const netBase = recipients.reduce((acc, recipient) => acc + BigInt(recipient.amount), 0n);
    return {
      rainId: rain.id,
      serverId: rain.server_id,
      groupId: `rain_${rain.id}`,
      kind: 'rain',
      fromUserId: rain.host_user_id,
      asset: rain.asset as AssetSymbol,
      grossBase: BigInt(rain.total),
      netBase,
      feeBase: BigInt(rain.fee),
      feeQuote: feeRow,
      note: null,
      status: rain.status,
      createdAt: rain.created_at,
      recipients: recipients.map((recipient) => ({
        userId: recipient.user_id,
        amountBase: BigInt(recipient.amount),
        netBase: BigInt(recipient.amount),
      })),
    };
  }

  private feeRow(refType: string, refId: string): FeeQuote | null {
    const row = this.db
      .prepare('SELECT * FROM fees WHERE ref_type = ? AND ref_id = ?')
      .get(refType, refId) as FeeRow | undefined;
    if (!row) return null;
    return {
      feeBase: BigInt(row.amount),
      priceUsd: row.usd_price,
      priceTimestamp: row.rate_timestamp,
      priceSource: row.rate_source,
      feeUsd: APP_FEE_USD,
    };
  }

  getReceipt(groupId: string): TransferReceipt {
    const rows = this.db
      .prepare('SELECT * FROM transfers WHERE group_id = ? ORDER BY id ASC')
      .all(groupId) as TransferRow[];
    if (rows.length === 0) throw new NotFoundError('No transaction matches that reference.');
    const first = rows[0] as TransferRow;
    const fee = this.feeRow('transfer', groupId);
    const netBase = rows.reduce((acc, row) => acc + BigInt(row.net), 0n);
    const grossBase = rows.reduce((acc, row) => acc + BigInt(row.amount), 0n);
    return {
      groupId,
      kind: first.kind,
      fromUserId: first.from_user_id,
      asset: first.asset as AssetSymbol,
      grossBase,
      netBase,
      feeBase: fee ? BigInt(fee.feeBase) : 0n,
      feeQuote: fee,
      note: first.note,
      status: first.status,
      createdAt: first.created_at,
      recipients: rows.map((row) => ({
        userId: row.to_user_id,
        amountBase: BigInt(row.amount),
        netBase: BigInt(row.net),
      })),
    };
  }

  countGroups(userId: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(DISTINCT group_id) AS n FROM transfers WHERE from_user_id = ? OR to_user_id = ?')
        .get(userId, userId) as { n: number }
    ).n;
  }

  /** Distinct transfer groups for /transactions pagination, newest first. */
  listGroups(userId: string, options: { limit?: number; offset?: number } = {}): string[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    const rows = this.db
      .prepare(
        `SELECT group_id, MAX(id) AS latest FROM transfers WHERE from_user_id = ? OR to_user_id = ?
         GROUP BY group_id ORDER BY latest DESC LIMIT ? OFFSET ?`,
      )
      .all(userId, userId, limit, Math.max(options.offset ?? 0, 0)) as { group_id: string }[];
    return rows.map((row) => row.group_id);
  }

  listTransfers(userId: string, options: { limit?: number; beforeId?: number; serverId?: string } = {}): TransferRow[] {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 25);
    const args: (string | number)[] = [userId];
    let sql = 'SELECT * FROM transfers WHERE (from_user_id = ? OR to_user_id = ?)';
    args.push(userId);
    if (options.serverId) {
      sql += ' AND server_id = ?';
      args.push(options.serverId);
    }
    if (options.beforeId) {
      sql += ' AND id < ?';
      args.push(options.beforeId);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args) as TransferRow[];
  }

  /** Tip totals for a user, optionally scoped to one server. */
  tipStats(userId: string, serverId?: string): {
    sentCount: number;
    sentBase: Map<AssetSymbol, bigint>;
    receivedCount: number;
    receivedBase: Map<AssetSymbol, bigint>;
  } {
    const scope = serverId ? ' AND server_id = ?' : '';
    const params = serverId ? [userId, serverId] : [userId];
    const sent = this.db
      .prepare(`SELECT asset, net FROM transfers WHERE from_user_id = ? AND kind IN ('tip','rain')${scope}`)
      .all(...params) as { asset: string; net: string }[];
    const received = this.db
      .prepare(`SELECT asset, net FROM transfers WHERE to_user_id = ? AND kind IN ('tip','rain')${scope}`)
      .all(...params) as { asset: string; net: string }[];
    const sentBase = new Map<AssetSymbol, bigint>();
    const receivedBase = new Map<AssetSymbol, bigint>();
    for (const row of sent) {
      const asset = row.asset as AssetSymbol;
      sentBase.set(asset, (sentBase.get(asset) ?? 0n) + BigInt(row.net));
    }
    for (const row of received) {
      const asset = row.asset as AssetSymbol;
      receivedBase.set(asset, (receivedBase.get(asset) ?? 0n) + BigInt(row.net));
    }
    return {
      sentCount: sent.length,
      sentBase,
      receivedCount: received.length,
      receivedBase,
    };
  }

  /** Tipping leaderboard, optionally server-scoped, aggregated per asset in JS to avoid integer casts. */
  leaderboard(options: { serverId?: string; limit?: number } = {}): {
    userId: string;
    perAsset: Map<AssetSymbol, bigint>;
    count: number;
  }[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 25);
    const params: string[] = [];
    let sql = `SELECT from_user_id AS user_id, asset, net FROM transfers WHERE kind = 'tip'`;
    if (options.serverId) {
      sql += ' AND server_id = ?';
      params.push(options.serverId);
    } else {
      sql += ' AND server_id IS NOT NULL';
    }
    const rows = this.db.prepare(sql).all(...params) as { user_id: string; asset: string; net: string }[];
    const users = new Map<string, { perAsset: Map<AssetSymbol, bigint>; count: number }>();
    for (const row of rows) {
      const entry = users.get(row.user_id) ?? { perAsset: new Map<AssetSymbol, bigint>(), count: 0 };
      const asset = row.asset as AssetSymbol;
      entry.perAsset.set(asset, (entry.perAsset.get(asset) ?? 0n) + BigInt(row.net));
      entry.count += 1;
      users.set(row.user_id, entry);
    }
    return [...users.entries()]
      .map(([userId, entry]) => ({ userId, ...entry }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  describeAmount(asset: AssetSymbol, base: bigint): string {
    return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
  }
}
