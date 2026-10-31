import { formatFcfa, formatGrade } from '@ecole/shared';

/** Accord au sexe de l'élève quand il est connu (« absente »), forme épicène sinon. */
export function agree(gender: 'F' | 'M' | null | undefined, word: string): string {
  return gender === 'F' ? `${word}e` : gender === 'M' ? word : `${word}(e)`;
}

/** Absences visées par un justificatif : « absence du 31/10/2026, 10:20–11:15 », « 2 absences du … ». */
function concerned(records: { date: string; slot: string; late: boolean }[]): string {
  const first = records[0];
  if (!first) return 'absence';
  if (records.length === 1)
    return `${first.late ? 'retard' : 'absence'} du ${first.date}, ${first.slot}`;
  const kind = records.every((r) => r.late)
    ? 'retards'
    : records.some((r) => r.late)
      ? 'absences et retards'
      : 'absences';
  const last = records.at(-1) ?? first;
  const span = first.date === last.date ? `du ${first.date}` : `du ${first.date} au ${last.date}`;
  return `${records.length} ${kind} ${span}`;
}

export const templates = {
  otp: (code: string) =>
    `Ecole : votre code de connexion est ${code}. Il expire dans 15 minutes. Ne le communiquez à personne.`,
  absence: (p: {
    student: string;
    gender?: 'F' | 'M' | null;
    date: string;
    slot: string;
    school: string;
  }) =>
    `${p.school} : ${p.student} était ${agree(p.gender, 'absent')} le ${p.date} (${p.slot}). Justifiez l'absence depuis l'application ou auprès de la vie scolaire.`,
  justificationRejected: (p: {
    school: string;
    student: string;
    records: { date: string; slot: string; late: boolean }[];
    note: string;
  }) =>
    `${p.school} : le justificatif envoyé pour ${p.student} (${concerned(p.records)}) n'a pas été accepté. Motif : ${p.note.replace(/[.\s]+$/, '')}. Vous pouvez en envoyer un autre depuis l'application ou auprès de la vie scolaire.`,
  absenceThreshold: (p: { student: string; count: number; days: number }) =>
    `Alerte assiduité : ${p.student} cumule ${p.count} absences non justifiées sur ${p.days} jours.`,
  paymentReceived: (p: {
    student: string;
    amount: number;
    receipt: string;
    balance: number;
    school: string;
  }) =>
    `${p.school} : paiement de ${formatFcfa(p.amount)} reçu pour ${p.student}. Reçu ${p.receipt}. Reste à payer : ${formatFcfa(p.balance)}.`,
  paymentFailed: (p: { student: string; amount: number }) =>
    `Le paiement de ${formatFcfa(p.amount)} pour ${p.student} n'a pas abouti. Aucun montant n'a été débité par l'école.`,
  feeReminder: (p: {
    student: string;
    label: string;
    amount: number;
    dueDate: string;
    school: string;
  }) =>
    `${p.school} : rappel, ${p.label} de ${p.student} (${formatFcfa(p.amount)}) était due le ${p.dueDate}. Payez par Mobile Money depuis l'application ou à la caisse.`,
  reportCardPublished: (p: { student: string; term: string; average: number | null }) =>
    `Le bulletin du ${p.term} de ${p.student} est disponible${p.average === null ? '' : ` (moyenne ${formatGrade(p.average)}/20)`}.`,
  annualReportCardPublished: (p: {
    student: string;
    average: number | null;
    decision: string | null;
  }) =>
    `Le bulletin de fin d'année de ${p.student} est disponible${p.average === null ? '' : ` (moyenne annuelle ${formatGrade(p.average)}/20)`}${p.decision ? `. Décision du conseil : ${p.decision}` : ''}.`,
  announcement: (p: { school: string; title: string }) =>
    `${p.school} : ${p.title}. Détails dans l'application.`,
  subscriptionReminder: (p: { school: string; number: string; due: number; dueDate: string }) =>
    `Ecole : la facture d'abonnement ${p.number} de ${p.school} présente un reste à payer de ${formatFcfa(p.due)} (échéance ${p.dueDate}). Détail dans Paramètres.`,
  announcementEmail: (p: { school: string; title: string; body: string }) =>
    `${p.title}\n\n${p.body}\n\n${p.school}`,
  temporaryExclusion: (p: {
    school: string;
    student: string;
    gender?: 'F' | 'M' | null;
    date: string;
    details: string | null;
  }) =>
    `${p.school} : ${p.student} est ${agree(p.gender, 'exclu')} temporairement de l'établissement à la suite de l'incident du ${p.date}${p.details ? ` (${p.details.replace(/[.\s]+$/, '')})` : ''}. Merci de prendre contact avec la vie scolaire. Détails dans l'application.`,
  messageNew: (p: { school: string; from: string; student: string }) =>
    `${p.school} : nouveau message de ${p.from} au sujet de ${p.student}. Lisez-le et répondez dans l'application.`,
  eventReminder: (p: { school: string; title: string; date: string; time?: string | null }) =>
    `${p.school} : rappel, ${p.title} demain ${p.date}${p.time ? ` à ${p.time}` : ''}. Détails dans l'application.`,
};

/** Objets des e-mails, par modèle. */
export const subjects = {
  temporaryExclusion: (p: { student: string }) => `Exclusion temporaire de ${p.student}`,
  announcement: (p: { school: string; title: string }) => `${p.school} : ${p.title}`,
  messageNew: (p: { student: string }) => `Nouveau message au sujet de ${p.student}`,
  eventReminder: (p: { title: string }) => `Rappel : ${p.title} demain`,
};
