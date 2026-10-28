import { APP_FEE_USD } from './assets.ts';
import { InsufficientFundsError, ValidationError } from './errors.ts';
import { ceilDiv, scalePrice } from './money.ts';

export interface FeeQuote {
  /** Fee amount expressed in the asset's base units. */
  feeBase: bigint;
  /** USD price of one whole coin used for the conversion. */
  priceUsd: number;
  /** Unix ms when that price was observed. */
  priceTimestamp: number;
  /** Where the rate came from (e.g. "orbchain", "coingecko"). */
  priceSource: string;
  /** Application fee in USD (always APP_FEE_USD). */
  feeUsd: number;
}

export interface OutgoingPlan {
  /** Gross amount requested by the sender. */
  amountBase: bigint;
  /** Amount the recipient actually receives. */
  netBase: bigint;
  /** Fee charged in the asset. */
  feeBase: bigint;
  /** Total debited from the sender's wallet. */
  debitBase: bigint;
  /** True when the fee had to come out of the sent amount (rule 2). */
  feeTakenFromAmount: boolean;
}

/**
 * Converts the flat USD application fee into an amount of `asset`.
 * Uses the price at the time of the transaction and rounds *up* so FluxTip
 * never under-charges because of rounding.
 */
export function quoteFee(input: {
  decimals: number;
  priceUsd: number;
  priceTimestamp: number;
  priceSource: string;
  feeUsd?: number;
}): FeeQuote {
  const feeUsd = input.feeUsd ?? APP_FEE_USD;
  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
    throw new ValidationError('No verified exchange rate is available for this asset right now, so the application fee cannot be calculated. Please try again shortly.');
  }
  const priceE8 = scalePrice(input.priceUsd);
  const feeCents = BigInt(Math.round(feeUsd * 100));
  const numerator = feeCents * 10n ** BigInt(input.decimals) * 100_000_000n;
  const feeBase = ceilDiv(numerator, 100n * priceE8);
  if (feeBase <= 0n) {
    throw new ValidationError('The application fee rounds below the smallest unit of this asset.');
  }
  return {
    feeBase,
    priceUsd: input.priceUsd,
    priceTimestamp: input.priceTimestamp,
    priceSource: input.priceSource,
    feeUsd,
  };
}

/**
 * Applies the fee policy for outgoing transfers, tips, rain and splits.
 *
 * 1. If the wallet can cover amount + fee, the recipient gets the full amount.
 * 2. Otherwise the fee is deducted from the amount being sent (net amount).
 * 3. If neither works, the transaction is rejected - balances never go negative.
 */
export function planOutgoing(amountBase: bigint, feeBase: bigint, balanceBase: bigint): OutgoingPlan {
  if (amountBase <= 0n) throw new ValidationError('Amount must be greater than zero.');
  if (balanceBase < 0n) throw new InsufficientFundsError();

  if (balanceBase >= amountBase + feeBase) {
    return {
      amountBase,
      netBase: amountBase,
      feeBase,
      debitBase: amountBase + feeBase,
      feeTakenFromAmount: false,
    };
  }
  if (balanceBase >= amountBase && amountBase > feeBase) {
    return {
      amountBase,
      netBase: amountBase - feeBase,
      feeBase,
      debitBase: amountBase,
      feeTakenFromAmount: true,
    };
  }
  throw new InsufficientFundsError(
    'Insufficient balance: the amount plus the $0.05 application fee must fit in your available balance.',
  );
}

/** Net amount credited for a deposit after the application fee (rule 4). */
export function planDeposit(amountBase: bigint, feeBase: bigint): { netBase: bigint; feeBase: bigint } {
  if (amountBase <= 0n) throw new ValidationError('Deposit amount must be greater than zero.');
  if (amountBase <= feeBase) {
    throw new ValidationError('Deposit is smaller than the flat application fee and cannot be credited.');
  }
  return { netBase: amountBase - feeBase, feeBase };
}

/** Net payout for a withdrawal: the fee comes out of the requested amount. */
export function planWithdrawal(amountBase: bigint, feeBase: bigint): { netBase: bigint; feeBase: bigint } {
  if (amountBase <= feeBase) {
    throw new ValidationError('The withdrawal amount must be larger than the application fee.');
  }
  return { netBase: amountBase - feeBase, feeBase };
}
