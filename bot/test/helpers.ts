import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { loadConfig, type Config } from '../src/config.ts';
import { openDatabase, type DB } from '../src/db/index.ts';
import type { AssetSymbol } from '../src/core/assets.ts';
import { SimulatedProvider } from '../src/providers/simulated.ts';
import type { Provider } from '../src/providers/types.ts';
import { createServices, type Services } from '../src/services/index.ts';

export const USER_A = '111111111111111111';
export const USER_B = '222222222222222222';
export const USER_C = '333333333333333333';
export const USER_D = '444444444444444444';
export const SERVER_ID = '999999999999999999';
export const OTHER_SERVER_ID = '888888888888888888';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DISCORD_TOKEN: 'test-token-value-not-real',
    DISCORD_CLIENT_ID: '123456789012345678',
    PROVIDER_MODE: 'simulated',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'error',
    ORBCHAIN_WEBHOOK_SECRET: 'test-webhook-secret-value',
    ORBCHAIN_WEBHOOK_PORT: '0',
    ADMIN_USER_IDS: USER_A,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestEnv {
  services: Services;
  db: DB;
  provider: Provider;
  simulated: SimulatedProvider;
  config: Config;
  close(): void;
}

export function createTestEnv(options: { db?: DB; config?: Config; provider?: Provider } = {}): TestEnv {
  const config = options.config ?? testConfig();
  const db = options.db ?? openDatabase(':memory:');
  const simulated = new SimulatedProvider({ confirmAfterMs: 0 });
  const provider = options.provider ?? simulated;
  const services = createServices(config, { db, provider });
  return {
    services,
    db,
    provider,
    simulated,
    config,
    close() {
      try {
        services.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Credits a test user through the real simulated deposit path. */
export async function fund(env: TestEnv, userId: string, asset: AssetSymbol, amount: string): Promise<void> {
  env.services.users.ensure(userId);
  const address = await env.services.addresses.ensure(userId, asset);
  const deposit = env.simulated.simulateDeposit({ userId, asset, amount, address: address.address });
  const result = await env.services.deposits.processProviderDeposit(deposit);
  if (result.outcome !== 'credited') throw new Error(`fund failed: ${result.outcome}`);
}

export function tempDatabasePath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'fluxtip-test-'));
  return {
    path: join(dir, 'fluxtip.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal Discord client stub: DMs always fail, which the notifier tolerates. */
export function stubClient(): Client {
  return {
    users: {
      fetch: async () => {
        throw new Error('DMs unavailable in tests');
      },
    },
  } as unknown as Client;
}

let counter = 0;
export function interactionId(): string {
  counter += 1;
  return `interaction-${counter}-${Date.now()}`;
}
