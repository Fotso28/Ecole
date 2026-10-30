import { permissionsForRoles, type StaffRole } from '@ecole/shared';
import { describe, expect, it } from 'vitest';
import { activeHref, primaryNav, safeNextPath, visibleNav } from './nav';
import type { Me } from './types';

function me(
  roles: StaffRole[],
  modules = ['students', 'attendance', 'grades', 'finance', 'communication', 'portal', 'timetable'],
): Me {
  return {
    user: {
      id: 'u',
      firstName: 'A',
      lastName: 'B',
      email: 'a@b.cm',
      phone: null,
      isPlatformAdmin: false,
      mfaEnabled: false,
    },
    kind: 'staff',
    schools: [],
    activeSchool: {
      id: 's',
      name: 'École',
      city: 'Yaoundé',
      modules,
      mfaRequired: false,
      currentYear: { id: 'y', name: '2026-2027' },
    },
    roles,
    permissions: [...permissionsForRoles(roles)],
  };
}

const hrefs = (m: Me) => visibleNav(m).flatMap((g) => g.items.map((i) => i.href));

describe('navigation par rôle', () => {
  it('réserve la facturation des écoles au super-administrateur', () => {
    expect(hrefs(me(['DIRECTOR']))).not.toContain('/plateforme/facturation');
    const admin: Me = {
      ...me([]),
      user: { ...me([]).user, isPlatformAdmin: true },
      activeSchool: null,
    };
    expect(hrefs(admin)).toEqual(['/plateforme/facturation']);
    expect(primaryNav(admin).map((i) => i.href)).toEqual(['/plateforme/facturation']);
  });

  it('masque ce qui n’est pas autorisé au lieu de le griser', () => {
    const teacher = hrefs(me(['TEACHER']));
    expect(teacher).toEqual(
      expect.arrayContaining(['/eleves', '/presences', '/enseignant', '/notes']),
    );
    expect(teacher).not.toContain('/caisse');
    expect(teacher).not.toContain('/tableau-de-bord');
    expect(teacher).not.toContain('/parametres');
  });

  it('ouvre la messagerie aux enseignants et à la vie scolaire, pas au secrétariat', () => {
    expect(hrefs(me(['TEACHER']))).toEqual(expect.arrayContaining(['/messages', '/calendrier']));
    expect(hrefs(me(['SUPERVISOR']))).toContain('/messages');
    expect(hrefs(me(['SECRETARY']))).not.toContain('/messages');
    expect(hrefs(me(['SECRETARY']))).toEqual(expect.arrayContaining(['/annonces', '/calendrier']));
    expect(hrefs(me(['TEACHER'], ['students', 'attendance', 'grades']))).not.toContain('/messages');
  });

  it('donne à la comptabilité la caisse mais pas les notes', () => {
    const accountant = hrefs(me(['ACCOUNTANT']));
    expect(accountant).toEqual(expect.arrayContaining(['/caisse', '/impayes', '/caisse/journal']));
    expect(accountant).not.toContain('/notes');
  });

  it('ouvre le cahier de texte aux enseignants, au censeur et à la direction', () => {
    expect(hrefs(me(['TEACHER']))).toContain('/cahier-de-texte');
    expect(hrefs(me(['CENSOR']))).toContain('/cahier-de-texte');
    expect(hrefs(me(['DIRECTOR']))).toContain('/cahier-de-texte');
    expect(hrefs(me(['ACCOUNTANT']))).not.toContain('/cahier-de-texte');
    expect(hrefs(me(['SECRETARY']))).not.toContain('/cahier-de-texte');
  });

  it('cumule les menus de rôles multiples', () => {
    const both = hrefs(me(['TEACHER', 'SUPERVISOR']));
    expect(both).toEqual(
      expect.arrayContaining(['/notes', '/presences/justificatifs', '/tableau-de-bord']),
    );
  });

  it('ouvre les relevés de notes à la direction et au censeur, pas aux enseignants', () => {
    expect(hrefs(me(['DIRECTOR']))).toContain('/releves');
    expect(hrefs(me(['CENSOR']))).toContain('/releves');
    expect(hrefs(me(['TEACHER']))).not.toContain('/releves');
    expect(hrefs(me(['CENSOR'], ['students']))).not.toContain('/releves');
  });

  it('retire les modules non souscrits', () => {
    const noFinance = hrefs(me(['DIRECTOR'], ['students', 'grades']));
    expect(noFinance).not.toContain('/caisse');
    expect(noFinance).not.toContain('/presences');
    expect(noFinance).toContain('/eleves');
  });

  it('choisit quatre destinations pour le menu inférieur du téléphone', () => {
    expect(primaryNav(me(['TEACHER'])).map((i) => i.href)).toEqual([
      '/enseignant',
      '/presences',
      '/notes',
      '/eleves',
    ]);
    expect(primaryNav(me(['ACCOUNTANT'])).map((i) => i.href)).toEqual([
      '/tableau-de-bord',
      '/caisse',
      '/impayes',
      '/caisse/journal',
    ]);
    expect(primaryNav(me(['DIRECTOR'])).length).toBe(4);
  });

  it('ne dépasse jamais cinq entrées dans le menu du bas (quatre destinations et « Menu »)', () => {
    const roles: StaffRole[] = [
      'DIRECTOR',
      'CENSOR',
      'SUPERVISOR',
      'SECRETARY',
      'ACCOUNTANT',
      'TEACHER',
      'NURSE',
    ];
    for (const role of roles) expect(primaryNav(me([role])).length).toBeLessThanOrEqual(4);
    expect(primaryNav(me(roles)).length).toBeLessThanOrEqual(4);
  });

  it('active l’élément du plus long préfixe', () => {
    const items = visibleNav(me(['DIRECTOR'])).flatMap((g) => g.items);
    expect(activeHref('/caisse/journal', items)).toBe('/caisse/journal');
    expect(activeHref('/caisse', items)).toBe('/caisse');
    expect(activeHref('/eleves/abc', items)).toBe('/eleves');
    expect(activeHref('/eleves/nouveau', items)).toBe('/eleves/nouveau');
  });
});

