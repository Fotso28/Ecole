import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { API_URL, E2E_DATABASE_URL } from '../playwright.config';
import {
  expectNoHorizontalOverflow,
  isMobile,
  loginParent,
  loginStaff,
  navigate,
  PASSWORD,
} from './helpers';

async function switchUser(page: Page, email: string) {
  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, email);
}

/** Matricules d'élèves inscrits sans abonnement au transport (un par projet de test). */
function unsubscribedMatricules(): string[] {
  const out = execSync(`psql "${E2E_DATABASE_URL}" -At -v ON_ERROR_STOP=1`, {
    input: `SELECT s."matricule" FROM "Student" s JOIN "Enrollment" e ON e."studentId" = s."id" JOIN "Class" c ON c."id" = e."classId" WHERE c."name" = '5e A' AND s."id" NOT IN (SELECT "studentId" FROM "TransportSubscription") ORDER BY s."matricule" LIMIT 4;`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.toString().trim().split('\n').filter(Boolean);
}

async function apiToken(request: APIRequestContext): Promise<{ Authorization: string }> {
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'direction@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { Authorization: `Bearer ${accessToken}` };
}

test.describe('transport scolaire', () => {
  test('le secrétariat abonne un élève, facturé dans la scolarité', async ({ page }, info) => {
    const matricule = unsubscribedMatricules()[isMobile(info) ? 0 : 1]!;
    await loginStaff(page, 'secretariat@demo.cm');
    await navigate(page, info, 'Transport scolaire');
    await expect(page.getByRole('heading', { name: 'Transport scolaire' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ligne 1 – Bastos' })).toBeVisible();
    await expect(page.getByLabel('Alertes des véhicules')).toContainText('Assurance');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Abonner un élève' }).click();
    const dialog = page.getByRole('dialog', { name: 'Abonner un élève' });
    await dialog.getByLabel('Élève', { exact: true }).fill(matricule);
    await dialog.getByRole('button', { name: new RegExp(matricule) }).click();
    const lineSelect = dialog.getByLabel('Ligne');
    const lineValue = await lineSelect
      .locator('option', { hasText: 'Ligne 1 – Bastos' })
      .getAttribute('value');
    await lineSelect.selectOption(lineValue ?? '');
    await dialog.getByLabel('Arrêt').selectOption({ index: 2 });
    await dialog.getByLabel('Trajets').selectOption('OUTBOUND');
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: /Abonner \(50/ }).click();
    await expect(
      page.getByText('Élève abonné ; le tarif est ajouté à son échéancier'),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Abonnés' }).click();
    const list = page.getByRole('list', { name: 'Abonnés au transport' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await expect(list).toContainText('Aller seulement');
    await expectNoHorizontalOverflow(page);

    // Avoir sur la facture d'un abonnement, par le gestionnaire du transport.
    const row = list.getByRole('listitem').filter({ hasText: 'Aller seulement' }).first();
    await row.getByRole('button', { name: /^Avoir sur l’abonnement/ }).click();
    const credit = page.getByRole('dialog', { name: /^Avoir sur l’abonnement/ });
    await credit.getByLabel('Montant de l’avoir (FCFA)').fill('1000');
    await credit.getByLabel('Motif').fill('Ligne interrompue une semaine');
    await expectNoHorizontalOverflow(page);
    await credit.getByRole('button', { name: 'Enregistrer l’avoir' }).click();
    await expect(page.getByText(/Avoir de 1.000.FCFA enregistré sur la facture/)).toBeVisible();
  });

  test('le chauffeur fait l’appel, y compris sans réseau', async ({ page, context }) => {
    await loginStaff(page, 'chauffeur@demo.cm');
    await page.waitForURL('**/transport/appel');
    await expect(page.getByRole('heading', { name: 'Appel du car' })).toBeVisible();
    await page.getByLabel('Trajet', { exact: true }).selectOption('OUTBOUND');
    const list = page.getByRole('list', { name: 'Élèves du trajet' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Marie-Claire Ngono : monté' }).click();
    await expect(page.getByRole('button', { name: 'Marie-Claire Ngono : monté' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('status').filter({ hasText: 'Appel enregistré' })).toBeVisible();

    // Coupure réseau : l'appel est gardé sur le téléphone puis envoyé au retour du réseau.
    await context.setOffline(true);
    const second = list.getByRole('listitem').nth(1);
    await second.getByRole('button', { name: /: absent$/ }).click();
    await expect(page.getByText(/Appel gardé sur le téléphone/)).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole('status').filter({ hasText: 'Appel enregistré' })).toBeVisible({
      timeout: 30_000,
    });
    // Le pointage est bien sur le serveur après rechargement.
    await second.getByRole('button', { name: /: monté$/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Appel enregistré' })).toBeVisible();
    await page.reload();
    await page.getByLabel('Trajet', { exact: true }).selectOption('OUTBOUND');
    await expect(
      list
        .getByRole('listitem')
        .nth(1)
        .getByRole('button', { name: /: monté$/ }),
    ).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('tab', { name: 'Descente' }).click();
    await page.getByRole('button', { name: 'Marie-Claire Ngono : descendu' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Appel enregistré' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('le parent voit la ligne, l’arrêt et l’horaire de son enfant', async ({
    page,
    request,
  }, info) => {
    const headers = await apiToken(request);
    const subs = (await (
      await request.get(`${API_URL}/transport/subscriptions`, { headers })
    ).json()) as { status: string; line: { name: string }; student: { id: string } | null }[];
    const students = (await (
      await request.get(`${API_URL}/students?pageSize=100`, { headers })
    ).json()) as { items: { id: string; lastName: string; guardian: { phone: string } | null }[] };
    // Enfants abonnés à la ligne de démonstration, hors famille Ngono (limite de codes SMS).
    const phones = subs
      .filter((sub) => sub.status === 'ACTIVE' && sub.line.name === 'Ligne 1 – Bastos')
      .map((sub) => students.items.find((st) => st.id === sub.student?.id))
      .filter((st) => st && st.lastName !== 'Ngono' && st.guardian)
      .map((st) => st!.guardian!.phone);
    await loginParent(page, phones[isMobile(info) ? 0 : 1]!.replace('+237', ''));
    await page.getByRole('link', { name: /Transport scolaire/ }).click();
    await expect(page.getByRole('heading', { name: 'Transport scolaire' })).toBeVisible();
    await expect(page.getByText('Ligne 1 – Bastos')).toBeVisible();
    await expect(page.getByText('Passage du matin')).toBeVisible();
    await expect(page.getByText(/^\d{2}:\d{2}$/).first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('bibliothèque et stock', () => {
  test('prêt et retour d’un livre, retards signalés', async ({ page }, info) => {
    await loginStaff(page, 'secretariat@demo.cm');
    await navigate(page, info, 'Bibliothèque');
    await expect(page.getByRole('heading', { name: 'Bibliothèque' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('tab', { name: 'En retard' }).click();
    await expect(page.getByRole('list', { name: 'Prêts' })).toContainText('Ville cruelle');
    await expect(page.getByRole('list', { name: 'Prêts' })).toContainText('de retard');

    await page.getByRole('button', { name: 'Nouveau prêt' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau prêt' });
    await dialog.getByLabel('Livre').fill('Enfant noir');
    await dialog.getByLabel('Exemplaire disponible').selectOption({ index: 1 });
    await dialog.getByLabel('Lecteur').selectOption('STAFF');
    await dialog.getByLabel('Membre du personnel').selectOption({ label: 'Owona Jean' });
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Enregistrer le prêt' }).click();
    await expect(page.getByText(/Prêt enregistré, retour prévu le/)).toBeVisible();

    await page.getByRole('tab', { name: 'Prêts en cours' }).click();
    await page
      .getByRole('button', { name: /Retour de L’Enfant noir/ })
      .first()
      .click();
    const back = page.getByRole('dialog', { name: 'Enregistrer le retour' });
    await expect(back).toContainText('Owona Jean');
    await back.getByRole('button', { name: 'Confirmer le retour' }).click();
    await expect(page.getByText('Retour enregistré')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('vente d’un uniforme facturée et inventaire du stock', async ({ page }, info) => {
    await switchUser(page, 'compta@demo.cm');
    await navigate(page, info, 'Stock et uniformes');
    await expect(page.getByRole('heading', { name: 'Stock et uniformes' })).toBeVisible();
    await expect(page.getByLabel('Alertes de stock')).toContainText('Chemise uniforme');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Vendre à un élève' }).click();
    const dialog = page.getByRole('dialog', { name: 'Vente à un élève' });
    await dialog.getByLabel('Article').selectOption({ label: 'Chemise uniforme' });
    await dialog.getByLabel('Taille').selectOption('M');
    await dialog.getByLabel('Élève', { exact: true }).fill('Ngono');
    await dialog.getByRole('button', { name: /Ngono Marie-Claire/ }).click();
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: /Vendre \(4/ }).click();
    await expect(
      page.getByText('Vente enregistrée et ajoutée à l’échéancier de l’élève'),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Mouvements' }).click();
    const moves = page.getByRole('list', { name: 'Mouvements de stock' });
    await expect(moves.getByRole('listitem').first()).toContainText('Vente à un élève');
    await expect(moves.getByRole('listitem').first()).toContainText('Facturé');

    await page.getByRole('tab', { name: 'Inventaire' }).click();
    await expect(page.getByRole('list', { name: 'Comptage' })).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer l’inventaire' }).click();
    await expect(page.getByText(/Inventaire (conforme|enregistré)/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
