import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AssetSymbol } from '../src/core/assets.ts';
import { AppError, ValidationError } from '../src/core/errors.ts';
import { ProviderError } from '../src/core/errors.ts';
import { SimulatedProvider } from '../src/providers/simulated.ts';
import type {
  Provider,
  ProviderCurrencyInfo,
  ProviderDeposit,
  ProviderPayoutStatus,
  ProviderPriceSnapshot,
} from '../src/providers/types.ts';
import { createTestEnv, fund, interactionId, testConfig, USER_A } from './helpers.ts';

const TRON_ADDRESS = 'TRrqEHua7YXsv7HYaDp1chAP6ErPMhR18e';
const BTC_ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

class FlakyProvider implements Provider {
  readonly name = 'flaky-live';
  readonly isSimulated = false;
  failPayout = false;

  private readonly inner: SimulatedProvider;

  constructor(inner: SimulatedProvider) {
    this.inner = inner;
  }

  getCurrencies(): Promise<ProviderCurrencyInfo[]> {
    return this.inner.getCurrencies();
  }
  getPrices(): Promise<ProviderPriceSnapshot> {
    return this.inner.getPrices();
  }
  getOrCreateAddress(input: { userId: string; asset: AssetSymbol; description?: string }) {
    return this.inner.getOrCreateAddress(input);
  }
  listDeposits(input: { sinceSeconds: number; limit?: number }): Promise<ProviderDeposit[]> {
    return this.inner.listDeposits(input);
  }
  async createPayout(input: { asset: AssetSymbol; address: string; amount: string; idempotencyKey: string }) {
    if (this.failPayout) {
      throw new ProviderError('The payment provider timed out. The payout may still be submitted.', { retryable: true });
    }
    return this.inner.createPayout(input);
  }
  getPayout(trackId: string): Promise<ProviderPayoutStatus> {
    return this.inner.getPayout(trackId);
  }
  getBalances(): Promise<Record<string, string>> {
    return this.inner.getBalances();
  }
  healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return this.inner.healthCheck();
  }
}

describe('withdrawal validation', () => {
  it('rejects invalid, burn and mismatched destinations', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    const quote = await env.services.withdrawals.quote(USER_A, 'USDT_TRC20', 2_000_000n);
    assert.equal(quote.netBase, 1_950_000n);
    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'USDT_TRC20',
        amountBase: 2_000_000n,
        address: 'not-an-address',
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    const rows = env.db.prepare('SELECT COUNT(*) AS n FROM withdrawals').get() as { n: number };
    assert.equal(rows.n, 0, 'invalid destinations never create a withdrawal row');

    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'ETH',
        amountBase: 1_000_000n,
        address: '0x0000000000000000000000000000000000000000',
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    env.close();
  });

  it('rejects withdrawals below the notional minimum and above the maximum', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    await assert.rejects(
      env.services.withdrawals.quote(USER_A, 'USDT_TRC20', 500_000n),
      (error: unknown) => error instanceof ValidationError && /Minimum withdrawal/.test(error.userMessage),
    );
    await assert.rejects(
      env.services.withdrawals.quote(USER_A, 'USDT_TRC20', 2_000_000_000n),
      (error: unknown) => error instanceof ValidationError && /Maximum withdrawal/.test(error.userMessage),
    );
    env.close();
  });

  it('refuses when the balance cannot cover the withdrawal', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'USDT_TRC20',
        amountBase: 10_000_000n,
        address: TRON_ADDRESS,
        interactionId: interactionId(),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'insufficient_funds',
    );
    env.close();
  });

  it('keeps live withdrawals disabled until explicitly enabled', async () => {
    const config = { ...testConfig(), withdrawalsLive: false };
    const inner = new SimulatedProvider();
    const env = createTestEnv({ config, provider: new FlakyProvider(inner) });
    await fund(env, USER_A, 'USDT_TRC20', '3');
    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'USDT_TRC20',
        amountBase: 2_000_000n,
        address: TRON_ADDRESS,
        interactionId: interactionId(),
      }),
      (error: unknown) => error instanceof AppError && error.code === 'withdrawals_disabled',
    );
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 2_950_000n, 'nothing was debited');
    env.close();
  });
});

