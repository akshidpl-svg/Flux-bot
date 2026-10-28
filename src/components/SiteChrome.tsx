import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowUpRight, BookOpenText } from "lucide-react";
import { Link, useLocation } from "react-router";

export const DISCORD_CLIENT_ID = (
  import.meta.env.VITE_DISCORD_CLIENT_ID as string | undefined
)?.trim();

export const guildInviteUrl = DISCORD_CLIENT_ID
  ? `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=379904&scope=bot%20applications.commands`
  : null;

export const userInstallUrl = DISCORD_CLIENT_ID
  ? `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&integration_type=1&scope=applications.commands`
  : null;

export function FluxMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn("size-7", className)}
      fill="none"
    >
      <path
        d="M16 2.5 29 9.5v13L16 29.5 3 22.5v-13L16 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10 19.5 22 12.5m0 0h-7m7 0v7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  );
}

const NAV_LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#assets", label: "Assets" },
  { href: "/#fees", label: "Fees" },
  { href: "/docs", label: "Docs" },
];

export function SiteNav() {
  const { pathname } = useLocation();

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
        <Link
          to="/"
          className="group flex items-center gap-2.5 text-foreground"
          aria-label="FluxTip home"
        >
          <span className="grid size-9 place-items-center rounded-sm border border-primary/40 bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
            <FluxMark className="size-5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-base font-semibold tracking-tight">FluxTip</span>
            <span className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              discord wallet
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn(
                "font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-primary",
                pathname === link.href && "text-primary",
              )}
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="hidden cursor-pointer gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em] sm:inline-flex"
          >
            <Link to="/docs">
              <BookOpenText className="size-3.5" />
              Docs
            </Link>
          </Button>
          <Button
            asChild
            size="sm"
            className="cursor-pointer gap-1.5 font-mono text-[11px] uppercase tracking-[0.12em]"
          >
            <a
              href={guildInviteUrl ?? "/docs#quickstart"}
              {...(guildInviteUrl
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              Add to Discord
              <ArrowUpRight className="size-3.5" />
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border/60 bg-background">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <div className="flex items-center gap-2 text-primary">
            <FluxMark />
            <span className="text-base font-semibold tracking-tight text-foreground">
              FluxTip
            </span>
          </div>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            A global Discord crypto wallet and tipping bot. Custodial by design,
            ledger-backed by default. Not a bank or an exchange.
          </p>
          <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
            $0.05 flat fee · 16 display currencies · 5 assets
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Product
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/#how">
                How it works
              </a>
            </li>
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/docs#commands">
                Command reference
              </a>
            </li>
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/#fees">
                Fee policy
              </a>
            </li>
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/docs#selfhost">
                Self-host
              </a>
            </li>
          </ul>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Trust
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/docs#security">
                Security model
              </a>
            </li>
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/docs#limitations">
                Limitations
              </a>
            </li>
            <li>
              <a className="text-foreground/80 hover:text-primary" href="/docs#privacy">
                Privacy
              </a>
            </li>
            <li>
              <a
                className="text-foreground/80 hover:text-primary"
                href="https://docs.orbchain.io/"
                target="_blank"
                rel="noopener noreferrer"
              >
                OrbChain docs
              </a>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70 sm:flex-row sm:items-center sm:justify-between">
          <span>FluxTip · global commands · simulated mode by default</span>
          <span>Crypto is volatile. Fiat values are estimates.</span>
        </div>
      </div>
    </footer>
  );
}
