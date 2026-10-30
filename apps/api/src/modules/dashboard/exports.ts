import ExcelJS from 'exceljs';
import { formatFcfa, formatGrade, formatRate } from '@ecole/shared';
import PDFDocument from 'pdfkit';
import { INK, MUTED, NIGHT, RULE, t, toBuffer } from '../pdf/pdf.service';
import type { DashboardService } from './dashboard.module';
import type { PassRateCell, ResultsIndicators } from './results.service';

export type Overview = Awaited<ReturnType<DashboardService['overview']>>;

export interface IndicatorsExport {
  school: string;
  overview: Overview;
  /** Absent si l'utilisateur n'a pas accès aux bulletins. */
  results: ResultsIndicators | null;
  generatedAt: Date;
}

const rateLabel = (c: PassRateCell | null) =>
  c ? `${formatRate(c.ratePermille)}${c.provisional ? ' (provisoire)' : ''}` : '—';
const detailLabel = (c: PassRateCell | null) =>
  c ? `${c.passed}/${c.counted} · moy. ${formatGrade(c.averageCenti)}` : '';

/** Lignes communes aux deux exports : libellé et valeur. */
function keyFigures(e: IndicatorsExport): [string, string][] {
  const o = e.overview;
  const rows: [string, string][] = [
    ['Année scolaire', o.year.name],
    [
      'Effectif',
      `${o.enrollment.total} (${o.enrollment.girls} filles, ${o.enrollment.boys} garçons)`,
    ],
    ['Absences non justifiées cette semaine', String(o.attendance.unjustifiedThisWeek)],
    ['Élèves au-dessus du seuil d’absences', String(o.attendance.studentsAboveThreshold)],
  ];
  if (o.finance) {
    rows.push(
      ['Montant attendu', formatFcfa(o.finance.expected)],
      ['Montant encaissé', formatFcfa(o.finance.collected)],
      ['Taux de recouvrement', `${o.finance.recoveryRate} %`],
      ['Impayés échus', `${formatFcfa(o.finance.overdue)} (${o.finance.overdueStudents} élèves)`],
    );
  }
  if (e.results) {
    e.results.terms.forEach((term, i) => {
      rows.push([
        `Taux de réussite · ${term.name}`,
        rateLabel(e.results?.overall.terms[i] ?? null),
      ]);
    });
    rows.push(['Taux de réussite · année', rateLabel(e.results.overall.annual)]);
  }
  return rows;
}

