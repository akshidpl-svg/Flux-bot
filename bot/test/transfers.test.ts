import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError, ValidationError } from '../src/core/errors.ts';
import {
  createTestEnv,
  fund,
  interactionId,
  SERVER_ID,
  USER_A,
  USER_B,
  USER_C,
  USER_D,
} from './helpers.ts';

describe('tips and sends', () => {
  it('debits amount + fee and credits the recipient', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const receipt = await env.services.transfers.send({
      kind: 'tip',
      fromUserId: USER_A,
      toUserIds: [USER_B],
      asset: 'USDT_TRC20',
      grossBase: 200_000n,
      note: 'thanks',
      serverId: SERVER_ID,
      interactionId: interactionId(),
    });

    assert.equal(receipt.grossBase, 200_000n);
    assert.equal(receipt.feeBase, 50_000n);
    assert.equal(receipt.netBase, 200_000n);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 700_000n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 200_000n);

    const fee = env.db.prepare("SELECT * FROM fees WHERE ref_type = 'transfer'").get() as {
      amount: string;
      status: string;
    };
    assert.equal(fee.amount, '50000');
    assert.equal(fee.status, 'completed');
    assert.equal(env.services.ledger.verifyIntegrity().ok, true);
    env.close();
  });

  it('is idempotent for a retried interaction', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const id = interactionId();
    const first = await env.services.transfers.send({
      kind: 'send',
      fromUserId: USER_A,
      toUserIds: [USER_B],
      asset: 'USDT_TRC20',
      grossBase: 100_000n,
      interactionId: id,
    });
    const second = await env.services.transfers.send({
      kind: 'send',
      fromUserId: USER_A,
      toUserIds: [USER_B],
      asset: 'USDT_TRC20',
      grossBase: 100_000n,
      interactionId: id,
    });
    assert.equal(second.groupId, first.groupId);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 800_000n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 100_000n);
    env.close();
  });

  it('takes the fee from the amount when the balance cannot cover both', async () => {
    const env = createTestEnv();
    // Deposit 0.25 -> 0.20 spendable after the deposit fee.
    await fund(env, USER_A, 'USDT_TRC20', '0.25');
    const receipt = await env.services.transfers.send({
      kind: 'tip',
      fromUserId: USER_A,
      toUserIds: [USER_B],
      asset: 'USDT_TRC20',
      grossBase: 200_000n,
      interactionId: interactionId(),
    });
    assert.equal(receipt.netBase, 150_000n);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 0n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 150_000n);
    env.close();
  });

  it('rejects self tips, bots are filtered by the command layer, and unaffordable tips', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    await assert.rejects(
      env.services.transfers.send({
        kind: 'tip',
        fromUserId: USER_A,
        toUserIds: [USER_A],
        asset: 'USDT_TRC20',
        grossBase: 100_000n,
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    await assert.rejects(
      env.services.transfers.send({
        kind: 'tip',
        fromUserId: USER_A,
        toUserIds: [USER_B],
        asset: 'USDT_TRC20',
        grossBase: 5_000_000n,
        interactionId: interactionId(),
      }),
      AppError,
    );
    env.close();
  });

  it('charges one fee for a split and divides the net equally', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const receipt = await env.services.transfers.send({
      kind: 'split',
      fromUserId: USER_A,
      toUserIds: [USER_B, USER_C, USER_D],
      asset: 'USDT_TRC20',
      grossBase: 300_000n,
      serverId: SERVER_ID,
      interactionId: interactionId(),
    });
    assert.equal(receipt.recipients.length, 3);
    assert.equal(receipt.feeBase, 50_000n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 100_000n);
    assert.equal(env.services.ledger.balance(USER_C, 'USDT_TRC20'), 100_000n);
    assert.equal(env.services.ledger.balance(USER_D, 'USDT_TRC20'), 100_000n);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 600_000n);
    const feeCount = env.db.prepare("SELECT COUNT(*) AS n FROM fees WHERE ref_type = 'transfer'").get() as { n: number };
    assert.equal(feeCount.n, 1);
    env.close();
  });
});

