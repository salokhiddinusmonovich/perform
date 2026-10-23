-- Hours entered as monthly totals per placement (AGENTS.md: Modules), only ever added.

-- CreateTable
CREATE TABLE "MonthlyHours" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "normalHours" DECIMAL(5,2) NOT NULL,
    "overtimeHours" DECIMAL(5,2) NOT NULL,
    "restDayHours" DECIMAL(5,2) NOT NULL,
    "holidayHours" DECIMAL(5,2) NOT NULL,
    "workdaysWorked" INTEGER NOT NULL,
    "leaveDays" INTEGER NOT NULL,
    "sickDays" INTEGER NOT NULL,
    "travelDays" INTEGER NOT NULL,
    "note" TEXT,
    "seq" BIGSERIAL NOT NULL,
    "setById" UUID NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyHours_seq_key" ON "MonthlyHours"("seq");

-- CreateIndex
CREATE INDEX "MonthlyHours_assignmentId_year_month_idx" ON "MonthlyHours"("assignmentId", "year", "month");

-- CreateIndex
CREATE INDEX "MonthlyHours_companyId_year_month_idx" ON "MonthlyHours"("companyId", "year", "month");

-- AddForeignKey
ALTER TABLE "MonthlyHours" ADD CONSTRAINT "MonthlyHours_assignmentId_companyId_fkey" FOREIGN KEY ("assignmentId", "companyId") REFERENCES "Assignment"("id", "companyId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyHours" ADD CONSTRAINT "MonthlyHours_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Value ranges Prisma can't express (the same as the shared zod schema).
ALTER TABLE "MonthlyHours" ADD CONSTRAINT "MonthlyHours_range_check" CHECK (
  "month" BETWEEN 1 AND 12
  AND "normalHours" BETWEEN 0 AND 744 AND "overtimeHours" BETWEEN 0 AND 744
  AND "restDayHours" BETWEEN 0 AND 744 AND "holidayHours" BETWEEN 0 AND 744
  AND "workdaysWorked" BETWEEN 0 AND 31 AND "leaveDays" BETWEEN 0 AND 31
  AND "sickDays" BETWEEN 0 AND 31 AND "travelDays" BETWEEN 0 AND 31
);
