import { ApiError, getAccessToken, refreshSession } from './api';

/** Envoi d'un formulaire multipart (fichier) à l'API, avec rafraîchissement de session. */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const send = () => {
    const token = getAccessToken();
    return fetch(`/api${path}`, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
      credentials: 'same-origin',
    });
  };
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && (await refreshSession())) res = await send();
  } catch {
    throw new ApiError(0, 'Connexion impossible. Vérifiez votre réseau et réessayez.');
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Réponse sans corps JSON (proxy, fichier trop volumineux).
  }
  if (!res.ok) {
    const message =
      typeof body.message === 'string'
        ? body.message
        : res.status === 413
          ? 'Fichier trop volumineux.'
          : 'La demande n’a pas abouti.';
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}
