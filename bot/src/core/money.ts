import { ValidationError } from './errors.ts';

/**
 * All monetary amounts are integer base units (bigint) so nothing is ever
 * represented as a float. ETH has 18 decimals, which overflows SQLite's signed
 * 64-bit INTEGER, so amounts are stored as decimal strings and summed in JS.
 */
export function parseUnits(input: string, decimals: number): bigint {
  const raw = input.trim();
  if (!/^\d{1,18}(\.\d{1,18})?$/.test(raw)) {
    throw new ValidationError('Enter a positive amount using digits only, for example `0.005` or `12.5`.');
  }
  const [whole = '0', fraction = ''] = raw.split('.');
  if (fraction.length > decimals) {
    throw new ValidationError(`That asset supports at most ${decimals} decimal places.`);
  }
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
}

/** Formats base units for humans: no exponent notation, no trailing zeros. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  let fractionText = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  if (fractionText.length === 0) fractionText = '00';
  if (fractionText.length === 1) fractionText = `${fractionText}0`;
  return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
}

/** Compact display with grouping for large whole parts. */
export function formatAmount(value: bigint, decimals: number): string {
  const text = formatUnits(value, decimals);
  const [whole, fraction] = text.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return (numerator + denominator - 1n) / denominator;
}

/** Converts a JS number price into an 8-decimal scaled bigint for exact math. */
export function scalePrice(price: number, scale = 8): bigint {
  if (!Number.isFinite(price) || price <= 0) throw new Error('invalid price');
  return BigInt(Math.round(price * 10 ** scale));
}

export function sum(values: bigint[]): bigint {
  return values.reduce((acc, value) => acc + value, 0n);
}

export function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