/** Classeur Excel des indicateurs : synthèse, réussite par classe, recouvrement par échéance. */
export async function indicatorsWorkbook(e: IndicatorsExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = e.school;
  wb.created = e.generatedAt;
  const header = (ws: ExcelJS.Worksheet) => {
    const row = ws.getRow(1);
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E2A20' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };

  const summary = wb.addWorksheet('Synthèse');
  summary.columns = [
    { header: 'Indicateur', key: 'label', width: 44 },
    { header: 'Valeur', key: 'value', width: 40 },
  ];
  for (const [label, value] of keyFigures(e)) summary.addRow({ label, value });
  header(summary);

  if (e.results) {
    const r = e.results;
    const ws = wb.addWorksheet('Réussite par classe');
    const periods = [...r.terms.map((term) => term.name), 'Année'];
    ws.columns = [
      { header: 'Classe', key: 'cls', width: 14 },
      ...periods.flatMap((p, i) => [
        { header: `${p} · taux (%)`, key: `rate${i}`, width: 18 },
        { header: `${p} · admis`, key: `passed${i}`, width: 12 },
        { header: `${p} · classés`, key: `counted${i}`, width: 12 },
        { header: `${p} · moyenne`, key: `avg${i}`, width: 14 },
      ]),
    ];
    const fill = (cells: (PassRateCell | null)[]) =>
      Object.fromEntries(
        cells.flatMap((c, i) => [
          // Valeurs numériques exploitables dans Excel : taux en pour cent, moyenne sur 20.
          [`rate${i}`, c?.ratePermille == null ? null : c.ratePermille / 10],
          [`passed${i}`, c?.passed ?? null],
          [`counted${i}`, c?.counted ?? null],
          [`avg${i}`, c?.averageCenti == null ? null : c.averageCenti / 100],
        ]),
      );
    for (const c of r.classes) ws.addRow({ cls: c.className, ...fill([...c.terms, c.annual]) });
    const total = ws.addRow({
      cls: 'Établissement',
      ...fill([...r.overall.terms, r.overall.annual]),
    });
    total.font = { bold: true };
    header(ws);
    if ([...r.overall.terms, r.overall.annual].some((c) => c?.provisional))
      ws.addRow({ cls: 'Certains chiffres proviennent de bulletins non publiés (provisoires).' });
  }

  if (e.overview.finance) {
    const ws = wb.addWorksheet('Recouvrement');
    ws.columns = [
      { header: 'Échéance', key: 'name', width: 28 },
      { header: 'Date', key: 'dueDate', width: 12 },
      { header: 'Attendu (FCFA)', key: 'due', width: 16 },
      { header: 'Encaissé (FCFA)', key: 'paid', width: 16 },
      { header: 'Taux (%)', key: 'rate', width: 10 },
    ];
    for (const item of e.overview.finance.items) ws.addRow(item);
    header(ws);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Rapport PDF des indicateurs du tableau de bord. */
export function indicatorsPdf(e: IndicatorsExport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 30,
    info: { Title: `Indicateurs ${e.overview.year.name}`, Author: e.school },
  });
  const left = 30;
  const W = doc.page.width - 60;
  const bottom = doc.page.height - 50;
  let y = 30;
  const ensure = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = 30;
    }
  };
  const section = (title: string) => {
    ensure(40);
    y += 8;
    doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(10).text(t(title.toUpperCase()), left, y);
    y += 16;
  };

  doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(14).text(t(e.school), left, y);
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(8.5)
    .text(
      t(
        `Indicateurs du tableau de bord · année ${e.overview.year.name} · édité le ${e.generatedAt.toLocaleString('fr-FR', { timeZone: 'Africa/Douala' })}`,
      ),
      left,
      y + 19,
    );
  y += 38;
  doc
    .moveTo(left, y)
    .lineTo(left + W, y)
    .lineWidth(1.5)
    .strokeColor(NIGHT)
    .stroke();
  y += 6;

  section('Synthèse');
  for (const [label, value] of keyFigures(e)) {
    ensure(16);
    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(9)
      .text(t(label), left, y, { width: W * 0.55 });
    doc
      .font('Helvetica-Bold')
      .text(t(value), left + W * 0.55, y, { width: W * 0.45, align: 'right' });
    y += 15;
    doc
      .moveTo(left, y - 3)
      .lineTo(left + W, y - 3)
      .lineWidth(0.4)
      .strokeColor(RULE)
      .stroke();
  }

  if (e.results) {
    const r = e.results;
    section('Taux de réussite par classe (moyenne d’au moins 10/20)');
    const periods = [...r.terms.map((term) => term.name), 'Année'];
    const first = 70;
    const colW = (W - first) / periods.length;
    const tableRow = (label: string, cells: string[], subs: string[], bold = false) => {
      ensure(26);
      doc
        .fillColor(INK)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8.5)
        .text(t(label), left + 2, y + 3, { width: first - 4 });
      cells.forEach((c, i) => {
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.5)
          .fillColor(INK)
          .text(t(c), left + first + i * colW, y + 3, { width: colW - 4, align: 'right' });
        if (subs[i])
          doc
            .font('Helvetica')
            .fontSize(7)
            .fillColor(MUTED)
            .text(t(subs[i]), left + first + i * colW, y + 13, { width: colW - 4, align: 'right' });
      });
      y += 24;
      doc
        .moveTo(left, y)
        .lineTo(left + W, y)
        .lineWidth(0.4)
        .strokeColor(RULE)
        .stroke();
    };
    tableRow('Classe', periods, [], true);
    for (const c of r.classes) {
      const cells = [...c.terms, c.annual];
      tableRow(c.className, cells.map(rateLabel), cells.map(detailLabel));
    }
    const all = [...r.overall.terms, r.overall.annual];
    tableRow('Établissement', all.map(rateLabel), all.map(detailLabel), true);
    y += 4;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        t(
          'Calculé à partir des bulletins publiés ; « provisoire » signale des bulletins encore en brouillon. Le taux annuel porte sur la moyenne annuelle (moyenne des trois trimestres).',
        ),
        left,
        y,
        { width: W },
      );
    y += 22;
  }

  if (e.overview.finance) {
    section('Recouvrement par échéance');
    for (const item of e.overview.finance.items) {
      ensure(16);
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(t(item.name), left, y, { width: 200 });
      doc.text(t(`${formatFcfa(item.paid)} / ${formatFcfa(item.due)}`), left + 200, y, {
        width: W - 260,
        align: 'right',
      });
      doc
        .font('Helvetica-Bold')
        .text(`${item.rate} %`, left + W - 56, y, { width: 56, align: 'right' });
      y += 15;
    }
  }
  return toBuffer(doc);
}
