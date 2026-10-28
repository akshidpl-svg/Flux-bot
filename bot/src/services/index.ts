import type { Config } from '../config.ts';
import { migrate, openDatabase, type DB } from '../db/index.ts';
import { createProvider } from '../providers/index.ts';
import type { Provider } from '../providers/types.ts';
import { AddressService } from './addresses.ts';
import { AlertsService } from './alerts.ts';
import { DepositsService } from './deposits.ts';
import { FxService } from './fx.ts';
import { LedgerService } from './ledger.ts';
import { MarketService } from './market.ts';
import { PriceService } from './prices.ts';
import { ReceiptsService } from './receipts.ts';
import { RequestsService } from './requests.ts';
import { ServersService } from './servers.ts';
import { StatsService } from './stats.ts';
import { TransfersService } from './transfers.ts';
import { UsersService } from './users.ts';
import { WithdrawalsService } from './withdrawals.ts';

export interface Services {
  config: Config;
  db: DB;
  provider: Provider;
  prices: PriceService;
  fx: FxService;
  market: MarketService;
  users: UsersService;
  ledger: LedgerService;
  addresses: AddressService;
  deposits: DepositsService;
  withdrawals: WithdrawalsService;
  transfers: TransfersService;
  requests: RequestsService;
  receipts: ReceiptsService;
  alerts: AlertsService;
  servers: ServersService;
  stats: StatsService;
  close(): void;
}

export interface CreateServicesOptions {
  db?: DB;
  provider?: Provider;
  fetchImpl?: typeof fetch;
}

export function createServices(config: Config, options: CreateServicesOptions = {}): Services {
  const db = options.db ?? openDatabase(config.databasePath);
  migrate(db);
  const provider = options.provider ?? createProvider(config);

  const users = new UsersService(db);
  const ledger = new LedgerService(db);
  const prices = new PriceService(provider);
  const fx = new FxService(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  const market = new MarketService(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  const addresses = new AddressService(db, provider);
  const deposits = new DepositsService(db, { ledger, users, addresses, provider, prices });
  const withdrawals = new WithdrawalsService(db, {
    ledger,
    users,
    provider,
    prices,
    limits: {
      minWithdrawUsd: config.minWithdrawUsd,
      maxWithdrawUsd: config.maxWithdrawUsd,
      withdrawalsLive: config.withdrawalsLive,
    },
  });
  const transfers = new TransfersService(db, {
    ledger,
    users,
    prices,
    maxRainRecipients: config.maxRainRecipients,
  });
  const requests = new RequestsService(db, { ledger, users, prices, transfers });
  const receipts = new ReceiptsService(db, { transfers, deposits, withdrawals });
  const alerts = new AlertsService(db, prices);
  const servers = new ServersService(db);
  const stats = new StatsService(db, { config, ledger, users, deposits, withdrawals, transfers, provider });

  return {
    config,
    db,
    provider,
    prices,
    fx,
    market,
    users,
    ledger,
    addresses,
    deposits,
    withdrawals,
    transfers,
    requests,
    receipts,
    alerts,
    servers,
    stats,
    close: () => db.close(),
  };
}
