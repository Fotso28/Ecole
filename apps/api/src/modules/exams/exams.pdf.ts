import PDFDocument from 'pdfkit';
import { frDate, INK, MUTED, NIGHT, RULE, t, toBuffer } from '../pdf/pdf.service';
import type { ExamsService } from './exams.service';

type Convocations = Awaited<ReturnType<ExamsService['convocations']>>;
type Sheets = Awaited<ReturnType<ExamsService['attendanceSheets']>>;

const duration = (minutes: number) =>
  minutes % 60 === 0
    ? `${minutes / 60} h`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;

/** Convocations A4, deux par page (demi-feuilles à découper) : salle, place et calendrier. */
export function renderConvocations(data: Convocations): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 30,
    info: { Title: `Convocations · ${data.session.name}`, Author: data.school.name },
  });
  const left = 30;
  const W = doc.page.width - 60;
  const half = doc.page.height / 2;

  data.items.forEach((item, index) => {
    if (index > 0 && index % 2 === 0) doc.addPage();
    const top = index % 2 === 0 ? 30 : half + 20;
    let y = top;
    doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(12).text(t(data.school.name), left, y);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(t(`${data.school.city} · Année scolaire ${data.year}`), left, y + 15);
    y += 30;
    doc.rect(left, y, W, 22).fill('#E8EDFB');
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(t(`CONVOCATION · ${data.session.name.toUpperCase()}`), left + 8, y + 6, {
        width: W - 16,
      });
    y += 30;

    const cell = (label: string, value: string, x: number, w: number) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, x, y, { width: w });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(t(value), x, y + 9, { width: w });
    };
    cell('Élève', item.name, left, W * 0.45);
    cell('Matricule', item.matricule, left + W * 0.45, W * 0.2);
    cell('Classe', item.className, left + W * 0.65, W * 0.15);
    cell('Né(e) le', frDate(item.birthDate), left + W * 0.8, W * 0.2);
    y += 30;

    // Salle et place, en gros : le candidat doit les repérer d'un coup d'œil.
    doc.rect(left, y, W, 36).lineWidth(1).strokeColor(NIGHT).stroke();
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text('Salle', left + 10, y + 5);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(t(item.room || 'À préciser'), left + 10, y + 15, { width: W / 2 - 20 });
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text('Place n°', left + W / 2, y + 5);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(16)
      .text(item.seat ? String(item.seat) : '—', left + W / 2, y + 15);
    y += 46;

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text('Calendrier des épreuves', left, y);
    y += 14;
    const cols = [
      { label: 'Date', w: W * 0.22 },
      { label: 'Horaire', w: W * 0.22 },
      { label: 'Durée', w: W * 0.14 },
      { label: 'Épreuve', w: W * 0.42 },
    ];
    doc.rect(left, y, W, 14).fill('#F1F3F8');
    let x = left;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5);
    for (const c of cols) {
      doc.text(c.label, x + 4, y + 4, { width: c.w - 8 });
      x += c.w;
    }
    y += 14;
    const limit = top + half - 90;
    for (const p of item.papers) {
      if (y > limit) {
        doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.5);
        doc.text('Calendrier complet affiché dans l’établissement.', left + 4, y + 3);
        y += 13;
        break;
      }
      x = left;
      doc.fillColor(INK).font('Helvetica').fontSize(8.5);
      const values = [
        frDate(p.date),
        `${p.startTime} – ${p.endTime}`,
        duration(p.durationMinutes),
        p.subject,
      ];
      values.forEach((v, i) => {
        doc.text(t(v), x + 4, y + 3, { width: cols[i]!.w - 8, lineBreak: false });
        x += cols[i]!.w;
      });
      y += 13;
      doc
        .moveTo(left, y)
        .lineTo(left + W, y)
        .lineWidth(0.4)
        .strokeColor(RULE)
        .stroke();
    }
    y += 8;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        t(
          'Présentez-vous 15 minutes avant chaque épreuve avec cette convocation. Téléphones et documents non autorisés sont interdits en salle.',
        ),
        left,
        y,
        { width: W },
      );
    if (index % 2 === 0 && index + 1 < data.items.length) {
      doc
        .moveTo(left, half)
        .lineTo(left + W, half)
        .dash(4, { space: 4 })
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke()
        .undash();
    }
  });
  return toBuffer(doc);
}

/** Listes d'émargement A4 : une page par salle pour une épreuve. */
export function renderAttendanceSheets(data: Sheets): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 30,
    info: {
      Title: `Émargement · ${data.session} · ${data.paper.subject}`,
      Author: data.school.name,
    },
  });
  const left = 30;
  const W = doc.page.width - 60;
  const bottom = doc.page.height - 90;
  const cols = [
    { label: 'Place', w: W * 0.08 },
    { label: 'Nom et prénoms', w: W * 0.38 },
    { label: 'Matricule', w: W * 0.16 },
    { label: 'Classe', w: W * 0.12 },
    { label: 'Signature', w: W * 0.26 },
  ];

  const header = (room: Sheets['rooms'][number], continued: boolean) => {
    let y = 30;
    doc.fillColor(NIGHT).font('Helvetica-Bold').fontSize(12).text(t(data.school.name), left, y);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text(t(data.school.city), left, y + 15);
    y += 30;
    doc.rect(left, y, W, 22).fill('#E8EDFB');
    doc
      .fillColor(NIGHT)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(t(`LISTE D’ÉMARGEMENT · ${room.name}${continued ? ' (suite)' : ''}`), left + 8, y + 6, {
        width: W - 16,
      });
    y += 30;
    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(9)
      .text(
        t(
          `${data.session} · ${data.paper.subject} · ${frDate(data.paper.date)} · ${data.paper.startTime} – ${data.paper.endTime}`,
        ),
        left,
        y,
      );
    y += 13;
    doc
      .fillColor(MUTED)
      .fontSize(8.5)
      .text(
        t(`Surveillance : ${room.supervisors.length ? room.supervisors.join(', ') : 'à désigner'}`),
        left,
        y,
      );
    y += 18;
    doc.rect(left, y, W, 16).fill('#F1F3F8');
    let x = left;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.label, x + 4, y + 4, { width: c.w - 8 });
      x += c.w;
    }
    return y + 16;
  };

  if (data.rooms.length === 0) {
    doc.font('Helvetica').fontSize(11).fillColor(INK).text('Aucun candidat pour cette épreuve.');
  }
  data.rooms.forEach((room, ri) => {
    if (ri > 0) doc.addPage();
    let y = header(room, false);
    for (const c of room.candidates) {
      if (y + 22 > bottom) {
        doc.addPage();
        y = header(room, true);
      }
      let x = left;
      const values = [c.seat ? String(c.seat) : '', c.name, c.matricule, c.className, ''];
      doc.fillColor(INK).font('Helvetica').fontSize(9);
      values.forEach((v, i) => {
        doc.text(t(v), x + 4, y + 7, { width: cols[i]!.w - 8, lineBreak: false });
        x += cols[i]!.w;
      });
      y += 22;
      doc
        .moveTo(left, y)
        .lineTo(left + W, y)
        .lineWidth(0.4)
        .strokeColor(RULE)
        .stroke();
    }
    y += 14;
    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(9)
      .text(
        t(
          `Inscrits : ${room.candidates.length}    Présents : ______    Absents : ______    Copies remises : ______`,
        ),
        left,
        y,
      );
    doc.text('Signature des surveillants :', left, y + 22);
  });
  return toBuffer(doc);
}
