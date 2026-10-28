import { motion } from "framer-motion";
import { ArrowLeft, Compass } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-md border border-border bg-card/50 p-8 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-sm border border-primary/30 bg-primary/10 text-primary">
            <Compass className="size-5" />
          </div>
          <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Error 404
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">No route here</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            This page does not exist. The wallet lives in Discord — the site only holds
            the overview and the command reference.
          </p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button asChild className="cursor-pointer gap-2 rounded-sm font-mono text-[11px] uppercase tracking-[0.12em]">
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                Overview
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="cursor-pointer rounded-sm font-mono text-[11px] uppercase tracking-[0.12em]"
            >
              <Link to="/docs">Documentation</Link>
            </Button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
