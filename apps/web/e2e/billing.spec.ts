import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  expectNoHorizontalOverflow,
  loginPlatformAdmin,
  loginStaff,
  navigate,
  preparePlatformAdmin,
} from './helpers';

interface Detail {
  invoices: {
    id: string;
    state: string;
    payments: { id: string; amount: number; corrected: boolean }[];
  }[];
}

/** Repart d'un état propre : les factures en cours du Collège Démo sont corrigées puis annulées. */
async function cancelOpenInvoices(request: APIRequestContext, token: string): Promise<string> {
  const headers = { Authorization: `Bearer ${token}` };
  const overview = (await (
    await request.get(`${API_URL}/platform/billing/schools`, { headers })
  ).json()) as { schools: { id: string; name: string }[] };
  const school = overview.schools.find((s) => s.name === 'Collège Démo');
  expect(school).toBeTruthy();
  const detail = (await (
    await request.get(`${API_URL}/platform/billing/schools/${school!.id}`, { headers })
  ).json()) as Detail;
  for (const inv of detail.invoices.filter((i) => i.state !== 'CANCELLED')) {
    for (const p of inv.payments.filter((p) => p.amount > 0 && !p.corrected))
      await request.post(`${API_URL}/platform/billing/payments/${p.id}/correct`, {
        headers,
        data: { reason: 'Remise à zéro du parcours de test' },
      });
    await request.post(`${API_URL}/platform/billing/invoices/${inv.id}/cancel`, {
      headers,
      data: { reason: 'Remise à zéro du parcours de test' },
    });
  }
  return school!.id;
}

test('facturation de l’abonnement : plateforme puis direction', async ({ page, request }, info) => {
  test.setTimeout(150_000);
  const { secret, token } = await preparePlatformAdmin(request);
  await cancelOpenInvoices(request, token);

  await loginPlatformAdmin(page, secret);
  await expect(page.getByRole('heading', { name: 'Facturation des écoles' })).toBeVisible();
  const offers = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Offres' }) });
  await expect(offers.getByText('Essentiel', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page
    .getByRole('link', { name: /Collège Démo/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Collège Démo' })).toBeVisible();
  await page.getByLabel('Offre de l’établissement').selectOption({ label: 'Essentiel' });
  await page.getByRole('button', { name: 'Appliquer' }).click();
  await expect(page.getByText('Offre enregistrée')).toBeVisible();
  await expect(page.getByText('Total annuel').first()).toBeVisible();

  await page.getByRole('button', { name: 'Émettre la facture' }).click();
  // Numéro lu dans la confirmation : la liste peut encore afficher l'état d'avant l'émission.
  const issued = page.getByText(/Facture ABO-\d{4}-\d{4} émise/);
  await expect(issued).toBeVisible();
  const number = (await issued.textContent())?.match(/ABO-\d{4}-\d{4}/)?.[0];
  expect(number).toBeTruthy();
  const invoice = page
    .locator('li')
    .filter({ has: page.getByRole('heading', { level: 3, name: number }) });
  await expect(invoice.getByText('À régler')).toBeVisible();
  await expect(invoice).toBeVisible();
  await expectNoHorizontalOverflow(page, 'détail de facturation');

  await invoice.getByRole('button', { name: 'Enregistrer un règlement' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Montant (FCFA)').fill('1000');
  await dialog.getByLabel(/Référence/).fill('VIR-E2E');
  await dialog.getByRole('button', { name: 'Enregistrer le règlement' }).click();
  await expect(invoice.getByText('Réglée en partie')).toBeVisible();
  await expect(invoice.getByText(/VIR-E2E/)).toBeVisible();

  await invoice.getByRole('button', { name: 'Relancer' }).click();
  await expect(invoice.getByText(/1 relance, la dernière le/)).toBeVisible();

  if (info.project.name === 'desktop') {
    // Correction par écriture négative : le règlement d'origine reste visible.
    await invoice.getByRole('button', { name: 'Corriger' }).click();
    await dialog.getByLabel('Motif').fill('Virement rejeté par la banque');
    await dialog.getByRole('button', { name: 'Corriger le règlement' }).click();
    await expect(invoice.getByText('À régler')).toBeVisible();
    await expect(invoice.getByText('Correction')).toBeVisible();
  }

  // La direction voit sa facture dans Paramètres, sans coupure de l'accès.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Paramètres');
  const card = page.locator('#abonnement');
  await expect(card.getByRole('heading', { name: 'Abonnement' })).toBeVisible();
  await expect(card.getByText(/Offre Essentiel/)).toBeVisible();
  await expect(
    card.getByText(info.project.name === 'desktop' ? 'À régler' : 'Réglée en partie'),
  ).toBeVisible();
  await expect(card.getByRole('status')).toContainText('Votre accès n’est pas interrompu');
  await expectNoHorizontalOverflow(page, 'paramètres (abonnement)');
});

test('nouvel établissement : création par la plateforme, puis guide de démarrage de la direction', async ({
  page,
  request,
}, info) => {
  const tag = info.project.name === 'mobile' ? 'tel' : 'ordi';
  const stamp = Date.now().toString(36);
  const email = `direction.${tag}.${stamp}@lbb.cm`;
  const { secret } = await preparePlatformAdmin(request);
  await loginPlatformAdmin(page, secret);
  await page.getByRole('button', { name: 'Nouvel établissement' }).click();
  const form = page.getByRole('dialog', { name: 'Nouvel établissement' });
  await form
    .getByLabel('Nom de l’établissement')
    .fill(`Lycée Bilingue de Bafoussam ${tag} ${stamp}`);
  await expect(form.getByLabel('Identifiant')).toHaveValue(
    `lycee-bilingue-de-bafoussam-${tag}-${stamp}`,
  );
  await form.getByLabel('Ville').fill('Bafoussam');
  await form.getByLabel('Préfixe des matricules').fill('LBB');
  await form.getByLabel('Prénom').fill('Henriette');
  await form.getByLabel('Nom', { exact: true }).fill('Tchinda');
  await form.getByLabel('Adresse e-mail').fill(email);
  await form.getByLabel('Mot de passe provisoire').fill('Bafoussam2026!');
  await expectNoHorizontalOverflow(page);
  await form.getByRole('button', { name: 'Créer l’établissement' }).click();
  await expect(page.getByText(new RegExp(`la direction se connecte avec ${email}`))).toBeVisible();
  await expect(
    page.getByText(`Lycée Bilingue de Bafoussam ${tag} ${stamp}`).filter({ visible: true }).first(),
  ).toBeVisible();

  // Première connexion de la direction : guide de démarrage, pas de message d'erreur.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill('Bafoussam2026!');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Bienvenue, Henriette' })).toBeVisible();
  await expect(page.getByText('Impossible d’afficher cette page')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: /^Créer l’année \d{4}-\d{4}$/ }).click();
  await expect(
    page.getByText(/^Année \d{4}-\d{4} créée et définie comme année en cours/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bonjour, Henriette' })).toBeVisible();
  await expect(page.getByText('Rien en attente. Tout est à jour.')).toBeVisible();
});
