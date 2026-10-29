-- AlterTable
ALTER TABLE "Worker" ADD COLUMN     "employeeNumber" TEXT;

-- AlterTable
ALTER TABLE "TimesheetEntry" ADD COLUMN     "importId" UUID;

-- CreateTable
CREATE TABLE "TimesheetImport" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "workers" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimesheetImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportMapping" (
    "companyId" UUID NOT NULL,
    "mapping" JSONB NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportMapping_pkey" PRIMARY KEY ("companyId")
);

-- CreateIndex
CREATE INDEX "TimesheetImport_companyId_year_month_idx" ON "TimesheetImport"("companyId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetImport_id_companyId_key" ON "TimesheetImport"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_companyId_employeeNumber_key" ON "Worker"("companyId", "employeeNumber");

-- CreateIndex
CREATE INDEX "TimesheetEntry_importId_idx" ON "TimesheetEntry"("importId");

-- AddForeignKey
ALTER TABLE "TimesheetEntry" ADD CONSTRAINT "TimesheetEntry_importId_companyId_fkey" FOREIGN KEY ("importId", "companyId") REFERENCES "TimesheetImport"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetImport" ADD CONSTRAINT "TimesheetImport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimesheetImport" ADD CONSTRAINT "TimesheetImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportMapping" ADD CONSTRAINT "ImportMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportMapping" ADD CONSTRAINT "ImportMapping_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Added by hand: what Prisma can't express.
ALTER TABLE "Worker" ADD CONSTRAINT "Worker_employeeNumber_check" CHECK ("employeeNumber" <> '' AND "employeeNumber" = btrim("employeeNumber"));
ALTER TABLE "TimesheetImport" ADD CONSTRAINT "TimesheetImport_check" CHECK ("month" BETWEEN 1 AND 12 AND "workers" >= 0);
