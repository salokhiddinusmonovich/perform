import { divRound, fromUnits, toUnits, type Units } from './decimal.js';
import type { PayResult } from './pay.js';

/** Mirrors AdjustmentType in apps/api/prisma/schema.prisma (ADJUSTMENT_TYPES in @puantaj/schemas). */
export type AdjustmentType = 'BONUS' | 'ADVANCE' | 'DEDUCTION';

/** Whether an adjustment type adds to pay (+1) or takes from it (−1). */
export const ADJUSTMENT_SIGN: Record<AdjustmentType, 1n | -1n> = { BONUS: 1n, ADVANCE: -1n, DEDUCTION: -1n };

/** An adjustment that counts this month (not cancelled). The amount is positive; the type gives the sign. */
export interface AdjustmentInput {
  id: string;
  type: AdjustmentType;
  amount: string;
}

export interface PayOutAdjustment {
  id: string;
  type: AdjustmentType;
  /** Signed: negative for advances and deductions */
  amount: string;
}

/** What a worker is paid for the month, from their earned pay (AGENTS.md: Adjustments). */
export interface PayOut {
  /** Sum of the parts' totals */
  earned: string;
  adjustments: PayOutAdjustment[];
  /** rounded total − (earned + adjustments); null when nothing had to be rounded */
  rounding: { step: string; amount: string } | null;
  /**
   * earned + adjustments, rounded once to the nearest multiple of the step (halves
   * away from zero). Below zero when advances and deductions exceed what was earned:
   * the worker owes it.
   */
  total: string;
}

/**
 * The amount to pay out: the earned pay of every part of the month, plus bonuses,
 * minus advances and deductions, rounded once with the company's rounding step.
 */
export function payOut(parts: readonly PayResult[], adjustments: readonly AdjustmentInput[], roundingStep: string): PayOut {
  const step = toUnits(roundingStep, 'roundingStep');
  if (step <= 0n) throw new RangeError('roundingStep must be more than 0');
  const earned = parts.reduce((sum, part) => sum + toUnits(part.total), 0n);
  const signed = adjustments.map((a) => {
    const amount: Units = toUnits(a.amount, `adjustments.${a.id}.amount`);
    if (amount <= 0n) throw new RangeError(`adjustments.${a.id}.amount must be more than 0`);
    return { id: a.id, type: a.type, amount: ADJUSTMENT_SIGN[a.type] * amount };
  });
  const exact = signed.reduce((sum, a) => sum + a.amount, earned);
  const total = divRound(exact, step) * step;
  return {
    earned: fromUnits(earned),
    adjustments: signed.map((a) => ({ ...a, amount: fromUnits(a.amount) })),
    rounding: total === exact ? null : { step: fromUnits(step), amount: fromUnits(total - exact) },
    total: fromUnits(total),
  };
}
