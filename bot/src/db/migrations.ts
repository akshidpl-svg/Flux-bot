/**
 * Versioned migrations. Append new entries; never edit an applied migration.
 * `migrate()` runs each version once inside a transaction and records it.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_ledger',
    sql: `
      CREATE TABLE users (
        user_id           TEXT PRIMARY KEY,
        display_currency  TEXT NOT NULL DEFAULT 'USD',
        notify_deposits   INTEGER NOT NULL DEFAULT 1,
        notify_withdrawals INTEGER NOT NULL DEFAULT 1,
        notify_tips       INTEGER NOT NULL DEFAULT 1,
        notify_prices     INTEGER NOT NULL DEFAULT 0,
        notify_receipts   INTEGER NOT NULL DEFAULT 1,
        allow_dm          INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE wallets (
        user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset      TEXT NOT NULL,
        network    TEXT NOT NULL,
        available  TEXT NOT NULL DEFAULT '0',
        locked     TEXT NOT NULL DEFAULT '0',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, asset, network)
      );
      CREATE INDEX idx_wallets_asset ON wallets(asset, network);

      CREATE TABLE ledger_entries (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset          TEXT NOT NULL,
        network        TEXT NOT NULL,
        delta          TEXT NOT NULL,
        balance_after  TEXT NOT NULL,
        entry_type     TEXT NOT NULL,
        ref_type       TEXT,
        ref_id         TEXT,
        memo           TEXT,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_ledger_user ON ledger_entries(user_id, id DESC);
      CREATE INDEX idx_ledger_ref ON ledger_entries(ref_type, ref_id);

      CREATE TABLE deposit_addresses (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset             TEXT NOT NULL,
        network           TEXT NOT NULL,
        address           TEXT NOT NULL,
        provider          TEXT NOT NULL,
        provider_track_id TEXT,
        created_at        INTEGER NOT NULL,
        UNIQUE (user_id, asset, network, provider),
        UNIQUE (provider, address)
      );

      CREATE TABLE deposits (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id                TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset                  TEXT NOT NULL,
        network                TEXT NOT NULL,
        tx_hash                TEXT NOT NULL,
        address                TEXT,
        provider_track_id      TEXT,
        amount                 TEXT NOT NULL,
        fee                    TEXT NOT NULL DEFAULT '0',
        net                    TEXT NOT NULL DEFAULT '0',
        usd_price              REAL,
        rate_timestamp         INTEGER,
        rate_source            TEXT,
        confirmations          INTEGER NOT NULL DEFAULT 0,
        required_confirmations INTEGER NOT NULL DEFAULT 0,
        status                 TEXT NOT NULL,
        failure_reason         TEXT,
        raw                    TEXT,
        created_at             INTEGER NOT NULL,
        credited_at            INTEGER,
        UNIQUE (tx_hash)
      );
      CREATE INDEX idx_deposits_user ON deposits(user_id, id DESC);
      CREATE INDEX idx_deposits_status ON deposits(status);

      CREATE TABLE withdrawals (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id            TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset              TEXT NOT NULL,
        network            TEXT NOT NULL,
        address            TEXT NOT NULL,
        amount             TEXT NOT NULL,
        fee                TEXT NOT NULL,
        net                TEXT NOT NULL,
        provider_fee       TEXT,
        status             TEXT NOT NULL,
        provider_track_id  TEXT,
        provider_tx_hash   TEXT,
        idempotency_key    TEXT NOT NULL UNIQUE,
        failure_reason     TEXT,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        completed_at       INTEGER
      );
      CREATE INDEX idx_withdrawals_user ON withdrawals(user_id, id DESC);
      CREATE INDEX idx_withdrawals_status ON withdrawals(status);
      CREATE INDEX idx_withdrawals_track ON withdrawals(provider_track_id);

      CREATE TABLE transfers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id      TEXT NOT NULL,
        kind          TEXT NOT NULL,
        from_user_id  TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        to_user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset         TEXT NOT NULL,
        network       TEXT NOT NULL,
        amount        TEXT NOT NULL,
        net           TEXT NOT NULL,
        note          TEXT,
        status        TEXT NOT NULL,
        server_id     TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_transfers_from ON transfers(from_user_id, id DESC);
      CREATE INDEX idx_transfers_to ON transfers(to_user_id, id DESC);
      CREATE INDEX idx_transfers_group ON transfers(group_id);
      CREATE INDEX idx_transfers_server ON transfers(server_id, id DESC);

      CREATE TABLE rains (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id        TEXT NOT NULL,
        channel_id       TEXT,
        host_user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset            TEXT NOT NULL,
        network          TEXT NOT NULL,
        total            TEXT NOT NULL,
        fee              TEXT NOT NULL,
        per_recipient    TEXT NOT NULL,
        recipient_count  INTEGER NOT NULL,
        status           TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_rains_host ON rains(host_user_id, id DESC);
      CREATE INDEX idx_rains_server ON rains(server_id, id DESC);

      CREATE TABLE rain_recipients (
        rain_id    INTEGER NOT NULL REFERENCES rains(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        amount     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (rain_id, user_id)
      );

      CREATE TABLE payment_requests (
        id               TEXT PRIMARY KEY,
        requester_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        payer_id         TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset            TEXT NOT NULL,
        network          TEXT NOT NULL,
        amount           TEXT NOT NULL,
        note             TEXT,
        status           TEXT NOT NULL,
        group_id         TEXT,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        paid_at          INTEGER
      );
      CREATE INDEX idx_requests_payer ON payment_requests(payer_id, status);

      CREATE TABLE fees (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_type      TEXT NOT NULL,
        ref_id        TEXT NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset         TEXT NOT NULL,
        network       TEXT NOT NULL,
        amount        TEXT NOT NULL,
        usd_amount    REAL NOT NULL,
        usd_price     REAL NOT NULL,
        rate_timestamp INTEGER NOT NULL,
        rate_source   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'completed',
        created_at    INTEGER NOT NULL,
        UNIQUE (ref_type, ref_id)
      );
      CREATE INDEX idx_fees_user ON fees(user_id, id DESC);
      CREATE INDEX idx_fees_created ON fees(created_at);

      CREATE TABLE price_alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        asset         TEXT NOT NULL,
        direction     TEXT NOT NULL,
        target_usd    REAL NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    INTEGER NOT NULL,
        triggered_at  INTEGER,
        last_price    REAL
      );
      CREATE INDEX idx_alerts_user ON price_alerts(user_id, status);
      CREATE INDEX idx_alerts_active ON price_alerts(status);

      CREATE TABLE server_settings (
        server_id                TEXT PRIMARY KEY,
        disabled                 INTEGER NOT NULL DEFAULT 0,
        tips_enabled             INTEGER NOT NULL DEFAULT 1,
        rain_enabled             INTEGER NOT NULL DEFAULT 1,
        notifications_channel_id TEXT,
        notify_tips_channel      INTEGER NOT NULL DEFAULT 0,
        updated_at               INTEGER NOT NULL
      );

      CREATE TABLE server_activity (
        server_id    TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        commands     INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, user_id)
      );
      CREATE INDEX idx_server_activity_recent ON server_activity(server_id, last_used_at DESC);

      CREATE TABLE admin_audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id   TEXT NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT,
        details    TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_audit_created ON admin_audit(created_at DESC);

      CREATE TABLE webhook_events (
        event_id     TEXT PRIMARY KEY,
        event_type   TEXT,
        payload      TEXT NOT NULL,
        received_at  INTEGER NOT NULL,
        processed_at INTEGER,
        status       TEXT NOT NULL,
        error        TEXT
      );

      CREATE TABLE idempotency_keys (
        key        TEXT PRIMARY KEY,
        user_id    TEXT,
        scope      TEXT NOT NULL,
        result     TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );

      CREATE TABLE system_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE command_usage (
        command      TEXT PRIMARY KEY,
        uses         INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'indexes_and_constraints',
    sql: `
      CREATE INDEX idx_payment_requests_status ON payment_requests(status, expires_at);
      CREATE INDEX idx_deposit_addresses_user ON deposit_addresses(user_id);
      CREATE INDEX idx_ledger_created ON ledger_entries(created_at);
      CREATE INDEX idx_users_currency ON users(display_currency);
    `,
  },
];
