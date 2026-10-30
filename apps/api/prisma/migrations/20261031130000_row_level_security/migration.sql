-- Row-Level Security : isolation des établissements par la base elle-même.
--
-- L'application pose deux réglages limités à la transaction (voir apps/api/src/common/prisma.ts) :
--   app.school_id : établissement du contexte (personnel, ou tâche système limitée à une école) ;
--   app.rls_mode  : 'system' pour runAsSystem sans établissement (plateforme, tâches de fond,
--                   portail parent avant vérification du lien, webhooks, vérification publique).
-- Sans réglage (requête SQL brute oubliée, connexion sans contexte), aucune ligne n'est visible.
-- FORCE ROW LEVEL SECURITY soumet aussi le propriétaire des tables à ces règles ; seuls les
-- superutilisateurs et les rôles BYPASSRLS y échappent. L'application se connecte donc avec le
-- rôle ecole_app (ni propriétaire, ni BYPASSRLS) ; les migrations gardent le rôle propriétaire.
--
-- Une migration de données future sur une table cloisonnée, jouée par un propriétaire qui n'est pas
-- superutilisateur, commence par : SELECT set_config('app.rls_mode', 'system', true);

CREATE OR REPLACE FUNCTION app_rls_school() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.school_id', true), '') $$;

CREATE OR REPLACE FUNCTION app_rls_system() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(current_setting('app.rls_mode', true), '') = 'system' $$;

-- Tables cloisonnées (TENANT_MODELS) : lecture et écriture limitées à l'établissement du contexte.

ALTER TABLE "AcademicYear" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AcademicYear" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AcademicYear"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Term" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Term" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Term"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Sequence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Sequence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Sequence"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Cycle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cycle" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Cycle"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Level" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Level" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Level"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Class" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Class" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Class"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Subject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subject" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Subject"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ClassSubject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassSubject" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ClassSubject"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Student" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Student" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Student"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Guardian" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Guardian" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Guardian"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StudentGuardian" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StudentGuardian" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StudentGuardian"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Enrollment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Enrollment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Enrollment"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StudentDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StudentDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StudentDocument"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "HealthRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "HealthRecord"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AttendanceSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AttendanceSession"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AttendanceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AttendanceRecord"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Justification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Justification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Justification"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Incident" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Incident" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Incident"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Evaluation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Evaluation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Evaluation"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Grade" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Grade" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Grade"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ReportCard" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReportCard" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ReportCard"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "CouncilDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CouncilDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "CouncilDecision"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "FeeItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeeItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "FeeItem"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Invoice"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "InvoiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InvoiceLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "InvoiceLine"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Payment"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "PaymentAllocation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "PaymentAllocation"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Receipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Receipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Receipt"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "LedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "LedgerEntry"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "CashSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CashSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "CashSession"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Reminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Reminder" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Reminder"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Announcement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Announcement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Announcement"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "MessageThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MessageThread" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "MessageThread"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Message"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SchoolEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchoolEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SchoolEvent"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Counter"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Room" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Room" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Room"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TimetableEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TimetableEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TimetableEntry"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SchoolSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SchoolSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SchoolSubscription"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SubscriptionInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubscriptionInvoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SubscriptionInvoice"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SubscriptionPayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubscriptionPayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SubscriptionPayment"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SubscriptionReminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SubscriptionReminder" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SubscriptionReminder"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "DocumentTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "DocumentTemplate"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AdminDocument" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdminDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AdminDocument"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StoredFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StoredFile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StoredFile"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "LessonLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LessonLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "LessonLog"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "CourseMaterial" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CourseMaterial" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "CourseMaterial"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamSession"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamPaper" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamPaper" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamPaper"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamRoom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamRoom" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamRoom"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamCandidate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamCandidate"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamSupervision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamSupervision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamSupervision"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamScore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamScore" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamScore"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "ExamTransfer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExamTransfer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "ExamTransfer"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AccountingAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountingAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AccountingAccount"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AccountingJournal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountingJournal" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AccountingJournal"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "FiscalYear" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FiscalYear" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "FiscalYear"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AccountingEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountingEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AccountingEntry"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AccountingLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountingLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AccountingLine"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Supplier"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Expense" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Expense" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Expense"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AccountingSettings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountingSettings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AccountingSettings"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "EmployeeFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmployeeFile" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "EmployeeFile"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "EmploymentContract" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmploymentContract" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "EmploymentContract"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TeachingSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeachingSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TeachingSession"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "SalaryAdvance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalaryAdvance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "SalaryAdvance"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "AdvanceRepayment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AdvanceRepayment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "AdvanceRepayment"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "PayrollScale" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollScale" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "PayrollScale"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "PayrollRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayrollRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "PayrollRun"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "Payslip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payslip" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "Payslip"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportVehicle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportVehicle" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportVehicle"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportLine"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportStop" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportStop"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportSubscription"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportTrip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportTrip" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportTrip"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "TransportTripRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TransportTripRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "TransportTripRecord"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "LibraryBook" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryBook" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "LibraryBook"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "LibraryCopy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryCopy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "LibraryCopy"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "LibraryLoan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LibraryLoan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "LibraryLoan"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StockItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StockItem"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StockMovement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockMovement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StockMovement"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

ALTER TABLE "StockInventory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockInventory" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "StockInventory"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

-- File des notifications : schoolId nul pour les codes de connexion et les alertes techniques,
-- lignes visibles du seul mode système (le worker).
ALTER TABLE "NotificationOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationOutbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_isolation" ON "NotificationOutbox"
  USING (app_rls_system() OR "schoolId" = app_rls_school())
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

-- Journal d'audit : lecture et ajout seulement. Aucune politique de modification ni de suppression :
-- le journal est en ajout seul, y compris en mode système.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ecole_lecture" ON "AuditLog" FOR SELECT
  USING (app_rls_system() OR "schoolId" = app_rls_school());
CREATE POLICY "ecole_ajout" ON "AuditLog" FOR INSERT
  WITH CHECK (app_rls_system() OR "schoolId" = app_rls_school());

-- Droits du rôle applicatif, s'il existe déjà (création : deploy/postgres/app-role.sh).
-- Les tables créées ensuite par le propriétaire lui sont ouvertes par les privilèges par défaut.
-- Rejouable à tout moment : prisma/app-role-grants.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ecole_app') THEN
    GRANT USAGE ON SCHEMA public TO ecole_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ecole_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ecole_app;
    -- Absente de la base fantôme de « prisma migrate dev ».
    IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
      REVOKE ALL ON "_prisma_migrations" FROM ecole_app;
    END IF;
    REVOKE UPDATE, DELETE ON "AuditLog" FROM ecole_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ecole_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ecole_app;
  END IF;
END $$;
