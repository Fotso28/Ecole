import { describe, expect, it } from 'vitest';
import {
  checkFile,
  detectFileType,
  fileCheckMessage,
  formatFileSize,
  lessonLogSchema,
  MAX_FILE_BYTES,
  sanitizeFileName,
} from './files';
import { hasPermission, isClassScoped } from './permissions';

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => new TextEncoder().encode(s);

describe('detectFileType', () => {
  it('reconnaît un PDF, un JPEG et un PNG par leur signature', () => {
    expect(detectFileType(text('%PDF-1.7\n...'))).toBe('application/pdf');
    expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image/jpeg');
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      'image/png',
    );
  });

  it('tolère quelques octets avant l’en-tête PDF, mais pas au-delà de 1 Ko', () => {
    expect(detectFileType(text('\n\n  %PDF-1.4'))).toBe('application/pdf');
    expect(detectFileType(text(`${' '.repeat(1100)}%PDF-1.4`))).toBeNull();
  });

  it('refuse les autres contenus, même renommés', () => {
    expect(detectFileType(text('<html><script>alert(1)</script>'))).toBeNull();
    expect(detectFileType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectFileType(bytes(0x4d, 0x5a, 0x90, 0))).toBeNull(); // exécutable Windows
    expect(detectFileType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull(); // zip, docx
    expect(detectFileType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull(); // GIF
    expect(detectFileType(bytes(0xff, 0xd8))).toBeNull(); // JPEG tronqué
    expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // PNG tronqué
    expect(detectFileType(bytes())).toBeNull();
  });
});

describe('checkFile', () => {
  it('accepte un fichier autorisé sous la limite', () => {
    expect(checkFile(text('%PDF-1.7'))).toEqual({ ok: true, type: 'application/pdf' });
  });

  it('refuse un fichier vide, trop volumineux ou d’un type interdit', () => {
    expect(checkFile(bytes())).toEqual({ ok: false, reason: 'empty' });
    expect(checkFile(text('%PDF-1.7 contenu'), 10)).toEqual({ ok: false, reason: 'too_large' });
    expect(checkFile(text('GIF89a'))).toEqual({ ok: false, reason: 'type' });
  });

  it('applique la limite au plus juste', () => {
    const atLimit = new Uint8Array(MAX_FILE_BYTES);
    atLimit.set([0xff, 0xd8, 0xff]);
    expect(checkFile(atLimit).ok).toBe(true);
    const over = new Uint8Array(MAX_FILE_BYTES + 1);
    over.set([0xff, 0xd8, 0xff]);
    expect(checkFile(over)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('explique le refus en français', () => {
    expect(fileCheckMessage('too_large')).toBe('Fichier trop volumineux (10 Mo au maximum)');
    expect(fileCheckMessage('type')).toContain('PDF, JPEG ou PNG');
    expect(fileCheckMessage('empty')).toBe('Le fichier est vide');
  });
});

describe('formatFileSize', () => {
  it('affiche octets, kilo-octets et méga-octets', () => {
    expect(formatFileSize(512)).toBe('512 o');
    expect(formatFileSize(850 * 1024)).toBe('850 Ko');
    expect(formatFileSize(2.44 * 1024 * 1024)).toBe('2,4 Mo');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 Mo');
  });
});

describe('sanitizeFileName', () => {
  it('retire le chemin et les caractères dangereux', () => {
    expect(sanitizeFileName('C:\\Users\\moi\\acte.pdf')).toBe('acte.pdf');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a"b<c>.pdf')).toBe('abc.pdf');
    expect(sanitizeFileName('ligne\r\nentête.pdf')).toBe('ligneentête.pdf');
  });

  it('remplace un nom vide ou réservé', () => {
    expect(sanitizeFileName(undefined)).toBe('fichier');
    expect(sanitizeFileName('..')).toBe('fichier');
    expect(sanitizeFileName('   ', 'photo')).toBe('photo');
  });

  it('limite la longueur en gardant l’extension', () => {
    const long = `${'a'.repeat(300)}.pdf`;
    expect(sanitizeFileName(long)).toHaveLength(120);
    expect(sanitizeFileName(long).endsWith('.pdf')).toBe(true);
  });
});

describe('lessonLogSchema', () => {
  const base = { classSubjectId: 'cs1', date: '2026-10-30', content: 'Théorème de Pythagore' };

  it('accepte une séance sans devoir', () => {
    expect(lessonLogSchema.safeParse(base).success).toBe(true);
  });

  it('exige une date pour le travail à faire, et inversement', () => {
    const noDate = lessonLogSchema.safeParse({ ...base, homework: 'Exercices 1 à 4' });
    expect(noDate.success).toBe(false);
    expect(noDate.error?.issues[0]?.path).toEqual(['homeworkDueDate']);
    const noWork = lessonLogSchema.safeParse({ ...base, homeworkDueDate: '2026-11-02' });
    expect(noWork.error?.issues[0]?.path).toEqual(['homework']);
  });

  it('refuse un travail dû avant la séance', () => {
    const r = lessonLogSchema.safeParse({
      ...base,
      homework: 'Exercices',
      homeworkDueDate: '2026-10-29',
    });
    expect(r.success).toBe(false);
  });

  it('ignore un devoir vide', () => {
    const r = lessonLogSchema.parse({ ...base, homework: '   ' });
    expect(r.homework).toBeUndefined();
  });
});

describe('permissions des nouveaux modules', () => {
  it('cahier de texte : saisi par l’enseignant (limité à ses classes), lu par le censeur', () => {
    expect(hasPermission(['TEACHER'], 'lessons.write')).toBe(true);
    expect(isClassScoped(['TEACHER'], 'lessons.write')).toBe(true);
    expect(hasPermission(['CENSOR'], 'lessons.read')).toBe(true);
    expect(hasPermission(['CENSOR'], 'lessons.write')).toBe(false);
    expect(hasPermission(['DIRECTOR'], 'lessons.read')).toBe(true);
    expect(hasPermission(['ACCOUNTANT'], 'lessons.read')).toBe(false);
  });

  it('pièces d’inscription : secrétariat et direction seulement', () => {
    expect(hasPermission(['SECRETARY'], 'students.documents')).toBe(true);
    expect(hasPermission(['DIRECTOR'], 'students.documents')).toBe(true);
    expect(hasPermission(['TEACHER'], 'students.documents')).toBe(false);
    expect(hasPermission(['CENSOR'], 'students.documents')).toBe(false);
    expect(hasPermission(['NURSE'], 'students.documents')).toBe(false);
  });
});
