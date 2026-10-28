import { loadConfig, loadDotEnv } from '../config.ts';
import { ASSETS, isAssetSymbol, type AssetSymbol } from '../core/assets.ts';
import { parseUnits } from '../core/money.ts';
import { configureLogger, logger } from '../logger.ts';
import { SimulatedProvider } from '../providers/simulated.ts';
import { createServices } from '../services/index.ts';

/**
 * Development helper: queues a clearly-labelled simulated deposit and runs it
 * through the exact same crediting path as a provider webhook.
 *
 *   node dist/scripts/simulate.js --user 123456789012345678 --asset USDT_TRC20 --amount 25
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const userId = args.user;
  const asset = args.asset as AssetSymbol | undefined;
  const amount = args.amount;

  if (!userId || !/^\d{17,20}$/.test(userId)) throw new Error('--user must be a Discord user ID');
  if (!asset || !isAssetSymbol(asset)) throw new Error(`--asset must be one of ${Object.keys(ASSETS).join(', ')}`);
  if (!amount) throw new Error('--amount is required');

  loadDotEnv();
  const config = loadConfig();
  configureLogger('debug', []);
  if (config.providerMode !== 'simulated') {
    throw new Error('Refusing to simulate a deposit against a live provider. Set PROVIDER_MODE=simulated.');
  }

  const services = createServices(config);
  if (!(services.provider instanceof SimulatedProvider)) throw new Error('simulated provider is not active');

  parseUnits(amount, ASSETS[asset].decimals);
  services.users.ensure(userId);
  const address = await services.addresses.ensure(userId, asset);
  const deposit = services.provider.simulateDeposit({ userId, asset, amount, address: address.address });
  const result = await services.deposits.processProviderDeposit(deposit);

  logger.info('SIMULATED deposit processed (no blockchain involved)', {
    userId,
    asset,
    amount,
    outcome: result.outcome,
    txHash: result.txHash,
  });
  services.close();
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    out[key.slice(2)] = argv[index + 1] ?? '';
    index += 1;
  }
  return out;
}

main().catch((error) => {
  logger.error('Simulation failed', { error });
  process.exitCode = 1;
});
