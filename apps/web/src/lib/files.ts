import { checkFile, fileCheckMessage, MAX_FILE_BYTES } from '@ecole/shared';

/** Au-delà de ce poids, une photo est réduite avant l'envoi (réseaux mobiles lents). */
export const COMPRESS_ABOVE_BYTES = 1.5 * 1024 * 1024;
/** Plus grand côté d'une photo réduite, en pixels : reste lisible pour un acte ou un certificat. */
export const MAX_PHOTO_SIDE = 2000;

/** Dimensions réduites en gardant les proportions, sans jamais agrandir. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE) {
  const ratio = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function compressPhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    );
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

/**
 * Prépare un fichier avant l'envoi : vérifie son type réel (l'API le revérifie), réduit les photos
 * lourdes prises au téléphone, puis contrôle la taille. Lève une erreur au message lisible.
 */
export async function prepareUpload(file: File): Promise<File> {
  const head = new Uint8Array(await file.slice(0, 1100).arrayBuffer());
  const first = checkFile(head.length ? head : new Uint8Array(), Number.MAX_SAFE_INTEGER);
  if (!first.ok) throw new Error(fileCheckMessage(first.reason));
  let ready = file;
  if (first.type !== 'application/pdf' && file.size > COMPRESS_ABOVE_BYTES)
    ready = await compressPhoto(file);
  if (ready.size > MAX_FILE_BYTES) throw new Error(fileCheckMessage('too_large'));
  return ready;
}
