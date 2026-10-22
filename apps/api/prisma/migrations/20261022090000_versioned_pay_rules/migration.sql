-- Pay rules are versioned by month: PayrollRuleSet is now only where rules apply
-- (company default or a site), and PayrollRules holds the rules from a month on.
-- Working-days overrides are append-only: a correction is a newer row.
-- Holiday names are optional notes (the kind names the day).

-- No API has ever created rule sets, so there are none to move. If there are, stop:
-- their settings need a "from month", which only a person can decide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PayrollRuleSet") THEN
    RAISE EXCEPTION 'PayrollRuleSet has rows; move their settings into PayrollRules by hand first';
  END IF;
END $$;

-- DropIndex: several overrides per month now; the newest counts.
DROP INDEX "WorkingDaysOverride_ruleSetId_year_month_key";

-- AlterTable
ALTER TABLE "Holiday" ALTER COLUMN "name" DROP NOT NULL;

-- AlterTable: the settings move to PayrollRules.
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_settings_check";
ALTER TABLE "PayrollRuleSet" DROP COLUMN "holidayMultiplier",
DROP COLUMN "leaveHoursPerDay",
DROP COLUMN "leavePaid",
DROP COLUMN "name",
DROP COLUMN "normalHoursPerDay",
DROP COLUMN "normalMultiplier",
DROP COLUMN "overtimeMultiplier",
DROP COLUMN "payRoundingStep",
DROP COLUMN "restDayMultiplier",
DROP COLUMN "restWeekdays",
DROP COLUMN "sickHoursPerDay",
DROP COLUMN "sickPaid",
DROP COLUMN "travelDayHoursPerDay",
DROP COLUMN "travelDayPaid",
DROP COLUMN "travelPayMode",
DROP COLUMN "updatedAt",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "WorkingDaysOverride" ADD COLUMN     "seq" BIGSERIAL NOT NULL,
ALTER COLUMN "workingDays" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PayrollRules" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ruleSetId" UUID NOT NULL,
    "fromYear" INTEGER NOT NULL,
    "fromMonth" INTEGER NOT NULL,
    "restWeekdays" INTEGER[],
    "normalHoursPerDay" DECIMAL(4,2) NOT NULL,
    "overtimeMultiplier" DECIMAL(4,2) NOT NULL,
    "restDayMultiplier" DECIMAL(4,2) NOT NULL,
    "holidayMultiplier" DECIMAL(4,2) NOT NULL,
    "leavePaid" BOOLEAN NOT NULL,
    "leaveHoursPerDay" DECIMAL(4,2),
    "sickPaid" BOOLEAN NOT NULL,
    "sickHoursPerDay" DECIMAL(4,2),
    "travelDayPaid" BOOLEAN NOT NULL,
    "travelDayHoursPerDay" DECIMAL(4,2),
    "travelPayMode" "TravelPayMode" NOT NULL,
    "payRoundingStep" DECIMAL(14,2) NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollRules_companyId_idx" ON "PayrollRules"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRules_ruleSetId_fromYear_fromMonth_key" ON "PayrollRules"("ruleSetId", "fromYear", "fromMonth");

-- CreateIndex
CREATE UNIQUE INDEX "WorkingDaysOverride_seq_key" ON "WorkingDaysOverride"("seq");

-- CreateIndex
CREATE INDEX "WorkingDaysOverride_ruleSetId_year_month_idx" ON "WorkingDaysOverride"("ruleSetId", "year", "month");

-- AddForeignKey
ALTER TABLE "PayrollRules" ADD CONSTRAINT "PayrollRules_ruleSetId_companyId_fkey" FOREIGN KEY ("ruleSetId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRules" ADD CONSTRAINT "PayrollRules_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Value ranges Prisma can't express (the same as the shared zod schema).
ALTER TABLE "PayrollRules" ADD CONSTRAINT "PayrollRules_settings_check" CHECK (
  "fromMonth" BETWEEN 1 AND 12
  AND "restWeekdays" IS NOT NULL
  AND "restWeekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  AND cardinality("restWeekdays") < 7
  AND "normalHoursPerDay" > 0 AND "normalHoursPerDay" <= 24
  AND "overtimeMultiplier" >= 0 AND "restDayMultiplier" >= 0 AND "holidayMultiplier" >= 0
  AND ("leaveHoursPerDay" IS NULL OR "leaveHoursPerDay" BETWEEN 0 AND 24)
  AND ("sickHoursPerDay" IS NULL OR "sickHoursPerDay" BETWEEN 0 AND 24)
  AND ("travelDayHoursPerDay" IS NULL OR "travelDayHoursPerDay" BETWEEN 0 AND 24)
  AND "payRoundingStep" > 0
);

ALTER TABLE "WorkingDaysOverride" DROP CONSTRAINT "WorkingDaysOverride_range_check";
ALTER TABLE "WorkingDaysOverride" ADD CONSTRAINT "WorkingDaysOverride_range_check"
  CHECK ("month" BETWEEN 1 AND 12 AND ("workingDays" IS NULL OR "workingDays" BETWEEN 1 AND 31));

-- Ramazon Hayit and Qurbon Hayit are one day each per year (extra days off declared
-- around them are PUBLIC_EXTRA). The API checks this first; this is the backstop.
CREATE UNIQUE INDEX "Holiday_moving_once_a_year_key" ON "Holiday"("companyId", "kind", (EXTRACT(YEAR FROM "date")))
  WHERE "kind" IN ('RAMAZON_HAYIT', 'QURBON_HAYIT');
