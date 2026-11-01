import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ACCOUNTING_REPORT_LABELS,
  balanceSheet,
  formatFcfa,
  generalLedger,
  incomeStatement,
  JOURNAL_LABELS,
  trialBalance,
  type AccountingReport,
  type BalanceSheet,
  type GeneralLedgerAccount,
  type IncomeStatement,
  type JournalCode,
  type TrialBalance,
} from '@ecole/shared';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { currentSchoolId } from '../../common/context';
import { addDays, fromDbDate, toDbDate } from '../../common/dates';
import { Db, InjectDb } from '../../common/prisma';
import { INK, MUTED, NIGHT, RULE, t, toBuffer } from '../pdf/pdf.service';
import { AccountingService } from './accounting.service';

export interface ReportQuery {
  from: string;
  to: string;
  journal?: string;
  account?: string;
}

interface JournalEntryRow {
  reference: string;
  journal: string;
  date: string;
  label: string;
  pieceRef: string | null;
  lines: { accountNumber: string; label: string | null; debit: number; credit: number }[];
}

export type ReportData =
  | { kind: 'journal'; entries: JournalEntryRow[]; totals: { debit: number; credit: number } }
  | { kind: 'grand-livre'; accounts: GeneralLedgerAccount[] }
  | { kind: 'balance'; balance: TrialBalance }
  | { kind: 'compte-de-resultat'; statement: IncomeStatement }
  | { kind: 'bilan'; sheet: BalanceSheet };

export type Report = ReportData & {
  title: string;
  school: string;
  from: string;
  to: string;
  fiscalYear: { id: string; name: string; startDate: string; endDate: string; status: string };
};

const frDate = (iso: string) => iso.split('-').reverse().join('/');

