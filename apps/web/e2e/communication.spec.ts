import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL } from '../playwright.config';
import {
  expectNoHorizontalOverflow,
  isMobile,
  loginParent,
  loginStaff,
  openPortalTab,
  PASSWORD,
} from './helpers';

async function token(request: APIRequestContext, email: string) {
  const res = await request.post(`${API_URL}/auth/login`, { data: { email, password: PASSWORD } });
  return { Authorization: `Bearer ${((await res.json()) as { accessToken: string }).accessToken}` };
}

const today = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
/** Réunion des parents du jeu de démonstration : le samedi d'au moins une semaine plus tard. */
const demoMeeting = () => {
  const inAWeek = addDays(today(), 7);
  return addDays(inAWeek, (6 - new Date(`${inAWeek}T00:00:00Z`).getUTCDay()) % 7);
};

/** Va au mois qui contient `date` dans le calendrier affiché. */
async function showMonthOf(page: Page, date: string) {
  if (date.slice(0, 7) !== today().slice(0, 7))
    await page.getByRole('button', { name: 'Mois suivant' }).click();
}

test.describe('communication', () => {
  test("l'enseignant écrit au parent, qui répond depuis le portail et consulte l'agenda", async ({
    page,
    request,
  }, info) => {
    // Un élève de 4e A différent par projet (limite de codes SMS par numéro).
    const teacher = await token(request, 'prof.maths@demo.cm');
    const director = await token(request, 'direction@demo.cm');
    const day = (await (
      await request.get(`${API_URL}/teacher/today`, { headers: teacher })
    ).json()) as { classSubjects: { classId: string; className: string }[] };
    const classId = day.classSubjects.find((c) => c.className === '4e A')?.classId ?? '';
    const roster = (await (
      await request.get(
        `${API_URL}/attendance/roster?classId=${classId}&date=${today()}&startTime=06:00`,
        { headers: teacher },
      )
    ).json()) as { students: { id: string; firstName: string; lastName: string }[] };
    const student = roster.students.filter((s) => s.lastName !== 'Ngono')[isMobile(info) ? 2 : 3]!;
    const detail = (await (
      await request.get(`${API_URL}/students/${student.id}`, { headers: director })
    ).json()) as { guardians: { phone: string; firstName: string; lastName: string }[] };
    const guardian = detail.guardians[0]!;
    const text = `Bonjour, ${student.firstName} a oublié son cahier de mathématiques (${info.project.name}).`;

    // L'enseignant ouvre une conversation au sujet de l'élève.
    await loginStaff(page, 'prof.maths@demo.cm');
    await page.goto('/messages');
    await expect(page.getByRole('heading', { name: 'Messages', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Nouveau message' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Au sujet de l’élève').fill(student.lastName);
    await dialog
      .getByRole('button', { name: new RegExp(`${student.lastName} ${student.firstName}`) })
      .first()
      .click();
    await expect(dialog.getByLabel('Parent destinataire')).toContainText(guardian.lastName);
    await dialog.getByLabel('Message').fill(text);
    await dialog.getByRole('button', { name: 'Envoyer' }).click();
    await page.waitForURL(/\/messages\/[a-z0-9]+$/);
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText(text);
    await expectNoHorizontalOverflow(page);

    // Le parent voit le message non lu, le lit et répond.
    await page.context().clearCookies();
    await loginParent(page, guardian.phone.replace('+237', ''));
    const nav = page.getByRole('navigation', { name: 'Navigation' });
    await expect(nav.getByRole('link', { name: 'Messages (1 non lu)' })).toBeVisible();
    await nav.getByRole('link', { name: /^Messages/ }).click();
    await page.getByRole('link', { name: /Mbarga/ }).click();
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText(text);
    await expect(page.getByRole('heading', { name: 'Paul Mbarga' })).toBeVisible();
    await page.getByLabel('Votre message').fill('Merci, il le rapportera demain.');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText(
      'Merci, il le rapportera demain.',
    );
    await expect(nav.getByRole('link', { name: 'Messages', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Agenda : un mois vide propose les prochains événements.
    await openPortalTab(page, 'Agenda');
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Mois précédent' }).click();
    await expect(page.getByText('Aucun événement ce mois-ci')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Prochains événements' })).toContainText(
      'Réunion des parents (séquence 1)',
    );
    await expectNoHorizontalOverflow(page);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Mois suivant' }).click();

    // La réunion des parents du jeu de démonstration, en liste puis en mois.
    const meeting = demoMeeting();
    await showMonthOf(page, meeting);
    await expect(page.getByText('Réunion des parents (séquence 1)')).toBeVisible();
    await page.getByRole('button', { name: 'Mois', exact: true }).click();
    await page
      .getByRole('button', { name: new RegExp(`${Number(meeting.slice(8))} \\w+, 1 événement`) })
      .first()
      .click();
    await expect(
      page.getByRole('region', { name: /^Événements du/ }).getByText('Réunion des parents'),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('la direction publie un événement, une annonce ciblée et consulte un fil sur motif', async ({
    page,
  }, info) => {
    await loginStaff(page, 'direction@demo.cm');

    // Calendrier : nouvel événement aujourd'hui pour toute l'école.
    const title = `Journée portes ouvertes (${info.project.name})`;
    await page.goto('/calendrier');
    await page.getByRole('button', { name: 'Nouvel événement' }).click();
    const form = page.getByRole('dialog');
    await form.getByLabel('Titre').fill(title);
    // La classe visée n'est jamais présélectionnée.
    await form.getByLabel('Concerne').selectOption({ label: 'Une classe' });
    await expect(form.getByLabel('Classe', { exact: true }).locator('option:checked')).toHaveText(
      'Choisir…',
    );
    await form.getByLabel('Concerne').selectOption({ label: 'Toute l’école' });
    await form.getByLabel('Type').selectOption({ label: 'Fête' });
    await form.getByLabel(/^Lieu/).fill('Cour principale');
    await form.getByLabel(/^Heure de début/).fill('10:00');
    await form.getByRole('button', { name: 'Ajouter au calendrier' }).click();
    await expect(page.getByText('Événement ajouté au calendrier')).toBeVisible();
    await expect(page.getByRole('list', { name: /^Événements de/ })).toContainText(title);
    await page.getByRole('button', { name: 'Mois', exact: true }).click();
    await page
      .getByRole('button', {
        name: new RegExp(`^\\w+ ${Number(today().slice(8))} \\w+, \\d+ événement`),
      })
      .first()
      .click();
    await expect(page.getByRole('region', { name: /^Événements du/ })).toContainText(title);
    await expectNoHorizontalOverflow(page);

    // Annonce aux parents d'un élève choisi.
    await page.goto('/annonces');
    const announcement = `Autorisation de sortie (${info.project.name})`;
    await page.getByLabel('Titre').fill(announcement);
    await page.getByLabel('Message').fill('Merci de signer l’autorisation avant vendredi.');
    await page.getByLabel('Destinataires').selectOption({ label: 'Les parents d’élèves choisis' });
    await page.getByLabel('Élèves', { exact: true }).fill('Ngono');
    await page.getByRole('button', { name: /Ngono Marie-Claire/ }).click();
    await expect(page.getByRole('list', { name: 'Élèves choisis' })).toContainText('Marie-Claire');
    await page.getByRole('button', { name: 'Publier' }).click();
    await expect(page.getByText(/Annonce publiée/)).toBeVisible();
    await expect(page.getByText(announcement)).toBeVisible();
    await expect(page.getByText('1 élève visé').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Annonce à une classe : la classe se choisit explicitement, puis l'annonce est retirée.
    const outing = `Sortie pédagogique (${info.project.name})`;
    await page.getByLabel('Titre').fill(outing);
    await page.getByLabel('Message').fill('Départ à 8 h devant le collège.');
    await page.getByLabel('Destinataires').selectOption({ label: 'Une classe' });
    const classe = page.getByLabel('Classe', { exact: true });
    await expect(classe.locator('option:checked')).toHaveText('Choisir…');
    await expect(page.getByRole('button', { name: 'Publier' })).toBeDisabled();
    await classe.selectOption({ label: '4e A' });
    await page.getByRole('button', { name: 'Publier' }).click();
    await expect(page.getByText(/Annonce publiée/).first()).toBeVisible();
    const card = page.getByRole('article', { name: outing });
    await expect(card).toContainText('Destinataires : Classe 4e A');
    await card.getByRole('button', { name: 'Retirer l’annonce' }).click();
    const confirm = page.getByRole('dialog', { name: 'Retirer l’annonce ?' });
    await expect(confirm).toContainText('Classe 4e A');
    await confirm.getByRole('button', { name: 'Retirer', exact: true }).click();
    await expect(page.getByText(/Annonce retirée/)).toBeVisible();
    await expect(card.getByText('Retirée', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Retirer l’annonce' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // Supervision : lecture d'un fil sur motif.
    await page.goto('/messages/supervision');
    const row = page
      .getByRole('list', { name: 'Conversations de l’établissement' })
      .getByRole('listitem')
      .filter({ hasText: 'Ngono' })
      .first();
    await row.getByRole('button', { name: 'Consulter' }).click();
    await page.getByRole('dialog').getByLabel('Motif').fill('Vérification à la demande du parent');
    await page.getByRole('dialog').getByRole('button', { name: 'Consulter le fil' }).click();
    await expect(page.getByText(/inscrite au journal d’audit/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText('fractions');
    await expect(page.getByLabel('Votre message')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
