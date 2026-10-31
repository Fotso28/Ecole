import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginStaff, navigate } from './helpers';

test('encaissement en espèces, reçu, annulation et clôture de caisse', async ({ page }, info) => {
  const student = info.project.name === 'mobile' ? 'Ngono Paul-Henri' : 'Ngono Marie-Claire';
  await loginStaff(page, 'compta@demo.cm');
  await navigate(page, info, 'Caisse');
  const open = page.getByRole('button', { name: 'Ouvrir ma caisse' });
  await expect(page.getByText('Ouverte', { exact: true }).or(open)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(page.getByText('Ouverte', { exact: true })).toBeVisible();

  await page.getByPlaceholder('Nom, matricule ou téléphone du parent').fill('Ngono');
  await page.getByRole('button', { name: new RegExp(student) }).click();
  await expect(page.getByRole('heading', { name: 'Échéancier' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const amountText = await page.getByLabel('Montant encaissé').inputValue();
  const amount = Number(amountText);
  expect(amount).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Espèces' }).click();
  await page.getByLabel('Montant remis').fill(String(amount + 5000));
  await expect(page.getByText('5 000 FCFA', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Encaisser / }).click();
  const confirm = page.getByRole('dialog', { name: 'Vérifiez avant de valider' });
  await expect(confirm.getByText(student.replace('Ngono ', 'Ngono '))).toBeVisible();
  await confirm.getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByRole('heading', { name: /Reçu R-\d{4}-\d{6} émis/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Imprimer le reçu' })).toBeVisible();

  // Le caissier ne peut pas annuler ses propres encaissements : la direction le fait depuis le journal.
  await page.goto('/caisse/journal');
  const row = () =>
    page.locator('li').filter({ hasText: student }).filter({ hasText: 'Encaissé' }).first();
  await expect(row()).toBeVisible();
  await expect(row().getByRole('button', { name: 'Annuler' })).toHaveCount(0);
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/caisse/journal');
  await row().getByRole('button', { name: 'Annuler' }).click();
  const dialog = page.getByRole('dialog', { name: 'Annuler ce paiement ?' });
  await dialog.getByLabel('Motif de l’annulation').fill('Erreur de saisie au guichet');
  await dialog.getByRole('button', { name: 'Créer l’écriture de correction' }).click();
  await expect(page.getByText('Paiement annulé par une écriture de correction')).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: student }).filter({ hasText: 'Annulé' }).first(),
  ).toBeVisible();
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'compta@demo.cm');

  // Clôture : le montant attendu exclut le paiement annulé ; un écart exige un motif.
  await page.goto('/caisse');
  await page.getByRole('button', { name: 'Clôturer ma caisse' }).click();
  const close = page.getByRole('dialog', { name: 'Clôturer ma caisse' });
  const expectedText = (await close.locator('strong').first().textContent()) ?? '0';
  const expected = Number(expectedText.replace(/\D/g, ''));
  await close.getByLabel('Montant compté').fill(String(expected + 500));
  await expect(close.getByText('Excédent : +500 FCFA')).toBeVisible();
  await expect(close.getByRole('button', { name: 'Clôturer' })).toBeDisabled();
  await close.getByLabel('Motif de l’écart').fill('Monnaie non reprise par un parent');
  await close.getByRole('button', { name: 'Clôturer' }).click();
  await expect(
    page.getByText('Caisse clôturée · écart de +500 FCFA, à faire approuver'),
  ).toBeVisible();

  // Le caissier voit sa clôture mais ne l'approuve pas.
  await page.goto('/caisse/clotures');
  const closure = () =>
    page
      .locator(info.project.name === 'mobile' ? 'li' : 'tr')
      .filter({ hasText: 'Monnaie non reprise par un parent' })
      .filter({ hasText: 'À approuver' })
      .first();
  await expect(closure()).toBeVisible();
  await expect(closure().getByRole('button', { name: /^Approuver/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // La direction l'approuve depuis « À traiter » du tableau de bord.
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/tableau-de-bord');
  await page.getByRole('link', { name: /\d+ clôtures? de caisse à approuver/ }).click();
  await expect(page).toHaveURL(/\/caisse\/clotures$/);
  await expect(page.getByRole('heading', { name: 'Clôtures de caisse' })).toBeVisible();
  await expect(closure()).toContainText('+500 FCFA');
  await closure()
    .getByRole('button', { name: /^Approuver/ })
    .click();
  await expect(page.getByText(/^Clôture approuvée/)).toBeVisible();
  await expect(closure()).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
