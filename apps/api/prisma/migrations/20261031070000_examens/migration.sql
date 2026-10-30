-- CreateEnum
CREATE TYPE "ExamKind" AS ENUM ('MOCK', 'SEQUENCE', 'PROMOTION');

-- CreateTable
CREATE TABLE "ExamSession" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL,
    "sequenceId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "classIds" TEXT[],
    "mixClasses" BOOLEAN NOT NULL DEFAULT true,
    "supervisorsPerRoom" INTEGER NOT NULL DEFAULT 1,
    "resultsPublishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamPaper" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "maxScore" INTEGER NOT NULL DEFAULT 20,
    "classIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamRoom" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExamRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamCandidate" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "anonymityCode" TEXT NOT NULL,
    "roomId" TEXT,
    "seat" INTEGER,

    CONSTRAINT "ExamCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSupervision" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ExamSupervision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamScore" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "status" "GradeStatus" NOT NULL,
    "valueCenti" INTEGER,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamTransfer" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExamSession_schoolId_academicYearId_idx" ON "ExamSession"("schoolId", "academicYearId");

-- CreateIndex
CREATE INDEX "ExamPaper_schoolId_date_idx" ON "ExamPaper"("schoolId", "date");

-- CreateIndex
CREATE INDEX "ExamPaper_sessionId_idx" ON "ExamPaper"("sessionId");

-- CreateIndex
CREATE INDEX "ExamRoom_schoolId_idx" ON "ExamRoom"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamRoom_sessionId_roomId_key" ON "ExamRoom"("sessionId", "roomId");

-- CreateIndex
CREATE INDEX "ExamCandidate_schoolId_studentId_idx" ON "ExamCandidate"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCandidate_sessionId_studentId_key" ON "ExamCandidate"("sessionId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCandidate_sessionId_anonymityCode_key" ON "ExamCandidate"("sessionId", "anonymityCode");

-- CreateIndex
CREATE UNIQUE INDEX "ExamCandidate_sessionId_roomId_seat_key" ON "ExamCandidate"("sessionId", "roomId", "seat");

-- CreateIndex
CREATE INDEX "ExamSupervision_schoolId_userId_idx" ON "ExamSupervision"("schoolId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamSupervision_paperId_roomId_userId_key" ON "ExamSupervision"("paperId", "roomId", "userId");

-- CreateIndex
CREATE INDEX "ExamScore_schoolId_idx" ON "ExamScore"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamScore_paperId_candidateId_key" ON "ExamScore"("paperId", "candidateId");

-- CreateIndex
CREATE INDEX "ExamTransfer_schoolId_idx" ON "ExamTransfer"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ExamTransfer_paperId_classId_key" ON "ExamTransfer"("paperId", "classId");

-- AddForeignKey
ALTER TABLE "ExamPaper" ADD CONSTRAINT "ExamPaper_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamRoom" ADD CONSTRAINT "ExamRoom_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamCandidate" ADD CONSTRAINT "ExamCandidate_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamSupervision" ADD CONSTRAINT "ExamSupervision_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamScore" ADD CONSTRAINT "ExamScore_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamScore" ADD CONSTRAINT "ExamScore_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ExamCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamTransfer" ADD CONSTRAINT "ExamTransfer_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;
