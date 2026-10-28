import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlertsService } from '../src/services/alerts.ts';
import { PriceService } from '../src/services/prices.ts';
import type { Provider } from '../src/providers/types.ts';
import { createTestEnv, USER_A, USER_B } from './helpers.ts';

describe('price alerts', () => {
  it('triggers an "above" alert only when the price actually crosses the target', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);

    const tooEarly = env.services.alerts.add(USER_A, 'BTC', 'above', 70_000);
    assert.equal((await env.services.alerts.check()).length, 0, 'BTC is $60,000, not $70,000 yet');
    assert.equal(env.services.alerts.list(USER_A)[0].status, 'active');

    // The simulated provider reports BTC at 60,000, so this target is crossed.
    const alert = env.services.alerts.add(USER_A, 'BTC', 'above', 50_000);
    const triggered = await env.services.alerts.check();
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].alert.id, alert.id);
    assert.equal(triggered[0].price, 60_000);

    // A triggered alert never fires twice, and the stale "too early" one survives.
    const again = await env.services.alerts.check();
    assert.equal(again.length, 0);
    const statuses = env.services.alerts.list(USER_A).map((row) => `${row.id}:${row.status}`);
    assert.ok(statuses.includes(`${alert.id}:triggered`));
    assert.ok(statuses.includes(`${tooEarly.id}:active`));
    env.close();
  });

  it('triggers a "below" alert and records the last observed price', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    env.services.alerts.add(USER_A, 'SOL', 'below', 100); // SOL is $150 in the simulated feed
    assert.equal((await env.services.alerts.check()).length, 0);
    assert.equal(env.services.alerts.list(USER_A)[0].last_price, 150);

    env.services.alerts.add(USER_A, 'SOL', 'below', 200);
    const triggered = await env.services.alerts.check();
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].price, 150);
    env.close();
  });

  it('keeps alerts per user, caps active alerts and respects ownership', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    env.services.users.ensure(USER_B);

    env.services.alerts.add(USER_A, 'BTC', 'above', 999_999);
    env.services.alerts.add(USER_B, 'ETH', 'above', 999_999);
    assert.equal(env.services.alerts.list(USER_A).length, 1);
    assert.equal(env.services.alerts.list(USER_B).length, 1);

    for (let index = 0; index < 9; index += 1) {
      env.services.alerts.add(USER_A, 'BTC', 'above', 1_000_000 + index);
    }
    assert.equal(env.services.alerts.list(USER_A).filter((row) => row.status === 'active').length, 10);
    assert.throws(
      () => env.services.alerts.add(USER_A, 'BTC', 'above', 5),
      /active price alerts/,
      'the per-user cap must be enforced',
    );

    const other = env.services.alerts.list(USER_B)[0];
    assert.throws(() => env.services.alerts.remove(USER_A, other.id), /not found/);
    env.services.alerts.remove(USER_B, other.id);
    assert.equal(env.services.alerts.list(USER_B).length, 0);
    env.close();
  });

  it('refuses to invent a state change when the price feed is unavailable', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    const alert = env.services.alerts.add(USER_A, 'BTC', 'above', 1);
    const down = new PriceService({
      name: 'broken',
      isSimulated: false,
      getPrices: async () => {
        throw new Error('price feed down');
      },
    } as unknown as Provider);
    const failing = new AlertsService(env.db, down);

    assert.deepEqual(await failing.check(), []);
    assert.equal(env.services.alerts.list(USER_A)[0].status, 'active', 'an outage must not fire or delete alerts');
    assert.equal(alert.status, 'active');
    env.close();
  });

  it('validates the target price', async () => {
    const env = createTestEnv();
    env.services.users.ensure(USER_A);
    for (const target of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => env.services.alerts.add(USER_A, 'BTC', 'above', target));
    }
    env.close();
  });
});