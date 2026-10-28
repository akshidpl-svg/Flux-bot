import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Copy,
  Database,
  FileCode2,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  ASSET_ROWS,
  COMMAND_CATEGORIES,
  COMMAND_COUNT,
  COMMAND_ENTRY_COUNT,
  FIAT_CURRENCIES,
} from "@/data/commands";
import { cn } from "@/lib/utils";
import {
  SiteFooter,
  SiteNav,
  guildInviteUrl,
  userInstallUrl,
} from "@/components/SiteChrome";

const SECTIONS = [
  { id: "quickstart", label: "Quickstart" },
  { id: "commands", label: "Commands" },
  { id: "fees", label: "Fees" },
  { id: "assets", label: "Assets" },
  { id: "provider", label: "Provider" },
  { id: "security", label: "Security" },
  { id: "privacy", label: "Privacy" },
  { id: "selfhost", label: "Self-host" },
  { id: "limitations", label: "Limitations" },
];

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            toast.success("Copied to clipboard");
            window.setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => toast.error("Could not copy — select the text instead"));
      }}
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-border/70 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      aria-label={`Copy ${label ?? value}`}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "copied" : "copy"}
    </button>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-sm border border-border bg-card/60">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </span>
        <CopyButton value={code} label={title} />
      </div>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6 text-foreground/85">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-primary/80">
        {eyebrow}
      </span>
      <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h2>
      {children ? (
        <div className="mt-3 text-sm leading-7 text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

const TAG_STYLES: Record<string, string> = {
  server: "border-chart-2/30 bg-chart-2/10 text-chart-2",
  admin: "border-destructive/30 bg-destructive/10 text-destructive",
  user: "border-primary/30 bg-primary/10 text-primary",
};

export default function Docs() {
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const categories = COMMAND_CATEGORIES.map((category) => ({
    ...category,
    commands: normalizedQuery
      ? category.commands.filter(
          (command) =>
            command.name.toLowerCase().includes(normalizedQuery) ||
            command.description.toLowerCase().includes(normalizedQuery),
        )
      : category.commands,
  })).filter((category) => category.commands.length > 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      <div className="relative border-b border-border/60">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "linear-gradient(to right, color-mix(in oklab, var(--border) 60%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--border) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse at 30% 0%, black 10%, transparent 70%)",
          }}
        />
        <div className="relative mx-auto w-full max-w-6xl px-5 py-14">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:text-primary"
          >
            <ArrowLeft className="size-3" /> Back to overview
          </Link>
          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45 }}
            className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl"
          >
            FluxTip documentation
          </motion.h1>
          <p className="mt-4 max-w-2xl text-pretty text-sm leading-7 text-muted-foreground sm:text-base">
            Everything you need to use, audit or host the bot: how the wallet behaves,
            every registered command, the exact fee policy, the OrbChain integration and
            the deployment runbook.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge variant="outline" className="rounded-sm font-mono text-[10px]">
              {COMMAND_COUNT} commands
            </Badge>
            <Badge variant="outline" className="rounded-sm font-mono text-[10px]">
              {ASSET_ROWS.length} assets
            </Badge>
            <Badge variant="outline" className="rounded-sm font-mono text-[10px]">
              $0.05 flat fee
            </Badge>
            <Badge variant="outline" className="rounded-sm font-mono text-[10px]">
              SQLite ledger
            </Badge>
          </div>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-12 lg:grid-cols-[200px_1fr]">
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              On this page
            </p>
            <nav className="mt-3 flex flex-col gap-1.5">
              {SECTIONS.map((section) => (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  className="border-l border-border/60 py-1 pl-3 text-[13px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  {section.label}
                </a>
              ))}
            </nav>
            <Separator className="my-6 bg-border/60" />
            <a
              href="https://docs.orbchain.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-primary hover:underline"
            >
              OrbChain reference <ArrowUpRight className="size-3" />
            </a>
          </div>
        </aside>

        <main className="min-w-0 space-y-20">
          {/* Quickstart */}
          <section id="quickstart" className="scroll-mt-24">
            <SectionHeading eyebrow="01 — Quickstart" title="Three commands to a working wallet">
              FluxTip works in servers and, where Discord permits, in DMs. Commands are
              registered globally, so a newly invited server can take up to an hour to
              show them — that is Discord's cache, not a broken install.
            </SectionHeading>

            <div className="mt-7 grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                {[
                  {
                    step: "1",
                    title: "Install",
                    body: "Add the bot to a server, or install it for your account to use wallet commands privately.",
                  },
                  {
                    step: "2",
                    title: "Deposit",
                    body: "Run /deposit, choose a network, scan the QR. Your address belongs to your Discord ID, not the server.",
                  },
                  {
                    step: "3",
                    title: "Tip",
                    body: "Once the provider reports the deposit as credited, /tip, /send, /split or /rain. Receipts are private.",
                  },
                ].map((item) => (
                  <div key={item.step} className="flex gap-4">
                    <span className="grid size-7 shrink-0 place-items-center rounded-sm border border-primary/30 bg-primary/10 font-mono text-[11px] text-primary">
                      {item.step}
                    </span>
                    <div>
                      <p className="text-sm font-semibold tracking-tight">{item.title}</p>
                      <p className="mt-1 text-[13px] leading-6 text-muted-foreground">{item.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-sm border border-border bg-card/50 p-5">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Try it
                </p>
                <div className="mt-3 space-y-2 font-mono text-[12.5px]">
                  {[
                    "/deposit asset:USDT_TRC20",
                    "/wallet view",
                    "/tip user:@nova amount:2 asset:USDT_TRC20",
                    "/currency",
                  ].map((command) => (
                    <div
                      key={command}
                      className="flex items-center justify-between gap-3 rounded-sm border border-border/60 bg-background/60 px-3 py-2"
                    >
                      <code className="truncate text-foreground/85">{command}</code>
                      <CopyButton value={command} />
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    asChild
                    size="sm"
                    className="cursor-pointer gap-1.5 rounded-sm font-mono text-[10px] uppercase tracking-[0.12em]"
                  >
                    <a
                      href={guildInviteUrl ?? "#selfhost"}
                      {...(guildInviteUrl
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                    >
                      Server invite <ArrowUpRight className="size-3" />
                    </a>
                  </Button>
                  {userInstallUrl ? (
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      className="cursor-pointer gap-1.5 rounded-sm font-mono text-[10px] uppercase tracking-[0.12em]"
                    >
                      <a href={userInstallUrl} target="_blank" rel="noopener noreferrer">
                        User install <ArrowUpRight className="size-3" />
                      </a>
                    </Button>
                  ) : null}
                </div>
                <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                  No client ID is configured for this site yet, so invite buttons fall
                  back to this guide. Set <code className="text-foreground">VITE_DISCORD_CLIENT_ID</code>{" "}
                  to point them at your application.
                </p>
              </div>
            </div>

            <div className="mt-8 flex items-start gap-2.5 rounded-sm border border-chart-4/25 bg-chart-4/5 p-4 text-[12.5px] leading-6 text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-chart-4" />
              <span>
                Discord command names cannot contain spaces, so history lives at{" "}
                <code className="text-foreground">/deposits</code> and{" "}
                <code className="text-foreground">/withdrawals</code>, and the wallet
                summary is <code className="text-foreground">/wallet view</code>.
              </span>
            </div>
          </section>

          {/* Commands */}
          <section id="commands" className="scroll-mt-24">
            <SectionHeading eyebrow="02 — Reference" title="Every registered command">
              {COMMAND_ENTRY_COUNT} usages across {COMMAND_COUNT} global commands. The
              in-Discord list is generated from the same registry that is submitted to
              Discord, so a command can never be advertised without an implementation.
            </SectionHeading>

            <div className="mt-6 flex items-center gap-3">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter commands…"
                className="h-9 w-full max-w-sm rounded-sm border-border bg-card/60 font-mono text-[12px]"
                aria-label="Filter commands"
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {categories.reduce((total, category) => total + category.commands.length, 0)} shown
              </span>
            </div>

            <div className="mt-8 space-y-10">
              {categories.map((category) => (
                <div key={category.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold tracking-tight">{category.name}</h3>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                      {category.commands.length} entries
                    </span>
                  </div>
                  <p className="mt-1 max-w-2xl text-[12.5px] leading-6 text-muted-foreground">
                    {category.blurb}
                  </p>
                  <div className="mt-4 overflow-hidden rounded-sm border border-border">
                    {category.commands.map((command) => (
                      <div
                        key={command.name}
                        className="flex flex-col gap-1.5 border-b border-border/50 px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <code className="font-mono text-[12px] text-primary">{command.name}</code>
                          {command.tag ? (
                            <span
                              className={cn(
                                "rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em]",
                                TAG_STYLES[command.tag],
                              )}
                            >
                              {command.tag === "server" ? "guild only" : command.tag}
                            </span>
                          ) : null}
                        </div>
                        <span className="text-[12.5px] leading-5 text-muted-foreground sm:text-right">
                          {command.description}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Fees */}
          <section id="fees" className="scroll-mt-24">
            <SectionHeading eyebrow="03 — Fees" title="Exactly $0.05, recorded with its rate">
              The fee is flat per completed transaction. It is converted into the asset
              using a verified USD price at execution time; the price, source and
              timestamp are stored on the fee row and printed on receipts.
            </SectionHeading>

            <div className="mt-7 overflow-hidden rounded-sm border border-border">
              <div className="grid grid-cols-2 gap-3 border-b border-border bg-card/60 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>operation</span>
                <span>how the fee is applied</span>
              </div>
              {[
                ["Deposit", "Subtracted from the credited amount. Dust below the fee is rejected, never credited partially."],
                ["Withdrawal", "Included in the requested amount. Net payout = amount − fee. Amount must exceed the fee."],
                ["Tip / send", "Charged on top. If the balance cannot cover both, the fee comes out of the sent amount and the recipient gets the net."],
                ["Split", "One fee for the whole split; recipients divide the net."],
                ["Rain", "One fee per rain; recipients divide the net."],
                ["Failed / rejected", "No completed fee. A failed payout refunds the amount and the fee, and the fee record is voided."],
              ].map(([label, detail]) => (
                <div
                  key={label}
                  className="grid grid-cols-2 gap-3 border-b border-border/50 px-4 py-3 text-[12.5px] last:border-0"
                >
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="leading-6 text-muted-foreground">{detail}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-sm border border-border bg-card/40 p-4 text-[12.5px] leading-6 text-muted-foreground">
                Rounding always rounds the fee <span className="text-foreground">up</span>{" "}
                to the asset's smallest unit, so FluxTip never under-charges because of
                precision. No fee is ever calculated from an invented price.
              </div>
              <div className="rounded-sm border border-border bg-card/40 p-4 text-[12.5px] leading-6 text-muted-foreground">
                Provider and blockchain network fees are separate and deducted by
                OrbChain from the merchant balance. They are not FluxTip revenue and are
                never presented as the application fee.
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between gap-4 rounded-sm border border-border bg-background px-4 py-3">
              <code className="font-mono text-[12px] text-primary">/fees</code>
              <span className="text-[12px] text-muted-foreground">
                current policy in your display currency
              </span>
              <CopyButton value="/fees" />
            </div>
          </section>

          {/* Assets */}
          <section id="assets" className="scroll-mt-24">
            <SectionHeading eyebrow="04 — Assets" title="Networks are part of the asset name">
              USDT is supported on TRON (TRC-20) only. It is never treated as USDT on
              Ethereum or Solana, and every deposit screen repeats the network.
            </SectionHeading>

            <div className="mt-6 overflow-hidden rounded-sm border border-border">
              <div className="grid grid-cols-[0.8fr_1.2fr_0.7fr_0.8fr] gap-2 border-b border-border bg-card/60 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                <span>value</span>
                <span>asset</span>
                <span>network</span>
                <span className="text-right">decimals</span>
              </div>
              {ASSET_ROWS.map((asset) => (
                <div
                  key={asset.symbol}
                  className="grid grid-cols-[0.8fr_1.2fr_0.7fr_0.8fr] items-center gap-2 border-b border-border/50 px-4 py-3 text-[12.5px] last:border-0"
                >
                  <span className="font-mono text-[11px] text-primary">
                    {asset.symbol === "USDT" ? "USDT_TRC20" : asset.symbol}
                  </span>
                  <span>{asset.name}</span>
                  <span className="text-muted-foreground">{asset.network}</span>
                  <span className="text-right font-mono text-[11px] text-muted-foreground">
                    {asset.decimals}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-4 text-[12.5px] leading-6 text-muted-foreground">
              Display currencies: {FIAT_CURRENCIES.join(", ")}. Changing the display
              currency never changes a balance or a transaction amount; it only changes
              the fiat estimate shown beside them.
            </p>
          </section>

          {/* Provider */}
          <section id="provider" className="scroll-mt-24">
            <SectionHeading eyebrow="05 — Provider" title="OrbChain, verified against its reference">
              The integration follows the documented v2 API at{" "}
              <a
                href="https://docs.orbchain.io/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                docs.orbchain.io
              </a>
              . No endpoint, field or feature is assumed.
            </SectionHeading>

            <div className="mt-6 space-y-4">
              <div className="overflow-hidden rounded-sm border border-border">
                {[
                  ["POST /v1/payment/static-address", "merchant_api_key", "Permanent per-user deposit address"],
                  ["GET /v1/deposits?since=", "merchant_api_key", "Polling backstop for missed webhooks"],
                  ["POST /v1/payout", "payout_api_key", "Withdrawal submission with idempotency key"],
                  ["GET /v1/payout/:track_id", "payout_api_key", "Confirming / Confirmed / Failed status"],
                  ["GET /v1/common/currencies", "none", "Decimals, confirmations, minimum payout"],
                  ["GET /v1/common/prices", "none", "USD prices used for fee conversion"],
                  ["GET /v1/general/account/balance", "general_api_key", "Reconciliation against liabilities"],
                ].map(([endpoint, auth, purpose]) => (
                  <div
                    key={endpoint}
                    className="flex flex-col gap-1 border-b border-border/50 px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <code className="text-[11.5px] text-primary">{endpoint}</code>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-muted-foreground">
                      {auth}
                    </span>
                    <span className="text-[12px] text-muted-foreground sm:text-right">{purpose}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-sm border border-border bg-card/40 p-4">
                <div className="flex items-center gap-2">
                  <KeyRound className="size-4 text-primary" />
                  <p className="text-sm font-semibold">Webhook contract</p>
                </div>
                <ul className="mt-3 space-y-2 text-[12.5px] leading-6 text-muted-foreground">
                  <li>
                    <span className="text-foreground">HMAC-SHA512</span> over the raw body, sent
                    in the <code>HMAC</code> header, keyed with the webhook secret — never an
                    API key.
                  </li>
                  <li>
                    <span className="text-foreground">X-Event-Id</span> is the idempotency key.
                    Duplicates are acknowledged without reprocessing; failed attempts stay
                    retryable.
                  </li>
                  <li>Payment events credit deposits. Payout events confirm or fail withdrawals and trigger refunds.</li>
                  <li>Transfer and subscription events are acknowledged and ignored.</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Security */}
          <section id="security" className="scroll-mt-24">
            <SectionHeading eyebrow="06 — Security" title="Accounting that survives a restart">
              Every balance change is one SQLite transaction with a ledger row. Pending
              payouts are retried with their original provider idempotency key, so a
              crash or timeout can never double-pay.
            </SectionHeading>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {[
                {
                  icon: Database,
                  title: "Atomic ledger",
                  body: "Wallet balances are derived from signed ledger deltas; negatives are refused at the write path.",
                },
                {
                  icon: ShieldCheck,
                  title: "Verified webhooks",
                  body: "Timing-safe signature comparison over raw bytes, event dedupe and a 256 KB body cap.",
                },
                {
                  icon: LockKeyhole,
                  title: "Least privilege",
                  body: "No privileged Discord intents. Admin access is an explicit numeric ID allowlist with audit logging.",
                },
                {
                  icon: Server,
                  title: "Operator controls",
                  body: "Emergency pause keeps history read-only. Reconciliation reports mismatches instead of hiding them.",
                },
              ].map((item) => (
                <div key={item.title} className="rounded-sm border border-border p-4">
                  <item.icon className="size-4 text-primary" />
                  <p className="mt-3 text-sm font-semibold">{item.title}</p>
                  <p className="mt-1 text-[12.5px] leading-6 text-muted-foreground">{item.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Privacy */}
          <section id="privacy" className="scroll-mt-24">
            <SectionHeading eyebrow="07 — Privacy" title="What is stored, and what is not">
              FluxTip stores the Discord user ID (never usernames), balances and ledger
              history, deposit addresses, provider references, display currency and
              notification preferences. Server settings are keyed by server ID.
            </SectionHeading>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-sm border border-border p-4 text-[12.5px] leading-6 text-muted-foreground">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                  Never public by default
                </p>
                Balances, addresses, deposits, withdrawals and receipts are ephemeral in
                servers. Server administrators never receive access to a user's wallet.
              </div>
              <div className="rounded-sm border border-border p-4 text-[12.5px] leading-6 text-muted-foreground">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                  Never logged
                </p>
                Bot tokens, API keys, webhook secrets, passwords and private keys. Logs
                are structured JSON with value redaction.
              </div>
            </div>
            <p className="mt-4 text-[12.5px] leading-6 text-muted-foreground">
              <code className="text-foreground">/export</code> returns everything FluxTip
              stores for you as JSON. <code className="text-foreground">/privacy</code>{" "}
              explains deletion, which is processed after balances and withdrawals are
              cleared.
            </p>
          </section>

          {/* Self-host */}
          <section id="selfhost" className="scroll-mt-24">
            <SectionHeading eyebrow="08 — Self-host" title="Ubuntu 22.04+, Node 22+, one process">
              The bot package is self-contained: discord.js v14, SQLite via
              better-sqlite3, no Convex and no external database. The full runbook lives
              in the repository README.
            </SectionHeading>

            <div className="mt-6 space-y-4">
              <CodeBlock
                title="install & first run (simulated)"
                code={`cd bot
npm ci
cp env.template .env          # chmod 600; fill DISCORD_TOKEN + DISCORD_CLIENT_ID
npm run build
npm run migrate
npm run register              # global commands, no guild ID
npm start`}
              />
              <CodeBlock
                title="systemd"
                code={`sudo cp deploy/fluxtip.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fluxtip
sudo journalctl -u fluxtip -f`}
              />
              <CodeBlock
                title="tests"
                code={`cd bot
npm test        # 78 tests, simulated provider only
npm run typecheck`}
              />
            </div>

            <div className="mt-5 flex items-start gap-2.5 rounded-sm border border-border bg-card/40 p-4 text-[12.5px] leading-6 text-muted-foreground">
              <FileCode2 className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>
                Secrets belong in <code className="text-foreground">/etc/fluxtip/fluxtip.env</code>{" "}
                (root-owned, 0640), on the VPS only. Keep{" "}
                <code className="text-foreground">WITHDRAWALS_LIVE=false</code> until the
                live deposit and webhook path has been reviewed with a small test amount.
              </span>
            </div>
          </section>

          {/* Limitations */}
          <section id="limitations" className="scroll-mt-24">
            <SectionHeading eyebrow="09 — Limitations" title="What FluxTip deliberately does not do" />
            <div className="mt-5 space-y-3">
              {[
                "No swaps or fiat on-ramp. /convert is an estimate and changes no balance.",
                "No invented prices, addresses, confirmations or transaction success. Unavailable provider data is reported as unavailable.",
                "No minimum deposit figure: OrbChain documents minimum payout and confirmation counts, not a minimum deposit.",
                "Rain uses an inspectable pool of users who used FluxTip in that server within 30 days.",
                "DM notifications can fail if a user blocks the bot; transactions still succeed and remain in history.",
                "This build has not been exercised against a live Discord gateway or a live OrbChain merchant account. Treat the first live deployment as supervised.",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-2.5 border-b border-border/50 pb-3 text-[12.5px] leading-6 text-muted-foreground last:border-0"
                >
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-chart-4" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <div className="mt-8 rounded-sm border border-primary/25 bg-primary/5 p-5">
              <div className="flex items-start gap-3">
                <Terminal className="mt-0.5 size-4 text-primary" />
                <div>
                  <p className="text-sm font-semibold">Simulated mode is labelled everywhere</p>
                  <p className="mt-1 text-[12.5px] leading-6 text-muted-foreground">
                    Development and tests use an in-process provider. Its addresses begin
                    with <code className="text-foreground">sim:</code>, its prices are marked
                    simulated, and Discord embeds carry a SIMULATED footer. It can never
                    present fake activity as a real blockchain event.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>

      <SiteFooter />
    </div>
  );
}