describe('redirection après connexion', () => {
  it('accepte un chemin interne', () => {
    expect(safeNextPath('/eleves?statut=ENROLLED')).toBe('/eleves?statut=ENROLLED');
    expect(safeNextPath('/caisse/journal')).toBe('/caisse/journal');
    // La tabulation est ignorée par le navigateur : le chemin reste interne.
    expect(safeNextPath('/\tnotes')).toBe('/notes');
  });

  it('refuse tout chemin qui mène hors du site', () => {
    for (const next of [
      null,
      '',
      'https://pirate.example',
      '//pirate.example',
      '/\\pirate.example',
      '/\t/pirate.example',
      'javascript:alert(1)',
    ]) {
      expect(safeNextPath(next)).toBeNull();
    }
  });

  it('ouvre les écrans du secrétariat et de la discipline aux seuls rôles concernés', () => {
    const modules = [
      'students',
      'attendance',
      'grades',
      'finance',
      'communication',
      'portal',
      'documents',
    ];
    expect(hrefs(me(['SECRETARY'], modules))).toEqual(
      expect.arrayContaining(['/documents', '/rentree', '/eleves/nouveau']),
    );
    expect(hrefs(me(['SECRETARY'], modules))).not.toContain('/incidents');
    expect(hrefs(me(['SUPERVISOR'], modules))).toContain('/incidents');
    expect(hrefs(me(['SUPERVISOR'], modules))).not.toContain('/documents');
    expect(hrefs(me(['DIRECTOR'], modules))).toEqual(
      expect.arrayContaining(['/documents', '/incidents', '/rentree']),
    );
    for (const role of ['CENSOR', 'TEACHER', 'ACCOUNTANT'] as const) {
      expect(hrefs(me([role], modules))).not.toContain('/incidents');
      expect(hrefs(me([role], modules))).not.toContain('/documents');
    }
    // Module « documents » non souscrit : l'entrée disparaît.
    expect(hrefs(me(['SECRETARY']))).not.toContain('/documents');
  });
});
