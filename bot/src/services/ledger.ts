import { ASSETS, getAsset, type AssetSymbol } from '../core/assets.ts';
import type { DB } from '../db/index.ts';

export interface LedgerEntryRow {
  id: number;
  user_id: string;
  asset: string;
  network: string;
  delta: string;
  balance_after: string;
  entry_type: string;
  ref_type: string | null;
  ref_id: string | null;
  memo: string | null;
  created_at: number;
}

export interface PostEntry {
  userId: string;
  asset: AssetSymbol;
  /** Signed change in base units. */
  delta: bigint;
  type: string;
  refType?: string;
  refId?: string;
  memo?: string;
}

export interface WalletRow {
  user_id: string;
  asset: string;
  network: string;
  available: string;
  locked: string;
  updated_at: number;
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Single write path for every balance change. Callers must run inside a
 * `transaction()`; every entry is appended to the ledger with the resulting
 * balance so wallets can always be re-derived and audited.
 */
export class LedgerService {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  ensureWallet(userId: string, asset: AssetSymbol): void {
    const meta = getAsset(asset);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO wallets (user_id, asset, network, available, locked, updated_at)
         VALUES (?, ?, ?, '0', '0', ?)
         ON CONFLICT(user_id, asset, network) DO NOTHING`,
      )
      .run(userId, asset, meta.network, now);
  }

  wallet(userId: string, asset: AssetSymbol): WalletRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM wallets WHERE user_id = ? AND asset = ?')
        .get(userId, asset) as WalletRow | undefined) ?? null
    );
  }

  balance(userId: string, asset: AssetSymbol): bigint {
    const row = this.wallet(userId, asset);
    return row ? toBigInt(row.available) : 0n;
  }

  balances(userId: string): Map<AssetSymbol, bigint> {
    const rows = this.db.prepare('SELECT asset, available FROM wallets WHERE user_id = ?').all(userId) as {
      asset: string;
      available: string;
    }[];
    const map = new Map<AssetSymbol, bigint>();
    for (const row of rows) {
      if (Object.hasOwn(ASSETS, row.asset)) map.set(row.asset as AssetSymbol, toBigInt(row.available));
    }
    return map;
  }

  post(entry: PostEntry): bigint {
    this.ensureWallet(entry.userId, entry.asset);
    const current = this.balance(entry.userId, entry.asset);
    const next = current + entry.delta;
    if (next < 0n) {
      throw new Error(`ledger invariant violated: ${entry.userId} ${entry.asset} would go negative`);
    }
    const network = getAsset(entry.asset).network;
    this.db
      .prepare('UPDATE wallets SET available = ?, updated_at = ? WHERE user_id = ? AND asset = ? AND network = ?')
      .run(next.toString(), Date.now(), entry.userId, entry.asset, network);
    this.db
      .prepare(
        `INSERT INTO ledger_entries (user_id, asset, network, delta, balance_after, entry_type, ref_type, ref_id, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.userId,
        entry.asset,
        network,
        entry.delta.toString(),
        next.toString(),
        entry.type,
        entry.refType ?? null,
        entry.refId ?? null,
        entry.memo ?? null,
        Date.now(),
      );
    return next;
  }

  history(userId: string, options: { limit?: number; beforeId?: number; offset?: number } = {}): LedgerEntryRow[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    if (options.beforeId) {
      return this.db
        .prepare('SELECT * FROM ledger_entries WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(userId, options.beforeId, limit) as LedgerEntryRow[];
    }
    return this.db
      .prepare('SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(userId, limit, Math.max(options.offset ?? 0, 0)) as LedgerEntryRow[];
  }

  count(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id = ?').get(userId) as { n: number }).n;
  }

  /**
   * Balance reconciliation: for every wallet, the wallet value must equal the
   * sum of its ledger entries and must not be negative.
   */
  verifyIntegrity(): { ok: boolean; problems: string[]; wallets: number } {
    const problems: string[] = [];
    const wallets = this.db.prepare('SELECT * FROM wallets').all() as WalletRow[];
    const sumStmt = this.db.prepare(
      'SELECT delta FROM ledger_entries WHERE user_id = ? AND asset = ? AND network = ?',
    );
    for (const wallet of wallets) {
      const rows = sumStmt.all(wallet.user_id, wallet.asset, wallet.network) as { delta: string }[];
      const total = rows.reduce((acc, row) => acc + toBigInt(row.delta), 0n);
      if (total !== toBigInt(wallet.available)) {
        problems.push(
          `wallet ${wallet.user_id}/${wallet.asset}: stored ${wallet.available} != ledger ${total.toString()}`,
        );
      }
      if (toBigInt(wallet.available) < 0n) {
        problems.push(`wallet ${wallet.user_id}/${wallet.asset}: negative balance ${wallet.available}`);
      }
    }
    return { ok: problems.length === 0, problems, wallets: wallets.length };
  }
}
