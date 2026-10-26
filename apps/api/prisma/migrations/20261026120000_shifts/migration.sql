-- Shifts with their own normal hours per day (AGENTS.md: Shifts) replace the DAY/NIGHT
-- label on placements, which never changed any pay. A company-defined shift needs its
-- normal hours, which the label doesn't say, so night placements stop the migration
-- instead of losing the label silently: they are moved to shifts by hand first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Assignment" WHERE "shift" <> 'DAY') THEN
    RAISE EXCEPTION 'Placements with shift NIGHT exist: define the night shift and give it to those workers before this migration';
  END IF;
END $$;

ALTER TABLE "Assignment" DROP COLUMN "shift";

-- The enum's name is taken by the new table (a table has a row type of its own name).
DROP TYPE "Shift";

-- CreateTable
CREATE TABLE "Shift" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalHoursPerDay" DECIMAL(4,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id"),
    -- Same range as the pay rules' normal hours per day
    CONSTRAINT "Shift_normalHours_check" CHECK ("normalHoursPerDay" > 0 AND "normalHoursPerDay" <= 24)
);

-- CreateTable
CREATE TABLE "WorkerShift" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "shiftId" UUID,
    "fromDay" DATE NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerShift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shift_companyId_name_key" ON "Shift"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_id_companyId_key" ON "Shift"("id", "companyId");

-- CreateIndex
CREATE INDEX "WorkerShift_companyId_idx" ON "WorkerShift"("companyId");

-- CreateIndex
CREATE INDEX "WorkerShift_shiftId_idx" ON "WorkerShift"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerShift_workerId_fromDay_key" ON "WorkerShift"("workerId", "fromDay");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerShift" ADD CONSTRAINT "WorkerShift_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey (with shiftId null, MATCH SIMPLE checks nothing: no shift from that day)
ALTER TABLE "WorkerShift" ADD CONSTRAINT "WorkerShift_shiftId_companyId_fkey" FOREIGN KEY ("shiftId", "companyId") REFERENCES "Shift"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerShift" ADD CONSTRAINT "WorkerShift_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Monthly totals are per part of a shift change; totals entered so far are for the whole month.
ALTER TABLE "MonthlyHours" ADD COLUMN "fromDay" DATE, ADD COLUMN "untilDay" DATE;
UPDATE "MonthlyHours" SET
  "fromDay" = make_date("year", "month", 1),
  "untilDay" = (make_date("year", "month", 1) + INTERVAL '1 month' - INTERVAL '1 day')::date;
ALTER TABLE "MonthlyHours" ALTER COLUMN "fromDay" SET NOT NULL, ALTER COLUMN "untilDay" SET NOT NULL;
ALTER TABLE "MonthlyHours" ADD CONSTRAINT "MonthlyHours_days_check" CHECK (
  "fromDay" <= "untilDay"
  AND EXTRACT(YEAR FROM "fromDay") = "year" AND EXTRACT(MONTH FROM "fromDay") = "month"
  AND EXTRACT(YEAR FROM "untilDay") = "year" AND EXTRACT(MONTH FROM "untilDay") = "month"
);
