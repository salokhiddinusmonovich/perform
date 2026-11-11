-- Pay rules only in rule sets, every set split by the company's pay categories (AGENTS.md:
-- Pay rule sets). The company default rules become a named set the company uses, the
-- categories the sets split by become the company's pay categories, and every combination
-- gets the rules and working-days overrides its workers were paid by in each month, so no
-- pay changes. The rounding step moves to its own company setting.

-- CreateTable
CREATE TABLE "PayCategoryChoice" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "fromYear" INTEGER NOT NULL,
    "fromMonth" INTEGER NOT NULL,
    "firstCategoryId" UUID NOT NULL,
    "secondCategoryId" UUID,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayCategoryChoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayCategoryChoice_fromMonth_check" CHECK ("fromMonth" BETWEEN 1 AND 12),
    CONSTRAINT "PayCategoryChoice_categories_check" CHECK ("secondCategoryId" IS NULL OR "secondCategoryId" <> "firstCategoryId")
);

-- CreateTable
CREATE TABLE "PayRounding" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "fromYear" INTEGER NOT NULL,
    "fromMonth" INTEGER NOT NULL,
    "step" DECIMAL(14,2) NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayRounding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PayRounding_fromMonth_check" CHECK ("fromMonth" BETWEEN 1 AND 12),
    CONSTRAINT "PayRounding_step_check" CHECK ("step" > 0)
);

-- CreateIndex
CREATE INDEX "PayCategoryChoice_firstCategoryId_idx" ON "PayCategoryChoice"("firstCategoryId");
CREATE INDEX "PayCategoryChoice_secondCategoryId_idx" ON "PayCategoryChoice"("secondCategoryId");
CREATE UNIQUE INDEX "PayCategoryChoice_companyId_fromYear_fromMonth_key" ON "PayCategoryChoice"("companyId", "fromYear", "fromMonth");
CREATE UNIQUE INDEX "PayRounding_companyId_fromYear_fromMonth_key" ON "PayRounding"("companyId", "fromYear", "fromMonth");

