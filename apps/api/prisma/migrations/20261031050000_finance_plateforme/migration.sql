-- CreateEnum
CREATE TYPE "SubscriptionPricing" AS ENUM ('PER_STUDENT', 'PER_MODULE');

-- CreateEnum
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('ISSUED', 'CANCELLED');

-- AlterTable
ALTER TABLE "OtpCode" ADD COLUMN     "sent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trusted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "OtpFailure" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricing" "SubscriptionPricing" NOT NULL,
    "pricePerStudent" INTEGER NOT NULL DEFAULT 0,
    "modulePrices" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolSubscription" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "pricing" "SubscriptionPricing" NOT NULL,
    "studentCount" INTEGER NOT NULL,
    "modules" TEXT[],
    "lines" JSONB NOT NULL,
    "amount" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "correctsId" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionReminder" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sentById" TEXT,
    "recipient" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OtpFailure_phone_createdAt_idx" ON "OtpFailure"("phone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_name_key" ON "SubscriptionPlan"("name");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSubscription_schoolId_key" ON "SchoolSubscription"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionInvoice_number_key" ON "SubscriptionInvoice"("number");

-- CreateIndex
CREATE INDEX "SubscriptionInvoice_schoolId_issuedAt_idx" ON "SubscriptionInvoice"("schoolId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_correctsId_key" ON "SubscriptionPayment"("correctsId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_schoolId_invoiceId_idx" ON "SubscriptionPayment"("schoolId", "invoiceId");

-- CreateIndex
CREATE INDEX "SubscriptionReminder_schoolId_invoiceId_idx" ON "SubscriptionReminder"("schoolId", "invoiceId");

-- CreateIndex
CREATE INDEX "OtpCode_sent_createdAt_idx" ON "OtpCode"("sent", "createdAt");

-- AddForeignKey
ALTER TABLE "SchoolSubscription" ADD CONSTRAINT "SchoolSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubscriptionInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionReminder" ADD CONSTRAINT "SubscriptionReminder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubscriptionInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Une seule facture d'abonnement en cours par établissement et par année.
CREATE UNIQUE INDEX "SubscriptionInvoice_active_period_key" ON "SubscriptionInvoice"("schoolId", "period") WHERE "status" = 'ISSUED';

-- Règlements d'abonnement en ajout seul (correction = nouvelle écriture).
CREATE TRIGGER "SubscriptionPayment_immutable"
  BEFORE UPDATE OR DELETE ON "SubscriptionPayment"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Facture émise : seule l'annulation (statut, date, motif) reste possible.
CREATE OR REPLACE FUNCTION protect_subscription_invoice() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une facture d''abonnement ne peut pas être supprimée';
  END IF;
  IF NEW."amount" <> OLD."amount" OR NEW."lines" IS DISTINCT FROM OLD."lines"
     OR NEW."schoolId" <> OLD."schoolId" OR NEW."number" <> OLD."number"
     OR NEW."studentCount" <> OLD."studentCount" OR NEW."modules" IS DISTINCT FROM OLD."modules"
     OR NEW."period" <> OLD."period" OR NEW."dueDate" <> OLD."dueDate" THEN
    RAISE EXCEPTION 'Une facture d''abonnement émise est figée (annuler puis réémettre)';
  END IF;
  IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Une facture annulée ne peut pas être rétablie';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SubscriptionInvoice_protected"
  BEFORE UPDATE OR DELETE ON "SubscriptionInvoice"
  FOR EACH ROW EXECUTE FUNCTION protect_subscription_invoice();
