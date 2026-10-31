import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, isMobile, loginStaff, navigate, PASSWORD } from './helpers';

/** Jeton d'API du secrétariat de démonstration. */
async function secretariatHeaders(request: APIRequestContext) {
  const login = await request.post(`${API_URL}/auth/login`, {
    data: { email: 'secretariat@demo.cm', password: PASSWORD },
  });
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { Authorization: `Bearer ${accessToken}` };
}

/** Élève inscrit par l'API, avec un parent et un numéro propres au parcours. */
async function createStudent(
  request: APIRequestContext,
  student: { firstName: string; lastName: string; birthDate: string; className: string },
  guardian: { firstName: string; lastName: string; phone: string },
) {
  const headers = await secretariatHeaders(request);
  const classes = (await (
    await request.get(`${API_URL}/academic/classes`, { headers })
  ).json()) as {
    id: string;
    name: string;
  }[];
  const res = await request.post(`${API_URL}/students`, {
    headers,
    data: {
      firstName: student.firstName,
      lastName: student.lastName,
      gender: 'M',
      birthDate: student.birthDate,
      birthPlace: 'Yaoundé',
      classId: classes.find((c) => c.name === student.className)?.id,
      confirmNotDuplicate: true,
      guardians: [{ ...guardian, relationship: 'FATHER', isPrimary: true }],
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; matricule: string };
}

test('inscription : un numéro déjà connu demande de rattacher au parent ou de corriger', async ({
  page,
  request,
}, info) => {
  const suffix = isMobile(info) ? 'Mobile' : 'Bureau';
  const phone = isMobile(info) ? '699200101' : '699200102';
  await createStudent(
    request,
    {
      firstName: 'Brice',
      lastName: `Mvondo-${suffix}`,
      birthDate: '2014-02-03',
      className: '6e A',
    },
    { firstName: 'Luc', lastName: `Mvondo-${suffix}`, phone },
  );

  await loginStaff(page, 'secretariat@demo.cm');
  await navigate(page, info, 'Nouvelle inscription');
  await page.getByLabel('Nom', { exact: true }).fill(`Mvondo-${suffix}`);
  await page.getByLabel('Prénoms').fill('Jordan');
  await page.getByText('Garçon', { exact: true }).click();
  await page.getByLabel('Date de naissance').fill('2016-09-09');
  await page.getByRole('button', { name: /Continuer/ }).click();
  await expect(page.getByText('Étape 2 sur 4')).toBeVisible();

  // Un autre prénom avec le numéro de Luc : jamais de rattachement silencieux.
  await page.getByLabel('Nom', { exact: true }).fill(`Mvondo-${suffix}`);
  await page.getByLabel('Prénom', { exact: true }).fill('Jacques');
  await page.getByLabel('Adresse e-mail').fill('jacques.mvondo@');
  await page.getByLabel('Téléphone').fill(phone);
  await page.getByRole('button', { name: /Continuer/ }).click();
  // Message de validation en français, pas « Invalid email ».
  await expect(page.getByText('Adresse e-mail invalide')).toBeVisible();
  await expect(page.getByText('Invalid email')).toHaveCount(0);
  await page.getByLabel('Adresse e-mail').fill('');
  await page.getByRole('button', { name: /Continuer/ }).click();

  const alert = page.getByRole('alert').filter({ hasText: 'Ce numéro appartient déjà à' });
  await expect(alert).toContainText(`Luc Mvondo-${suffix} (parent de Brice)`);
  await expect(page.getByText('Étape 2 sur 4')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Corriger le numéro : le champ reprend la main.
  await alert.getByRole('button', { name: 'Corriger le numéro' }).click();
  await expect(page.getByLabel('Téléphone')).toBeFocused();
  await expect(alert).toHaveCount(0);

  // Le numéro était juste : rattachement explicite au parent existant.
  await page.getByRole('button', { name: /Continuer/ }).click();
  await alert.getByRole('button', { name: `Rattacher à Luc Mvondo-${suffix}` }).click();
  await expect(page.getByText('L’élève sera rattaché au parent déjà enregistré')).toBeVisible();
  await page.getByRole('button', { name: /Continuer/ }).click();
  await expect(page.getByText('Étape 3 sur 4')).toBeVisible();
  const classSelect = page.getByLabel('Classe pour l’année en cours');
  const value = await classSelect.locator('option', { hasText: '6e A' }).getAttribute('value');
  await classSelect.selectOption(value ?? '');
  await page.getByRole('button', { name: /Continuer/ }).click();
  await expect(page.getByText(`Luc Mvondo-${suffix}`)).toBeVisible();
  await page.getByRole('button', { name: 'Valider l’inscription' }).click();
  await expect(page.getByRole('heading', { name: `Mvondo-${suffix} Jordan` })).toBeVisible();
  await expect(page.getByText(`Luc Mvondo-${suffix} · père`)).toBeVisible();
});

test('fiche élève : corriger l’identité, changer de classe puis enregistrer un transfert', async ({
  page,
  request,
}, info) => {
  const suffix = isMobile(info) ? 'Mobile' : 'Bureau';
  const student = await createStudent(
    request,
    {
      firstName: 'Aurelie',
      lastName: `Mbala-${suffix}`,
      birthDate: '2012-04-05',
      className: '4e A',
    },
    {
      firstName: 'Rose',
      lastName: `Mbala-${suffix}`,
      phone: isMobile(info) ? '699200201' : '699200202',
    },
  );
  await loginStaff(page, 'secretariat@demo.cm');
  await page.goto(`/eleves/${student.id}`);
  await expect(page.getByRole('heading', { name: `Mbala-${suffix} Aurelie` })).toBeVisible();

  await page.getByRole('button', { name: 'Corriger l’identité' }).click();
  const identity = page.getByRole('dialog', { name: 'Corriger l’identité' });
  await identity.getByLabel('Nom', { exact: true }).fill(`Mballa-${suffix}`);
  await identity.getByLabel('Prénoms').fill('Aurélie Grâce');
  await identity.getByText('Fille', { exact: true }).click();
  await expectNoHorizontalOverflow(page);
  await identity.getByRole('button', { name: 'Enregistrer la correction' }).click();
  await expect(page.getByText('Identité corrigée')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: `Mballa-${suffix} Aurélie Grâce`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('Née le')).toBeVisible();

  await page.getByRole('button', { name: 'Changer de classe' }).click();
  const change = page.getByRole('dialog', { name: 'Changer de classe' });
  const select = change.getByLabel('Nouvelle classe');
  const value = await select.locator('option', { hasText: '4e B' }).getAttribute('value');
  await select.selectOption(value ?? '');
  await change.getByRole('button', { name: 'Changer de classe' }).click();
  await expect(page.getByText('Élève passé en 4e B')).toBeVisible();

  await page.getByRole('button', { name: 'Transfert ou sortie' }).click();
  const exit = page.getByRole('dialog', { name: 'Transfert ou sortie' });
  await exit.getByRole('button', { name: 'Enregistrer le transfert' }).click();
  await expect(exit.getByText('Indiquez l’établissement d’accueil')).toBeVisible();
  await exit.getByLabel('Établissement d’accueil').fill('Lycée classique de Garoua');
  await exit.getByLabel('Motif').fill('Mutation des parents');
  await expectNoHorizontalOverflow(page);
  await exit.getByRole('button', { name: 'Enregistrer le transfert' }).click();
  await expect(page.getByText('Transfert enregistré')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Transférée le' })).toContainText(
    'vers Lycée classique de Garoua · Motif : Mutation des parents',
  );
  await expect(page.getByRole('button', { name: 'Changer de classe' })).toHaveCount(0);

  // Le filtre « Transférés » de la liste se remplit.
  await page.goto('/eleves');
  await page.getByRole('button', { name: /Transférés/ }).click();
  await page.getByPlaceholder('Nom, matricule ou téléphone du parent').fill(`mballa-${suffix}`);
  await expect(page.getByRole('link', { name: new RegExp(`Mballa-${suffix}`) })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('recherche d’élève sans accents et « nom prénom » dans les deux ordres', async ({
  page,
}, info) => {
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Élèves');
  const search = page.getByPlaceholder('Nom, matricule ou téléphone du parent');
  await search.fill('ngono paul');
  await expect(page.getByRole('link', { name: /Ngono Paul-Henri/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ngono Marie-Claire/ })).toHaveCount(0);
  await search.fill('Marie-Claire NGONO');
  await expect(page.getByRole('link', { name: /Ngono Marie-Claire/ })).toBeVisible();
  await search.fill('cedric');
  await expect(page.getByRole('link', { name: /Cédric/ }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('structure : corriger le coefficient d’une matière de classe', async ({ page }) => {
  await loginStaff(page, 'censeur@demo.cm');
  await page.goto('/structure');
  await page.getByRole('button', { name: 'Modifier Anglais en 4e B' }).click();
  const sheet = page.getByRole('dialog', { name: 'Anglais · 4e B' });
  await sheet.getByLabel('Coefficient').fill('3');
  await expectNoHorizontalOverflow(page);
  await sheet.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Matière mise à jour')).toBeVisible();
  // Une matière déjà notée ne se retire pas : le refus est expliqué.
  await page.getByRole('button', { name: 'Modifier Mathématiques en 4e A' }).click();
  const maths = page.getByRole('dialog', { name: 'Mathématiques · 4e A' });
  page.once('dialog', (d) => void d.accept());
  await maths.getByRole('button', { name: 'Retirer de la classe' }).click();
  await expect(page.getByText(/Impossible de retirer Mathématiques \(4e A\)/)).toBeVisible();
});
