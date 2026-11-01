// Génère plaquette.pdf à partir de plaquette.html (Chromium via Playwright, polices Google Fonts).
// Usage, depuis la racine du dépôt : node docs/commercial/generer-pdf.cjs [dossier d'aperçus PNG]
const { chromium } = require('playwright');
const path = require('node:path');

(async () => {
  const src = path.join(__dirname, 'plaquette.html');
  const out = path.join(__dirname, 'plaquette.pdf');
  const previews = process.argv[2];
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 900, height: 1200 },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${src}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  );
  if (!fonts.includes('Lexend'))
    console.warn('Attention : polices Google Fonts non chargées (accès réseau ?)');
  // Un contenu qui dépasse le bas de sa page serait coupé à l'impression.
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll('.page')].flatMap((p, i) => {
      const bottom = p.getBoundingClientRect().bottom;
      const worst = Math.max(
        0,
        ...[...p.querySelectorAll('*')]
          .filter((el) => !el.closest('.phone'))
          .map((el) => el.getBoundingClientRect().bottom - bottom),
      );
      return worst > 0.5 ? [`page ${i + 1} : débordement de ${worst.toFixed(1)} px`] : [];
    }),
  );
  overflow.forEach((m) => console.warn(m));
  if (previews) {
    const pages = await page.$$('.page');
    for (let i = 0; i < pages.length; i++)
      await pages[i].screenshot({ path: path.join(previews, `page-${i + 1}.png`) });
  }
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: out, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log(`PDF : ${out}`);
})();
