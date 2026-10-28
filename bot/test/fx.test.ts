import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIAT_CODES, type FiatCode } from '../src/core/fiat.ts';
import { FxService } from '../src/services/fx.ts';
import { createTestEnv } from './helpers.ts';

/** Representative rates from open.er-api.com: one USD buys this much of each currency. */
const RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  INR: 84.2,
  CAD: 1.37,
  AUD: 1.52,
  NZD: 1.68,
  CHF: 0.88,
  JPY: 151.4,
  SGD: 1.34,
  AED: 3.67,
  SAR: 3.75,
  TRY: 34.5,
  BRL: 5.42,
  PHP: 57.3,
  ZAR: 18.1,
};

function fxFetch(rates: Record<string, number>): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      result: 'success',
      rates: { ...rates },
      time_last_update_unix: 1_760_000_000,
    }),
  })) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error('FX provider unreachable');
  }) as unknown as typeof fetch;
}

describe('fiat conversion', () => {
  it('supports exactly the 16 documented display currencies', () => {
    assert.equal(FIAT_CODES.length, 16);
    assert.deepEqual(
      [...FIAT_CODES].sort(),
      ['AED', 'AUD', 'BRL', 'CAD', 'CHF', 'EUR', 'GBP', 'INR', 'JPY', 'NZD', 'PHP', 'SAR', 'SGD', 'TRY', 'USD', 'ZAR'].sort(),
    );
  });

  it('returns a verified rate for every supported code', async () => {
    const fx = new FxService({ fetchImpl: fxFetch(RATES) });
    for (const code of FIAT_CODES) {
      const rate = await fx.rateFor(code);
      assert.equal(typeof rate, 'number', `${code} has no rate`);
      assert.ok(rate !== null && Number.isFinite(rate) && rate > 0, `${code} rate is not usable: ${rate}`);
    }
    assert.equal(await fx.rateFor('USD'), 1);
  });

  it('converts between every ordered pair of currencies, using the same math as /converter', async () => {
    const fx = new FxService({ fetchImpl: fxFetch(RATES) });
    // Warm the cache the way a wallet summary would.
    await fx.quote('USD');
    const amount = 125.5;
    let pairs = 0;
    for (const from of FIAT_CODES) {
      const fromRate = await fx.rateFor(from);
      assert.ok(fromRate, `no rate for ${from}`);
      for (const to of FIAT_CODES) {
        const toRate = await fx.rateFor(to);
        assert.ok(toRate, `no rate for ${to}`);
        // /converter: fiat -> USD -> fiat
        const usd = amount / fromRate;
        const converted = usd * toRate;
        assert.ok(Number.isFinite(converted) && converted > 0, `${from}->${to} produced ${converted}`);
        // Round trip must return the original amount.
        const back = converted / toRate * fromRate;
        assert.ok(Math.abs(back - amount) <= amount * 1e-9, `${from}->${to} round trip drifted`);
        pairs += 1;
      }
    }
    assert.equal(pairs, 16 * 16);
  });

  it('produces the expected value for a known pair', async () => {
    const fx = new FxService({ fetchImpl: fxFetch(RATES) });
    const usdRate = await fx.rateFor('USD');
    const eurRate = await fx.rateFor('EUR');
    assert.ok(usdRate && eurRate);
    assert.equal(100 / usdRate * eurRate, 92);
    assert.equal(100 / eurRate * usdRate, 100 / 0.92);
  });

  it('never depends on the user display currency', async () => {
    const env = createTestEnv({ fetchImpl: fxFetch(RATES) });
    const read = async () => {
      const out: Record<string, number | null> = {};
      for (const code of FIAT_CODES) out[code] = await env.services.fx.rateFor(code);
      return out;
    };

    env.services.users.ensure('111111111111111111');
    env.services.users.setCurrency('111111111111111111', 'JPY');
    const withJpy = await read();

    env.services.users.setCurrency('111111111111111111', 'BRL');
    const withBrl = await read();

    env.services.users.setCurrency('111111111111111111', 'USD');
    const withUsd = await read();

    assert.deepEqual(withJpy, withBrl);
    assert.deepEqual(withBrl, withUsd);
    for (const code of FIAT_CODES) {
      assert.equal(typeof withUsd[code], 'number', `${code} missing`);
    }
    env.close();
  });

  it('reports USD but never invents a rate when the FX provider is down', async () => {
    const fx = new FxService({ fetchImpl: failingFetch() });
    assert.equal(await fx.rateFor('USD'), 1);
    assert.equal(await fx.rateFor('EUR'), null);
    const quote = await fx.quote('EUR' as FiatCode);
    assert.equal(quote.fellBackToUsd, true);
    assert.equal(quote.source, 'unavailable');
  });
});