import { transaction, type DB } from '../db/index.ts';

export interface ServerSettingsRow {
  server_id: string;
  disabled: number;
  tips_enabled: number;
  rain_enabled: number;
  notifications_channel_id: string | null;
  notify_tips_channel: number;
  updated_at: number;
}

export interface ServerSettings {
  serverId: string;
  disabled: boolean;
  tipsEnabled: boolean;
  rainEnabled: boolean;
  notificationsChannelId: string | null;
  notifyTipsChannel: boolean;
  updatedAt: number;
}

function toSettings(row: ServerSettingsRow): ServerSettings {
  return {
    serverId: row.server_id,
    disabled: row.disabled === 1,
    tipsEnabled: row.tips_enabled === 1,
    rainEnabled: row.rain_enabled === 1,
    notificationsChannelId: row.notifications_channel_id,
    notifyTipsChannel: row.notify_tips_channel === 1,
    updatedAt: row.updated_at,
  };
}

/** Server settings are isolated by guild ID and never touch user wallets. */
export class ServersService {
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  get(serverId: string): ServerSettings {
    const row = this.ensure(serverId);
    return toSettings(row);
  }

  ensure(serverId: string): ServerSettingsRow {
    this.db
      .prepare('INSERT INTO server_settings (server_id, updated_at) VALUES (?, ?) ON CONFLICT(server_id) DO NOTHING')
      .run(serverId, Date.now());
    return this.db.prepare('SELECT * FROM server_settings WHERE server_id = ?').get(serverId) as ServerSettingsRow;
  }

  update(
    serverId: string,
    patch: Partial<Pick<ServerSettings, 'disabled' | 'tipsEnabled' | 'rainEnabled' | 'notificationsChannelId' | 'notifyTipsChannel'>>,
  ): ServerSettings {
    this.ensure(serverId);
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.disabled !== undefined) {
      fields.push('disabled = ?');
      values.push(patch.disabled ? 1 : 0);
    }
    if (patch.tipsEnabled !== undefined) {
      fields.push('tips_enabled = ?');
      values.push(patch.tipsEnabled ? 1 : 0);
    }
    if (patch.rainEnabled !== undefined) {
      fields.push('rain_enabled = ?');
      values.push(patch.rainEnabled ? 1 : 0);
    }
    if (patch.notificationsChannelId !== undefined) {
      fields.push('notifications_channel_id = ?');
      values.push(patch.notificationsChannelId);
    }
    if (patch.notifyTipsChannel !== undefined) {
      fields.push('notify_tips_channel = ?');
      values.push(patch.notifyTipsChannel ? 1 : 0);
    }
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(serverId);
    this.db.prepare(`UPDATE server_settings SET ${fields.join(', ')} WHERE server_id = ?`).run(...values);
    return this.get(serverId);
  }

  /** Records that a user used FluxTip in a server; powers /rain and server stats. */
  recordActivity(serverId: string, userId: string, command: string): void {
    transaction(this.db, () => {
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO server_activity (server_id, user_id, commands, last_used_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(server_id, user_id) DO UPDATE SET commands = commands + 1, last_used_at = excluded.last_used_at`,
        )
        .run(serverId, userId, now);
      this.db
        .prepare(
          `INSERT INTO command_usage (command, uses, last_used_at) VALUES (?, 1, ?)
           ON CONFLICT(command) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`,
        )
        .run(command, now);
    });
  }

  stats(serverId: string): { users: number; commands: number; tipsVolumeGroups: number } {
    const users = (
      this.db.prepare('SELECT COUNT(*) AS n FROM server_activity WHERE server_id = ?').get(serverId) as { n: number }
    ).n;
    const commands = (
      this.db.prepare('SELECT COALESCE(SUM(commands), 0) AS n FROM server_activity WHERE server_id = ?').get(serverId) as {
        n: number;
      }
    ).n;
    const tips = (
      this.db
        .prepare("SELECT COUNT(DISTINCT group_id) AS n FROM transfers WHERE server_id = ? AND kind = 'tip'")
        .get(serverId) as { n: number }
    ).n;
    return { users, commands, tipsVolumeGroups: tips };
  }

  activityUsers(serverId: string, days = 30): { userId: string; lastUsedAt: number }[] {
    const rows = this.db
      .prepare(
        'SELECT user_id, last_used_at FROM server_activity WHERE server_id = ? AND last_used_at >= ? ORDER BY last_used_at DESC',
      )
      .all(serverId, Date.now() - days * 86_400_000) as { user_id: string; last_used_at: number }[];
    return rows.map((row) => ({ userId: row.user_id, lastUsedAt: row.last_used_at }));
  }
}
