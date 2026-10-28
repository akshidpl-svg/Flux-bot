# FluxTip bot

Production Discord bot: Node.js 22, discord.js v14, SQLite. No Convex, no external database.

The full documentation (architecture, provider integration, fee policy, VPS runbook, security, limitations) is in the [root README](../README.md).

## Commands

```bash
npm ci
cp env.template .env          # chmod 600 .env, then fill in DISCORD_TOKEN + DISCORD_CLIENT_ID
# (this sandbox blocks writing files named .env*, so the template ships as env.template;
#  on a normal machine you can also `cp env.template .env.example` and commit that)

npm run build                 # tsc -> dist/
npm run migrate               # apply SQLite migrations (also runs at startup)
npm run register              # PUT global application commands (no guild ID)
npm start                     # node dist/index.js

npm test                      # 58 tests, simulated provider only
npm run typecheck
npm run simulate -- --user <discord-id> --asset USDT_TRC20 --amount 25
npm run backup                # VACUUM INTO $BACKUP_DIR (keeps 7)
```

Development without a build (Node 22.18+ type stripping):

```bash
npm run migrate:dev
npm run register:dev
npm run dev
```

## Safety defaults

- `PROVIDER_MODE=simulated` — no real addresses, prices or payouts; everything is labelled simulated.
- `WITHDRAWALS_LIVE=false` — live payouts are refused until explicitly enabled with a live key set.
- `ADMIN_USER_IDS` — numeric Discord IDs only; empty means nobody can use `/admin`.

## Layout

```
src/core/       assets, bigint money, fees, fiat, errors
src/db/         migrations, transactions, state, backup
src/providers/  Provider interface, OrbChain client, simulated provider
src/services/   ledger, wallets, deposits, withdrawals, transfers, requests, market, stats
src/discord/    commands, registry, dispatcher, embeds, pagination
src/webhooks/   HMAC-SHA512 endpoint + event idempotency
src/jobs/       deposit poll + open-deposit refresh, payout retries, alerts, expiry, backups
deploy/         systemd, PM2, nginx, backup timer
test/           node:test suite
```

One process only. SQLite is a single-writer database and a second instance would open a second gateway session.
