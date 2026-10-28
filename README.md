# FluxTip

A global, multi-server Discord crypto wallet and tipping bot for **BTC, LTC, ETH, SOL and USDT (TRC-20)**.

FluxTip gives every Discord account one wallet that follows the user across every server and DM, with a SQLite-backed ledger, verified OrbChain deposits and payouts, a flat **$0.05** application fee, 16 personal display currencies, market tools, price alerts, server leaderboards and operator tooling.

> **Read this first**
>
> - The bot defaults to `PROVIDER_MODE=simulated` and `WITHDRAWALS_LIVE=false`. Simulated data is always labelled as simulated in Discord; nothing in this repository can move real funds until a live key set is configured **and** withdrawals are explicitly enabled.
> - **Never commit `.env`.** Any Discord token, OrbChain key or webhook secret that has been pasted into a chat, screenshot or commit must be rotated in the Discord Developer Portal and the OrbChain dashboard before use.
> - This repository's web directory (`src/`) is the optional marketing/docs site. **The bot uses no Convex and no external database** — see [`bot/`](bot).

---

## What is in the repository

| Path | Purpose |
| --- | --- |
| `bot/` | The product: Node.js 22 + discord.js v14 + SQLite (`better-sqlite3`), migrations, provider integration, webhook server, background jobs, tests, deployment units. |
| `src/` | Optional Freebuff/Vite marketing and documentation site (landing page + command reference). Not required to run the bot. |
| `bot/deploy/` | systemd unit, PM2 ecosystem file, backup timer, nginx TLS front for webhooks. |

The bot is deliberately independent of the web app: it runs with `node dist/index.js` and its own SQLite file.

---

## Feature summary

**Wallet (per Discord account, not per server)**
- `/wallet view`, `/balance`, `/portfolio`, `/allocation`, `/networth`, `/qr`
- `/deposit` (address + QR), `/deposits` (history and confirmations), `/address`, `/addresses`, `/addy`
- `/withdraw`, `/withdrawals`, `/fees`, `/limits`
- `/currency` — select-menu choice of 16 fiat display currencies; changing it never touches crypto balances
- `/convert` — **estimate only**, FluxTip does not execute swaps

**Tipping and transfers**
- `/tip`, `/send`, `/split` (one fee for up to 10 recipients), `/rain` (one fee per rain), `/request`, `/pay`, `/cancel request`
- `/transactions`, `/transaction <ref>`, `/receipt <ref>`, `/tipstats`, `/tipleaderboard`
- Private receipts by default; DMs are best-effort and never required for the transaction to succeed

**Market tools** — `/price`, `/prices`, `/chart`, `/calculator`, `/converter`, `/gas`, `/network`, `/explorer`, `/confirmations`, `/market`, `/gainers`, `/losers`, `/alert add|remove|list`, `/alerts`

**Account and server** — `/profile`, `/stats`, `/rank`, `/settings`, `/privacy`, `/export`, `/support`, `/help`, `/cmds`, `/ping`, `/uptime`, `/status`, `/about`, `/invite`, `/changelog`, `/report`, `/notifications`, `/notify …`, `/server stats|leaderboard|settings|notifications|fees|disable`

**Administration (ID allowlist only)** — `/admin stats|user|transactions|deposits|withdrawals|revenue|fees|limits|pause|resume|reconcile|health|logs`

62 global commands are registered. `/help` and `/cmds` are generated from the live command registry, so they only ever list commands that exist.

### Naming notes (Discord constraints)

Discord command names cannot contain spaces, so a few documented spellings map to the closest legal command:

| Documented | Registered |
| --- | --- |
| `/deposit history` | `/deposits` |
| `/withdraw history` | `/withdrawals` |
| `/wallet` | `/wallet view` (summary) and `/wallet activity` |
| `/cancel request` | `/cancel request` (a subcommand) |

### Supported assets

| Command value | Asset | Network | Decimals | Explorer |
| --- | --- | --- | --- | --- |
| `BTC` | Bitcoin | Bitcoin | 8 | mempool.space |
| `LTC` | Litecoin | Litecoin | 8 | blockchair.com |
| `ETH` | Ethereum | Ethereum | 18 | etherscan.io |
| `SOL` | Solana | Solana | 9 | solscan.io |
| `USDT_TRC20` | Tether USD | **TRON (TRC-20)** | 6 | tronscan.org |

