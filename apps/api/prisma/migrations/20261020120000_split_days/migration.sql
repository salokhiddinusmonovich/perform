-- A worker can work at several sites or teams on one day: timesheet entries are
-- stored per assignment, date, site and team, and record their creation order.

-- AlterTable: where the hours were worked. Existing entries were worked at their
-- assignment's site and team.
ALTER TABLE "TimesheetEntry" ADD COLUMN "siteId" UUID,
ADD COLUMN "teamId" UUID;
UPDATE "TimesheetEntry" e SET "siteId" = a."siteId", "teamId" = a."teamId" FROM "Assignment" a WHERE a."id" = e."assignmentId";
ALTER TABLE "TimesheetEntry" ALTER COLUMN "siteId" SET NOT NULL;

-- AlterTable: creation order. Existing entries are one per worker and day, so their
-- order among themselves doesn't matter; createdAt is unknown for them, and their
-- last update is the earliest time known.
ALTER TABLE "TimesheetEntry" ADD COLUMN "seq" BIGSERIAL NOT NULL,
ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "TimesheetEntry" SET "createdAt" = "updatedAt";
ALTER TABLE "TimesheetEntry" ALTER COLUMN "createdAt" SET NOT NULL,
ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- DropIndex: one entry per assignment and date no longer holds.
DROP INDEX "TimesheetEntry_assignmentId_date_key";

-- CreateIndex: one entry per assignment, date, site and team. NULLS NOT DISTINCT so
-- that two entries without a team on one site still collide (Prisma can't express it).
CREATE UNIQUE INDEX "TimesheetEntry_assignmentId_date_siteId_teamId_key" ON "TimesheetEntry"("assignmentId", "date", "siteId", "teamId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "TimesheetEntry_assignmentId_date_idx" ON "TimesheetEntry"("assignmentId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetEntry_seq_key" ON "TimesheetEntry"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_siteId_companyId_key" ON "Team"("id", "siteId", "companyId");

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey: the team must be in the same company and on the entry's site.
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_teamId_siteId_companyId_fkey" FOREIGN KEY ("teamId", "siteId", "companyId") REFERENCES "Team"("id", "siteId", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;
