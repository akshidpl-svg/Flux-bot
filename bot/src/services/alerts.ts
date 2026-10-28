import { ASSETS, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { ValidationError } from '../core/errors.ts';
import type { DB } from '../db/index.ts';
import type { PriceService } from './prices.ts';

export interface AlertRow {
  id: number;
  user_id: string;
  asset: string;
  direction: 'above' | 'below';
  target_usd: number;
  status: 'active' | 'triggered' | 'deleted';
  created_at: number;
  triggered_at: number | null;
  last_price: number | null;
}

const MAX_ALERTS_PER_USER = 10;

export class AlertsService {
  private readonly db: DB;
  private readonly prices: PriceService;

  constructor(db: DB, prices: PriceService) {
    this.db = db;
    this.prices = prices;
  }

  add(userId: string, asset: AssetSymbol, direction: 'above' | 'below', targetUsd: number): AlertRow {
    if (!Number.isFinite(targetUsd) || targetUsd <= 0) {
      throw new ValidationError('Target price must be a positive USD value.');
    }
    const active = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = ? AND status = 'active'")
        .get(userId) as { n: number }
    ).n;
    if (active >= MAX_ALERTS_PER_USER) {
      throw new ValidationError(`You already have ${MAX_ALERTS_PER_USER} active price alerts. Remove one first.`);
    }
    const result = this.db
      .prepare(
        `INSERT INTO price_alerts (user_id, asset, direction, target_usd, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(userId, asset, direction, targetUsd, Date.now());
    return this.db.prepare('SELECT * FROM price_alerts WHERE id = ?').get(result.lastInsertRowid) as AlertRow;
  }

  remove(userId: string, alertId: number): AlertRow {
    const row = this.db.prepare('SELECT * FROM price_alerts WHERE id = ? AND user_id = ?').get(alertId, userId) as
      | AlertRow
      | undefined;
    if (!row) throw new ValidationError(`Alert #${alertId} was not found.`);
    this.db.prepare("UPDATE price_alerts SET status = 'deleted' WHERE id = ?").run(alertId);
    return { ...row, status: 'deleted' };
  }

  list(userId: string): AlertRow[] {
    return this.db
      .prepare("SELECT * FROM price_alerts WHERE user_id = ? AND status IN ('active','triggered') ORDER BY id DESC")
      .all(userId) as AlertRow[];
  }

  /** Called by the scheduler. Returns alerts that just crossed their target. */
  async check(): Promise<{ alert: AlertRow; price: number }[]> {
    const rows = this.db.prepare("SELECT * FROM price_alerts WHERE status = 'active'").all() as AlertRow[];
    if (rows.length === 0) return [];
    let snapshot;
    try {
      snapshot = await this.prices.snapshot();
    } catch {
      return [];
    }
    const triggered: { alert: AlertRow; price: number }[] = [];
    for (const row of rows) {
      const price = snapshot.prices[row.asset as AssetSymbol];
      if (!price) continue;
      const hit = row.direction === 'above' ? price >= row.target_usd : price <= row.target_usd;
      this.db.prepare('UPDATE price_alerts SET last_price = ? WHERE id = ?').run(price, row.id);
      if (hit) {
        this.db
          .prepare("UPDATE price_alerts SET status = 'triggered', triggered_at = ? WHERE id = ?")
          .run(Date.now(), row.id);
        triggered.push({ alert: { ...row, status: 'triggered', triggered_at: Date.now() }, price });
      }
    }
    return triggered;
  }

  describe(alert: AlertRow): string {
    const asset = alert.asset as AssetSymbol;
    return `#${alert.id} · ${assetTicker(asset)} ${alert.direction} $${alert.target_usd.toLocaleString('en-US')}`;
  }
}
