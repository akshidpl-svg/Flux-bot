export type FiatCode =
  | 'USD'
  | 'EUR'
  | 'GBP'
  | 'INR'
  | 'CAD'
  | 'AUD'
  | 'NZD'
  | 'CHF'
  | 'JPY'
  | 'SGD'
  | 'AED'
  | 'SAR'
  | 'TRY'
  | 'BRL'
  | 'PHP'
  | 'ZAR';

export interface FiatCurrency {
  code: FiatCode;
  symbol: string;
  label: string;
  locale: string;
  decimals: number;
}

export const FIAT_CURRENCIES: Record<FiatCode, FiatCurrency> = {
  USD: { code: 'USD', symbol: '$', label: 'US Dollar', locale: 'en-US', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', label: 'Euro', locale: 'de-DE', decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', label: 'British Pound', locale: 'en-GB', decimals: 2 },
  INR: { code: 'INR', symbol: '₹', label: 'Indian Rupee', locale: 'en-IN', decimals: 2 },
  CAD: { code: 'CAD', symbol: 'CA$', label: 'Canadian Dollar', locale: 'en-CA', decimals: 2 },
  AUD: { code: 'AUD', symbol: 'A$', label: 'Australian Dollar', locale: 'en-AU', decimals: 2 },
  NZD: { code: 'NZD', symbol: 'NZ$', label: 'New Zealand Dollar', locale: 'en-NZ', decimals: 2 },
  CHF: { code: 'CHF', symbol: 'CHF ', label: 'Swiss Franc', locale: 'de-CH', decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', label: 'Japanese Yen', locale: 'ja-JP', decimals: 0 },
  SGD: { code: 'SGD', symbol: 'S$', label: 'Singapore Dollar', locale: 'en-SG', decimals: 2 },
  AED: { code: 'AED', symbol: 'AED ', label: 'UAE Dirham', locale: 'en-AE', decimals: 2 },
  SAR: { code: 'SAR', symbol: 'SAR ', label: 'Saudi Riyal', locale: 'ar-SA', decimals: 2 },
  TRY: { code: 'TRY', symbol: '₺', label: 'Turkish Lira', locale: 'tr-TR', decimals: 2 },
  BRL: { code: 'BRL', symbol: 'R$', label: 'Brazilian Real', locale: 'pt-BR', decimals: 2 },
  PHP: { code: 'PHP', symbol: '₱', label: 'Philippine Peso', locale: 'en-PH', decimals: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', label: 'South African Rand', locale: 'en-ZA', decimals: 2 },
};

export const FIAT_CODES = Object.keys(FIAT_CURRENCIES) as FiatCode[];
export const DEFAULT_FIAT: FiatCode = 'USD';

export function isFiatCode(value: string): value is FiatCode {
  return Object.hasOwn(FIAT_CURRENCIES, value);
}

export function getFiat(code: string): FiatCurrency {
  const currency = FIAT_CURRENCIES[code as FiatCode];
  if (!currency) throw new Error(`Unsupported fiat currency: ${code}`);
  return currency;
}

/** Formats a fiat amount (already converted into `code`) with its symbol. */
export function formatFiat(amount: number, code: FiatCode, options?: { decimals?: number }): string {
  const currency = getFiat(code);
  const decimals = options?.decimals ?? currency.decimals;
  const safe = Number.isFinite(amount) ? amount : 0;
  const fixed = Math.abs(safe).toFixed(decimals);
  const [whole = '0', fraction = ''] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const sign = safe < 0 ? '-' : '';
  const symbol = currency.symbol;
  // Symbols that are words (AED, SAR, CHF) read better with a space already included.
  return `${sign}${symbol}${body}`;
}

/** Fiat estimates below one cent are shown as "<$0.01" rather than "$0.00". */
export function formatFiatEstimate(amount: number, code: FiatCode): string {
  if (Number.isFinite(amount) && amount > 0 && amount < 0.01) {
    return `<${getFiat(code).symbol}0.01`;
  }
  return formatFiat(amount, code);
}
