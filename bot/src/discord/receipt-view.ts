import { ASSETS, assetNetworkLabel, assetTicker, type AssetSymbol } from '../core/assets.ts';
import type { EmbedBuilder } from 'discord.js';
import { formatUnits } from '../core/money.ts';
import type { DepositRow } from '../services/deposits.ts';
import type { RateQuote } from '../services/fx.ts';
import type { ReceiptView } from '../services/receipts.ts';
import type { RainResult, TransferReceipt } from '../services/transfers.ts';
import type { WithdrawalRow } from '../services/withdrawals.ts';
import { COLORS, baseEmbed, fiatFromUsd, fxNote, statusBadge, timestamp } from './embeds.ts';

export interface EmbedContextFlags {
  simulated: boolean;
}

function amount(asset: AssetSymbol, base: bigint): string {
  return `${formatUnits(base, ASSETS[asset].decimals)} ${assetTicker(asset)}`;
}

function usdLine(asset: AssetSymbol, base: bigint, rate: RateQuote): string {
  const whole = Number(formatUnits(base, ASSETS[asset].decimals));
  return `${amount(asset, base)} · ${fiatFromUsd(whole, rate)}`;
}

export function transferEmbed(
  flags: EmbedContextFlags,
  receipt: TransferReceipt,
  rate: RateQuote,
): EmbedBuilder {
  const title =
    receipt.kind === 'rain'
      ? 'Rain receipt'
      : receipt.kind === 'tip'
        ? 'Tip receipt'
        : receipt.kind === 'send'
          ? 'Transfer receipt'
          : receipt.kind === 'request'
            ? 'Payment request receipt'
            : 'Split receipt';
  const embed = baseEmbed(flags, COLORS.success)
    .setTitle(title)
    .setDescription(`Reference \`${receipt.groupId}\``)
    .addFields(
      { name: 'Amount', value: usdLine(receipt.asset, receipt.grossBase, rate), inline: true },
      { name: 'Application fee', value: usdLine(receipt.asset, receipt.feeBase, rate), inline: true },
      { name: 'Net to recipients', value: usdLine(receipt.asset, receipt.netBase, rate), inline: true },
      { name: 'Asset / network', value: assetNetworkLabel(receipt.asset), inline: true },
      { name: 'Status', value: statusBadge(receipt.status), inline: true },
      { name: 'Created', value: timestamp(receipt.createdAt), inline: true },
    )
    .setFooter({ text: fxNote(rate) });
  if (receipt.note) embed.addFields({ name: 'Note', value: receipt.note.slice(0, 500) });
  if (receipt.recipients.length > 1) {
    embed.addFields({
      name: 'Recipients',
      value: receipt.recipients
        .slice(0, 15)
        .map((recipient) => `<@${recipient.userId}> ${amount(receipt.asset, recipient.netBase)}`)
        .join('\n'),
    });
  } else if (receipt.recipients[0]) {
    embed.addFields({ name: 'Recipient', value: `<@${receipt.recipients[0].userId}>` });
  }
  return embed;
}

export function rainEmbed(flags: EmbedContextFlags, receipt: RainResult, rate: RateQuote): EmbedBuilder {
  const embed = transferEmbed(flags, receipt, rate);
  embed.setTitle('Rain receipt').addFields({
    name: 'Distribution',
    value: `${receipt.recipients.length} recipient${receipt.recipients.length === 1 ? '' : 's'} · one application fee charged for the whole rain`,
  });
  return embed;
}

export function depositEmbed(flags: EmbedContextFlags, row: DepositRow, rate: RateQuote): EmbedBuilder {
  const asset = row.asset as AssetSymbol;
  return baseEmbed(flags, COLORS.neutral)
    .setTitle(`Deposit \`d_${row.id}\``)
    .addFields(
      { name: 'Amount', value: usdLine(asset, BigInt(row.amount), rate), inline: true },
      { name: 'Application fee', value: usdLine(asset, BigInt(row.fee), rate), inline: true },
      { name: 'Net credited', value: usdLine(asset, BigInt(row.net), rate), inline: true },
      { name: 'Asset / network', value: assetNetworkLabel(asset), inline: true },
      { name: 'Status', value: statusBadge(row.status), inline: true },
      {
        name: 'Confirmations',
        value: `${row.confirmations}${row.required_confirmations ? ` / ${row.required_confirmations}` : ''}`,
        inline: true,
      },
      { name: 'Transaction', value: `\`${row.tx_hash}\`` },
    )
    .setFooter({ text: fxNote(rate) });
}

export function withdrawalEmbed(flags: EmbedContextFlags, row: WithdrawalRow, rate: RateQuote): EmbedBuilder {
  const asset = row.asset as AssetSymbol;
  const embed = baseEmbed(flags, row.status === 'failed' ? COLORS.danger : COLORS.neutral)
    .setTitle(`Withdrawal \`w_${row.id}\``)
    .addFields(
      { name: 'Requested', value: usdLine(asset, BigInt(row.amount), rate), inline: true },
      { name: 'Application fee', value: usdLine(asset, BigInt(row.fee), rate), inline: true },
      { name: 'Net payout', value: usdLine(asset, BigInt(row.net), rate), inline: true },
      { name: 'Asset / network', value: assetNetworkLabel(asset), inline: true },
      { name: 'Status', value: statusBadge(row.status), inline: true },
      { name: 'To', value: `\`${row.address}\`` },
      { name: 'Provider reference', value: row.provider_track_id ? `\`${row.provider_track_id}\`` : 'not submitted yet' },
    )
    .setFooter({ text: fxNote(rate) });
  if (row.provider_tx_hash) embed.addFields({ name: 'On-chain transaction', value: `\`${row.provider_tx_hash}\`` });
  if (row.failure_reason) embed.addFields({ name: 'Failure reason', value: row.failure_reason });
  return embed;
}

export function receiptViewEmbed(flags: EmbedContextFlags, view: ReceiptView, rate: RateQuote): EmbedBuilder {
  switch (view.type) {
    case 'transfer':
      return transferEmbed(flags, view.receipt, rate);
    case 'rain':
      return rainEmbed(flags, view.receipt, rate);
    case 'deposit':
      return depositEmbed(flags, view.row, rate);
    case 'withdrawal':
      return withdrawalEmbed(flags, view.row, rate);
  }
}
