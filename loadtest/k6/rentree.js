// Pic de rentrée : inscriptions au secrétariat et encaissements en espèces à la caisse
// (recherche de l'élève, situation du compte, paiement, reçu PDF), dans les cinq établissements.
//   k6 run -e OFFSET=0 k6/rentree.js
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { API, expectOk, fakeIp, fixtures, params, staffLogin, thresholds, uuid } from './lib.js';

const schools = fixtures().schools;
const OFFSET = Number(__ENV.OFFSET || 0);
const duration = __ENV.DURATION || '4m';

export const options = {
  scenarios: {
    inscriptions: {
      executor: 'constant-arrival-rate',
      exec: 'inscription',
      rate: Number(__ENV.ENROLL_RATE || 2),
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 15,
      maxVUs: 60,
    },
    encaissements: {
      executor: 'constant-arrival-rate',
      exec: 'encaissement',
      rate: Number(__ENV.PAY_RATE || 4),
      timeUnit: '1s',
      duration,
      preAllocatedVUs: 15,
      maxVUs: 60,
    },
  },
  thresholds: {
    ...thresholds,
    'http_req_duration{name:POST /students}': ['p(95)<1000'],
    'http_req_duration{name:POST /finance/payments}': ['p(95)<1000'],
    'http_req_duration{name:GET /finance/payments/:id/receipt.pdf}': ['p(95)<1500'],
  },
};

let session;

function login(role) {
  if (session) return session;
  const vu = exec.vu.idInTest - 1;
  const school = schools[vu % schools.length];
  const staff = school[role][Math.floor(vu / schools.length) % school[role].length];
  const ip = fakeIp(60000 + vu);
  session = { school, ip, token: staffLogin(staff, ip) };
  if (role === 'accountants') {
    const open = http.post(
      `${API}/finance/cash-sessions/open`,
      '{}',
      params(ip, session.token, 'POST /finance/cash-sessions/open'),
    );
    if (open.status !== 201 && open.status !== 409) expectOk(open, 'ouverture de caisse', 201);
  }
  return session;
}

export function inscription() {
  const { school, ip, token } = login('secretaries');
  const n = exec.scenario.iterationInTest + OFFSET;
  const phone = `+23769${String(n).padStart(7, '0')}`;
  const student = {
    firstName: 'Nouvel',
    lastName: `Élève ${n}`,
    gender: n % 2 ? 'M' : 'F',
    birthDate: `2014-0${(n % 9) + 1}-1${n % 10}`,
    birthPlace: 'Douala',
    classId: school.classIds[n % school.classIds.length],
    guardians: [
      {
        firstName: 'Parent',
        lastName: `Rentrée ${n}`,
        phone,
        relationship: 'MOTHER',
        isPrimary: true,
      },
    ],
  };
  const dup = http.post(
    `${API}/students/check-duplicates`,
    JSON.stringify({
      firstName: student.firstName,
      lastName: student.lastName,
      birthDate: student.birthDate,
      guardianPhones: [phone],
    }),
    params(ip, token, 'POST /students/check-duplicates'),
  );
  expectOk(dup, 'contrôle des doublons', 201);
  sleep(1);
  const created = http.post(
    `${API}/students`,
    JSON.stringify({ ...student, confirmNotDuplicate: true }),
    params(ip, token, 'POST /students'),
  );
  expectOk(created, 'inscription', 201);
  expectOk(
    http.get(
      `${API}/students?search=${encodeURIComponent(student.lastName)}`,
      params(ip, token, 'GET /students?search'),
    ),
    'recherche après inscription',
  );
}

export function encaissement() {
  const { school, ip, token } = login('accountants');
  const n = exec.scenario.iterationInTest + OFFSET;
  const parent = school.parents[(n * 7) % school.parents.length];
  const search = http.get(
    `${API}/students?search=${encodeURIComponent(String(n % 1500))}`,
    params(ip, token, 'GET /students?search'),
  );
  expectOk(search, "recherche de l'élève");
  const account = http.get(
    `${API}/finance/students/${parent.studentId}/account`,
    params(ip, token, 'GET /finance/students/:id/account'),
  );
  expectOk(account, 'situation du compte');
  sleep(1);
  const pay = http.post(
    `${API}/finance/payments`,
    JSON.stringify({
      studentId: parent.studentId,
      amount: 5000,
      method: 'CASH',
      idempotencyKey: uuid(),
    }),
    params(ip, token, 'POST /finance/payments'),
  );
  if (!expectOk(pay, 'encaissement', 201)) return;
  expectOk(
    http.get(
      `${API}/finance/payments/${pay.json('id')}/receipt.pdf`,
      params(ip, token, 'GET /finance/payments/:id/receipt.pdf'),
    ),
    'reçu PDF',
  );
}
