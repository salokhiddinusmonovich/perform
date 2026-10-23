-- Snapshots of what each lock of a month paid (AGENTS.md: Data integrity), never changed.

-- CreateTable
CREATE TABLE "PayrollSnapshot" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "periodId" UUID NOT NULL,
    "lockNumber" INTEGER NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "lockedById" UUID NOT NULL,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollSnapshotWorker" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "workerId" UUID NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "PayrollSnapshotWorker_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSnapshot_periodId_lockNumber_key" ON "PayrollSnapshot"("periodId", "lockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSnapshot_id_companyId_key" ON "PayrollSnapshot"("id", "companyId");

-- CreateIndex
CREATE INDEX "PayrollSnapshotWorker_companyId_idx" ON "PayrollSnapshotWorker"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSnapshotWorker_snapshotId_workerId_key" ON "PayrollSnapshotWorker"("snapshotId", "workerId");

-- AddForeignKey
ALTER TABLE "PayrollSnapshot" ADD CONSTRAINT "PayrollSnapshot_periodId_companyId_fkey" FOREIGN KEY ("periodId", "companyId") REFERENCES "PayrollPeriod"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSnapshot" ADD CONSTRAINT "PayrollSnapshot_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSnapshotWorker" ADD CONSTRAINT "PayrollSnapshotWorker_snapshotId_companyId_fkey" FOREIGN KEY ("snapshotId", "companyId") REFERENCES "PayrollSnapshot"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSnapshotWorker" ADD CONSTRAINT "PayrollSnapshotWorker_workerId_companyId_fkey" FOREIGN KEY ("workerId", "companyId") REFERENCES "Worker"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;


ALTER TABLE "PayrollSnapshot" ADD CONSTRAINT "PayrollSnapshot_range_check" CHECK ("lockNumber" >= 1);