USDT is only supported on TRON. It is never confused with USDT on Ethereum or Solana.

---

## Fee policy

A flat **$0.05 USD** application fee per completed transaction.

| Operation | How the fee is taken |
| --- | --- |
| Deposit | Withheld from the credited amount (`net = verified amount − fee`). Dust deposits that cannot cover the fee are marked `rejected` and never credited. |
| Withdrawal | Included in the requested amount; the payout is `amount − fee`. Requires `amount > fee`. |
| Tip / send / split / rain | Charged on top of the amount. If the balance cannot cover amount + fee, the fee comes out of the amount and the recipient receives the net (rule 2 in the original specification). Rain and splits are charged **once per transaction**, not per recipient. |
| Failed / rejected / cancelled | No completed-transaction fee. A failed payout refunds the amount **and** the fee, and the fee row is voided. |

Fees are converted from USD into the asset using the provider's verified USD price at transaction time; the rate, source and timestamp are stored on every fee row and shown on receipts. Rounding always rounds the fee **up** so FluxTip never under-charges. If no verified price is available, the operation is refused rather than using an invented rate.

Provider/network fees are separate: OrbChain deducts them from the merchant balance; they are not part of FluxTip's application fee and are never presented as such.

Revenue is available in `/admin revenue`; it is revenue before provider costs, refunds and other expenses.

---

## Architecture

```
bot/
  src/
    config.ts              environment parsing + fail-fast validation
    logger.ts              JSON logs with secret redaction
    core/                  assets, money (bigint base units), fees, fiat formatting, errors
    db/                    connection, versioned migrations, transactions, state, backups
    providers/             Provider interface, OrbChain v2 client, simulated provider
    services/              users, ledger, addresses, deposits, withdrawals, transfers,
                           requests, receipts, prices, fx, market, alerts, servers, stats
    discord/               client + dispatcher, command modules, embeds, pagination, registry
    webhooks/server.ts     raw-body HMAC verification + event idempotency
    jobs/                  deposit poll + open-deposit refresh, payout retry/status sync, alerts, expiry, backups
    index.ts               startup / graceful shutdown
    scripts/               migrate, register, backup, simulate
  test/                    58 tests (node:test)
  deploy/                  systemd, PM2, backup timer, nginx
```

