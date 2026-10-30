// Pic de publication des bulletins : les parents reçoivent le SMS, se connectent par code
// (OTP), consultent l'espace de leur enfant puis téléchargent le bulletin en PDF.
//   k6 run -e PARENT_OFFSET=0 k6/bulletins.js
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { API, SMS, expectOk, fakeIp, fixtures, params, thresholds } from './lib.js';

const RATE = Number(__ENV.RATE || 5);
const OFFSET = Number(__ENV.PARENT_OFFSET || 0);

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
    'http_req_duration{name:POST /auth/otp/verify}': ['p(95)<800'],
    'http_req_duration{name:GET /portal/children/:id}': ['p(95)<800'],
    'http_req_duration{name:GET /portal/report-cards/:id/pdf}': ['p(95)<2000'],
  },
};

const parents = fixtures().schools.flatMap((s) => s.parents);

export default function () {
  const i = exec.scenario.iterationInTest + OFFSET;
  const parent = parents[i % parents.length];
  const ip = fakeIp(i);
  const before = http.get(`${SMS}/last?to=${encodeURIComponent(parent.phone)}`, {
    tags: { name: 'sink' },
  });
  const seen = before.json('count') || 0;
  const req = http.post(
    `${API}/auth/otp/request`,
    JSON.stringify({ phone: parent.phone }),
    params(ip, null, 'POST /auth/otp/request'),
  );
  if (!expectOk(req, 'demande de code', 202)) return;
  // Le parent lit le SMS : la fausse passerelle rend le dernier message reçu.
  let code = null;
  for (let k = 0; k < 40 && !code; k++) {
    sleep(0.25);
    const sms = http.get(`${SMS}/last?to=${encodeURIComponent(parent.phone)}`, {
      tags: { name: 'sink' },
    });
    if ((sms.json('count') || 0) > seen) code = /(\d{6})/.exec(sms.json('text') || '')?.[1];
  }
  if (!expectOk({ status: code ? 200 : 0 }, 'code reçu par SMS')) return;
  const verify = http.post(
    `${API}/auth/otp/verify`,
    JSON.stringify({ phone: parent.phone, code }),
    params(ip, null, 'POST /auth/otp/verify'),
  );
  if (!expectOk(verify, 'connexion du parent')) return;
  const token = verify.json('accessToken');
  const children = http.get(`${API}/portal/children`, params(ip, token, 'GET /portal/children'));
  expectOk(children, 'liste des enfants');
  sleep(1);
  const overview = http.get(
    `${API}/portal/children/${parent.studentId}`,
    params(ip, token, 'GET /portal/children/:id'),
  );
  if (!expectOk(overview, "espace de l'enfant")) return;
  const card = overview.json('reportCards.0.id');
  if (!expectOk({ status: card ? 200 : 0 }, 'bulletin publié visible')) return;
  sleep(1);
  const pdf = http.get(
    `${API}/portal/report-cards/${card}/pdf`,
    params(ip, token, 'GET /portal/report-cards/:id/pdf'),
  );
  expectOk(pdf, 'bulletin PDF');
}
