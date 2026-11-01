import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { PdfService } from '../pdf/pdf.service';
import type { AdminDocumentData } from './documents.service';

const INK = '#12183A';
const MUTED = '#525A78';
const RULE = '#8A90A8';
const NIGHT = '#16205C';
const DANGER = '#B3261E';
const SPECIAL_SPACES = new RegExp(
  `[${String.fromCharCode(0x202f)}${String.fromCharCode(0xa0)}]`,
  'g',
);

/** Les polices standard PDF ne connaissent pas les espaces fines : on les remplace. */
const t = (s: string | null | undefined) => (s ?? '').replace(SPECIAL_SPACES, ' ');
const frDate = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const longDate = (d: Date) =>
  new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Douala',
  }).format(d);

const DEFAULT_HEADER = [
  'RÉPUBLIQUE DU CAMEROUN',
  'Paix – Travail – Patrie',
  'Ministère des Enseignements Secondaires',
];

export interface RenderableDocument {
  type: 'SCHOOL_CERTIFICATE' | 'ENROLLMENT_ATTESTATION' | 'STUDENT_CARD';
  number: string;
  verificationCode: string;
  status: 'ISSUED' | 'CANCELLED';
  issuedAt: Date;
  data: AdminDocumentData;
  /** Photo d'identité en clair (JPEG ou PNG), absente si retirée ou sans consentement. */
  photo?: Buffer | null;
  /** Aperçu d'un modèle : filigrane « SPÉCIMEN », aucun numéro du registre consommé. */
  specimen?: boolean;
}

