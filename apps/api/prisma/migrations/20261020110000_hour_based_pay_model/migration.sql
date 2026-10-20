-- Hour-based pay model (AGENTS.md, decided 2026-10-19):
-- - explicit pay settings on PayrollRuleSet, travel routes, per-company timesheet codes
-- - holiday kinds, per-month working-days overrides, who locked a period
-- - companyId on assignments, timesheet entries and adjustments, with composite foreign
--   keys so the database refuses rows that mix two companies.
--
-- New NOT NULL settings (PayrollRuleSet pay fields, Holiday.kind) have no sensible value
-- to fill in for existing rows, so this migration fails if those tables have rows,
-- rather than inventing pay policy. No release has created such rows.

-- CreateEnum
CREATE TYPE "HolidayKind" AS ENUM ('RAMAZON_HAYIT', 'QURBON_HAYIT', 'PUBLIC_EXTRA', 'COMPANY_DAY_OFF', 'WORKING_DAY');

-- CreateEnum
CREATE TYPE "TravelPayMode" AS ENUM ('NONE', 'PER_DAY_WORKED', 'MONTHLY_AMOUNT');

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_assignmentId_fkey";

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_periodId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_workerId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_siteId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_siteId_fkey";

-- DropForeignKey
ALTER TABLE "TimesheetEntry" DROP CONSTRAINT "TimesheetEntry_assignmentId_fkey";

-- DropForeignKey
ALTER TABLE "TimesheetEntry" DROP CONSTRAINT "TimesheetEntry_periodId_fkey";


-- AlterTable: companyId, backfilled from the worker / assignment
ALTER TABLE "Assignment" ADD COLUMN     "companyId" UUID,
ADD COLUMN     "travelRouteId" UUID;
UPDATE "Assignment" a SET "companyId" = w."companyId" FROM "Worker" w WHERE w."id" = a."workerId";
ALTER TABLE "Assignment" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "TimesheetEntry" ADD COLUMN "companyId" UUID;
UPDATE "TimesheetEntry" e SET "companyId" = a."companyId" FROM "Assignment" a WHERE a."id" = e."assignmentId";
ALTER TABLE "TimesheetEntry" ALTER COLUMN "companyId" SET NOT NULL;

ALTER TABLE "Adjustment" ADD COLUMN "companyId" UUID;
UPDATE "Adjustment" j SET "companyId" = a."companyId" FROM "Assignment" a WHERE a."id" = j."assignmentId";
ALTER TABLE "Adjustment" ALTER COLUMN "companyId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Holiday" ADD COLUMN     "kind" "HolidayKind" NOT NULL;

-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "lockedById" UUID;

-- AlterTable
ALTER TABLE "PayrollRuleSet" DROP COLUMN "options",
DROP COLUMN "standardDayHours",
ADD COLUMN     "holidayMultiplier" DECIMAL(4,2) NOT NULL,
ADD COLUMN     "leaveHoursPerDay" DECIMAL(4,2),
ADD COLUMN     "leavePaid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "normalHoursPerDay" DECIMAL(4,2) NOT NULL,
ADD COLUMN     "normalMultiplier" DECIMAL(4,2) NOT NULL DEFAULT 1,
ADD COLUMN     "payRoundingStep" DECIMAL(14,2) NOT NULL DEFAULT 1000,
ADD COLUMN     "sickHoursPerDay" DECIMAL(4,2) DEFAULT 8,
ADD COLUMN     "sickPaid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "travelDayHoursPerDay" DECIMAL(4,2),
ADD COLUMN     "travelDayPaid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "travelPayMode" "TravelPayMode" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "overtimeMultiplier" DROP DEFAULT,
ALTER COLUMN "restDayMultiplier" DROP DEFAULT,
ALTER COLUMN "restWeekdays" DROP DEFAULT;


-- CreateTable
CREATE TABLE "WorkingDaysOverride" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ruleSetId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "workingDays" INTEGER NOT NULL,
    "reason" TEXT,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkingDaysOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelRoute" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amountPerDay" DECIMAL(14,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetCode" (
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "DayStatus" NOT NULL,

    CONSTRAINT "TimesheetCode_pkey" PRIMARY KEY ("companyId","code")
);

