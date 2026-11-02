-- Named rule sets that sites and firms share (AGENTS.md: Pay rule sets). A rule set no longer
-- belongs to one site or firm: RuleSetUse says who uses which, from a month.

-- AlterTable
ALTER TABLE "PayrollRuleSet" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "RuleSetUse" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "firmId" UUID,
    "ruleSetId" UUID,
    "fromYear" INTEGER NOT NULL,
    "fromMonth" INTEGER NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleSetUse_pkey" PRIMARY KEY ("id")
);

-- Existing site and firm rule sets become named sets, called after their site or firm. A firm
-- named like a site gets "(firm)" added, as names are unique in a company.
UPDATE "PayrollRuleSet" r SET "name" = s."name" FROM "Site" s WHERE s."id" = r."siteId";
UPDATE "PayrollRuleSet" r
SET "name" = CASE
  WHEN EXISTS (SELECT 1 FROM "PayrollRuleSet" o WHERE o."companyId" = r."companyId" AND lower(o."name") = lower(f."name"))
    THEN f."name" || ' (firm)'
  ELSE f."name"
END
FROM "Firm" f WHERE f."id" = r."firmId";

-- They are used from their first version on: before it they had no rules to apply.
INSERT INTO "RuleSetUse" ("id", "companyId", "siteId", "firmId", "ruleSetId", "fromYear", "fromMonth", "setById", "setAt")
SELECT gen_random_uuid(), r."companyId", r."siteId", r."firmId", r."id", v."fromYear", v."fromMonth", v."setById", v."setAt"
FROM "PayrollRuleSet" r
JOIN LATERAL (
  SELECT * FROM "PayrollRules" p WHERE p."ruleSetId" = r."id" ORDER BY p."fromYear", p."fromMonth" LIMIT 1
) v ON true
WHERE r."siteId" IS NOT NULL OR r."firmId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_siteId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_firmId_companyId_fkey";

-- Rule sets are no longer tied to a site or firm.
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_site_or_firm_check";
DROP INDEX "PayrollRuleSet_companyId_default_key";

-- DropIndex
DROP INDEX "PayrollRuleSet_companyId_siteId_key";

-- DropIndex
DROP INDEX "PayrollRuleSet_companyId_firmId_key";

-- AlterTable
ALTER TABLE "PayrollRuleSet" DROP COLUMN "firmId",
DROP COLUMN "siteId";

-- CreateIndex
CREATE INDEX "RuleSetUse_companyId_idx" ON "RuleSetUse"("companyId");

-- CreateIndex
CREATE INDEX "RuleSetUse_ruleSetId_idx" ON "RuleSetUse"("ruleSetId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSetUse_siteId_fromYear_fromMonth_key" ON "RuleSetUse"("siteId", "fromYear", "fromMonth");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSetUse_firmId_fromYear_fromMonth_key" ON "RuleSetUse"("firmId", "fromYear", "fromMonth");

-- CreateIndex
CREATE INDEX "PayrollRuleSet_companyId_idx" ON "PayrollRuleSet"("companyId");

-- AddForeignKey
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_siteId_companyId_fkey" FOREIGN KEY ("siteId", "companyId") REFERENCES "Site"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_firmId_companyId_fkey" FOREIGN KEY ("firmId", "companyId") REFERENCES "Firm"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_ruleSetId_companyId_fkey" FOREIGN KEY ("ruleSetId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- One company default: the rule set without a name.
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_default_key" ON "PayrollRuleSet"("companyId") WHERE "name" IS NULL;

-- Rule set names are unique in a company, ignoring case.
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_name_key" ON "PayrollRuleSet"("companyId", lower("name")) WHERE "name" IS NOT NULL;

-- A use belongs to one site or one firm, never both.
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_site_or_firm_check" CHECK (("siteId" IS NULL) <> ("firmId" IS NULL));
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_fromMonth_check" CHECK ("fromMonth" BETWEEN 1 AND 12);
