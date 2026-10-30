import { describe, expect, it } from 'vitest';
import { fitWithin, prepareUpload } from './files';

describe('fitWithin', () => {
  it('réduit le plus grand côté en gardant les proportions', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1500, height: 2000 });
  });

  it('n’agrandit jamais une petite image', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('prepareUpload', () => {
  it('accepte un PDF et refuse un contenu non autorisé ou vide', async () => {
    const pdf = new File(['%PDF-1.4 contenu'], 'acte.pdf', { type: 'application/pdf' });
    expect(await prepareUpload(pdf)).toBe(pdf);
    const html = new File(['<html></html>'], 'acte.pdf', { type: 'application/pdf' });
    await expect(prepareUpload(html)).rejects.toThrow('PDF, JPEG ou PNG');
    await expect(prepareUpload(new File([], 'vide.pdf'))).rejects.toThrow('vide');
  });

  it('refuse un PDF trop volumineux', async () => {
    const big = new File(['%PDF-1.4', new Uint8Array(10 * 1024 * 1024)], 'gros.pdf');
    await expect(prepareUpload(big)).rejects.toThrow('10 Mo');
  });
});
