/** Rôles du personnel et permissions associées. */

export const STAFF_ROLES = [
  'DIRECTOR',
  'CENSOR',
  'SUPERVISOR',
  'SECRETARY',
  'ACCOUNTANT',
  'TEACHER',
  'NURSE',
  'TRANSPORT',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  DIRECTOR: 'Direction',
  CENSOR: 'Censeur',
  SUPERVISOR: 'Surveillant général',
  SECRETARY: 'Secrétariat',
  ACCOUNTANT: 'Comptabilité',
  TEACHER: 'Enseignant',
  NURSE: 'Infirmerie',
  TRANSPORT: 'Chauffeur ou accompagnateur',
};

export const PERMISSIONS = [
  'dashboard.read',
  'academic.read',
  'academic.write',
  'staff.read',
  'staff.write',
  'roles.manage',
  'students.read',
  'students.write',
  'enrollments.write',
  'attendance.read',
  'attendance.write',
  'attendance.justify',
  'discipline.write',
  'grades.read',
  'grades.write',
  'grades.validate',
  'reportcards.read',
  'reportcards.generate',
  'reportcards.publish',
  'finance.read',
  'finance.fees.write',
  'finance.payments.create',
  'finance.payments.reverse',
  'finance.cash.close',
  'finance.cash.approve',
  'communication.write',
  'messaging.use',
  'messaging.oversee',
  'health.read',
  'audit.read',
  'settings.write',
  'subscription.read',
  'discipline.read',
  'documents.read',
  'documents.issue',
  'documents.cancel',
  'documents.configure',
  'students.documents',
  'lessons.read',
  'lessons.write',
  'exams.read',
  'exams.manage',
  'exams.grade',
  'exams.anonymity.reveal',
  'accounting.read',
  'accounting.write',
  'accounting.close',
  'hr.read',
  'hr.write',
  'hr.payroll.prepare',
  'hr.payroll.validate',
  'transport.read',
  'transport.manage',
  'transport.rollcall',
  'library.read',
  'library.manage',
  'library.loans',
  'stock.read',
  'stock.write',
  'stock.inventory',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS.filter((p) => p !== 'health.read');

export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  DIRECTOR: ALL,
  CENSOR: [
    'dashboard.read',
    'academic.read',
    'academic.write',
    'staff.read',
    'students.read',
    'attendance.read',
    'grades.read',
    'grades.write',
    'grades.validate',
    'reportcards.read',
    'reportcards.generate',
    'communication.write',
    'lessons.read',
    'messaging.use',
    'exams.read',
    'exams.manage',
    'exams.grade',
    'exams.anonymity.reveal',
    'library.read',
  ],
  SUPERVISOR: [
    'dashboard.read',
    'academic.read',
    'students.read',
    'attendance.read',
    'attendance.write',
    'attendance.justify',
    'discipline.write',
    'communication.write',
    'discipline.read',
    'messaging.use',
    'exams.read',
    'transport.read',
    'transport.rollcall',
  ],
  SECRETARY: [
    'dashboard.read',
    'academic.read',
    'students.read',
    'students.write',
    'enrollments.write',
    'attendance.read',
    'reportcards.read',
    'finance.read',
    'communication.write',
    'documents.read',
    'documents.issue',
    'students.documents',
    'exams.read',
    'transport.read',
    'transport.manage',
    'library.read',
    'library.manage',
    'library.loans',
    'stock.read',
    'stock.write',
  ],
  ACCOUNTANT: [
    'dashboard.read',
    'academic.read',
    'students.read',
    'finance.read',
    'finance.fees.write',
    'finance.payments.create',
    'finance.payments.reverse',
    'finance.cash.close',
    'communication.write',
    'accounting.read',
    'accounting.write',
    'accounting.close',
    'hr.read',
    'hr.write',
    'hr.payroll.prepare',
    'transport.read',
    'stock.read',
    'stock.write',
    'stock.inventory',
  ],
  TEACHER: [
    'academic.read',
    'students.read',
    'attendance.read',
    'attendance.write',
    'grades.read',
    'grades.write',
    'lessons.read',
    'lessons.write',
    'messaging.use',
    'exams.read',
    'exams.grade',
  ],
  NURSE: ['students.read', 'health.read'],
  TRANSPORT: ['transport.rollcall'],
};

/**
 * Droits que la direction garde toujours, quelles que soient les adaptations de l'école :
 * gérer le personnel, les rôles et les réglages. Sans eux, l'école pourrait s'enfermer dehors.
 */
export const LOCKED_DIRECTOR_PERMISSIONS: readonly Permission[] = [
  'staff.read',
  'staff.write',
  'roles.manage',
  'settings.write',
];

/** Rôles intégrés qui exigent la double authentification lorsque l'école l'impose. */
export const ADMIN_ROLES: readonly StaffRole[] = ['DIRECTOR', 'CENSOR', 'SECRETARY', 'ACCOUNTANT'];

/**
 * Droits administratifs (argent, personnel, réglages) : tout rôle qui en accorde un exige la
 * double authentification lorsque l'école l'impose, comme les rôles administratifs intégrés.
 */
export const ADMIN_PERMISSIONS: readonly Permission[] = [
  'finance.fees.write',
  'finance.payments.create',
  'finance.payments.reverse',
  'finance.cash.close',
  'finance.cash.approve',
  'accounting.write',
  'accounting.close',
  'hr.read',
  'hr.write',
  'hr.payroll.prepare',
  'hr.payroll.validate',
  'staff.write',
  'roles.manage',
  'settings.write',
];

/** Adaptation d'un rôle intégré par une école : permissions ajoutées et retirées. */
export interface RoleOverride {
  added: readonly string[];
  removed: readonly string[];
}

