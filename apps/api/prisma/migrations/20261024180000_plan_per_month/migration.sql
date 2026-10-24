-- A company's plan per month (AGENTS.md: Plans): a change always starts on the 1st of the
-- next month, so Company.planId becomes a history.

-- CreateTable
CREATE TABLE "CompanyPlan" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "fromMonth" DATE NOT NULL,
    "setById" UUID,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyPlan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CompanyPlan_fromMonth_first_check" CHECK (EXTRACT(DAY FROM "fromMonth") = 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyPlan_companyId_fromMonth_key" ON "CompanyPlan"("companyId", "fromMonth");

-- AddForeignKey
ALTER TABLE "CompanyPlan" ADD CONSTRAINT "CompanyPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyPlan" ADD CONSTRAINT "CompanyPlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyPlan" ADD CONSTRAINT "CompanyPlan_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- A company's current plan applies from the month the company was created in (its own
-- time zone), as for a new company.
INSERT INTO "CompanyPlan" ("id", "companyId", "planId", "fromMonth")
SELECT gen_random_uuid(), c."id", c."planId",
       date_trunc('month', (c."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE c."timezone")::date
FROM "Company" c
WHERE c."planId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "Company" DROP CONSTRAINT "Company_planId_fkey";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "planId";
