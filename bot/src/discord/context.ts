import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionReplyOptions,
  type InteractionEditReplyOptions,
} from 'discord.js';
import type { Services } from '../services/index.ts';

export interface CommandContext {
  interaction: ChatInputCommandInteraction;
  client: Client;
  services: Services;
  userId: string;
  guildId: string | null;
  commandName: string;
  subcommand: string | null;
  subcommandGroup: string | null;
}

/** Ephemeral replies are used in servers; DMs are already private. */
export function privateFlag(interaction: ChatInputCommandInteraction): number | undefined {
  return interaction.inGuild() ? MessageFlags.Ephemeral : undefined;
}

export async function deferPrivate(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferReply({ flags: privateFlag(interaction) });
}

export async function replyPrivate(
  interaction: ChatInputCommandInteraction,
  payload: InteractionReplyOptions | InteractionEditReplyOptions,
): Promise<void> {
  if (interaction.deferred) {
    await interaction.editReply(payload as InteractionEditReplyOptions);
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ ...(payload as InteractionReplyOptions), flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ ...(payload as InteractionReplyOptions), flags: privateFlag(interaction) });
}

export function displayName(interaction: ChatInputCommandInteraction): string {
  return interaction.user.globalName ?? interaction.user.username;
}

export function guildLabel(interaction: ChatInputCommandInteraction): string {
  return interaction.guild?.name ?? 'Direct messages';
}

export function channelId(interaction: ChatInputCommandInteraction): string | null {
  return interaction.channelId ?? null;
}

/** Ensures a command only runs inside a guild, without a guild ID hardcoded. */
export function requireGuild(ctx: CommandContext): string {
  if (!ctx.guildId || !ctx.interaction.inGuild()) {
    throw new Error('This command can only be used inside a Discord server.');
  }
  return ctx.guildId;
}