**Money handling.** Amounts are integer base units (`bigint`) everywhere, stored as decimal strings in SQLite (ETH's 18 decimals overflow a signed 64-bit integer). No floating point is used for balances or fees; floats appear only in fiat display estimates.

**Ledger.** Every balance change goes through `LedgerService.post`, which reads the current balance, applies a signed delta, refuses negatives, and appends a ledger row with the resulting balance. A full ledger history lets any wallet be re-derived, and `/admin reconcile` verifies `sum(ledger deltas) == wallet balance` for every wallet.

**Atomicity and idempotency.**
- Writes run in `BEGIN IMMEDIATE` transactions; the bot is a single process, so writes are serialized.
- Deposits are unique per `tx_hash`; webhooks are unique per `event_id`; withdrawals are unique per Discord interaction ID **and** send a stable provider idempotency key (`fluxtip-wd-<id>`), so a timeout can be retried without a second payout.
- Tips/sends/splits/rain store an interaction-scoped idempotency key, so a retried interaction returns the original receipt.
- Payment requests use a guarded status transition (`UPDATE … WHERE status = 'open'`), so a request can never be paid twice.

**Provider abstractions.** `SimulatedProvider` implements the same interface as `OrbChainProvider`; tests and development use it exclusively. It returns deliberately fake addresses (`sim:…`, never valid on-chain formats) and its prices are labelled `simulated`.

---

## OrbChain integration

Endpoints and field names were taken from the official reference at <https://docs.orbchain.io/> (v2 API, base URL `https://orbchain.io`). No endpoint is guessed.

| Purpose | Call | Auth header |
| --- | --- | --- |
| Health | `GET /health` | none |
| Currencies, decimals, confirmations, minimum payout | `GET /v1/common/currencies` | none |
| USD prices | `GET /v1/common/prices` | none |
| Per-user permanent deposit address | `POST /v1/payment/static-address` `{currency, user_id, callback_url?}` | `merchant_api_key` |
| Payment status | `GET /v1/payment/:track_id` | `merchant_api_key` |
| Deposit history / polling backstop | `GET /v1/deposits?since=…` | `merchant_api_key` |
| Create payout | `POST /v1/payout` `{currency, address, amount, idempotency_key}` | `payout_api_key` |
| Payout status | `GET /v1/payout/:track_id` | `payout_api_key` |
| Merchant balances | `GET /v1/general/account/balance` | `general_api_key` |

**Webhooks**
- `POST /webhooks/orbchain`, raw body, **HMAC-SHA512** in the `HMAC` header, keyed with `ORBCHAIN_WEBHOOK_SECRET` (never an API key). Verification is timing-safe and happens before JSON parsing.
- `X-Event-Id` / `event_id` is the idempotency key; duplicates return `200 {duplicate:true}` without reprocessing. A failed attempt is left retryable.
- Payment events credit deposits; payout events confirm or fail withdrawals and trigger refunds. `transfer.*` and `subscription.*` events are acknowledged and ignored (FluxTip does not use OrbChain internal transfers or subscriptions).
- `GET /health` on the same port reports liveness and provider mode without secrets.

**Deposit statuses:** `pending` → `confirming` → `confirmed` (provider reported `CREDITED`), plus `failed` and `rejected` (below fee). **Withdrawal statuses:** `pending` (submission retry queued) → `confirming` → `confirmed` (provider `Confirmed`), or `failed` (refunded).

**Payout safety.** Withdrawals are only submitted when `PROVIDER_MODE=live` and `WITHDRAWALS_LIVE=true`. While withdrawals are disabled the bot refuses with a clear message and moves nothing. A retryable provider error leaves the payout `pending` and the job retries the same idempotency key; a permanent rejection refunds the user.

**What FluxTip cannot verify.** A screenshot or transaction hash supplied by a user never credits anything. Crediting requires the provider's own deposit record. If the provider is unreachable, deposits stay pending and `/status` reports degraded — no fake success.

---

## Quick start (safe, simulated)

Requirements: Node.js **22.18+** (22 LTS recommended), npm.

```bash
cd bot
npm ci

# The sandbox that produced this repository blocks writing dotfiles named .env*,
# so the template ships as bot/env.template. On your machine/VPS:
cp env.template .env            # chmod 600 .env
cp env.template .env.example    # placeholder-only template to commit

# Edit .env: DISCORD_TOKEN + DISCORD_CLIENT_ID are required.
# Keep PROVIDER_MODE=simulated and WITHDRAWALS_LIVE=false while developing.

npm run build
npm run migrate        # creates the database (also runs automatically on boot)
npm run register       # registers all commands GLOBALLY
npm start
```

Generate a test deposit without touching a blockchain:

```bash
npm run simulate -- --user 123456789012345678 --asset USDT_TRC20 --amount 25
```

The simulation goes through the real deposit-crediting code path and is labelled `SIMULATED` everywhere.

Run the tests:

```bash
npm test          # 58 tests, node:test, simulated provider only
npm run typecheck
```

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. Never log or commit. |
| `DISCORD_CLIENT_ID` | yes | Application ID used for global command registration. |
| `PROVIDER_MODE` | yes | `simulated` (default) or `live`. |
| `ORBCHAIN_MERCHANT_API_KEY` | live only | Address/payment endpoints. |
| `ORBCHAIN_PAYOUT_API_KEY` | live only | Payout endpoints. |
| `ORBCHAIN_GENERAL_API_KEY` | live only | Balance endpoint. |
| `ORBCHAIN_WEBHOOK_SECRET` | live only | HMAC-SHA512 webhook signature key. |
| `ORBCHAIN_BASE_URL` | no | Defaults to `https://orbchain.io`; must be HTTPS in live mode. |
| `ORBCHAIN_WEBHOOK_URL` | recommended | Public HTTPS URL used as `callback_url`. |
| `ORBCHAIN_WEBHOOK_PORT` | no | Default 8787. |
| `WITHDRAWALS_LIVE` | no | Default `false`. Requires `PROVIDER_MODE=live`. |
| `ADMIN_USER_IDS` | recommended | Comma-separated numeric Discord IDs. |
| `DATABASE_PATH` | no | Default `./data/fluxtip.db`. |
| `BACKUP_DIR` | no | Default `./data/backups`. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn`, `error`. |
| `MIN_WITHDRAW_USD` / `MAX_WITHDRAW_USD` | no | Defaults 1 / 1000. |
| `MAX_RAIN_RECIPIENTS` | no | Default 25, hard-capped at 50. |
| `SUPPORT_SERVER_URL`, `STATUS_PAGE_URL` | no | Shown by `/support` and `/status`. |

Secrets are never printed: the logger redacts registered secret values, bot-token patterns, 64-character hex keys and `Bearer` tokens. Admin commands cannot read keys or the webhook secret.

---

## Global commands and Discord contexts

- Commands are registered **globally** with `PUT /applications/{id}/commands`. There is no `DISCORD_GUILD_ID` and no test-guild registration anywhere.
- **Global propagation can take up to an hour** after a deploy. A freshly invited server may not show commands immediately; this is Discord behaviour, not an installation error.
- Wallet, tipping, market and account commands are installable by users (`integration_types: GuildInstall + UserInstall`) and usable in servers, bot DMs and private channels.
- `/rain` and `/server` are guild-only. `/admin` is restricted by the configured ID allowlist.
- The bot never assumes it is installed in a server, never assumes a user can receive DMs, and handles missing guild context explicitly. `Guilds` is the only gateway intent; no privileged intents are requested.

Invite links (also produced by `/invite`):
- Server: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=379904&scope=bot%20applications.commands`
- User install: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&integration_type=1&scope=applications.commands`

---

## Ubuntu VPS deployment (22.04+, Node 22+)

Assumes a fresh server, a domain for webhooks, and the repository at `https://github.com/<you>/FluxTip`.

### 1. Base packages and Node.js

```bash
sudo apt update && sudo apt install -y curl ca-certificates git ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

### 2. Service user, directories, code

```bash
sudo useradd --system --home /opt/fluxtip --shell /usr/sbin/nologin fluxtip
sudo mkdir -p /opt/fluxtip /etc/fluxtip /var/lib/fluxtip /var/backups/fluxtip
sudo git clone https://github.com/<you>/FluxTip.git /opt/fluxtip
sudo chown -R fluxtip:fluxtip /opt/fluxtip /var/lib/fluxtip /var/backups/fluxtip
cd /opt/fluxtip/bot
sudo -u fluxtip npm ci
```

### 3. Configure secrets (root-owned, not in the repo)

```bash
sudo cp /opt/fluxtip/bot/env.template /etc/fluxtip/fluxtip.env
sudo chown root:fluxtip /etc/fluxtip/fluxtip.env
sudo chmod 0640 /etc/fluxtip/fluxtip.env
sudo -e /etc/fluxtip/fluxtip.env
```

Set at least:

```dotenv
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
PROVIDER_MODE=live
ORBCHAIN_MERCHANT_API_KEY=...
ORBCHAIN_PAYOUT_API_KEY=...
ORBCHAIN_GENERAL_API_KEY=...
ORBCHAIN_WEBHOOK_SECRET=...
ORBCHAIN_WEBHOOK_URL=https://bot.example.com/webhooks/orbchain
WITHDRAWALS_LIVE=false
ADMIN_USER_IDS=<your numeric Discord ID>
DATABASE_PATH=/var/lib/fluxtip/fluxtip.db
BACKUP_DIR=/var/backups/fluxtip
NODE_ENV=production
```

Leave `WITHDRAWALS_LIVE=false` until the live deposit path, webhooks and reconciliation have been tested with small amounts.

### 4. Build, migrate, register commands

```bash
cd /opt/fluxtip/bot
sudo -u fluxtip env $(sudo cat /etc/fluxtip/fluxtip.env | grep -v '^#' | xargs) npm run build
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; node dist/db/migrate.js'
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; node dist/discord/register.js'
```

Migrations also run automatically at startup, so the explicit step is only for verification.

### 5. Run under systemd (recommended)

```bash
sudo cp /opt/fluxtip/bot/deploy/fluxtip.service /etc/systemd/system/fluxtip.service
sudo systemctl daemon-reload
sudo systemctl enable --now fluxtip
sudo systemctl status fluxtip --no-pager
```

Automatic restart after a crash is provided by `Restart=always`; after a reboot by `enable`.

Alternative: PM2

```bash
sudo npm i -g pm2
cd /opt/fluxtip/bot
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; pm2 start deploy/ecosystem.config.cjs'
sudo -u fluxtip pm2 save
sudo env PATH=$PATH pm2 startup systemd -u fluxtip --hp /opt/fluxtip
```

Keep **one** instance — SQLite has a single writer and two gateways would duplicate work.

### 6. Webhooks over TLS

```bash
sudo cp /opt/fluxtip/bot/deploy/nginx-fluxtip.conf /etc/nginx/sites-available/fluxtip
sudo ln -s /etc/nginx/sites-available/fluxtip /etc/nginx/sites-enabled/fluxtip
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d bot.example.com
```

Point OrbChain's webhook URL at `https://bot.example.com/webhooks/orbchain`. The endpoint verifies HMAC-SHA512 over the raw body; a proxy that re-serialises JSON will break it.

### 7. Backups

```bash
sudo cp /opt/fluxtip/bot/deploy/fluxtip-backup.service /etc/systemd/system/
sudo cp /opt/fluxtip/bot/deploy/fluxtip-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fluxtip-backup.timer
```

`npm run backup` uses SQLite `VACUUM INTO`, is safe while the bot is running, keeps 7 copies, and writes to `BACKUP_DIR`. The bot also runs a daily backup job internally.

**Restore procedure**

```bash
sudo systemctl stop fluxtip
sudo -u fluxtip cp /var/backups/fluxtip/fluxtip-<stamp>.db /var/lib/fluxtip/fluxtip.db
sudo -u fluxtip rm -f /var/lib/fluxtip/fluxtip.db-wal /var/lib/fluxtip/fluxtip.db-shm
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; node dist/db/migrate.js'
sudo systemctl start fluxtip
# then in Discord: /admin reconcile  and  /admin health
```

### 8. Logs

```bash
sudo journalctl -u fluxtip -f
sudo journalctl -u fluxtip --since "1 hour ago" | grep '"level":"error"'
```

Logs are single-line JSON with secrets redacted. Never enable shell tracing (`set -x`) while loading `/etc/fluxtip/fluxtip.env`.

### 9. Updating

```bash
cd /opt/fluxtip
sudo git pull --ff-only
cd bot
sudo -u fluxtip npm ci
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; npm run build'
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; node dist/db/migrate.js'
sudo -u fluxtip bash -c 'set -a; . /etc/fluxtip/fluxtip.env; set +a; node dist/discord/register.js'
sudo systemctl restart fluxtip
```

### 10. Stopping safely

```bash
sudo systemctl stop fluxtip       # SIGTERM: jobs stop, webhook server closes, SQLite closes
```

The bot is careful about crash recovery: every financial write is a single SQLite transaction, so a restart cannot leave a half-applied ledger. Pending withdrawals are retried with their original idempotency key.

### 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `DISCORD_TOKEN is required` | systemd/PM2 is not loading `/etc/fluxtip/fluxtip.env`. Check `systemctl show fluxtip -p EnvironmentFiles`. |
| Commands missing after deploy | Global commands can take up to an hour. Confirm with `/cmds` in a server where the bot was already present, and re-run `npm run register`. |
| `401 invalid_signature` in provider logs | Wrong `ORBCHAIN_WEBHOOK_SECRET`, or nginx/proxy altered the body. Check `proxy_request_buffering off`. |
| Deposits stay `confirming` | The provider has not reported `CREDITED` yet. `/status` and `/admin reconcile` show pending counts; never credit manually. |
| Withdrawal says disabled | `WITHDRAWALS_LIVE=false`. This is intentional until review; enabling it requires `PROVIDER_MODE=live` too. |
| `better-sqlite3` native error after Node upgrade | `cd bot && npm ci --build-from-source`. |
| `SQLITE_BUSY` | Another process (a CLI command, a second bot instance) is writing. Run one instance only. |
| Blank web preview | The bot is unaffected; the web site is a separate Vite app. |

---

## Security and privacy

- **Discord identity only.** The Discord user ID is the canonical user key; usernames/display names are never used for authorization.
- **Server isolation.** Server settings, notification channels and leaderboards are keyed by server ID. Server administrators can never see or access user wallets or funds.
- **Admin allowlist.** `/admin` is gated by numeric `ADMIN_USER_IDS`; every sensitive action is appended to `admin_audit` and visible through `/admin logs`.
- **Private by default.** Balances, addresses, deposits, withdrawals and receipts are ephemeral in servers. DMs are opt-out and failures are non-fatal.
- **Webhook hardening.** Timing-safe HMAC-SHA512 over the raw body, event-ID deduplication, 256 KB body cap, no secret logging, and replayed events acknowledged without reprocessing.
- **Input validation.** Every asset, amount and destination is validated; malformed, zero, negative, over-precise, burn-address and simulated addresses are rejected. Withdrawals enforce the provider's minimum payout and the configured notional limits.
- **Rate limiting.** 10 commands per 10 seconds per user; financial writes are additionally protected by database-level idempotency.
- **No secret exposure.** No admin command exposes keys or the webhook secret; `/privacy` documents what is stored; `/export` returns the user's own data.

### Emergency controls

`/admin pause` refuses new transfers and withdrawals while keeping balances, history and receipts available. `/admin resume` restores service. `/admin reconcile` is read-only and reports, rather than silently fixes, any ledger mismatch.

---

## Testing

```bash
cd bot
npm test
```

58 tests cover: migrations and idempotent re-runs, currency and notification preferences, server isolation, fee conversion and rounding, fee-from-amount behaviour, deposit crediting, duplicate deposits and webhooks, dust rejection, unknown addresses, tips, splits, rain distributions, request double-pay protection, withdrawal validation, disabled live withdrawals, provider timeouts and retries, payout failure refunds, HMAC verification, concurrent transfer races, command registry/permissions, open-deposit refresh and restart/backup recovery.

Tests use the **simulated provider only** and in-memory or temporary SQLite files.

---

## Known limitations / not implemented

FluxTip does not pretend to do things it cannot:

- **No swaps or fiat on-ramp.** `/convert` is labelled as an estimate and changes no balance.
- **No fabricated market data.** `/chart`, `/market`, `/gainers` and `/losers` use CoinGecko's public API for the five supported assets; `/gas` uses a public Ethereum JSON-RPC endpoint. If those are unavailable the commands say so. `/price` and `/prices` use OrbChain's price endpoint, whose cache is short and whose values are explicitly informational.
- **No minimum *deposit* amount.** OrbChain's public reference documents `min_payout` (used for withdrawals) and confirmation counts, not a minimum deposit; FluxTip does not invent one.
- **`/confirmations`** reports provider data for deposits FluxTip already knows about; it is not an independent chain scanner.
- **`/rain` recipients** are users who have used FluxTip in that server in the last 30 days (a documented, inspectable pool), not arbitrary members the bot has never seen.
- **DM delivery** can fail if a user blocks the bot; the transaction still succeeds and history remains available.
- **Not yet exercised against production.** The automated suite covers the simulated provider and the real code paths, but this repository was produced in an environment without a live Discord gateway session or a live OrbChain merchant account. Treat the first live deployment as a supervised test: keep `WITHDRAWALS_LIVE=false`, make a small deposit, verify the webhook, then enable payouts after review.

---

## Publishing this repository (public GitHub)

Git operations are managed by the hosting environment here, so the push was not performed. To publish:

```bash
# from the repository root
git add -A
git status --short

# Secret scan before publishing (no matches expected)
grep -RIn --exclude-dir=node_modules --exclude-dir=.git --exclude='*.lock' \
  -E '(DISCORD_TOKEN|ORBCHAIN_[A-Z_]+|WEBHOOK_SECRET)=[^[:space:]]+' . || true
grep -RIlE '(\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}\b)|(\b[a-f0-9]{64}\b)' \
  --exclude-dir=node_modules --exclude-dir=.git . || true

# If a real .env was ever committed, rewrite history before publishing:
#   git filter-repo --path .env --invert-paths
#   git filter-repo --path bot/.env --invert-paths
# then rotate every exposed credential.

gh repo create FluxTip --public --source=. --remote=origin --push
# or: git remote add origin git@github.com:<you>/FluxTip.git && git push -u origin main
```

The repository must be **public**; `.env`, API keys, tokens, webhook secrets, SQLite files and backups are ignored by `.gitignore` and must never be shipped.

A fresh clone works with the documented steps: `npm ci → cp env.template .env → npm run build → npm run migrate → npm run register → npm start`, with `PROVIDER_MODE=simulated` until live credentials are configured.
