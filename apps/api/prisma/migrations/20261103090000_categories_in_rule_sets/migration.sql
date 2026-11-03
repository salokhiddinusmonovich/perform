-- Worker categories start from a month, and rule sets may split their rules by them
-- (AGENTS.md: Worker categories, Rule sets split by categories).

-- A worker's options become a history from a month on. Existing options count from the
-- month of the worker's first placement (or when the worker was added, without one), so
-- every month the worker has worked keeps the option it had.
ALTER TABLE "WorkerCategoryValue" DROP CONSTRAINT "WorkerCategoryValue_optionId_categoryId_companyId_fkey";
ALTER TABLE "WorkerCategoryValue" DROP CONSTRAINT "WorkerCategoryValue_pkey",
ADD COLUMN     "fromMonth" INTEGER,
ADD COLUMN     "fromYear" INTEGER,
ADD COLUMN     "id" UUID,
ADD COLUMN     "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "setById" UUID,
ALTER COLUMN "optionId" DROP NOT NULL;

UPDATE "WorkerCategoryValue" v
SET "id" = gen_random_uuid(),
    "fromYear" = EXTRACT(YEAR FROM s."start")::INTEGER,
    "fromMonth" = EXTRACT(MONTH FROM s."start")::INTEGER
FROM (
  SELECT w."id", COALESCE(MIN(a."hiredOn"), w."createdAt"::DATE) AS "start"
  FROM "Worker" w
  LEFT JOIN "Assignment" a ON a."workerId" = w."id"
  GROUP BY w."id", w."createdAt"
) s
WHERE s."id" = v."workerId";

ALTER TABLE "WorkerCategoryValue"
ALTER COLUMN "id" SET NOT NULL,
ALTER COLUMN "fromYear" SET NOT NULL,
ALTER COLUMN "fromMonth" SET NOT NULL,
ADD CONSTRAINT "WorkerCategoryValue_pkey" PRIMARY KEY ("id"),
ADD CONSTRAINT "WorkerCategoryValue_fromMonth_check" CHECK ("fromMonth" BETWEEN 1 AND 12);

CREATE INDEX "WorkerCategoryValue_categoryId_idx" ON "WorkerCategoryValue"("categoryId");
CREATE UNIQUE INDEX "WorkerCategoryValue_workerId_categoryId_fromYear_fromMonth_key" ON "WorkerCategoryValue"("workerId", "categoryId", "fromYear", "fromMonth");

-- MATCH SIMPLE: a row without an option ("not set") isn't checked.
ALTER TABLE "WorkerCategoryValue" ADD CONSTRAINT "WorkerCategoryValue_optionId_categoryId_companyId_fkey" FOREIGN KEY ("optionId", "categoryId", "companyId") REFERENCES "WorkerCategoryOption"("id", "categoryId", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "WorkerCategoryValue" ADD CONSTRAINT "WorkerCategoryValue_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Combinations of a rule set that splits by categories are rule sets with a parent.
ALTER TABLE "PayrollRuleSet" ADD COLUMN     "parentId" UUID,
ADD COLUMN     "variantKey" TEXT;
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_variant_check" CHECK (
  ("parentId" IS NULL AND "variantKey" IS NULL) OR ("parentId" IS NOT NULL AND "variantKey" IS NOT NULL AND "name" IS NULL)
);
CREATE UNIQUE INDEX "PayrollRuleSet_parentId_variantKey_key" ON "PayrollRuleSet"("parentId", "variantKey");
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_parentId_companyId_fkey" FOREIGN KEY ("parentId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The company default is the one set without a name or a parent.
DROP INDEX "PayrollRuleSet_companyId_default_key";
CREATE UNIQUE INDEX "PayrollRuleSet_companyId_default_key" ON "PayrollRuleSet"("companyId") WHERE "name" IS NULL AND "parentId" IS NULL;

-- CreateTable
CREATE TABLE "RuleSetSplit" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "ruleSetId" UUID NOT NULL,
    "fromYear" INTEGER NOT NULL,
    "fromMonth" INTEGER NOT NULL,
    "firstCategoryId" UUID,
    "secondCategoryId" UUID,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleSetSplit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RuleSetSplit_fromMonth_check" CHECK ("fromMonth" BETWEEN 1 AND 12),
    CONSTRAINT "RuleSetSplit_categories_check" CHECK (
      "secondCategoryId" IS NULL OR ("firstCategoryId" IS NOT NULL AND "firstCategoryId" <> "secondCategoryId")
    )
);

-- CreateTable
CREATE TABLE "RuleSetVariantOption" (
    "companyId" UUID NOT NULL,
    "ruleSetId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "optionId" UUID NOT NULL,

    CONSTRAINT "RuleSetVariantOption_pkey" PRIMARY KEY ("ruleSetId","categoryId")
);

-- CreateIndex
CREATE INDEX "RuleSetSplit_companyId_idx" ON "RuleSetSplit"("companyId");

-- CreateIndex
CREATE INDEX "RuleSetSplit_firstCategoryId_idx" ON "RuleSetSplit"("firstCategoryId");

-- CreateIndex
CREATE INDEX "RuleSetSplit_secondCategoryId_idx" ON "RuleSetSplit"("secondCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleSetSplit_ruleSetId_fromYear_fromMonth_key" ON "RuleSetSplit"("ruleSetId", "fromYear", "fromMonth");

-- CreateIndex
CREATE INDEX "RuleSetVariantOption_companyId_idx" ON "RuleSetVariantOption"("companyId");

-- CreateIndex
CREATE INDEX "RuleSetVariantOption_categoryId_idx" ON "RuleSetVariantOption"("categoryId");

-- CreateIndex
CREATE INDEX "RuleSetVariantOption_optionId_idx" ON "RuleSetVariantOption"("optionId");

-- AddForeignKey
ALTER TABLE "RuleSetSplit" ADD CONSTRAINT "RuleSetSplit_ruleSetId_companyId_fkey" FOREIGN KEY ("ruleSetId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetSplit" ADD CONSTRAINT "RuleSetSplit_firstCategoryId_companyId_fkey" FOREIGN KEY ("firstCategoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetSplit" ADD CONSTRAINT "RuleSetSplit_secondCategoryId_companyId_fkey" FOREIGN KEY ("secondCategoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetSplit" ADD CONSTRAINT "RuleSetSplit_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleSetVariantOption" ADD CONSTRAINT "RuleSetVariantOption_ruleSetId_companyId_fkey" FOREIGN KEY ("ruleSetId", "companyId") REFERENCES "PayrollRuleSet"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetVariantOption" ADD CONSTRAINT "RuleSetVariantOption_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RuleSetVariantOption" ADD CONSTRAINT "RuleSetVariantOption_optionId_categoryId_companyId_fkey" FOREIGN KEY ("optionId", "categoryId", "companyId") REFERENCES "WorkerCategoryOption"("id", "categoryId", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;
