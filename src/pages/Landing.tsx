import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  ASSET_ROWS,
  COMMAND_CATEGORIES,
  COMMAND_COUNT,
  FIAT_CURRENCIES,
} from "@/data/commands";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDollarSign,
  Fingerprint,
  Gauge,
  Globe2,
  LockKeyhole,
  QrCode,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { SiteFooter, SiteNav, guildInviteUrl } from "@/components/SiteChrome";

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as const },
};

const HERO_STATS = [
  { label: "global commands", value: String(COMMAND_COUNT) },
  { label: "flat fee", value: "$0.05" },
  { label: "display currencies", value: String(FIAT_CURRENCIES.length) },
  { label: "supported assets", value: String(ASSET_ROWS.length) },
];

const FEATURES = [
  {
    icon: Fingerprint,
    title: "One wallet, every server",
    body: "Your Discord user ID is the account. Balances, history and preferences follow you across servers and DMs — there is no separate wallet per guild.",
  },
  {
    icon: Zap,
    title: "Tips that settle instantly",
    body: "Tips, sends, splits and rain are atomic ledger moves. The sender is debited once, each recipient credited once, and a retried interaction returns the original receipt.",
  },
  {
    icon: QrCode,
    title: "Deposits you can verify",
    body: "Per-user BTC, LTC, ETH, SOL and USDT (TRC-20) addresses, with QR codes and confirmation progress. Credit happens only after the provider reports it.",
  },
  {
    icon: ShieldCheck,
    title: "Withdrawals that wait",
    body: "Destination validation, notional limits, provider minimums and a stable payout idempotency key. Live payouts stay disabled until explicitly switched on.",
  },
  {
    icon: CircleDollarSign,
    title: "One honest fee",
    body: "A flat $0.05 per completed transaction, converted at a recorded rate. Failed, rejected and cancelled transactions are never charged.",
  },
  {
    icon: Globe2,
    title: "16 display currencies",
    body: "Choose USD, EUR, GBP, INR, CAD, AUD, NZD, CHF, JPY, SGD, AED, SAR, TRY, BRL, PHP or ZAR. Display only — your crypto never changes.",
  },
  {
    icon: Gauge,
    title: "Market tools with sources",
    body: "Prices, charts, movers, gas and alerts, each with its source and observation time. If a provider is down, FluxTip says so instead of inventing a number.",
  },
  {
    icon: LockKeyhole,
    title: "Private by default",
    body: "Balances, addresses, deposits and receipts are ephemeral in servers. Server admins get aggregate stats, never your wallet or funds.",
  },
];

const STEPS = [
  {
    n: "01",
    title: "Invite or install",
    body: "Add FluxTip to a server, or install it for your account to use wallet commands in DMs where Discord permits it.",
  },
  {
    n: "02",
    title: "Get your address",
    body: "Run /deposit, pick an asset and network, then scan the QR. The address is bound to your Discord ID and works everywhere.",
  },
  {
    n: "03",
    title: "Tip from chat",
    body: "Wait for the provider to credit the deposit, then /tip, /send, /split or /rain. Receipts are private and reference the ledger.",
  },
];

const SECURITY_POINTS = [
  "Ledger-based accounting: every balance change is a row, and reconciliation compares wallets to their full history.",
  "HMAC-SHA512 webhook verification over the raw body, with event-ID deduplication and a body size cap.",
  "Withdrawals are unique per interaction and use the provider's idempotency key, so a timeout can never become a double payout.",
  "Administrators are identified by numeric Discord ID, every sensitive action is audited, and no admin command exposes keys.",
];

const LIMITATIONS = [
  "/convert is an estimate. FluxTip does not execute swaps or fiat on-ramps.",
  "Charts, movers and gas depend on public providers (CoinGecko, Ethereum RPC). Unavailable data is reported, never fabricated.",
  "Rain recipients are users who used FluxTip in that server in the last 30 days — an inspectable pool, not arbitrary members.",
  "Live payouts ship disabled and must be reviewed and enabled by the operator.",
];

function MonoLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function CommandRow({ command, detail }: { command: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border/50 py-3 last:border-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <code className="font-mono text-[13px] text-primary">{command}</code>
      <span className="text-sm text-muted-foreground sm:text-right">{detail}</span>
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteNav />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, color-mix(in oklab, var(--border) 60%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklab, var(--border) 60%, transparent) 1px, transparent 1px)",
            backgroundSize: "64px 64px",
            maskImage: "radial-gradient(ellipse at 50% 0%, black 20%, transparent 72%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 h-[540px] w-[900px] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in oklab, var(--primary) 55%, transparent), transparent)",
          }}
        />

        <div className="relative mx-auto grid w-full max-w-6xl gap-14 px-5 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-28">
          <div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
              <Badge
                variant="outline"
                className="gap-2 rounded-sm border-primary/30 bg-primary/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-primary"
              >
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-70" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                </span>
                Global multi-server bot · OrbChain settled
              </Badge>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.05 }}
              className="mt-6 text-balance text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
            >
              Tip crypto at the
              <br />
              speed of{" "}
              <span className="relative whitespace-nowrap text-primary">
                chat.
                <svg
                  aria-hidden
                  viewBox="0 0 240 12"
                  className="absolute -bottom-2 left-0 h-2.5 w-full text-primary/45"
                  preserveAspectRatio="none"
                >
                  <path d="M2 8c60-6 120-6 236-3" stroke="currentColor" strokeWidth="3" fill="none" />
                </svg>
              </span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.12 }}
              className="mt-6 max-w-xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8"
            >
              FluxTip gives every Discord account a real crypto wallet: deposits with
              verified confirmations, instant tips and rain, guarded withdrawals and
              receipts that actually reconcile. One flat fee, no per-server wallets,
              no invented numbers.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.18 }}
              className="mt-8 flex flex-col gap-3 sm:flex-row"
            >
              <Button
                asChild
                size="lg"
                className="cursor-pointer gap-2 rounded-sm px-6 font-mono text-xs uppercase tracking-[0.14em]"
              >
                <a
                  href={guildInviteUrl ?? "/docs#quickstart"}
                  {...(guildInviteUrl
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  Add FluxTip to Discord
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="cursor-pointer gap-2 rounded-sm border-border px-6 font-mono text-xs uppercase tracking-[0.14em]"
              >
                <Link to="/docs#commands">
                  Browse {COMMAND_COUNT} commands
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </motion.div>

            <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
              {HERO_STATS.map((stat) => (
                <div key={stat.label} className="flex flex-col">
                  <span className="font-mono text-lg tracking-tight text-foreground">{stat.value}</span>
                  <MonoLabel className="mt-0.5 text-[9px] tracking-[0.18em]">{stat.label}</MonoLabel>
                </div>
              ))}
            </div>
          </div>

          {/* Terminal card */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="relative"
          >
            <div className="absolute -inset-3 rounded-md border border-primary/10" aria-hidden />
            <div className="relative overflow-hidden rounded-sm border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-destructive/70" />
                  <span className="size-2 rounded-full bg-chart-4/70" />
                  <span className="size-2 rounded-full bg-primary/70" />
                </div>
                <MonoLabel className="text-[9px]">#trading-desk</MonoLabel>
                <MonoLabel className="text-[9px] text-primary/80">flux@bot</MonoLabel>
              </div>

              <div className="space-y-4 px-4 py-5 font-mono text-[12.5px] leading-6">
                <div className="text-muted-foreground">
                  <span className="text-primary/70">$</span> /deposit asset:USDT
                </div>
                <div className="rounded-sm border border-border/60 bg-background/60 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      USDT · TRON (TRC-20)
                    </span>
                    <span className="text-[10px] text-primary">waiting</span>
                  </div>
                  <div className="mt-2 break-all text-foreground/90">TRrqEHua7YXsv7HYaDp1chAP6ErPMhR18e</div>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>19 confirmations required</span>
                    <span>QR attached</span>
                  </div>
                </div>

                <div className="text-muted-foreground">
                  <span className="text-primary/70">$</span> /tip user:@nova amount:5 asset:USDT
                </div>
                <div className="rounded-sm border border-primary/25 bg-primary/5 p-3">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.16em]">
                    <span className="text-primary">tip receipt</span>
                    <span className="text-muted-foreground">tip_7C4A19B2</span>
                  </div>
                  <div className="mt-3 space-y-1.5 text-[11.5px]">
                    {[
                      ["amount", "5.00 USDT"],
                      ["fee", "0.05 USDT"],
                      ["net to @nova", "5.00 USDT"],
                      ["status", "completed"],
                    ].map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <span className="text-muted-foreground">{key}</span>
                        <span className={key === "status" ? "text-primary" : "text-foreground/90"}>
                          {value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>🔒 ephemeral · only you can see this</span>
                  <span>rate recorded</span>
                </div>
              </div>
            </div>
            <p className="mt-3 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60">
              Illustrative receipt · live numbers come from the provider
            </p>
          </motion.div>
        </div>
      </section>

      {/* Asset ticker */}
      <div className="overflow-hidden border-b border-border/60 bg-card/40">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-4">
          {ASSET_ROWS.map((asset) => (
            <div key={asset.symbol} className="flex items-center gap-2.5">
              <span className="grid size-7 place-items-center rounded-sm border border-border/70 bg-background font-mono text-[10px] text-primary">
                {asset.symbol.slice(0, 1)}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/85">
                {asset.symbol}
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                {asset.network}
              </span>
            </div>
          ))}
          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground/70">
            USDT on TRON only
          </span>
        </div>
      </div>

      {/* How it works */}
      <section id="how" className="border-b border-border/60">
        <div className="mx-auto w-full max-w-6xl px-5 py-20">
          <motion.div {...fadeUp} className="max-w-2xl">
            <MonoLabel>01 — How it works</MonoLabel>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              A wallet that belongs to a person, not a guild.
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              Discord is the identity layer. FluxTip keeps one ledger per account, and
              each server only stores its own settings. Leave a server and your balance
              is still there; join a new one and your address is the same.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-sm border border-border bg-border md:grid-cols-3">
            {STEPS.map((step, index) => (
              <motion.div
                key={step.n}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: index * 0.08 }}
                className="group relative bg-background p-7 transition-colors hover:bg-card/60"
              >
                <span className="font-mono text-[11px] tracking-[0.2em] text-primary/70">{step.n}</span>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.body}</p>
                <ArrowRight className="mt-6 size-4 text-muted-foreground/40 transition-all group-hover:translate-x-1 group-hover:text-primary" />
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-b border-border/60">
        <div className="mx-auto w-full max-w-6xl px-5 py-20">
          <motion.div {...fadeUp} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <MonoLabel>02 — What is inside</MonoLabel>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Built like a ledger, not a leaderboard.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              Every promise below maps to code in the bot package, with tests around the
              accounting path.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-sm border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature, index) => (
              <motion.div
                key={feature.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: (index % 4) * 0.06 }}
                className="bg-background p-6 transition-colors hover:bg-card/60"
              >
                <feature.icon className="size-5 text-primary" strokeWidth={1.6} />
                <h3 className="mt-5 text-[15px] font-semibold tracking-tight">{feature.title}</h3>
                <p className="mt-2 text-[13.5px] leading-6 text-muted-foreground">{feature.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Assets */}
      <section id="assets" className="border-b border-border/60">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 lg:grid-cols-[0.9fr_1.1fr]">
          <motion.div {...fadeUp}>
            <MonoLabel>03 — Assets & networks</MonoLabel>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Five assets. One network each.
            </h2>
            <p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">
              FluxTip shows the network next to every asset so nobody sends USDT on the
              wrong chain. Deposits are credited from the provider's record — never from
              a screenshot or a transaction hash a user pastes.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {FIAT_CURRENCIES.map((code) => (
                <span
                  key={code}
                  className="rounded-sm border border-border/70 px-2 py-1 font-mono text-[10px] tracking-[0.1em] text-muted-foreground"
                >
                  {code}
                </span>
              ))}
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              personal display currencies
            </p>
          </motion.div>

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
            <div className="overflow-hidden rounded-sm border border-border">
              <div className="grid grid-cols-[1fr_1.2fr_0.7fr] gap-3 border-b border-border bg-card/60 px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-muted-foreground sm:grid-cols-[0.9fr_1.3fr_0.6fr_0.7fr]">
                <span>asset</span>
                <span>network</span>
                <span className="hidden sm:block">decimals</span>
                <span className="text-right">explorer</span>
              </div>
              {ASSET_ROWS.map((asset) => (
                <div
                  key={asset.symbol}
                  className="grid grid-cols-[1fr_1.2fr_0.7fr] items-center gap-3 border-b border-border/50 px-4 py-3.5 last:border-0 sm:grid-cols-[0.9fr_1.3fr_0.6fr_0.7fr]"
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-[12px] text-foreground">{asset.symbol}</span>
                    <span className="text-[11px] text-muted-foreground">{asset.name}</span>
                  </div>
                  <span className="text-[12.5px] text-foreground/85">{asset.network}</span>
                  <span className="hidden font-mono text-[11px] text-muted-foreground sm:block">
                    {asset.decimals}
                  </span>
                  <span className="text-right font-mono text-[10px] text-muted-foreground">
                    {asset.explorer}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-start gap-2 text-[11.5px] leading-5 text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-chart-4" />
              Wrong-network deposits cannot be recovered by FluxTip. The deposit screen
              repeats the network on every address.
            </div>
          </motion.div>
        </div>
      </section>

      {/* Fees */}
      <section id="fees" className="border-b border-border/60 bg-card/30">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 lg:grid-cols-[0.85fr_1.15fr]">
          <motion.div {...fadeUp}>
            <MonoLabel>04 — Fees</MonoLabel>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              One number to remember.
            </h2>
            <div className="mt-8 flex items-baseline gap-3">
              <span className="text-6xl font-bold tracking-tighter text-primary">$0.05</span>
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                per completed
                <br />
                transaction
              </span>
            </div>
            <p className="mt-5 max-w-sm text-sm leading-7 text-muted-foreground">
              Converted into the asset at a verified rate, with the rate, source and
              timestamp stored on the fee record. No fee confirmation prompts — just
              receipts you can audit with /fees.
            </p>
            <Button
              asChild
              variant="outline"
              className="mt-7 cursor-pointer gap-2 rounded-sm font-mono text-[11px] uppercase tracking-[0.14em]"
            >
              <Link to="/docs#fees">
                Read the fee rules
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </motion.div>

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
            <div className="overflow-hidden rounded-sm border border-border bg-background">
              <div className="border-b border-border bg-card/60 px-5 py-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                Fee application matrix
              </div>
              <div className="divide-y divide-border/60">
                {[
                  ["Deposit", "Withheld from the credited amount"],
                  ["Withdrawal", "Included in the amount; payout is net"],
                  ["Tip / send", "On top of the amount, or taken from it if needed"],
                  ["Split", "Once per split, not per recipient"],
                  ["Rain", "Once per rain, not per recipient"],
                  ["Failed / rejected", "No fee. Failed payouts refund the fee too"],
                ].map(([label, detail]) => (
                  <div key={label} className="flex items-start justify-between gap-6 px-5 py-3.5">
                    <span className="flex items-center gap-2 text-[13px] font-medium">
                      <Check className="size-3.5 text-primary" />
                      {label}
                    </span>
                    <span className="max-w-[55%] text-right text-[12.5px] leading-5 text-muted-foreground">
                      {detail}
                    </span>
                  </div>
                ))}
              </div>
              <div className="border-t border-border bg-card/40 px-5 py-3 font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground/80">
                Provider and network fees are separate from FluxTip's fee
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Commands */}
      <section id="commands" className="border-b border-border/60">
        <div className="mx-auto w-full max-w-6xl px-5 py-20">
          <motion.div {...fadeUp} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <MonoLabel>05 — Commands</MonoLabel>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                {COMMAND_COUNT} global commands, no dead entries.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              /help and /cmds are generated from the live registry, so the bot can only
              advertise what it actually implements.
            </p>
          </motion.div>

          <div className="mt-12 grid gap-10 md:grid-cols-2">
            {COMMAND_CATEGORIES.slice(0, 4).map((category, index) => (
              <motion.div
                key={category.id}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: (index % 2) * 0.08 }}
              >
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-semibold tracking-tight">{category.name}</h3>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                    {category.commands.length} entries
                  </span>
                </div>
                <div className="mt-3">
                  {category.commands.slice(0, 4).map((command) => (
                    <CommandRow
                      key={command.name}
                      command={command.name}
                      detail={command.description}
                    />
                  ))}
                </div>
              </motion.div>
            ))}
          </div>

          <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-sm border border-border bg-card/40 p-5 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 size-4 text-primary" />
              <div>
                <p className="text-sm font-medium">Wallet · tips · rain · requests · market · admin</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Full usage, tags and fee notes for every command.
                </p>
              </div>
            </div>
            <Button
              asChild
              className="cursor-pointer gap-2 rounded-sm font-mono text-[11px] uppercase tracking-[0.14em]"
            >
              <Link to="/docs#commands">
                Open the reference
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Security + limitations */}
      <section className="border-b border-border/60">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-5 py-20 lg:grid-cols-2">
          <motion.div {...fadeUp}>
            <MonoLabel>06 — Security</MonoLabel>
            <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
              The boring guarantees matter most.
            </h2>
            <ul className="mt-7 space-y-4">
              {SECURITY_POINTS.map((point) => (
                <li key={point} className="flex gap-3 text-[13.5px] leading-6 text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" strokeWidth={1.7} />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <Link
              to="/docs#security"
              className="mt-6 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-primary hover:underline"
            >
              Full security model <ArrowRight className="size-3" />
            </Link>
          </motion.div>

          <motion.div {...fadeUp} transition={{ ...fadeUp.transition, delay: 0.1 }}>
            <div className="rounded-sm border border-border bg-card/40 p-6">
              <div className="flex items-center gap-2">
                <TriangleAlert className="size-4 text-chart-4" />
                <h3 className="text-sm font-semibold tracking-tight">What FluxTip will not do</h3>
              </div>
              <ul className="mt-4 space-y-3">
                {LIMITATIONS.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[13px] leading-6 text-muted-foreground">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-chart-4" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <Separator className="my-5 bg-border/60" />
              <p className="text-[12.5px] leading-6 text-muted-foreground">
                FluxTip is a custodial tipping service. It is not a bank, exchange or
                investment product, and fiat values shown anywhere are estimates rather
                than guaranteed execution prices.
              </p>
            </div>
          </motion.div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            background:
              "radial-gradient(60% 80% at 50% 100%, color-mix(in oklab, var(--primary) 45%, transparent), transparent)",
          }}
        />
        <div className="relative mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-8 px-5 py-20 lg:flex-row lg:items-center">
          <div>
            <MonoLabel className="text-primary/80">Ready when you are</MonoLabel>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight sm:text-4xl">
              Put a wallet behind every hello.
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-7 text-muted-foreground">
              Invite FluxTip, generate an address, and start tipping. Keep the defaults
              until you have reviewed the live provider path — the bot is safe by
              omission, not by promise.
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <Button
              asChild
              size="lg"
              className="cursor-pointer gap-2 rounded-sm px-6 font-mono text-xs uppercase tracking-[0.14em]"
            >
              <a
                href={guildInviteUrl ?? "/docs#quickstart"}
                {...(guildInviteUrl
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                Add to Discord
                <ArrowUpRight className="size-4" />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="cursor-pointer gap-2 rounded-sm px-6 font-mono text-xs uppercase tracking-[0.14em]"
            >
              <Link to="/docs#selfhost">
                <ReceiptText className="size-4" />
                Self-host guide
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
