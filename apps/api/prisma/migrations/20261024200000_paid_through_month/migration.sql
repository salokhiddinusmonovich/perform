-- A company is paid through a calendar month (AGENTS.md: Subscriptions), stored as the
-- month's 1st day. An existing paid-until date becomes the month it falls in.
ALTER TABLE "Company" RENAME COLUMN "paidUntil" TO "paidThrough";
UPDATE "Company" SET "paidThrough" = date_trunc('month', "paidThrough")::date WHERE "paidThrough" IS NOT NULL;
ALTER TABLE "Company" ADD CONSTRAINT "Company_paidThrough_month_check" CHECK (EXTRACT(DAY FROM "paidThrough") = 1);

ALTER TABLE "SubscriptionPayment" RENAME COLUMN "paidUntil" TO "paidThrough";
UPDATE "SubscriptionPayment" SET "paidThrough" = date_trunc('month', "paidThrough")::date;
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_paidThrough_month_check" CHECK (EXTRACT(DAY FROM "paidThrough") = 1);
