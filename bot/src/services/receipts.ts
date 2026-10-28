import { AppError } from '../core/errors.ts';
import type { DB } from '../db/index.ts';
import type { DepositRow, DepositsService } from './deposits.ts';
import type { RainResult, TransfersService, TransferReceipt } from './transfers.ts';
import type { WithdrawalsService, WithdrawalRow } from './withdrawals.ts';

export type ReceiptView =
  | { type: 'transfer'; receipt: TransferReceipt }
  | { type: 'rain'; receipt: RainResult }
  | { type: 'deposit'; row: DepositRow }
  | { type: 'withdrawal'; row: WithdrawalRow };

/**
 * Resolves the short references shown by /transactions into full receipts.
 * Deposits and withdrawals are only visible to their owner; transfers are
 * visible to sender and recipients.
 */
interface ReceiptsDeps {
  transfers: TransfersService;
  deposits: DepositsService;
  withdrawals: WithdrawalsService;
}

export class ReceiptsService {
  private readonly db: DB;
  private readonly deps: ReceiptsDeps;

  constructor(db: DB, deps: ReceiptsDeps) {
    this.db = db;
    this.deps = deps;
  }

  find(userId: string, reference: string): ReceiptView {
    const ref = reference.trim();
    const withdrawalMatch = /^w_(\d+)$/i.exec(ref);
    if (withdrawalMatch) {
      const row = this.deps.withdrawals.getForUser(userId, Number(withdrawalMatch[1]));
      return { type: 'withdrawal', row };
    }
    const depositMatch = /^d_(\d+)$/i.exec(ref);
    if (depositMatch) {
      const row = this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(Number(depositMatch[1])) as
        | DepositRow
        | undefined;
      if (!row || row.user_id !== userId) throw new AppError('not_found', 'No deposit matches that reference.');
      return { type: 'deposit', row };
    }
    const depositByHash = this.deps.deposits.byTxHash(ref);
    if (depositByHash && depositByHash.user_id === userId) return { type: 'deposit', row: depositByHash };

    if (/^rain_\d+$/i.test(ref)) {
      const rain = this.deps.transfers.getRain(Number(ref.split('_')[1]));
      const involved =
        rain.fromUserId === userId || rain.recipients.some((recipient) => recipient.userId === userId);
      if (!involved) throw new AppError('not_found', 'No transaction matches that reference.');
      return { type: 'rain', receipt: rain };
    }

    const receipt = this.deps.transfers.getReceipt(ref);
    const involved = receipt.fromUserId === userId || receipt.recipients.some((row) => row.userId === userId);
    if (!involved) throw new AppError('not_found', 'No transaction matches that reference.');
    return { type: 'transfer', receipt };
  }
}
