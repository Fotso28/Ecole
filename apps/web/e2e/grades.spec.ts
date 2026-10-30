import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, isMobile, loginStaff } from './helpers';

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
