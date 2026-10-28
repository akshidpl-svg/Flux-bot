/** Fixed application fee, in USD. Changing this is a product decision, not config. */
export const APP_FEE_USD = 0.05;

/** Assets FluxTip supports. Keys are the exact OrbChain currency symbols. */
export const ASSETS = {
  BTC: {
    symbol: 'BTC',
    name: 'Bitcoin',
    network: 'bitcoin',
    networkLabel: 'Bitcoin',
    decimals: 8,
    providerSymbol: 'BTC',
    explorerTx: 'https://mempool.space/tx/',
    explorerAddress: 'https://mempool.space/address/',
  },
  LTC: {
    symbol: 'LTC',
    name: 'Litecoin',
    network: 'litecoin',
    networkLabel: 'Litecoin',
    decimals: 8,
    providerSymbol: 'LTC',
    explorerTx: 'https://blockchair.com/litecoin/transaction/',
    explorerAddress: 'https://blockchair.com/litecoin/address/',
  },
  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    network: 'ethereum',
    networkLabel: 'Ethereum',
    decimals: 18,
    providerSymbol: 'ETH',
    explorerTx: 'https://etherscan.io/tx/',
    explorerAddress: 'https://etherscan.io/address/',
  },
  SOL: {
    symbol: 'SOL',
    name: 'Solana',
    network: 'solana',
    networkLabel: 'Solana',
    decimals: 9,
    providerSymbol: 'SOL',
    explorerTx: 'https://solscan.io/tx/',
    explorerAddress: 'https://solscan.io/account/',
  },
  USDT_TRC20: {
    symbol: 'USDT_TRC20',
    name: 'Tether USD',
    network: 'tron',
    networkLabel: 'TRON (TRC-20)',
    decimals: 6,
    providerSymbol: 'USDT_TRC20',
    explorerTx: 'https://tronscan.org/#/transaction/',
    explorerAddress: 'https://tronscan.org/#/address/',
  },
} as const;

export type AssetSymbol = keyof typeof ASSETS;
export type Asset = (typeof ASSETS)[AssetSymbol];

export const ASSET_SYMBOLS = Object.keys(ASSETS) as AssetSymbol[];

/** Display order used in wallet summaries and pickers. */
export const ASSET_ORDER: AssetSymbol[] = ['BTC', 'LTC', 'ETH', 'SOL', 'USDT_TRC20'];

export function isAssetSymbol(value: string): value is AssetSymbol {
  return Object.hasOwn(ASSETS, value);
}

export function getAsset(symbol: string): Asset {
  const asset = ASSETS[symbol as AssetSymbol];
  if (!asset) {
    throw new Error(`Unsupported asset: ${symbol}`);
  }
  return asset;
}

export function assetLabel(symbol: AssetSymbol): string {
  const asset = ASSETS[symbol];
  return symbol === 'USDT_TRC20' ? 'USDT (TRC-20)' : asset.name;
}

/** Short label used in balances, e.g. "USDT". */
export function assetTicker(symbol: AssetSymbol): string {
  return symbol === 'USDT_TRC20' ? 'USDT' : symbol;
}

/** "USDT (TRC-20)" is never confused with USDT on Ethereum or Solana. */
export function assetNetworkLabel(symbol: AssetSymbol): string {
  return `${assetTicker(symbol)} · ${ASSETS[symbol].networkLabel}`;
}
