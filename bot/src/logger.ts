import type { LogLevel } from './config.ts';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED_KEYS = /(token|secret|api[-_]?key|authorization|password|private[-_]?key|cookie)/i;

let threshold: number = LEVELS.info;
let secrets: string[] = [];

export function configureLogger(level: LogLevel, knownSecrets: string[] = []): void {
  threshold = LEVELS[level] ?? LEVELS.info;
  // Only remember values long enough to be real credentials; short strings would
  // redact ordinary words out of log messages.
  secrets = knownSecrets.filter((value) => value.length >= 8);
}

function redactString(value: string): string {
  let result = value;
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join('[redacted]');
    }
  }
  // Defensive: Discord bot tokens, 64-char hex keys and Bearer tokens.
  result = result.replace(/\b[MN][A-Za-z\d_-]{23,}\.[\w-]{6,}\.[\w-]{27,}\b/g, '[redacted-token]');
  result = result.replace(/\b[a-f0-9]{64}\b/gi, '[redacted-key]');
  result = result.replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]');
  return result;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      code: (value as { code?: unknown }).code,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.test(key) && typeof entry === 'string' ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message: redactString(message),
    ...(context ? { context: redact(context) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};