-- AddForeignKey
ALTER TABLE "PayCategoryChoice" ADD CONSTRAINT "PayCategoryChoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PayCategoryChoice" ADD CONSTRAINT "PayCategoryChoice_firstCategoryId_companyId_fkey" FOREIGN KEY ("firstCategoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PayCategoryChoice" ADD CONSTRAINT "PayCategoryChoice_secondCategoryId_companyId_fkey" FOREIGN KEY ("secondCategoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "PayCategoryChoice" ADD CONSTRAINT "PayCategoryChoice_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PayRounding" ADD CONSTRAINT "PayRounding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "PayRounding" ADD CONSTRAINT "PayRounding_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- The company's choice of rule set is a use without a site or firm, and always has a set.
ALTER TABLE "RuleSetUse" DROP CONSTRAINT "RuleSetUse_site_or_firm_check";
ALTER TABLE "RuleSetUse" ADD CONSTRAINT "RuleSetUse_owner_check" CHECK (
  num_nonnulls("siteId", "firmId") <= 1 AND ("siteId" IS NOT NULL OR "firmId" IS NOT NULL OR "ruleSetId" IS NOT NULL)
);
CREATE UNIQUE INDEX "RuleSetUse_company_month_key" ON "RuleSetUse"("companyId", "fromYear", "fromMonth") WHERE "siteId" IS NULL AND "firmId" IS NULL;

-- The plan: for each top set, combination of the pay categories (its option ids) and month,
-- the rules (and per month the set whose overrides) its workers were paid by.
CREATE TEMP TABLE "mig_rules" ("topId" UUID, "optionIds" UUID[], "idx" INTEGER, "srcId" UUID);
CREATE TEMP TABLE "mig_overrides" ("topId" UUID, "optionIds" UUID[], "idx" INTEGER, "srcSetId" UUID);

DO $$
DECLARE
  co RECORD;
  t RECORD;
  cats UUID[];
  cat UUID;
  m0 INTEGER;
  who UUID;
  default_id UUID;
  set_name TEXT;
  n INTEGER;
  combos UUID[][];
  c UUID[];
  bounds INTEGER[];
  b INTEGER;
  split UUID[];
  src_set UUID;
  src UUID;
  prev UUID;
  had BOOLEAN;
BEGIN
  FOR co IN SELECT "id" FROM "Company" LOOP
    IF NOT EXISTS (SELECT 1 FROM "PayrollRules" WHERE "companyId" = co."id")
       AND NOT EXISTS (SELECT 1 FROM "RuleSetSplit" WHERE "companyId" = co."id") THEN
      CONTINUE;
    END IF;

    -- The pay categories: those the sets split by, in the order they were created.
    SELECT array_agg(x."id" ORDER BY x."createdAt", x."id") INTO cats FROM (
      SELECT DISTINCT wc."id", wc."createdAt"
      FROM "RuleSetSplit" s JOIN "WorkerCategory" wc ON wc."id" IN (s."firstCategoryId", s."secondCategoryId")
      WHERE s."companyId" = co."id"
    ) x;
    IF cats IS NULL THEN
      SELECT "id" INTO cat FROM "WorkerCategory" WHERE "companyId" = co."id" AND "name" = 'Direkt / Endirekt';
      IF cat IS NULL THEN
        -- A company with rules but no workers yet got no category (20261102150000).
        cat := gen_random_uuid();
        INSERT INTO "WorkerCategory" ("id", "companyId", "name") VALUES (cat, co."id", 'Direkt / Endirekt');
        INSERT INTO "WorkerCategoryOption" ("id", "companyId", "categoryId", "position", "name")
        VALUES (gen_random_uuid(), co."id", cat, 0, 'Direkt'), (gen_random_uuid(), co."id", cat, 1, 'Endirekt');
      END IF;
      cats := ARRAY[cat];
    END IF;
    IF cardinality(cats) > 2 THEN
      RAISE EXCEPTION 'Company % splits its rule sets by % categories; the company can have at most 2 pay categories. Change the splits before migrating.', co."id", cardinality(cats);
    END IF;

    SELECT x."idx", x."who" INTO m0, who FROM (
      SELECT "fromYear" * 12 + "fromMonth" - 1 AS "idx", "setById" AS "who", "setAt" FROM "PayrollRules" WHERE "companyId" = co."id"
      UNION ALL
      SELECT "fromYear" * 12 + "fromMonth" - 1, "setById", "setAt" FROM "RuleSetSplit" WHERE "companyId" = co."id"
    ) x ORDER BY x."idx", x."setAt" LIMIT 1;
    INSERT INTO "PayCategoryChoice" ("id", "companyId", "fromYear", "fromMonth", "firstCategoryId", "secondCategoryId", "setById")
    VALUES (gen_random_uuid(), co."id", m0 / 12, m0 % 12 + 1, cats[1], cats[2], who);

    -- The rounding step of each version of the company default.
    INSERT INTO "PayRounding" ("id", "companyId", "fromYear", "fromMonth", "step", "setById", "setAt")
    SELECT gen_random_uuid(), r."companyId", r."fromYear", r."fromMonth", r."payRoundingStep", r."setById", r."setAt"
    FROM "PayrollRules" r JOIN "PayrollRuleSet" s ON s."id" = r."ruleSetId"
    WHERE s."companyId" = co."id" AND s."name" IS NULL AND s."parentId" IS NULL AND r."payRoundingStep" IS NOT NULL;

    -- The company default becomes a named set that the company uses from its first rules.
    default_id := NULL;
    SELECT "id" INTO default_id FROM "PayrollRuleSet" WHERE "companyId" = co."id" AND "name" IS NULL AND "parentId" IS NULL;
    IF default_id IS NOT NULL THEN
      set_name := 'Kompaniya qoidalari';
      n := 1;
      WHILE EXISTS (SELECT 1 FROM "PayrollRuleSet" WHERE "companyId" = co."id" AND lower("name") = lower(set_name)) LOOP
        n := n + 1;
        set_name := 'Kompaniya qoidalari ' || n;
      END LOOP;
      UPDATE "PayrollRuleSet" SET "name" = set_name WHERE "id" = default_id;
      INSERT INTO "RuleSetUse" ("id", "companyId", "ruleSetId", "fromYear", "fromMonth", "setById", "setAt")
      SELECT gen_random_uuid(), co."id", default_id, "fromYear", "fromMonth", "setById", "setAt"
      FROM "PayrollRules" WHERE "ruleSetId" = default_id ORDER BY "fromYear", "fromMonth" LIMIT 1;
    END IF;

    -- Every combination of the pay categories' options, inactive ones too.
    IF cats[2] IS NULL THEN
      SELECT array_agg(ARRAY[o."id"]) INTO combos FROM "WorkerCategoryOption" o WHERE o."categoryId" = cats[1];
    ELSE
      SELECT array_agg(ARRAY[o1."id", o2."id"]) INTO combos
      FROM "WorkerCategoryOption" o1 CROSS JOIN "WorkerCategoryOption" o2
      WHERE o1."categoryId" = cats[1] AND o2."categoryId" = cats[2];
    END IF;
    IF combos IS NULL THEN
      RAISE EXCEPTION 'Company % has pay rules, but its pay categories have no options. Add options before migrating.', co."id";
    END IF;

    FOR t IN SELECT "id" FROM "PayrollRuleSet" WHERE "companyId" = co."id" AND "parentId" IS NULL LOOP
      -- The months where the rules a combination is paid by may change.
      SELECT array_agg(DISTINCT x."idx" ORDER BY x."idx") INTO bounds FROM (
        SELECT r."fromYear" * 12 + r."fromMonth" - 1 AS "idx" FROM "PayrollRules" r
        JOIN "PayrollRuleSet" s ON s."id" = r."ruleSetId" WHERE s."id" = t."id" OR s."parentId" = t."id"
        UNION
        SELECT "fromYear" * 12 + "fromMonth" - 1 FROM "RuleSetSplit" WHERE "ruleSetId" = t."id"
      ) x;

      FOREACH c SLICE 1 IN ARRAY combos LOOP
        had := FALSE;
        prev := NULL;
        FOREACH b IN ARRAY COALESCE(bounds, ARRAY[]::INTEGER[]) LOOP
          split := NULL;
          SELECT array_remove(ARRAY["firstCategoryId", "secondCategoryId"], NULL) INTO split
          FROM "RuleSetSplit" WHERE "ruleSetId" = t."id" AND "fromYear" * 12 + "fromMonth" - 1 <= b
          ORDER BY "fromYear" DESC, "fromMonth" DESC LIMIT 1;
          src_set := NULL;
          IF split IS NULL OR cardinality(split) = 0 THEN
            src_set := t."id";
          ELSE
            SELECT v."id" INTO src_set FROM "PayrollRuleSet" v
            WHERE v."parentId" = t."id" AND v."variantKey" = (
              SELECT string_agg(o."id"::TEXT, ',' ORDER BY o."id"::TEXT COLLATE "C")
              FROM "WorkerCategoryOption" o WHERE o."id" = ANY (c) AND o."categoryId" = ANY (split)
            );
          END IF;
          src := NULL;
          SELECT "id" INTO src FROM "PayrollRules"
          WHERE "ruleSetId" = src_set AND "fromYear" * 12 + "fromMonth" - 1 <= b
          ORDER BY "fromYear" DESC, "fromMonth" DESC LIMIT 1;
          IF src IS NULL THEN
            IF had THEN
              RAISE EXCEPTION 'Rule set % has no rules from %-% for the combination % after having had them; add its rules before migrating.', t."id", b / 12, b % 12 + 1, c;
            END IF;
            CONTINUE;
          END IF;
          IF src IS DISTINCT FROM prev THEN
            INSERT INTO "mig_rules" VALUES (t."id", c, b, src);
          END IF;
          prev := src;
          had := TRUE;
        END LOOP;

        -- Working-days overrides of each month any of the set's rules had one.
        FOR b IN
          SELECT DISTINCT w."year" * 12 + w."month" - 1 FROM "WorkingDaysOverride" w
          JOIN "PayrollRuleSet" s ON s."id" = w."ruleSetId" WHERE s."id" = t."id" OR s."parentId" = t."id"
        LOOP
          split := NULL;
          SELECT array_remove(ARRAY["firstCategoryId", "secondCategoryId"], NULL) INTO split
          FROM "RuleSetSplit" WHERE "ruleSetId" = t."id" AND "fromYear" * 12 + "fromMonth" - 1 <= b
          ORDER BY "fromYear" DESC, "fromMonth" DESC LIMIT 1;
          src_set := NULL;
          IF split IS NULL OR cardinality(split) = 0 THEN
            src_set := t."id";
          ELSE
            SELECT v."id" INTO src_set FROM "PayrollRuleSet" v
            WHERE v."parentId" = t."id" AND v."variantKey" = (
              SELECT string_agg(o."id"::TEXT, ',' ORDER BY o."id"::TEXT COLLATE "C")
              FROM "WorkerCategoryOption" o WHERE o."id" = ANY (c) AND o."categoryId" = ANY (split)
            );
          END IF;
          INSERT INTO "mig_overrides" VALUES (t."id", c, b, src_set);
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- The combinations the plan needs: the existing one with the same options, else a new one.
CREATE TEMP TABLE "mig_combos" AS
SELECT DISTINCT ON (p."topId", k."key") p."topId", p."optionIds", k."key", v."id" AS "comboId"
FROM (SELECT "topId", "optionIds" FROM "mig_rules" UNION SELECT "topId", "optionIds" FROM "mig_overrides") p
CROSS JOIN LATERAL (
  SELECT string_agg(x::TEXT, ',' ORDER BY x::TEXT COLLATE "C") AS "key" FROM unnest(p."optionIds") x
) k
LEFT JOIN "PayrollRuleSet" v ON v."parentId" = p."topId" AND v."variantKey" = k."key";

UPDATE "mig_combos" SET "comboId" = gen_random_uuid() WHERE "comboId" IS NULL AND "key" IS NOT NULL;
INSERT INTO "PayrollRuleSet" ("id", "companyId", "parentId", "variantKey")
SELECT m."comboId", s."companyId", m."topId", m."key"
FROM "mig_combos" m JOIN "PayrollRuleSet" s ON s."id" = m."topId"
WHERE NOT EXISTS (SELECT 1 FROM "PayrollRuleSet" v WHERE v."id" = m."comboId");
INSERT INTO "RuleSetVariantOption" ("companyId", "ruleSetId", "categoryId", "optionId")
SELECT o."companyId", m."comboId", o."categoryId", o."id"
FROM "mig_combos" m CROSS JOIN LATERAL unnest(m."optionIds") x JOIN "WorkerCategoryOption" o ON o."id" = x
ON CONFLICT DO NOTHING;

-- Rules: every version is rebuilt on its combination from what it was paid by.
CREATE TEMP TABLE "mig_rule_rows" AS
SELECT m."comboId", p."idx", r.*
FROM "mig_rules" p
JOIN "mig_combos" m ON m."topId" = p."topId" AND m."optionIds" = p."optionIds"
JOIN "PayrollRules" r ON r."id" = p."srcId";
DELETE FROM "PayrollRules";
INSERT INTO "PayrollRules" (
  "id", "companyId", "ruleSetId", "fromYear", "fromMonth", "restWeekdays", "normalHoursPerDay",
  "overtimeMultiplier", "restDayMultiplier", "holidayMultiplier", "leavePaid", "leaveHoursPerDay",
  "sickPaid", "sickHoursPerDay", "travelDayPaid", "travelDayHoursPerDay", "travelPayMode", "setById", "setAt"
)
SELECT gen_random_uuid(), "companyId", "comboId", "idx" / 12, "idx" % 12 + 1, "restWeekdays", "normalHoursPerDay",
  "overtimeMultiplier", "restDayMultiplier", "holidayMultiplier", "leavePaid", "leaveHoursPerDay",
  "sickPaid", "sickHoursPerDay", "travelDayPaid", "travelDayHoursPerDay", "travelPayMode", "setById", "setAt"
FROM "mig_rule_rows";

-- Overrides: a combination keeps its own for the months they counted; elsewhere it gets
-- the whole history (in order) of the set whose overrides counted, or none.
CREATE TEMP TABLE "mig_override_rows" AS
SELECT m."comboId", w."year", w."month", w."workingDays", w."reason", w."setById", w."setAt", w."seq"
FROM "mig_overrides" p
JOIN "mig_combos" m ON m."topId" = p."topId" AND m."optionIds" = p."optionIds"
JOIN "WorkingDaysOverride" w ON w."ruleSetId" = p."srcSetId" AND w."year" * 12 + w."month" - 1 = p."idx"
WHERE p."srcSetId" <> m."comboId";
DELETE FROM "WorkingDaysOverride" w
WHERE NOT EXISTS (
  SELECT 1 FROM "mig_overrides" p JOIN "mig_combos" m ON m."topId" = p."topId" AND m."optionIds" = p."optionIds"
  WHERE m."comboId" = w."ruleSetId" AND p."srcSetId" = m."comboId" AND w."year" * 12 + w."month" - 1 = p."idx"
);
INSERT INTO "WorkingDaysOverride" ("id", "companyId", "ruleSetId", "year", "month", "workingDays", "reason", "setById", "setAt")
SELECT gen_random_uuid(), s."companyId", r."comboId", r."year", r."month", r."workingDays", r."reason", r."setById", r."setAt"
FROM "mig_override_rows" r JOIN "PayrollRuleSet" s ON s."id" = r."comboId"
ORDER BY r."seq";

-- Combinations of the old splits that aren't combinations of the pay categories: their
-- rules and overrides are now on the combinations above.
DELETE FROM "RuleSetVariantOption" o
WHERE NOT EXISTS (SELECT 1 FROM "mig_combos" m WHERE m."comboId" = o."ruleSetId");
DELETE FROM "PayrollRuleSet" v
WHERE v."parentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "mig_combos" m WHERE m."comboId" = v."id");

DROP TABLE "mig_rules", "mig_overrides", "mig_combos", "mig_rule_rows", "mig_override_rows";

-- Every top set is named now.
DROP INDEX "PayrollRuleSet_companyId_default_key";
ALTER TABLE "PayrollRuleSet" DROP CONSTRAINT "PayrollRuleSet_variant_check";
ALTER TABLE "PayrollRuleSet" ADD CONSTRAINT "PayrollRuleSet_variant_check" CHECK (
  ("parentId" IS NULL AND "variantKey" IS NULL AND "name" IS NOT NULL)
  OR ("parentId" IS NOT NULL AND "variantKey" IS NOT NULL AND "name" IS NULL)
);

-- DropForeignKey
ALTER TABLE "RuleSetSplit" DROP CONSTRAINT "RuleSetSplit_ruleSetId_companyId_fkey";
ALTER TABLE "RuleSetSplit" DROP CONSTRAINT "RuleSetSplit_firstCategoryId_companyId_fkey";
ALTER TABLE "RuleSetSplit" DROP CONSTRAINT "RuleSetSplit_secondCategoryId_companyId_fkey";
ALTER TABLE "RuleSetSplit" DROP CONSTRAINT "RuleSetSplit_setById_fkey";

-- DropTable
DROP TABLE "RuleSetSplit";

-- The settings check names the rounding step: dropping the column would drop the whole check,
-- so it is replaced by one without it (the step's check is on PayRounding now).
ALTER TABLE "PayrollRules" DROP CONSTRAINT "PayrollRules_settings_check";
ALTER TABLE "PayrollRules" DROP COLUMN "payRoundingStep";
ALTER TABLE "PayrollRules" ADD CONSTRAINT "PayrollRules_settings_check" CHECK (
  "fromMonth" BETWEEN 1 AND 12
  AND "restWeekdays" IS NOT NULL
  AND "restWeekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  AND cardinality("restWeekdays") < 7
  AND "normalHoursPerDay" > 0 AND "normalHoursPerDay" <= 24
  AND "overtimeMultiplier" >= 0 AND "restDayMultiplier" >= 0 AND "holidayMultiplier" >= 0
  AND ("leaveHoursPerDay" IS NULL OR "leaveHoursPerDay" BETWEEN 0 AND 24)
  AND ("sickHoursPerDay" IS NULL OR "sickHoursPerDay" BETWEEN 0 AND 24)
  AND ("travelDayHoursPerDay" IS NULL OR "travelDayHoursPerDay" BETWEEN 0 AND 24)
);
