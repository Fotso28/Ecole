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

  // Le paiement apparaît au journal ; on l'annule par une écriture de correction.
  await page.goto('/caisse/journal');
  const row = page
    .locator('li')
    .filter({ hasText: student })
    .filter({ hasText: 'Encaissé' })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Annuler' }).click();
  const dialog = page.getByRole('dialog', { name: 'Annuler ce paiement ?' });
  await dialog.getByLabel('Motif de l’annulation').fill('Erreur de saisie au guichet');
  await dialog.getByRole('button', { name: 'Créer l’écriture de correction' }).click();
  await expect(page.getByText('Paiement annulé par une écriture de correction')).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: student }).filter({ hasText: 'Annulé' }).first(),
  ).toBeVisible();

  // Clôture : le montant attendu exclut le paiement annulé.
  await page.goto('/caisse');
  await page.getByRole('button', { name: 'Clôturer ma caisse' }).click();
  const close = page.getByRole('dialog', { name: 'Clôturer ma caisse' });
  const expectedText = (await close.locator('strong').first().textContent()) ?? '0';
  await close.getByLabel('Montant compté').fill(expectedText.replace(/\D/g, ''));
  await close.getByRole('button', { name: 'Clôturer' }).click();
  await expect(page.getByText('Caisse clôturée sans écart')).toBeVisible();
});
