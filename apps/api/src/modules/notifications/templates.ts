import { formatFcfa, formatGrade } from '@ecole/shared';

export const templates = {
  otp: (code: string) =>
    `Ecole : votre code de connexion est ${code}. Il expire dans 5 minutes. Ne le communiquez à personne.`,
  absence: (p: { student: string; date: string; slot: string; school: string }) =>
    `${p.school} : ${p.student} était absent(e) le ${p.date} (${p.slot}). Justifiez l'absence depuis l'application ou auprès de la vie scolaire.`,
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
  announcement: (p: { school: string; title: string }) =>
    `${p.school} : ${p.title}. Détails dans l'application.`,
  announcementEmail: (p: { school: string; title: string; body: string }) =>
    `${p.title}\n\n${p.body}\n\n${p.school}`,
  messageNew: (p: { school: string; from: string; student: string }) =>
    `${p.school} : nouveau message de ${p.from} au sujet de ${p.student}. Lisez-le et répondez dans l'application.`,
  eventReminder: (p: { school: string; title: string; date: string; time?: string | null }) =>
    `${p.school} : rappel, ${p.title} demain ${p.date}${p.time ? ` à ${p.time}` : ''}. Détails dans l'application.`,
};

/** Objets des e-mails, par modèle. */
export const subjects = {
  announcement: (p: { school: string; title: string }) => `${p.school} : ${p.title}`,
  messageNew: (p: { student: string }) => `Nouveau message au sujet de ${p.student}`,
  eventReminder: (p: { title: string }) => `Rappel : ${p.title} demain`,
};
