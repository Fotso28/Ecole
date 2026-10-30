-- CreateEnum
CREATE TYPE "FiscalYearStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING_APPROVAL', 'POSTED', 'REJECTED');

-- CreateTable
CREATE TABLE "AccountingAccount" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingJournal" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "AccountingJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "FiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingEntry" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "journalCode" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "pieceRef" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "reversesEntryId" TEXT,
    "total" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingLine" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "label" TEXT,
    "debit" INTEGER NOT NULL DEFAULT 0,
    "credit" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL,

    CONSTRAINT "AccountingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "taxId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "pieceRef" TEXT NOT NULL,
    "status" "ExpenseStatus" NOT NULL,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingSettings" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "expenseApprovalThreshold" INTEGER NOT NULL DEFAULT 100000,

    CONSTRAINT "AccountingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingAccount_schoolId_number_key" ON "AccountingAccount"("schoolId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingJournal_schoolId_code_key" ON "AccountingJournal"("schoolId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_schoolId_startDate_key" ON "FiscalYear"("schoolId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingEntry_reversesEntryId_key" ON "AccountingEntry"("reversesEntryId");

-- CreateIndex
CREATE INDEX "AccountingEntry_schoolId_date_idx" ON "AccountingEntry"("schoolId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingEntry_schoolId_fiscalYearId_journalCode_number_key" ON "AccountingEntry"("schoolId", "fiscalYearId", "journalCode", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingEntry_schoolId_sourceType_sourceId_key" ON "AccountingEntry"("schoolId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "AccountingLine_schoolId_accountNumber_idx" ON "AccountingLine"("schoolId", "accountNumber");

-- CreateIndex
CREATE INDEX "AccountingLine_entryId_idx" ON "AccountingLine"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_schoolId_name_key" ON "Supplier"("schoolId", "name");

-- CreateIndex
CREATE INDEX "Expense_schoolId_status_idx" ON "Expense"("schoolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingSettings_schoolId_key" ON "AccountingSettings"("schoolId");

-- AddForeignKey
ALTER TABLE "AccountingEntry" ADD CONSTRAINT "AccountingEntry_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingLine" ADD CONSTRAINT "AccountingLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "AccountingEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Lignes : un montant entier positif, soit au débit, soit au crédit.
ALTER TABLE "AccountingLine" ADD CONSTRAINT "AccountingLine_amounts_check"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" = 0) <> ("credit" = 0)));
ALTER TABLE "AccountingEntry" ADD CONSTRAINT "AccountingEntry_number_check" CHECK ("number" >= 1 AND "total" > 0);
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_amount_check" CHECK ("amount" > 0);

-- Écritures comptables et lignes : ajout seul (correction par contre-passation).
CREATE TRIGGER "AccountingEntry_immutable"
  BEFORE UPDATE OR DELETE ON "AccountingEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER "AccountingLine_immutable"
  BEFORE UPDATE OR DELETE ON "AccountingLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- Nouvelle écriture : exercice ouvert de la même école, date dans l'exercice, numéro suivant
-- du journal (aucun trou), contre-passation d'une écriture de la même école.
CREATE OR REPLACE FUNCTION check_accounting_entry() RETURNS trigger AS $$
DECLARE
  fy RECORD;
  last_number INTEGER;
BEGIN
  SELECT "schoolId", "status", "startDate", "endDate" INTO fy
    FROM "FiscalYear" WHERE "id" = NEW."fiscalYearId" FOR SHARE;
  IF NOT FOUND OR fy."schoolId" <> NEW."schoolId" THEN
    RAISE EXCEPTION 'Exercice comptable introuvable';
  END IF;
  IF fy."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'Exercice clôturé : aucune nouvelle écriture n''est possible sur cette période';
  END IF;
  IF NEW."date" < fy."startDate" OR NEW."date" > fy."endDate" THEN
    RAISE EXCEPTION 'La date de l''écriture est hors de l''exercice';
  END IF;
  SELECT MAX("number") INTO last_number FROM "AccountingEntry"
    WHERE "schoolId" = NEW."schoolId" AND "fiscalYearId" = NEW."fiscalYearId"
      AND "journalCode" = NEW."journalCode";
  IF NEW."number" <> COALESCE(last_number, 0) + 1 THEN
    RAISE EXCEPTION 'Numérotation du journal % : % attendu', NEW."journalCode", COALESCE(last_number, 0) + 1;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AccountingJournal" WHERE "schoolId" = NEW."schoolId" AND "code" = NEW."journalCode") THEN
    RAISE EXCEPTION 'Journal inconnu : %', NEW."journalCode";
  END IF;
  IF NEW."reversesEntryId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AccountingEntry" WHERE "id" = NEW."reversesEntryId" AND "schoolId" = NEW."schoolId"
  ) THEN
    RAISE EXCEPTION 'Écriture contre-passée introuvable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountingEntry_check"
  BEFORE INSERT ON "AccountingEntry"
  FOR EACH ROW EXECUTE FUNCTION check_accounting_entry();

-- Ligne : écriture et compte de la même école.
CREATE OR REPLACE FUNCTION check_accounting_line() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AccountingEntry" WHERE "id" = NEW."entryId" AND "schoolId" = NEW."schoolId") THEN
    RAISE EXCEPTION 'Écriture introuvable pour cette ligne';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AccountingAccount" WHERE "schoolId" = NEW."schoolId" AND "number" = NEW."accountNumber") THEN
    RAISE EXCEPTION 'Compte inconnu du plan comptable : %', NEW."accountNumber";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountingLine_check"
  BEFORE INSERT ON "AccountingLine"
  FOR EACH ROW EXECUTE FUNCTION check_accounting_line();

-- Partie double, contrôlée à la validation de la transaction : au moins deux lignes, débits égaux
-- aux crédits et au total de l'écriture.
CREATE OR REPLACE FUNCTION check_accounting_balance() RETURNS trigger AS $$
DECLARE
  target TEXT;
  expected INTEGER;
  n INTEGER;
  d BIGINT;
  c BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'AccountingEntry' THEN
    target := NEW."id";
  ELSE
    target := NEW."entryId";
  END IF;
  SELECT "total" INTO expected FROM "AccountingEntry" WHERE "id" = target;
  SELECT COUNT(*), COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0) INTO n, d, c
    FROM "AccountingLine" WHERE "entryId" = target;
  IF n < 2 OR d <> c OR d <> expected THEN
    RAISE EXCEPTION 'Écriture déséquilibrée : % au débit, % au crédit', d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AccountingEntry_balanced"
  AFTER INSERT ON "AccountingEntry" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_accounting_balance();

CREATE CONSTRAINT TRIGGER "AccountingLine_balanced"
  AFTER INSERT ON "AccountingLine" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_accounting_balance();

-- Exercice : jamais supprimé, dates figées, une clôture est définitive.
CREATE OR REPLACE FUNCTION protect_fiscal_year() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un exercice comptable ne peut pas être supprimé';
  END IF;
  IF NEW."schoolId" <> OLD."schoolId" OR NEW."startDate" <> OLD."startDate" OR NEW."endDate" <> OLD."endDate" THEN
    RAISE EXCEPTION 'Les dates d''un exercice ne se modifient pas';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'Un exercice clôturé ne peut pas être rouvert ni modifié';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "FiscalYear_protected"
  BEFORE UPDATE OR DELETE ON "FiscalYear"
  FOR EACH ROW EXECUTE FUNCTION protect_fiscal_year();

-- Dépense : jamais supprimée ; seul le statut d'une dépense en attente évolue.
CREATE OR REPLACE FUNCTION protect_expense() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une dépense ne peut pas être supprimée';
  END IF;
  IF OLD."status" <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'Une dépense comptabilisée ou rejetée ne se modifie plus';
  END IF;
  IF NEW."schoolId" <> OLD."schoolId" OR NEW."amount" <> OLD."amount" OR NEW."accountNumber" <> OLD."accountNumber"
     OR NEW."method" <> OLD."method" OR NEW."supplierId" <> OLD."supplierId" OR NEW."date" <> OLD."date"
     OR NEW."pieceRef" <> OLD."pieceRef" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'Les données d''une dépense ne se modifient pas';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Expense_protected"
  BEFORE UPDATE OR DELETE ON "Expense"
  FOR EACH ROW EXECUTE FUNCTION protect_expense();