describe('withdrawal lifecycle', () => {
  it('debits immediately, is idempotent per interaction and confirms only when the provider does', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    const id = interactionId();
    const first = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 2_000_000n,
      address: TRON_ADDRESS,
      interactionId: id,
    });
    assert.equal(first.status, 'confirming');
    assert.ok(first.provider_track_id);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);

    const replay = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 2_000_000n,
      address: TRON_ADDRESS,
      interactionId: id,
    });
    assert.equal(replay.id, first.id);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);

    const sync = await env.services.withdrawals.syncPending();
    assert.equal(sync.confirmed, 1);
    const confirmed = env.services.withdrawals.getForUser(USER_A, first.id);
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.provider_tx_hash);
    const fee = env.db.prepare("SELECT status FROM fees WHERE ref_type = 'withdrawal'").get() as { status: string };
    assert.equal(fee.status, 'completed');
    env.close();
  });

  it('refunds the full amount and voids the fee when a payout fails', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'USDT_TRC20', '3');
    const row = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 2_000_000n,
      address: TRON_ADDRESS,
      interactionId: interactionId(),
    });
    env.simulated.setPayoutStatus(row.provider_track_id as string, 'Failed', 'broadcast_timeout');
    const sync = await env.services.withdrawals.syncPending();
    assert.equal(sync.failed, 1);

    const failed = env.services.withdrawals.getForUser(USER_A, row.id);
    assert.equal(failed.status, 'failed');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 2_950_000n, 'amount plus fee returned');
    const fee = env.db.prepare("SELECT status FROM fees WHERE ref_type = 'withdrawal'").get() as { status: string };
    assert.equal(fee.status, 'voided');
    assert.equal(env.services.ledger.verifyIntegrity().ok, true);
    env.close();
  });

  it('keeps a timed-out submission pending, then retries without double-debiting', async () => {
    const config = { ...testConfig(), withdrawalsLive: true };
    const inner = new SimulatedProvider({ confirmAfterMs: 0 });
    const provider = new FlakyProvider(inner);
    provider.failPayout = true;
    const env = createTestEnv({ config, provider });
    await fund(env, USER_A, 'USDT_TRC20', '3');

    const row = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 2_000_000n,
      address: TRON_ADDRESS,
      interactionId: interactionId(),
    });
    assert.equal(row.status, 'pending', 'provider timeout leaves the payout retryable');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);
    const withdrawals = env.db.prepare('SELECT COUNT(*) AS n FROM withdrawals').get() as { n: number };
    assert.equal(withdrawals.n, 1);

    provider.failPayout = false;
    assert.equal(await env.services.withdrawals.retryPending(), 1);
    const retried = env.services.withdrawals.getForUser(USER_A, row.id);
    assert.equal(retried.status, 'confirming');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n, 'no second debit');

    await env.services.withdrawals.syncPending();
    assert.equal(env.services.withdrawals.getForUser(USER_A, row.id).status, 'confirmed');
    env.close();
  });

  it('accepts a valid BTC address and enforces provider minimum payout', async () => {
    const env = createTestEnv();
    await fund(env, USER_A, 'BTC', '0.02');
    // 0.01 BTC at the simulated $60k price is $600, inside the $1-$1000 window.
    const row = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'BTC',
      amountBase: 1_000_000n,
      address: BTC_ADDRESS,
      interactionId: interactionId(),
    });
    assert.equal(row.net, '999916', 'fee is 84 satoshis at $60k/BTC');
    await assert.rejects(
      env.services.withdrawals.create({
        userId: USER_A,
        asset: 'BTC',
        amountBase: 1_000_000n,
        address: TRON_ADDRESS,
        interactionId: interactionId(),
      }),
      ValidationError,
    );
    env.close();
  });
});
