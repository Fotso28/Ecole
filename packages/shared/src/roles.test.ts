import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  builtinGrant,
  builtinPermissions,
  hasLockedRights,
  isClassScoped,
  isLineScoped,
  LOCKED_DIRECTOR_PERMISSIONS,
  overrideFor,
  PERMISSIONS,
  resolveAccess,
  ROLE_PERMISSIONS,
  STAFF_ROLES,
  type Permission,
  type RoleGrant,
} from './permissions';
import { customRoleSchema, PERMISSION_GROUPS, PERMISSION_LABELS } from './roles';
import { staffCreateSchema } from './schemas';

const custom = (
  permissions: Permission[],
  scope: { classScoped?: boolean; lineScoped?: boolean } = {},
): RoleGrant => ({
  permissions,
  classScoped: !!scope.classScoped,
  lineScoped: !!scope.lineScoped,
});

describe('catalogue des permissions', () => {
  it('décrit et range chaque permission dans exactement un domaine', () => {
    const grouped = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect([...grouped].sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const p of PERMISSIONS) {
      expect(PERMISSION_LABELS[p]).toBeTruthy();
      expect(PERMISSION_LABELS[p]).not.toContain(p);
    }
    expect(PERMISSION_LABELS['finance.payments.create']).toBe('Encaisser des paiements');
  });

  it('la direction dispose par défaut de la gestion des rôles', () => {
    expect(ROLE_PERMISSIONS.DIRECTOR).toContain('roles.manage');
    expect(ROLE_PERMISSIONS.CENSOR).not.toContain('roles.manage');
  });
});

describe('rôles intégrés ajustés par une école', () => {
  it('sans adaptation, garde les valeurs du code', () => {
    for (const role of STAFF_ROLES) {
      expect(builtinPermissions(role)).toEqual(
        PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].includes(p)),
      );
    }
  });

  it('applique les ajouts et les retraits, en ignorant les permissions inconnues', () => {
    const perms = builtinPermissions('SECRETARY', {
      added: ['finance.payments.create', 'inconnue.permission'],
      removed: ['library.loans'],
    });
    expect(perms).toContain('finance.payments.create');
    expect(perms).not.toContain('library.loans');
    expect(perms).not.toContain('inconnue.permission' as Permission);
  });

  it('la direction garde toujours la gestion du personnel, des rôles et des réglages', () => {
    const perms = builtinPermissions('DIRECTOR', {
      added: [],
      removed: [...LOCKED_DIRECTOR_PERMISSIONS, 'finance.payments.create'],
    });
    for (const p of LOCKED_DIRECTOR_PERMISSIONS) expect(perms).toContain(p);
    expect(perms).not.toContain('finance.payments.create');
    expect(
      hasLockedRights(
        resolveAccess([
          builtinGrant('DIRECTOR', { added: [], removed: [...LOCKED_DIRECTOR_PERMISSIONS] }),
        ]).permissions,
      ),
    ).toBe(true);
  });

  it('calcule l’écart avec les valeurs par défaut', () => {
    const o = overrideFor('TEACHER', [
      ...ROLE_PERMISSIONS.TEACHER.filter((p) => p !== 'exams.grade'),
      'discipline.write',
      'discipline.write',
    ]);
    expect(o).toEqual({ added: ['discipline.write'], removed: ['exams.grade'] });
    expect(overrideFor('NURSE', ROLE_PERMISSIONS.NURSE)).toEqual({ added: [], removed: [] });
  });
});

