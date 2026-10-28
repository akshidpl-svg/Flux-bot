import { adminCommands } from './commands/admin.ts';
import { marketCommands } from './commands/market.ts';
import { serverCommands } from './commands/server.ts';
import { socialCommands } from './commands/social.ts';
import { userCommands } from './commands/user.ts';
import { walletCommands } from './commands/wallet.ts';
import type { Command } from './types.ts';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

export interface CommandCategory {
  name: string;
  commands: Command[];
}

/** Single source of truth for what is registered, documented and help-listed. */
const CATEGORIES: CommandCategory[] = [
  { name: 'Wallet', commands: walletCommands },
  { name: 'Tips & transfers', commands: socialCommands },
  { name: 'Market', commands: marketCommands },
  { name: 'Account', commands: userCommands },
  { name: 'Server', commands: serverCommands },
  { name: 'Admin', commands: adminCommands },
];

export const commands: Command[] = CATEGORIES.flatMap((category) => category.commands);

export const commandMap = new Map<string, Command>(commands.map((command) => [command.data.name, command]));

export function registeredCommands(isAdmin = false): Command[] {
  return commands.filter((command) => isAdmin || !command.adminOnly);
}

/** Help only ever lists commands that exist in the registry and get registered. */
export function commandsByCategory(isAdmin = false): { name: string; commands: { name: string; description: string }[] }[] {
  return CATEGORIES.map((category) => ({
    name: category.name,
    commands: category.commands
      .filter((command) => isAdmin || !command.adminOnly)
      .map((command) => ({
        name: command.data.name,
        description: command.data.description,
      })),
  })).filter((category) => category.commands.length > 0);
}

export function commandPayloads(): RESTPostAPIApplicationCommandsJSONBody[] {
  return commands.map((command) => command.data.toJSON());
}
