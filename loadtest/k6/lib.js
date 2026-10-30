// Outils communs des scripts de charge k6.
import http from 'k6/http';
import { check, fail } from 'k6';
import { SharedArray } from 'k6/data';

export const API = __ENV.API_URL || 'http://127.0.0.1:4000';
export const SMS = __ENV.SMS_URL || 'http://127.0.0.1:8025';
const FIXTURES = __ENV.FIXTURES || '/data/loadtest-fixtures.json';

const data = new SharedArray('fixtures', () => [JSON.parse(open(FIXTURES))]);
export const fixtures = () => data[0];

/**
 * Adresse IP simulée (en-tête X-Forwarded-For) : chaque utilisateur virtuel compte comme
 * un appareil distinct pour les limites de débit de l'API, comme des parents sur leur téléphone.
 */
export function fakeIp(n) {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export function params(ip, token, name) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (token) headers.authorization = `Bearer ${token}`;
  return { headers, tags: { name } };
}

export function expectOk(res, label, status = 200) {
  const ok = check(res, { [`${label} : ${status}`]: (r) => r.status === status });
  if (!ok) console.warn(`${label} : HTTP ${res.status} ${String(res.body).slice(0, 160)}`);
  return ok;
}

/** Connexion du personnel : renvoie le jeton d'accès. */
export function staffLogin(email, ip) {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password: fixtures().password }),
    params(ip, null, 'POST /auth/login'),
  );
  if (!expectOk(res, 'connexion du personnel')) fail(`connexion impossible : ${email}`);
  return res.json('accessToken');
}

export const thresholds = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
};

/** Identifiant unique (clé d'idempotence des paiements). */
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
