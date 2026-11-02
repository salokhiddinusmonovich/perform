-- A category's options keep the order they were added in (AGENTS.md: Worker categories).
-- Options added in one step can share a createdAt, so the order is stored.
ALTER TABLE "WorkerCategoryOption" ADD COLUMN "position" INTEGER;

UPDATE "WorkerCategoryOption" o
SET "position" = n."position"
FROM (
  SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "categoryId" ORDER BY "createdAt", "name") - 1)::int AS "position"
  FROM "WorkerCategoryOption"
) n
WHERE n."id" = o."id";

ALTER TABLE "WorkerCategoryOption" ALTER COLUMN "position" SET NOT NULL;

-- DropIndex
DROP INDEX "WorkerCategoryOption_categoryId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "WorkerCategoryOption_categoryId_position_key" ON "WorkerCategoryOption"("categoryId", "position");
