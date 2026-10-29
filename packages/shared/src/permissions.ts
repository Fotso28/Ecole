/** Rôles du personnel et permissions associées. */

export const STAFF_ROLES = [
  'DIRECTOR',
  'CENSOR',
  'SUPERVISOR',
  'SECRETARY',
  'ACCOUNTANT',
  'TEACHER',
  'NURSE',
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
};

export const PERMISSIONS = [
  'dashboard.read',
  'academic.read',
  'academic.write',
  'staff.read',
  'staff.write',
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
  'health.read',
  'audit.read',
  'settings.write',
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
  ],
  TEACHER: [
    'academic.read',
    'students.read',
    'attendance.read',
    'attendance.write',
    'grades.read',
    'grades.write',
  ],
  NURSE: ['students.read', 'health.read'],
};

/** Union des permissions des rôles cumulés. */
export function permissionsForRoles(roles: readonly StaffRole[]): Set<Permission> {
  const set = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
  }
  return set;
}

export function hasPermission(roles: readonly StaffRole[], permission: Permission): boolean {
  return permissionsForRoles(roles).has(permission);
}

/** Un enseignant pur n'accède qu'à ses classes et matières. */
export function isTeacherOnly(roles: readonly StaffRole[]): boolean {
  const scoped: readonly StaffRole[] = ['TEACHER'];
  return roles.length > 0 && roles.every((r) => scoped.includes(r));
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
] as const;
export type Module = (typeof MODULES)[number];
