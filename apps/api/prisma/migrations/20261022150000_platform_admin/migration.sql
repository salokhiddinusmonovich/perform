-- AlterTable
ALTER TABLE "Company" DROP COLUMN "timesheetModule",
ADD COLUMN     "paidUntil" DATE,
ADD COLUMN     "planId" UUID;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "impersonatedCompanyId" UUID,
ADD COLUMN     "impersonatedUserId" UUID,
ADD COLUMN     "impersonationEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "impersonatorUserId" UUID;

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPrice" DECIMAL(14,2) NOT NULL,
    "maxActiveWorkers" INTEGER NOT NULL,
    "timesheetModule" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "paidUntil" DATE NOT NULL,
    "note" TEXT,
    "recordedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_name_key" ON "Plan"("name");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_companyId_createdAt_idx" ON "SubscriptionPayment"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_impersonatedUserId_fkey" FOREIGN KEY ("impersonatedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_impersonatorUserId_fkey" FOREIGN KEY ("impersonatorUserId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- Hand-written: rules Prisma can't express.
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_maxActiveWorkers_positive" CHECK ("maxActiveWorkers" > 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_monthlyPrice_not_negative" CHECK ("monthlyPrice" >= 0);
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_amount_not_negative" CHECK ("amount" >= 0);
-- An impersonation has a user and an end, or neither.
ALTER TABLE "Session" ADD CONSTRAINT "Session_impersonation_complete"
  CHECK (("impersonatedUserId" IS NULL) = ("impersonationEndsAt" IS NULL));
