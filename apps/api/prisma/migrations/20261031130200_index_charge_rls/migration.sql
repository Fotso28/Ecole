-- DropIndex
DROP INDEX "OtpCode_sent_createdAt_idx";

-- CreateIndex
CREATE INDEX "NotificationOutbox_template_recipient_createdAt_idx" ON "NotificationOutbox"("template", "recipient", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationOutbox_schoolId_template_status_idx" ON "NotificationOutbox"("schoolId", "template", "status");

-- CreateIndex
CREATE INDEX "OtpCode_sent_trusted_createdAt_idx" ON "OtpCode"("sent", "trusted", "createdAt");

-- CreateIndex
CREATE INDEX "StudentGuardian_guardianId_idx" ON "StudentGuardian"("guardianId");
