import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  expectNoHorizontalOverflow,
  isMobile,
  loginParent,
  loginStaff,
  openPortalTab,
  PASSWORD,
} from './helpers';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Numéro d'un parent distinct par test et par projet : la limite de codes SMS par numéro n'est
 * jamais atteinte, et les autres parcours (4e A, a11y) gardent leurs parents.
 */
async function parentPhone(request: APIRequestContext, index: number): Promise<string> {
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'direction@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  const list = (await (
    await request.get(`${API_URL}/students?pageSize=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  ).json()) as { items: { class: { name: string } | null; guardian: { phone: string } | null }[] };
  const phones = [
    ...new Set(
      list.items
        .filter((s) => s.class?.name !== '4e A' && s.guardian)
        .map((s) => s.guardian!.phone)
        .filter((p) => !p.endsWith('677123456')),
    ),
  ];
  return phones[index]!.replace('+237', '');
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Élément invisible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Glisser à la souris (ordinateur) ou au doigt (téléphone, événements tactiles réels). */
async function dragTo(
  page: Page,
  mobile: boolean,
  handle: Locator,
  steps: { target: Locator; onHover?: () => Promise<void> }[],
) {
  const from = await center(handle);
  if (!mobile) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (const step of steps) {
      const to = await center(step.target);
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await step.onHover?.();
    }
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
    });
  await touch('touchStart', from.x, from.y);
  let at = from;
  for (const step of steps) {
    const to = await center(step.target);
    for (let i = 1; i <= 8; i++)
      await touch('touchMove', at.x + ((to.x - at.x) * i) / 8, at.y + ((to.y - at.y) * i) / 8);
    at = to;
    await step.onHover?.();
  }
  await touch('touchEnd', at.x, at.y);
  await cdp.detach();
}

test.describe('emploi du temps', () => {
  test('glisse un cours vers un autre créneau, signale les conflits, et le remet au clavier', async ({
    page,
  }, info) => {
    const mobile = isMobile(info);
    await loginStaff(page, 'direction@demo.cm');
    await page.goto('/emploi-du-temps');
    await page.getByLabel('Classe').selectOption({ label: '4e A' });

    const cell = (day: number, start: string) =>
      mobile
        ? page.locator(`li[data-drop-day="${day}"][data-drop-start="${start}"]`)
        : page.locator(`td[data-drop-day="${day}"][data-drop-start="${start}"]`);
    if (mobile) await page.getByRole('tab', { name: 'Lundi' }).click();
    const maths = cell(1, '09:20').locator('[data-lesson]', { hasText: 'Mathématiques' });
    await expect(maths).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Sur téléphone, on reste sur la journée affichée ; sur ordinateur, on change de jour.
    const conflictCell = mobile ? cell(1, '07:30') : cell(2, '07:30');
    const freeDay = mobile ? 1 : 4;
    // Sur téléphone, cible visible à l'écran (un toucher hors de la fenêtre est annulé).
    const freeStart = mobile ? '12:20' : '14:00';
    const freeCell = cell(freeDay, freeStart);
    const status = page.locator('[data-drag-status]');
    await dragTo(page, mobile, maths.locator('[data-drag-handle]'), [
      {
        target: conflictCell,
        onHover: async () => {
          await expect(status).toContainText('la classe a déjà cours');
          await expect(page.getByRole('status').filter({ hasText: 'Conflit' })).toHaveCount(1);
        },
      },
      {
        target: freeCell,
        onHover: async () => {
          await expect(status).toContainText('libre');
        },
      },
    ]);
    await expect(
      page.getByText(`Cours déplacé au ${mobile ? 'lundi' : 'jeudi'} à ${freeStart}`),
    ).toBeVisible();
    const moved = freeCell.locator('[data-lesson]', { hasText: 'Mathématiques' });
    await expect(moved).toContainText(mobile ? '12:20–13:15' : '14:00–14:55');

    // Alternative au clavier : bouton « Déplacer » et choix du créneau.
    await moved.getByRole('button', { name: /^Déplacer Mathématiques/ }).focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: /Déplacer Mathématiques/ });
    await sheet.getByLabel('Nouveau jour').selectOption({ label: 'Mardi' });
    await sheet.getByLabel('Nouvelle heure de début').selectOption('07:30');
    await expect(sheet.getByRole('status')).toContainText('la classe a déjà cours');
    await expect(sheet.getByRole('button', { name: 'Déplacer ici' })).toBeDisabled();
    await sheet.getByLabel('Nouveau jour').selectOption({ label: 'Lundi' });
    await sheet.getByLabel('Nouvelle heure de début').selectOption('09:20');
    await expect(sheet.getByRole('status')).toContainText('Créneau libre');
    await sheet.getByRole('button', { name: 'Déplacer ici' }).click();
    await expect(page.getByText('Cours déplacé au lundi à 09:20')).toBeVisible();
    if (mobile) await page.getByRole('tab', { name: 'Lundi' }).click();
    await expect(maths).toContainText('09:20–10:15');
  });
});

test.describe('portail des parents', () => {
  test('quatre onglets et « Plus » sur un écran de 360 px', async ({ page, request }, info) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await loginParent(page, await parentPhone(request, isMobile(info) ? 10 : 11));
    const nav = page.getByRole('navigation', { name: 'Navigation' });
    await expect(nav.getByRole('link')).toHaveCount(4);
    const plus = nav.getByRole('button', { name: /^Plus/ });
    await expect(plus).toBeVisible();
    for (const target of [...(await nav.getByRole('link').all()), plus]) {
      const box = await target.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page, 'portail (360 px)');
    await plus.click();
    const more = page.getByRole('dialog', { name: 'Plus' });
    await expect(more.getByRole('link')).toHaveText(['Absences', 'Devoirs', 'Agenda']);
    await more.getByRole('link', { name: 'Absences' }).click();
    await expect(page).toHaveURL(/\/portail\/absences$/);
    await expect(plus).toHaveAttribute('aria-current', 'page');
    await expectNoHorizontalOverflow(page, 'absences (360 px)');
  });
});

test.describe('listes volumineuses', () => {
  test('charge les élèves par pages', async ({ page }) => {
    await loginStaff(page, 'direction@demo.cm');
    await page.goto('/eleves');
    await expect(page.getByText(/^30 sur \d+ élèves$/)).toBeVisible();
    await page.getByRole('button', { name: 'Charger plus' }).click();
    await expect(page.getByText(/^60 sur \d+ élèves$/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto('/caisse/journal');
    await expect(page.getByRole('heading', { name: 'Journal des paiements' })).toBeVisible();
    await expect(page.getByText(/paiements affichés$|Aucun paiement sur la période/)).toBeVisible();
  });
});

test.describe('hors connexion', () => {
  test('le parent relit ses dernières pages, puis la déconnexion purge le cache', async ({
    page,
    context,
    request,
  }, info) => {
    await loginParent(page, await parentPhone(request, isMobile(info) ? 12 : 13));
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    // Page contrôlée par le service worker : les données consultées sont mises en cache.
    await page.reload();
    await expect(page.getByText('Reste à payer').first()).toBeVisible();
    await openPortalTab(page, 'Notes');
    await expect(page).toHaveURL(/\/portail\/notes$/);
    await page.waitForLoadState('networkidle');
    await openPortalTab(page, 'Accueil');
    await page.waitForLoadState('networkidle');

    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByText(/Hors connexion, données du \d{2}\/\d{2} à \d{2}:\d{2}/),
    ).toBeVisible();
    await expect(page.getByText('Reste à payer').first()).toBeVisible();
    await expectNoHorizontalOverflow(page, 'portail hors connexion');
    await openPortalTab(page, 'Notes');
    await expect(page).toHaveURL(/\/portail\/notes$/);
    await expect(page.getByText(/Hors connexion/)).toBeVisible();

    // Déconnexion hors connexion : plus aucune donnée en cache ni profil gardé.
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await expect
      .poll(() =>
        page
          .evaluate(async () => ({
            data: await caches.has('ecole-data'),
            profile: localStorage.getItem('ecole.offline.me'),
          }))
          // Navigation en cours vers l'écran de connexion : on réessaie.
          .catch(() => null),
      )
      .toEqual({ data: false, profile: null });

    // Au retour du réseau, la session est révoquée : retour à l'écran de connexion.
    await context.setOffline(false);
    await page.goto('/portail');
    await expect(page).toHaveURL(/\/parent\/connexion/);
  });

  test('l’enseignant relit « Ma journée » hors connexion, jamais l’authentification', async ({
    page,
    context,
  }) => {
    await loginStaff(page, 'prof.maths@demo.cm');
    await page.goto('/enseignant');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    const cached = await page.evaluate(async () => {
      const cache = await caches.open('ecole-data');
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached).toContain('/api/teacher/today');
    expect(cached.filter((p) => /\/(auth|health|payments?|finance)(\/|$)/.test(p))).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(/Hors connexion, données du/)).toBeVisible();
    await expect(page.locator('main h1').first()).toBeVisible();
    await context.setOffline(false);
  });
});

test.describe('photo de l’élève', () => {
  test('consentement daté, dépôt de la photo puis retrait', async ({ page }, info) => {
    await loginStaff(page, 'secretariat@demo.cm');
    // Un élève différent par projet : les deux parcours partagent la base.
    await page.goto('/eleves?q=Ngono');
    await page
      .getByRole('link', { name: isMobile(info) ? /Ngono Paul-Henri/ : /Ngono Marie-Claire/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Photo d’identité' })).toBeVisible();

    const consent = page.getByRole('button', { name: 'Enregistrer le consentement' });
    if (await consent.count()) await consent.click();
    await expect(page.getByText('Consentement des parents donné')).toBeVisible();
    await expect(page.getByText(/Enregistré le .* par /)).toBeVisible();

    await page.getByRole('button', { name: /(Déposer|Remplacer) la photo/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Photo d’identité' });
    await sheet
      .getByLabel('Choisir un fichier')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
    await sheet.getByRole('button', { name: 'Enregistrer la photo' }).click();
    await expect(page.getByText('Photo enregistrée')).toBeVisible();
    await expect(page.getByRole('img', { name: /^Photo de Ngono/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Retirer le consentement' }).click();
    await page
      .getByRole('dialog', { name: 'Retirer le consentement ?' })
      .getByRole('button', { name: 'Retirer et supprimer la photo' })
      .click();
    await expect(page.getByText('Pas de consentement à la photo')).toBeVisible();
    await expect(page.getByRole('img', { name: /^Photo de Ngono/ })).toHaveCount(0);
    await expect(page.getByText(/Retiré le .* par /)).toBeVisible();
  });
});
