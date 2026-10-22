-- Groundwork for sites, teams and workers:
-- - PROJECT_MANAGER role; members are scoped to several sites (MemberSite: project
--   managers, timekeepers) or teams (MemberTeam: foremen) instead of one Membership.siteId
-- - app sessions sent as a bearer token (Session.kind, deviceName)
-- - the optional Timesheet module per company
-- - salaries leave Assignment for their own append-only table (Salary), so placements
--   can be shown to timekeepers and foremen without pay

-- No API has created placements yet, so there are no salaries to move. If there are,
-- stop: a Salary row needs who set it, which only a person can say.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Assignment") THEN
    RAISE EXCEPTION 'Assignment has rows; move their salaries into Salary by hand first';
  END IF;
  -- Foremen are scoped to teams, not sites; a site limit on a foreman can't be carried over.
  IF EXISTS (SELECT 1 FROM "Membership" WHERE "siteId" IS NOT NULL AND "role" = 'FOREMAN') THEN
    RAISE EXCEPTION 'A foreman has a site limit; assign their teams by hand first';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('BROWSER', 'APP');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PROJECT_MANAGER';

-- DropForeignKey
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_siteId_companyId_fkey";

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "timesheetModule" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "deviceName" TEXT,
ADD COLUMN     "kind" "SessionKind" NOT NULL DEFAULT 'BROWSER';



-- AlterTable
ALTER TABLE "Assignment" DROP COLUMN "monthlySalary",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "MemberSite" (
    "userId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberSite_pkey" PRIMARY KEY ("userId","companyId","siteId")
);

-- CreateTable
CREATE TABLE "MemberTeam" (
    "userId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberTeam_pkey" PRIMARY KEY ("userId","companyId","teamId")
);

-- CreateTable
CREATE TABLE "Salary" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "fromDate" DATE NOT NULL,
    "monthlySalary" DECIMAL(14,2) NOT NULL,
    "reason" TEXT,
    "seq" BIGSERIAL NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Salary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberSite_companyId_siteId_idx" ON "MemberSite"("companyId", "siteId");

-- CreateIndex
CREATE INDEX "MemberTeam_companyId_teamId_idx" ON "MemberTeam"("companyId", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "Salary_seq_key" ON "Salary"("seq");

-- CreateIndex
CREATE INDEX "Salary_assignmentId_fromDate_idx" ON "Salary"("assignmentId", "fromDate");

-- CreateIndex
CREATE INDEX "Salary_companyId_idx" ON "Salary"("companyId");

-- Carry over existing site limits (timekeepers), then drop the old column.
INSERT INTO "MemberSite" ("userId", "companyId", "siteId")
SELECT "userId", "companyId", "siteId" FROM "Membership" WHERE "siteId" IS NOT NULL;

ALTER TABLE "Membership" DROP COLUMN "siteId";

-- AddForeignKey
ALTER TABLE "MemberSite" ADD CONSTRAINT "MemberSite_userId_companyId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "Membership"("userId", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSite" ADD CONSTRAINT "MemberSite_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTeam" ADD CONSTRAINT "MemberTeam_userId_companyId_fkey" FOREIGN KEY ("userId", "companyId") REFERENCES "Membership"("userId", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberTeam" ADD CONSTRAINT "MemberTeam_teamId_companyId_fkey" FOREIGN KEY ("teamId", "companyId") REFERENCES "Team"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_assignmentId_companyId_fkey" FOREIGN KEY ("assignmentId", "companyId") REFERENCES "Assignment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Value ranges Prisma can't express.
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_monthlySalary_check" CHECK ("monthlySalary" >= 0);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_dates_check" CHECK ("leftOn" IS NULL OR "leftOn" >= "hiredOn");