@Injectable()
export class AccountingReportsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly accounting: AccountingService,
  ) {}

  /** Une période d'état reste à l'intérieur d'un exercice (les à-nouveaux ouvrent chaque exercice). */
  private async fiscalYearFor(from: string, to: string) {
    if (to < from) throw new BadRequestException('La fin de la période précède son début');
    const year = await this.db.fiscalYear.findFirst({
      where: { startDate: { lte: toDbDate(from) }, endDate: { gte: toDbDate(from) } },
    });
    if (!year) throw new BadRequestException(`Aucun exercice ne couvre le ${frDate(from)}`);
    if (toDbDate(to) > year.endDate)
      throw new BadRequestException(
        `Choisissez une période à l’intérieur de l’exercice (fin le ${frDate(fromDbDate(year.endDate))})`,
      );
    return year;
  }

  async build(kind: AccountingReport, q: ReportQuery): Promise<Report> {
    await this.accounting.ensureSetup();
    const year = await this.fiscalYearFor(q.from, q.to);
    const school = await this.db.school.findUniqueOrThrow({
      where: { id: currentSchoolId() },
      select: { name: true },
    });
    const head = {
      title: ACCOUNTING_REPORT_LABELS[kind],
      school: school.name,
      from: q.from,
      to: q.to,
      fiscalYear: {
        id: year.id,
        name: year.name,
        startDate: fromDbDate(year.startDate),
        endDate: fromDbDate(year.endDate),
        status: year.status,
      },
    };
    const fy = year.id;
    switch (kind) {
      case 'journal': {
        const entries = await this.db.accountingEntry.findMany({
          where: {
            fiscalYearId: fy,
            date: { gte: toDbDate(q.from), lte: toDbDate(q.to) },
            journalCode: q.journal,
          },
          include: { lines: { orderBy: { order: 'asc' } } },
          orderBy: [{ date: 'asc' }, { journalCode: 'asc' }, { number: 'asc' }],
        });
        let debit = 0;
        let credit = 0;
        const rows = entries.map((e) => {
          for (const l of e.lines) {
            debit += l.debit;
            credit += l.credit;
          }
          return {
            reference: e.reference,
            journal: e.journalCode,
            date: fromDbDate(e.date),
            label: e.label,
            pieceRef: e.pieceRef,
            lines: e.lines.map((l) => ({
              accountNumber: l.accountNumber,
              label: l.label,
              debit: l.debit,
              credit: l.credit,
            })),
          };
        });
        return {
          ...head,
          title: q.journal
            ? `Journal ${JOURNAL_LABELS[q.journal as JournalCode] ?? q.journal}`
            : 'Journal général',
          kind,
          entries: rows,
          totals: { debit, credit },
        };
      }
      case 'grand-livre': {
        const [opening, lines, accounts] = await Promise.all([
          this.accounting.balances(this.db, { fiscalYearId: fy, before: q.from }),
          this.db.accountingLine.findMany({
            where: {
              accountNumber: q.account ? { startsWith: q.account } : undefined,
              entry: { fiscalYearId: fy, date: { gte: toDbDate(q.from), lte: toDbDate(q.to) } },
            },
            include: { entry: { select: { date: true, reference: true, label: true } } },
          }),
          this.db.accountingAccount.findMany({ select: { number: true, label: true } }),
        ]);
        const numbers = new Set([
          ...opening.map((o) => o.accountNumber),
          ...lines.map((l) => l.accountNumber),
        ]);
        const scoped = [...numbers].filter((n) => !q.account || n.startsWith(q.account));
        return {
          ...head,
          kind,
          accounts: generalLedger(
            scoped.map((n) => ({
              accountNumber: n,
              label: accounts.find((a) => a.number === n)?.label ?? n,
              opening: opening.find((o) => o.accountNumber === n)?.balance ?? 0,
            })),
            lines.map((l) => ({
              accountNumber: l.accountNumber,
              date: fromDbDate(l.entry.date),
              reference: l.entry.reference,
              label: l.label ?? l.entry.label,
              debit: l.debit,
              credit: l.credit,
            })),
          ),
        };
      }
      case 'balance': {
        const sums = async (where: Record<string, unknown>) =>
          this.db.accountingLine.groupBy({
            by: ['accountNumber'],
            where: { entry: { fiscalYearId: fy, ...where } },
            _sum: { debit: true, credit: true },
          });
        const [before, period, accounts] = await Promise.all([
          sums({ date: { lt: toDbDate(q.from) } }),
          sums({ date: { gte: toDbDate(q.from), lte: toDbDate(q.to) } }),
          this.db.accountingAccount.findMany({ select: { number: true, label: true } }),
        ]);
        const numbers = new Set([...before, ...period].map((g) => g.accountNumber));
        return {
          ...head,
          kind,
          balance: trialBalance(
            [...numbers].map((n) => {
              const b = before.find((g) => g.accountNumber === n)?._sum;
              const p = period.find((g) => g.accountNumber === n)?._sum;
              return {
                accountNumber: n,
                label: accounts.find((a) => a.number === n)?.label ?? n,
                openingDebit: b?.debit ?? 0,
                openingCredit: b?.credit ?? 0,
                debit: p?.debit ?? 0,
                credit: p?.credit ?? 0,
              };
            }),
          ),
        };
      }
      case 'compte-de-resultat': {
        const balances = await this.accounting.balances(this.db, {
          fiscalYearId: fy,
          from: q.from,
          to: q.to,
        });
        return { ...head, kind, statement: incomeStatement(balances) };
      }
      case 'bilan': {
        const balances = await this.accounting.balances(this.db, {
          fiscalYearId: fy,
          before: addDays(q.to, 1),
        });
        return { ...head, kind, sheet: balanceSheet(balances) };
      }
    }
  }

  async xlsx(report: Report): Promise<Buffer> {
    return workbook(toTable(report), report);
  }

  async pdf(report: Report): Promise<Buffer> {
    return pdfDocument(toTable(report), report);
  }
}

// ---------------------------------------------------------------- Mise en tableau

interface Column {
  header: string;
  width: number;
  money?: boolean;
}

interface Row {
  cells: (string | number | null)[];
  bold?: boolean;
}

export interface ReportTable {
  columns: Column[];
  rows: Row[];
  landscape: boolean;
}

