import type { CommandContext } from './context.ts';
import type { AnySlashCommandBuilder } from './builders.ts';

export interface Command {
  data: AnySlashCommandBuilder;
  execute(ctx: CommandContext): Promise<void>;
  /** Refuses use outside a server (Discord also hides it via contexts). */
  guildOnly?: boolean;
  /** Only IDs in ADMIN_USER_IDS may run it. */
  adminOnly?: boolean;
}
