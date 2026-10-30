import { formatFcfa, formatGrade } from '@ecole/shared';

export const templates = {
  otp: (code: string) =>
    `Ecole : votre code de connexion est ${code}. Il expire dans 15 minutes. Ne le communiquez à personne.`,
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
  subscriptionReminder: (p: { school: string; number: string; due: number; dueDate: string }) =>
    `Ecole : la facture d'abonnement ${p.number} de ${p.school} présente un reste à payer de ${formatFcfa(p.due)} (échéance ${p.dueDate}). Détail dans Paramètres.`,
};
