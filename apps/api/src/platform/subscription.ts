import { dayToDate, isoDay } from '../common/dates';

/** Days after the paid-through month during which the company still works normally (AGENTS.md: Subscriptions). */
export const GRACE_DAYS = 14;

/**
 * NONE: not paid through any month (a company from before plans), never expires.
 * ACTIVE: paid. GRACE: unpaid, still working, owners are warned. READ_ONLY: grace is over.
 */
export type SubscriptionStatus = 'NONE' | 'ACTIVE' | 'GRACE' | 'READ_ONLY';

export interface SubscriptionState {
  status: SubscriptionStatus;
  planName: string | null;
  /** The last month paid for, "YYYY-MM-01" */
  paidThrough: string | null;
  /** Last day of the grace period, "YYYY-MM-DD" */
  graceEndsOn: string | null;
}

/** The subscription on `today` (the company's calendar day, "YYYY-MM-DD"). */
export function subscriptionState(
  company: { paidThrough: Date | null; plan: { name: string } | null },
  today: string,
): SubscriptionState {
  const planName = company.plan?.name ?? null;
  if (!company.paidThrough) return { status: 'NONE', planName, paidThrough: null, graceEndsOn: null };
  const paidThrough = isoDay(company.paidThrough);
  // The paid month's last day, then the grace days after it.
  const lastPaid = dayToDate(paidThrough);
  lastPaid.setUTCMonth(lastPaid.getUTCMonth() + 1, 0);
  const graceEnd = new Date(lastPaid);
  graceEnd.setUTCDate(graceEnd.getUTCDate() + GRACE_DAYS);
  const graceEndsOn = isoDay(graceEnd);
  const status = today <= isoDay(lastPaid) ? 'ACTIVE' : today <= graceEndsOn ? 'GRACE' : 'READ_ONLY';
  return { status, planName, paidThrough, graceEndsOn };
}
