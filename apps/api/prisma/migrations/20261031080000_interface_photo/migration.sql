-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'STUDENT_PHOTO';

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "photoConsentAt" TIMESTAMP(3),
ADD COLUMN     "photoConsentById" TEXT,
ADD COLUMN     "photoFileId" TEXT;

-- CreateIndex
CREATE INDEX "Enrollment_schoolId_academicYearId_status_idx" ON "Enrollment"("schoolId", "academicYearId", "status");

-- CreateIndex
CREATE INDEX "Payment_schoolId_createdAt_idx" ON "Payment"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "Student_schoolId_lastName_firstName_idx" ON "Student"("schoolId", "lastName", "firstName");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_photoFileId_fkey" FOREIGN KEY ("photoFileId") REFERENCES "StoredFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
