import { ASSETS, ASSET_SYMBOLS, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { formatUnits } from '../core/money.ts';
import { isPaused, type DB } from '../db/index.ts';
import type { Config } from '../config.ts';
import type { Provider } from '../providers/types.ts';
import type { DepositsService } from './deposits.ts';
import type { LedgerService } from './ledger.ts';
import type { TransfersService } from './transfers.ts';
import type { UsersService } from './users.ts';
import type { WithdrawalsService } from './withdrawals.ts';

export interface RevenueSummary {
  feeCount: number;
  completedCount: number;
  voidedCount: number;
  pendingCount: number;
  revenueUsd: number;
  bySource: { refType: string; count: number; usd: number }[];
  byAsset: { asset: string; amount: string; count: number }[];
}

interface StatsDeps {
  config: Config;
  ledger: LedgerService;
  users: UsersService;
  deposits: DepositsService;
  withdrawals: WithdrawalsService;
  transfers: TransfersService;
  provider: Provider;
}

export class StatsService {
  private readonly db: DB;
  private readonly deps: StatsDeps;

  constructor(db: DB, deps: StatsDeps) {
    this.db = db;
    this.deps = deps;
  }

  platform(): {
    users: number;
    wallets: number;
    deposits: number;
    withdrawals: number;
    transfers: number;
    rains: number;
    feeCount: number;
    revenueUsd: number;
    openRequests: number;
    activeAlerts: number;
    paused: boolean;
    databaseBytes: number;
    uptimeSeconds: number;
  } {
    const n = (sql: string, ...params: (string | number)[]) =>
      (this.db.prepare(sql).get(...params) as { n: number }).n;
    const pageCount = (this.db.pragma('page_count', { simple: true }) as number) ?? 0;
    const pageSize = (this.db.pragma('page_size', { simple: true }) as number) ?? 0;
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      wallets: n('SELECT COUNT(*) AS n FROM wallets WHERE available != \'0\''),
      deposits: n('SELECT COUNT(*) AS n FROM deposits'),
      withdrawals: n('SELECT COUNT(*) AS n FROM withdrawals'),
      transfers: n("SELECT COUNT(DISTINCT group_id) AS n FROM transfers"),
      rains: n('SELECT COUNT(*) AS n FROM rains'),
      feeCount: n("SELECT COUNT(*) AS n FROM fees WHERE status = 'completed'"),
      revenueUsd: Math.round(
        (this.db.prepare("SELECT COALESCE(SUM(usd_amount), 0) AS s FROM fees WHERE status = 'completed'").get() as {
          s: number;
        }).s * 100,
      ) / 100,
      openRequests: n("SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'open'"),
      activeAlerts: n("SELECT COUNT(*) AS n FROM price_alerts WHERE status = 'active'"),
      paused: isPaused(this.db),
      databaseBytes: pageCount * pageSize,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  userOverview(userId: string, serverId?: string): {
    joinedAt: number;
    balances: { asset: AssetSymbol; amount: bigint }[];
    tipsSent: number;
    tipsReceived: number;
    deposits: number;
    withdrawals: number;
    requestsPaid: number;
  } {
    const user = this.deps.users.ensure(userId);
    const balances = [...this.deps.ledger.balances(userId).entries()]
      .filter(([, amount]) => amount > 0n)
      .map(([asset, amount]) => ({ asset, amount }));
    const tips = this.deps.transfers.tipStats(userId, serverId);
    const deposits = (
      this.db.prepare("SELECT COUNT(*) AS n FROM deposits WHERE user_id = ? AND status = 'confirmed'").get(userId) as {
        n: number;
      }
    ).n;
    const withdrawals = (
      this.db.prepare('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?').get(userId) as { n: number }
    ).n;
    const requestsPaid = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE payer_id = ? AND status = 'paid'")
        .get(userId) as { n: number }
    ).n;
    return {
      joinedAt: user.created_at,
      balances,
      tipsSent: tips.sentCount,
      tipsReceived: tips.receivedCount,
      deposits,
      withdrawals,
      requestsPaid,
    };
  }

  revenue(): RevenueSummary {
    const rows = this.db.prepare('SELECT ref_type, status, usd_amount, asset, amount FROM fees').all() as {
      ref_type: string;
      status: string;
      usd_amount: number;
      asset: string;
      amount: string;
    }[];
    const bySource = new Map<string, { count: number; usd: number }>();
    const byAsset = new Map<string, { amount: bigint; count: number }>();
    let completedCount = 0;
    let voidedCount = 0;
    let pendingCount = 0;
    let revenueUsd = 0;
    for (const row of rows) {
      if (row.status === 'completed') {
        completedCount += 1;
        revenueUsd += row.usd_amount;
        const source = bySource.get(row.ref_type) ?? { count: 0, usd: 0 };
        source.count += 1;
        source.usd += row.usd_amount;
        bySource.set(row.ref_type, source);
        const asset = byAsset.get(row.asset) ?? { amount: 0n, count: 0 };
        asset.amount += BigInt(row.amount);
        asset.count += 1;
        byAsset.set(row.asset, asset);
      } else if (row.status === 'voided') {
        voidedCount += 1;
      } else {
        pendingCount += 1;
      }
    }
    return {
      feeCount: rows.length,
      completedCount,
      voidedCount,
      pendingCount,
      revenueUsd: Math.round(revenueUsd * 100) / 100,
      bySource: [...bySource.entries()].map(([refType, value]) => ({
        refType,
        count: value.count,
        usd: Math.round(value.usd * 100) / 100,
      })),
      byAsset: [...byAsset.entries()].map(([asset, value]) => ({
        asset,
        amount: formatUnits(value.amount, ASSETS[asset as AssetSymbol]?.decimals ?? 8),
        count: value.count,
      })),
    };
  }

  recentFees(limit = 15): {
    id: number;
    refType: string;
    refId: string;
    userId: string;
    asset: string;
    amount: string;
    usd: number;
    status: string;
    createdAt: number;
  }[] {
    return (
      this.db.prepare('SELECT * FROM fees ORDER BY id DESC LIMIT ?').all(Math.min(limit, 50)) as {
        id: number;
        ref_type: string;
        ref_id: string;
        user_id: string;
        asset: string;
        amount: string;
        usd_amount: number;
        status: string;
        created_at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      refType: row.ref_type,
      refId: row.ref_id,
      userId: row.user_id,
      asset: row.asset,
      amount: row.amount,
      usd: row.usd_amount,
      status: row.status,
      createdAt: row.created_at,
    }));
  }

  recentLedger(limit = 15): { id: number; userId: string; asset: string; delta: string; type: string; ref: string | null; createdAt: number }[] {
    return (
      this.db
        .prepare('SELECT * FROM ledger_entries ORDER BY id DESC LIMIT ?')
        .all(Math.min(limit, 50)) as {
        id: number;
        user_id: string;
        asset: string;
        delta: string;
        entry_type: string;
        ref_id: string | null;
        created_at: number;
      }[]
    ).map((row) => ({
      id: row.id,
      userId: row.user_id,
      asset: row.asset,
      delta: row.delta,
      type: row.entry_type,
      ref: row.ref_id,
      createdAt: row.created_at,
    }));
  }

  userAdminView(discordId: string): {
    user: { userId: string; currency: string; createdAt: number };
    balances: { asset: AssetSymbol; amount: string }[];
    deposits: number;
    withdrawals: number;
    openRequests: number;
    audit: { action: string; target: string | null; createdAt: number }[];
  } {
    const user = this.deps.users.ensure(discordId);
    return {
      user: { userId: user.user_id, currency: user.display_currency, createdAt: user.created_at },
      balances: [...this.deps.ledger.balances(discordId).entries()]
        .filter(([, amount]) => amount > 0n)
        .map(([asset, amount]) => ({ asset, amount: formatUnits(amount, ASSETS[asset].decimals) })),
      deposits: (
        this.db.prepare('SELECT COUNT(*) AS n FROM deposits WHERE user_id = ?').get(discordId) as { n: number }
      ).n,
      withdrawals: (
        this.db.prepare('SELECT COUNT(*) AS n FROM withdrawals WHERE user_id = ?').get(discordId) as { n: number }
      ).n,
      openRequests: (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE (requester_id = ? OR payer_id = ?) AND status = 'open'")
          .get(discordId, discordId) as { n: number }
      ).n,
      audit: this.db
        .prepare("SELECT action, target, created_at FROM admin_audit WHERE target = ? ORDER BY id DESC LIMIT 5")
        .all(discordId) as { action: string; target: string | null; createdAt: number }[],
    };
  }

  auditLogs(limit = 15): { actorId: string; action: string; target: string | null; details: string | null; createdAt: number }[] {
    return (
      this.db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').all(Math.min(limit, 50)) as {
        actor_id: string;
        action: string;
        target: string | null;
        details: string | null;
        created_at: number;
      }[]
    ).map((row) => ({
      actorId: row.actor_id,
      action: row.action,
      target: row.target,
      details: row.details,
      createdAt: row.created_at,
    }));
  }

  /**
   * Reconciles three sources of truth: the ledger, stored wallet balances and the
   * provider's merchant balance. Differences are reported, never silently fixed.
   */
  async reconcile(): Promise<{
    ledgerOk: boolean;
    ledgerProblems: string[];
    wallets: number;
    liabilities: { asset: AssetSymbol; amount: string; totalBase: bigint }[];
    providerBalances: Record<string, string> | null;
    providerError: string | null;
    pendingWithdrawals: number;
    confirmingWithdrawals: number;
    pendingDeposits: number;
    unprocessedWebhooks: number;
    withdrawalsLive: boolean;
    simulated: boolean;
  }> {
    const ledger = this.deps.ledger.verifyIntegrity();
    const liabilities: { asset: AssetSymbol; amount: string; totalBase: bigint }[] = [];
    for (const asset of ASSET_SYMBOLS) {
      const rows = this.db.prepare('SELECT available FROM wallets WHERE asset = ?').all(asset) as { available: string }[];
      const total = rows.reduce((acc, row) => acc + BigInt(row.available), 0n);
      liabilities.push({ asset, amount: formatUnits(total, ASSETS[asset].decimals), totalBase: total });
    }

    let providerBalances: Record<string, string> | null = null;
    let providerError: string | null = null;
    try {
      providerBalances = await this.deps.provider.getBalances();
    } catch (error) {
      providerError = 'Provider balance could not be read; nothing else was assumed.';
    }

    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ledgerOk: ledger.ok,
      ledgerProblems: ledger.problems,
      wallets: ledger.wallets,
      liabilities,
      providerBalances,
      providerError,
      pendingWithdrawals: count("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'"),
      confirmingWithdrawals: count("SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'confirming'"),
      pendingDeposits: count("SELECT COUNT(*) AS n FROM deposits WHERE status IN ('pending','confirming')"),
      unprocessedWebhooks: count("SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'received'"),
      withdrawalsLive: this.deps.config.withdrawalsLive,
      simulated: this.deps.provider.isSimulated,
    };
  }

  health(): Promise<{ ok: boolean; detail: string }> {
    return this.deps.provider.healthCheck();
  }

  liabilityFor(asset: AssetSymbol): string {
    const rows = this.db.prepare('SELECT available FROM wallets WHERE asset = ?').all(asset) as { available: string }[];
    const total = rows.reduce((acc, row) => acc + BigInt(row.available), 0n);
    return `${formatUnits(total, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
  }
}
