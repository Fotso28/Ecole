import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, loginStaff, navigate, PASSWORD } from './helpers';

async function switchUser(page: Page, email: string) {
  await page.goto('/connexion');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await loginStaff(page, email);
}

async function openRoles(page: Page, info: Parameters<typeof navigate>[1]) {
  await navigate(page, info, 'Rôles et droits');
  await expect(page.getByRole('heading', { name: 'Rôles et droits', level: 1 })).toBeVisible();
}

test.describe('rôles et droits par école', () => {
  test('la direction ajoute un droit à un rôle intégré, la personne le voit, puis rétablit', async ({
    page,
  }, info) => {
    await loginStaff(page, 'direction@demo.cm');
    await openRoles(page, info);
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Modifier le rôle Infirmerie' }).click();
    const dialog = page.getByRole('dialog', { name: 'Infirmerie' });
    await expect(dialog.getByText('Consulter les informations médicales')).toBeVisible();
    const preview = dialog.getByTestId('apercu-menu');
    await expect(preview).not.toContainText('Registre des incidents');
    await dialog.locator('summary', { hasText: 'Vie scolaire' }).click();
    await dialog.getByLabel('Voir les incidents de discipline').check();
    // L'aperçu suit la sélection, avant même l'enregistrement.
    await expect(preview).toContainText('Registre des incidents');
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Rôle enregistré')).toBeVisible();
    await expect(dialog).toBeHidden();

    // L'infirmière voit l'écran correspondant à son nouveau droit.
    await switchUser(page, 'infirmerie@demo.cm');
    await navigate(page, info, 'Registre des incidents');
    await expect(page.getByRole('heading', { name: /incidents/i, level: 1 })).toBeVisible();

    // Retour aux valeurs par défaut : le droit disparaît.
    await switchUser(page, 'direction@demo.cm');
    await page.goto('/parametres/roles');
    await page.getByRole('button', { name: 'Modifier le rôle Infirmerie' }).click();
    await page
      .getByRole('dialog', { name: 'Infirmerie' })
      .getByRole('button', { name: 'Rétablir les valeurs par défaut' })
      .click();
    await expect(page.getByText('Valeurs par défaut rétablies')).toBeVisible();
    await switchUser(page, 'infirmerie@demo.cm');
    await page.goto('/incidents');
    await expect(page.getByRole('link', { name: 'Registre des incidents' })).toHaveCount(0);
  });

  test('la direction ne peut pas retirer la gestion du personnel à la direction', async ({
    page,
  }) => {
    await loginStaff(page, 'direction@demo.cm');
    await page.goto('/parametres/roles');
    await page.getByRole('button', { name: 'Modifier le rôle Direction' }).click();
    const dialog = page.getByRole('dialog', { name: 'Direction' });
    await expect(dialog.getByLabel(/Adapter les rôles et leurs droits/)).toBeDisabled();
    await expect(dialog.getByLabel(/Adapter les rôles et leurs droits/)).toBeChecked();
    await expect(dialog.getByText('toujours accordé à la direction').first()).toBeVisible();
  });

  test('crée un rôle propre, l’attribue à un nouveau membre et limite son menu', async ({
    page,
  }, info) => {
    const name = `Bibliothécaire ${info.project.name}`;
    const email = `biblio.${info.project.name}@demo.cm`;
    await loginStaff(page, 'direction@demo.cm');
    await openRoles(page, info);
    await page.getByRole('button', { name: 'Nouveau rôle' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouveau rôle' });
    await dialog.getByLabel('Nom du rôle').fill(name);
    await dialog.locator('summary', { hasText: 'Élèves et structure' }).click();
    await dialog.getByLabel('Voir les fiches élèves').check();
    await dialog.locator('summary', { hasText: 'Bibliothèque et stock' }).click();
    await dialog.getByLabel('Consulter le catalogue de la bibliothèque').check();
    await dialog.getByLabel('Enregistrer les prêts et retours').check();
    await expect(dialog.getByTestId('apercu-menu')).toContainText('Bibliothèque');
    await expect(dialog.getByTestId('apercu-menu')).not.toContainText('Caisse');
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByText('Rôle créé')).toBeVisible();
    await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible();

    // Attribution depuis l'écran du personnel.
    await page.goto('/personnel');
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const form = page.getByRole('dialog', { name: 'Nouveau membre du personnel' });
    await form.getByLabel('Prénom').fill('Awa');
    await form.getByLabel('Nom', { exact: true }).fill('Ndi');
    await form.getByLabel('Adresse e-mail').fill(email);
    await form.getByLabel('Mot de passe provisoire').fill(PASSWORD);
    await form.getByLabel(name).check();
    await form.getByRole('button', { name: 'Créer le compte' }).click();
    await expect(page.getByText(/Compte créé/)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // La personne ne voit que ce que son rôle permet.
    await switchUser(page, email);
    await navigate(page, info, 'Bibliothèque');
    await expect(page.getByRole('heading', { name: 'Bibliothèque', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Caisse', exact: true })).toHaveCount(0);
    const me = await page.evaluate(async () => {
      const refresh = await fetch('/api/auth/refresh', { method: 'POST' });
      const { accessToken } = (await refresh.json()) as { accessToken: string };
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return (await res.json()) as { permissions: string[]; customRoles: { name: string }[] };
    });
    expect(me.permissions.sort()).toEqual(['library.loans', 'library.read', 'students.read']);
    expect(me.customRoles.map((r) => r.name)).toEqual([name]);
  });
});

test('lien direct vers une page interdite : refus net, sans les commandes de la page', async ({
  page,
}) => {
  await loginStaff(page, 'prof.maths@demo.cm');
  for (const [path, label] of [
    ['/caisse', 'Caisse'],
    ['/caisse/journal', 'Journal des paiements'],
    ['/rh/paie', 'Paie'],
    ['/parametres/roles', 'Rôles et droits'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Accès refusé' })).toBeVisible();
    await expect(
      page.getByText(`Vous n’avez pas le droit d’ouvrir la page « ${label} »`),
    ).toBeVisible();
    await expect(page.getByText('Permission insuffisante')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Exporter|Barèmes|Nouveau rôle/ })).toHaveCount(
      0,
    );
    await expect(page.getByPlaceholder('Nom, matricule ou téléphone du parent')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  }
  await page.getByRole('link', { name: 'Retour à l’accueil' }).click();
  await expect(page).toHaveURL(/\/enseignant$/);
});
