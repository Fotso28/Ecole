import { expect, test, type APIRequestContext } from '@playwright/test';
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
  return {
    Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`,
  };
}

/**
 * Prépare par l'API des notes de mathématiques soumises au 3e trimestre (séquence 5) en 4e A,
 * une seule fois pour les deux projets.
 */
async function gradeThirdTerm(request: APIRequestContext) {
  const prof = await headers(request, 'prof.maths@demo.cm');
  const mine = (await (
    await request.get(`${API_URL}/grades/class-subjects`, { headers: prof })
  ).json()) as {
    classSubjects: { id: string; classId: string; className: string; subjectName: string }[];
    sequences: { id: string; name: string }[];
  };
  const cs = mine.classSubjects.find(
    (c) => c.className === '4e A' && c.subjectName === 'Mathématiques',
  )!;
  const seq5 = mine.sequences.find((s) => s.name === 'Séquence 5')!;
  const sheet = (await (
    await request.get(`${API_URL}/grades/sheet?classSubjectId=${cs.id}&sequenceId=${seq5.id}`, {
      headers: prof,
    })
  ).json()) as { status?: string; evaluations: unknown[]; rows: { student: { id: string } }[] };
  if (sheet.evaluations.length === 0) {
    const ev = (await (
      await request.post(`${API_URL}/grades/evaluations`, {
        headers: prof,
        data: {
          classSubjectId: cs.id,
          sequenceId: seq5.id,
          name: 'Composition',
          type: 'EXAM',
          weight: 1,
        },
      })
    ).json()) as { id: string };
    const saved = await request.put(`${API_URL}/grades/evaluations/${ev.id}/grades`, {
      headers: prof,
      data: {
        grades: sheet.rows.map((r, i) => ({ studentId: r.student.id, value: String(8 + (i % 9)) })),
      },
    });
    expect(saved.ok()).toBeTruthy();
    await request.post(`${API_URL}/grades/sheet/submit`, {
      headers: prof,
      data: { classSubjectId: cs.id, sequenceId: seq5.id },
    });
  }
  return { classId: cs.classId };
}

test('le censeur prépare le bulletin de fin d’année et saisit la décision du conseil', async ({
  page,
  request,
}) => {
  await gradeThirdTerm(request);
  await loginStaff(page, 'censeur@demo.cm');
  await page.goto('/bulletins');
  const cls = page.getByLabel('Classe');
  await cls.selectOption({ label: '4e A' });
  await page.getByLabel('Trimestre').selectOption({ label: '3e trimestre' });
  await expect(page.getByText('Bulletin de fin d’année.')).toBeVisible();
  await page.getByRole('button', { name: 'Préparer les bulletins' }).click();
  await expect(page.getByText(/bulletins préparés en brouillon/)).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: 'Ngono Marie-Claire' });
  await expect(row.getByText(/^Année \d+,\d\d/)).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await row.getByRole('button', { name: 'Décision' }).click();
  const dialog = page.getByRole('dialog', { name: /Décision du conseil/ });
  const yearEnd = dialog.getByLabel('Décision de fin d’année');
  await expect(dialog.getByText(/Moyenne annuelle \d+,\d\d · proposition/)).toBeVisible();
  await yearEnd.selectOption({ label: 'Admis en classe supérieure' });
  await dialog.getByLabel('Appréciation du conseil').fill('Très bonne année');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText(/Décision enregistrée/)).toBeVisible();
  // La décision apparaît tout de suite et les brouillons sont signalés comme à mettre à jour.
  await expect(row.getByText('Admis en classe supérieure')).toBeVisible();
  await expect(page.getByText('Brouillons à mettre à jour.')).toBeVisible();

  // Rouverte, la fiche reprend la décision enregistrée ; un autre élève a sa propre fiche.
  await row.getByRole('button', { name: 'Décision' }).click();
  await expect(yearEnd).toHaveValue('PROMOTED');
  await expect(dialog.getByLabel('Appréciation du conseil')).toHaveValue('Très bonne année');
  await expect(dialog.getByText(/décision déjà enregistrée/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  const other = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Décision' }) })
    .filter({ hasNotText: 'Ngono Marie-Claire' })
    .first();
  await other.getByRole('button', { name: 'Décision' }).click();
  await expect(dialog.getByLabel('Appréciation du conseil')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  await page.getByRole('button', { name: 'Préparer les bulletins' }).click();
  await expect(page.getByText(/bulletins préparés en brouillon/)).toBeVisible();
  await expect(page.getByText('Brouillons à mettre à jour.')).toBeHidden();
  await expect(row.getByText('Admis en classe supérieure')).toBeVisible();
});

test('la direction consulte et imprime le relevé de notes d’un élève', async ({ page }, info) => {
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Relevés de notes');
  await expect(page.getByRole('heading', { name: 'Relevés de notes', level: 1 })).toBeVisible();
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  await page.getByLabel('Élève', { exact: true }).selectOption({ label: 'Ngono Marie-Claire' });
  await page.getByLabel('Relevé', { exact: true }).selectOption({ label: 'Séquence' });
  await page.getByLabel('Période', { exact: true }).selectOption({ label: 'Séquence 1' });
  await expect(page.getByRole('heading', { name: 'Séquence 1 · 4e A' })).toBeVisible();
  // Mathématiques : (14 + 15 + 14 × 2) ÷ 4 = 14,25.
  if (isMobile(info)) {
    await expect(page.getByRole('listitem').filter({ hasText: 'Mathématiques' })).toContainText(
      '14,25',
    );
  } else {
    await expect(page.getByRole('row', { name: /Mathématiques/ })).toContainText('14,25');
  }
  await expectNoHorizontalOverflow(page);
  await page.getByLabel('Relevé', { exact: true }).selectOption({ label: 'Année' });
  await expect(page.getByRole('heading', { name: /Année scolaire .* · 4e A/ })).toBeVisible();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Relevé PDF' }).click();
  await (await popup).waitForLoadState();
  await expectNoHorizontalOverflow(page);
});

test('le tableau de bord affiche les taux de réussite et exporte les indicateurs', async ({
  page,
  request,
}, info) => {
  const { classId } = await gradeThirdTerm(request);
  const censor = await headers(request, 'censeur@demo.cm');
  const year = (await (await request.get(`${API_URL}/auth/me`, { headers: censor })).json()) as {
    activeSchool: { currentYear: { id: string } };
  };
  const terms = (await (
    await request.get(`${API_URL}/academic/years/${year.activeSchool.currentYear.id}/structure`, {
      headers: censor,
    })
  ).json()) as { terms: { id: string; name: string }[] };
  const t3 = terms.terms.find((t) => t.name === '3e trimestre')!;
  const gen = await request.post(`${API_URL}/report-cards/generate`, {
    headers: censor,
    data: { classId, termId: t3.id },
  });
  expect(gen.ok()).toBeTruthy();

  await loginStaff(page, 'direction@demo.cm');
  await page.goto('/tableau-de-bord');
  await expect(page.getByRole('heading', { name: 'Taux de réussite' })).toBeVisible();
  const line = isMobile(info)
    ? page
        .getByRole('listitem')
        .filter({ has: page.getByText('4e A', { exact: true }) })
        .filter({ hasText: 'trimestre' })
    : page.getByRole('row', { name: /4e A/ });
  await expect(line).toContainText(/\d+,\d %/);
  await expectNoHorizontalOverflow(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter Excel' }).click();
  expect((await download).suggestedFilename()).toMatch(/^indicateurs-.*\.xlsx$/);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Exporter PDF' }).click();
  await (await popup).waitForLoadState();
});

test('le parent télécharge le relevé de notes de son enfant', async ({ page, request }, info) => {
  // Un parent différent par projet, distinct de ceux des autres parcours (limite de codes SMS).
  const director = await headers(request, 'direction@demo.cm');
  const list = (await (
    await request.get(`${API_URL}/students?pageSize=100`, { headers: director })
  ).json()) as {
    items: {
      lastName: string;
      class: { name: string } | null;
      guardian: { phone: string } | null;
    }[];
  };
  const phones = [
    ...new Set(
      list.items
        .filter((s) => s.class?.name === '4e A' && s.lastName !== 'Ngono' && s.guardian)
        .map((s) => s.guardian!.phone),
    ),
  ];
  // Les autres parcours prennent les premiers élèves de la liste alphabétique : on part de la fin.
  await loginParent(page, phones[phones.length - (isMobile(info) ? 1 : 2)]!.replace('+237', ''));
  await page.goto('/portail/notes');
  await expect(page.getByRole('heading', { name: 'Relevés de notes' })).toBeVisible();
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Relevé · Séquence 1' }).click();
  await (await popup).waitForLoadState();
  await expectNoHorizontalOverflow(page);
});

test('la direction règle les propositions du conseil de classe', async ({ page }, info) => {
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Paramètres');
  const card = page.locator('#conseil');
  await expect(card.getByRole('heading', { name: 'Conseil de classe' })).toBeVisible();
  await expect(card.getByLabel('Moyenne annuelle de passage')).toHaveValue('10,00');
  // Seuils incohérents : refusés par l'API, rien n'est enregistré.
  await card.getByLabel('Encouragements à partir de').fill('11');
  await card.getByRole('button', { name: 'Enregistrer les règles du conseil' }).click();
  await expect(page.getByText(/Les seuils doivent croître|invalide/i)).toBeVisible();
  await card.getByLabel('Encouragements à partir de').fill('14');
  await card.getByLabel('Félicitations à partir de').fill('15,5');
  await card.getByRole('button', { name: 'Enregistrer les règles du conseil' }).click();
  await expect(page.getByText('Paramètres enregistrés')).toBeVisible();
  await page.reload();
  await expect(page.locator('#conseil').getByLabel('Félicitations à partir de')).toHaveValue(
    '15,50',
  );
  await expectNoHorizontalOverflow(page);
});
