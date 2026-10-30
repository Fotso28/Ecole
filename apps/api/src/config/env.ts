import { MAX_FILE_BYTES } from '@ecole/shared';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  OTP_SECRET: z.string().min(32, 'OTP_SECRET doit faire au moins 32 caractères'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'DATA_ENCRYPTION_KEY : 64 caractères hexadécimaux'),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  PUBLIC_VERIFY_URL: z.string().default('http://localhost:3000/verifier'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SMS_PROVIDER: z.enum(['console', 'memory', 'http']).default('console'),
  SMS_HTTP_URL: z.string().optional(),
  SMS_HTTP_TOKEN: z.string().optional(),
  SMS_SENDER: z.string().default('ECOLE'),
  EMAIL_PROVIDER: z.enum(['console', 'memory', 'smtp', 'http']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('Ecole <no-reply@ecole.cm>'),
  MOBILE_MONEY_PROVIDER: z.enum(['simulator', 'http', 'operators']).default('simulator'),
  MOBILE_MONEY_HTTP_URL: z.string().optional(),
  MOBILE_MONEY_HTTP_TOKEN: z.string().optional(),
  MOBILE_MONEY_WEBHOOK_SECRET: z.string().min(16),
  MOBILE_MONEY_ALLOWED_IPS: z.string().default(''),
  // Raccordement direct MTN MoMo (API Collection) et Orange Money Cameroun (paiement marchand).
  MTN_MOMO_BASE_URL: z.string().default('https://sandbox.momodeveloper.mtn.com'),
  MTN_MOMO_TARGET_ENVIRONMENT: z.string().default('sandbox'),
  MTN_MOMO_SUBSCRIPTION_KEY: z.string().optional(),
  MTN_MOMO_API_USER: z.string().optional(),
  MTN_MOMO_API_KEY: z.string().optional(),
  MTN_MOMO_CURRENCY: z.string().default('XAF'),
  MTN_MOMO_CALLBACK_URL: z.string().optional(),
  ORANGE_MONEY_BASE_URL: z.string().default('https://api-s1.orange.cm'),
  ORANGE_MONEY_API_PATH: z.string().default('/omcoreapis/1.0.2'),
  ORANGE_MONEY_CLIENT_ID: z.string().optional(),
  ORANGE_MONEY_CLIENT_SECRET: z.string().optional(),
  ORANGE_MONEY_AUTH_TOKEN: z.string().optional(),
  ORANGE_MONEY_CHANNEL_MSISDN: z.string().optional(),
  ORANGE_MONEY_CHANNEL_PIN: z.string().optional(),
  ORANGE_MONEY_CALLBACK_URL: z.string().optional(),
  // Limites dédiées aux paiements (par utilisateur ou par adresse pour les opérateurs).
  PAYMENT_RATE_PORTAL: z.string().default('5/600,20/86400'),
  PAYMENT_RATE_CASHIER: z.string().default('30/60,600/3600'),
  PAYMENT_RATE_CALLBACK: z.string().default('120/60'),
  // Codes SMS de connexion des parents.
  OTP_DAILY_SMS_BUDGET: z.coerce.number().int().positive().default(2000),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /**
   * Liens présignés directs vers le stockage S3 (fichiers non chiffrés). À désactiver quand le
   * stockage n'est pas joignable par les navigateurs (MinIO interne) : l'API sert alors les fichiers.
   */
  S3_PRESIGNED_DOWNLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  FILE_MAX_BYTES: z.coerce.number().int().positive().default(MAX_FILE_BYTES),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  /** Préfixe public de l'API, pour les liens de téléchargement signés du stockage local. */
  API_PUBLIC_URL: z.string().default('/api'),
  QUEUES_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['verbose', 'debug', 'log', 'warn', 'error']).default('log'),
  /** Par défaut : JSON en production, texte lisible ailleurs. */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
  /** Alertes à l'équipe technique : numéros et adresses séparés par des virgules. */
  ALERT_SMS_TO: z.string().default(''),
  ALERT_EMAIL_TO: z.string().default(''),
  /** Anti-répétition : une même alerte n'est renvoyée qu'après ce délai. */
  ALERT_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(60),
  /** URL de santé de l'API sondée par le worker (ex. http://api:4000/health). */
  ALERT_HEALTH_URL: z.string().optional(),
  /** Fichier d'état écrit par deploy/backup.sh, lu par le worker. */
  BACKUP_STATUS_FILE: z.string().optional(),
  BACKUP_MAX_AGE_HOURS: z.coerce.number().int().positive().default(26),
  /** Passerelle e-mail HTTP générique : POST JSON { to, from, subject, text }. */
  EMAIL_HTTP_URL: z.string().optional(),
  EMAIL_HTTP_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuration invalide :\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (/change-me/.test(parsed.data.JWT_SECRET) || /change-me/.test(parsed.data.OTP_SECRET)) {
      throw new Error('Secrets par défaut interdits en production');
    }
    if (/^0+$/.test(parsed.data.DATA_ENCRYPTION_KEY)) {
      throw new Error('Clé de chiffrement par défaut interdite en production');
    }
    // Le fournisseur « console » écrit chaque SMS, codes de connexion des parents compris, dans
    // les journaux ; « memory » les garde en mémoire sans les envoyer.
    if (parsed.data.SMS_PROVIDER !== 'http') {
      throw new Error('SMS_PROVIDER=http obligatoire en production (passerelle SMS)');
    }
  }
  if (parsed.data.STORAGE_PROVIDER === 's3') {
    const missing = (['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter(
      (k) => !parsed.data[k],
    );
    if (missing.length > 0) throw new Error(`Stockage S3 : renseigner ${missing.join(', ')}`);
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Réservé aux tests : force la relecture de l'environnement. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Pas de fichier .env : les variables viennent de l'environnement.
  }
}
