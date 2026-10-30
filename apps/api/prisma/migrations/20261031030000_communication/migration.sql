-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('PARENT', 'STAFF');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('PARENT_MEETING', 'HOLIDAY', 'CELEBRATION', 'OUTING', 'EXAM', 'OTHER');

-- CreateEnum
CREATE TYPE "EventScope" AS ENUM ('SCHOOL', 'CYCLE', 'LEVEL', 'CLASS');

-- AlterEnum
ALTER TYPE "AnnouncementScope" ADD VALUE 'STUDENTS';

-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "studentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "MessageThread" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "guardianId" TEXT NOT NULL,
    "staffUserId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentLastReadAt" TIMESTAMP(3),
    "staffLastReadAt" TIMESTAMP(3),

    CONSTRAINT "MessageThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorKind" "MessageAuthor" NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolEvent" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "EventCategory" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "location" TEXT,
    "scope" "EventScope" NOT NULL,
    "targetId" TEXT,
    "remindBySms" BOOLEAN NOT NULL DEFAULT false,
    "reminderSentAt" TIMESTAMP(3),
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageThread_schoolId_staffUserId_lastMessageAt_idx" ON "MessageThread"("schoolId", "staffUserId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "MessageThread_schoolId_guardianId_idx" ON "MessageThread"("schoolId", "guardianId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageThread_studentId_guardianId_staffUserId_key" ON "MessageThread"("studentId", "guardianId", "staffUserId");

-- CreateIndex
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_schoolId_idx" ON "Message"("schoolId");

-- CreateIndex
CREATE INDEX "SchoolEvent_schoolId_startDate_idx" ON "SchoolEvent"("schoolId", "startDate");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "MessageThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un message envoyé ne se modifie plus : la direction consulte le fil tel qu'il a été écrit.
CREATE OR REPLACE FUNCTION forbid_message_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Un message envoyé ne peut pas être modifié';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Message_immutable"
  BEFORE UPDATE ON "Message"
  FOR EACH ROW EXECUTE FUNCTION forbid_message_update();
