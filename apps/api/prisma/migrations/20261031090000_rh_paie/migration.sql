-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('CDI', 'CDD', 'HOURLY');

-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'MOBILE_MONEY', 'CASH');

-- CreateEnum
CREATE TYPE "TeachingSessionKind" AS ENUM ('REGULAR', 'OVERTIME');

-- CreateEnum
CREATE TYPE "TeachingSessionStatus" AS ENUM ('DONE', 'ABSENT');

-- CreateEnum
CREATE TYPE "SalaryAdvanceStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'REPAID');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'PREPARED', 'VALIDATED');

-- CreateTable
CREATE TABLE "EmployeeFile" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "hireDate" DATE NOT NULL,
    "diplomas" JSONB NOT NULL DEFAULT '[]',
    "payoutMethod" "PayoutMethod" NOT NULL DEFAULT 'CASH',
    "encryptedSensitive" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmploymentContract" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" "ContractType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "baseSalary" INTEGER,
    "hourlyRate" INTEGER,
    "overtimeRate" INTEGER,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmploymentContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeachingSession" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timetableEntryId" TEXT,
    "minutes" INTEGER NOT NULL,
    "kind" "TeachingSessionKind" NOT NULL DEFAULT 'REGULAR',
    "status" "TeachingSessionStatus" NOT NULL,
    "justified" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeachingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryAdvance" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "installments" INTEGER NOT NULL,
    "firstMonth" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "SalaryAdvanceStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvanceRepayment" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollScale" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "scale" JSONB NOT NULL,
    "computedById" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "preparedById" TEXT,
    "preparedAt" TIMESTAMP(3),
    "validatedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" TEXT,
    "contractType" "ContractType" NOT NULL,
    "elements" JSONB NOT NULL DEFAULT '[]',
    "absenceDays" INTEGER NOT NULL DEFAULT 0,
    "inputs" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "gross" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "employerCost" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeFile_schoolId_userId_key" ON "EmployeeFile"("schoolId", "userId");

-- CreateIndex
CREATE INDEX "EmploymentContract_schoolId_employeeId_idx" ON "EmploymentContract"("schoolId", "employeeId");

-- CreateIndex
CREATE INDEX "TeachingSession_schoolId_teacherId_date_idx" ON "TeachingSession"("schoolId", "teacherId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "TeachingSession_timetableEntryId_date_key" ON "TeachingSession"("timetableEntryId", "date");

-- CreateIndex
CREATE INDEX "SalaryAdvance_schoolId_status_idx" ON "SalaryAdvance"("schoolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceRepayment_advanceId_payslipId_key" ON "AdvanceRepayment"("advanceId", "payslipId");

-- CreateIndex
CREATE INDEX "PayrollScale_schoolId_effectiveFrom_idx" ON "PayrollScale"("schoolId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_schoolId_month_key" ON "PayrollRun"("schoolId", "month");

-- CreateIndex
CREATE INDEX "Payslip_schoolId_idx" ON "Payslip"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_runId_employeeId_key" ON "Payslip"("runId", "employeeId");

-- AddForeignKey
ALTER TABLE "EmploymentContract" ADD CONSTRAINT "EmploymentContract_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "EmployeeFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "EmployeeFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceRepayment" ADD CONSTRAINT "AdvanceRepayment_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "SalaryAdvance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Paie validée : figée. Une correction passe par un rappel sur la paie du mois suivant.
CREATE OR REPLACE FUNCTION protect_validated_payroll_run() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'VALIDATED' THEN
    RAISE EXCEPTION 'Une paie validée est figée : passer par un rappel le mois suivant';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollRun_protected"
  BEFORE UPDATE OR DELETE ON "PayrollRun"
  FOR EACH ROW EXECUTE FUNCTION protect_validated_payroll_run();

CREATE OR REPLACE FUNCTION protect_validated_payslip() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PayrollRun" WHERE "id" = OLD."runId" AND "status" = 'VALIDATED') THEN
    RAISE EXCEPTION 'Un bulletin de paie validé est figé : passer par un rappel le mois suivant';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Payslip_protected"
  BEFORE UPDATE OR DELETE ON "Payslip"
  FOR EACH ROW EXECUTE FUNCTION protect_validated_payslip();

-- Remboursements d'avances et barèmes datés : ajout seul.
CREATE OR REPLACE FUNCTION forbid_payroll_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Historique de paie en ajout seul : créer une nouvelle entrée';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdvanceRepayment_immutable"
  BEFORE UPDATE OR DELETE ON "AdvanceRepayment"
  FOR EACH ROW EXECUTE FUNCTION forbid_payroll_history_mutation();

CREATE TRIGGER "PayrollScale_immutable"
  BEFORE UPDATE OR DELETE ON "PayrollScale"
  FOR EACH ROW EXECUTE FUNCTION forbid_payroll_history_mutation();
