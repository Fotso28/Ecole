import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  expectNoHorizontalOverflow,
  isMobile,
  loginParent,
  loginStaff,
  navigate,
  PASSWORD,
} from './helpers';

async function headers(request: APIRequestContext, email: string) {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } });
  const { accessToken } = (await res.json()) as { accessToken: string };
  return { Authorization: `Bearer ${accessToken}` };
}

async function switchUser(page: Page, email: string) {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, email);
}

async function selectByText(page: Page, label: string, text: RegExp | string) {
  const select = page.getByLabel(label);
  const value = await select.locator('option', { hasText: text }).first().getAttribute('value');
  await select.selectOption(value ?? '');
}

test('parcours complet d’une session d’examen', async ({ page, request }, info) => {
  test.setTimeout(300_000);
  // Une session par projet, à des dates différentes pour ne pas créer de conflit de classe.
  const name = `Examen blanc ${info.project.name}`;
  const day = isMobile(info) ? '2026-12-07' : '2026-12-14';

  // 1. Le censeur crée la session et planifie les épreuves.
  await loginStaff(page, 'censeur@demo.cm');
  await navigate(page, info, 'Examens');
  await expect(page.getByRole('heading', { name: 'Examens', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Nouvelle session' }).click();
  const create = page.getByRole('dialog', { name: 'Nouvelle session d’examen' });
  await create.getByLabel('Nom').fill(name);
  await create.getByLabel('Début').fill(day);
  await create.getByLabel('Fin').fill(day);
  await create.getByLabel('4e B').check();
  await create.getByRole('button', { name: 'Créer la session' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, 'session (calendrier)');

  const addPaper = async (subject: string, start: string) => {
    await page.getByRole('button', { name: 'Ajouter une épreuve' }).click();
    const dialog = page.getByRole('dialog', { name: 'Ajouter une épreuve' });
    await selectByText(page, 'Matière', subject);
    await dialog.getByLabel('Début').fill(start);
    await dialog.getByRole('button', { name: 'Ajouter', exact: true }).click();
    return dialog;
  };
  await addPaper('Mathématiques', '08:00');
  await expect(page.getByText('Épreuve ajoutée')).toBeVisible();
  // Conflit : la 4e B compose déjà les mathématiques de 8 h à 10 h.
  const clash = await addPaper('Français', '09:00');
  await expect(clash.getByRole('alert')).toContainText('la classe 4e B compose');
  await clash.getByLabel('Début').fill('10:30');
  await clash.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByText(/08:00–10:00 · Mathématiques/)).toBeVisible();
  await expect(page.getByText(/10:30–12:30 · Français/)).toBeVisible();

  // 2. Salles et répartition des candidats.
  await page.getByRole('tab', { name: 'Salles et places' }).click();
  for (const room of ['B12', 'B14']) {
    await page.getByRole('button', { name: 'Salle', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Ajouter une salle' });
    await selectByText(page, 'Salle existante (facultatif)', room);
    await dialog.getByLabel('Places en configuration d’examen (facultatif)').fill('6');
    await dialog.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByRole('button', { name: `Retirer la salle ${room}` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Répartir les candidats' }).click();
  await expect(page.getByText(/candidats placés/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salle B12' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Salle B14' })).toBeVisible();
  await expectNoHorizontalOverflow(page, 'session (salles)');
  // Ajustement à la main : échange avec la place 1 de la salle B14.
  await page
    .getByRole('button', { name: /^Déplacer/ })
    .filter({ visible: true })
    .first()
    .click();
  const move = page.getByRole('dialog', { name: /^Déplacer · / });
  await move.getByLabel('Salle').selectOption({ label: 'B14' });
  await move.getByLabel('Place n°').fill('1');
  await move.getByRole('button', { name: 'Déplacer' }).click();
  await expect(page.getByText('Places échangées')).toBeVisible();

  // 3. Surveillants : un choix manuel, puis la répartition automatique équilibrée.
  await page.getByRole('tab', { name: 'Surveillants' }).click();
  await selectByText(page, 'Ajouter un surveillant · Mathématiques, salle B12', 'Owona Jean');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).first().click();
  await expect(page.getByText('Surveillant ajouté')).toBeVisible();
  await page.getByRole('button', { name: 'Répartir les surveillants' }).click();
  await expect(page.getByText(/surveillances? attribuées?/)).toBeVisible();
  await expect(page.getByText('Sans surveillant')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Charge des enseignants' })).toBeVisible();
  await expectNoHorizontalOverflow(page, 'session (surveillants)');

  // Documents : convocations de la classe en PDF.
  await page.getByRole('tab', { name: 'Documents' }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: '4e B' }).click();
  await (await popup).waitForLoadState();
  await expectNoHorizontalOverflow(page, 'session (documents)');
  const sessionUrl = page.url();

  // 4. L'enseignant voit sa surveillance sur sa page du jour.
  await switchUser(page, 'prof.histoire@demo.cm');
  await page.goto('/enseignant');
  const card = page.locator('section', {
    has: page.getByRole('heading', { name: 'Mes surveillances d’examen' }),
  });
  await expect(card.getByText(/salle B12/).first()).toBeVisible();
  await expect(card.getByText(`Mathématiques · ${name}`).first()).toBeVisible();

  // 5. Saisie des notes par numéro d'anonymat.
  await switchUser(page, 'prof.maths@demo.cm');
  await navigate(page, info, 'Notes d’examen');
  await selectByText(page, 'Épreuve', new RegExp(`${name} · Mathématiques`));
  const copies = page.getByLabel(/^Copie /);
  await expect(copies.first()).toBeVisible();
  // Aucun nom d'élève sur la grille anonyme.
  const grid = page.locator('section', {
    has: page.getByRole('heading', { name: 'Grille anonyme' }),
  });
  await expect(grid).not.toContainText('4e B');
  const firstLabel =
    (await page
      .locator('label', { hasText: /^Copie / })
      .first()
      .textContent()) ?? '';
  const code = firstLabel.replace('Copie ', '').trim();
  const typo = `${code.slice(0, -1)}${code.endsWith('2') ? '3' : '2'}`;
  await page.getByLabel('Numéro d’anonymat').fill(typo);
  await page.getByLabel('Note', { exact: true }).fill('15');
  await page.getByRole('button', { name: 'Ajouter à la grille' }).click();
  await expect(page.getByText('Numéro invalide : vérifiez chaque caractère')).toBeVisible();
  await page.getByLabel('Numéro d’anonymat').fill(code.toLowerCase());
  await page.getByRole('button', { name: 'Ajouter à la grille' }).click();
  await expect(copies.first()).toHaveValue('15');
  const count = await copies.count();
  for (let i = 1; i < count; i++) await copies.nth(i).fill(i === 1 ? 'abs' : '12');
  await expectNoHorizontalOverflow(page, '/examens/copies');
  await page.getByRole('button', { name: /^Enregistrer \d+ note/ }).click();
  await expect(page.getByText(/note\(s\) enregistrée\(s\)/)).toBeVisible();

  // Le français est noté par son enseignante (par l'API pour abréger le parcours).
  const fr = await headers(request, 'prof.francais@demo.cm');
  const papers = (await (
    await request.get(`${API_URL}/exams/grading`, { headers: fr })
  ).json()) as {
    id: string;
    sessionName: string;
  }[];
  const frPaper = papers.find((p) => p.sessionName === name)!;
  const sheet = (await (
    await request.get(`${API_URL}/exams/papers/${frPaper.id}/scores`, { headers: fr })
  ).json()) as { rows: { code: string }[] };
  const saved = await request.put(`${API_URL}/exams/papers/${frPaper.id}/scores`, {
    headers: fr,
    data: { scores: sheet.rows.map((r) => ({ code: r.code, value: '11' })) },
  });
  expect(saved.ok()).toBe(true);

  // 6. Le censeur lève l'anonymat (journalisé) puis publie les résultats.
  await switchUser(page, 'censeur@demo.cm');
  await page.goto(sessionUrl);
  await page.getByRole('tab', { name: 'Résultats' }).click();
  await expect(page.getByText(/désignés par leur numéro d’anonymat/)).toBeVisible();
  await page.getByRole('button', { name: 'Lever l’anonymat' }).click();
  const reveal = page.getByRole('dialog', { name: 'Lever l’anonymat' });
  await reveal.getByLabel('Motif').fill('Contrôle avant publication');
  await reveal.getByRole('button', { name: 'Afficher la correspondance' }).click();
  await expect(reveal.locator('code').first()).toBeVisible();
  await reveal.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Publier les résultats' }).click();
  const publish = page.getByRole('dialog', { name: 'Publier les résultats ?' });
  await publish.getByRole('button', { name: 'Publier', exact: true }).click();
  await expect(page.getByText(/Résultats publiés · parents prévenus/)).toBeVisible();
  await expect(page.getByText('Résultats publiés', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/désignés par leur numéro d’anonymat/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page, 'session (résultats)');

  // 7. Le parent d'un élève de 4e B consulte les résultats dans le portail.
  const director = await headers(request, 'direction@demo.cm');
  const list = (await (
    await request.get(`${API_URL}/students?pageSize=100`, { headers: director })
  ).json()) as { items: { class: { name: string } | null; guardian: { phone: string } | null }[] };
  const phones = [
    ...new Set(
      list.items
        .filter((s) => s.class?.name === '4e B' && s.guardian)
        .map((s) => s.guardian!.phone),
    ),
  ];
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginParent(page, phones[isMobile(info) ? 0 : 1]!.replace('+237', ''));
  await page.goto('/portail/notes');
  const results = page.locator('section', {
    has: page.getByRole('heading', { name: 'Résultats d’examens' }),
  });
  await expect(results.getByText(name)).toBeVisible();
  await expect(results.getByText('Mathématiques').first()).toBeVisible();
  await expectNoHorizontalOverflow(page, '/portail/notes (examens)');
});
