-- CreateIndex
CREATE INDEX "Enrollment_schoolId_academicYearId_idx" ON "Enrollment"("schoolId", "academicYearId");

-- CreateIndex
CREATE INDEX "Guardian_userId_idx" ON "Guardian"("userId");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_invoiceLineId_idx" ON "PaymentAllocation"("invoiceLineId");

-- CreateIndex
CREATE INDEX "PaymentAllocation_paymentId_idx" ON "PaymentAllocation"("paymentId");