-- CreateIndex
CREATE INDEX "WorkingDaysOverride_companyId_idx" ON "WorkingDaysOverride"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkingDaysOverride_ruleSetId_year_month_key" ON "WorkingDaysOverride"("ruleSetId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "TravelRoute_companyId_name_key" ON "TravelRoute"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TravelRoute_id_companyId_key" ON "TravelRoute"("id", "companyId");

-- CreateIndex
CREATE INDEX "Assignment_companyId_idx" ON "Assignment"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_id_companyId_key" ON "Assignment"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_id_companyId_key" ON "PayrollPeriod"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRuleSet_id_companyId_key" ON "PayrollRuleSet"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_id_companyId_key" ON "Site"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_companyId_key" ON "Team"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_id_companyId_key" ON "Worker"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_teamId_companyId_fkey" FOREIGN KEY ("teamId", "companyId") REFERENCES "Team"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_travelRouteId_companyId_fkey" FOREIGN KEY ("travelRouteId", "companyId") REFERENCES "TravelRoute"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingDaysOverride" ADD CONSTRAINT "WorkingDaysOverride_ruleSetId_companyId_fkey" FOREIGN KEY ("ruleSetId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkingDaysOverride" ADD CONSTRAINT "WorkingDaysOverride_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetCode" ADD CONSTRAINT "TimesheetCode_code_check" CHECK ("code" <> '' AND "code" = btrim("code"));

ALTER TABLE "TravelRoute" ADD CONSTRAINT "TravelRoute_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetCode" ADD CONSTRAINT "TimesheetCode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_periodId_companyId_fkey" FOREIGN KEY ("periodId", "companyId") REFERENCES "PayrollPeriod"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_assignmentId_companyId_fkey" FOREIGN KEY ("assignmentId", "companyId") REFERENCES "Assignment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_periodId_companyId_fkey" FOREIGN KEY ("periodId", "companyId") REFERENCES "PayrollPeriod"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_assignmentId_companyId_fkey" FOREIGN KEY ("assignmentId", "companyId") REFERENCES "Assignment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Value ranges Prisma can't express.
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_settings_check" CHECK (
  "restWeekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  AND cardinality("restWeekdays") < 7
  AND "normalHoursPerDay" > 0 AND "normalHoursPerDay" <= 24
  AND "normalMultiplier" >= 0 AND "overtimeMultiplier" >= 0
  AND "restDayMultiplier" >= 0 AND "holidayMultiplier" >= 0
  AND ("leaveHoursPerDay" IS NULL OR "leaveHoursPerDay" BETWEEN 0 AND 24)
  AND ("sickHoursPerDay" IS NULL OR "sickHoursPerDay" BETWEEN 0 AND 24)
  AND ("travelDayHoursPerDay" IS NULL OR "travelDayHoursPerDay" BETWEEN 0 AND 24)
  AND "payRoundingStep" > 0
);

ALTER TABLE "WorkingDaysOverride" ADD CONSTRAINT "WorkingDaysOverride_range_check"
  CHECK ("month" BETWEEN 1 AND 12 AND "workingDays" BETWEEN 1 AND 31);

ALTER TABLE "TravelRoute" ADD CONSTRAINT "TravelRoute_amountPerDay_check" CHECK ("amountPerDay" >= 0);

ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_month_check" CHECK ("month" BETWEEN 1 AND 12);

-- A period is locked exactly when we know when and by whom.
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_lock_check" CHECK (
  ("status" = 'OPEN' AND "lockedAt" IS NULL AND "lockedById" IS NULL)
  OR ("status" = 'LOCKED' AND "lockedAt" IS NOT NULL AND "lockedById" IS NOT NULL)
);

-- Hours only on worked days, more than 0 and at most 24 (same rule as @puantaj/payroll).
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_hours_check" CHECK (
  ("status" = 'WORKED' AND "hours" > 0 AND "hours" <= 24)
  OR ("status" <> 'WORKED' AND "hours" = 0)
);
