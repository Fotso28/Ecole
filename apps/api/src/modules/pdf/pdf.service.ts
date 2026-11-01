import { Injectable, NotFoundException } from '@nestjs/common';
import {
  formatCameroonPhone,
  formatFcfa,
  formatGrade,
  formatRate,
  PAYMENT_METHOD_LABELS,
} from '@ecole/shared';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { env } from '../../config/env';
import { Db, InjectDb } from '../../common/prisma';
import type { ReportCardData } from '../report-cards/report-cards.service';

export const INK = '#12183A';
export const MUTED = '#525A78';
export const RULE = '#8A90A8';
export const NIGHT = '#16205C';
const SPECIAL_SPACES = new RegExp(
  `[${String.fromCharCode(0x202f)}${String.fromCharCode(0xa0)}]`,
  'g',
);

/** Les polices standard PDF ne connaissent pas les espaces fines : on les remplace. */
export function t(s: string | null | undefined): string {
  return (s ?? '').replace(SPECIAL_SPACES, ' ');
}

const money = (n: number) => t(formatFcfa(n));
export const grade = (c: number | null | undefined) =>
  c === null || c === undefined ? '—' : formatGrade(c);
export const frDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');

export function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

@Injectable()
export class PdfService {
  constructor(@InjectDb() private readonly db: Db) {}

  verifyUrl(code: string): string {
    return `${env().PUBLIC_VERIFY_URL}/${code}`;
  }

  private qr(code: string): Promise<Buffer> {
    return QRCode.toBuffer(this.verifyUrl(code), {
      margin: 1,
      width: 160,
      errorCorrectionLevel: 'M',
    });
  }

