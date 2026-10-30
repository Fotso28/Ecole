-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('INDISCIPLINE', 'INSOLENCE', 'VIOLENCE', 'FRAUD', 'DAMAGE', 'TRUANCY', 'DRESS_CODE', 'OTHER');

-- CreateEnum
CREATE TYPE "SanctionType" AS ENUM ('NONE', 'WARNING', 'DETENTION', 'BLAME', 'TEMPORARY_EXCLUSION', 'DISCIPLINARY_COUNCIL', 'PERMANENT_EXCLUSION', 'OTHER');

-- CreateEnum
CREATE TYPE "AdminDocumentType" AS ENUM ('SCHOOL_CERTIFICATE', 'ENROLLMENT_ATTESTATION', 'STUDENT_CARD');

-- CreateEnum
CREATE TYPE "AdminDocumentStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Incident" ADD COLUMN     "sanctionType" "SanctionType" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "type" "IncidentType" NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "type" "AdminDocumentType" NOT NULL,
    "title" TEXT,
    "headerLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signatoryName" TEXT,
    "signatoryTitle" TEXT,
    "mentions" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminDocument" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "type" "AdminDocumentType" NOT NULL,
    "number" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "verificationCode" TEXT NOT NULL,
    "status" "AdminDocumentStatus" NOT NULL DEFAULT 'ISSUED',
    "duplicateOfId" TEXT,
    "photoKey" TEXT,
    "issuedById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "AdminDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_schoolId_type_key" ON "DocumentTemplate"("schoolId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AdminDocument_verificationCode_key" ON "AdminDocument"("verificationCode");

-- CreateIndex
CREATE INDEX "AdminDocument_schoolId_issuedAt_idx" ON "AdminDocument"("schoolId", "issuedAt");

-- CreateIndex
CREATE INDEX "AdminDocument_schoolId_studentId_idx" ON "AdminDocument"("schoolId", "studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminDocument_schoolId_number_key" ON "AdminDocument"("schoolId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AdminDocument_schoolId_type_academicYearId_sequence_key" ON "AdminDocument"("schoolId", "type", "academicYearId", "sequence");

-- CreateIndex
CREATE INDEX "Incident_schoolId_date_idx" ON "Incident"("schoolId", "date");

-- Incidents existants : une sanction saisie en texte libre devient la catégorie « autre ».
UPDATE "Incident" SET "sanctionType" = 'OTHER' WHERE "sanction" IS NOT NULL AND btrim("sanction") <> '';

-- Documents délivrés : jamais supprimés ; contenu, numéro et code figés. Seule l'annulation est permise.
CREATE OR REPLACE FUNCTION protect_admin_document() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un document délivré ne peut pas être supprimé (l''annuler)';
  END IF;
  IF NEW."data" IS DISTINCT FROM OLD."data"
    OR NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."studentId" IS DISTINCT FROM OLD."studentId"
    OR NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
    OR NEW."verificationCode" IS DISTINCT FROM OLD."verificationCode"
    OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" THEN
    RAISE EXCEPTION 'Un document délivré est figé : délivrer un nouveau document';
  END IF;
  IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Un document annulé ne peut pas être rétabli';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdminDocument_protected"
  BEFORE UPDATE OR DELETE ON "AdminDocument"
  FOR EACH ROW EXECUTE FUNCTION protect_admin_document();
