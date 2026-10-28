import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Client } from 'discord.js';
import { logger } from '../logger.ts';
import type { Services } from '../services/index.ts';
import { notifyDeposit, notifyWithdrawal } from '../discord/notifier.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface WebhookServer {
  server: Server;
  close(): Promise<void>;
}

function safeEqualHex(received: string, expected: string): boolean {
  const a = Buffer.from(received.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** Verifies OrbChain's HMAC-SHA512 signature over the raw request body. */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  return safeEqualHex(signature, expected);
}

interface WebhookBody {
  type?: string;
  event_type?: string;
  event_id?: string;
  status?: string;
  currency?: string;
  coin?: string;
  address?: string;
  tx_hash?: string;
  amount?: string;
  confirmations?: number;
  track_id?: string;
  failure_reason?: string | null;
  transactions?: { tx_hash?: string; coin?: string; amount?: string; confirmations?: number; status?: string }[];
}

/**
 * Webhook endpoint. Signature is checked before parsing, event_id is the
 * idempotency key, and a failed processing attempt is left retryable.
 */
export function startWebhookServer(input: { services: Services; client: Client }): WebhookServer | null {
  const { services, client } = input;
  const secret = services.config.orbchain.webhookSecret;
  if (!secret) {
    logger.warn('Webhook server not started: ORBCHAIN_WEBHOOK_SECRET is not set');
    return null;
  }

  const server = createServer((request, response) => {
    const url = request.url ?? '/';

    if (request.method === 'GET' && url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, mode: services.provider.isSimulated ? 'simulated' : 'live' }));
      return;
    }

    if (request.method !== 'POST' || !url.startsWith('/webhooks/orbchain')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const signature = request.headers.hmac as string | undefined;
        if (!verifyWebhookSignature(raw, signature, secret)) {
          logger.warn('Rejected webhook with invalid signature');
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_signature' }));
          return;
        }

        let body: WebhookBody;
        try {
          body = JSON.parse(raw) as WebhookBody;
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'invalid_json' }));
          return;
        }

        const eventId =
          (request.headers['x-event-id'] as string | undefined) ?? body.event_id ?? undefined;
        if (!eventId || eventId.length < 8) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'missing_event_id' }));
          return;
        }

        const db = services.db;
        const existing = db.prepare('SELECT status FROM webhook_events WHERE event_id = ?').get(eventId) as
          | { status: string }
          | undefined;
        if (existing && existing.status !== 'failed') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, duplicate: true }));
          return;
        }
        if (existing) {
          db.prepare("UPDATE webhook_events SET status = 'received' WHERE event_id = ?").run(eventId);
        } else {
          db.prepare(
            "INSERT INTO webhook_events (event_id, event_type, payload, received_at, status) VALUES (?, ?, ?, ?, 'received')",
          ).run(eventId, body.event_type ?? body.type ?? null, raw, Date.now());
        }

        try {
          const outcome = await processEvent(body, services, client);
          db.prepare("UPDATE webhook_events SET status = ?, processed_at = ? WHERE event_id = ?").run(
            outcome,
            Date.now(),
            eventId,
          );
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, outcome }));
        } catch (error) {
          logger.error('Webhook processing failed', { error, eventId });
          db.prepare("UPDATE webhook_events SET status = 'failed', error = ? WHERE event_id = ?").run(
            'processing_error',
            eventId,
          );
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'processing_failed' }));
        }
      })();
    });

    request.on('error', (error) => {
      logger.warn('Webhook request error', { error });
      response.destroy();
    });
  });

  server.listen(services.config.orbchain.webhookPort, '0.0.0.0', () => {
    logger.info('Webhook server listening', { port: services.config.orbchain.webhookPort });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function processEvent(body: WebhookBody, services: Services, client: Client): Promise<string> {
  const type = (body.event_type ?? body.type ?? '').toLowerCase();

  if (type.startsWith('payout')) {
    const result = services.withdrawals.handlePayoutWebhook(body);
    if (result.withdrawalId) await notifyWithdrawal(client, services, result.withdrawalId);
    return `payout_${result.outcome}`;
  }

  if (type.includes('transfer') || type.startsWith('subscription')) {
    return 'ignored_event_type';
  }

  const hasDepositShape =
    Array.isArray(body.transactions) ||
    Boolean(body.tx_hash && body.coin && body.amount) ||
    type.startsWith('payment') ||
    type.startsWith('deposit');

  if (!hasDepositShape) return 'ignored_event_type';

  if (Array.isArray(body.transactions) && body.transactions.length > 0) {
    const results = await services.deposits.handlePaymentWebhook(body);
    for (const result of results) {
      if (result.outcome === 'credited') await notifyDeposit(client, services, result.txHash);
    }
    return `payment_${results.map((result) => result.outcome).join('_') || 'no_transactions'}`;
  }

  if (body.tx_hash && body.coin && body.amount) {
    const result = await services.deposits.processProviderDeposit({
      txHash: body.tx_hash,
      coin: body.coin,
      network: '',
      amount: body.amount,
      confirmations: body.confirmations ?? 0,
      requiredConfirmations: 0,
      status: body.status ?? 'PENDING',
      credited: (body.status ?? '').toUpperCase() === 'CREDITED',
      address: body.address ?? null,
      trackId: body.track_id ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });
    if (result.outcome === 'credited') await notifyDeposit(client, services, result.txHash);
    return `deposit_${result.outcome}`;
  }

  return 'ignored_no_deposit_data';
}
