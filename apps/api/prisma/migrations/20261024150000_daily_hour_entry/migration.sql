-- Daily hour entry (AGENTS.md: Hour entry, Mobile app): who may enter hours is a company
-- setting, and every entry records who created and last changed it, and a version that
-- refuses stale writes. There was no way to enter daily hours before this, so the table
-- is empty; refuse to run rather than invent who entered existing rows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TimesheetEntry") THEN
    RAISE EXCEPTION 'TimesheetEntry has rows; set who entered them by hand before this migration';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "TimesheetEntry" ADD COLUMN     "createdById" UUID NOT NULL,
ADD COLUMN     "updatedById" UUID NOT NULL,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CHECK: versions start at 1.
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_version_check" CHECK ("version" >= 1);

-- CreateTable
CREATE TABLE "TimesheetSettings" (
    "companyId" UUID NOT NULL,
    "entryRoles" "Role"[] NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetSettings_pkey" PRIMARY KEY ("companyId")
);

-- CHECK: timekeepers and/or foremen, at least one (owners and admins always may).
ALTER TABLE "TimesheetSettings" ADD CONSTRAINT "TimesheetSettings_entryRoles_check"
  CHECK (cardinality("entryRoles") > 0 AND "entryRoles" <@ ARRAY['TIMEKEEPER', 'FOREMAN']::"Role"[]);

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetSettings" ADD CONSTRAINT "TimesheetSettings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetSettings" ADD CONSTRAINT "TimesheetSettings_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
