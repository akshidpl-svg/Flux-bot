import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { migrate, openDatabase } from '../src/db/index.ts';
import { backupDatabase } from '../src/db/backup.ts';
import { ProviderError } from '../src/core/errors.ts';
import { SimulatedProvider } from '../src/providers/simulated.ts';
import type { Provider } from '../src/providers/types.ts';
import { createTestEnv, fund, tempDatabasePath, testConfig, USER_A } from './helpers.ts';

const TRON_ADDRESS = 'TRrqEHua7YXsv7HYaDp1chAP6ErPMhR18e';

/** Live-shaped provider whose payout submission always times out (retryable). */
class TimeoutProvider implements Provider {
  readonly name = 'timeout-live';
  readonly isSimulated = false;
  readonly inner: SimulatedProvider;

  constructor() {
    this.inner = new SimulatedProvider({ confirmAfterMs: 0 });
  }
  getCurrencies() {
    return this.inner.getCurrencies();
  }
  getPrices() {
    return this.inner.getPrices();
  }
  getOrCreateAddress(input: { userId: string; asset: 'USDT_TRC20'; description?: string }) {
    return this.inner.getOrCreateAddress(input);
  }
  listDeposits(input: { sinceSeconds: number; limit?: number }) {
    return this.inner.listDeposits(input);
  }
  async createPayout(): Promise<{ trackId: string; status: string }> {
    throw new ProviderError('provider timeout', { retryable: true });
  }
  getPayout(trackId: string) {
    return this.inner.getPayout(trackId);
  }
  getBalances() {
    return this.inner.getBalances();
  }
  healthCheck() {
    return this.inner.healthCheck();
  }
}

describe('restart recovery', () => {
  it('persists balances, pending payouts and applies migrations only once', async () => {
    const temp = tempDatabasePath();
    try {
      const db1 = openDatabase(temp.path);
      const config = { ...testConfig(), withdrawalsLive: true };
      const env1 = createTestEnv({ db: db1, config, provider: new TimeoutProvider() });
      await fund(env1, USER_A, 'USDT_TRC20', '3');
      const withdrawal = await env1.services.withdrawals.create({
        userId: USER_A,
        asset: 'USDT_TRC20',
        amountBase: 2_000_000n,
        address: TRON_ADDRESS,
        interactionId: 'restart-test-1',
      });
      assert.equal(withdrawal.status, 'pending');
      assert.equal(env1.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);
      env1.close();

      // Simulated crash/restart: new process, new handles, same file.
      const db2 = openDatabase(temp.path);
      assert.equal(migrate(db2), 0, 'migrations must not re-run on restart');
      const env2 = createTestEnv({ db: db2 });
      assert.equal(env2.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n, 'balance survived restart');
      assert.equal(env2.services.withdrawals.getForUser(USER_A, withdrawal.id).status, 'pending');

      // The retry uses the same provider idempotency key, so it can never double-pay.
      assert.equal(await env2.services.withdrawals.retryPending(), 1);
      assert.equal(env2.services.withdrawals.getForUser(USER_A, withdrawal.id).status, 'confirming');
      assert.equal(env2.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n, 'no second debit after restart');

      await env2.services.withdrawals.syncPending();
      assert.equal(env2.services.withdrawals.getForUser(USER_A, withdrawal.id).status, 'confirmed');
      assert.equal(env2.services.ledger.verifyIntegrity().ok, true);

      // Backup can be opened independently and contains the same ledger state.
      const backupDir = join(temp.path, '..', 'backups');
      const backupPath = backupDatabase(db2, backupDir, { keep: 2 });
      assert.ok(existsSync(backupPath));
      const restored = openDatabase(backupPath);
      const restoredBalance = restored
        .prepare("SELECT available FROM wallets WHERE user_id = ? AND asset = 'USDT_TRC20'")
        .get(USER_A) as { available: string };
      assert.equal(restoredBalance.available, '950000');
      restored.close();

      env2.close();
    } finally {
      temp.cleanup();
    }
  });

  it('does not lose a credited deposit when the process exits right after the write', async () => {
    const temp = tempDatabasePath();
    try {
      const db1 = openDatabase(temp.path);
      const env1 = createTestEnv({ db: db1 });
      await fund(env1, USER_A, 'USDT_TRC20', '5');
      env1.close();

      const db2 = openDatabase(temp.path);
      const env2 = createTestEnv({ db: db2 });
      assert.equal(env2.services.ledger.balance(USER_A, 'USDT_TRC20'), 4_950_000n);
      assert.equal(env2.services.ledger.verifyIntegrity().ok, true);
      env2.close();
    } finally {
      temp.cleanup();
    }
  });
});