describe('résolution des permissions effectives', () => {
  it('cumule les rôles intégrés et propres à l’école', () => {
    const access = resolveAccess([builtinGrant('NURSE'), custom(['library.loans', 'stock.read'])]);
    expect([...access.permissions].sort()).toEqual(
      ['health.read', 'library.loans', 'stock.read', 'students.read'].sort(),
    );
    expect(access.classScoped.size).toBe(0);
    expect(access.lineScoped).toBe(false);
  });

  it('un rôle propre « limité à ses classes » reste limité, même en cumul avec un enseignant', () => {
    const tutor = custom(['students.read', 'grades.read', 'discipline.write'], {
      classScoped: true,
    });
    const alone = resolveAccess([tutor]);
    expect(alone.classScoped.has('grades.read')).toBe(true);
    expect(alone.classScoped.has('discipline.write')).toBe(true);
    // Par prudence, une permission non accordée est aussi traitée comme limitée.
    expect(alone.classScoped.has('exams.read')).toBe(true);
    const withTeacher = resolveAccess([builtinGrant('TEACHER'), tutor]);
    expect(withTeacher.classScoped.has('grades.write')).toBe(true);
    expect(withTeacher.classScoped.has('discipline.write')).toBe(true);
  });

  it('seul un rôle sans limite lève la limite de classe, permission par permission', () => {
    const access = resolveAccess([builtinGrant('TEACHER'), custom(['attendance.write'])]);
    expect(access.classScoped.has('attendance.write')).toBe(false);
    expect(access.classScoped.has('grades.write')).toBe(true);
    // Un rôle limité aux lignes n'élargit pas le périmètre d'un enseignant.
    const lined = resolveAccess([
      builtinGrant('TEACHER'),
      custom(['grades.write'], { lineScoped: true }),
    ]);
    expect(lined.classScoped.has('grades.write')).toBe(true);
  });

  it('les règles des enseignants restent garanties même si l’école enrichit le rôle', () => {
    const teacher = builtinGrant('TEACHER', { added: ['discipline.write'], removed: [] });
    const access = resolveAccess([teacher, builtinGrant('SUPERVISOR')]);
    // Le surveillant accorde discipline.write sans limite : la limite est levée pour celle-ci.
    expect(access.classScoped.has('discipline.write')).toBe(false);
    expect(access.classScoped.has('grades.write')).toBe(true);
    expect(resolveAccess([teacher]).classScoped.has('discipline.write')).toBe(true);
  });

  it('un rôle propre « limité à ses lignes » limite l’appel du transport', () => {
    const driver = custom(['transport.rollcall', 'students.read'], { lineScoped: true });
    expect(resolveAccess([driver]).lineScoped).toBe(true);
    expect(resolveAccess([driver, builtinGrant('TEACHER')]).lineScoped).toBe(true);
    expect(resolveAccess([driver, builtinGrant('SUPERVISOR')]).lineScoped).toBe(false);
    // Un enseignant à qui l'école ajoute l'appel du bus ne lève pas la limite d'un chauffeur.
    const teacher = builtinGrant('TEACHER', { added: ['transport.rollcall'], removed: [] });
    expect(resolveAccess([builtinGrant('TRANSPORT'), teacher]).lineScoped).toBe(true);
  });

  it('conserve les règles historiques des rôles intégrés cumulés', () => {
    expect(isClassScoped(['TEACHER'], 'grades.write')).toBe(true);
    expect(isClassScoped(['TEACHER', 'CENSOR'], 'grades.write')).toBe(false);
    expect(isClassScoped(['TEACHER', 'SUPERVISOR'], 'attendance.write')).toBe(false);
    expect(isLineScoped(['TRANSPORT'])).toBe(true);
    expect(isLineScoped(['TRANSPORT', 'SUPERVISOR'])).toBe(false);
    expect(isLineScoped(['TRANSPORT', 'TEACHER'])).toBe(true);
  });
});

describe('double authentification exigible', () => {
  it('pour les rôles administratifs intégrés', () => {
    for (const role of ADMIN_ROLES)
      expect(resolveAccess([builtinGrant(role)]).requiresMfa).toBe(true);
    expect(resolveAccess([builtinGrant('TEACHER')]).requiresMfa).toBe(false);
    expect(resolveAccess([builtinGrant('NURSE')]).requiresMfa).toBe(false);
  });

  it('pour tout rôle qui accorde un droit sur l’argent, le personnel ou les réglages', () => {
    expect(resolveAccess([custom(['library.loans'])]).requiresMfa).toBe(false);
    expect(resolveAccess([custom(['finance.payments.create'])]).requiresMfa).toBe(true);
    expect(resolveAccess([custom(['staff.write'])]).requiresMfa).toBe(true);
    expect(resolveAccess([custom(['settings.write'])]).requiresMfa).toBe(true);
    const teacher = builtinGrant('TEACHER', { added: ['finance.cash.close'], removed: [] });
    expect(resolveAccess([teacher]).requiresMfa).toBe(true);
  });
});

describe('schémas', () => {
  it('valide un rôle propre', () => {
    const ok = customRoleSchema.safeParse({
      name: '  Bibliothécaire ',
      permissions: ['library.loans'],
    });
    expect(ok.success && ok.data).toMatchObject({
      name: 'Bibliothécaire',
      classScoped: false,
      lineScoped: false,
    });
    expect(customRoleSchema.safeParse({ name: 'X', permissions: ['library.loans'] }).success).toBe(
      false,
    );
    expect(customRoleSchema.safeParse({ name: 'Rôle', permissions: [] }).success).toBe(false);
    expect(customRoleSchema.safeParse({ name: 'Rôle', permissions: ['tout.faire'] }).success).toBe(
      false,
    );
  });

  it('accepte un membre du personnel avec uniquement un rôle propre', () => {
    const base = {
      firstName: 'Awa',
      lastName: 'Ndi',
      email: 'awa@demo.cm',
      password: 'motdepasse-1',
    };
    expect(staffCreateSchema.safeParse({ ...base, customRoleIds: ['r1'] }).success).toBe(true);
    expect(staffCreateSchema.safeParse({ ...base }).success).toBe(false);
  });
});
