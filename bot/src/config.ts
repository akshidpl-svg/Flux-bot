import { APP_FEE_USD } from './core/assets.ts';

export type ProviderMode = 'live' | 'simulated';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  nodeEnv: string;
  discordToken: string;
  discordClientId: string;
  providerMode: ProviderMode;
  withdrawalsLive: boolean;
  orbchain: {
    baseUrl: string;
    merchantApiKey: string;
    payoutApiKey: string;
    generalApiKey: string;
    webhookSecret: string;
    webhookPort: number;
    /** Public HTTPS URL of the FluxTip webhook endpoint, sent as callback_url. */
    webhookUrl: string | null;
  };
  databasePath: string;
  backupDir: string;
  logLevel: LogLevel;
  adminUserIds: ReadonlySet<string>;
  feeUsd: number;
  minWithdrawUsd: number;
  maxWithdrawUsd: number;
  maxRainRecipients: number;
  supportServerUrl: string | null;
  statusPageUrl: string | null;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  const value = env[key];
  return value === undefined ? fallback : value.trim();
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = str(env, key).toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be true or false`);
}

/**
 * Loads `.env` from the working directory when present. Real environments
 * (systemd `EnvironmentFile`, PM2, Docker) take precedence over the file.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file; rely on the process environment.
  }
}

/**
 * Reads configuration from the environment. Throws on missing/invalid values so
 * the process fails fast at startup instead of at the first transaction.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providerMode = str(env, 'PROVIDER_MODE', 'simulated').toLowerCase();
  if (providerMode !== 'live' && providerMode !== 'simulated') {
    throw new Error('PROVIDER_MODE must be "live" or "simulated"');
  }

  const logLevel = str(env, 'LOG_LEVEL', 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be debug, info, warn or error');
  }

  const token = str(env, 'DISCORD_TOKEN');
  const clientId = str(env, 'DISCORD_CLIENT_ID');
  if (!token) throw new Error('DISCORD_TOKEN is required');
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is required');

  const adminIds = new Set(
    str(env, 'ADMIN_USER_IDS')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  for (const id of adminIds) {
    if (!/^\d{17,20}$/.test(id)) {
      throw new Error('ADMIN_USER_IDS must contain numeric Discord user IDs (17-20 digits), separated by commas');
    }
  }

  const config: Config = {
    nodeEnv: str(env, 'NODE_ENV', 'development'),
    discordToken: token,
    discordClientId: clientId,
    providerMode,
    withdrawalsLive: bool(env, 'WITHDRAWALS_LIVE', false),
    orbchain: {
      baseUrl: str(env, 'ORBCHAIN_BASE_URL', 'https://orbchain.io').replace(/\/+$/, ''),
      merchantApiKey: str(env, 'ORBCHAIN_MERCHANT_API_KEY'),
      payoutApiKey: str(env, 'ORBCHAIN_PAYOUT_API_KEY'),
      generalApiKey: str(env, 'ORBCHAIN_GENERAL_API_KEY'),
      webhookSecret: str(env, 'ORBCHAIN_WEBHOOK_SECRET'),
      webhookPort: num(env, 'ORBCHAIN_WEBHOOK_PORT', 8787),
      webhookUrl: str(env, 'ORBCHAIN_WEBHOOK_URL') || null,
    },
    databasePath: str(env, 'DATABASE_PATH', './data/fluxtip.db'),
    backupDir: str(env, 'BACKUP_DIR', './data/backups'),
    logLevel: logLevel as LogLevel,
    adminUserIds: adminIds,
    feeUsd: APP_FEE_USD,
    minWithdrawUsd: num(env, 'MIN_WITHDRAW_USD', 1),
    maxWithdrawUsd: num(env, 'MAX_WITHDRAW_USD', 1000),
    maxRainRecipients: Math.min(50, Math.max(2, num(env, 'MAX_RAIN_RECIPIENTS', 25))),
    supportServerUrl: str(env, 'SUPPORT_SERVER_URL') || null,
    statusPageUrl: str(env, 'STATUS_PAGE_URL') || null,
  };

  if (config.minWithdrawUsd > config.maxWithdrawUsd) {
    throw new Error('MIN_WITHDRAW_USD cannot be greater than MAX_WITHDRAW_USD');
  }

  if (providerMode === 'live') {
    const missing: string[] = [];
    if (!config.orbchain.merchantApiKey) missing.push('ORBCHAIN_MERCHANT_API_KEY');
    if (!config.orbchain.payoutApiKey) missing.push('ORBCHAIN_PAYOUT_API_KEY');
    if (!config.orbchain.generalApiKey) missing.push('ORBCHAIN_GENERAL_API_KEY');
    if (!config.orbchain.webhookSecret) missing.push('ORBCHAIN_WEBHOOK_SECRET');
    if (missing.length > 0) {
      throw new Error(`PROVIDER_MODE=live requires: ${missing.join(', ')}`);
    }
    if (!config.orbchain.baseUrl.startsWith('https://')) {
      throw new Error('ORBCHAIN_BASE_URL must use https:// in live mode');
    }
  }

  if (config.withdrawalsLive && providerMode !== 'live') {
    throw new Error('WITHDRAWALS_LIVE=true requires PROVIDER_MODE=live');
  }

  return config;
}

/** Secrets the logger must never print, in any form. */
export function configSecrets(config: Config): string[] {
  return [
    config.discordToken,
    config.orbchain.merchantApiKey,
    config.orbchain.payoutApiKey,
    config.orbchain.generalApiKey,
    config.orbchain.webhookSecret,
  ].filter((value) => value.length >= 8);
}
