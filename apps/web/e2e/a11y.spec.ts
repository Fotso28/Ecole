import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  loginParent,
  loginPlatformAdmin,
  loginStaff,
  PASSWORD,
  preparePlatformAdmin,
} from './helpers';

/** Accessibilité automatisée (WCAG 2.1 A et AA) : aucune violation grave ou critique. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}) : ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(blocking, `violations d'accessibilité sur ${label}`).toEqual([]);
}

test('écrans publics', async ({ page }) => {
  for (const path of ['/connexion', '/parent/connexion']) {
    await page.goto(path);
    await expect(page.locator('h1').first()).toBeVisible();
    await expectAccessible(page, path);
  }
});

test('écrans de la direction', async ({ page }) => {
  test.setTimeout(180_000);
  await loginStaff(page, 'direction@demo.cm');
  for (const path of [
    '/tableau-de-bord',
    '/eleves',
    '/eleves/nouveau',
    '/presences',
    '/notes',
    '/bulletins',
    '/caisse',
    '/impayes',
    '/emploi-du-temps',
    '/parametres',
  ]) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expectAccessible(page, path);
  }
});

test('appel et notes de l’enseignant', async ({ page }) => {
  await loginStaff(page, 'prof.maths@demo.cm');
  await page.goto('/presences');
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  await expect(page.getByRole('button', { name: 'Marquer les autres présents' })).toBeVisible();
  await expectAccessible(page, '/presences (appel)');
  await page.goto('/notes');
  const select = page.getByLabel('Classe et matière');
  const value = await select
    .locator('option', { hasText: '4e A · Mathématiques' })
    .getAttribute('value');
  await select.selectOption(value ?? '');
  await expect(
    page
      .getByText(/Moyenne/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expectAccessible(page, '/notes (saisie)');
});

test('portail des parents', async ({ page, request }, info) => {
  // Un parent différent par projet, pour ne pas dépasser la limite de codes SMS par numéro.
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'direction@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const list = (await (
    await request.get(`${API_URL}/students?pageSize=50`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).json()) as { items: { class: { name: string } | null; guardian: { phone: string } | null }[] };
  const phones = list.items
    .filter(
      (s) => s.class?.name !== '4e A' && s.guardian && !s.guardian.phone.endsWith('677123456'),
    )
    .map((s) => s.guardian!.phone);
  await loginParent(page, phones[info.project.name === 'mobile' ? 0 : 1]!.replace('+237', ''));
  await expect(page.getByRole('heading', { name: /^Bonjour/ })).toBeVisible();
  await expectAccessible(page, '/portail');
  for (const path of ['/portail/paiement', '/portail/notes', '/portail/absences']) {
    await page.goto(path);
    await expect(page.locator('main').first()).toBeVisible();
    await expectAccessible(page, path);
  }
});

test('facturation de la plateforme', async ({ page, request }) => {
  const { secret } = await preparePlatformAdmin(request);
  await loginPlatformAdmin(page, secret);
  await expect(page.locator('main h1').first()).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation');
  await page.getByRole('button', { name: 'Nouvelle offre' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation (nouvelle offre)');
  await page.keyboard.press('Escape');
  await page
    .getByRole('link', { name: /Collège Démo/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Collège Démo' })).toBeVisible();
  await expectAccessible(page, '/plateforme/facturation/[id]');
});