/** Ensemble de droits apporté par un rôle (intégré ou propre à l'école) et ses limites. */
export interface RoleGrant {
  permissions: readonly Permission[];
  /** Limité aux classes et matières de la personne (comme un enseignant). */
  classScoped: boolean;
  /** Appel du transport limité aux lignes de la personne (comme un chauffeur). */
  lineScoped: boolean;
  /** Rôle intégré d'origine, le cas échéant. */
  builtin?: StaffRole;
}

/** Droits effectifs d'une personne. */
export interface ResolvedAccess {
  permissions: Set<Permission>;
  /** Permissions limitées aux classes de la personne. */
  classScoped: Set<Permission>;
  /** Appel du transport limité aux lignes de la personne. */
  lineScoped: boolean;
  /** Double authentification exigible (droits administratifs). */
  requiresMfa: boolean;
}

const KNOWN: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return KNOWN.has(value);
}

/** Ne garde que des permissions connues, sans doublon, dans l'ordre du catalogue. */
export function normalizePermissions(values: Iterable<string>): Permission[] {
  const set = new Set(values);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Permissions d'un rôle intégré pour une école : valeurs du code, ajouts, retraits, verrous. */
export function builtinPermissions(role: StaffRole, override?: RoleOverride | null): Permission[] {
  const set = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
  for (const p of override?.added ?? []) set.add(p);
  for (const p of override?.removed ?? []) set.delete(p);
  if (role === 'DIRECTOR') for (const p of LOCKED_DIRECTOR_PERMISSIONS) set.add(p);
  return normalizePermissions(set);
}

/** Écart d'une liste de permissions par rapport aux valeurs par défaut d'un rôle intégré. */
export function overrideFor(
  role: StaffRole,
  permissions: Iterable<string>,
): { added: Permission[]; removed: Permission[] } {
  const wanted = new Set(normalizePermissions(permissions));
  const defaults = new Set<string>(ROLE_PERMISSIONS[role] ?? []);
  return {
    added: [...wanted].filter((p) => !defaults.has(p)),
    removed: PERMISSIONS.filter((p) => defaults.has(p) && !wanted.has(p)),
  };
}

/** Droits d'un rôle intégré : un enseignant est limité à ses classes, un chauffeur à ses lignes. */
export function builtinGrant(role: StaffRole, override?: RoleOverride | null): RoleGrant {
  return {
    permissions: builtinPermissions(role, override),
    classScoped: role === 'TEACHER',
    lineScoped: role === 'TRANSPORT',
    builtin: role,
  };
}

/**
 * Combine les droits des rôles cumulés. Une limite de périmètre (classes, lignes) ne se lève que
 * si un rôle sans aucune limite accorde lui-même la permission : un rôle limité n'élargit jamais
 * le périmètre d'un autre. Par prudence, dès qu'un rôle est limité aux classes, toute permission
 * qu'aucun rôle sans limite n'accorde est traitée comme limitée.
 */
export function resolveAccess(grants: readonly RoleGrant[]): ResolvedAccess {
  const permissions = new Set<Permission>();
  for (const g of grants) for (const p of g.permissions) if (isPermission(p)) permissions.add(p);
  const free = new Set<Permission>();
  for (const g of grants) {
    if (g.classScoped || g.lineScoped) continue;
    for (const p of g.permissions) free.add(p);
  }
  const classScoped = new Set<Permission>(
    grants.some((g) => g.classScoped) ? PERMISSIONS.filter((p) => !free.has(p)) : [],
  );
  const lineScoped = grants.some((g) => g.lineScoped) && !free.has('transport.rollcall');
  const requiresMfa =
    grants.some((g) => g.builtin !== undefined && ADMIN_ROLES.includes(g.builtin)) ||
    ADMIN_PERMISSIONS.some((p) => permissions.has(p));
  return { permissions, classScoped, lineScoped, requiresMfa };
}

/** Vrai si ces droits permettent de gérer le personnel, les rôles et les réglages. */
export function hasLockedRights(permissions: ReadonlySet<Permission>): boolean {
  return LOCKED_DIRECTOR_PERMISSIONS.every((p) => permissions.has(p));
}

/** Droits effectifs des rôles intégrés avec leurs valeurs par défaut. */
export function accessForRoles(roles: readonly StaffRole[]): ResolvedAccess {
  return resolveAccess(roles.map((r) => builtinGrant(r)));
}

/** Union des permissions des rôles cumulés (valeurs par défaut). */
export function permissionsForRoles(roles: readonly StaffRole[]): Set<Permission> {
  return accessForRoles(roles).permissions;
}

export function hasPermission(roles: readonly StaffRole[], permission: Permission): boolean {
  return permissionsForRoles(roles).has(permission);
}

/**
 * Vrai si la permission ne vient que du rôle enseignant : elle est alors limitée aux classes et
 * matières de l'enseignant. Un rôle cumulé ne lève la limite que s'il accorde lui-même la permission
 * (un enseignant également surveillant ne peut pas noter les classes de ses collègues).
 */
export function isClassScoped(roles: readonly StaffRole[], permission: Permission): boolean {
  return accessForRoles(roles).classScoped.has(permission);
}

/**
 * Vrai si l'appel du transport ne vient que du rôle chauffeur ou accompagnateur : il est alors
 * limité aux lignes auxquelles la personne est affectée.
 */
export function isLineScoped(roles: readonly StaffRole[]): boolean {
  return accessForRoles(roles).lineScoped;
}

/** Modules activables par abonnement. */
export const MODULES = [
  'students',
  'attendance',
  'grades',
  'finance',
  'communication',
  'portal',
  'timetable',
  'exams',
  'documents',
  'accounting',
  'hr',
  'transport',
  'library',
] as const;
export type Module = (typeof MODULES)[number];
