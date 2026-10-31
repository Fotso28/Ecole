import { expect, test } from '@playwright/test';
import { API_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, loginParent, PASSWORD } from './helpers';

test.describe('portail parents', () => {
  test('le parent paie la scolarité par Mobile Money', async ({ page, context }) => {
    // Liste des enfants lente : jamais « Aucun enfant rattaché » pendant le chargement.
    await context.route('**/api/portal/children', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await loginParent(page, '677123456');
    await expect(
      page.getByRole('status').filter({ hasText: 'Chargement de vos enfants' }),
    ).toBeAttached();
    await expect(page.getByText('Aucun enfant rattaché à ce numéro')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Bonjour Pierre' })).toBeVisible();
    await expect(page.getByText('Aucun enfant rattaché à ce numéro')).toHaveCount(0);
    await context.unroute('**/api/portal/children');
    const switcher = page.getByRole('group', { name: 'Choisir un enfant' });
    await expect(switcher.getByRole('button')).toHaveCount(2);
    await switcher.getByRole('button', { name: /Marie-Claire/ }).click();
    await expect(page.getByText('Reste à payer')).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page
      .getByRole('navigation', { name: 'Navigation' })
      .getByRole('link', { name: 'Payer' })
      .click();
    await page.getByRole('button', { name: 'Orange Money' }).click();
    const pay = page.getByRole('button', { name: /^Payer \d/ });
    await expect(pay).toBeEnabled();
    await pay.click();
    await expect(page.getByRole('heading', { name: 'Validez sur votre téléphone' })).toBeVisible();
    await page.getByRole('button', { name: 'Démo : simuler la validation de l’opérateur' }).click();
    await expect(page.getByRole('heading', { name: 'Paiement reçu' })).toBeVisible();
    await expect(page.getByText(/R-\d{4}-\d{6}/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const receipt = /R-\d{4}-\d{6}/.exec(
      (await page.getByText(/R-\d{4}-\d{6}/).textContent()) ?? '',
    )?.[0];

    // Historique des paiements de l'enfant sur l'accueil, avec le reçu.
    await page
      .getByRole('navigation', { name: 'Navigation' })
      .getByRole('link', { name: 'Accueil' })
      .click();
    const history = page.getByRole('list', { name: 'Derniers paiements' });
    await expect(history.getByText(`reçu ${receipt}`, { exact: false })).toBeVisible();
    await expect(history.getByRole('button', { name: `Reçu ${receipt}` })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('le parent justifie une absence signalée par l’enseignant', async ({
    page,
    request,
  }, info) => {
    // Préparation par l'API : l'enseignant marque un élève absent, la direction donne le téléphone du parent.
    const token = async (email: string) => {
      const res = await request.post(`${API_URL}/auth/login`, {
        data: { email, password: PASSWORD },
      });
      return {
        Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}`,
      };
    };
    const teacher = await token('prof.maths@demo.cm');
    const director = await token('direction@demo.cm');
    const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
    const day = (await (
      await request.get(`${API_URL}/teacher/today`, { headers: teacher })
    ).json()) as { classSubjects: { classId: string; className: string }[] };
    const classId = day.classSubjects.find((c) => c.className === '4e A')?.classId ?? '';
    const startTime = info.project.name === 'mobile' ? '15:00' : '16:00';
    const roster = (await (
      await request.get(
        `${API_URL}/attendance/roster?classId=${classId}&date=${today}&startTime=${startTime}`,
        { headers: teacher },
      )
    ).json()) as {
      students: { id: string; firstName: string; lastName: string }[];
    };
    // Un élève différent par projet, pour ne pas dépasser la limite de codes SMS par numéro.
    const absent = roster.students.filter((s) => s.lastName !== 'Ngono')[
      info.project.name === 'mobile' ? 0 : 1
    ]!;
    const submitted = await request.post(`${API_URL}/attendance/sessions`, {
      headers: teacher,
      data: {
        classId,
        date: today,
        startTime,
        endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}:00`,
        records: roster.students.map((s) => ({
          studentId: s.id,
          status: s.id === absent.id ? 'ABSENT' : 'PRESENT',
        })),
      },
    });
    expect(submitted.ok()).toBeTruthy();
    const detail = (await (
      await request.get(`${API_URL}/students/${absent.id}`, { headers: director })
    ).json()) as { guardians: { phone: string }[] };
    const phone = detail.guardians[0]!.phone.replace('+237', '');

    await loginParent(page, phone);
    await expect(page.getByText(/absences? non justifiées?/i)).toBeVisible();
    await page.getByRole('link', { name: 'Justifier' }).click();
    await page.getByRole('checkbox').first().check();
    await page.getByLabel('Motif').fill('Consultation médicale au CHU');
    await page.getByRole('button', { name: 'Envoyer le justificatif' }).click();
    await expect(page.getByText('Justificatif envoyé à la vie scolaire')).toBeVisible();
    await expect(page.getByText('En examen').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('la page de connexion parent passe en anglais', async ({ page }) => {
    await page.goto('/parent/connexion');
    await page.getByRole('button', { name: 'EN' }).click();
    await expect(
      page.getByRole('heading', { name: 'Follow your children’s schooling' }),
    ).toBeVisible();
    await page.getByLabel('Your phone number').fill('12');
    await page.getByRole('button', { name: 'Get a code by SMS' }).click();
    await expect(page.getByText('A 9-digit Cameroon number is expected.')).toBeVisible();
  });
});
