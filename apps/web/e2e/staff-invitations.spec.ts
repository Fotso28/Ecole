import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { E2E_DATABASE_URL } from '../playwright.config';
import { expectNoHorizontalOverflow, loginStaff, navigate } from './helpers';

async function switchUser(page: Page, email: string) {
  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, email);
}

/**
 * Compte d'une autre école (un par projet de test et par exécution), avec le mot de passe des
 * comptes de démonstration.
 */
function otherSchoolAccount(project: string): { email: string; lastName: string } {
  const tag = `${project}-${Date.now()}`;
  const lastName = `Essomba${Date.now() % 100000}`;
  const email = `invitee-${tag}@autre.cm`;
  execSync(`psql "${E2E_DATABASE_URL}" -At -v ON_ERROR_STOP=1`, {
    input: `
      INSERT INTO "School" ("id", "name", "slug", "city", "matriculePrefix", "updatedAt")
        VALUES ('school-${tag}', 'Lycée invité ${tag}', 'lycee-${tag}', 'Douala', 'LI', now());
      INSERT INTO "User" ("id", "email", "phone", "passwordHash", "firstName", "lastName", "updatedAt")
        SELECT 'user-${tag}', '${email}', NULL, "passwordHash", 'Béatrice', '${lastName}', now()
        FROM "User" WHERE "email" = 'direction@demo.cm';
      INSERT INTO "Membership" ("id", "userId", "schoolId", "roles")
        VALUES ('membership-${tag}', 'user-${tag}', 'school-${tag}', '{TEACHER}');`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { email, lastName };
}

test('la direction invite le compte d’une autre école, qui accepte à sa connexion', async ({
  page,
}, info) => {
  const { email, lastName } = otherSchoolAccount(info.project.name);
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Personnel');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau membre du personnel' });
  await dialog.getByLabel('Prénom').fill('Prénom');
  await dialog.getByLabel('Nom', { exact: true }).fill('Saisi');
  await dialog.getByLabel('Adresse e-mail').fill(email);
  await dialog.getByLabel('Mot de passe provisoire').fill('motdepasse-ignore');
  await dialog.getByLabel('Enseignant', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Créer le compte' }).click();
  await expect(page.getByText(/une invitation lui sera proposée/)).toBeVisible();
  // Rien du compte existant n'apparaît : seule l'adresse saisie est rappelée.
  const pending = page.getByRole('list', { name: 'Invitations en attente' });
  await expect(pending).toContainText(email);
  await expect(page.getByText(lastName)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await switchUser(page, email);
  const banner = page.getByRole('region', { name: 'Invitations reçues' });
  await expect(banner).toContainText('vous invite à rejoindre son personnel');
  await expectNoHorizontalOverflow(page);
  await banner.getByRole('button', { name: 'Accepter' }).click();
  await expect(page.getByText(/Invitation acceptée/)).toBeVisible();
  await expect(banner).toBeHidden();
});
