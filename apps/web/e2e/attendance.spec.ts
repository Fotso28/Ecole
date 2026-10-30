import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, loginStaff, navigate } from './helpers';

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
