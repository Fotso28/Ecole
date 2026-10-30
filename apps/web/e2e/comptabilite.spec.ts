import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff, navigate } from './helpers';

/** Ligne visible (carte sur téléphone, ligne de tableau sur ordinateur) contenant le texte. */
const row = (page: Page, text: string) =>
  page.locator('li, tr').filter({ hasText: text }).filter({ visible: true }).first();

async function logout(page: Page): Promise<void> {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
}

async function newEntry(
  page: Page,
  e: { label: string; date?: string; debit: string; credit: string; amount: number },
): Promise<void> {
  await page.getByRole('button', { name: 'Nouvelle écriture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle écriture' });
  if (e.date) await dialog.getByLabel('Date', { exact: true }).fill(e.date);
  await dialog.getByLabel('Libellé').fill(e.label);
  await dialog.getByLabel('Compte (ligne 1)').selectOption(e.debit);
  await dialog.getByLabel('Débit (ligne 1)').fill(String(e.amount));
  await dialog.getByLabel('Compte (ligne 2)').selectOption(e.credit);
  await dialog.getByLabel('Crédit (ligne 2)').fill(String(e.amount));
  await expect(dialog.getByText(/Écriture équilibrée/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Enregistrer l’écriture' }).click();
}

test('comptabilité : scolarité, saisie, contre-passation, dépense validée, états et clôture', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  // Chaque projet travaille sur ses propres pièces et son propre exercice passé.
  const tag = isMobile(info) ? 'TEL' : 'ORDI';
  const pastYear = isMobile(info) ? '2023' : '2021';

  await loginStaff(page, 'compta@demo.cm');
  await navigate(page, info, 'Comptabilité');
  await expect(page.getByRole('heading', { name: 'Comptabilité', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Synchroniser la scolarité' }).click();
  await expect(
    page.getByText(/écritures? passées? depuis la scolarité|Comptabilité à jour avec la scolarité/),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('Caisse', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Écritures automatiques de la scolarité, puis saisie manuelle et contre-passation.
  await navigate(page, info, 'Écritures');
  await expect(page.getByText('Scolarité', { exact: true }).first()).toBeVisible();
  await newEntry(page, {
    label: `Apport du promoteur ${tag}`,
    debit: '521',
    credit: '101',
    amount: 150000,
  });
  await expect(page.getByText(/Écriture OD-\d{4}-\d{6} enregistrée/)).toBeVisible();
  await row(page, `Apport du promoteur ${tag}`)
    .getByRole('button', { name: 'Contre-passer' })
    .click();
  const reverse = page.getByRole('dialog', { name: /^Contre-passer OD-/ });
  await reverse.getByLabel('Motif de la correction').fill('Apport saisi deux fois');
  await reverse.getByRole('button', { name: 'Enregistrer la contre-passation' }).click();
  await expect(page.getByText(/Contre-passation OD-\d{4}-\d{6} enregistrée/)).toBeVisible();
  await expect(
    page
      .locator('li')
      .filter({ hasText: `Apport du promoteur ${tag}` })
      .filter({ hasText: 'Contre-passée' }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Dépense au-delà du seuil : l'auteur ne peut pas la valider lui-même.
  await navigate(page, info, 'Dépenses');
  await page.getByRole('button', { name: 'Nouvelle dépense' }).click();
  const form = page.getByRole('dialog', { name: 'Nouvelle dépense' });
  await form.getByLabel('Fournisseur').fill('ENEO');
  await form.getByLabel('Objet').fill(`Électricité ${tag}`);
  await form.getByLabel('Montant (FCFA)').fill('150000');
  await form.getByLabel('Compte de charge').selectOption('6052');
  await form.getByLabel('Mode de règlement').selectOption('BANK');
  await form.getByLabel('Pièce de référence').fill(`ENEO-${tag}`);
  await form.getByRole('button', { name: 'Enregistrer la dépense' }).click();
  await expect(page.getByText(/en attente de validation par une autre personne/)).toBeVisible();
  await expect(row(page, `Électricité ${tag}`).getByText('À valider')).toBeVisible();
  await expect(
    row(page, `Électricité ${tag}`).getByRole('button', { name: 'Valider' }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await logout(page);
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/comptabilite/depenses');
  await row(page, `Électricité ${tag}`).getByRole('button', { name: 'Valider' }).click();
  await expect(page.getByText(/Dépense validée · écritures AC-\d{4}-\d{6}, BQ-/)).toBeVisible();
  await expect(row(page, `Électricité ${tag}`).getByText('Comptabilisée')).toBeVisible();

  // Annulation de la dépense : motif, contre-passation de ses écritures, statut « Annulée ».
  await row(page, `Électricité ${tag}`)
    .getByRole('button', { name: /^Annuler/ })
    .click();
  const cancel = page.getByRole('dialog', { name: 'Annuler cette dépense ?' });
  await cancel.getByLabel('Motif de l’annulation').fill('Facture saisie en double');
  await cancel.getByRole('button', { name: 'Annuler la dépense' }).click();
  await expect(
    page.getByText(/Dépense annulée · contre-passations AC-\d{4}-\d{6}, BQ-/),
  ).toBeVisible();
  await expect(row(page, `Électricité ${tag}`).getByText('Annulée', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Sortie de caisse au-delà du seuil saisie par la comptabilité : la direction la valide.
  await logout(page);
  await loginStaff(page, 'compta@demo.cm');
  await page.goto('/comptabilite/ecritures');
  await newEntry(page, {
    label: `Avance de caisse ${tag}`,
    debit: '658',
    credit: '571',
    amount: 120000,
  });
  await expect(page.getByText(/au-delà du seuil : en attente de validation/)).toBeVisible();
  const pendingEntry = page
    .getByRole('list', { name: 'Écritures à valider' })
    .getByRole('listitem')
    .filter({ hasText: `Avance de caisse ${tag}` });
  await expect(pendingEntry).toBeVisible();
  await expect(pendingEntry.getByRole('button', { name: /^Valider/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await logout(page);
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/comptabilite/ecritures');
  await pendingEntry.getByRole('button', { name: /^Valider/ }).click();
  await expect(page.getByText(/Écriture CA-\d{4}-\d{6} validée et enregistrée/)).toBeVisible();
  await expect(pendingEntry).toHaveCount(0);

  // États financiers et export Excel.
  await navigate(page, info, 'États financiers');
  await expect(page.getByRole('heading', { name: 'Balance générale' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByLabel('État').selectOption('bilan');
  await expect(page.getByText('Bilan équilibré')).toBeVisible();
  await page.getByLabel('État').selectOption('compte-de-resultat');
  await expect(page.getByText('Total des produits')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Excel' }).click();
  expect((await download).suggestedFilename()).toMatch(/^compte-de-resultat-.*\.xlsx$/);
  await expectNoHorizontalOverflow(page);

  // Exercice passé : ouverture, écriture, clôture, puis plus aucune écriture sur la période.
  await navigate(page, info, 'Comptabilité');
  await page.getByRole('button', { name: 'Ouvrir un exercice' }).click();
  const open = page.getByRole('dialog', { name: 'Ouvrir un exercice' });
  await open.getByLabel('Début').fill(`${pastYear}-01-01`);
  await open.getByLabel('Fin').fill(`${pastYear}-12-31`);
  await open.getByRole('button', { name: 'Ouvrir l’exercice' }).click();
  await expect(page.getByText(`Exercice ${pastYear} ouvert`)).toBeVisible();

  await page.goto('/comptabilite/ecritures');
  await newEntry(page, {
    label: `Capital initial ${tag}`,
    date: `${pastYear}-06-01`,
    debit: '571',
    credit: '101',
    amount: 80000,
  });
  await expect(page.getByText(`Écriture OD-${pastYear}-000001 enregistrée`)).toBeVisible();

  await page.goto('/comptabilite');
  await row(page, `Exercice ${pastYear}`).getByRole('button', { name: 'Clôturer' }).click();
  await page
    .getByRole('dialog', { name: `Clôturer Exercice ${pastYear} ?` })
    .getByRole('button', { name: 'Clôturer définitivement' })
    .click();
  await expect(
    page.getByText(
      `Exercice ${pastYear} clôturé · report à nouveau AN-${Number(pastYear) + 1}-000001`,
    ),
  ).toBeVisible();
  await expect(row(page, `Exercice ${pastYear}`).getByText('Clôturé')).toBeVisible();

  await page.goto('/comptabilite/ecritures');
  await newEntry(page, {
    label: `Écriture tardive ${tag}`,
    date: `${pastYear}-12-15`,
    debit: '571',
    credit: '101',
    amount: 1000,
  });
  await expect(page.getByText(/Exercice clôturé/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
