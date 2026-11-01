import ExcelJS from 'exceljs';
import {
  CONTRACT_TYPE_LABELS,
  formatFcfa,
  formatMinutes,
  formatPayrollMonth,
  ofPayrollMonth,
  PAY_ELEMENT_LABELS,
  PAYOUT_METHOD_LABELS,
  PAYROLL_CONTRIBUTION_LABELS as L,
  type PayElement,
  type PayoutMethod,
  type PayrollScale,
  type PayslipResult,
} from '@ecole/shared';
import PDFDocument from 'pdfkit';
import { frDate, INK, MUTED, NIGHT, RULE, t, toBuffer } from '../pdf/pdf.service';
import type { PayslipInputs } from './payroll.service';

export interface PrintablePayslip {
  number: string | null;
  inputs: PayslipInputs;
  elements: PayElement[];
  absenceDays: number;
  result: PayslipResult;
  cnpsNumber: string | null;
}

export interface PayslipBatch {
  school: { name: string; city: string };
  month: string;
  scale: PayrollScale;
  validatedAt: Date | null;
  validatedBy: string | null;
  slips: PrintablePayslip[];
}

const money = (n: number) => t(formatFcfa(n, false));

/** Bulletins de paie A4, un par page, à partir des données figées à la validation. */
export async function payslipsPdf(batch: PayslipBatch): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    autoFirstPage: false,
    info: { Title: `Bulletins de paie ${batch.month}`, Author: batch.school.name },
  });
  for (const slip of batch.slips) renderSlip(doc, batch, slip);
  if (batch.slips.length === 0) doc.addPage().text('Aucun bulletin.');
  return toBuffer(doc);
}

function renderSlip(doc: PDFKit.PDFDocument, batch: PayslipBatch, slip: PrintablePayslip) {
  doc.addPage();
  const left = 36;
  const W = doc.page.width - 72;
  let y = 36;
  const { inputs, result: r } = slip;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(t(batch.school.name), left, y);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(t(batch.school.city), left, y + 16);
  doc
    .font('Helvetica-Bold')
    .fontSize(15)
    .fillColor(NIGHT)
    .text('BULLETIN DE PAIE', left, y, { width: W, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(INK)
    .text(t(`Période : ${formatPayrollMonth(batch.month)}`), left, y + 19, {
      width: W,
      align: 'right',
    })
    .text(t(`N° ${slip.number ?? '—'}`), left, y + 31, { width: W, align: 'right' });
  y += 50;
  doc
    .moveTo(left, y)
    .lineTo(left + W, y)
    .lineWidth(1.2)
    .strokeColor(NIGHT)
    .stroke();
  y += 10;

  const c = inputs.contract;
  const info: [string, string][] = [
    ['Nom et prénom', `${inputs.employee.lastName} ${inputs.employee.firstName}`],
    ['Poste', inputs.employee.position],
    ['Date d’entrée', frDate(inputs.employee.hireDate)],
    ['Contrat', CONTRACT_TYPE_LABELS[c.type]],
    ['N° CNPS', slip.cnpsNumber ?? 'non renseigné'],
    [
      c.type === 'HOURLY' ? 'Taux horaire' : 'Salaire de base',
      c.type === 'HOURLY'
        ? `${money(c.hourlyRate ?? 0)} FCFA/h`
        : `${money(c.baseSalary ?? 0)} FCFA`,
    ],
  ];
  doc.fontSize(9);
  info.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = left + col * (W / 2);
    doc
      .font('Helvetica')
      .fillColor(MUTED)
      .text(t(label), x, y + row * 14, { width: 90 });
    doc
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text(t(value), x + 92, y + row * 14, { width: W / 2 - 96 });
  });
  y += Math.ceil(info.length / 2) * 14 + 8;
  const h = inputs.hours;
  if (h.plannedMinutes || h.doneMinutes || h.overtimeMinutes) {
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        t(
          `Heures de cours : prévues ${formatMinutes(h.plannedMinutes)} · faites ${formatMinutes(h.doneMinutes)} · absences justifiées ${formatMinutes(h.absentJustifiedMinutes)} · non justifiées ${formatMinutes(h.absentUnjustifiedMinutes)} · supplémentaires ${formatMinutes(h.overtimeMinutes)}`,
        ),
        left,
        y,
        { width: W },
      );
    y += 16;
  }

  const cols = [left, left + W * 0.55, left + W * 0.78];
  const header = (title: string) => {
    doc.rect(left, y, W, 18).fill('#E8EDFB');
    doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(9);
    doc.text(t(title), cols[0]! + 6, y + 5);
    doc.text('Retenue', cols[1]!, y + 5, { width: W * 0.21, align: 'right' });
    doc.text('Gain', cols[2]!, y + 5, { width: W * 0.22 - 6, align: 'right' });
    y += 20;
  };
  const line = (label: string, gain: number | null, retenue: number | null, bold = false) => {
    doc
      .fillColor(INK)
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(9);
    doc.text(t(label), cols[0]! + 6, y, { width: W * 0.53 });
    if (retenue !== null)
      doc.text(money(retenue), cols[1]!, y, { width: W * 0.21, align: 'right' });
    if (gain !== null) doc.text(money(gain), cols[2]!, y, { width: W * 0.22 - 6, align: 'right' });
    y += 14;
  };
  const rule = () => {
    doc
      .moveTo(left, y)
      .lineTo(left + W, y)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    y += 5;
  };

  header('Rémunération');
  if (c.type === 'HOURLY')
    line(`Heures faites (${formatMinutes(h.doneMinutes)})`, r.baseEarned, null);
  else
    line(
      inputs.activeDays < inputs.daysInMonth
        ? `Salaire de base (${inputs.activeDays}/${inputs.daysInMonth} jours)`
        : 'Salaire de base',
      r.baseEarned,
      null,
    );
  if (r.overtimePay)
    line(`Heures supplémentaires (${formatMinutes(h.overtimeMinutes)})`, r.overtimePay, null);
  if (r.absenceDeduction)
    line(
      `Absences non justifiées${slip.absenceDays ? ` (${slip.absenceDays} j)` : ''}`,
      null,
      r.absenceDeduction,
    );
  for (const e of slip.elements) {
    const label = `${PAY_ELEMENT_LABELS[e.kind]} : ${e.label}${e.taxable ? '' : ' (non imposable)'}`;
    if (e.amount >= 0) line(label, e.amount, null);
    else line(label, null, -e.amount);
  }
  rule();
  line('Salaire brut', r.gross, null, true);
  line('dont brut taxable', r.grossTaxable, null);
  y += 4;

  header('Cotisations et impôts salariaux');
  line(`${L.cnpsEmployee} (base ${money(r.cnpsBase)})`, null, r.employee.cnps);
  line(L.housingEmployee, null, r.employee.housing);
  line(L.irpp, null, r.employee.irpp);
  line(L.cac, null, r.employee.cac);
  line(L.audiovisual, null, r.employee.audiovisual);
  line(L.communal, null, r.employee.communal);
  rule();
  line('Total des retenues salariales', null, r.employee.total, true);
  if (r.advanceDeduction) line('Remboursement d’avance sur salaire', null, r.advanceDeduction);
  y += 6;

  doc.rect(left, y, W, 26).fill(NIGHT);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('NET À PAYER', left + 8, y + 8)
    .text(t(`${money(r.net)} FCFA`), left, y + 8, { width: W - 8, align: 'right' });
  y += 36;

  doc
    .fillColor(MUTED)
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .text('Charges patronales (pour information)', left, y);
  y += 12;
  doc.font('Helvetica').fontSize(8.5);
  const employer: [string, number][] = [
    [L.cnpsPension, r.employer.pension],
    [L.cnpsFamily, r.employer.family],
    [L.cnpsAccident, r.employer.accident],
    [L.housingEmployer, r.employer.housing],
    [L.employment, r.employer.employment],
    ['Coût total employeur', r.employerCost],
  ];
  for (const [label, amount] of employer) {
    doc.text(t(label), left, y, { width: W * 0.6 });
    doc.text(money(amount), left, y, { width: W, align: 'right' });
    y += 11;
  }
  y += 10;
  doc
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      t(
        `Paie validée${batch.validatedAt ? ` le ${frDate(batch.validatedAt.toISOString())}` : ''}${batch.validatedBy ? ` par ${batch.validatedBy}` : ''}. Barème : ${batch.scale.label}.`,
      ),
      left,
      y,
      { width: W },
    );
  if (batch.scale.toVerify) {
    y = doc.y + 4;
    doc
      .fillColor('#9A5B00')
      .text(
        'Taux de cotisations et d’impôts préremplis : à vérifier par un comptable avant tout paiement.',
        left,
        y,
        { width: W },
      );
  }
}

