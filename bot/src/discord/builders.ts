import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
  SlashCommandStringOption,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { ASSET_ORDER, assetNetworkLabel, type AssetSymbol } from '../core/assets.ts';

export type AnySlashCommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * Commands that make sense anywhere (a wallet belongs to a user, not a server)
 * are installable by users and usable in DMs. Server/admin commands stay in guilds.
 */
export function installable<T extends AnySlashCommandBuilder>(builder: T): T {
  return builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ) as T;
}

export function guildOnly<T extends AnySlashCommandBuilder>(builder: T): T {
  return builder
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild) as T;
}

export function addAssetOption(option: SlashCommandStringOption, required = true): SlashCommandStringOption {
  return option
    .setName('asset')
    .setDescription('Crypto asset and network')
    .setRequired(required)
    .addChoices(...ASSET_ORDER.map((asset) => ({ name: assetNetworkLabel(asset), value: asset })));
}

export function assetFromOption(value: string | null): AssetSymbol {
  return value as AssetSymbol;
}
