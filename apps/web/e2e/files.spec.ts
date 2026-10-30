import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, loginParent, loginStaff, navigate, PASSWORD } from './helpers';

// Image PNG valide de 1 × 1 pixel et en-tête JPEG : le type est vérifié sur le contenu.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.alloc(256, 9),
]);

const today = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const inDays = (n: number) =>
  new Date(Date.now() + 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

async function auth(request: APIRequestContext, email: string) {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } });
  return { Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
}

interface Listed {
  id: string;
  firstName: string;
  lastName: string;
  class: { id: string; name: string } | null;
  guardian: { phone: string } | null;
}

/** Élèves d'une classe (hors famille Ngono, utilisée par d'autres parcours). */
async function studentsOf(request: APIRequestContext, className: string): Promise<Listed[]> {
  const headers = await auth(request, 'direction@demo.cm');
  const classes = (await (
    await request.get(`${API_URL}/academic/classes`, { headers })
  ).json()) as { id: string; name: string }[];
  const classId = classes.find((c) => c.name === className)?.id ?? '';
  const res = await request.get(`${API_URL}/students?classId=${classId}&pageSize=100`, {
    headers,
  });
  const { items } = (await res.json()) as { items: Listed[] };
  return items.filter((s) => s.class?.name === className && s.lastName !== 'Ngono');
}

