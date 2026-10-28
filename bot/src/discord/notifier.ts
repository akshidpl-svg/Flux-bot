import type { Client, User } from 'discord.js';
import { ASSETS, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { formatUnits } from '../core/money.ts';
import { logger } from '../logger.ts';
import type { Services } from '../services/index.ts';

/**
 * DM delivery is best-effort: users can block DMs or share no mutual guild.
 * Failures are logged at debug level and never break a transaction.
 */
export async function sendPrivateMessage(client: Client, userId: string, payload: Parameters<User['send']>[0]): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId, { cache: false });
    await user.send(payload);
    return true;
  } catch {
    logger.debug('Could not DM user', { userId });
    return false;
  }
}

export async function notifyDeposit(client: Client, services: Services, txHash: string): Promise<void> {
  const deposit = services.deposits.byTxHash(txHash);
  if (!deposit || deposit.status !== 'confirmed') return;
  const prefs = services.users.notifications(deposit.user_id);
  if (!prefs.dm || !prefs.deposits) return;
  const asset = deposit.asset as AssetSymbol;
  const credited = formatUnits(BigInt(deposit.net), ASSETS[asset]?.decimals ?? 8);
  await sendPrivateMessage(client, deposit.user_id, {
    content: `💰 Deposit credited: **${credited} ${assetTicker(asset)}** after the $0.05 fee.\nReference \`d_${deposit.id}\` · run \`/receipt d_${deposit.id}\` for the full receipt.`,
  });
}

export async function notifyWithdrawal(client: Client, services: Services, withdrawalId: number): Promise<void> {
  const row = services.withdrawals.getById(withdrawalId);
  const prefs = services.users.notifications(row.user_id);
  if (!prefs.dm || !prefs.withdrawals) return;
  await sendPrivateMessage(client, row.user_id, {
    content:
      row.status === 'confirmed'
        ? `✅ Withdrawal \`w_${row.id}\` confirmed by the provider.${row.provider_tx_hash ? `\nTransaction \`${row.provider_tx_hash}\`` : ''}`
        : `⚠️ Withdrawal \`w_${row.id}\` failed and the amount plus fee were returned to your balance.`,
  });
}
