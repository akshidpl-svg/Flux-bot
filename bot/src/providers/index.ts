import type { Config } from '../config.ts';
import { OrbChainProvider } from './orbchain.ts';
import { SimulatedProvider } from './simulated.ts';
import type { Provider } from './types.ts';

export function createProvider(config: Config): Provider {
  if (config.providerMode === 'simulated') {
    return new SimulatedProvider();
  }
  return new OrbChainProvider({
    baseUrl: config.orbchain.baseUrl,
    merchantApiKey: config.orbchain.merchantApiKey,
    payoutApiKey: config.orbchain.payoutApiKey,
    generalApiKey: config.orbchain.generalApiKey,
    webhookUrl: config.orbchain.webhookUrl,
  });
}

export type { Provider } from './types.ts';
export { SimulatedProvider } from './simulated.ts';
