/** All money amounts are integer paise (M7). */

export const MAX_AMOUNT_PAISE = 1_000_000_000_000; // ₹100 crore (D2)
export const MAX_PARTICIPANTS = 50; // per expense (D2)
export const BP_TOTAL = 10_000; // percent splits arrive as integer basis points (M8)

export type UserStatus = 'active' | 'merged';

export interface UserRecord {
  id: string;
  status: UserStatus;
  mergedInto: string | null;
  isGhost?: boolean;
}

export type SplitType = 'equal' | 'exact' | 'percent' | 'shares';

export interface SplitParticipant {
  userId: string;
  /** exact: the participant's share in paise */
  amount?: number;
  /** percent: integer basis points (Σ must be 10000) */
  bp?: number;
  /** shares: integer weight >= 1 */
  weight?: number;
}

export interface SplitInput {
  splitType: SplitType;
  amountTotal: number;
  participants: SplitParticipant[];
}

export interface ExpenseRecord {
  id: string;
  paidBy: string;
  amountTotal: number;
  /** userId -> share in paise; Σ must equal amountTotal */
  splits: Record<string, number>;
  deleted?: boolean;
}

export type SettlementStatus = 'pending' | 'marked_paid' | 'confirmed' | 'disputed';
export type SettlementAction = 'mark_paid' | 'confirm' | 'dispute' | 'reset';

export interface SettlementRecord {
  id: string;
  from: string;
  to: string;
  amount: number;
  status: SettlementStatus;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}
