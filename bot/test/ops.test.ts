import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setPaused, isPaused } from '../src/db/index.ts';
import { AppError } from '../src/core/errors.ts';
import { notifyDeposit } from '../src/discord/notifier.ts';
import { startJobs } from '../src/jobs/index.ts';
import { createTestEnv, fund, interactionId, stubClient, USER_A, USER_B, SERVER_ID } from './helpers.ts';

describe('emergency pause', () => {
  it('blocks new transfers, requests and withdrawals while keeping history readable', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    const before = env.services.ledger.balance(USER_A, 'USDT_TRC20');
    assert.equal(isPaused(env.db), false);

    setPaused(env.db, true, USER_A);
    assert.equal(isPaused(env.db), true);

    await assert.rejects(
      env.services.transfers.send({
        kind: 'tip',
        fromUserId: USER_A,
        toUserIds: [USER_B],
        asset: 'USDT_TRC20',
        grossBase: 1_000_000n,
        serverId: SERVER_ID,
        interactionId: interactionId(),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'paused',
    );

    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'USDT_TRC20',
        amountBase: 1_000_000n,
        address: 'TScrjXYxr8kMVe3AVeGrM5xQv1oaeCnrqX',
        interactionId: interactionId(),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'paused',
    );

    // Nothing moved, and history stays available while paused.
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), before);
    assert.ok(env.services.ledger.history(USER_A).length > 0);
    assert.ok(env.services.deposits.history(USER_A).length > 0);

    setPaused(env.db, false, USER_A);
    assert.equal(isPaused(env.db), false);
    await env.services.transfers.send({
      kind: 'tip',
      fromUserId: USER_A,
      toUserIds: [USER_B],
      asset: 'USDT_TRC20',
      grossBase: 1_000_000n,
      serverId: SERVER_ID,
      interactionId: interactionId(),
    });
    assert.ok(env.services.ledger.balance(USER_B, 'USDT_TRC20') > 0n);
    env.close();
  });

  it('records who paused the system', () => {
    const env = createTestEnv();
    setPaused(env.db, true, USER_A);
    const row = env.db.prepare("SELECT * FROM admin_audit WHERE action = 'pause' ORDER BY id DESC").get() as
      | { actor_id: string }
      | undefined;
    assert.equal(row?.actor_id, USER_A);
    env.close();
  });
});

describe('notifications', () => {
  it('honours preferences and tolerates users who block DMs', async () => {
    const env = createTestEnv();
    const client = stubClient();
    await fund(env, USER_A, 'USDT_TRC20', '10');
    const txHash = env.services.deposits.history(USER_A)[0]?.tx_hash as string;
    assert.ok(txHash);

    // DMs are blocked in the stub client; delivery must never throw or affect state.
    env.services.users.toggleNotification(USER_A, 'deposits', false);
    assert.equal(env.services.users.notifications(USER_A).deposits, false);
    await notifyDeposit(client, env.services, txHash);

    env.services.users.toggleNotification(USER_A, 'deposits', true);
    await notifyDeposit(client, env.services, txHash); // throws inside, swallowed by the notifier

    // An unconfirmed deposit is never announced.
    env.services.users.toggleNotification(USER_A, 'deposits', true);
    await notifyDeposit(client, env.services, 'no-such-transaction');
    env.close();
  });
});

describe('scheduled jobs', () => {
  it('runs a full maintenance pass twice with no side effects on balances', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '5');
    const before = env.services.ledger.balance(USER_A, 'USDT_TRC20');

    const runner = startJobs({ services: env.services, client: stubClient() });
    try {
      await runner.runOnce();
      await runner.runOnce();
    } finally {
      runner.stop();
    }

    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), before, 'maintenance must never move funds');
    assert.equal(env.services.ledger.verifyIntegrity().ok, true);
    env.close();
  });
});