import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  loginParent,
  loginPlatformAdmin,
  loginStaff,
  PASSWORD,
  preparePlatformAdmin,
} from './helpers';

/** Accessibilité automatisée (WCAG 2.1 A et AA) : aucune violation grave ou critique. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) : ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(blocking, `violations d'accessibilité sur ${label}`).toEqual([]);
}

test('écrans publics', async ({ page }) => {
  for (const path of ['/connexion', '/parent/connexion', '/verifier']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await expectAccessible(page, path);
  }
});

test('écrans de la direction', async ({ page }) => {
  test.setTimeout(180_000);
  await loginStaff(page, 'direction@demo.cm');
  for (const path of [
    '/tableau-de-bord',
    '/eleves',
    '/eleves/nouveau',
    '/presences',
    '/notes',
    '/bulletins',
    '/releves',
    '/caisse',
    '/impayes',
    '/emploi-du-temps',
    '/cahier-de-texte',
    '/examens',
    '/examens/copies',
    '/parametres',
    '/eleves/import',
    '/documents',
    '/documents/modeles',
    '/incidents',
    '/rentree',
    '/annonces',
    '/calendrier',
    '/messages',
    '/messages/supervision',
    '/comptabilite',
    '/comptabilite/ecritures',
    '/comptabilite/depenses',
    '/comptabilite/etats',
    '/comptabilite/plan',
    '/rh',
    '/rh/heures',
    '/rh/paie',
    '/rh/avances',
    '/rh/baremes',
    '/transport',
    '/transport/appel',
    '/bibliotheque',
    '/stock',
    '/parametres/roles',
  ]) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expectAccessible(page, path);
  }
  // Fiche élève et dépôt d'une pièce d'inscription.
  await page.goto('/eleves?q=Ngono');
  await page.getByRole('link', { name: /Ngono Marie-Claire/ }).click();
  await expect(page.getByRole('heading', { name: 'Pièces du dossier' })).toBeVisible();
  await expectAccessible(page, '/eleves/[id]');
  await page
    .getByRole('button', { name: /(Déposer|Remplacer) le fichier : Certificat médical/ })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, '/eleves/[id] (dépôt de pièce)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  // Fenêtres de la fiche : correction d'identité, transfert ou sortie.
  await page.getByRole('button', { name: 'Corriger l’identité' }).click();
  await expect(page.getByRole('dialog', { name: 'Corriger l’identité' })).toBeVisible();
  await expectAccessible(page, '/eleves/[id] (identité)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Transfert ou sortie' }).click();
  await expect(page.getByRole('dialog', { name: 'Transfert ou sortie' })).toBeVisible();
  await expectAccessible(page, '/eleves/[id] (transfert ou sortie)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  // Structure : correction d'une matière de classe.
  await page.goto('/structure');
  await page.getByRole('button', { name: 'Modifier Français en 4e A' }).click();
  await expect(page.getByRole('dialog', { name: 'Français · 4e A' })).toBeVisible();
  await expectAccessible(page, '/structure (matière de classe)');
});

test('écran des rôles et fenêtre d’édition', async ({ page }) => {
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/parametres/roles');
  await page.getByRole('button', { name: 'Modifier le rôle Secrétariat' }).click();
  await expect(page.getByRole('dialog', { name: 'Secrétariat' })).toBeVisible();
  await expectAccessible(page, '/parametres/roles (rôle intégré)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Nouveau rôle' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouveau rôle' })).toBeVisible();
  await expectAccessible(page, '/parametres/roles (nouveau rôle)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.goto('/personnel');
  await page
    .getByRole('button', { name: /^Modifier les rôles de / })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: /^Rôles de / })).toBeVisible();
  await expectAccessible(page, '/personnel (rôles)');
});

test('dossier du personnel et fenêtres du module RH', async ({ page }) => {
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/rh');
  await page.getByRole('link', { name: 'Mbarga Paul' }).first().click();
  await expect(page.getByRole('heading', { name: 'Mbarga Paul', level: 1 })).toBeVisible();
  // Nouveau RIB du jeu de démonstration en attente d'approbation (tant que le parcours RH ne l'a
  // pas approuvé).
  await expectAccessible(page, '/rh/[id]');
  await page.getByRole('button', { name: 'Afficher' }).click();
  await expect(page.getByRole('dialog', { name: 'Données sensibles' })).toBeVisible();
  await expectAccessible(page, '/rh/[id] (données sensibles)');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Nouveau contrat' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouveau contrat' })).toBeVisible();
  await expectAccessible(page, '/rh/[id] (nouveau contrat)');
  await page.goto('/rh/avances');
  await page.getByRole('button', { name: 'Nouvelle demande' }).click();
  await expect(page.getByRole('dialog', { name: 'Demande d’avance sur salaire' })).toBeVisible();
  await expectAccessible(page, '/rh/avances (demande)');
  await page.goto('/rh/baremes');
  await page.getByRole('button', { name: 'Nouvelle version' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouvelle version du barème' })).toBeVisible();
  await expectAccessible(page, '/rh/baremes (nouvelle version)');
  // Paie validée du jeu de démonstration (deux mois plus tôt) : fenêtre de versement.
  await page.goto('/rh/paie');
  const now = new Date(Date.now() + 3_600_000);
  const demoMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
    .toISOString()
    .slice(0, 7);
  await page.getByLabel('Mois de paie').selectOption(demoMonth);
  await expect(page.getByText('Validée', { exact: true })).toBeVisible();
  await expectAccessible(page, '/rh/paie (paie validée)');
  await page.getByRole('button', { name: 'Marquer comme versée' }).click();
  await expect(page.getByRole('dialog', { name: 'Marquer la paie comme versée' })).toBeVisible();
  await expectAccessible(page, '/rh/paie (versement)');
});

test('journal des paiements et déplacement d’un cours', async ({ page }) => {
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/caisse/journal');
  await expect(page.locator('main h1').first()).toBeVisible();
  await expectAccessible(page, '/caisse/journal');
  // Emploi du temps : choix d'un créneau au clavier (alternative au glisser-déposer).
  await page.goto('/emploi-du-temps');
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  // Sur téléphone, un jour à la fois : le lundi a des cours dans le jeu de démonstration.
  const monday = page.getByRole('tab', { name: 'Lundi' });
  if (await monday.isVisible()) await monday.click();
  await page
    .getByRole('button', { name: /^Déplacer / })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: /^Déplacer / })).toBeVisible();
  await expectAccessible(page, '/emploi-du-temps (déplacer un cours)');
});

test('fenêtres du secrétariat et de la surveillance', async ({ page }) => {
  await loginStaff(page, 'secretariat@demo.cm');
  await page.goto('/documents');
  await page.getByRole('button', { name: 'Délivrer un document' }).click();
  const dialog = page.getByRole('dialog', { name: 'Délivrer un document' });
  await dialog.getByLabel('Élève', { exact: true }).fill('Ngono');
  await expect(dialog.getByRole('button', { name: /Ngono Marie-Claire/ })).toBeVisible();
  await expectAccessible(page, '/documents (délivrance)');
  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'surveillant@demo.cm');
  await page.goto('/incidents');
  await page.getByRole('button', { name: 'Signaler un incident' }).click();
  await expect(page.getByRole('dialog', { name: 'Signaler un incident' })).toBeVisible();
  await expectAccessible(page, '/incidents (saisie)');
});

test('écrans d’une session d’examen', async ({ page, request }) => {
  test.setTimeout(180_000);
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'censeur@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const classes = (await (
    await request.get(`${API_URL}/academic/classes`, { headers })
  ).json()) as { id: string; name: string }[];
  const created = await request.post(`${API_URL}/exams/sessions`, {
    headers,
    data: {
      name: `Contrôle accessibilité ${Date.now()}`,
      kind: 'PROMOTION',
      startDate: '2027-06-01',
      endDate: '2027-06-02',
      classIds: [classes.find((c) => c.name === '6e A')!.id],
    },
  });
  const { id } = (await created.json()) as { id: string };
  await loginStaff(page, 'censeur@demo.cm');
  await page.goto(`/examens/${id}`);
  await expect(page.locator('main h1').first()).toBeVisible();
  for (const tab of ['Calendrier', 'Salles et places', 'Surveillants', 'Résultats', 'Documents']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAccessible(page, `/examens/[id] (${tab})`);
  }
  await page.getByRole('tab', { name: 'Calendrier' }).click();
  await page.getByRole('button', { name: 'Ajouter une épreuve' }).click();
  await expectAccessible(page, '/examens/[id] (ajout d’épreuve)');
});

test('formulaires de la comptabilité', async ({ page }) => {
  await loginStaff(page, 'compta@demo.cm');
  await page.goto('/comptabilite/ecritures');
  await page.getByRole('button', { name: 'Nouvelle écriture' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouvelle écriture' })).toBeVisible();
  await expectAccessible(page, '/comptabilite/ecritures (nouvelle écriture)');
  await page.goto('/comptabilite/depenses');
  await page.getByRole('button', { name: 'Nouvelle dépense' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouvelle dépense' })).toBeVisible();
  await expectAccessible(page, '/comptabilite/depenses (nouvelle dépense)');
  // Dépense comptabilisée du jeu de démonstration : fenêtre d'annulation.
  await page.getByRole('button', { name: 'Fermer' }).click();
  await page
    .getByRole('button', { name: /^Annuler la dépense Facture d’eau/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Annuler cette dépense ?' })).toBeVisible();
  await expectAccessible(page, '/comptabilite/depenses (annulation)');
  // Sortie de banque au-delà du seuil en attente de validation.
  await page.goto('/comptabilite/ecritures');
  await expect(
    page.getByRole('heading', { name: 'Écritures de trésorerie à valider' }),
  ).toBeVisible();
  await expectAccessible(page, '/comptabilite/ecritures (écritures à valider)');
  for (const kind of ['grand-livre', 'bilan']) {
    await page.goto('/comptabilite/etats');
    await page.getByLabel('État').selectOption(kind);
    await expect(page.locator('main h2').first()).toBeVisible();
    await expectAccessible(page, `/comptabilite/etats (${kind})`);
  }
});

test('appel et notes de l’enseignant', async ({ page }) => {
  await loginStaff(page, 'prof.maths@demo.cm');
  await page.goto('/presences');
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  await expect(page.getByRole('button', { name: 'Marquer les autres présents' })).toBeVisible();
  await expectAccessible(page, '/presences (appel)');
  await page.goto('/notes');
  const select = page.getByLabel('Classe et matière');
  const value = await select
    .locator('option', { hasText: '4e A · Mathématiques' })
    .getAttribute('value');
  await select.selectOption(value ?? '');
  await expect(
    page
      .getByText(/Moyenne/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expectAccessible(page, '/notes (saisie)');
  await page.goto('/cahier-de-texte');
  await expect(page.getByText(/Théorème de Pythagore/).first()).toBeVisible();
  await expectAccessible(page, '/cahier-de-texte (enseignant)');
  await page.getByRole('button', { name: 'Nouvelle séance' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, '/cahier-de-texte (nouvelle séance)');
  await page.goto('/messages');
  await page.getByRole('list', { name: 'Conversations' }).getByRole('link').first().click();
  await expect(page.getByRole('list', { name: 'Messages' })).toBeVisible();
  await expectAccessible(page, '/messages/[id] (fil)');
  await page.goto('/calendrier');
  await page.getByRole('button', { name: 'Mois', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expectAccessible(page, '/calendrier (mois)');
});

test('transport, bibliothèque et stock', async ({ page }) => {
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/transport');
  for (const [button, dialog] of [
    ['Abonner un élève', 'Abonner un élève'],
    ['Nouvelle ligne', 'Nouvelle ligne'],
    ['Nouveau véhicule', 'Nouveau véhicule'],
  ] as const) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.getByRole('dialog', { name: dialog })).toBeVisible();
    await expectAccessible(page, `/transport (${dialog})`);
    await page.keyboard.press('Escape');
  }
  for (const tab of ['Abonnés', 'Véhicules', 'Réglages']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAccessible(page, `/transport (${tab})`);
  }
  await page.goto('/bibliotheque');
  await page.getByRole('button', { name: 'Nouveau prêt' }).click();
  await expect(page.getByRole('dialog', { name: 'Nouveau prêt' })).toBeVisible();
  await expectAccessible(page, '/bibliotheque (nouveau prêt)');
  await page.keyboard.press('Escape');
  for (const tab of ['En retard', 'Catalogue', 'Réglages']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAccessible(page, `/bibliotheque (${tab})`);
  }
  await page.goto('/stock');
  await page.getByRole('button', { name: 'Vendre à un élève' }).click();
  await expect(page.getByRole('dialog', { name: 'Vente à un élève' })).toBeVisible();
  await expectAccessible(page, '/stock (vente)');
  await page.keyboard.press('Escape');
  for (const tab of ['Mouvements', 'Inventaire']) {
    await page.getByRole('tab', { name: tab }).click();
    await expectAccessible(page, `/stock (${tab})`);
  }
  // Appel du car par le chauffeur, sur téléphone ou ordinateur.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'chauffeur@demo.cm');
  await expect(page.getByRole('heading', { name: 'Appel du car' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Élèves du trajet' })).toBeVisible();
  await expectAccessible(page, '/transport/appel (chauffeur)');
});

test('portail des parents', async ({ page, request }, info) => {
  // Un parent différent par projet, pour ne pas dépasser la limite de codes SMS par numéro.
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'direction@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const list = (await (
    await request.get(`${API_URL}/students?pageSize=50`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).json()) as { items: { class: { name: string } | null; guardian: { phone: string } | null }[] };
  const phones = list.items
    .filter(
      (s) => s.class?.name !== '4e A' && s.guardian && !s.guardian.phone.endsWith('677123456'),
    )
    .map((s) => s.guardian!.phone);
  await loginParent(page, phones[info.project.name === 'mobile' ? 0 : 1]!.replace('+237', ''));
  await expect(page.getByRole('heading', { name: /^Bonjour/ })).toBeVisible();
  await expectAccessible(page, '/portail');
  for (const path of [
    '/portail/paiement',
    '/portail/notes',
    '/portail/absences',
    '/portail/devoirs',
    '/portail/messages',
    '/portail/calendrier',
    '/portail/transport',
  ]) {
    await page.goto(path);
    await expect(page.locator('main').first()).toBeVisible();
    await expectAccessible(page, path);
  }
  // Menu « Plus » de la barre du bas, et bandeau hors connexion.
  await page
    .getByRole('navigation', { name: 'Navigation' })
    .getByRole('button', { name: /^Plus/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Plus' })).toBeVisible();
  await expectAccessible(page, '/portail (menu Plus)');
  await page.keyboard.press('Escape');
  await page.context().setOffline(true);
  await expect(page.getByText(/^Hors connexion/)).toBeVisible();
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await page.context().setOffline(false);
});

test('facturation de la plateforme', async ({ page, request }) => {
  const { secret } = await preparePlatformAdmin(request);
  await loginPlatformAdmin(page, secret);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation');
  await page.getByRole('button', { name: 'Nouvelle offre' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation (nouvelle offre)');
  await page.keyboard.press('Escape');
  await page
    .getByRole('link', { name: /Collège Démo/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Collège Démo' })).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation/[id]');
});
