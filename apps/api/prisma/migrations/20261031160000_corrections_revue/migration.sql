-- CreateEnum
CREATE TYPE "StaffInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "ExamSession" ADD COLUMN     "frozenCoefficients" JSONB;

-- AlterTable
ALTER TABLE "NotificationOutbox" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "sensitive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReportCard" ADD COLUMN     "needsRepublish" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "republishReason" TEXT;

-- AlterTable
ALTER TABLE "TransportSubscription" ADD COLUMN     "replacedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StaffInvitation" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roles" "StaffRole"[],
    "customRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxWeeklyHours" INTEGER,
    "status" "StaffInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "StaffInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffInvitation_schoolId_status_idx" ON "StaffInvitation"("schoolId", "status");

-- CreateIndex
CREATE INDEX "StaffInvitation_userId_status_idx" ON "StaffInvitation"("userId", "status");

-- Une seule invitation en attente par personne et par école.
CREATE UNIQUE INDEX "StaffInvitation_pending_key" ON "StaffInvitation"("schoolId", "userId") WHERE "status" = 'PENDING';

-- Codes de connexion : corps confidentiel effacé une fois le message traité.
UPDATE "NotificationOutbox" SET "sensitive" = true WHERE "template" = 'otp';
UPDATE "NotificationOutbox" SET "body" = '[code masqué]'
  WHERE "template" = 'otp' AND ("status" <> 'PENDING' OR "createdAt" < now() - interval '15 minutes');
UPDATE "NotificationOutbox" SET "status" = 'CANCELLED'
  WHERE "template" = 'otp' AND "status" = 'PENDING' AND "createdAt" < now() - interval '15 minutes';
