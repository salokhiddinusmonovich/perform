-- Salaries belong to the worker and start from a month (AGENTS.md: Roles → Salaries),
-- so moving to another site keeps the salary and each worker-month has one salary.

-- No API has added salaries yet. If there are any, stop: which month an existing
-- salary should start from is for a person to decide.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Salary") THEN
    RAISE EXCEPTION 'Salary has rows; move them to workers and months by hand first';
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Salary" DROP CONSTRAINT "Salary_assignmentId_companyId_fkey";

-- DropIndex
DROP INDEX "Salary_assignmentId_fromDate_idx";

-- AlterTable
ALTER TABLE "Salary" DROP COLUMN "assignmentId",
DROP COLUMN "fromDate",
ADD COLUMN     "fromMonth" INTEGER NOT NULL,
ADD COLUMN     "fromYear" INTEGER NOT NULL,
ADD COLUMN     "workerId" UUID NOT NULL;

-- CreateIndex
CREATE INDEX "Salary_workerId_fromYear_fromMonth_idx" ON "Salary"("workerId", "fromYear", "fromMonth");

-- AddForeignKey
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Value ranges Prisma can't express (the same as the shared zod schema). A salary is
-- more than 0: the hourly rate is worked out from it.
ALTER TABLE "Salary" DROP CONSTRAINT "Salary_monthlySalary_check";
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_range_check"
  CHECK ("fromMonth" BETWEEN 1 AND 12 AND "monthlySalary" > 0);
