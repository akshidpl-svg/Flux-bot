import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate, openDatabase, transaction } from '../src/db/index.ts';
import { createTestEnv, fund, interactionId, OTHER_SERVER_ID, SERVER_ID, USER_A, USER_B } from './helpers.ts';

describe('database migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const db = openDatabase(':memory:');
    const applied = migrate(db);
    assert.ok(applied >= 2);
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    assert.equal(version.v, 2);
    assert.equal(migrate(db), 0, 'second run must not reapply migrations');
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    assert.throws(() =>
      db
        .prepare("INSERT INTO wallets (user_id, asset, network, available, locked, updated_at) VALUES ('ghost', 'BTC', 'bitcoin', '0', '0', 0)")
        .run(),
    );
    db.close();
  });
});

describe('user preferences', () => {
  it('defaults to USD and persists a per-user display currency', async () => {
    const env = createTestEnv();
    assert.equal(env.services.users.currency(USER_A), 'USD');
    env.services.users.setCurrency(USER_A, 'EUR');
    assert.equal(env.services.users.currency(USER_A), 'EUR');
    assert.equal(env.services.users.currency(USER_B), 'USD', 'other users are unaffected');
    assert.throws(() => env.services.users.setCurrency(USER_A, 'XYZ'));
    env.close();
  });

  it('keeps notification preferences per user', async () => {
    const env = createTestEnv();
    assert.equal(env.services.users.notifications(USER_A).tips, true);
    env.services.users.toggleNotification(USER_A, 'tips', false);
    assert.equal(env.services.users.notifications(USER_A).tips, false);
    assert.equal(env.services.users.notifications(USER_B).tips, true);
    env.close();
  });

  it('isolates server settings by server ID', async () => {
    const env = createTestEnv();
    env.services.servers.update(SERVER_ID, { tipsEnabled: false, notificationsChannelId: '1234' });
    assert.equal(env.services.servers.get(SERVER_ID).tipsEnabled, false);
    assert.equal(env.services.servers.get(OTHER_SERVER_ID).tipsEnabled, true);
    assert.equal(env.services.servers.get(OTHER_SERVER_ID).notificationsChannelId, null);
    env.close();
  });
});

describe('ledger accounting', () => {
  it('credits deposits and keeps ledger == wallet balance', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '25');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 24_950_000n);
    const integrity = env.services.ledger.verifyIntegrity();
    assert.equal(integrity.ok, true, integrity.problems.join('\n'));
    env.close();
  });

  it('refuses to apply a negative balance', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    assert.throws(() =>
      transaction(env.db, () =>
        env.services.ledger.post({
          userId: USER_A,
          asset: 'USDT_TRC20',
          delta: -5_000_000n,
          type: 'test',
        }),
      ),
    );
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);
    env.close();
  });

  it('cannot be double-spent by concurrent transfers', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1'); // 0.95 after fee
    await env.services.users.ensure(USER_B);

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        env.services.transfers.send({
          kind: 'send',
          fromUserId: USER_A,
          toUserIds: [USER_B],
          asset: 'USDT_TRC20',
          grossBase: 200_000n, // 0.2 + 0.05 fee each
          interactionId: interactionId(),
        }),
      ),
    );
    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled').length;
    // 0.95 available: three transfers take 0.25 each, the fourth is fully covered
    // by the remaining 0.20 with the fee taken out of the amount; the fifth fails.
    assert.equal(succeeded, 4);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 0n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 750_000n);
    const integrity = env.services.ledger.verifyIntegrity();
    assert.equal(integrity.ok, true, integrity.problems.join('\n'));
    env.close();
  });
});