/** Qualité du signataire au milieu d'une phrase : « Je soussigné(e), le Chef d'établissement ». */
export function titleInSentence(title: string): string {
  return title.replace(/^(Le |La |Les |L’|L')/, (article) => article.toLowerCase());
}

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function watermark(doc: PDFKit.PDFDocument, text: string, size: number, opacity: number) {
  doc.save();
  doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
  doc
    .fillColor(DANGER)
    .opacity(opacity)
    .font('Helvetica-Bold')
    .fontSize(size)
    .text(text, 0, doc.page.height / 2 - size / 2, { width: doc.page.width, align: 'center' });
  doc.restore();
}

/** PDF des documents administratifs (certificat, attestation, carte d'élève). */
@Injectable()
export class DocumentsPdf {
  constructor(private readonly pdf: PdfService) {}

  private qr(code: string, width: number): Promise<Buffer> {
    return QRCode.toBuffer(this.pdf.verifyUrl(code), {
      margin: 1,
      width,
      errorCorrectionLevel: 'M',
    });
  }

  render(d: RenderableDocument): Promise<Buffer> {
    return d.type === 'STUDENT_CARD' ? this.card(d) : this.letter(d);
  }

  /** Certificat de scolarité ou attestation d'inscription (A4). */
  private async letter(d: RenderableDocument): Promise<Buffer> {
    const { data } = d;
    const s = data.student;
    const female = s.gender === 'F';
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `${t(data.template.title)} ${d.number}`, Author: t(data.school.name) },
    });
    const left = 50;
    const W = doc.page.width - 100;
    let y = 50;

    // En-tête officiel configurable, à gauche ; établissement à droite.
    const header = data.template.headerLines.length ? data.template.headerLines : DEFAULT_HEADER;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5);
    header.forEach((line, i) => {
      doc
        .font(i === 0 ? 'Helvetica-Bold' : 'Helvetica')
        .text(t(line), left, y + i * 12, { width: 230, align: 'center' });
    });
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(t(data.school.name.toUpperCase()), left + W - 230, y, { width: 230, align: 'center' });
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        t([data.school.address, data.school.city, data.school.phone].filter(Boolean).join(' · ')),
        left + W - 230,
        y + 18,
        { width: 230, align: 'center' },
      );
    y += Math.max(header.length * 12, 40) + 14;
    doc
      .moveTo(left, y)
      .lineTo(left + W, y)
      .lineWidth(1.5)
      .strokeColor(NIGHT)
      .stroke();
    y += 10;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(9)
      .text(`N° ${d.number}`, left, y, { width: W, align: 'right' });
    y += 34;

    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(t(data.template.title), left, y, { width: W, align: 'center' });
    y += 34;
    if (data.duplicateOf) {
      doc.rect(left + W / 2 - 140, y, 280, 22).fill('#FBEFD9');
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`DUPLICATA de l’original n° ${data.duplicateOf.number}`, left + W / 2 - 140, y + 6, {
          width: 280,
          align: 'center',
        });
      y += 34;
    }
    y += 16;

    const signatory = data.template.signatoryName
      ? `${data.template.signatoryName}, ${titleInSentence(data.template.signatoryTitle)}`
      : titleInSentence(data.template.signatoryTitle);
    const name = `${s.lastName.toUpperCase()} ${s.firstName}`;
    const born = `${female ? 'née' : 'né'} le ${frDate(s.birthDate)}${s.birthPlace ? ` à ${s.birthPlace}` : ''}`;
    const repeating =
      data.enrollmentStatus === 'REPEATING' ? ` (${female ? 'redoublante' : 'redoublant'})` : '';
    const paragraph =
      d.type === 'SCHOOL_CERTIFICATE'
        ? `Je soussigné(e), ${signatory} du ${data.school.name}, certifie que l’élève ${name}, ${born}, de nationalité ${s.nationality.toLowerCase()}, matricule ${s.matricule}, est ${female ? 'régulièrement inscrite' : 'régulièrement inscrit'} et suit les cours en classe de ${data.class.name}${repeating} au titre de l’année scolaire ${data.year.name}.`
        : `Je soussigné(e), ${signatory} du ${data.school.name}, atteste que l’élève ${name}, ${born}, matricule ${s.matricule}, a été ${female ? 'inscrite' : 'inscrit'} dans notre établissement en classe de ${data.class.name}${repeating} pour l’année scolaire ${data.year.name}, qui s’étend du ${frDate(data.year.startDate)} au ${frDate(data.year.endDate)}.`;
    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(12)
      .text(t(paragraph), left, y, { width: W, align: 'justify', lineGap: 6 });
    y = doc.y + 18;
    doc.text(t(data.template.mentions), left, y, { width: W, align: 'justify', lineGap: 6 });
    y = doc.y + 36;

    doc
      .font('Helvetica')
      .fontSize(11)
      .text(t(`Fait à ${data.school.city}, le ${longDate(d.issuedAt)}`), left + W / 2, y, {
        width: W / 2,
        align: 'center',
      });
    y += 22;
    doc
      .font('Helvetica-Bold')
      .text(t(data.template.signatoryTitle), left + W / 2, y, { width: W / 2, align: 'center' });
    if (data.template.signatoryName)
      doc.font('Helvetica').text(t(data.template.signatoryName), left + W / 2, y + 70, {
        width: W / 2,
        align: 'center',
      });

    // Pied de page : QR de vérification publique.
    const footY = doc.page.height - 50 - 64;
    doc
      .moveTo(left, footY - 8)
      .lineTo(left + W, footY - 8)
      .lineWidth(0.8)
      .strokeColor(RULE)
      .stroke();
    doc.image(await this.qr(d.verificationCode, 160), left, footY, { width: 60 });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text(`Document vérifiable · code ${d.verificationCode}`, left + 70, footY + 10);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(
        `Scannez le code ou rendez-vous sur ${this.pdf.verifyUrl(d.verificationCode)} pour contrôler l’authenticité de ce document. Un document annulé y apparaît comme tel.`,
        left + 70,
        footY + 24,
        { width: W - 70 },
      );
    if (d.status === 'CANCELLED') watermark(doc, 'ANNULÉ', 110, 0.16);
    if (d.specimen) watermark(doc, 'SPÉCIMEN', 100, 0.14);
    return toBuffer(doc);
  }

  /** Carte d'élève au format carte bancaire (85,6 × 54 mm). */
  private async card(d: RenderableDocument): Promise<Buffer> {
    const { data } = d;
    const s = data.student;
    const doc = new PDFDocument({
      size: [242.65, 153.07],
      margin: 0,
      info: { Title: `Carte d’élève ${d.number}`, Author: t(data.school.name) },
    });
    const W = doc.page.width;
    const H = doc.page.height;
    // En-tête officiel du modèle (ministère, délégation…), sur une ligne au-dessus du nom.
    const header = data.template.headerLines.filter(Boolean);
    const shift = header.length ? 8 : 0;
    doc.rect(0, 0, W, 30 + shift).fill(NIGHT);
    if (header.length)
      doc
        .fillColor('#FFFFFF')
        .font('Helvetica')
        .fontSize(5)
        .text(t(header.join(' · ')), 8, 4, { width: W - 16, lineBreak: false, ellipsis: true });
    doc
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(t(data.school.name.toUpperCase()), 8, 6 + shift, {
        width: W - 16,
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .font('Helvetica')
      .fontSize(6.5)
      .text(
        t(`${data.template.title}${data.duplicateOf ? ' · DUPLICATA' : ''} · ${data.year.name}`),
        8,
        18 + shift,
        { width: W - 16, lineBreak: false, ellipsis: true },
      );

    // Photo d'identité, ou cadre vide sans consentement.
    const px = 8;
    const py = 36 + shift / 2;
    let photoDrawn = false;
    if (d.photo) {
      try {
        doc.image(d.photo, px, py, { fit: [52, 64], align: 'center', valign: 'center' });
        photoDrawn = true;
      } catch {
        // Image illisible : le cadre vide reste imprimé.
      }
    }
    doc.rect(px, py, 52, 64).lineWidth(0.6).strokeColor(RULE).stroke();
    if (!photoDrawn)
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(6)
        .text('PHOTO', px, py + 29, { width: 52, align: 'center' });

    const fx = 68;
    let fy = 36 + shift / 2;
    const field = (label: string, value: string) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(5.5).text(label, fx, fy);
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .text(t(value), fx, fy + 6, { width: W - fx - 50, lineBreak: false, ellipsis: true });
      fy += 16;
    };
    field('Nom et prénoms', `${s.lastName.toUpperCase()} ${s.firstName}`);
    field(
      s.gender === 'F' ? 'Née le' : 'Né le',
      `${frDate(s.birthDate)}${s.birthPlace ? ` à ${s.birthPlace}` : ''}`,
    );
    field('Classe', data.class.name);
    field('Matricule', s.matricule);

    doc.image(await this.qr(d.verificationCode, 120), W - 46, 38 + shift / 2, { width: 40 });
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(5)
      .text(d.verificationCode, W - 48, 79 + shift / 2, { width: 44, align: 'center' });

    doc
      .moveTo(8, H - 26)
      .lineTo(W - 8, H - 26)
      .lineWidth(0.4)
      .strokeColor(RULE)
      .stroke();
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(5.5)
      .text(`N° ${d.number}`, 8, H - 21, { width: W / 2 });
    doc.text(t(data.template.mentions), 8, H - 13, {
      width: W / 2 + 10,
      lineBreak: false,
      ellipsis: true,
    });
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(5.5)
      .text(t(data.template.signatoryTitle), W / 2 + 20, H - 21, {
        width: W / 2 - 28,
        align: 'right',
      });
    if (data.template.signatoryName)
      doc.font('Helvetica').text(t(data.template.signatoryName), W / 2 + 20, H - 13, {
        width: W / 2 - 28,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });
    if (d.status === 'CANCELLED') watermark(doc, 'ANNULÉE', 40, 0.25);
    if (d.specimen) watermark(doc, 'SPÉCIMEN', 36, 0.2);
    return toBuffer(doc);
  }
}