/** Ouvre le lien signé remis par l'API dans un nouvel onglet et vérifie le fichier servi. */
async function expectFileOpens(page: Page, open: () => Promise<void>, type: RegExp) {
  const popupPromise = page.waitForEvent('popup');
  await open();
  const popup = await popupPromise;
  await popup.waitForURL(/\/api\/files\//);
  const res = await page.request.get(popup.url());
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(type);
  await popup.close();
}

async function logout(page: Page) {
  await page.context().clearCookies();
}

test.describe('fichiers et pédagogie', () => {
  test('le secrétariat dépose une pièce photographiée, la consulte puis la remplace', async ({
    page,
    request,
  }, info) => {
    const list = await studentsOf(request, '3e B');
    const student = list[info.project.name === 'mobile' ? 0 : 1]!;
    await loginStaff(page, 'secretariat@demo.cm');
    await page.goto(`/eleves/${student.id}`);
    await expect(page.getByRole('heading', { name: 'Pièces du dossier' })).toBeVisible();

    await page.getByRole('button', { name: 'Déposer le fichier : Acte de naissance' }).click();
    const sheet = page.getByRole('dialog');
    if (info.project.name === 'mobile')
      await expect(sheet.getByText('Prendre une photo')).toBeVisible();
    await sheet
      .getByLabel('Choisir un fichier')
      .setInputFiles({ name: 'acte-naissance.png', mimeType: 'image/png', buffer: PNG });
    await expect(sheet.getByText('acte-naissance.png')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole('button', { name: 'Enregistrer la pièce' }).click();
    await expect(page.getByText('Pièce déposée')).toBeVisible();
    await expect(page.getByText(/acte-naissance\.png · \d+ o/)).toBeVisible();

    await expectFileOpens(
      page,
      () => page.getByRole('button', { name: 'Voir le fichier : Acte de naissance' }).click(),
      /image\/png/,
    );

    // Un fichier d'un autre type, même renommé, est refusé avant l'envoi.
    await page.getByRole('button', { name: 'Remplacer le fichier : Acte de naissance' }).click();
    await sheet.getByLabel('Choisir un fichier').setInputFiles({
      name: 'acte.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('<html>'),
    });
    await expect(
      sheet.getByText('Type de fichier refusé : PDF, JPEG ou PNG uniquement'),
    ).toBeVisible();
    await sheet
      .getByLabel('Choisir un fichier')
      .setInputFiles({ name: 'acte-scan.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await sheet.getByRole('button', { name: 'Enregistrer la pièce' }).click();
    await expect(page.getByText('Pièce remplacée')).toBeVisible();
    await expect(page.getByText(/acte-scan\.jpg/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('l’enseignant tient le cahier de texte, le censeur le consulte, le parent voit le devoir', async ({
    page,
    request,
  }, info) => {
    const mobile = info.project.name === 'mobile';
    const content = mobile
      ? 'Fractions : addition (téléphone)'
      : 'Fractions : produit (ordinateur)';
    const homework = mobile ? 'Exercices 1 et 2 page 40' : 'Exercices 7 et 8 page 42';
    const title = mobile ? 'Fiche fractions A' : 'Fiche fractions B';

    await loginStaff(page, 'prof.maths@demo.cm');
    await navigate(page, info, 'Cahier de texte');
    await expect(page.getByRole('heading', { name: 'Cahier de texte' })).toBeVisible();
    // Séance du jeu de démonstration.
    await expect(page.getByText(/Théorème de Pythagore/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Nouvelle séance' }).click();
    const sheet = page.getByRole('dialog');
    const cs = sheet.getByLabel('Classe et matière');
    const value = await cs
      .locator('option', { hasText: '4e A · Mathématiques' })
      .getAttribute('value');
    await cs.selectOption(value ?? '');
    await sheet.getByLabel('Contenu de la séance').fill(content);
    await sheet.getByLabel('Travail à faire').fill(homework);
    await sheet.getByRole('button', { name: 'Enregistrer la séance' }).click();
    await expect(sheet.getByText('Indiquez pour quand le travail est à faire')).toBeVisible();
    await sheet.getByLabel('Pour le').fill(inDays(1));
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole('button', { name: 'Enregistrer la séance' }).click();
    await expect(page.getByText('Séance enregistrée')).toBeVisible();

    const card = page.locator('li').filter({ hasText: content });
    await expect(card.getByText(homework)).toBeVisible();
    await card.getByRole('button', { name: 'Joindre un support' }).click();
    await sheet.getByLabel('Titre').fill(title);
    await sheet
      .getByLabel('Choisir un fichier')
      .setInputFiles({ name: 'fiche.png', mimeType: 'image/png', buffer: PNG });
    await sheet.getByRole('button', { name: 'Partager le support' }).click();
    await expect(page.getByText('Support de cours ajouté')).toBeVisible();
    await expect(card.getByText(title)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Le censeur consulte, sans pouvoir saisir.
    await logout(page);
    await loginStaff(page, 'censeur@demo.cm');
    await navigate(page, info, 'Cahier de texte');
    await expect(page.getByText(content)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nouvelle séance' })).toHaveCount(0);
    await expectFileOpens(
      page,
      () =>
        page
          .locator('li')
          .filter({ hasText: content })
          .getByRole('button', { name: new RegExp(title) })
          .click(),
      /image\/png/,
    );
    await expectNoHorizontalOverflow(page);

    // Le parent d'un élève de 4e A voit le devoir et le support.
    await logout(page);
    const list = await studentsOf(request, '4e A');
    const child = list[list.length - (mobile ? 1 : 2)]!;
    await loginParent(page, child.guardian!.phone.replace('+237', ''));
    await page
      .getByRole('navigation', { name: 'Navigation' })
      .getByRole('link', { name: 'Devoirs' })
      .click();
    await expect(page.getByRole('heading', { name: 'Devoirs à faire' })).toBeVisible();
    await expect(page.getByText(homework)).toBeVisible();
    await expect(page.getByText('Exercices 3 à 6 page 112.')).toBeVisible();
    await expectFileOpens(
      page,
      () =>
        page
          .getByRole('button', { name: new RegExp(title) })
          .first()
          .click(),
      /image\/png/,
    );
    await expectNoHorizontalOverflow(page);
  });

  test('le parent joint une photo au justificatif, la vie scolaire la consulte', async ({
    page,
    request,
  }, info) => {
    const mobile = info.project.name === 'mobile';
    const teacher = await auth(request, 'prof.maths@demo.cm');
    const list = await studentsOf(request, '4e A');
    const absent = list[list.length - (mobile ? 3 : 4)]!;
    const startTime = mobile ? '17:00' : '18:00';
    const roster = (await (
      await request.get(
        `${API_URL}/attendance/roster?classId=${absent.class!.id}&date=${today()}&startTime=${startTime}`,
        { headers: teacher },
      )
    ).json()) as { students: { id: string }[] };
    const submitted = await request.post(`${API_URL}/attendance/sessions`, {
      headers: teacher,
      data: {
        classId: absent.class!.id,
        date: today(),
        startTime,
        endTime: mobile ? '17:55' : '18:55',
        records: roster.students.map((s) => ({
          studentId: s.id,
          status: s.id === absent.id ? 'ABSENT' : 'PRESENT',
        })),
      },
    });
    expect(submitted.ok()).toBeTruthy();

    await loginParent(page, absent.guardian!.phone.replace('+237', ''));
    await page.getByRole('link', { name: 'Justifier' }).click();
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Motif').fill('Fièvre, certificat médical joint');
    await page
      .getByLabel('Choisir un fichier')
      .setInputFiles({ name: 'certificat.jpg', mimeType: 'image/jpeg', buffer: JPEG });
    await expect(page.getByText('certificat.jpg')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Envoyer le justificatif' }).click();
    await expect(page.getByText('Justificatif envoyé à la vie scolaire')).toBeVisible();
    await expect(page.getByText('En examen').first()).toBeVisible();

    await logout(page);
    await loginStaff(page, 'surveillant@demo.cm');
    await navigate(page, info, 'Justificatifs');
    await expectFileOpens(
      page,
      () =>
        page
          .getByRole('button', { name: new RegExp(`Voir la pièce jointe de ${absent.firstName}`) })
          .click(),
      /image\/jpeg/,
    );
    await expectNoHorizontalOverflow(page);
  });
});
