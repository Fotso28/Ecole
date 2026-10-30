import { describe, expect, it } from 'vitest';
import { isPortalActive, PORTAL_NAV, splitPortalNav } from './portal-nav';

describe('barre du bas du portail des parents', () => {
  it('garde quatre onglets et range les autres dans « Plus »', () => {
    const { primary, more } = splitPortalNav(PORTAL_NAV, '/portail', 0);
    expect(primary.map((i) => i.label)).toEqual(['Accueil', 'Notes', 'Payer', 'Messages']);
    expect(more.map((i) => i.label)).toEqual(['Absences', 'Devoirs', 'Agenda']);
  });

  it('met le badge des messages sur l’onglet quand il est visible, sinon sur « Plus »', () => {
    expect(splitPortalNav(PORTAL_NAV, '/portail', 3).moreBadge).toBe(false);
    const reordered = [...PORTAL_NAV.filter((i) => i.label !== 'Messages'), PORTAL_NAV[3]!];
    expect(splitPortalNav(reordered, '/portail', 3).moreBadge).toBe(true);
    expect(splitPortalNav(reordered, '/portail', 0).moreBadge).toBe(false);
  });

  it('active « Plus » sur une page du menu', () => {
    expect(splitPortalNav(PORTAL_NAV, '/portail/devoirs', 0).moreActive).toBe(true);
    expect(splitPortalNav(PORTAL_NAV, '/portail/notes', 0).moreActive).toBe(false);
  });

  it('n’ajoute pas « Plus » pour cinq onglets ou moins', () => {
    const five = PORTAL_NAV.slice(0, 5);
    expect(splitPortalNav(five, '/portail', 0)).toMatchObject({ primary: five, more: [] });
  });

  it('reconnaît la page active sans confondre l’accueil et ses sous-pages', () => {
    expect(isPortalActive('/portail', '/portail')).toBe(true);
    expect(isPortalActive('/portail', '/portail/notes')).toBe(false);
    expect(isPortalActive('/portail/messages', '/portail/messages/abc')).toBe(true);
    expect(isPortalActive('/portail/notes', '/portail/notesx')).toBe(false);
  });
});