export interface TransferRow {
  lastName: string;
  firstName: string;
  position: string;
  method: PayoutMethod;
  bankName: string | null;
  account: string | null;
  operator: string | null;
  net: number;
  number: string | null;
}

const TRANSFER_NOTICE =
  'État à exécuter manuellement auprès de la banque ou de l’opérateur : Ecole n’envoie aucun virement.';

function transferCells(r: TransferRow): (string | number)[] {
  return [
    r.number ?? '',
    r.lastName,
    r.firstName,
    r.position,
    PAYOUT_METHOD_LABELS[r.method],
    r.bankName ?? '',
    r.account ?? '',
    r.operator ?? '',
    r.net,
  ];
}

const TRANSFER_HEADERS = [
  'Bulletin',
  'Nom',
  'Prénom',
  'Poste',
  'Mode de paiement',
  'Banque',
  'Compte ou numéro',
  'Opérateur',
  'Net à payer (FCFA)',
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** État des virements au format CSV (séparateur point-virgule, lisible par Excel). */
export function transfersCsv(month: string, rows: TransferRow[]): string {
  const total = rows.reduce((s, r) => s + r.net, 0);
  const lines = [
    [`État des virements – paie ${ofPayrollMonth(month)}`],
    [TRANSFER_NOTICE],
    [],
    TRANSFER_HEADERS,
    ...rows.map(transferCells),
    [],
    ['', '', '', '', '', '', '', 'Total', total],
  ];
  return lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
}

/** État des virements au format Excel, un onglet par mode de paiement en plus du total. */
export async function transfersWorkbook(
  school: string,
  month: string,
  rows: TransferRow[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = school;
  const ws = wb.addWorksheet('Virements');
  ws.addRow([`État des virements – paie ${ofPayrollMonth(month)} – ${school}`]).font = {
    bold: true,
  };
  ws.addRow([TRANSFER_NOTICE]).font = { italic: true };
  ws.addRow([]);
  const header = ws.addRow(TRANSFER_HEADERS);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16205C' } };
  for (const r of rows) ws.addRow(transferCells(r));
  ws.addRow([]);
  const total = ws.addRow([
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    'Total',
    rows.reduce((s, r) => s + r.net, 0),
  ]);
  total.font = { bold: true };
  ws.columns.forEach((col, i) => {
    col.width = [12, 18, 18, 22, 18, 18, 24, 12, 18][i] ?? 14;
  });
  ws.getColumn(9).numFmt = '#,##0';
  return Buffer.from(await wb.xlsx.writeBuffer());
}
