-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_companyId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorUserId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_userId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Site" DROP CONSTRAINT "Site_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Worker" DROP CONSTRAINT "Worker_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_workerId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_siteId_fkey";

-- DropForeignKey
ALTER TABLE "Assignment" DROP CONSTRAINT "Assignment_teamId_fkey";

-- DropForeignKey
ALTER TABLE "Holiday" DROP CONSTRAINT "Holiday_companyId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_companyId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_siteId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollPeriod" DROP CONSTRAINT "PayrollPeriod_companyId_fkey";

-- DropForeignKey
ALTER TABLE "TimesheetEntry" DROP CONSTRAINT "TimesheetEntry_periodId_fkey";

-- DropForeignKey
ALTER TABLE "TimesheetEntry" DROP CONSTRAINT "TimesheetEntry_assignmentId_fkey";

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_periodId_fkey";

-- DropForeignKey
ALTER TABLE "Adjustment" DROP CONSTRAINT "Adjustment_assignmentId_fkey";

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- At most one company-wide default rule set (siteId IS NULL). The unique index on
-- (companyId, siteId) can't enforce this: PostgreSQL treats NULLs as distinct.
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_default_key" ON "PayrollRuleSet"("companyId") WHERE "siteId" IS NULL;
