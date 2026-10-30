import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptBuffer, encryptBuffer } from '../../common/crypto';
import { loadEnv } from '../../config/env';
import {
  assertSafeKey,
  contentDisposition,
  createStorage,
  LocalFileStorage,
  S3FileStorage,
} from './storage.provider';

const KEY = 'b'.repeat(64);

describe('stockage local', () => {
  let dir: string;
  let storage: LocalFileStorage;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ecole-storage-'));
    storage = new LocalFileStorage(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('enregistre, relit et supprime un fichier', async () => {
    await storage.put('ecole1/supports/2026/abc', Buffer.from('contenu'), 'application/pdf');
    expect((await readFile(path.join(dir, 'ecole1/supports/2026/abc'))).toString()).toBe('contenu');
    expect((await storage.get('ecole1/supports/2026/abc')).toString()).toBe('contenu');
    await storage.remove('ecole1/supports/2026/abc');
    await expect(storage.get('ecole1/supports/2026/abc')).rejects.toThrow();
    expect(await storage.presignedUrl()).toBeNull();
  });

  it('refuse toute clé qui sortirait du dossier de stockage', async () => {
    for (const key of ['../secret', 'a/../../b', '/etc/passwd', 'a//b', 'a/./b', '', 'a\\b']) {
      expect(() => assertSafeKey(key)).toThrow();
      await expect(storage.get(key)).rejects.toThrow();
    }
  });
});

describe('stockage compatible S3', () => {
  const client = new S3Client({
    endpoint: 'https://s3.gra.io.cloud.ovh.net',
    region: 'gra',
    forcePathStyle: true,
    credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-test' },
  });
  const storage = new S3FileStorage(client, 'ecole-fichiers');

  it('envoie et relit les objets dans le seau configuré', async () => {
    const sent: unknown[] = [];
    const spy = vi.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
      sent.push(command);
      if (command instanceof GetObjectCommand)
        return { Body: { transformToByteArray: async () => Uint8Array.from([1, 2, 3]) } };
      return {};
    });
    await storage.put('ecole1/eleves/2026/xyz', Buffer.from('abc'), 'application/octet-stream');
    const put = sent[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({
      Bucket: 'ecole-fichiers',
      Key: 'ecole1/eleves/2026/xyz',
      ContentType: 'application/octet-stream',
      ContentLength: 3,
    });
    expect([...(await storage.get('ecole1/eleves/2026/xyz'))]).toEqual([1, 2, 3]);
    await expect(storage.put('../x', Buffer.from(''), 'a')).rejects.toThrow();
    spy.mockRestore();
  });

  it('délivre une URL signée de courte durée avec le nom et le type du fichier', async () => {
    const url = new URL(
      await storage.presignedUrl('ecole1/supports/2026/abc', {
        expiresIn: 300,
        fileName: 'Fiche d’exercices.pdf',
        contentType: 'application/pdf',
      }),
    );
    expect(url.origin).toBe('https://s3.gra.io.cloud.ovh.net');
    expect(url.pathname).toBe('/ecole-fichiers/ecole1/supports/2026/abc');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIA-TEST/');
    expect(url.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(url.searchParams.get('response-content-disposition')).toContain(
      "filename*=UTF-8''Fiche%20d%E2%80%99exercices.pdf",
    );
  });
});

describe('configuration du stockage', () => {
  const base = {
    DATABASE_URL: 'postgresql://x',
    JWT_SECRET: 'x'.repeat(32),
    OTP_SECRET: 'y'.repeat(32),
    DATA_ENCRYPTION_KEY: KEY,
    MOBILE_MONEY_WEBHOOK_SECRET: 'z'.repeat(16),
  };

  it('choisit le fournisseur par variable d’environnement', () => {
    expect(createStorage(loadEnv({ ...base })).name).toBe('local');
    const s3 = loadEnv({
      ...base,
      STORAGE_PROVIDER: 's3',
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'ecole',
      S3_ACCESS_KEY_ID: 'minio',
      S3_SECRET_ACCESS_KEY: 'minio-secret',
    });
    expect(createStorage(s3).name).toBe('s3');
  });

  it('refuse un stockage S3 incomplet', () => {
    expect(() => loadEnv({ ...base, STORAGE_PROVIDER: 's3', S3_BUCKET: 'ecole' })).toThrow(
      /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
    );
  });
});

describe('chiffrement des fichiers', () => {
  it('chiffre et déchiffre un contenu binaire, et détecte toute altération', () => {
    const plain = Buffer.from('%PDF-1.4 acte de naissance');
    const enc = encryptBuffer(plain, KEY);
    expect(enc.includes(Buffer.from('%PDF'))).toBe(false);
    expect(decryptBuffer(enc, KEY).equals(plain)).toBe(true);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => decryptBuffer(tampered, KEY)).toThrow();
    expect(() => decryptBuffer(enc, 'c'.repeat(64))).toThrow();
    expect(() => decryptBuffer(Buffer.alloc(10), KEY)).toThrow();
  });

  it('produit un chiffré différent à chaque fois (vecteur aléatoire)', () => {
    const plain = Buffer.from('même contenu');
    expect(encryptBuffer(plain, KEY).equals(encryptBuffer(plain, KEY))).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('encode le nom pour l’en-tête HTTP', () => {
    expect(contentDisposition('acte "naissance".pdf')).toBe(
      `inline; filename="acte naissance.pdf"; filename*=UTF-8''acte%20%22naissance%22.pdf`,
    );
    expect(contentDisposition('élève.jpg')).toContain('filename="eleve.jpg"');
  });
});
