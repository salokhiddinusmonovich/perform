-- CreateTable
CREATE TABLE "WorkerCategory" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCategoryOption" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerCategoryOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerCategoryValue" (
    "companyId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "optionId" UUID NOT NULL,

    CONSTRAINT "WorkerCategoryValue_pkey" PRIMARY KEY ("workerId","categoryId")
);

-- CreateIndex
CREATE INDEX "WorkerCategory_companyId_idx" ON "WorkerCategory"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerCategory_id_companyId_key" ON "WorkerCategory"("id", "companyId");

-- CreateIndex
CREATE INDEX "WorkerCategoryOption_categoryId_idx" ON "WorkerCategoryOption"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerCategoryOption_id_categoryId_companyId_key" ON "WorkerCategoryOption"("id", "categoryId", "companyId");

-- CreateIndex
CREATE INDEX "WorkerCategoryValue_companyId_idx" ON "WorkerCategoryValue"("companyId");

-- CreateIndex
CREATE INDEX "WorkerCategoryValue_optionId_idx" ON "WorkerCategoryValue"("optionId");

-- AddForeignKey
ALTER TABLE "WorkerCategory" ADD CONSTRAINT "WorkerCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCategoryOption" ADD CONSTRAINT "WorkerCategoryOption_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCategoryValue" ADD CONSTRAINT "WorkerCategoryValue_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCategoryValue" ADD CONSTRAINT "WorkerCategoryValue_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "WorkerCategory"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerCategoryValue" ADD CONSTRAINT "WorkerCategoryValue_optionId_categoryId_companyId_fkey" FOREIGN KEY ("optionId", "categoryId", "companyId") REFERENCES "WorkerCategoryOption"("id", "categoryId", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Direct/Indirect becomes a worker category (AGENTS.md: Worker categories): every company
-- with workers gets "Direkt / Endirekt", with each worker's value. The names are the
-- customers' own words and can be renamed.
INSERT INTO "WorkerCategory" ("id", "companyId", "name")
SELECT gen_random_uuid(), c."companyId", 'Direkt / Endirekt'
FROM (SELECT DISTINCT "companyId" FROM "Worker") c;

INSERT INTO "WorkerCategoryOption" ("id", "companyId", "categoryId", "name")
SELECT gen_random_uuid(), wc."companyId", wc."id", o."name"
FROM "WorkerCategory" wc
CROSS JOIN (VALUES ('Direkt'), ('Endirekt')) AS o("name");

INSERT INTO "WorkerCategoryValue" ("companyId", "workerId", "categoryId", "optionId")
SELECT w."companyId", w."id", o."categoryId", o."id"
FROM "Worker" w
JOIN "WorkerCategoryOption" o
  ON o."companyId" = w."companyId"
 AND o."name" = CASE w."employmentType" WHEN 'DIRECT' THEN 'Direkt' ELSE 'Endirekt' END;

-- Saved Excel import mappings: the employment type column and its values become the
-- category's column and options.
UPDATE "ImportMapping" m
SET "mapping" = ((m."mapping" #- '{columns,employmentType}') - 'values')
  || jsonb_build_object('categories', COALESCE((
    SELECT jsonb_build_object(wc."id"::text, jsonb_build_object(
      'column', m."mapping"->'columns'->>'employmentType',
      'values', COALESCE((
        SELECT jsonb_object_agg(v.key, o."id"::text)
        FROM jsonb_each_text(COALESCE(m."mapping"->'values'->'employmentType', '{}'::jsonb)) v
        JOIN "WorkerCategoryOption" o
          ON o."categoryId" = wc."id"
         AND o."name" = CASE v.value WHEN 'DIRECT' THEN 'Direkt' ELSE 'Endirekt' END
      ), '{}'::jsonb)))
    FROM "WorkerCategory" wc
    WHERE wc."companyId" = m."companyId" AND m."mapping"->'columns'->>'employmentType' IS NOT NULL
  ), '{}'::jsonb));

-- AlterTable
ALTER TABLE "Worker" DROP COLUMN "employmentType";

-- DropEnum
DROP TYPE "EmploymentType";
