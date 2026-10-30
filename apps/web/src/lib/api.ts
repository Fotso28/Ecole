/** Client HTTP de l'API : jeton d'accès en mémoire, jeton de rafraîchissement en cookie httpOnly. */

import { CACHED_AT_HEADER, isOffline, noteCachedResponse } from './offline';

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get code(): string | undefined {
    return typeof this.body.code === 'string' ? this.body.code : undefined;
  }

  get fieldErrors(): FieldError[] {
    return Array.isArray(this.body.errors) ? (this.body.errors as FieldError[]) : [];
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;
let onSessionRefreshed: (() => void) | null = null;
let refreshFailure: 'network' | 'denied' | null = null;

/** Cause du dernier échec de rafraîchissement : réseau absent ou session refusée. */
export function lastRefreshFailure(): 'network' | 'denied' | null {
  return refreshFailure;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

/**
 * Appelé après le rafraîchissement du jeton en cours d'utilisation : le profil (droits effectifs)
 * est relu, pour qu'une modification des rôles s'applique au plus tard à ce moment.
 */
export function setSessionRefreshedHandler(handler: (() => void) | null): void {
  onSessionRefreshed = handler;
}

/** Rafraîchit la session une seule fois même si plusieurs requêtes échouent en même temps. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        accessToken = null;
        refreshFailure = 'denied';
        return false;
      }
      const body = (await res.json()) as { accessToken: string };
      accessToken = body.accessToken;
      refreshFailure = null;
      return true;
    } catch {
      refreshFailure = 'network';
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  const isForm = options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : isForm
          ? (options.body as FormData)
          : JSON.stringify(options.body),
    credentials: 'same-origin',
    signal: options.signal,
  });
}

async function toError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Réponse sans corps JSON.
  }
  const message =
    typeof body.message === 'string'
      ? body.message
      : res.status === 0 || res.status >= 500
        ? 'Le serveur ne répond pas. Vérifiez votre connexion et réessayez.'
        : 'La demande n’a pas abouti.';
  return new ApiError(res.status, message, body);
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  // Hors connexion, lecture seule : aucune saisie n'est tentée ni mise en attente.
  if ((options.method ?? 'GET') !== 'GET' && isOffline())
    throw new ApiError(0, 'Hors connexion : la saisie reprendra au retour du réseau.');
  let res: Response;
  try {
    res = await send(path, options);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Connexion impossible. Vérifiez votre réseau et réessayez.');
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      onSessionRefreshed?.();
      res = await send(path, options);
    } else {
      onSessionLost?.();
    }
  }
  if (!res.ok) throw await toError(res);
  noteCachedResponse(res.headers.get(CACHED_AT_HEADER));
  return res;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Ouvre un PDF protégé (bulletin, reçu) dans un nouvel onglet. */
export async function openPdf(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const res = await request(path);
    const url = URL.createObjectURL(await res.blob());
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Télécharge un fichier protégé (export CSV). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await request(path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Envoie un fichier (champ `file`) et des champs texte en multipart. */
export async function uploadFile<T>(
  path: string,
  file: File,
  fields: Record<string, string | undefined> = {},
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  form.append('file', file, file.name);
  return api<T>(path, { method: 'POST', body: form });
}

export interface FileLink {
  url: string;
  expiresAt: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Ouvre un fichier protégé : l'API contrôle les droits puis remet un lien signé de courte durée,
 * ouvert dans un nouvel onglet (préparé avant l'appel pour ne pas être bloqué par le navigateur).
 */
export async function openFile(path: string): Promise<void> {
  const tab = window.open('', '_blank');
  try {
    const link = await api<FileLink>(path);
    if (tab) tab.location.href = link.url;
    else window.location.href = link.url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}
