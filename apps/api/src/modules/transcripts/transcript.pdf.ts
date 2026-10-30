import PDFDocument from 'pdfkit';
import { frDate, grade, INK, MUTED, NIGHT, RULE, t, toBuffer } from '../pdf/pdf.service';
import type { TranscriptData } from './transcripts.service';

const SCOPE_TITLES: Record<TranscriptData['scope'], string> = {
  sequence: 'RELEVÉ DE NOTES DE SÉQUENCE',
  term: 'RELEVÉ DE NOTES TRIMESTRIEL',
  year: 'RELEVÉ DE NOTES ANNUEL',
};

/** Relevé de notes A4 : notes et moyennes, sans rang ni décision (distinct du bulletin). */
export function renderTranscript(data: TranscriptData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 30,
    info: {
      Title: `Relevé de notes ${data.student.lastName} ${data.student.firstName} · ${data.period}`,
      Author: data.school.name,
    },
  });
  const left = 30;
  const W = doc.page.width - 60;
  const bottom = doc.page.height - 70;
  let y = 30;

  doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(13).text(t(data.school.name), left, y);
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8)
    .text(t(`${data.school.city} · Année scolaire ${data.year}`), left, y + 17);
  y += 36;
  doc
    .moveTo(left, y)
    .lineTo(left + W, y)
    .lineWidth(1.5)
    .strokeColor(NIGHT)
    .stroke();
  y += 8;
  doc.rect(left, y, W, 22).fill('#E3F0EA');
  doc
    .fillColor(NIGHT)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(t(`${SCOPE_TITLES[data.scope]} · ${data.period.toUpperCase()}`), left + 8, y + 6, {
      width: W - 16,
    });
  y += 30;

  // Identité.
  const idLine = (label: string, value: string, x: number, w: number) => {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, x, y, { width: w });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(t(value), x, y + 9, { width: w });
  };
  const cw = W / 4;
  idLine(
    'Nom et prénoms',
    `${data.student.lastName.toUpperCase()} ${data.student.firstName}`,
    left,
    cw * 2 - 6,
  );
  idLine('Matricule', data.student.matricule, left + cw * 2, cw - 6);
  idLine('Classe', data.className, left + cw * 3, cw - 6);
  y += 22;
  idLine(
    'Né(e) le',
    `${frDate(data.student.birthDate)}${data.student.birthPlace ? ` à ${data.student.birthPlace}` : ''}`,
    left,
    W,
  );
  y += 28;

  // Tableau.
  const detail = data.scope === 'sequence';
  const cols = [
    { key: 'subject', label: 'Matière', w: detail ? 130 : 0, align: 'left' as const },
    ...(detail ? [{ key: 'evals', label: 'Évaluations', w: 0, align: 'left' as const }] : []),
    ...data.columns.map((c, i) => ({
      key: `c${i}`,
      label: c.replace('Séquence', 'Séq.').replace(' trimestre', ' trim.'),
      w: 56,
      align: 'right' as const,
    })),
    {
      key: 'avg',
      label: data.scope === 'year' ? 'Moy. annuelle' : 'Moyenne',
      w: 64,
      align: 'right' as const,
    },
    { key: 'coef', label: 'Coef.', w: 36, align: 'right' as const },
  ];
  const flex = cols.find((c) => c.w === 0);
  if (flex) flex.w = W - cols.reduce((s, c) => s + c.w, 0);

  const row = (
    values: Record<string, string>,
    opts: { bold?: boolean; fill?: string; height?: number } = {},
  ) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const needed = detail
      ? doc.heightOfString(t(values.evals ?? ''), { width: (flex?.w ?? 100) - 6 }) + 7
      : 0;
    const h = Math.max(opts.height ?? 15, needed);
    if (y + h > bottom) {
      doc.addPage();
      y = 30;
    }
    if (opts.fill) doc.rect(left, y, W, h).fill(opts.fill);
    let x = left;
    for (const c of cols) {
      doc.rect(x, y, c.w, h).lineWidth(0.6).strokeColor(RULE).stroke();
      doc
        .fillColor(INK)
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8);
      const multiline = detail && c.key === 'evals';
      doc.text(t(values[c.key] ?? ''), x + 3, multiline ? y + 4 : y + (h - 8) / 2, {
        width: c.w - 6,
        align: c.align,
        ...(multiline ? {} : { lineBreak: false, ellipsis: true }),
      });
      x += c.w;
    }
    y += h;
  };

  row(Object.fromEntries(cols.map((c) => [c.key, c.label])), {
    bold: true,
    fill: '#F1F0EA',
    height: 17,
  });
  for (const g of data.groups) {
    if (y + 14 > bottom) {
      doc.addPage();
      y = 30;
    }
    doc.rect(left, y, W, 14).fill('#FAFAF7');
    doc.rect(left, y, W, 14).lineWidth(0.6).strokeColor(RULE).stroke();
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(t(g.label.toUpperCase()), left + 4, y + 4);
    y += 14;
    for (const s of g.subjects) {
      const values: Record<string, string> = {
        subject: s.name,
        avg: grade(s.averageCenti),
        coef: String(s.coefficient),
        evals: s.evaluations.length
          ? s.evaluations
              .map(
                (e) =>
                  `${e.name}${e.weight > 1 ? ` (×${e.weight})` : ''} : ${e.value}${/^\d/.test(e.value) ? `/${e.maxScore}` : ''}`,
              )
              .join(' · ')
          : 'Aucune évaluation soumise',
      };
      s.columns.forEach((v, i) => {
        values[`c${i}`] = grade(v);
      });
      row(values);
    }
  }
  const totals: Record<string, string> = {
    subject: 'Moyenne générale',
    avg: grade(data.generalAverageCenti),
    coef: String(data.totalCoefficient),
  };
  data.columnGeneralAverages.forEach((v, i) => {
    totals[`c${i}`] = grade(v);
  });
  row(totals, { bold: true, fill: '#E3F0EA', height: 18 });
  y += 10;

  if (y + 90 > bottom) {
    doc.addPage();
    y = 30;
  }
  if (data.publicationNotice) {
    doc
      .fillColor('#9A3412')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(t(data.publicationNotice), left, y, { width: W });
    y = doc.y + 8;
  }
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(7.5)
    .text(
      t(
        `${data.scope === 'year' ? 'Moyenne annuelle : moyenne des moyennes trimestrielles. ' : ''}Relevé établi le ${frDate(data.generatedAt)} à partir des évaluations soumises ou validées. Document distinct du bulletin : il ne mentionne ni rang ni décision du conseil de classe.`,
      ),
      left,
      y,
      { width: W },
    );
  y += 34;
  doc
    .moveTo(left + W - 180, y + 20)
    .lineTo(left + W, y + 20)
    .lineWidth(0.8)
    .strokeColor(RULE)
    .stroke();
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text("Le chef d'établissement", left + W - 180, y + 24, { width: 180, align: 'center' });
  return toBuffer(doc);
}
