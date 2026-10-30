-- CreateEnum
CREATE TYPE "StaffPayoutKind" AS ENUM ('PAYROLL', 'ADVANCE');

-- CreateTable
CREATE TABLE "StaffPayout" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "kind" "StaffPayoutKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "amount" INTEGER NOT NULL,
    "paidById" TEXT NOT NULL,
    "sameAsValidator" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffPayout_schoolId_date_idx" ON "StaffPayout"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPayout_schoolId_kind_sourceId_key" ON "StaffPayout"("schoolId", "kind", "sourceId");

-- Versements au personnel en ajout seul : une erreur se corrige par une écriture comptable.
CREATE OR REPLACE FUNCTION forbid_staff_payout_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Les versements au personnel ne peuvent être ni modifiés ni supprimés';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "StaffPayout_immutable"
  BEFORE UPDATE OR DELETE ON "StaffPayout"
  FOR EACH ROW EXECUTE FUNCTION forbid_staff_payout_mutation();
