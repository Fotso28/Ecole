import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomToken } from '../../common/crypto';
import type { Env } from '../../config/env';

export interface SignedUrlOptions {
  expiresIn: number;
  fileName: string;
  contentType: string;
}

/**
 * Stockage des fichiers. Les clés sont toujours générées par l'API. Deux fournisseurs : disque local
 * (développement, tests) et stockage compatible S3 (OVH Object Storage, MinIO).
 */
export interface FileStorage {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /**
   * Lien direct signé vers le fournisseur, ou `null` si le fournisseur n'en délivre pas : l'API sert
   * alors le contenu elle-même derrière son propre lien signé.
   */
  presignedUrl(key: string, options: SignedUrlOptions): Promise<string | null>;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*$/;

export function assertSafeKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.split('/').some((p) => p === '..' || p === '.'))
    throw new Error(`Clé de stockage invalide : ${key}`);
}

export class LocalFileStorage implements FileStorage {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Clé hors du stockage');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    // Écriture atomique : un fichier partiellement écrit n'est jamais lisible sous sa clé.
    const tmp = `${full}.${randomToken(6)}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, full);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  presignedUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

export class S3FileStorage implements FileStorage {
  readonly name = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static fromEnv(config: Env): S3FileStorage {
    const client = new S3Client({
      endpoint: config.S3_ENDPOINT || undefined,
      region: config.S3_REGION,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: config.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
    return new S3FileStorage(client, config.S3_BUCKET ?? '');
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('Objet vide');
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: contentDisposition(options.fileName),
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: options.expiresIn },
    );
  }
}

/** En-tête `Content-Disposition` affichable dans le navigateur, nom encodé (RFC 6266). */
export function contentDisposition(fileName: string): string {
  const ascii = fileName
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\]/g, '');
  return `inline; filename="${ascii || 'fichier'}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createStorage(config: Env): FileStorage {
  return config.STORAGE_PROVIDER === 's3'
    ? S3FileStorage.fromEnv(config)
    : new LocalFileStorage(config.STORAGE_LOCAL_DIR);
}

export const FILE_STORAGE = Symbol('FILE_STORAGE');
