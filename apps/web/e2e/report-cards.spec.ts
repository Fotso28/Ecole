import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginStaff } from './helpers';

test('le censeur prépare les bulletins, la direction les publie', async ({ page }) => {
  await loginStaff(page, 'censeur@demo.cm');
  await page.goto('/bulletins');
  const cls = page.getByLabel('Classe');
  await cls.selectOption(
    (await cls.locator('option', { hasText: '4e A' }).getAttribute('value')) ?? '',
  );
  await page.getByRole('button', { name: 'Préparer les bulletins' }).click();
  await expect(page.getByText(/bulletins préparés en brouillon/)).toBeVisible();
  await expect(page.getByText(/Brouillon · v\d/).first()).toBeVisible();
  await expect(page.getByText('Ngono Marie-Claire')).toBeVisible();
  // Le censeur n'a pas le droit de publier.
  await expect(page.getByRole('button', { name: /^Publier/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/bulletins');
  await cls.selectOption(
    (await cls.locator('option', { hasText: '4e A' }).getAttribute('value')) ?? '',
  );
  await page.getByRole('button', { name: /^Publier \d+ bulletins/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Publier les bulletins ?' });
  await expect(dialog.getByText(/ne peut plus être modifié/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Publier', exact: true }).click();
  await expect(page.getByText(/bulletins publiés · parents prévenus par SMS/)).toBeVisible();
  await expect(page.getByText(/Publié · v\d/).first()).toBeVisible();
});

test('la vérification publique signale un code inconnu', async ({ page }) => {
  await page.goto('/verifier/CODEINCONNU1');
  await expect(page.getByRole('heading', { name: 'Code inconnu' })).toBeVisible();
});
