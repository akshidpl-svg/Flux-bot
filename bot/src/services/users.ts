import { DEFAULT_FIAT, isFiatCode, type FiatCode } from '../core/fiat.ts';
import type { DB } from '../db/index.ts';

export interface UserRow {
  user_id: string;
  display_currency: string;
  notify_deposits: number;
  notify_withdrawals: number;
  notify_tips: number;
  notify_prices: number;
  notify_receipts: number;
  allow_dm: number;
  created_at: number;
  updated_at: number;
}

export type NotificationKey = 'deposits' | 'withdrawals' | 'tips' | 'prices' | 'receipts' | 'dm';

const NOTIFICATION_COLUMNS: Record<NotificationKey, keyof UserRow> = {
  deposits: 'notify_deposits',
  withdrawals: 'notify_withdrawals',
  tips: 'notify_tips',
  prices: 'notify_prices',
  receipts: 'notify_receipts',
  dm: 'allow_dm',
};

export interface NotificationSettings {
  deposits: boolean;
  withdrawals: boolean;
  tips: boolean;
  prices: boolean;
  receipts: boolean;
  dm: boolean;
}

export class UsersService {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  ensure(userId: string): UserRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (user_id, display_currency, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
      )
      .run(userId, DEFAULT_FIAT, now, now);
    return this.get(userId);
  }

  get(userId: string): UserRow {
    const row = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | undefined;
    if (!row) throw new Error(`user ${userId} not found`);
    return row;
  }

  find(userId: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | undefined) ?? null;
  }

  currency(userId: string): FiatCode {
    const code = this.ensure(userId).display_currency;
    return isFiatCode(code) ? code : DEFAULT_FIAT;
  }

  setCurrency(userId: string, code: string): FiatCode {
    if (!isFiatCode(code)) throw new Error(`unsupported currency ${code}`);
    this.ensure(userId);
    this.db.prepare('UPDATE users SET display_currency = ?, updated_at = ? WHERE user_id = ?').run(code, Date.now(), userId);
    return code;
  }

  notifications(userId: string): NotificationSettings {
    const row = this.ensure(userId);
    return {
      deposits: row.notify_deposits === 1,
      withdrawals: row.notify_withdrawals === 1,
      tips: row.notify_tips === 1,
      prices: row.notify_prices === 1,
      receipts: row.notify_receipts === 1,
      dm: row.allow_dm === 1,
    };
  }

  toggleNotification(userId: string, key: NotificationKey, explicit?: boolean): boolean {
    const row = this.ensure(userId);
    const column = NOTIFICATION_COLUMNS[key];
    const current = row[column] === 1;
    const next = explicit ?? !current;
    this.db.prepare(`UPDATE users SET ${column} = ?, updated_at = ? WHERE user_id = ?`).run(next ? 1 : 0, Date.now(), userId);
    return next;
  }

  setNotifications(userId: string, patch: Partial<NotificationSettings>): NotificationSettings {
    for (const [key, value] of Object.entries(patch) as [NotificationKey, boolean | undefined][]) {
      if (value === undefined) continue;
      this.toggleNotification(userId, key, value);
    }
    return this.notifications(userId);
  }

  /** Wipes every FluxTip record for a user (privacy command); balances must be zero first. */
  deleteUserData(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  }
}