  /** Bulletin A4 à partir de l'instantané figé. */
  async reportCard(id: string): Promise<Buffer> {
    const card = await this.db.reportCard.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('Bulletin introuvable');
    const data = card.data as unknown as ReportCardData;
    const annual = data.annual;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 30,
      info: {
        Title: `Bulletin ${data.student.lastName} ${data.student.firstName}`,
        Author: data.school.name,
      },
    });
    const W = doc.page.width - 60;
    const left = 30;
    let y = 30;

    // En-tête bilingue.
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8);
    doc.text('RÉPUBLIQUE DU CAMEROUN', left, y, { width: 190, align: 'center' });
    doc.text('REPUBLIC OF CAMEROON', left + W - 190, y, { width: 190, align: 'center' });
    doc.font('Helvetica-Oblique').fontSize(7.5);
    doc.text('Paix – Travail – Patrie', left, y + 11, { width: 190, align: 'center' });
    doc.text('Peace – Work – Fatherland', left + W - 190, y + 11, { width: 190, align: 'center' });
    doc.font('Helvetica').fontSize(7.5);
    doc.text('Ministère des Enseignements Secondaires', left, y + 22, {
      width: 190,
      align: 'center',
    });
    doc.text('Ministry of Secondary Education', left + W - 190, y + 22, {
      width: 190,
      align: 'center',
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(t(data.school.name.toUpperCase()), left + 190, y + 4, {
        width: W - 380,
        align: 'center',
      });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(t(data.school.city), left + 190, y + 22, { width: W - 380, align: 'center' });
    y += 40;
    doc
      .moveTo(left, y)
      .lineTo(left + W, y)
      .lineWidth(1.5)
      .strokeColor(NIGHT)
      .stroke();
    y += 8;

    // Titre.
    doc.rect(left, y, W, 22).fill('#E8EDFB');
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(
        t(
          `${annual ? 'BULLETIN DE FIN D’ANNÉE' : 'BULLETIN DE NOTES'} · ${data.term.name.toUpperCase()}`,
        ),
        left + 8,
        y + 6,
      );
    doc
      .fontSize(9)
      .text(`Année scolaire ${data.year}`, left + 8, y + 7, { width: W - 16, align: 'right' });
    y += 30;

    // Identité.
    doc.rect(left, y, W, 46).lineWidth(0.8).strokeColor(RULE).stroke();
    const idCell = (label: string, value: string, x: number, yy: number, w: number) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, x, yy, { width: w });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(t(value), x, yy + 9, { width: w });
    };
    const cw = W / 4;
    idCell(
      'Nom et prénoms',
      `${data.student.lastName.toUpperCase()} ${data.student.firstName}`,
      left + 6,
      y + 4,
      cw * 2 - 10,
    );
    idCell('Matricule', data.student.matricule, left + cw * 2, y + 4, cw - 6);
    idCell(
      'Classe · effectif',
      `${data.class.name} · ${data.class.size} élèves`,
      left + cw * 3,
      y + 4,
      cw - 6,
    );
    idCell(
      'Né(e) le',
      `${frDate(data.student.birthDate)}${data.student.birthPlace ? ` à ${data.student.birthPlace}` : ''}`,
      left + 6,
      y + 25,
      cw * 2 - 10,
    );
    idCell(
      'Sexe · redoublant(e)',
      `${data.student.gender} · ${data.student.repeating ? 'Oui' : 'Non'}`,
      left + cw * 2,
      y + 25,
      cw - 6,
    );
    idCell('Professeur principal', data.class.mainTeacher ?? '—', left + cw * 3, y + 25, cw - 6);
    y += 54;

    // Tableau des notes. Au dernier trimestre, les moyennes des trimestres précédents et la
    // moyenne annuelle remplacent la colonne de l'enseignant.
    const seqCols = data.sequences.length;
    const pastTerms = annual ? annual.terms.filter((tm) => tm.id !== data.term.id) : [];
    const cols = [
      { key: 'subject', label: 'Matière', w: 0, align: 'left' as const },
      ...(annual ? [] : [{ key: 'teacher', label: 'Enseignant', w: 70, align: 'left' as const }]),
      ...data.sequences.map((s, i) => ({
        key: `s${i}`,
        label: s.name.replace('Séquence', 'Séq.'),
        w: 38,
        align: 'right' as const,
      })),
      { key: 'avg', label: 'Moy.', w: 38, align: 'right' as const },
      { key: 'coef', label: 'Coef.', w: 30, align: 'right' as const },
      { key: 'total', label: 'M × C', w: 42, align: 'right' as const },
      { key: 'rank', label: 'Rang', w: 36, align: 'right' as const },
      ...pastTerms.map((tm) => ({
        key: `t${tm.order}`,
        label: `T${tm.order}`,
        w: 34,
        align: 'right' as const,
      })),
      ...(annual ? [{ key: 'annual', label: 'Moy. an.', w: 42, align: 'right' as const }] : []),
      { key: 'app', label: 'Appréciation', w: 70, align: 'left' as const },
    ];
    const fixed = cols.reduce((s, c) => s + c.w, 0);
    cols[0]!.w = W - fixed;
    const rowH = 15;
    const drawRow = (
      values: Record<string, string>,
      opts: { bold?: boolean; fill?: string; height?: number } = {},
    ) => {
      const h = opts.height ?? rowH;
      if (opts.fill) doc.rect(left, y, W, h).fill(opts.fill);
      let x = left;
      for (const c of cols) {
        doc.rect(x, y, c.w, h).lineWidth(0.6).strokeColor(RULE).stroke();
        doc
          .fillColor(INK)
          .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8);
        doc.text(t(values[c.key] ?? ''), x + 3, y + (h - 8) / 2, {
          width: c.w - 6,
          align: c.align,
          lineBreak: false,
          ellipsis: true,
        });
        x += c.w;
      }
      y += h;
    };
    drawRow(Object.fromEntries(cols.map((c) => [c.key, c.label])), {
      bold: true,
      fill: '#EFF1F6',
      height: 17,
    });
    for (const g of data.groups) {
      doc.rect(left, y, W, 14).fill('#F8F9FC');
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
          teacher: s.teacher ?? '',
          avg: grade(s.averageCenti),
          coef: String(s.coefficient),
          total: grade(s.totalCenti),
          rank: s.rank,
          app: s.appreciation ?? '',
        };
        for (let i = 0; i < seqCols; i++) values[`s${i}`] = grade(s.sequenceAverages[i]);
        if (annual) {
          annual.terms.forEach((tm, i) => {
            values[`t${tm.order}`] = grade(s.termAverages?.[i]);
          });
          values.annual = grade(s.annualAverageCenti);
        }
        drawRow(values);
      }
      drawRow(
        {
          subject: 'Bilan du groupe',
          avg: grade(g.averageCenti),
          coef: String(g.totalCoefficient),
          total: grade(g.totalPointsCenti),
        },
        { bold: true, fill: '#F8F9FC' },
      );
    }
    drawRow(
      {
        subject: 'Totaux',
        coef: String(data.totals.totalCoefficient),
        total: grade(data.totals.totalPointsCenti),
      },
      { bold: true, fill: '#E8EDFB', height: 17 },
    );
    y += 8;

    // Résultats, assiduité, décision.
    const boxH = 92;
    const bw = (W - 16) / 3;
    doc.rect(left, y, bw, boxH).lineWidth(1.5).strokeColor(NIGHT).stroke();
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('RÉSULTATS', left + 8, y + 6);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(grade(data.totals.generalAverageCenti), left + 8, y + 18, { continued: true });
    doc.font('Helvetica').fontSize(9).text(' / 20');
    doc
      .fontSize(8)
      .text(
        data.totals.rank === null
          ? 'Non classé (aucune moyenne)'
          : `Rang ${data.totals.rankLabel} sur ${data.totals.ranked}`,
        left + 8,
        y + 44,
      );
    doc.text(
      `Classe : ${grade(data.classStats.averageCenti)} · extrêmes ${grade(data.classStats.minCenti)} et ${grade(data.classStats.maxCenti)}`,
      left + 8,
      y + 56,
      { width: bw - 16 },
    );
    doc.text(
      data.sequenceGeneralAverages
        .map((a, i) => `${data.sequences[i]?.name ?? ''} : ${grade(a)}`)
        .join(' · '),
      left + 8,
      y + 70,
      { width: bw - 16 },
    );

    const ax = left + bw + 8;
    doc.rect(ax, y, bw, boxH).lineWidth(0.8).strokeColor(RULE).stroke();
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('ASSIDUITÉ', ax + 8, y + 6);
    const line = (label: string, value: string, yy: number) => {
      doc
        .fillColor(INK)
        .font('Helvetica')
        .fontSize(8)
        .text(label, ax + 8, yy, { width: bw - 60 });
      doc.font('Helvetica-Bold').text(value, ax + bw - 58, yy, { width: 50, align: 'right' });
    };
    line('Absences justifiées', `${data.attendance.justifiedHours} h`, y + 22);
    line('Absences non justifiées', `${data.attendance.unjustifiedHours} h`, y + 36);
    line('Retards', String(data.attendance.lates), y + 50);
    line('Incidents', String(data.attendance.incidents), y + 64);

    const dx = left + 2 * (bw + 8);
    doc.rect(dx, y, bw, boxH).lineWidth(0.8).strokeColor(RULE).stroke();
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('DÉCISION DU CONSEIL', dx + 8, y + 6);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(t(data.decision?.label ?? 'En attente du conseil de classe'), dx + 8, y + 22, {
        width: bw - 16,
      });
    if (data.decision?.comment)
      doc
        .font('Helvetica')
        .fontSize(8)
        .text(t(data.decision.comment), dx + 8, y + 38, { width: bw - 16 });
    if (data.totals.appreciation)
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(MUTED)
        .text(`Appréciation générale : ${t(data.totals.appreciation)}`, dx + 8, y + boxH - 18, {
          width: bw - 16,
        });
    y += boxH + 8;

    // Bilan annuel (bulletin du dernier trimestre).
    if (annual) {
      const annualH = 50;
      doc.rect(left, y, W, annualH).fill('#E8EDFB');
      doc.rect(left, y, W, annualH).lineWidth(1.5).strokeColor(NIGHT).stroke();
      doc
        .fillColor(NIGHT)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text('BILAN ANNUEL', left + 8, y + 6);
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(16)
        .text(grade(annual.generalAverageCenti), left + 8, y + 18, { continued: true });
      doc.font('Helvetica').fontSize(9).text(' / 20');
      doc
        .fontSize(8)
        .text(
          annual.rank === null
            ? 'Non classé sur l’année'
            : `Rang annuel ${annual.rankLabel} sur ${annual.ranked}`,
          left + 8,
          y + 37,
          { width: 150 },
        );
      const midX = left + 150;
      const midW = W * 0.58 - 158;
      doc.text(
        annual.terms
          .map((tm, i) => `T${tm.order} : ${grade(annual.termGeneralAverages[i])}`)
          .join(' · '),
        midX,
        y + 8,
        { width: midW },
      );
      if (annual.missingTerms.length)
        doc.text(t(`Sans moyenne : ${annual.missingTerms.join(', ')}`), midX, y + 21, {
          width: midW,
        });
      doc.text(
        `Classe : ${grade(annual.classStats.averageCenti)} · réussite ${t(formatRate(annual.classPassRatePermille))}`,
        midX,
        y + 34,
        { width: midW },
      );
      const yx = left + W * 0.58;
      doc
        .fillColor(NIGHT)
        .font('Helvetica-Bold')
        .fontSize(8)
        .text('DÉCISION DE FIN D’ANNÉE', yx, y + 6, { width: W * 0.42 - 8 });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(t(data.yearEndDecision?.label ?? 'En attente du conseil de classe'), yx, y + 20, {
          width: W * 0.42 - 8,
        });
      y += annualH + 14;
    } else {
      y += 6;
    }

    // Signatures.
    const sw = (W - 16) / 3;
    ['Le professeur principal', 'Le parent ou tuteur', "Le chef d'établissement"].forEach(
      (label, i) => {
        const sx = left + i * (sw + 8);
        doc
          .moveTo(sx, y)
          .lineTo(sx + sw, y)
          .lineWidth(0.8)
          .strokeColor(RULE)
          .stroke();
        doc
          .fillColor(INK)
          .font('Helvetica-Bold')
          .fontSize(8)
          .text(label, sx, y + 4, { width: sw, align: 'center' });
      },
    );

    // Pied de page : QR et version.
    const footY = doc.page.height - 30 - 60;
    doc
      .moveTo(left, footY - 6)
      .lineTo(left + W, footY - 6)
      .lineWidth(0.8)
      .strokeColor(RULE)
      .stroke();
    doc.image(await this.qr(card.verificationCode), left, footY, { width: 56 });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(
        `Document vérifiable · code ${card.verificationCode} · version ${card.version}`,
        left + 66,
        footY + 10,
      );
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        card.status === 'DRAFT'
          ? 'BROUILLON — document non publié, sans valeur officielle.'
          : `Scannez le code ou rendez-vous sur ${this.verifyUrl(card.verificationCode)} pour contrôler l’authenticité. Toute correction après publication produit une nouvelle version numérotée.`,
        left + 66,
        footY + 24,
        { width: W - 70 },
      );
    if (card.status === 'DRAFT') {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .fillColor('#B3261E')
        .opacity(0.12)
        .font('Helvetica-Bold')
        .fontSize(90)
        .text('BROUILLON', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
      doc.restore();
    }
    return toBuffer(doc);
  }

  /** Reçu de paiement (A5). */
  async receipt(paymentId: string): Promise<Buffer> {
    const payment = await this.db.payment.findUnique({
      where: { id: paymentId },
      include: { receipt: true, allocations: { include: { invoiceLine: true } } },
    });
    if (!payment?.receipt) throw new NotFoundException('Reçu introuvable');
    const [student, school, enrollment] = await Promise.all([
      this.db.student.findUniqueOrThrow({ where: { id: payment.studentId } }),
      this.db.school.findUniqueOrThrow({ where: { id: payment.schoolId } }),
      this.db.enrollment.findFirst({
        where: { studentId: payment.studentId },
        orderBy: { createdAt: 'desc' },
        include: { class: true },
      }),
    ]);
    const doc = new PDFDocument({
      size: 'A5',
      margin: 28,
      info: { Title: `Reçu ${payment.receipt.number}`, Author: school.name },
    });
    const left = 28;
    const W = doc.page.width - 56;
    let y = 28;
    doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(13).text(t(school.name), left, y);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(t([school.city, school.phone].filter(Boolean).join(' · ')), left, y + 17);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text('REÇU DE PAIEMENT', left, y, { width: W, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(9)
      .text(`N° ${payment.receipt.number}`, left, y + 15, { width: W, align: 'right' });
    y += 40;
    doc
      .moveTo(left, y)
      .lineTo(left + W, y)
      .lineWidth(1)
      .strokeColor(NIGHT)
      .stroke();
    y += 12;
    const row = (label: string, value: string) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(label, left, y, { width: 120 });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(t(value), left + 120, y, { width: W - 120 });
      y += 16;
    };
    row(
      'Date',
      new Date(payment.confirmedAt ?? payment.createdAt).toLocaleString('fr-FR', {
        timeZone: 'Africa/Douala',
      }),
    );
    row('Élève', `${student.lastName.toUpperCase()} ${student.firstName}`);
    row(
      'Matricule · classe',
      `${student.matricule}${enrollment ? ` · ${enrollment.class.name}` : ''}`,
    );
    row('Moyen de paiement', PAYMENT_METHOD_LABELS[payment.method]);
    if (payment.operatorReference) row('Référence opérateur', payment.operatorReference);
    if (payment.bankReference)
      row('Bordereau', `${payment.bankName ?? ''} ${payment.bankReference}`.trim());
    if (payment.payerPhone) row('Payeur', formatCameroonPhone(payment.payerPhone));
    y += 4;
    doc.rect(left, y, W, 34).fill('#E8EDFB');
    doc
      .fillColor(NIGHT)
      .font('Helvetica')
      .fontSize(9)
      .text('Montant reçu', left + 10, y + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(money(payment.amount), left + 10, y + 9, { width: W - 20, align: 'right' });
    y += 46;
    if (payment.allocations.length > 0) {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('IMPUTATION', left, y);
      y += 12;
      for (const a of payment.allocations) {
        doc
          .fillColor(INK)
          .font('Helvetica')
          .fontSize(9)
          .text(t(a.invoiceLine.label), left, y, { width: W - 100 });
        doc.text(money(a.amount), left, y, { width: W, align: 'right' });
        y += 14;
      }
    }
    const footY = doc.page.height - 28 - 64;
    doc.image(await this.qr(payment.receipt.verificationCode), left, footY, { width: 60 });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(`Code de vérification : ${payment.receipt.verificationCode}`, left + 70, footY + 12);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        'Un paiement enregistré ne peut être ni modifié ni supprimé. Toute correction fait l’objet d’une écriture d’annulation tracée.',
        left + 70,
        footY + 26,
        { width: W - 70 },
      );
    if (payment.reversedAt) {
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc
        .fillColor('#B3261E')
        .opacity(0.18)
        .font('Helvetica-Bold')
        .fontSize(64)
        .text('ANNULÉ', 0, doc.page.height / 2 - 32, { width: doc.page.width, align: 'center' });
      doc.restore();
    }
    return toBuffer(doc);
  }
}
