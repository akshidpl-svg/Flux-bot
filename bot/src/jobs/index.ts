import type { Client } from 'discord.js';
import { ASSETS, assetTicker, type AssetSymbol } from '../core/assets.ts';
import { backupDatabase } from '../db/backup.ts';
import { getState, setState } from '../db/index.ts';
import { logger } from '../logger.ts';
import type { Services } from '../services/index.ts';
import { notifyDeposit, notifyWithdrawal, sendPrivateMessage } from '../discord/notifier.ts';

export interface JobRunner {
  stop(): void;
  runOnce(): Promise<void>;
}

/**
 * Background maintenance. Every job is idempotent, so overlapping or repeated
 * runs (including after a crash/restart) cannot double-credit or double-pay.
 */
export function startJobs(input: { services: Services; client: Client }): JobRunner {
  const { services, client } = input;
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();

  const guard = (name: string, fn: () => Promise<void>) => {
    return async () => {
      if (running.has(name)) return;
      running.add(name);
      try {
        await fn();
      } catch (error) {
        logger.warn('Background job failed', { job: name, error });
      } finally {
        running.delete(name);
      }
    };
  };

  const pollDeposits = guard('deposits', async () => {
    const cursor = Number(getState(services.db, 'deposit_poll_cursor') ?? Math.floor(Date.now() / 1000) - 3600);
    const result = await services.deposits.poll(cursor);
    setState(services.db, 'deposit_poll_cursor', String(Math.floor(Date.now() / 1000) - 30));
    if (result.processed > 0) logger.info('Deposit poll complete', { processed: result.processed, credited: result.credited });
    for (const hash of result.creditedHashes) await notifyDeposit(client, services, hash);
  });

  const refreshDeposits = guard('deposits-refresh', async () => {
    const result = await services.deposits.refreshOpen(10);
    if (result.credited.length > 0) {
      logger.info('Credited deposits that were waiting on provider or price data', { credited: result.credited.length });
    }
    for (const hash of result.credited) await notifyDeposit(client, services, hash);
  });

  const retryWithdrawals = guard('withdrawals-retry', async () => {
    const submitted = await services.withdrawals.retryPending(10);
    if (submitted > 0) logger.info('Retried pending withdrawal submissions', { submitted });
  });

  const syncWithdrawals = guard('withdrawals-sync', async () => {
    const result = await services.withdrawals.syncPending(25);
    for (const id of [...result.confirmedIds, ...result.failedIds]) {
      await notifyWithdrawal(client, services, id);
    }
  });

  const expireRequests = guard('requests', async () => {
    const expired = services.requests.expireStale();
    if (expired > 0) logger.info('Expired payment requests', { expired });
  });

  const checkAlerts = guard('alerts', async () => {
    const triggered = await services.alerts.check();
    for (const { alert, price } of triggered) {
      const prefs = services.users.notifications(alert.user_id);
      if (!prefs.dm || !prefs.prices) continue;
      const asset = alert.asset as AssetSymbol;
      await sendPrivateMessage(client, alert.user_id, {
        embeds: [
          {
            color: 0x35f0b4,
            title: 'Price alert triggered',
            description: `${assetTicker(asset)} is now **$${price.toFixed(price >= 1 ? 2 : 6)}**, ${alert.direction} your target of $${alert.target_usd}.\n\nAlert #${alert.id} has been marked triggered.`,
            footer: { text: `${ASSETS[asset]?.networkLabel ?? ''} · market data is informational, not an execution price` },
          },
        ],
      });
    }
  });

  const dailyBackup = guard('backup', async () => {
    const last = Number(getState(services.db, 'last_backup_at') ?? 0);
    if (Date.now() - last < 20 * 3_600_000) return;
    const path = backupDatabase(services.db, services.config.backupDir, { keep: 7 });
    setState(services.db, 'last_backup_at', String(Date.now()));
    logger.info('Daily backup complete', { path });
  });

  const schedule = (name: string, fn: () => Promise<void>, everyMs: number, initialDelayMs = 5_000) => {
    const timeout = setTimeout(() => {
      void fn();
      const interval = setInterval(() => void fn(), everyMs);
      timers.push(interval);
    }, initialDelayMs);
    timers.push(timeout);
    logger.debug('Scheduled job', { job: name, everyMs });
  };

  schedule('deposits', pollDeposits, 60_000, 8_000);
  schedule('deposits-refresh', refreshDeposits, 10 * 60_000, 90_000);
  schedule('withdrawals-retry', retryWithdrawals, 45_000, 6_000);
  schedule('withdrawals-sync', syncWithdrawals, 30_000, 12_000);
  schedule('requests', expireRequests, 5 * 60_000, 15_000);
  schedule('alerts', checkAlerts, 2 * 60_000, 30_000);
  schedule('backup', dailyBackup, 6 * 3_600_000, 60_000);

  return {
    async runOnce() {
      await expireRequests();
      await retryWithdrawals();
      await syncWithdrawals();
      await pollDeposits();
      await refreshDeposits();
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
  };
}
