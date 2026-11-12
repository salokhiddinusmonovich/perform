-- Salaries start from a day (AGENTS.md: Salaries, decided 2026-11-11). A salary that
-- started from a month starts from its 1st, so it pays what it paid before.
ALTER TABLE "Salary" ADD COLUMN "fromDay" DATE;

UPDATE "Salary" SET "fromDay" = make_date("fromYear", "fromMonth", 1);

ALTER TABLE "Salary" ALTER COLUMN "fromDay" SET NOT NULL;

-- The range check named the month; without it the amount keeps its own (dropping a column drops the checks that name it).
ALTER TABLE "Salary" DROP CONSTRAINT "Salary_range_check";
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_monthlySalary_check" CHECK ("monthlySalary" > 0);

-- DropIndex
DROP INDEX "Salary_workerId_fromYear_fromMonth_idx";

-- AlterTable
ALTER TABLE "Salary" DROP COLUMN "fromMonth",
DROP COLUMN "fromYear";

-- CreateIndex
CREATE INDEX "Salary_workerId_fromDay_idx" ON "Salary"("workerId", "fromDay");

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerPosition" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "positionId" UUID,
    "fromDay" DATE NOT NULL,
    "setById" UUID,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Position_companyId_name_key" ON "Position"("companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Position_id_companyId_key" ON "Position"("id", "companyId");

-- CreateIndex
CREATE INDEX "WorkerPosition_companyId_idx" ON "WorkerPosition"("companyId");

-- CreateIndex
CREATE INDEX "WorkerPosition_positionId_idx" ON "WorkerPosition"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerPosition_workerId_fromDay_key" ON "WorkerPosition"("workerId", "fromDay");

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerPosition" ADD CONSTRAINT "WorkerPosition_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerPosition" ADD CONSTRAINT "WorkerPosition_positionId_companyId_fkey" FOREIGN KEY ("positionId", "companyId") REFERENCES "Position"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkerPosition" ADD CONSTRAINT "WorkerPosition_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Each worker's free-text position becomes a position of the company's list (AGENTS.md:
-- Positions): the same text (without the spaces around it) is the same position, and the
-- worker has it from their first placement's day (from the day they were added, without one).
INSERT INTO "Position" ("id", "companyId", "name")
SELECT gen_random_uuid(), p."companyId", p."name"
FROM (
  SELECT DISTINCT "companyId", btrim("position") AS "name"
  FROM "Worker"
  WHERE btrim("position") <> ''
) p;

INSERT INTO "WorkerPosition" ("id", "companyId", "workerId", "positionId", "fromDay")
SELECT
  gen_random_uuid(),
  w."companyId",
  w."id",
  p."id",
  COALESCE((SELECT MIN(a."hiredOn") FROM "Assignment" a WHERE a."workerId" = w."id"), w."createdAt"::date)
FROM "Worker" w
JOIN "Position" p ON p."companyId" = w."companyId" AND p."name" = btrim(w."position");

-- AlterTable
ALTER TABLE "Worker" DROP COLUMN "position";
