import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { checkFile, fileCheckMessage, sanitizeFileName, type AllowedFileType } from '@ecole/shared';
import { createHash } from 'node:crypto';
import type { FileCategory, StoredFile } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { currentActorId, currentSchoolId, runAsSystem } from '../../common/context';
import {
  decryptBuffer,
  encryptBuffer,
  hmacSha256,
  randomToken,
  safeEqual,
} from '../../common/crypto';
import { Db, InjectDb, Tx } from '../../common/prisma';
import { env } from '../../config/env';
import { FILE_STORAGE, type FileStorage } from './storage.provider';

/** Fichier reçu par l'API (champ `file` d'un formulaire multipart). */
export interface UploadedFile {
  buffer: Buffer;
  originalname?: string;
  size: number;
}

export interface FileLink {
  url: string;
  expiresAt: string;
  name: string;
  mimeType: string;
  size: number;
}

/** Catégories chiffrées au repos : pièces d'identité de l'élève et justificatifs (souvent médicaux). */
const ENCRYPTED: ReadonlySet<FileCategory> = new Set(['STUDENT_DOCUMENT', 'JUSTIFICATION']);

const FOLDERS: Record<FileCategory, string> = {
  STUDENT_DOCUMENT: 'eleves',
  JUSTIFICATION: 'justificatifs',
  COURSE_MATERIAL: 'supports',
};

function signingKey(): string {
  return hmacSha256(env().JWT_SECRET, 'ecole-files-v1');
}

/** Présentation d'un fichier dans les réponses de l'API (jamais la clé de stockage). */
export function presentFile(file: StoredFile | null | undefined) {
  if (!file || file.deletedAt) return null;
  return {
    id: file.id,
    name: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
  };
}

@Injectable()
export class FilesService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly audit: AuditService,
  ) {}

  /** Contrôle du fichier reçu : présent, non vide, sous la taille maximale, type réel autorisé. */
  validate(upload: UploadedFile | undefined): AllowedFileType {
    if (!upload?.buffer) throw new BadRequestException('Aucun fichier reçu');
    const max = env().FILE_MAX_BYTES;
    const check = checkFile(upload.buffer, max);
    if (!check.ok) {
      const message = fileCheckMessage(check.reason, max);
      if (check.reason === 'too_large') throw new PayloadTooLargeException(message);
      throw new BadRequestException(message);
    }
    return check.type;
  }

  /**
   * Enregistre le contenu dans le stockage puis la fiche en base (dans `tx` si fournie). Si la
   * transaction échoue ensuite, le contenu reste orphelin dans le stockage, sans fiche ni accès.
   */
  async store(upload: UploadedFile | undefined, category: FileCategory, tx?: Tx) {
    const mimeType = this.validate(upload);
    const buffer = upload!.buffer;
    const schoolId = currentSchoolId();
    const encrypted = ENCRYPTED.has(category);
    const now = new Date();
    const storageKey = `${schoolId}/${FOLDERS[category]}/${now.getUTCFullYear()}/${randomToken(18)}`;
    const body = encrypted ? encryptBuffer(buffer, env().DATA_ENCRYPTION_KEY) : buffer;
    await this.storage.put(storageKey, body, encrypted ? 'application/octet-stream' : mimeType);
    const fallback = mimeType === 'application/pdf' ? 'document.pdf' : 'photo.jpg';
    const file = await (tx ?? this.db).storedFile.create({
      data: {
        schoolId,
        category,
        storageKey,
        originalName: sanitizeFileName(upload!.originalname, fallback),
        mimeType,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        encrypted,
        uploadedById: currentActorId() ?? null,
      },
    });
    await this.audit.log(
      {
        action: 'files.uploaded',
        entity: 'StoredFile',
        entityId: file.id,
        after: { category, mimeType, size: file.size, encrypted },
      },
      tx,
    );
    return file;
  }

  /** Suppression logique : le contenu reste dans le stockage, il n'est plus servi. */
  async softDelete(fileId: string, reason: string, tx?: Tx): Promise<void> {
    const db = tx ?? this.db;
    const file = await db.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt) return;
    await db.storedFile.update({
      where: { id: fileId },
      data: { deletedAt: new Date(), deletedById: currentActorId() ?? null },
    });
    await this.audit.log(
      { action: 'files.deleted', entity: 'StoredFile', entityId: fileId, reason },
      tx,
    );
  }

  /**
   * Lien de consultation de courte durée. À n'appeler qu'après le contrôle des droits sur l'objet
   * auquel le fichier est rattaché. Les fichiers chiffrés sont toujours servis par l'API, qui les
   * déchiffre ; les autres peuvent l'être directement par le stockage S3.
   */
  async link(fileId: string | null | undefined, audit = false): Promise<FileLink> {
    const file = fileId ? await this.db.storedFile.findUnique({ where: { id: fileId } }) : null;
    if (!file || file.deletedAt) throw new NotFoundException('Fichier introuvable');
    const ttl = env().FILE_URL_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const direct = file.encrypted
      ? null
      : await this.storage.presignedUrl(file.storageKey, {
          expiresIn: ttl,
          fileName: file.originalName,
          contentType: file.mimeType,
        });
    const url = direct ?? `${env().API_PUBLIC_URL}/files/${this.sign(file, expiresAt)}`;
    if (audit)
      await this.audit.log({ action: 'files.viewed', entity: 'StoredFile', entityId: file.id });
    return {
      url,
      expiresAt: expiresAt.toISOString(),
      name: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
    };
  }

  private sign(file: StoredFile, expiresAt: Date): string {
    const payload = `${file.id}.${file.schoolId}.${Math.floor(expiresAt.getTime() / 1000)}`;
    const mac = hmacSha256(signingKey(), payload).slice(0, 43);
    return `${Buffer.from(payload).toString('base64url')}.${mac}`;
  }

  /** Vérifie un lien signé et renvoie le fichier en clair, ou une erreur 404 indistincte. */
  async openSigned(token: string): Promise<{ file: StoredFile; content: Buffer }> {
    const notFound = new NotFoundException('Lien expiré ou invalide');
    const [encoded, mac] = token.split('.');
    if (!encoded || !mac) throw notFound;
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!safeEqual(hmacSha256(signingKey(), payload).slice(0, 43), mac)) throw notFound;
    const [fileId, schoolId, exp] = payload.split('.');
    if (!fileId || !schoolId || !exp || Number(exp) * 1000 < Date.now()) throw notFound;
    const file = await runAsSystem(
      'file-download',
      () => this.db.storedFile.findUnique({ where: { id: fileId } }),
      schoolId,
    );
    if (!file || file.deletedAt) throw notFound;
    const raw = await this.storage.get(file.storageKey);
    const content = file.encrypted ? decryptBuffer(raw, env().DATA_ENCRYPTION_KEY) : raw;
    return { file, content };
  }
}
