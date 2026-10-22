import { dayToDate, isoDay } from '../common/dates';

/** Days after the paid-until date during which the company still works normally (AGENTS.md: Subscriptions). */
export const GRACE_DAYS = 14;

/**
 * NONE: no paid-until date (a company from before plans), never expires.
 * ACTIVE: paid. GRACE: unpaid, still working, owners are warned. READ_ONLY: grace is over.
 */
export type SubscriptionStatus = 'NONE' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';

export interface SubscriptionState {
  status: SubscriptionStatus;
  planName: string | null;
  /** "YYYY-MM-DD" */
  paidUntil: string | null;
  /** Last day of the grace period, "YYYY-MM-DD" */
  graceEndsOn: string | null;
}

/** The subscription on `today` (the company's calendar day, "YYYY-MM-DD"). */
export function subscriptionState(
  company: { paidUntil: Date | null; plan: { name: string } | null },
  today: string,
): SubscriptionState {
  const planName = company.plan?.name ?? null;
  if (!company.paidUntil) return { status: 'NONE', planName, paidUntil: null, graceEndsOn: null };
  const paidUntil = isoDay(company.paidUntil);
  const graceEnd = dayToDate(paidUntil);
  graceEnd.setUTCDate(graceEnd.getUTCDate() + GRACE_DAYS);
  const graceEndsOn = isoDay(graceEnd);
  const status = today <= paidUntil ? 'ACTIVE' : today <= graceEndsOn ? 'GRACE' : 'READ_ONLY';
  return { status, planName, paidUntil, graceEndsOn };
}
