import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { API_URL, E2E_DATABASE_URL } from '../playwright.config';

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

/** Code TOTP (RFC 6238, 6 chiffres, pas de 30 s) pour un secret en base 32. */
export function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, ''))
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const offset = (h[h.length - 1] ?? 0) & 0xf;
  const value = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}

/**
 * Super-administrateur de démonstration : sa double authentification (obligatoire) est
 * réinitialisée puis activée avec un secret connu du test. Renvoie le secret et un jeton d'API.
 */
export async function preparePlatformAdmin(
  request: APIRequestContext,
): Promise<{ secret: string; token: string }> {
  execSync(`psql "${E2E_DATABASE_URL}" -v ON_ERROR_STOP=1`, {
    input: `UPDATE "User" SET "mfaEnabled" = false, "mfaSecret" = NULL, "mfaLastStep" = NULL WHERE "email" = 'admin@ecole.cm';`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'admin@ecole.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const setup = await request.post(`${API_URL}/auth/mfa/setup`, { headers });
  const { secret } = (await setup.json()) as { secret: string };
  const enable = await request.post(`${API_URL}/auth/mfa/enable`, {
    headers,
    data: { code: totp(secret) },
  });
  expect(enable.ok()).toBe(true);
  return { secret, token: accessToken };
}

/** Connexion du super-administrateur dans le navigateur, code du pas TOTP suivant. */
export async function loginPlatformAdmin(page: Page, secret: string): Promise<void> {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill('admin@ecole.cm');
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByLabel('Code de vérification').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'Valider' }).click();
  await page.waitForURL('**/plateforme/facturation');
}

/** Ouvre un onglet du portail des parents, dans la barre du bas ou dans le menu « Plus ». */
export async function openPortalTab(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Navigation' });
  const direct = nav.getByRole('link', { name, exact: true });
  if (await direct.count()) {
    await direct.click();
    return;
  }
  await nav.getByRole('button', { name: /^Plus/ }).click();
  await page.getByRole('dialog', { name: 'Plus' }).getByRole('link', { name }).click();
}
