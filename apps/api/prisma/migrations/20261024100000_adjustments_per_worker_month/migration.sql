-- Adjustments belong to the worker-month instead of a placement and period, mistakes are
-- cancelled instead of edited, and the monthly travel amount gets its own table
-- (AGENTS.md: Adjustments). There was no way to enter adjustments before this, so the
-- old table is empty; refuse to run rather than drop rows that can't be moved (they have
-- no worker-month or author to move them to).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Adjustment") THEN
    RAISE EXCEPTION 'Adjustment has rows; move them by hand before this migration';
  END IF;
END $$;

-- AlterEnum
BEGIN;
CREATE TYPE "AdjustmentType_new" AS ENUM ('BONUS', 'ADVANCE', 'DEDUCTION');
ALTER TABLE "Adjustment" ALTER COLUMN "type" TYPE "AdjustmentType_new" USING ("type"::text::"AdjustmentType_new");
ALTER TYPE "AdjustmentType" RENAME TO "AdjustmentType_old";
ALTER TYPE "AdjustmentType_new" RENAME TO "AdjustmentType";
DROP TYPE "AdjustmentType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_periodId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_assignmentId_companyId_fkey";

-- DropIndex
DROP INDEX "Adjustment_periodId_assignmentId_idx";

-- AlterTable
ALTER TABLE "PayrollRules" ALTER COLUMN "payRoundingStep" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Adjustment" DROP COLUMN "assignmentId",
DROP COLUMN "createdAt",
DROP COLUMN "periodId",
ADD COLUMN     "month" INTEGER NOT NULL,
ADD COLUMN     "seq" BIGSERIAL NOT NULL,
ADD COLUMN     "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "setById" UUID NOT NULL,
ADD COLUMN     "workerId" UUID NOT NULL,
ADD COLUMN     "year" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "AdjustmentCancel" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "adjustmentId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelledById" UUID NOT NULL,
    "cancelledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdjustmentCancel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelAmount" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "seq" BIGSERIAL NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelAmount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdjustmentCancel_companyId_idx" ON "AdjustmentCancel"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AdjustmentCancel_adjustmentId_companyId_key" ON "AdjustmentCancel"("adjustmentId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "TravelAmount_seq_key" ON "TravelAmount"("seq");

-- CreateIndex
CREATE INDEX "TravelAmount_assignmentId_year_month_idx" ON "TravelAmount"("assignmentId", "year", "month");

-- CreateIndex
CREATE INDEX "TravelAmount_companyId_year_month_idx" ON "TravelAmount"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Adjustment_seq_key" ON "Adjustment"("seq");

-- CreateIndex
CREATE INDEX "Adjustment_workerId_year_month_idx" ON "Adjustment"("workerId", "year", "month");

-- CreateIndex
CREATE INDEX "Adjustment_companyId_year_month_idx" ON "Adjustment"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "Adjustment_id_companyId_key" ON "Adjustment"("id", "companyId");

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentCancel" ADD CONSTRAINT "AdjustmentCancel_adjustmentId_companyId_fkey" FOREIGN KEY ("adjustmentId", "companyId") REFERENCES "Adjustment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdjustmentCancel" ADD CONSTRAINT "AdjustmentCancel_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelAmount" ADD CONSTRAINT "TravelAmount_assignmentId_companyId_fkey" FOREIGN KEY ("assignmentId", "companyId") REFERENCES "Assignment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelAmount" ADD CONSTRAINT "TravelAmount_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Rounding is company-wide: only the company default rule set has a step.
UPDATE "PayrollRules" r SET "payRoundingStep" = NULL
  FROM "PayrollRuleSet" s
  WHERE s."id" = r."ruleSetId" AND s."siteId" IS NOT NULL;

-- Value ranges Prisma can't express (the same as the shared zod schemas).
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_range_check"
  CHECK ("month" BETWEEN 1 AND 12 AND "amount" > 0);
ALTER TABLE "AdjustmentCancel" ADD CONSTRAINT "AdjustmentCancel_reason_check"
  CHECK (length(btrim("reason")) > 0);
ALTER TABLE "TravelAmount" ADD CONSTRAINT "TravelAmount_range_check"
  CHECK ("month" BETWEEN 1 AND 12 AND "amount" >= 0);
