// Portail des parents, parcours complet : connexion par code (OTP), accueil, notes de l'enfant,
// devoirs, messagerie (nouveau message à un enseignant), paiement Mobile Money simulé
// (demande depuis le portail, confirmation par le webhook signé de l'opérateur, suivi du statut).
//   k6 run -e PARENT_OFFSET=0 -e WEBHOOK_SECRET=… k6/portail.js
import http from 'k6/http';
import crypto from 'k6/crypto';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { API, SMS, expectOk, fakeIp, fixtures, params, thresholds, uuid } from './lib.js';

const RATE = Number(__ENV.RATE || 3);
const OFFSET = Number(__ENV.PARENT_OFFSET || 0);
const SECRET = __ENV.WEBHOOK_SECRET || '';

export const options = {
  scenarios: {
    parents: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 300,
      stages: [
        { target: RATE, duration: __ENV.RAMP || '1m' },
        { target: RATE, duration: __ENV.HOLD || '3m' },
        { target: 0, duration: '20s' },
      ],
    },
  },
  thresholds: {
    ...thresholds,
    'http_req_duration{name:GET /portal/children/:id}': ['p(95)<800'],
    'http_req_duration{name:GET /portal/children/:id/homework}': ['p(95)<800'],
    'http_req_duration{name:POST /portal/messages/threads}': ['p(95)<800'],
    'http_req_duration{name:POST /portal/payments}': ['p(95)<800'],
    'http_req_duration{name:POST /webhooks/mobile-money}': ['p(95)<800'],
  },
};

const parents = fixtures().schools.flatMap((s) => s.parents);

function login(parent, ip) {
  const before = http.get(`${SMS}/last?to=${encodeURIComponent(parent.phone)}`, {
    tags: { name: 'sink' },
  });
  const seen = before.json('count') || 0;
  const req = http.post(
    `${API}/auth/otp/request`,
    JSON.stringify({ phone: parent.phone }),
    params(ip, null, 'POST /auth/otp/request'),
  );
  if (!expectOk(req, 'demande de code', 202)) return null;
  let code = null;
  for (let k = 0; k < 40 && !code; k++) {
    sleep(0.25);
    const sms = http.get(`${SMS}/last?to=${encodeURIComponent(parent.phone)}`, {
      tags: { name: 'sink' },
    });
    if ((sms.json('count') || 0) > seen) code = /(\d{6})/.exec(sms.json('text') || '')?.[1];
  }
  if (!expectOk({ status: code ? 200 : 0 }, 'code reçu par SMS')) return null;
  const verify = http.post(
    `${API}/auth/otp/verify`,
    JSON.stringify({ phone: parent.phone, code }),
    params(ip, null, 'POST /auth/otp/verify'),
  );
  if (!expectOk(verify, 'connexion du parent')) return null;
  return verify.json('accessToken');
}

export default function () {
  const i = exec.scenario.iterationInTest + OFFSET;
  const parent = parents[i % parents.length];
  const ip = fakeIp(i);
  const token = login(parent, ip);
  if (!token) return;
  const child = parent.studentId;

  // Accueil : enfants et messages non lus.
  expectOk(
    http.get(`${API}/portal/children`, params(ip, token, 'GET /portal/children')),
    'enfants',
  );
  expectOk(
    http.get(`${API}/portal/messages/unread`, params(ip, token, 'GET /portal/messages/unread')),
    'messages non lus',
  );
  sleep(1);
  // Notes, absences, bulletins et compte de l'enfant.
  const overview = http.get(
    `${API}/portal/children/${child}`,
    params(ip, token, 'GET /portal/children/:id'),
  );
  if (!expectOk(overview, "espace de l'enfant")) return;
  sleep(1);
  expectOk(
    http.get(
      `${API}/portal/children/${child}/homework`,
      params(ip, token, 'GET /portal/children/:id/homework'),
    ),
    'devoirs',
  );
  sleep(1);

  // Messagerie : fils existants, contacts de l'enfant, nouveau message, lecture du fil.
  expectOk(
    http.get(`${API}/portal/messages/threads`, params(ip, token, 'GET /portal/messages/threads')),
    'fils de discussion',
  );
  const contacts = http.get(
    `${API}/portal/children/${child}/contacts`,
    params(ip, token, 'GET /portal/children/:id/contacts'),
  );
  if (!expectOk(contacts, "contacts de l'enfant")) return;
  const staffUserId = contacts.json('0.userId') || contacts.json('0.id');
  if (staffUserId) {
    const started = http.post(
      `${API}/portal/messages/threads`,
      JSON.stringify({
        studentId: child,
        staffUserId,
        body: 'Bonjour, mon enfant sera absent demain matin pour un rendez-vous médical.',
      }),
      params(ip, token, 'POST /portal/messages/threads'),
    );
    if (expectOk(started, 'nouveau message', 201)) {
      const threadId = started.json('id') || started.json('threadId');
      expectOk(
        http.get(
          `${API}/portal/messages/threads/${threadId}`,
          params(ip, token, 'GET /portal/messages/threads/:id'),
        ),
        'lecture du fil',
      );
    }
  }
  sleep(1);

  // Paiement Mobile Money simulé : demande, confirmation de l'opérateur (webhook), statut.
  const pay = http.post(
    `${API}/portal/payments`,
    JSON.stringify({
      studentId: child,
      amount: 5000,
      method: 'MTN_MOMO',
      payerPhone: parent.phone,
      idempotencyKey: uuid(),
    }),
    params(ip, token, 'POST /portal/payments'),
  );
  if (!expectOk(pay, 'demande de paiement', 201)) return;
  const paymentId = pay.json('id');
  if (SECRET) {
    sleep(1);
    const body = JSON.stringify({ externalId: paymentId, status: 'SUCCESS', amount: 5000 });
    const signature = `sha256=${crypto.hmac('sha256', SECRET, body, 'hex')}`;
    const hook = http.post(`${API}/webhooks/mobile-money`, body, {
      headers: { 'content-type': 'application/json', 'x-ecole-signature': signature },
      tags: { name: 'POST /webhooks/mobile-money' },
    });
    expectOk(hook, "confirmation de l'opérateur");
  }
  const status = http.get(
    `${API}/portal/payments/${paymentId}`,
    params(ip, token, 'GET /portal/payments/:id'),
  );
  if (expectOk(status, 'statut du paiement') && SECRET) {
    expectOk({ status: status.json('status') === 'SUCCESS' ? 200 : 0 }, 'paiement confirmé');
  }
}
