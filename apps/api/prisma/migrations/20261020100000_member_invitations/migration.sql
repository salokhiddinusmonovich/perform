-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "invitedEmail" TEXT,
ADD COLUMN     "invitedName" TEXT,
ADD COLUMN     "invitedPhone" TEXT;

-- Everyone who is already a member got in before invitations existed: accepted.
UPDATE "Membership" SET "acceptedAt" = "createdAt";
