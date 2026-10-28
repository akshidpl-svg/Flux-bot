import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatUnits, parseUnits, ceilDiv } from '../src/core/money.ts';
import { planDeposit, planOutgoing, planWithdrawal, quoteFee } from '../src/core/fees.ts';
import { InsufficientFundsError, ValidationError } from '../src/core/errors.ts';

describe('crypto rounding (base units)', () => {
  it('round-trips decimal strings without floats', () => {
    assert.equal(parseUnits('0.00000001', 8), 1n);
    assert.equal(parseUnits('1', 8), 100_000_000n);
    assert.equal(parseUnits('0.1', 18), 100_000_000_000_000_000n);
    assert.equal(formatUnits(1n, 8), '0.00000001');
    assert.equal(formatUnits(100_000_000n, 8), '1.00');
    assert.equal(formatUnits(123_456_789n, 8), '1.23456789');
    assert.equal(formatUnits(0n, 6), '0.00');
  });

  it('rejects malformed, negative, scientific and over-precise amounts', () => {
    assert.throws(() => parseUnits('-1', 8), ValidationError);
    assert.throws(() => parseUnits('1e-5', 8), ValidationError);
    assert.throws(() => parseUnits('abc', 8), ValidationError);
    assert.throws(() => parseUnits('1.123456789', 8), ValidationError);
    assert.throws(() => parseUnits('', 8), ValidationError);
  });

  it('never loses the last base unit when splitting', () => {
    assert.equal(ceilDiv(10n, 3n), 4n);
    assert.equal(ceilDiv(9n, 3n), 3n);
    assert.equal(ceilDiv(1n, 1_000_000n), 1n);
  });
});

describe('application fee conversion', () => {
  it('converts $0.05 into USDT (6 decimals) exactly', () => {
    const quote = quoteFee({ decimals: 6, priceUsd: 1, priceTimestamp: 1_700_000_000_000, priceSource: 'test' });
    assert.equal(quote.feeBase, 50_000n);
    assert.equal(formatUnits(quote.feeBase, 6), '0.05');
    assert.equal(quote.priceUsd, 1);
    assert.equal(quote.priceTimestamp, 1_700_000_000_000);
  });

  it('rounds the fee up (never under-charges) for high-value assets', () => {
    const quote = quoteFee({ decimals: 8, priceUsd: 60_000, priceTimestamp: 1, priceSource: 'test' });
    // 0.05 / 60000 = 0.000000833... -> 84 satoshis after ceiling
    assert.equal(quote.feeBase, 84n);
  });

  it('refuses to invent a fee when no verified price exists', () => {
    assert.throws(
      () => quoteFee({ decimals: 8, priceUsd: 0, priceTimestamp: 1, priceSource: 'test' }),
      ValidationError,
    );
  });
});

describe('fee policy for outgoing transfers', () => {
  const fee = 50_000n; // 0.05 USDT

  it('charges the fee on top when the balance covers both', () => {
    const plan = planOutgoing(1_000_000n, fee, 1_050_000n);
    assert.equal(plan.netBase, 1_000_000n);
    assert.equal(plan.debitBase, 1_050_000n);
    assert.equal(plan.feeTakenFromAmount, false);
  });

  it('deducts the fee from the amount when it cannot be covered separately', () => {
    const plan = planOutgoing(1_000_000n, fee, 1_000_000n);
    assert.equal(plan.netBase, 950_000n);
    assert.equal(plan.debitBase, 1_000_000n);
    assert.equal(plan.feeTakenFromAmount, true);
  });

  it('rejects when the amount itself is unaffordable or not larger than the fee', () => {
    assert.throws(() => planOutgoing(2_000_000n, fee, 1_000_000n), InsufficientFundsError);
    assert.throws(() => planOutgoing(50_000n, fee, 50_000n), InsufficientFundsError);
    assert.throws(() => planOutgoing(0n, fee, 1_000_000n), ValidationError);
  });
});

describe('deposit and withdrawal fee plans', () => {
  it('withholds the fee from a deposit', () => {
    const plan = planDeposit(1_000_000n, 50_000n);
    assert.equal(plan.netBase, 950_000n);
  });

  it('rejects dust deposits that cannot cover the fee', () => {
    assert.throws(() => planDeposit(50_000n, 50_000n), ValidationError);
    assert.throws(() => planDeposit(10n, 50_000n), ValidationError);
  });

  it('takes the withdrawal fee out of the requested amount', () => {
    const plan = planWithdrawal(1_000_000n, 50_000n);
    assert.equal(plan.netBase, 950_000n);
    assert.throws(() => planWithdrawal(50_000n, 50_000n), ValidationError);
  });
});
