-- Mode système par rôle plutôt que par réglage de session.
--
-- La première version (20261031130000) ouvrait toutes les lignes avec
-- « app_rls_system() OR "schoolId" = app_rls_school() ». Sous charge, l'optimiseur estime ce OU
-- à une fraction des lignes de chaque table, même en mode système où tout est visible : les
-- jointures du portail parent partaient alors de tous les élèves (35 à 47 ms au lieu de 1 ms).
--
-- Désormais :
--   - mode établissement : politique simple, "schoolId" = app_rls_school() ;
--   - mode système (runAsSystem sans établissement) : l'application passe, dans la transaction,
--     sur le rôle ecole_system (SET LOCAL ROLE), qui n'a pas de connexion propre et porte
--     BYPASSRLS. Les plans sont alors ceux d'une base sans RLS.
-- ecole_app se connecte toujours sans BYPASSRLS ; le rôle ecole_system lui est accordé
-- (création : deploy/postgres/app-role.sh). Le journal d'audit reste en ajout seul pour les deux
-- rôles par les droits (aucun UPDATE ni DELETE).

DROP POLICY "ecole_isolation" ON "AcademicYear";
CREATE POLICY "ecole_isolation" ON "AcademicYear"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Term";
CREATE POLICY "ecole_isolation" ON "Term"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Sequence";
CREATE POLICY "ecole_isolation" ON "Sequence"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Cycle";
CREATE POLICY "ecole_isolation" ON "Cycle"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Level";
CREATE POLICY "ecole_isolation" ON "Level"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Class";
CREATE POLICY "ecole_isolation" ON "Class"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Subject";
CREATE POLICY "ecole_isolation" ON "Subject"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ClassSubject";
CREATE POLICY "ecole_isolation" ON "ClassSubject"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Student";
CREATE POLICY "ecole_isolation" ON "Student"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Guardian";
CREATE POLICY "ecole_isolation" ON "Guardian"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StudentGuardian";
CREATE POLICY "ecole_isolation" ON "StudentGuardian"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Enrollment";
CREATE POLICY "ecole_isolation" ON "Enrollment"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StudentDocument";
CREATE POLICY "ecole_isolation" ON "StudentDocument"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "HealthRecord";
CREATE POLICY "ecole_isolation" ON "HealthRecord"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AttendanceSession";
CREATE POLICY "ecole_isolation" ON "AttendanceSession"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AttendanceRecord";
CREATE POLICY "ecole_isolation" ON "AttendanceRecord"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Justification";
CREATE POLICY "ecole_isolation" ON "Justification"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Incident";
CREATE POLICY "ecole_isolation" ON "Incident"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Evaluation";
CREATE POLICY "ecole_isolation" ON "Evaluation"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Grade";
CREATE POLICY "ecole_isolation" ON "Grade"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ReportCard";
CREATE POLICY "ecole_isolation" ON "ReportCard"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "CouncilDecision";
CREATE POLICY "ecole_isolation" ON "CouncilDecision"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "FeeItem";
CREATE POLICY "ecole_isolation" ON "FeeItem"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Invoice";
CREATE POLICY "ecole_isolation" ON "Invoice"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "InvoiceLine";
CREATE POLICY "ecole_isolation" ON "InvoiceLine"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Payment";
CREATE POLICY "ecole_isolation" ON "Payment"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "PaymentAllocation";
CREATE POLICY "ecole_isolation" ON "PaymentAllocation"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Receipt";
CREATE POLICY "ecole_isolation" ON "Receipt"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "LedgerEntry";
CREATE POLICY "ecole_isolation" ON "LedgerEntry"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "CashSession";
CREATE POLICY "ecole_isolation" ON "CashSession"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Reminder";
CREATE POLICY "ecole_isolation" ON "Reminder"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Announcement";
CREATE POLICY "ecole_isolation" ON "Announcement"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "MessageThread";
CREATE POLICY "ecole_isolation" ON "MessageThread"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Message";
CREATE POLICY "ecole_isolation" ON "Message"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SchoolEvent";
CREATE POLICY "ecole_isolation" ON "SchoolEvent"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Counter";
CREATE POLICY "ecole_isolation" ON "Counter"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Room";
CREATE POLICY "ecole_isolation" ON "Room"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TimetableEntry";
CREATE POLICY "ecole_isolation" ON "TimetableEntry"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SchoolSubscription";
CREATE POLICY "ecole_isolation" ON "SchoolSubscription"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SubscriptionInvoice";
CREATE POLICY "ecole_isolation" ON "SubscriptionInvoice"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SubscriptionPayment";
CREATE POLICY "ecole_isolation" ON "SubscriptionPayment"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SubscriptionReminder";
CREATE POLICY "ecole_isolation" ON "SubscriptionReminder"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "DocumentTemplate";
CREATE POLICY "ecole_isolation" ON "DocumentTemplate"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AdminDocument";
CREATE POLICY "ecole_isolation" ON "AdminDocument"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StoredFile";
CREATE POLICY "ecole_isolation" ON "StoredFile"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "LessonLog";
CREATE POLICY "ecole_isolation" ON "LessonLog"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "CourseMaterial";
CREATE POLICY "ecole_isolation" ON "CourseMaterial"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamSession";
CREATE POLICY "ecole_isolation" ON "ExamSession"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamPaper";
CREATE POLICY "ecole_isolation" ON "ExamPaper"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamRoom";
CREATE POLICY "ecole_isolation" ON "ExamRoom"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamCandidate";
CREATE POLICY "ecole_isolation" ON "ExamCandidate"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamSupervision";
CREATE POLICY "ecole_isolation" ON "ExamSupervision"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamScore";
CREATE POLICY "ecole_isolation" ON "ExamScore"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "ExamTransfer";
CREATE POLICY "ecole_isolation" ON "ExamTransfer"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AccountingAccount";
CREATE POLICY "ecole_isolation" ON "AccountingAccount"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AccountingJournal";
CREATE POLICY "ecole_isolation" ON "AccountingJournal"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "FiscalYear";
CREATE POLICY "ecole_isolation" ON "FiscalYear"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AccountingEntry";
CREATE POLICY "ecole_isolation" ON "AccountingEntry"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AccountingLine";
CREATE POLICY "ecole_isolation" ON "AccountingLine"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Supplier";
CREATE POLICY "ecole_isolation" ON "Supplier"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Expense";
CREATE POLICY "ecole_isolation" ON "Expense"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AccountingSettings";
CREATE POLICY "ecole_isolation" ON "AccountingSettings"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "EmployeeFile";
CREATE POLICY "ecole_isolation" ON "EmployeeFile"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "EmploymentContract";
CREATE POLICY "ecole_isolation" ON "EmploymentContract"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TeachingSession";
CREATE POLICY "ecole_isolation" ON "TeachingSession"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "SalaryAdvance";
CREATE POLICY "ecole_isolation" ON "SalaryAdvance"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "AdvanceRepayment";
CREATE POLICY "ecole_isolation" ON "AdvanceRepayment"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "PayrollScale";
CREATE POLICY "ecole_isolation" ON "PayrollScale"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "PayrollRun";
CREATE POLICY "ecole_isolation" ON "PayrollRun"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "Payslip";
CREATE POLICY "ecole_isolation" ON "Payslip"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportVehicle";
CREATE POLICY "ecole_isolation" ON "TransportVehicle"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportLine";
CREATE POLICY "ecole_isolation" ON "TransportLine"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportStop";
CREATE POLICY "ecole_isolation" ON "TransportStop"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportSubscription";
CREATE POLICY "ecole_isolation" ON "TransportSubscription"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportTrip";
CREATE POLICY "ecole_isolation" ON "TransportTrip"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "TransportTripRecord";
CREATE POLICY "ecole_isolation" ON "TransportTripRecord"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "LibraryBook";
CREATE POLICY "ecole_isolation" ON "LibraryBook"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "LibraryCopy";
CREATE POLICY "ecole_isolation" ON "LibraryCopy"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "LibraryLoan";
CREATE POLICY "ecole_isolation" ON "LibraryLoan"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StockItem";
CREATE POLICY "ecole_isolation" ON "StockItem"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StockMovement";
CREATE POLICY "ecole_isolation" ON "StockMovement"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "StockInventory";
CREATE POLICY "ecole_isolation" ON "StockInventory"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_isolation" ON "NotificationOutbox";
CREATE POLICY "ecole_isolation" ON "NotificationOutbox"
  USING ("schoolId" = app_rls_school())
  WITH CHECK ("schoolId" = app_rls_school());

DROP POLICY "ecole_lecture" ON "AuditLog";
DROP POLICY "ecole_ajout" ON "AuditLog";
CREATE POLICY "ecole_lecture" ON "AuditLog" FOR SELECT USING ("schoolId" = app_rls_school());
CREATE POLICY "ecole_ajout" ON "AuditLog" FOR INSERT WITH CHECK ("schoolId" = app_rls_school());

DROP FUNCTION app_rls_system();

-- Droits du rôle système, s'il existe déjà. Rejouable : prisma/app-role-grants.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_system') THEN
    GRANT USAGE ON SCHEMA public TO ecole_system;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ecole_system;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ecole_system;
    -- Absente de la base fantôme de « prisma migrate dev ».
    IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
      REVOKE ALL ON "_prisma_migrations" FROM ecole_system;
    END IF;
    REVOKE UPDATE, DELETE ON "AuditLog" FROM ecole_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecole_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ecole_system;
  END IF;
END $$;
