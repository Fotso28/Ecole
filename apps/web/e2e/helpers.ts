import { expect, type Page, type TestInfo } from '@playwright/test';
import { API_URL } from '../playwright.config';

export const PASSWORD = 'Ecole2026!demo';

export async function loginStaff(page: Page, email: string): Promise<void> {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/connexion'));
}

/** Connexion parent : le code est lu via l'outil de développement du fournisseur SMS en mémoire. */
export async function loginParent(page: Page, phone: string): Promise<void> {
  const lastSms = async () => {
    const res = await page.request.get(`${API_URL}/dev/sms/last?to=${encodeURIComponent(phone)}`);
    return res.ok() ? ((await res.json()) as { body: string; count: number }) : null;
  };
  const before = (await lastSms())?.count ?? 0;
  await page.goto('/parent/connexion');
  await page.getByLabel('Votre numéro de téléphone').fill(phone);
  await page.getByRole('button', { name: 'Recevoir un code par SMS' }).click();
  await expect(page.getByRole('heading', { name: 'Entrez le code reçu' })).toBeVisible();
  // Le SMS part en arrière-plan : on attend le nouveau message.
  let sms: { body: string; count: number } | null = null;
  await expect
    .poll(async () => {
      sms = await lastSms();
      return sms?.count ?? 0;
    })
    .toBeGreaterThan(before);
  const code = /(\d{6})/.exec((sms as { body: string } | null)?.body ?? '')?.[1] ?? '';
  await page.getByLabel('Code à 6 chiffres').fill(code);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.waitForURL('**/portail');
}

/** Mobile d'abord : aucune page ne doit défiler horizontalement. */
export async function expectNoHorizontalOverflow(page: Page, label = page.url()): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `débordement horizontal (px) sur ${label}`).toBeLessThanOrEqual(1);
}

export const isMobile = (info: TestInfo) => info.project.name === 'mobile';

/** Navigation principale : menu inférieur + tiroir sur téléphone, barre latérale sur ordinateur. */
export async function navigate(page: Page, info: TestInfo, label: string): Promise<void> {
  if (isMobile(info)) {
    const tab = page
      .getByRole('navigation', { name: 'Navigation rapide' })
      .getByRole('link', { name: label, exact: true });
    if (await tab.count()) {
      await tab.click();
      return;
    }
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: label, exact: true }).click();
    return;
  }
  await page.getByRole('complementary').getByRole('link', { name: label, exact: true }).click();
}
