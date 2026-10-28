-- Departments (AGENTS.md: Departments): a company's tree of departments, set on brigades
-- (teams) and placements. Replaces the team's free-text department, whose values become
-- top-level departments. Existing companies keep departments off until an owner or admin
-- switches them on.

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "departmentsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "departmentId" UUID;

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "departmentId" UUID;

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "parentId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_companyId_idx" ON "Department"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_id_companyId_key" ON "Department"("id", "companyId");

-- CreateIndex: names are unique among siblings, ignoring case. NULLS NOT DISTINCT so
-- top-level departments (parentId null) are siblings too.
CREATE UNIQUE INDEX "Department_companyId_parentId_name_key" ON "Department"("companyId", "parentId", lower("name")) NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_departmentId_companyId_key" ON "Team"("id", "departmentId", "companyId");

-- CreateIndex
CREATE INDEX "Assignment_departmentId_idx" ON "Assignment"("departmentId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_parentId_companyId_fkey" FOREIGN KEY ("parentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_departmentId_companyId_fkey" FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: a placement with a team and a department has the team's department.
-- MATCH SIMPLE: not checked while either is null.
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_teamId_departmentId_companyId_fkey" FOREIGN KEY ("teamId", "departmentId", "companyId") REFERENCES "Team"("id", "departmentId", "companyId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Data: each company's free-text team departments become top-level departments (one per
-- name, ignoring case and surrounding spaces), and the teams and their placements get them.
INSERT INTO "Department" ("id", "companyId", "name")
SELECT gen_random_uuid(), "companyId", MIN(btrim("department"))
FROM "Team"
WHERE btrim(coalesce("department", '')) <> ''
GROUP BY "companyId", lower(btrim("department"));

UPDATE "Team" t
SET "departmentId" = d."id"
FROM "Department" d
WHERE d."companyId" = t."companyId" AND d."parentId" IS NULL AND lower(d."name") = lower(btrim(t."department"));

UPDATE "Assignment" a
SET "departmentId" = t."departmentId"
FROM "Team" t
WHERE a."teamId" = t."id" AND t."departmentId" IS NOT NULL;

-- AlterTable: the free text is now in Department; foremanName was unused (foremen are MemberTeam).
ALTER TABLE "Team" DROP COLUMN "department",
DROP COLUMN "foremanName";
