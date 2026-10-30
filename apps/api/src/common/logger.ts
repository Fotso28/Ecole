import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentContext, currentRequestId } from './context';

export type LogFormat = 'json' | 'text';

const LEVELS: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
const LEVEL_NAMES: Record<LogLevel, string> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** Clés dont la valeur n'est jamais journalisée. */
const SECRET_KEYS =
  /pass(word)?|secret|token|authorization|cookie|otp|code|signature|phone|email|firstname|lastname|birth|health|recipient|body/i;

/**
 * Masque les données personnelles et les secrets dans un texte libre :
 * jetons JWT et Bearer, adresses e-mail, numéros de téléphone (internationaux ou camerounais).
 */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jeton]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [masqué]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail]')
    .replace(/\+\d[\d .-]{6,16}\d/g, '[téléphone]')
    .replace(/\b(?:237)?[62]\d{8}\b/g, '[téléphone]')
    .replace(/\b[62]\d{2}(?:[ .]\d{2}){3}\b/g, '[téléphone]');
}

/** Copie d'un objet sans les champs sensibles, textes masqués. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[masqué]' : redactValue(v, depth + 1);
  }
  return out;
}

/** Établissement et identifiant de requête du contexte courant (jamais l'utilisateur). */
export function logContext(): { requestId?: string; schoolId?: string } {
  const ctx = currentContext();
  const schoolId =
    ctx?.kind === 'staff' ? ctx.schoolId : ctx?.kind === 'system' ? ctx.schoolId : undefined;
  const requestId = currentRequestId();
  return {
    ...(requestId ? { requestId } : {}),
    ...(schoolId ? { schoolId } : {}),
  };
}

export interface LoggerOptions {
  format?: LogFormat;
  level?: LogLevel;
  service?: string;
  /** Destination (tests) ; par défaut la sortie standard. */
  write?: (line: string) => void;
}

/**
 * Journal applicatif : une ligne JSON par événement (format `json`, production) avec
 * horodatage, niveau, service, contexte Nest, identifiant de requête et d'école.
 * Les messages sont filtrés par `redact` : pas de téléphone, d'e-mail ni de jeton.
 */
export class AppLogger implements LoggerService {
  private readonly format: LogFormat;
  private readonly minLevel: number;
  private readonly service: string;
  private readonly write: (line: string) => void;

  constructor(options: LoggerOptions = {}) {
    this.format = options.format ?? 'json';
    this.minLevel = LEVELS.indexOf(options.level ?? 'log');
    this.service = options.service ?? 'api';
    this.write = options.write ?? ((line) => process.stdout.write(line + '\n'));
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest, true);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest, true);
  }

  /** Événement structuré (ex. accès HTTP) : les champs sont ajoutés tels quels à la ligne. */
  event(level: LogLevel, context: string, message: string, fields: Record<string, unknown>): void {
    if (LEVELS.indexOf(level) < this.minLevel) return;
    this.output(level, context, message, redactValue(fields) as Record<string, unknown>);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[], withStack = false): void {
    if (LEVELS.indexOf(level) < this.minLevel) return;
    // Convention Nest : le dernier argument texte est le contexte ; pour error, l'avant-dernier
    // peut être la pile.
    const args = rest.filter((a) => a !== undefined);
    const context = args.length > 0 && typeof args[args.length - 1] === 'string' ? args.pop() : '';
    const fields: Record<string, unknown> = {};
    let text: string;
    if (message instanceof Error) {
      text = message.message;
      fields.stack = message.stack;
    } else if (typeof message === 'string') {
      text = message;
    } else {
      text = '';
      fields.data = redactValue(message);
    }
    if (withStack && typeof args[0] === 'string' && args[0].includes('\n')) {
      fields.stack = args.shift();
    }
    if (args.length > 0) fields.extra = redactValue(args);
    if (typeof fields.stack === 'string') fields.stack = redact(fields.stack);
    this.output(level, String(context), redact(text), fields);
  }

  private output(
    level: LogLevel,
    context: string,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    const time = new Date().toISOString();
    const ctx = logContext();
    if (this.format === 'text') {
      const extra = Object.keys({ ...ctx, ...fields }).length
        ? ' ' + JSON.stringify({ ...ctx, ...fields })
        : '';
      this.write(`${time} ${LEVEL_NAMES[level].toUpperCase()} [${context}] ${message}${extra}`);
      return;
    }
    this.write(
      JSON.stringify({
        time,
        level: LEVEL_NAMES[level],
        service: this.service,
        context: context || undefined,
        msg: message,
        ...ctx,
        ...fields,
      }),
    );
  }
}

let shared: AppLogger | undefined;

/** Journal partagé du processus (API ou worker), créé au démarrage. */
export function appLogger(options?: LoggerOptions): AppLogger {
  if (options) shared = new AppLogger(options);
  // Sans configuration (tests, scripts) : texte, et seulement les erreurs pendant les tests.
  shared ??= new AppLogger({
    format: 'text',
    level: process.env.NODE_ENV === 'test' ? 'error' : 'log',
  });
  return shared;
}
