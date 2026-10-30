import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff } from './helpers';

const PAGES = [
  '/tableau-de-bord',
  '/eleves',
  '/eleves/nouveau',
  '/eleves/import',
  '/presences',
  '/presences/justificatifs',
  '/notes',
  '/bulletins',
  '/emploi-du-temps',
  '/caisse',
  '/impayes',
  '/caisse/journal',
  '/annonces',
  '/personnel',
  '/structure',
  '/parametres',
  '/compte',
];

test('chaque écran de la direction tient dans la largeur, avec la navigation adaptée', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await loginStaff(page, 'direction@demo.cm');
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expectNoHorizontalOverflow(page, path);
    if (isMobile(info)) {
      await expect(page.getByRole('navigation', { name: 'Navigation rapide' })).toBeVisible();
      await expect(page.getByRole('complementary')).toBeHidden();
    } else {
      await expect(page.getByRole('complementary')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Navigation rapide' })).toBeHidden();
    }
  }
});

test('les champs restent lisibles sans zoom sur téléphone (16 px)', async ({ page }, info) => {
  test.skip(!isMobile(info), 'propre au téléphone');
  await page.goto('/connexion');
  const size = await page
    .getByLabel('Adresse e-mail')
    .evaluate((el) => getComputedStyle(el).fontSize);
  expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
  const height = await page
    .getByRole('button', { name: 'Se connecter' })
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeGreaterThanOrEqual(44);
});
