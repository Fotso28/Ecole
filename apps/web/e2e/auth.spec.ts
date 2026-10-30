import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff } from './helpers';

test.describe('connexion du personnel', () => {
  test('redirige vers la connexion sans session', async ({ page }) => {
    await page.goto('/eleves');
    await expect(page).toHaveURL(/\/connexion/);
    await expect(page.getByRole('heading', { name: 'Connexion du personnel' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('refuse un mauvais mot de passe avec un message clair', async ({ page }) => {
    await page.goto('/connexion');
    await page.getByLabel('Adresse e-mail').fill('direction@demo.cm');
    await page.getByLabel('Mot de passe').fill('mauvais');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByText('Adresse e-mail ou mot de passe incorrect')).toBeVisible();
  });

  test('la direction arrive sur le tableau de bord puis se déconnecte', async ({ page }, info) => {
    await loginStaff(page, 'direction@demo.cm');
    await expect(page).toHaveURL(/tableau-de-bord/);
    await expect(page.getByRole('heading', { name: 'Bonjour, Alice' })).toBeVisible();
    await expect(page.getByText('Effectif')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (isMobile(info)) {
      await expect(page.getByRole('navigation', { name: 'Navigation rapide' })).toBeVisible();
      await page.getByRole('button', { name: 'Menu' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Quitter' }).click();
    } else {
      await expect(page.getByRole('complementary')).toBeVisible();
      await page.getByRole('complementary').getByRole('button', { name: 'Quitter' }).click();
    }
    await expect(page).toHaveURL(/\/connexion/);
    // La session est bien révoquée : retour impossible sans se reconnecter.
    await page.goto('/tableau-de-bord');
    await expect(page).toHaveURL(/\/connexion/);
  });

  test('un enseignant arrive sur sa journée', async ({ page }) => {
    await loginStaff(page, 'prof.maths@demo.cm');
    await expect(page).toHaveURL(/enseignant/);
    await expect(page.getByRole('heading', { name: 'Mes classes' })).toBeVisible();
    await expect(page.getByText('4e A').first()).toBeVisible();
  });
});
