import { z } from 'zod';
import { PERMISSIONS, type Permission } from './permissions';

/** Domaine fonctionnel regroupant des permissions dans l'écran des rôles. */
export interface PermissionGroup {
  key: string;
  label: string;
  permissions: readonly Permission[];
}

/** Description en clair de chaque permission. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  'dashboard.read': 'Voir le tableau de bord',
  'audit.read': 'Consulter le journal d’audit',
  'settings.write': 'Modifier les réglages de l’établissement',
  'subscription.read': 'Voir l’abonnement de l’école',
  'staff.read': 'Voir la liste du personnel',
  'staff.write': 'Ajouter le personnel, attribuer les rôles, retirer un accès',
  'roles.manage': 'Adapter les rôles et leurs droits',
  'academic.read': 'Voir les classes, matières et emplois du temps',
  'academic.write': 'Modifier la structure académique et les emplois du temps',
  'students.read': 'Voir les fiches élèves',
  'students.write': 'Créer et modifier les fiches élèves',
  'enrollments.write': 'Inscrire et réinscrire les élèves',
  'students.documents': 'Consulter les pièces du dossier élève',
  'health.read': 'Consulter les informations médicales',
  'attendance.read': 'Voir les absences et retards',
  'attendance.write': 'Faire l’appel',
  'attendance.justify': 'Justifier les absences',
  'discipline.read': 'Voir les incidents de discipline',
  'discipline.write': 'Signaler et sanctionner les incidents',
  'discipline.manage': 'Corriger ou supprimer les incidents signalés par d’autres',
  'grades.read': 'Voir les notes',
  'grades.write': 'Saisir les notes',
  'grades.validate': 'Valider et verrouiller les notes',
  'reportcards.read': 'Voir les bulletins',
  'reportcards.generate': 'Préparer les bulletins',
  'reportcards.publish': 'Publier les bulletins aux familles',
  'lessons.read': 'Consulter le cahier de textes',
  'lessons.write': 'Remplir le cahier de textes et partager des supports',
  'exams.read': 'Voir les examens',
  'exams.manage': 'Organiser les examens (salles, surveillances, candidats)',
  'exams.grade': 'Saisir les notes d’examen',
  'exams.anonymity.reveal': 'Lever l’anonymat des copies',
  'finance.read': 'Voir les frais, factures et paiements',
  'finance.fees.write': 'Définir les frais de scolarité et les remises',
  'finance.payments.create': 'Encaisser des paiements',
  'finance.payments.reverse': 'Annuler un paiement par contre-passation',
  'finance.cash.close': 'Ouvrir et clôturer sa caisse',
  'finance.cash.approve': 'Valider les clôtures de caisse',
  'accounting.read': 'Consulter la comptabilité',
  'accounting.write': 'Saisir les écritures et les dépenses',
  'accounting.close': 'Clôturer un exercice comptable',
  'hr.read': 'Consulter les dossiers du personnel et la paie',
  'hr.write': 'Modifier les dossiers, contrats et avances du personnel',
  'hr.payroll.prepare': 'Préparer la paie',
  'hr.payroll.validate': 'Valider la paie',
  'hr.payroll.pay': 'Enregistrer le versement des salaires et des avances',
  'communication.write': 'Publier des annonces et envoyer des messages groupés',
  'messaging.use': 'Échanger avec les familles',
  'messaging.oversee': 'Superviser les échanges avec les familles',
  'documents.read': 'Voir les documents officiels délivrés',
  'documents.issue': 'Délivrer des documents officiels (certificats, attestations)',
  'documents.cancel': 'Annuler un document officiel',
  'documents.configure': 'Configurer les modèles de documents officiels',
  'transport.read': 'Voir le transport scolaire',
  'transport.manage': 'Gérer les lignes, véhicules et abonnements de transport',
  'transport.rollcall': 'Faire l’appel dans le bus',
  'library.read': 'Consulter le catalogue de la bibliothèque',
  'library.manage': 'Gérer le catalogue de la bibliothèque',
  'library.loans': 'Enregistrer les prêts et retours',
  'stock.read': 'Consulter le stock',
  'stock.write': 'Enregistrer les entrées et sorties de stock',
  'stock.inventory': 'Réaliser les inventaires de stock',
};

/** Permissions regroupées par domaine, dans l'ordre d'affichage. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    key: 'pilotage',
    label: 'Pilotage et réglages',
    permissions: ['dashboard.read', 'audit.read', 'settings.write', 'subscription.read'],
  },
  {
    key: 'personnel',
    label: 'Personnel et rôles',
    permissions: ['staff.read', 'staff.write', 'roles.manage'],
  },
  {
    key: 'scolarite',
    label: 'Élèves et structure',
    permissions: [
      'academic.read',
      'academic.write',
      'students.read',
      'students.write',
      'enrollments.write',
      'students.documents',
      'health.read',
    ],
  },
  {
    key: 'vie-scolaire',
    label: 'Vie scolaire',
    permissions: [
      'attendance.read',
      'attendance.write',
      'attendance.justify',
      'discipline.read',
      'discipline.write',
      'discipline.manage',
    ],
  },
  {
    key: 'notes',
    label: 'Notes, bulletins et cahier de textes',
    permissions: [
      'grades.read',
      'grades.write',
      'grades.validate',
      'reportcards.read',
      'reportcards.generate',
      'reportcards.publish',
      'lessons.read',
      'lessons.write',
    ],
  },
  {
    key: 'examens',
    label: 'Examens',
    permissions: ['exams.read', 'exams.manage', 'exams.grade', 'exams.anonymity.reveal'],
  },
  {
    key: 'finances',
    label: 'Scolarité et caisse',
    permissions: [
      'finance.read',
      'finance.fees.write',
      'finance.payments.create',
      'finance.payments.reverse',
      'finance.cash.close',
      'finance.cash.approve',
    ],
  },
  {
    key: 'comptabilite',
    label: 'Comptabilité',
    permissions: ['accounting.read', 'accounting.write', 'accounting.close'],
  },
  {
    key: 'rh',
    label: 'Ressources humaines et paie',
    permissions: [
      'hr.read',
      'hr.write',
      'hr.payroll.prepare',
      'hr.payroll.validate',
      'hr.payroll.pay',
    ],
  },
  {
    key: 'communication',
    label: 'Communication',
    permissions: ['communication.write', 'messaging.use', 'messaging.oversee'],
  },
  {
    key: 'documents',
    label: 'Documents officiels',
    permissions: ['documents.read', 'documents.issue', 'documents.cancel', 'documents.configure'],
  },
  {
    key: 'transport',
    label: 'Transport scolaire',
    permissions: ['transport.read', 'transport.manage', 'transport.rollcall'],
  },
  {
    key: 'bibliotheque',
    label: 'Bibliothèque et stock',
    permissions: [
      'library.read',
      'library.manage',
      'library.loans',
      'stock.read',
      'stock.write',
      'stock.inventory',
    ],
  },
];

const permissionList = z
  .array(z.enum(PERMISSIONS, { errorMap: () => ({ message: 'Permission inconnue' }) }))
  .max(PERMISSIONS.length);

/** Nouvelles permissions d'un rôle intégré pour l'école. */
export const builtinRoleUpdateSchema = z.object({ permissions: permissionList });

/** Rôle propre à l'école. */
export const customRoleSchema = z.object({
  name: z.string().trim().min(2, '2 caractères minimum').max(60, '60 caractères maximum'),
  description: z.string().trim().max(200, '200 caractères maximum').optional(),
  permissions: permissionList.min(1, 'Choisissez au moins une permission'),
  classScoped: z.boolean().default(false),
  lineScoped: z.boolean().default(false),
});
export type CustomRoleInput = z.infer<typeof customRoleSchema>;
