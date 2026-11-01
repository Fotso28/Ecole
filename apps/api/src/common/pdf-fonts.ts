/* eslint-disable @typescript-eslint/no-require-imports -- chemins littéraux lus par le traçage de Vercel */
/**
 * Polices standard de pdfkit (Helvetica, etc.) : pdfkit les charge à la demande par un import
 * interne (`#standard-fonts/…`) que le traçage des fichiers des fonctions serverless (Vercel) ne
 * suit pas, d'où « Cannot find module …/standard-fonts/Helvetica.cjs » sur la plateforme. Cette
 * fonction n'est jamais appelée : ses `require` littéraux suffisent à embarquer les fichiers.
 */
export function traceStandardFonts(): unknown[] {
  return [
    require('pdfkit/standard-fonts/Courier'),
    require('pdfkit/standard-fonts/CourierBold'),
    require('pdfkit/standard-fonts/CourierBoldOblique'),
    require('pdfkit/standard-fonts/CourierOblique'),
    require('pdfkit/standard-fonts/Helvetica'),
    require('pdfkit/standard-fonts/HelveticaBold'),
    require('pdfkit/standard-fonts/HelveticaBoldOblique'),
    require('pdfkit/standard-fonts/HelveticaOblique'),
    require('pdfkit/standard-fonts/Symbol'),
    require('pdfkit/standard-fonts/TimesBold'),
    require('pdfkit/standard-fonts/TimesBoldItalic'),
    require('pdfkit/standard-fonts/TimesItalic'),
    require('pdfkit/standard-fonts/TimesRoman'),
    require('pdfkit/standard-fonts/ZapfDingbats'),
  ];
}
