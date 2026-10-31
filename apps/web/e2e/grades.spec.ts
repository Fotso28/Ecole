import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, isMobile, loginStaff, PASSWORD } from './helpers';

test('saisie des notes : validation immédiate, enregistrement automatique, moyennes', async ({
  page,
}, info) => {
  const evalName = `Interro ${info.project.name}`;
  await loginStaff(page, 'prof.maths@demo.cm');
  await page.goto('/notes');
  const cs = page.getByLabel('Classe et matière');
  await cs.selectOption(
    (await cs.locator('option', { hasText: '4e A · Mathématiques' }).getAttribute('value')) ?? '',
  );
  // Séquence du 2e trimestre : les bulletins du 1er trimestre, publiés par un autre parcours,
  // verrouillent ses notes.
  const seq = page.getByLabel('Séquence');
  await seq.selectOption(
    (await seq.locator('option', { hasText: 'Séquence 3' }).getAttribute('value')) ?? '',
  );

  await page.getByRole('button', { name: 'Évaluation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle évaluation' });
  // L'intitulé par défaut suit le type choisi, tant qu'il n'a pas été personnalisé.
  await expect(dialog.getByLabel('Intitulé')).toHaveValue('Interrogation');
  await dialog.getByLabel('Type').selectOption({ label: 'Composition' });
  await expect(dialog.getByLabel('Intitulé')).toHaveValue('Composition');
  await dialog.getByLabel('Type').selectOption({ label: 'Interrogation' });
  await dialog.getByLabel('Intitulé').fill(evalName);
  await dialog.getByRole('button', { name: 'Créer l’évaluation' }).click();
  await expect(dialog).toBeHidden();
  await expectNoHorizontalOverflow(page);

  if (isMobile(info)) {
    await page.getByRole('tab', { name: new RegExp(evalName) }).click();
    const inputs = page.locator('ul input[inputmode="decimal"]');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(5);
    await inputs.first().fill('21');
    await expect(page.getByText('Entre 0 et 20, deux décimales au plus')).toBeVisible();
    await inputs.first().fill('16,5');
    for (let i = 1; i < count; i++) await inputs.nth(i).fill(String(8 + (i % 10)));
    await inputs.last().blur();
  } else {
    const header = page.getByRole('columnheader', { name: new RegExp(evalName) });
    await expect(header).toBeVisible();
    const col = await page
      .locator('thead th')
      .evaluateAll((ths, name) => ths.findIndex((t) => t.textContent?.includes(name)), evalName);
    const cells = page.locator(`tbody tr td:nth-child(${col + 1}) input`);
    const count = await cells.count();
    await cells.first().click();
    await page.keyboard.type('21');
    await expect(cells.first()).toHaveAttribute('aria-invalid', 'true');
    await cells.first().fill('16,5');
    await page.keyboard.press('Enter');
    // Entrée passe à l'élève suivant, comme dans un tableur.
    for (let i = 1; i < count; i++) {
      await expect(cells.nth(i)).toBeFocused();
      await page.keyboard.type(String(8 + (i % 10)));
      await page.keyboard.press('Enter');
    }
  }
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();

  // Après rechargement, les notes sont bien en base et les moyennes calculées.
  await page.reload();
  if (isMobile(info)) {
    await page.getByRole('tab', { name: new RegExp(evalName) }).click();
    await expect(page.locator('ul input[inputmode="decimal"]').first()).toHaveValue('16,5');
    await expect(page.getByText(/Moyenne \d+,\d{2}/).first()).toBeVisible();
  } else {
    await expect(page.locator('tbody tr').first().locator('input').last()).toHaveValue(/\d/);
    await expect(page.locator('tbody tr').first().locator('td[title]')).toHaveText(/^\d+,\d{2}$/);
  }
});

async function auth(request: APIRequestContext, email: string) {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } });
  return { Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
}

test('saisie verrouillée : l’enseignant voit pourquoi les notes sont figées', async ({
  page,
  request,
}) => {
  // Préparation par l'API (une seule fois) : grille de 3e B, séquence 2, soumise puis validée.
  const prof = await auth(request, 'prof.maths@demo.cm');
  const mine = (await (
    await request.get(`${API_URL}/grades/class-subjects`, { headers: prof })
  ).json()) as {
    classSubjects: { id: string; className: string; subjectName: string }[];
    sequences: { id: string; name: string }[];
  };
  const cs = mine.classSubjects.find(
    (c) => c.className === '3e B' && c.subjectName === 'Mathématiques',
  )!;
  const seq = mine.sequences.find((x) => x.name === 'Séquence 2')!;
  const query = `classSubjectId=${cs.id}&sequenceId=${seq.id}`;
  const sheet = (await (
    await request.get(`${API_URL}/grades/sheet?${query}`, { headers: prof })
  ).json()) as { status: string; evaluations: unknown[]; rows: { student: { id: string } }[] };
  if (sheet.status !== 'LOCKED') {
    if (sheet.evaluations.length === 0) {
      const ev = (await (
        await request.post(`${API_URL}/grades/evaluations`, {
          headers: prof,
          data: {
            classSubjectId: cs.id,
            sequenceId: seq.id,
            name: 'Interrogation',
            type: 'QUIZ',
            weight: 1,
          },
        })
      ).json()) as { id: string };
      const saved = await request.put(`${API_URL}/grades/evaluations/${ev.id}/grades`, {
        headers: prof,
        data: {
          grades: sheet.rows.map((r, i) => ({
            studentId: r.student.id,
            value: String(9 + (i % 8)),
          })),
        },
      });
      expect(saved.ok()).toBeTruthy();
    }
    const body = { classSubjectId: cs.id, sequenceId: seq.id };
    expect(
      (await request.post(`${API_URL}/grades/sheet/submit`, { headers: prof, data: body })).ok(),
    ).toBeTruthy();
    const censor = await auth(request, 'censeur@demo.cm');
    expect(
      (
        await request.post(`${API_URL}/grades/sheet/validate`, { headers: censor, data: body })
      ).ok(),
    ).toBeTruthy();
  }

  await loginStaff(page, 'prof.maths@demo.cm');
  await page.goto('/notes');
  const select = page.getByLabel('Classe et matière');
  await select.selectOption(
    (await select.locator('option', { hasText: '3e B · Mathématiques' }).getAttribute('value')) ??
      '',
  );
  const sequence = page.getByLabel('Séquence');
  await sequence.selectOption(
    (await sequence.locator('option', { hasText: 'Séquence 2' }).getAttribute('value')) ?? '',
  );
  await expect(page.getByRole('status').filter({ hasText: 'Notes validées' })).toHaveText(
    'Notes validées par le censeur : elles sont figées. Pour une correction, adressez-vous au censeur.',
  );
  await expect(page.getByText('Enregistrement automatique')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
