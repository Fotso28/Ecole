-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('STUDENT_DOCUMENT', 'JUSTIFICATION', 'COURSE_MATERIAL');

-- AlterTable
ALTER TABLE "Justification" ADD COLUMN     "fileId" TEXT;

-- AlterTable
ALTER TABLE "StudentDocument" ADD COLUMN     "fileId" TEXT;

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonLog" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "classSubjectId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT,
    "content" TEXT NOT NULL,
    "homework" TEXT,
    "homeworkDueDate" DATE,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "LessonLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseMaterial" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "classSubjectId" TEXT NOT NULL,
    "lessonLogId" TEXT,
    "title" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CourseMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_storageKey_key" ON "StoredFile"("storageKey");

-- CreateIndex
CREATE INDEX "StoredFile_schoolId_category_idx" ON "StoredFile"("schoolId", "category");

-- CreateIndex
CREATE INDEX "LessonLog_schoolId_classId_date_idx" ON "LessonLog"("schoolId", "classId", "date");

-- CreateIndex
CREATE INDEX "LessonLog_schoolId_classId_homeworkDueDate_idx" ON "LessonLog"("schoolId", "classId", "homeworkDueDate");

-- CreateIndex
CREATE INDEX "LessonLog_classSubjectId_date_idx" ON "LessonLog"("classSubjectId", "date");

-- CreateIndex
CREATE INDEX "CourseMaterial_schoolId_classId_idx" ON "CourseMaterial"("schoolId", "classId");

-- CreateIndex
CREATE INDEX "CourseMaterial_classSubjectId_idx" ON "CourseMaterial"("classSubjectId");

-- AddForeignKey
ALTER TABLE "StudentDocument" ADD CONSTRAINT "StudentDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Justification" ADD CONSTRAINT "Justification_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseMaterial" ADD CONSTRAINT "CourseMaterial_lessonLogId_fkey" FOREIGN KEY ("lessonLogId") REFERENCES "LessonLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseMaterial" ADD CONSTRAINT "CourseMaterial_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "StoredFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
