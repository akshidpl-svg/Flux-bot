import { getAsset, type AssetSymbol } from '../core/assets.ts';
import type { DB } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { Provider } from '../providers/types.ts';

export interface DepositAddressRow {
  id: number;
  user_id: string;
  asset: string;
  network: string;
  address: string;
  provider: string;
  provider_track_id: string | null;
  created_at: number;
}

export class AddressService {
  private readonly db: DB;
  private readonly provider: Provider;

  constructor(db: DB, provider: Provider) {
    this.db = db;
    this.provider = provider;
  }

  list(userId: string): DepositAddressRow[] {
    return this.db
      .prepare('SELECT * FROM deposit_addresses WHERE user_id = ? ORDER BY asset ASC')
      .all(userId) as DepositAddressRow[];
  }

  find(userId: string, asset: AssetSymbol): DepositAddressRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM deposit_addresses WHERE user_id = ? AND asset = ? AND provider = ?')
        .get(userId, asset, this.provider.name) as DepositAddressRow | undefined) ?? null
    );
  }

  /** Used by webhook processing: addresses are chain-specific, so match both. */
  findByAddress(address: string, asset: AssetSymbol): DepositAddressRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM deposit_addresses WHERE address = ? AND asset = ? AND provider = ?')
        .get(address, asset, this.provider.name) as DepositAddressRow | undefined) ?? null
    );
  }

  /**
   * Returns the existing address or asks the provider for one. Nothing is shown
   * to a user unless the provider actually returned an address.
   */
  async ensure(userId: string, asset: AssetSymbol): Promise<DepositAddressRow> {
    const existing = this.find(userId, asset);
    if (existing) return existing;

    const meta = getAsset(asset);
    const created = await this.provider.getOrCreateAddress({
      userId,
      asset,
      description: `FluxTip ${asset} deposit address`,
    });
    if (!created.address || created.address.trim().length === 0) {
      throw new Error('provider returned an empty address');
    }

    this.db
      .prepare(
        `INSERT INTO deposit_addresses (user_id, asset, network, address, provider, provider_track_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, asset, network, provider) DO NOTHING`,
      )
      .run(userId, asset, meta.network, created.address, this.provider.name, created.trackId, Date.now());

    const stored = this.find(userId, asset);
    if (!stored) {
      throw new Error('deposit address could not be stored');
    }
    logger.info('Deposit address ready', { userId, asset, provider: this.provider.name });
    return stored;
  }
}
