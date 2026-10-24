-- The daily grid types a company's own codes (AGENTS.md: The daily grid); each grid
-- status shows with one of them.
ALTER TABLE "TimesheetCode" ADD COLUMN "inGrid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TimesheetCode" ADD CONSTRAINT "TimesheetCode_inGrid_check"
  CHECK (NOT "inGrid" OR "status" IN ('ABSENT', 'LEAVE', 'SICK', 'TRAVEL'));
CREATE UNIQUE INDEX "TimesheetCode_companyId_status_inGrid_key" ON "TimesheetCode" ("companyId", "status") WHERE "inGrid";
