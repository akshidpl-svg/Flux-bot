import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowUpRight,
  BookOpen,
  LayoutDashboard,
  LogOut,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useNavigate } from "react-router";

const INVITE_URL =
  "https://discord.com/oauth2/authorize?client_id=1476276303781957662&scope=bot+applications.commands&permissions=379904";


export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <main className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <LayoutDashboard className="size-4" />
              FluxTip workspace
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              Welcome{user?.name ? `, ${user.name}` : ""}
            </h1>
          </div>
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer gap-2 self-start"
            onClick={handleSignOut}
          >
            <LogOut className="size-4" />
            Sign out
          </Button>
        </header>

        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Terminal className="size-5" />
            </div>
            <CardTitle>FluxTip runs in Discord, not here</CardTitle>
            <CardDescription>
              This account is for the website only. Your wallet, balances and
              transaction history are keyed to your Discord user ID inside the
              bot&apos;s own SQLite ledger — no browser session can move funds.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button asChild className="cursor-pointer justify-between">
                <a href={INVITE_URL} target="_blank" rel="noopener noreferrer">
                  Invite FluxTip to a server
                  <ArrowUpRight className="size-4" />
                </a>
              </Button>
              <Button
                asChild
                variant="outline"
                className="cursor-pointer justify-between"
              >
                <a href="/docs">
                  Command reference
                  <BookOpen className="size-4" />
                </a>
              </Button>
            </div>

            <ol className="grid gap-3 text-sm leading-6 text-muted-foreground sm:grid-cols-3">
              <li className="rounded-lg border border-border/70 p-3">
                <span className="font-medium text-foreground">1. Invite</span>
                <br />
                Add the bot with the invite link. Global commands can take a
                few minutes to appear.
              </li>
              <li className="rounded-lg border border-border/70 p-3">
                <span className="font-medium text-foreground">2. Deposit</span>
                <br />
                Run <code className="text-foreground">/deposit</code> and send
                crypto to your own address. Balances appear after the provider
                confirms the transaction.
              </li>
              <li className="rounded-lg border border-border/70 p-3">
                <span className="font-medium text-foreground">3. Tip</span>
                <br />
                <code className="text-foreground">/tip</code>,{" "}
                <code className="text-foreground">/rain</code> and{" "}
                <code className="text-foreground">/request</code> work in any
                server and in DMs.
              </li>
            </ol>

            <div className="flex flex-col gap-3 border-t border-border/70 pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                Live withdrawals stay disabled until the provider integration
                has been reviewed and explicitly configured.
              </p>
              <Button asChild variant="ghost" size="sm" className="cursor-pointer gap-2 self-start">
                <a href="/docs">
                  <Server className="size-4" />
                  Self-hosting guide
                </a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
