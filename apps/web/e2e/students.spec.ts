import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginStaff, navigate } from './helpers';

test.describe('élèves et inscriptions', () => {
  test('inscrit un élève avec l’assistant, puis détecte un doublon', async ({ page }, info) => {
    const lastName = info.project.name === 'mobile' ? 'Essomba-Mobile' : 'Essomba-Bureau';
    const phone = info.project.name === 'mobile' ? '699100101' : '699100102';
    await loginStaff(page, 'secretariat@demo.cm');
    await navigate(page, info, 'Nouvelle inscription');
    await expect(page.getByText('Étape 1 sur 4')).toBeVisible();

    // Validation : rien n'avance sans les champs obligatoires.
    await page.getByRole('button', { name: /Continuer/ }).click();
    await expect(page.getByText('Choisissez le sexe')).toBeVisible();

    await page.getByLabel('Nom', { exact: true }).fill(lastName);
    await page.getByLabel('Prénoms').fill('Grâce');
    await page.getByText('Fille', { exact: true }).click();
    await page.getByLabel('Date de naissance').fill('2013-05-14');
    await page.getByLabel('Lieu de naissance').fill('Yaoundé');
    await page.getByRole('button', { name: /Continuer/ }).click();

    await expect(page.getByText('Étape 2 sur 4')).toBeVisible();
    await page.getByLabel('Nom', { exact: true }).fill(lastName);
    await page.getByLabel('Prénom', { exact: true }).fill('Luc');
    await page.getByLabel('Téléphone').fill('12');
    await page.getByRole('button', { name: /Continuer/ }).click();
    await expect(page.getByText('Numéro de téléphone camerounais invalide')).toBeVisible();
    await page.getByLabel('Téléphone').fill(phone);
    await page.getByRole('button', { name: /Continuer/ }).click();

    await expect(page.getByText('Étape 3 sur 4')).toBeVisible();
    const classSelect = page.getByLabel('Classe pour l’année en cours');
    const value = await classSelect.locator('option', { hasText: '4e B' }).getAttribute('value');
    await classSelect.selectOption(value ?? '');
    await page.getByRole('button', { name: /Continuer/ }).click();
    await expect(page.getByText('Étape 4 sur 4')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Valider l’inscription' }).click();

    await expect(page.getByRole('heading', { name: `${lastName} Grâce` })).toBeVisible();
    await expect(
      page.getByText(/Inscription enregistrée · matricule CD-\d{4}-\d{4}/),
    ).toBeVisible();
    await expect(page.getByText('185 000 FCFA').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Même enfant saisi une seconde fois : l'assistant propose le dossier existant.
    await page.goto('/eleves/nouveau');
    await page.getByLabel('Nom', { exact: true }).fill(lastName.toUpperCase());
    await page.getByLabel('Prénoms').fill('Grace');
    await page.getByText('Fille', { exact: true }).click();
    await page.getByLabel('Date de naissance').fill('2013-05-14');
    await page.getByRole('button', { name: /Continuer/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Ce dossier existe peut-être déjà' }),
    ).toBeVisible();
    await expect(page.getByText('Même date de naissance')).toBeVisible();
    await page.getByRole('link', { name: 'Ouvrir le dossier existant' }).click();
    await expect(page.getByRole('heading', { name: `${lastName} Grâce` })).toBeVisible();
  });

  test('recherche un élève par nom ou par téléphone du parent', async ({ page }, info) => {
    await loginStaff(page, 'direction@demo.cm');
    await navigate(page, info, 'Élèves');
    await expect(page.getByText(/élèves inscrits cette année/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByPlaceholder('Nom, matricule ou téléphone du parent').fill('6 77 12 34 56');
    await expect(page.getByRole('link', { name: /Ngono Marie-Claire/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Ngono Paul-Henri/ })).toBeVisible();
    await page.getByRole('link', { name: /Ngono Marie-Claire/ }).click();
    await expect(page.getByRole('heading', { name: 'Ngono Marie-Claire' })).toBeVisible();
    await expect(page.getByText('Pierre Ngono · père')).toBeVisible();
  });
});
