-- CreateTable
CREATE TABLE "ImportedDayEdit" (
    "workerId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "companyId" UUID NOT NULL,

    CONSTRAINT "ImportedDayEdit_pkey" PRIMARY KEY ("workerId","date")
);

-- CreateIndex
CREATE INDEX "ImportedDayEdit_companyId_date_idx" ON "ImportedDayEdit"("companyId", "date");

-- AddForeignKey
ALTER TABLE "ImportedDayEdit" ADD CONSTRAINT "ImportedDayEdit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedDayEdit" ADD CONSTRAINT "ImportedDayEdit_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