/** Représentation tabulaire commune aux exports Excel et PDF. */
export function toTable(r: Report): ReportTable {
  switch (r.kind) {
    case 'journal': {
      const rows: Row[] = [];
      for (const e of r.entries) {
        e.lines.forEach((l, i) => {
          rows.push({
            cells: [
              i === 0 ? frDate(e.date) : '',
              i === 0 ? e.reference : '',
              i === 0 ? (e.pieceRef ?? '') : '',
              l.accountNumber,
              l.label ?? e.label,
              l.debit || null,
              l.credit || null,
            ],
          });
        });
      }
      rows.push({ cells: ['', '', '', '', 'Totaux', r.totals.debit, r.totals.credit], bold: true });
      return {
        landscape: true,
        columns: [
          { header: 'Date', width: 11 },
          { header: 'Écriture', width: 16 },
          { header: 'Pièce', width: 12 },
          { header: 'Compte', width: 9 },
          { header: 'Libellé', width: 46 },
          { header: 'Débit', width: 14, money: true },
          { header: 'Crédit', width: 14, money: true },
        ],
        rows,
      };
    }
    case 'grand-livre': {
      const rows: Row[] = [];
      for (const a of r.accounts) {
        rows.push({
          cells: [`${a.accountNumber} · ${a.label}`, '', '', null, null, null],
          bold: true,
        });
        rows.push({ cells: ['', '', 'Solde d’ouverture', null, null, a.opening] });
        for (const l of a.lines)
          rows.push({
            cells: [
              frDate(l.date),
              l.reference,
              l.label,
              l.debit || null,
              l.credit || null,
              l.balance,
            ],
          });
        rows.push({
          cells: ['', '', `Total ${a.accountNumber}`, a.totalDebit, a.totalCredit, a.closing],
          bold: true,
        });
      }
      return {
        landscape: true,
        columns: [
          { header: 'Date', width: 11 },
          { header: 'Écriture', width: 16 },
          { header: 'Libellé', width: 50 },
          { header: 'Débit', width: 14, money: true },
          { header: 'Crédit', width: 14, money: true },
          { header: 'Solde (débiteur +)', width: 16, money: true },
        ],
        rows,
      };
    }
    case 'balance': {
      const b = r.balance;
      const money = (header: string): Column => ({ header, width: 14, money: true });
      return {
        landscape: true,
        columns: [
          { header: 'Compte', width: 9 },
          { header: 'Intitulé', width: 40 },
          money('Ouverture débit'),
          money('Ouverture crédit'),
          money('Mouvements débit'),
          money('Mouvements crédit'),
          money('Solde débiteur'),
          money('Solde créditeur'),
        ],
        rows: [
          ...b.rows.map((x) => ({
            cells: [
              x.accountNumber,
              x.label,
              x.openingDebit,
              x.openingCredit,
              x.debit,
              x.credit,
              x.balanceDebit,
              x.balanceCredit,
            ],
          })),
          {
            bold: true,
            cells: [
              '',
              'Totaux',
              b.totals.openingDebit,
              b.totals.openingCredit,
              b.totals.debit,
              b.totals.credit,
              b.totals.balanceDebit,
              b.totals.balanceCredit,
            ],
          },
        ],
      };
    }
    case 'compte-de-resultat': {
      const s = r.statement;
      return {
        landscape: false,
        columns: [
          { header: 'Rubrique', width: 10 },
          { header: 'Intitulé', width: 50 },
          { header: 'Montant', width: 16, money: true },
        ],
        rows: [
          { cells: ['', 'Produits', null], bold: true },
          ...s.products.map((g) => ({ cells: [g.code, g.label, g.amount] })),
          { cells: ['', 'Total des produits', s.totalProducts], bold: true },
          { cells: ['', 'Charges', null], bold: true },
          ...s.charges.map((g) => ({ cells: [g.code, g.label, g.amount] })),
          { cells: ['', 'Total des charges', s.totalCharges], bold: true },
          {
            cells: ['', s.result >= 0 ? 'Résultat : bénéfice' : 'Résultat : perte', s.result],
            bold: true,
          },
        ],
      };
    }
    case 'bilan': {
      const s = r.sheet;
      return {
        landscape: false,
        columns: [
          { header: 'Poste', width: 56 },
          { header: 'Montant', width: 16, money: true },
        ],
        rows: [
          { cells: ['Actif', null], bold: true },
          ...s.assets.map((g) => ({ cells: [g.label, g.amount] })),
          { cells: ['Total actif', s.totalAssets], bold: true },
          { cells: ['Passif', null], bold: true },
          ...s.liabilities.map((g) => ({ cells: [g.label, g.amount] })),
          { cells: ['Total passif', s.totalLiabilities], bold: true },
        ],
      };
    }
  }
}

