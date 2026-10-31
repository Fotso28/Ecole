import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff, navigate } from './helpers';

async function switchUser(page: Page, email: string) {
  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, email);
}

test.describe('documents administratifs', () => {
  test('délivre un certificat, le vérifie publiquement puis la direction l’annule', async ({
    page,
  }, info) => {
    await loginStaff(page, 'secretariat@demo.cm');
    await navigate(page, info, 'Documents administratifs');
    await expect(page.getByRole('heading', { name: 'Documents administratifs' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Délivrer un document' }).click();
    const dialog = page.getByRole('dialog', { name: 'Délivrer un document' });
    await dialog.getByLabel('Élève', { exact: true }).fill('Ngono');
    await dialog.getByRole('button', { name: /Ngono Marie-Claire/ }).click();
    await dialog.getByLabel(/Certificat de scolarité/).check();
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Délivrer le document' }).click();
    const issued = dialog.getByRole('status');
    await expect(issued).toContainText(/Certificat de scolarité n° CS-2026-2027-\d{4}/);
    const number = /CS-2026-2027-\d{4}/.exec((await issued.textContent()) ?? '')?.[0] ?? '';
    const code =
      /Code de vérification\s*([A-Z0-9]{12})/.exec((await issued.textContent()) ?? '')?.[1] ?? '';
    expect(code).toHaveLength(12);

    const pdf = page.waitForResponse(
      (r) => /\/api\/documents\/[^/]+\/pdf$/.test(r.url()) && r.status() === 200,
    );
    const popup = page.waitForEvent('popup');
    await dialog.getByRole('button', { name: 'Imprimer le PDF' }).click();
    expect((await pdf).headers()['content-type']).toBe('application/pdf');
    await (await popup).close();
    await dialog.getByRole('button', { name: 'Terminer' }).click();

    await page.getByPlaceholder('Numéro, nom ou matricule').fill(number);
    const row = isMobile(info)
      ? page.getByRole('list', { name: 'Registre des documents' }).getByRole('listitem')
      : page.getByRole('row').filter({ hasText: number });
    await expect(row.first()).toContainText(number);
    await expect(row.first()).toContainText('Valide');
    // Le secrétariat délivre mais n'annule pas.
    await expect(page.getByRole('button', { name: `Annuler le n° ${number}` })).toHaveCount(0);

    await page.goto(`/verifier/${code}`);
    await expect(
      page.getByRole('heading', { name: 'Certificat de scolarité authentique' }),
    ).toBeVisible();
    await expect(page.getByText(number)).toBeVisible();

    await switchUser(page, 'direction@demo.cm');
    await page.goto('/documents');
    await page.getByPlaceholder('Numéro, nom ou matricule').fill(number);
    await page.getByRole('button', { name: `Annuler le n° ${number}` }).click();
    const cancel = page.getByRole('dialog', { name: 'Annuler le document' });
    await cancel.getByLabel('Motif de l’annulation').fill('Erreur sur le nom du parent');
    await cancel.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    await expect(page.getByText(`Document n° ${number} annulé`)).toBeVisible();
    await expect(row.first()).toContainText('Annulé');

    await page.goto(`/verifier/${code}`);
    await expect(
      page.getByRole('heading', { name: 'Certificat de scolarité annulé(e)' }),
    ).toBeVisible();
  });

  test('la direction personnalise le modèle de la carte d’élève', async ({ page }, info) => {
    await loginStaff(page, 'direction@demo.cm');
    await navigate(page, info, 'Documents administratifs');
    await page.getByRole('link', { name: 'Modèles' }).click();
    await expect(page.getByRole('heading', { name: 'Modèles de documents' })).toBeVisible();
    const card = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Carte d’élève' }) });
    await card.getByLabel('Nom du signataire').fill('Alice Ngo Bassa');
    await card.getByRole('button', { name: 'Enregistrer le modèle' }).click();
    await expect(page.getByText('Modèle « Carte d’élève » enregistré')).toBeVisible();
    await expect(card.getByText('Personnalisé')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test('importe un classeur Excel à partir du modèle téléchargé', async ({ page }, info) => {
  await loginStaff(page, 'secretariat@demo.cm');
  await navigate(page, info, 'Élèves');
  await page.getByRole('link', { name: 'Importer' }).click();
  await expect(page.getByRole('heading', { name: 'Importer des élèves' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Modèle Excel' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('modele-import-eleves.xlsx');
  const buffer = readFileSync(await download.path());
  await page.locator('input[type="file"]').setInputFiles({
    name: 'eleves-rentree.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer,
  });
  await expect(page.getByText('eleves-rentree.xlsx')).toBeVisible();
  await page.getByRole('button', { name: 'Vérifier sans importer' }).click();
  await expect(page.getByText('1 ligne(s) valide(s) sur 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importer 1 élève' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('registre des incidents : saisie, filtres et statistiques', async ({ page }, info) => {
  const description = `Bagarre dans la cour (${info.project.name})`;
  await loginStaff(page, 'surveillant@demo.cm');
  await navigate(page, info, 'Registre des incidents');
  await expect(page.getByRole('heading', { name: 'Registre des incidents' })).toBeVisible();
  await page.getByRole('button', { name: 'Signaler un incident' }).click();
  const dialog = page.getByRole('dialog', { name: 'Signaler un incident' });
  await dialog.getByLabel('Élève', { exact: true }).fill('Ngono');
  await dialog.getByRole('button', { name: /Ngono Marie-Claire/ }).click();
  await dialog.getByLabel('Type d’incident').selectOption({ label: 'Violence' });
  await dialog.getByLabel('Description').fill(description);
  await dialog.getByLabel('Sanction', { exact: true }).selectOption({ label: 'Blâme' });
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('button', { name: 'Enregistrer l’incident' }).click();
  await expect(page.getByText('Incident enregistré au registre')).toBeVisible();
  await expect(page.getByText(description).filter({ visible: true })).toBeVisible();

  // Le formulaire rouvert repart de zéro ; une date future est refusée.
  await page.getByRole('button', { name: 'Signaler un incident' }).click();
  await expect(dialog.getByLabel('Élève', { exact: true })).toHaveValue('');
  await expect(dialog.getByRole('button', { name: /Ngono Marie-Claire/ })).toHaveCount(0);
  const tomorrow = new Date(Date.now() + 25 * 3600_000).toISOString().slice(0, 10);
  await dialog.getByLabel('Date', { exact: true }).fill(tomorrow);
  await expect(dialog.getByText('La date ne peut pas être dans le futur')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Enregistrer l’incident' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // Statistiques : des élèves sanctionnés, les récidives sous leur propre titre.
  await expect(page.getByText('Élèves sanctionnés')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Élèves signalés plusieurs fois' })).toBeVisible();

  // Correction par le déclarant.
  const row = page.locator('li, tr').filter({ hasText: description }).filter({ visible: true });
  await row.getByRole('button', { name: /^Corriger/ }).click();
  const edit = page.getByRole('dialog', { name: 'Corriger l’incident' });
  await expect(edit.getByLabel('Description')).toHaveValue(description);
  await expect(edit.getByText('Ngono Marie-Claire')).toBeVisible();
  await edit.getByLabel('Sanction', { exact: true }).selectOption({ label: 'Avertissement' });
  await edit.getByRole('button', { name: 'Enregistrer la correction' }).click();
  await expect(page.getByText('Incident corrigé')).toBeVisible();
  await expect(row).toContainText('Avertissement');

  const filter = (label: string) =>
    page.getByLabel(label, { exact: true }).filter({ visible: true });
  // Filtre « Toutes les sanctions » lisible en entier sur téléphone (toute la largeur).
  if (isMobile(info))
    expect((await filter('Sanction').boundingBox())?.width ?? 0).toBeGreaterThan(250);
  await filter('Type').selectOption({ label: 'Violence' });
  await filter('Classe').selectOption({ label: '4e A' });
  await expect(page.getByText(description).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Par type' })).toBeVisible();
  await filter('Sanction').selectOption({ label: 'Exclusion définitive' });
  await expect(page.getByText('Aucun incident sur ces critères')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Suppression après confirmation.
  await filter('Sanction').selectOption({ label: 'Toutes les sanctions' });
  await row.getByRole('button', { name: /^Supprimer/ }).click();
  const confirm = page.getByRole('dialog', { name: 'Supprimer l’incident ?' });
  await expect(confirm).toContainText(description);
  await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.getByText('Incident supprimé du registre')).toBeVisible();
  await expect(page.getByText(description).filter({ visible: true })).toHaveCount(0);

  // Le secrétariat n'a pas accès au registre.
  await switchUser(page, 'secretariat@demo.cm');
  await page.goto('/incidents');
  await expect(page.getByText('Permission insuffisante').first()).toBeVisible();
});

test('assistant de rentrée : nouvelle année, structure reprise, réinscriptions', async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const className = isMobile(info) ? '5e A' : '3e B';
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Assistant de rentrée');
  await expect(page.getByRole('heading', { name: 'Assistant de rentrée' })).toBeVisible();
  await expect(page.getByLabel('Année qui se termine')).toHaveValue(/.+/);
  const create = page.getByRole('button', { name: 'Créer l’année 2027-2028' });
  const newYear = page.getByLabel('Nouvelle année');
  await expect(
    create.or(page.getByRole('heading', { name: '2. Structure de la nouvelle année' })),
  ).toBeVisible();
  if (await create.isVisible()) {
    await create.click();
    await expect(page.getByText('Année 2027-2028 créée')).toBeVisible();
  }
  await expect(newYear.locator('option:checked')).toHaveText('2027-2028');
  const copy = page.getByRole('button', { name: 'Copier la structure de 2026-2027' });
  const classes = page.getByRole('list', { name: 'Classes de 2027-2028' });
  await expect(copy.or(classes)).toBeVisible();
  if (await copy.isVisible()) {
    await copy.click();
    await expect(page.getByText(/Structure copiée : 8 classes/)).toBeVisible();
  }
  await expect(classes.getByText('Tle D')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page
    .getByRole('list', { name: 'Classes de départ' })
    .getByRole('button', { name: new RegExp(`^${className}`) })
    .click();
  const card = page.locator('section').filter({
    has: page.getByRole('heading', { name: `${className} · 2026-2027` }),
  });
  await expect(card.getByText(/À décider$/)).toBeVisible();
  const groups = card.getByRole('radiogroup');
  const count = await groups.count();
  expect(count).toBeGreaterThan(2);
  await groups.nth(0).getByRole('radio', { name: 'Redoublant' }).click();
  await groups.nth(1).getByRole('radio', { name: 'Sortant' }).click();
  await card.getByRole('button', { name: 'Marquer les autres admis' }).click();
  await expect(
    card.getByLabel('Classe d’arrivée des admis').locator('option:checked'),
  ).not.toHaveText('Choisir…');
  await expect(card.getByLabel('Classe des redoublants').locator('option:checked')).toHaveText(
    className,
  );
  await expectNoHorizontalOverflow(page);
  await card.getByRole('button', { name: `Valider ${count} décisions` }).click();
  await expect(card.getByText('Réinscriptions enregistrées')).toBeVisible();
  await expect(card.getByText(`${count - 2} admis · 1 redoublant · 1 sortant`)).toBeVisible();
  await expect(card.getByText(/^Réinscrit en /).first()).toBeVisible();
});
