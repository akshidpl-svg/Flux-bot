import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type EmbedBuilder,
  type InteractionUpdateOptions,
} from 'discord.js';
import { randomBytes } from 'node:crypto';

export interface PageContent {
  embeds: EmbedBuilder[];
  totalPages: number;
}

interface View {
  ownerId: string;
  render: (page: number) => Promise<PageContent>;
  createdAt: number;
}

const VIEW_TTL_MS = 10 * 60_000;

/** In-memory, per-message pagination state. Lost on restart, which just expires buttons. */
export class ViewStore {
  private views = new Map<string, View>();

  create(ownerId: string, render: (page: number) => Promise<PageContent>): string {
    this.cleanup();
    const id = randomBytes(5).toString('hex');
    this.views.set(id, { ownerId, render, createdAt: Date.now() });
    return id;
  }

  row(viewId: string, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`view:${viewId}:${page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId('view:noop')
        .setLabel(`Page ${page + 1} / ${Math.max(totalPages, 1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`view:${viewId}:${page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page + 1 >= totalPages),
    );
  }

  async handle(interaction: ButtonInteraction): Promise<boolean> {
    const [, viewId, rawPage] = interaction.customId.split(':');
    if (!viewId || rawPage === undefined) return false;
    if (viewId === 'noop') {
      await interaction.deferUpdate().catch(() => undefined);
      return true;
    }
    const view = this.views.get(viewId);
    if (!view || Date.now() - view.createdAt > VIEW_TTL_MS) {
      await interaction
        .reply({
          content: 'This menu has expired. Run the command again to see fresh data.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return true;
    }
    if (view.ownerId !== interaction.user.id) {
      await interaction
        .reply({ content: 'This paginated view belongs to someone else.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return true;
    }
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 0) return true;

    try {
      const content = await view.render(page);
      const safePage = Math.min(Math.max(page, 0), Math.max(content.totalPages - 1, 0));
      const payload: InteractionUpdateOptions = {
        embeds: content.embeds,
        components: content.totalPages > 1 ? [this.row(viewId, safePage, content.totalPages)] : [],
      };
      await interaction.update(payload);
    } catch {
      await interaction
        .reply({ content: 'Could not load that page. Please try again.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
    }
    return true;
  }

  private cleanup(): void {
    const cutoff = Date.now() - VIEW_TTL_MS;
    for (const [id, view] of this.views) {
      if (view.createdAt < cutoff) this.views.delete(id);
    }
  }
}

/** Process-wide pagination state shared by commands and the button dispatcher. */
export const views = new ViewStore();