function subtitle(r: Report): string {
  return `${r.school} · du ${frDate(r.from)} au ${frDate(r.to)} · ${r.fiscalYear.name}`;
}

async function workbook(table: ReportTable, r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = r.school;
  wb.created = new Date();
  const ws = wb.addWorksheet(r.title.slice(0, 31));
  ws.columns = table.columns.map((c) => ({ width: c.width }));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle(r)]).font = { color: { argb: 'FF525A78' } };
  ws.addRow([]);
  const header = ws.addRow(table.columns.map((c) => c.header));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16205C' } };
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  for (const row of table.rows) {
    const added = ws.addRow(row.cells.map((v) => (v === null ? null : v)));
    if (row.bold) added.font = { bold: true };
    table.columns.forEach((c, i) => {
      if (c.money) added.getCell(i + 1).numFmt = '#,##0';
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdfDocument(table: ReportTable, r: Report): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: table.landscape ? 'landscape' : 'portrait',
    margin: 30,
    info: { Title: `${r.title} ${r.from} ${r.to}`, Author: r.school },
  });
  const left = 30;
  const width = doc.page.width - 60;
  const totalWidth = table.columns.reduce((s, c) => s + c.width, 0);
  const widths = table.columns.map((c) => (c.width / totalWidth) * width);
  const bottom = () => doc.page.height - 40;
  let y = 30;

  doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(15).text(t(r.title), left, y);
  y += 20;
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(9)
    .text(t(subtitle(r)), left, y);
  y += 18;

  const drawHeader = () => {
    doc.rect(left, y, width, 16).fill(NIGHT);
    let x = left;
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    table.columns.forEach((c, i) => {
      const w = widths[i] ?? 0;
      doc.text(t(c.header), x + 3, y + 4, { width: w - 6, align: c.money ? 'right' : 'left' });
      x += w;
    });
    y += 18;
  };
  drawHeader();
  for (const row of table.rows) {
    doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const texts = row.cells.map((v, i) =>
      v === null || v === ''
        ? ''
        : typeof v === 'number' && table.columns[i]?.money
          ? t(formatFcfa(v, false))
          : t(String(v)),
    );
    const height =
      Math.max(
        ...texts.map((s, i) => doc.heightOfString(s || ' ', { width: (widths[i] ?? 0) - 6 })),
      ) + 4;
    if (y + height > bottom()) {
      doc.addPage();
      y = 30;
      drawHeader();
      doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    }
    let x = left;
    doc.fillColor(INK);
    texts.forEach((s, i) => {
      const w = widths[i] ?? 0;
      doc.text(s, x + 3, y + 2, {
        width: w - 6,
        align: table.columns[i]?.money ? 'right' : 'left',
      });
      x += w;
    });
    y += height;
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(0.3)
      .strokeColor(RULE)
      .stroke();
  }
  doc
    .fillColor(MUTED)
    .font('Helvetica')
    .fontSize(7)
    .text(
      t(`Édité le ${frDate(new Date().toISOString().slice(0, 10))} · SYSCOHADA révisé`),
      left,
      Math.min(y + 8, bottom()),
      {
        width,
        align: 'right',
      },
    );
  return toBuffer(doc);
}
