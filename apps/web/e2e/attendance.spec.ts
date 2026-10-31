import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, loginParent, loginStaff, navigate, PASSWORD } from './helpers';

test('un enseignant fait l’appel depuis sa journée', async ({ page }, info) => {
  const start = info.project.name === 'mobile' ? '10:30' : '13:00';
  const end = info.project.name === 'mobile' ? '11:25' : '13:55';
  await loginStaff(page, 'prof.maths@demo.cm');
  await navigate(page, info, 'Appel');
  await expect(page.getByRole('heading', { name: 'Appel' })).toBeVisible();
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  await page.getByLabel('Début').fill(start);
  await page.getByLabel('Fin').fill(end);
  await expect(page.getByRole('button', { name: 'Marquer les autres présents' })).toBeVisible();
  // Le délai annoncé correspond au comportement réel (fin du cours, ou appel fait plus tard).
  await expect(
    page.getByText(
      'Les parents des absents non justifiés reçoivent un SMS une heure après la fin du cours, ou après l’enregistrement de l’appel s’il est fait plus tard.',
      { exact: false },
    ),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const submit = page.getByRole('button', {
    name: /élèves? à marquer|Valider l’appel|Mettre à jour l’appel/,
  });
  await expect(submit).toBeDisabled();
  const first = page.getByRole('radiogroup').first();
  const name = (await first.getAttribute('aria-label'))?.replace('Présence de ', '') ?? '';
  await first.getByRole('radio', { name: 'Absent' }).click();
  await page.getByRole('button', { name: 'Marquer les autres présents' }).click();
  await expect(page.getByRole('button', { name: 'Valider l’appel' })).toBeEnabled();
  await page.getByRole('button', { name: 'Valider l’appel' }).click();
  await expect(page.getByText(/Appel enregistré · 1 parent sera prévenu par SMS/)).toBeVisible();

  // L'appel enregistré est rechargé, et reste corrigeable.
  await page.reload();
  await page.getByLabel('Classe').selectOption({ label: '4e A' });
  await page.getByLabel('Début').fill(start);
  await page.getByLabel('Fin').fill(end);
  const group = page.getByRole('radiogroup', { name: `Présence de ${name}` });
  await expect(group.getByRole('radio', { name: 'Absent' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Mettre à jour l’appel' })).toBeEnabled();
});

test('la vie scolaire saisit un justificatif papier, le refuse avec un motif ; le parent voit le refus', async ({
  page,
  request,
}, info) => {
  const mobile = info.project.name === 'mobile';
  const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
  const auth = async (email: string) => {
    const res = await request.post(`${API_URL}/auth/login`, {
      data: { email, password: PASSWORD },
    });
    return {
      Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`,
    };
  };
  // Préparation par l'API : le surveillant marque absent un élève de 6e A (un par projet).
  const headers = await auth('surveillant@demo.cm');
  const classes = (await (
    await request.get(`${API_URL}/academic/classes`, { headers })
  ).json()) as { id: string; name: string }[];
  const classId = classes.find((c) => c.name === '6e A')?.id ?? '';
  const startTime = mobile ? '07:30' : '08:25';
  const roster = (await (
    await request.get(
      `${API_URL}/attendance/roster?classId=${classId}&date=${today}&startTime=${startTime}`,
      { headers },
    )
  ).json()) as { students: { id: string; firstName: string; lastName: string }[] };
  const absent = roster.students.filter((s) => s.lastName !== 'Ngono')[mobile ? 0 : 1]!;
  const submitted = await request.post(`${API_URL}/attendance/sessions`, {
    headers,
    data: {
      classId,
      date: today,
      startTime,
      endTime: mobile ? '08:25' : '09:20',
      records: roster.students.map((s) => ({
        studentId: s.id,
        status: s.id === absent.id ? 'ABSENT' : 'PRESENT',
      })),
    },
  });
  expect(submitted.ok()).toBeTruthy();

  // Le parent apporte un mot à l'école : la vie scolaire le saisit.
  await loginStaff(page, 'surveillant@demo.cm');
  await navigate(page, info, 'Justificatifs');
  await page.getByRole('button', { name: 'Saisir un justificatif' }).click();
  const sheet = page.getByRole('dialog', { name: 'Saisir un justificatif' });
  await sheet.getByLabel('Élève').fill(absent.lastName);
  await sheet
    .getByRole('button', { name: new RegExp(`${absent.lastName} ${absent.firstName}`) })
    .click();
  await sheet.getByRole('checkbox', { name: new RegExp(`Absence du .*${startTime}`) }).check();
  await sheet.getByLabel('Motif').fill('Mot du père : fatigue');
  await expectNoHorizontalOverflow(page);
  await sheet.getByRole('button', { name: 'Enregistrer le justificatif' }).click();
  await expect(page.getByText(/Justificatif enregistré/)).toBeVisible();

  // Tableau de bord : compteur accordé, rafraîchi à chaque retour sur l'accueil.
  const home = mobile ? 'Accueil' : 'Tableau de bord';
  const todo = page.getByRole('link', { name: /\d+ justificatifs? d’absence à traiter/ });
  const dashboard = (await (await request.get(`${API_URL}/dashboard`, { headers })).json()) as {
    todo: { pendingJustifications: number };
  };
  const pending = dashboard.todo.pendingJustifications;
  expect(pending).toBeGreaterThan(0);
  await navigate(page, info, home);
  await expect(todo).toHaveText(
    pending === 1
      ? /1 justificatif d’absence à traiter/
      : new RegExp(`${pending} justificatifs d’absence à traiter`),
  );
  await navigate(page, info, 'Justificatifs');

  // Refus avec motif.
  const card = page
    .getByRole('listitem')
    .filter({ hasText: `${absent.lastName} ${absent.firstName}` })
    .filter({ hasText: 'Mot du père : fatigue' });
  await card.getByRole('button', { name: 'Refuser' }).click();
  const refuse = page.getByRole('dialog', { name: 'Refuser le justificatif' });
  const confirm = refuse.getByRole('button', { name: 'Refuser et prévenir le parent' });
  await expect(confirm).toBeDisabled();
  await refuse.getByLabel('Motif du refus').fill('Un certificat médical est demandé');
  await confirm.click();
  await expect(page.getByText('Justificatif refusé, parent prévenu')).toBeVisible();
  await navigate(page, info, home);
  if (pending === 1) await expect(todo).toHaveCount(0);
  else await expect(todo).toHaveText(new RegExp(`^\\s*${pending - 1} justificatifs? d’absence`));
  await navigate(page, info, 'Justificatifs');

  // L'onglet « Refusés » garde l'absence concernée et le motif.
  await page.getByRole('tab', { name: 'Refusés' }).click();
  const rejected = page
    .getByRole('listitem')
    .filter({ hasText: `${absent.lastName} ${absent.firstName}` })
    .filter({ hasText: 'Mot du père : fatigue' });
  await expect(rejected.getByText(new RegExp(`Absence du .*${startTime}`))).toBeVisible();
  await expect(rejected.getByText('Un certificat médical est demandé')).toBeVisible();

  // Le parent voit « Refusé » et le motif ; l'absence reste à justifier.
  const director = await auth('direction@demo.cm');
  const detail = (await (
    await request.get(`${API_URL}/students/${absent.id}`, { headers: director })
  ).json()) as { guardians: { phone: string }[] };
  await page.context().clearCookies();
  await loginParent(page, detail.guardians[0]!.phone.replace('+237', ''));
  await page.goto('/portail/absences');
  await expect(page.getByRole('heading', { name: 'À justifier' })).toBeVisible();
  await expect(page.getByText('Refusé', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Motif : Un certificat médical est demandé\. Vous pouvez en envoyer un autre/),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
