import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestEnv, fund, USER_A } from './helpers.ts';

describe('deposit crediting', () => {
  it('credits the verified amount minus the $0.05 fee and records the rate', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const deposit = env.provider.simulateDeposit({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amount: '25',
      address: address.address,
    });

    const result = await env.services.deposits.processProviderDeposit(deposit);
    assert.equal(result.outcome, 'credited');

    const row = env.services.deposits.byTxHash(deposit.txHash);
    assert.ok(row);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.amount, '25000000');
    assert.equal(row.fee, '50000');
    assert.equal(row.net, '24950000');
    assert.equal(row.usd_price, 1);
    assert.ok(row.rate_timestamp);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 24_950_000n);

    const fee = env.db.prepare("SELECT * FROM fees WHERE ref_type = 'deposit'").get() as { amount: string; status: string };
    assert.equal(fee.amount, '50000');
    assert.equal(fee.status, 'completed');
    env.close();
  });

  it('is idempotent per transaction hash (no double credit, no duplicate fee)', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const deposit = env.provider.simulateDeposit({ userId: USER_A, asset: 'USDT_TRC20', amount: '10', address: address.address });

    assert.equal((await env.services.deposits.processProviderDeposit(deposit)).outcome, 'credited');
    assert.equal((await env.services.deposits.processProviderDeposit(deposit)).outcome, 'duplicate');
    assert.equal((await env.services.deposits.processProviderDeposit({ ...deposit, status: 'CREDITED' })).outcome, 'duplicate');

    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 9_950_000n);
    const fees = env.db.prepare("SELECT COUNT(*) AS n FROM fees WHERE ref_type = 'deposit'").get() as { n: number };
    assert.equal(fees.n, 1);
    env.close();
  });

  it('tracks pending and confirming deposits without crediting them', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'BTC');
    const pending = env.provider.simulateDeposit({
      userId: USER_A,
      asset: 'BTC',
      amount: '0.01',
      address: address.address,
      status: 'PENDING',
      confirmations: 0,
    });
    const result = await env.services.deposits.processProviderDeposit(pending);
    assert.equal(result.outcome, 'pending');
    assert.equal(env.services.ledger.balance(USER_A, 'BTC'), 0n);

    const confirmed = await env.services.deposits.processProviderDeposit({
      ...pending,
      status: 'CREDITED',
      credited: true,
      confirmations: 2,
    });
    assert.equal(confirmed.outcome, 'credited');
    assert.equal(env.services.deposits.byTxHash(pending.txHash)?.status, 'confirmed');
    assert.ok(env.services.ledger.balance(USER_A, 'BTC') > 0n);
    env.close();
  });

  it('rejects dust below the application fee without crediting it', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const dust = env.provider.simulateDeposit({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amount: '0.01',
      address: address.address,
    });
    const result = await env.services.deposits.processProviderDeposit(dust);
    assert.equal(result.outcome, 'rejected');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 0n);
    const row = env.services.deposits.byTxHash(dust.txHash);
    assert.equal(row?.status, 'rejected');
    assert.equal(row?.failure_reason, 'below_app_fee');
    env.close();
  });

  it('ignores a deposit sent to an address FluxTip does not own', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const result = await env.services.deposits.processProviderDeposit({
      txHash: 'unknown-tx-1',
      coin: 'USDT_TRC20',
      network: 'tron',
      amount: '100',
      confirmations: 20,
      requiredConfirmations: 19,
      status: 'CREDITED',
      credited: true,
      address: 'TSomeoneElsesAddress1111111111111111',
      trackId: null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    assert.equal(result.outcome, 'ignored');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 0n);
    env.close();
  });

  it('credits from a payment webhook payload exactly once', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const payload = {
      type: 'payment',
      status: 'Paid',
      currency: 'USDT_TRC20',
      address: address.address,
      track_id: 'track-1',
      transactions: [{ tx_hash: 'webhook-tx-1', coin: 'USDT_TRC20', amount: '50', confirmations: 21, status: 'CREDITED' }],
    };
    const results = await env.services.deposits.handlePaymentWebhook(payload);
    assert.deepEqual(results.map((result) => result.outcome), ['credited']);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 49_950_000n);

    const again = await env.services.deposits.handlePaymentWebhook(payload);
    assert.deepEqual(again.map((result) => result.outcome), ['duplicate']);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 49_950_000n);
    env.close();
  });

  it('poll backstop credits deposits that a webhook missed', async () => {
    const env = createTestEnv();
    await env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'SOL');
    env.provider.simulateDeposit({ userId: USER_A, asset: 'SOL', amount: '1', address: address.address });
    const result = await env.services.deposits.poll(Math.floor(Date.now() / 1000) - 60);
    assert.equal(result.credited, 1);
    assert.ok(env.services.ledger.balance(USER_A, 'SOL') > 0n);
    env.close();
  });

  it('labels simulated deposits as simulated data, never a real transaction', async () => {
    const env = createTestEnv();
    await env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'ETH');
    assert.ok(env.provider.isSimulated);
    assert.match(address.address, /^sim:/);
    await fund(env, USER_A, 'ETH', '0.5');
    const row = env.services.deposits.history(USER_A)[0];
    assert.match(row?.raw ?? '', /simtx_deposit/);
    env.close();
  });
});

describe('open deposit refresh', () => {
  it('credits a pending deposit once the provider confirms it, exactly once', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const deposit = env.simulated.simulateDeposit({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amount: '20',
      address: address.address,
      status: 'PENDING',
      confirmations: 0,
    });
    assert.equal((await env.services.deposits.processProviderDeposit(deposit)).outcome, 'pending');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 0n);

    env.simulated.setDepositStatus(deposit.txHash, 'CREDITED', 20);
    const refreshed = await env.services.deposits.refreshOpen();
    assert.deepEqual(refreshed.credited, [deposit.txHash]);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 19_950_000n);

    const again = await env.services.deposits.refreshOpen();
    assert.deepEqual(again.credited, []);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 19_950_000n);
    env.close();
  });
});
