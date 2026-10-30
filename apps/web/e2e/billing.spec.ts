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
  await expect(page.getByText(/Facture ABO-\d{4}-\d{4} émise/)).toBeVisible();
  // La facture la plus récente est en tête de liste.
  const number = (
    await page.getByRole('heading', { level: 3, name: /ABO-/ }).first().textContent()
  )?.trim();
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
