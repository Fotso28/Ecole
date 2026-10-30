import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff, navigate } from './helpers';

/** Mois AAAA-MM décalé de `offset` par rapport au mois courant (heure de Douala). */
function monthAt(offset: number): string {
  const now = new Date(Date.now() + 3_600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))
    .toISOString()
    .slice(0, 7);
}

async function logout(page: Page) {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
}

/** Élément visible (carte sur téléphone, ligne de tableau sur ordinateur) contenant ce texte. */
const visibleItem = (page: Page, text: string) =>
  page.locator('li:visible, tr:visible').filter({ hasText: text }).first();

test('dossier du personnel, données sensibles, heures de cours et avance', async ({
  page,
}, info) => {
  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Dossiers du personnel');
  await expect(
    page.getByRole('heading', { name: 'Dossiers du personnel', level: 1 }),
  ).toBeVisible();
  // Le CDD de la professeure de français arrive à échéance dans 20 jours.
  await expect(page.getByRole('heading', { name: 'CDD à renouveler ou à clôturer' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await visibleItem(page, 'Eyenga Brigitte').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Eyenga Brigitte', level: 1 })).toBeVisible();
  // Données masquées, puis affichées avec un motif journalisé.
  await expect(page.getByText('•••• 7804')).toBeVisible();
  await expect(page.getByText('677112233')).toHaveCount(0);
  await page.getByRole('button', { name: 'Afficher' }).click();
  const dialog = page.getByRole('dialog', { name: 'Données sensibles' });
  await dialog.getByLabel('Motif de la consultation').fill('Contrôle du numéro Mobile Money');
  await dialog.getByRole('button', { name: 'Afficher les données' }).click();
  await expect(dialog.getByText('677112233')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await dialog.getByRole('button', { name: 'Masquer et fermer' }).click();

  // Avance demandée par la comptabilité : la direction l'accorde.
  await navigate(page, info, 'Avances sur salaire');
  const advance = visibleItem(page, 'Eyenga Brigitte');
  await expect(advance).toBeVisible();
  const approve = advance.getByRole('button', { name: /Accorder/ });
  if (await approve.count()) await approve.click();
  await expect(advance.getByText('Accordée')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await logout(page);

  // Heures de cours du mois précédent : un cours manqué avec motif.
  await loginStaff(page, 'compta@demo.cm');
  await navigate(page, info, 'Heures de cours');
  await page.getByLabel('Enseignant').selectOption({ label: 'Mbarga Paul' });
  await page.getByLabel('Mois', { exact: true }).selectOption(monthAt(-1));
  const lessons = page.getByRole('list', { name: 'Cours prévus' });
  await expect(lessons.getByRole('listitem').first()).toBeVisible();
  await lessons
    .getByRole('listitem')
    .first()
    .getByRole('button', { name: /Absent/ })
    .click();
  const absence = page.getByRole('dialog', { name: 'Cours non fait' });
  await absence.getByLabel('Motif de l’absence').fill('Absent sans prévenir');
  await absence.getByRole('button', { name: 'Enregistrer l’absence' }).click();
  await expect(
    lessons.getByRole('listitem').first().getByText('Absence non justifiée'),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Versement de l'avance accordée par la comptabilité (une seule fois : base partagée).
  await navigate(page, info, 'Avances sur salaire');
  const accorded = visibleItem(page, 'Eyenga Brigitte');
  await expect(accorded.getByText(/À verser|Versée le/).first()).toBeVisible();
  const pay = accorded.getByRole('button', { name: /Verser/ });
  if (await pay.count()) {
    await pay.click();
    const sheet = page.getByRole('dialog', { name: 'Versement de l’avance' });
    await sheet.getByLabel('Mode de versement').selectOption('CASH');
    await sheet.getByLabel(/Référence/).fill('BC-0001');
    await expectNoHorizontalOverflow(page);
    await sheet.getByRole('button', { name: 'Enregistrer le versement' }).click();
    await expect(page.getByText('Avance versée')).toBeVisible();
  }
  await expect(accorded.getByText(/Versée le .*Caisse \(espèces\)/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('paie : préparation par la comptabilité, validation par la direction, exports', async ({
  page,
}, info) => {
  // Un mois différent par projet : la base de démonstration est partagée.
  const month = monthAt(isMobile(info) ? 0 : 1);
  await loginStaff(page, 'compta@demo.cm');
  await navigate(page, info, 'Paie');
  await page.getByLabel('Mois de paie').selectOption(month);
  await page.getByRole('button', { name: 'Calculer la paie' }).click();
  await expect(page.getByText('En préparation', { exact: true })).toBeVisible();
  await expect(page.getByText(/à vérifier par un comptable/).first()).toBeVisible();
  await expect(visibleItem(page, 'Mbarga Paul')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Prime saisie sur un bulletin : recalcul immédiat.
  await page.getByRole('button', { name: 'Éléments de Mbarga Paul' }).click();
  const sheet = page.getByRole('dialog', { name: 'Éléments de Mbarga Paul' });
  await sheet.getByLabel('Libellé').fill('Prime de rendement');
  await sheet.getByLabel('Montant (FCFA)').fill('10000');
  await sheet.getByRole('button', { name: 'Ajouter l’élément' }).click();
  await expect(sheet.getByText('Prime de rendement')).toBeVisible();
  await sheet.getByRole('button', { name: 'Enregistrer et recalculer' }).click();
  await expect(page.getByText('Bulletin recalculé')).toBeVisible();

  await page.getByRole('button', { name: 'Soumettre à la direction' }).click();
  await expect(page.getByText('En attente de validation', { exact: true })).toBeVisible();
  // La comptabilité ne peut pas valider elle-même.
  await expect(page.getByRole('button', { name: 'Valider la paie' })).toHaveCount(0);
  await logout(page);

  await loginStaff(page, 'direction@demo.cm');
  await navigate(page, info, 'Paie');
  await page.getByLabel('Mois de paie').selectOption(month);
  await page.getByRole('button', { name: 'Valider la paie' }).click();
  const confirm = page.getByRole('dialog', { name: 'Valider la paie' });
  await expect(confirm.getByText(/Aucun virement n’est envoyé automatiquement/)).toBeVisible();
  await confirm.getByRole('button', { name: /Je valide la paie/ }).click();
  await expect(page.getByText('Validée', { exact: true })).toBeVisible();
  await expect(visibleItem(page, 'Mbarga Paul').getByText(/PAIE-/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Calculer la paie' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recalculer' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Virements (CSV)' }).click();
  expect((await download).suggestedFilename()).toBe(`virements-${month}.csv`);
  const pdf = await page.request.get(`/api/hr/payroll/${month}/payslips.pdf`, {
    headers: {
      authorization: `Bearer ${await page.evaluate(async () => {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        return ((await res.json()) as { accessToken: string }).accessToken;
      })}`,
    },
  });
  expect(pdf.headers()['content-type']).toBe('application/pdf');

  // Les barèmes sont consultables et signalés à vérifier.
  await page.getByRole('link', { name: 'Barèmes' }).click();
  await expect(page.getByRole('heading', { name: 'Barèmes de paie', level: 1 })).toBeVisible();
  await expect(page.getByText(/à vérifier par un comptable/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await logout(page);

  // Versement des salaires : enregistré par la comptabilité, pas par la direction qui a validé.
  await loginStaff(page, 'compta@demo.cm');
  await navigate(page, info, 'Paie');
  await page.getByLabel('Mois de paie').selectOption(month);
  await expect(page.getByText('À verser', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Marquer comme versée' }).click();
  const payout = page.getByRole('dialog', { name: 'Marquer la paie comme versée' });
  await payout.getByLabel('Mode de versement').selectOption('BANK');
  await payout.getByLabel(/Référence/).fill(`VIR-${month}`);
  await expectNoHorizontalOverflow(page);
  await payout.getByRole('button', { name: 'Enregistrer le versement' }).click();
  await expect(page.getByText('Paie marquée comme versée')).toBeVisible();
  await expect(page.getByText('Versée', { exact: true })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`réf\\. VIR-${month}.*écriture BQ-\\d{4}-\\d{6}`)),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Marquer comme versée' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
