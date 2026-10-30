-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "ExpenseStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "encryptedPayout" TEXT;

-- CreateTable
CREATE TABLE "ManualEntryRequest" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "journalCode" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "pieceRef" TEXT,
    "lines" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualEntryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutDetailsChange" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "encryptedChange" TEXT NOT NULL,
    "beforeFingerprint" TEXT NOT NULL,
    "afterFingerprint" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutDetailsChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualEntryRequest_entryId_key" ON "ManualEntryRequest"("entryId");

-- CreateIndex
CREATE INDEX "ManualEntryRequest_schoolId_status_idx" ON "ManualEntryRequest"("schoolId", "status");

-- CreateIndex
CREATE INDEX "PayoutDetailsChange_schoolId_employeeId_status_idx" ON "PayoutDetailsChange"("schoolId", "employeeId", "status");

-- Un seul changement de coordonnées en attente par dossier.
CREATE UNIQUE INDEX "PayoutDetailsChange_one_pending" ON "PayoutDetailsChange"("schoolId", "employeeId") WHERE "status" = 'PENDING';

-- Une demande tranchée ne se modifie plus, et aucune demande ne se supprime.
CREATE OR REPLACE FUNCTION protect_approval_request() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une demande d''approbation ne peut pas être supprimée';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Une demande d''approbation tranchée ne se modifie plus';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayoutDetailsChange_protected"
  BEFORE UPDATE OR DELETE ON "PayoutDetailsChange"
  FOR EACH ROW EXECUTE FUNCTION protect_approval_request();

CREATE TRIGGER "ManualEntryRequest_protected"
  BEFORE UPDATE OR DELETE ON "ManualEntryRequest"
  FOR EACH ROW EXECUTE FUNCTION protect_approval_request();

-- Dépense : jamais supprimée ; une dépense en attente est validée ou rejetée, une dépense
-- comptabilisée peut seulement être annulée (statut et traces d'annulation).
CREATE OR REPLACE FUNCTION protect_expense() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une dépense ne peut pas être supprimée';
  END IF;
  IF NEW."schoolId" <> OLD."schoolId" OR NEW."amount" <> OLD."amount" OR NEW."accountNumber" <> OLD."accountNumber"
     OR NEW."method" <> OLD."method" OR NEW."supplierId" <> OLD."supplierId" OR NEW."date" <> OLD."date"
     OR NEW."pieceRef" <> OLD."pieceRef" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'Les données d''une dépense ne se modifient pas';
  END IF;
  IF OLD."status" = 'PENDING_APPROVAL' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'POSTED' AND NEW."status"::text = 'CANCELLED'
     AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
     AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
     AND NEW."rejectedReason" IS NOT DISTINCT FROM OLD."rejectedReason"
     AND NEW."label" = OLD."label"
     AND NEW."cancelledById" IS NOT NULL AND NEW."cancelReason" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Une dépense comptabilisée ou rejetée ne se modifie plus';
END;
$$ LANGUAGE plpgsql;