describe('rain', () => {
  it('splits between active users in the server with a single fee', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    for (const user of [USER_B, USER_C, USER_D]) {
      env.services.users.ensure(user);
      env.services.servers.recordActivity(SERVER_ID, user, 'wallet');
    }
    const result = await env.services.transfers.rain({
      hostUserId: USER_A,
      serverId: SERVER_ID,
      channelId: 'channel-1',
      asset: 'USDT_TRC20',
      totalBase: 300_000n,
      count: 3,
      interactionId: interactionId(),
    });

    assert.equal(result.recipients.length, 3);
    assert.equal(result.feeBase, 50_000n);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 600_000n);
    for (const user of [USER_B, USER_C, USER_D]) {
      assert.equal(env.services.ledger.balance(user, 'USDT_TRC20'), 100_000n);
    }
    const fees = env.db.prepare("SELECT COUNT(*) AS n FROM fees WHERE ref_type = 'rain'").get() as { n: number };
    assert.equal(fees.n, 1);
    env.close();
  });

  it('is idempotent and never exceeds available funds', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    env.services.users.ensure(USER_B);
    env.services.servers.recordActivity(SERVER_ID, USER_B, 'wallet');
    const id = interactionId();

    const first = await env.services.transfers.rain({
      hostUserId: USER_A,
      serverId: SERVER_ID,
      channelId: null,
      asset: 'USDT_TRC20',
      totalBase: 400_000n,
      count: 1,
      interactionId: id,
    });
    const balanceAfter = env.services.ledger.balance(USER_A, 'USDT_TRC20');
    const replay = await env.services.transfers.rain({
      hostUserId: USER_A,
      serverId: SERVER_ID,
      channelId: null,
      asset: 'USDT_TRC20',
      totalBase: 400_000n,
      count: 1,
      interactionId: id,
    });
    assert.equal(replay.rainId, first.rainId);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), balanceAfter);

    await assert.rejects(
      env.services.transfers.rain({
        hostUserId: USER_A,
        serverId: SERVER_ID,
        channelId: null,
        asset: 'USDT_TRC20',
        totalBase: 99_000_000n,
        count: 1,
        interactionId: interactionId(),
      }),
      AppError,
    );
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), balanceAfter);
    env.close();
  });

  it('refuses to rain when the server has no eligible participants', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    await assert.rejects(
      env.services.transfers.rain({
        hostUserId: USER_A,
        serverId: SERVER_ID,
        channelId: null,
        asset: 'USDT_TRC20',
        totalBase: 100_000n,
        count: 3,
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    env.close();
  });
});

describe('payment requests', () => {
  it('can only be paid once and notifies through the ledger', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const request = env.services.requests.create({
      requesterId: USER_B,
      payerId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 200_000n,
      note: 'lunch',
      interactionId: interactionId(),
    });
    assert.equal(request.status, 'open');

    const receipt = await env.services.requests.pay({
      requestId: request.id,
      payerId: USER_A,
      interactionId: interactionId(),
    });
    assert.equal(receipt.netBase, 200_000n);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 700_000n);
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 200_000n);

    await assert.rejects(
      env.services.requests.pay({
        requestId: request.id,
        payerId: USER_A,
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    assert.equal(env.services.ledger.balance(USER_B, 'USDT_TRC20'), 200_000n);
    env.close();
  });

  it('only lets the payer pay and the requester cancel', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const request = env.services.requests.create({
      requesterId: USER_B,
      payerId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 100_000n,
      interactionId: interactionId(),
    });
    await assert.rejects(
      env.services.requests.pay({ requestId: request.id, payerId: USER_C, interactionId: interactionId() }),
      ValidationError,
    );
    assert.throws(() => env.services.requests.cancel(request.id, USER_C), ValidationError);
    const cancelled = env.services.requests.cancel(request.id, USER_B);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(
      env.services.requests.pay({ requestId: request.id, payerId: USER_A, interactionId: interactionId() }),
      ValidationError,
    );
    env.close();
  });

  it('expires stale requests', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '1');
    const request = env.services.requests.create({
      requesterId: USER_B,
      payerId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 100_000n,
      expiresInHours: 1,
      interactionId: interactionId(),
    });
    env.db.prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, request.id);
    assert.equal(env.services.requests.expireStale(), 1);
    await assert.rejects(
      env.services.requests.pay({ requestId: request.id, payerId: USER_A, interactionId: interactionId() }),
      ValidationError,
    );
    env.close();
  });
});
