import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { startWebhookServer, verifyWebhookSignature } from '../src/webhooks/server.ts';
import { createTestEnv, stubClient, USER_A } from './helpers.ts';

const TRON_ADDRESS = 'TRrqEHua7YXsv7HYaDp1chAP6ErPMhR18e';

function signature(raw: string, secret: string): string {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

describe('webhook signature verification', () => {
  it('accepts a correct HMAC-SHA512 and rejects tampering', () => {
    const secret = 'whsec_test';
    const raw = JSON.stringify({ type: 'payment', status: 'Paid' });
    assert.equal(verifyWebhookSignature(raw, signature(raw, secret), secret), true);
    assert.equal(verifyWebhookSignature(raw, signature(raw, 'wrong-secret'), secret), false);
    assert.equal(verifyWebhookSignature(`${raw} `, signature(raw, secret), secret), false);
    assert.equal(verifyWebhookSignature(raw, undefined, secret), false);
    assert.equal(verifyWebhookSignature(raw, signature(raw, secret), ''), false);
  });
});

describe('webhook endpoint', () => {
  it('credits once, deduplicates replays and verifies the signature', async () => {
    const env = createTestEnv();
    await env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    const webhook = startWebhookServer({ services: env.services, client: stubClient() });
    assert.ok(webhook);
    if (!webhook.server.listening) await once(webhook.server, 'listening');
    const port = (webhook.server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/webhooks/orbchain`;
    const secret = env.config.orbchain.webhookSecret;

    const body = JSON.stringify({
      type: 'payment',
      event_id: 'evt_credit_1',
      event_type: 'payment.paid',
      status: 'Paid',
      currency: 'USDT_TRC20',
      address: address.address,
      track_id: 'track_1',
      transactions: [{ tx_hash: 'wh-tx-1', coin: 'USDT_TRC20', amount: '25', confirmations: 21, status: 'CREDITED' }],
    });

    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', hmac: signature(body, secret), 'x-event-id': 'evt_credit_1' },
      body,
    });
    assert.equal(ok.status, 200);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 24_950_000n);

    // same event id -> acknowledged as a duplicate, no new credit
    const duplicate = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', hmac: signature(body, secret), 'x-event-id': 'evt_credit_1' },
      body,
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 24_950_000n);

    // new event id, same transaction hash -> still no double credit
    const replay = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', hmac: signature(body, secret), 'x-event-id': 'evt_credit_2' },
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 24_950_000n);

    // bad signature is rejected before parsing
    const rejected = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', hmac: 'deadbeef', 'x-event-id': 'evt_bad' },
      body,
    });
    assert.equal(rejected.status, 401);

    await webhook.close();
    env.close();
  });

  it('confirms a payout through the payout webhook', async () => {
    const env = createTestEnv();
    await env.services.users.ensure(USER_A);
    const address = await env.services.addresses.ensure(USER_A, 'USDT_TRC20');
    env.simulated.simulateDeposit({ userId: USER_A, asset: 'USDT_TRC20', amount: '3', address: address.address });
    await env.services.deposits.poll(Math.floor(Date.now() / 1000) - 60);

    const withdrawal = await env.services.withdrawals.create({
      userId: USER_A,
      asset: 'USDT_TRC20',
      amountBase: 2_000_000n,
      address: TRON_ADDRESS,
      interactionId: 'wh-payout-1',
    });
    assert.equal(withdrawal.status, 'confirming');

    const webhook = startWebhookServer({ services: env.services, client: stubClient() });
    assert.ok(webhook);
    if (!webhook.server.listening) await once(webhook.server, 'listening');
    const port = (webhook.server.address() as AddressInfo).port;
    const raw = JSON.stringify({
      type: 'payout',
      event_type: 'payout.confirmed',
      event_id: 'evt_payout_1',
      status: 'Confirmed',
      track_id: withdrawal.provider_track_id,
      tx_hash: 'chain-tx-1',
    });
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/orbchain`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        hmac: signature(raw, env.config.orbchain.webhookSecret),
        'x-event-id': 'evt_payout_1',
      },
      body: raw,
    });
    assert.equal(response.status, 200);
    const row = env.services.withdrawals.getForUser(USER_A, withdrawal.id);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.provider_tx_hash, 'chain-tx-1');
    assert.equal(env.services.ledger.balance(USER_A, 'USDT_TRC20'), 950_000n);

    await webhook.close();
    env.close();
  });
});
