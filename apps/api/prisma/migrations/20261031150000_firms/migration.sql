-- CreateEnum
CREATE TYPE "FirmType" AS ENUM ('OWN', 'SUBCONTRACTOR');

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "firmsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "firmId" UUID;

-- AlterTable
ALTER TABLE "Salary" ADD COLUMN     "firmId" UUID;

-- AlterTable
ALTER TABLE "PayrollRuleSet" ADD COLUMN     "firmId" UUID;

-- AlterTable
ALTER TABLE "Adjustment" ADD COLUMN     "firmId" UUID;

-- CreateTable
CREATE TABLE "Firm" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "FirmType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Firm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Firm_companyId_idx" ON "Firm"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Firm_id_companyId_key" ON "Firm"("id", "companyId");

-- CreateIndex
CREATE INDEX "Assignment_firmId_idx" ON "Assignment"("firmId");

-- CreateIndex
CREATE INDEX "Salary_firmId_idx" ON "Salary"("firmId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_firmId_key" ON "PayrollRuleSet"("companyId", "firmId");

-- AddForeignKey
ALTER TABLE "Firm" ADD CONSTRAINT "Firm_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_firmId_companyId_fkey" FOREIGN KEY ("firmId", "companyId") REFERENCES "Firm"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Salary" ADD CONSTRAINT "Salary_firmId_companyId_fkey" FOREIGN KEY ("firmId", "companyId") REFERENCES "Firm"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_firmId_companyId_fkey" FOREIGN KEY ("firmId", "companyId") REFERENCES "Firm"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Adjustment" ADD CONSTRAINT "Adjustment_firmId_companyId_fkey" FOREIGN KEY ("firmId", "companyId") REFERENCES "Firm"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Firm names are unique in a company, ignoring case.
CREATE UNIQUE INDEX "Firm_companyId_name_key" ON "Firm"("companyId", lower("name"));

-- A rule set is the company default, one site's or one firm's, never a site's and a firm's.
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_site_or_firm_check" CHECK ("siteId" IS NULL OR "firmId" IS NULL);

-- One company default: firm rule sets have no site either, so the index must leave them out.
DROP INDEX "PayrollRuleSet_companyId_default_key";
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_default_key" ON "PayrollRuleSet"("companyId") WHERE "siteId" IS NULL AND "firmId" IS NULL;
