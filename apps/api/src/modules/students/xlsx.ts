import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';

/** Colonnes du fichier d'import des élèves (CSV ou Excel). */
export const IMPORT_COLUMNS: { key: string; label: string; example: string; width: number }[] = [
  { key: 'nom', label: 'Nom de famille de l’élève (obligatoire)', example: 'Atangana', width: 18 },
  { key: 'prenoms', label: 'Prénoms (obligatoire)', example: 'Cédric', width: 18 },
  { key: 'sexe', label: 'F ou M (obligatoire)', example: 'M', width: 8 },
  {
    key: 'date_naissance',
    label: 'Date de naissance, JJ/MM/AAAA (obligatoire)',
    example: '04/07/2013',
    width: 16,
  },
  { key: 'lieu_naissance', label: 'Lieu de naissance', example: 'Yaoundé', width: 16 },
  {
    key: 'parent_nom',
    label: 'Nom du parent ou tuteur (obligatoire)',
    example: 'Atangana',
    width: 18,
  },
  { key: 'parent_prenom', label: 'Prénom du parent (obligatoire)', example: 'Joseph', width: 18 },
  {
    key: 'parent_telephone',
    label: 'Téléphone camerounais du parent (obligatoire)',
    example: '677000101',
    width: 18,
  },
  { key: 'lien', label: 'Père, Mère, Tuteur ou Autre', example: 'Père', width: 10 },
];

/** Nombre maximal de lignes lues dans un fichier, pour borner le temps de traitement. */
export const MAX_IMPORT_ROWS = 2000;

/** En-tête normalisé : minuscules, sans accents, espaces remplacées par « _ ». */
export function normalizeImportHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Valeur d'une cellule Excel en texte : dates au format JJ/MM/AAAA, nombres sans décimales parasites. */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date)
    return `${pad(value.getUTCDate())}/${pad(value.getUTCMonth() + 1)}/${value.getUTCFullYear()}`;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if ('richText' in value)
    return value.richText
      .map((r) => r.text)
      .join('')
      .trim();
  if ('text' in value && typeof value.text === 'string') return value.text.trim();
  if ('result' in value) return cellText((value.result ?? null) as ExcelJS.CellValue);
  return '';
}

/** Lit la première feuille d'un classeur : une ligne par élève, en-têtes en ligne 1. */
export async function readStudentSheet(
  file: Buffer,
): Promise<{ line: number; raw: Record<string, string> }[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new BadRequestException('Fichier Excel illisible : enregistrez-le au format .xlsx');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.actualRowCount < 1) throw new BadRequestException('Le fichier est vide');
  if (sheet.actualRowCount > MAX_IMPORT_ROWS + 1)
    throw new BadRequestException(`Le fichier dépasse ${MAX_IMPORT_ROWS} lignes : découpez-le`);
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = normalizeImportHeader(cellText(cell.value));
  });
  if (!headers.includes('nom'))
    throw new BadRequestException(
      'Colonne « nom » introuvable en ligne 1 : partez du modèle de fichier',
    );
  const rows: { line: number; raw: Record<string, string> }[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, line) => {
    if (line === 1) return;
    const raw: Record<string, string> = {};
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = headers[col];
      if (key) raw[key] = cellText(cell.value);
    });
    if (Object.values(raw).some((v) => v !== '')) rows.push({ line, raw });
  });
  return rows;
}

/** Modèle Excel à télécharger : feuille « Élèves » avec un exemple, et un mode d'emploi. */
export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ecole';
  const sheet = workbook.addWorksheet('Élèves', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = IMPORT_COLUMNS.map((c) => ({
    header: c.key,
    key: c.key,
    width: c.width,
    // Texte : Excel ne transforme ni les dates ni les numéros de téléphone.
    style: { numFmt: '@' },
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(Object.fromEntries(IMPORT_COLUMNS.map((c) => [c.key, c.example])));
  const help = workbook.addWorksheet('Mode d’emploi');
  help.columns = [
    { header: 'Colonne', key: 'key', width: 20 },
    { header: 'Contenu attendu', key: 'label', width: 60 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of IMPORT_COLUMNS) help.addRow({ key: c.key, label: c.label });
  help.addRow({});
  help.addRow({
    key: 'Conseil',
    label:
      'Remplacez la ligne d’exemple, une ligne par élève. Vérifiez d’abord le fichier : rien n’est enregistré tant qu’il reste une erreur.',
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
