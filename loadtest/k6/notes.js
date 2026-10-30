// Pic de saisie des notes : tous les enseignants des cinq établissements saisissent en même
// temps (création d'une évaluation, saisie de la classe, relecture de la grille).
//   k6 run k6/notes.js
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { API, expectOk, fakeIp, fixtures, params, staffLogin, thresholds } from './lib.js';

const teachers = fixtures().schools.flatMap((s) =>
  s.teachers.map((t) => ({ ...t, sequenceId: s.sequenceId })),
);

export const options = {
  scenarios: {
    enseignants: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || teachers.length),
      duration: __ENV.DURATION || '4m',
    },
  },
  thresholds: {
    ...thresholds,
    'http_req_duration{name:GET /grades/sheet}': ['p(95)<800'],
    'http_req_duration{name:PUT /grades/evaluations/:id/grades}': ['p(95)<1000'],
    // Tous les enseignants se connectent dans la même seconde : file d'attente du hachage
    // argon2 (4 fils, 64 Mo chacun) ; mesuré pour information, sans objectif strict.
    'http_req_duration{name:POST /auth/login}': ['max<60000'],
  },
};

let token;

export default function () {
  const vu = exec.vu.idInTest - 1;
  const teacher = teachers[vu % teachers.length];
  const ip = fakeIp(50000 + vu);
  if (!token) token = staffLogin(teacher.email, ip);
  const it = exec.vu.iterationInScenario;
  const classSubjectId = teacher.classSubjectIds[it % teacher.classSubjectIds.length];
  const list = http.get(
    `${API}/grades/class-subjects`,
    params(ip, token, 'GET /grades/class-subjects'),
  );
  expectOk(list, 'matières de l’enseignant');
  const sheetUrl = `${API}/grades/sheet?classSubjectId=${classSubjectId}&sequenceId=${teacher.sequenceId}`;
  const sheet = http.get(sheetUrl, params(ip, token, 'GET /grades/sheet'));
  if (!expectOk(sheet, 'grille de notes')) return;
  const students = sheet.json('rows').map((r) => r.student.id);
  const ev = http.post(
    `${API}/grades/evaluations`,
    JSON.stringify({
      classSubjectId,
      sequenceId: teacher.sequenceId,
      name: `Interrogation ${vu}-${it}`,
      type: 'QUIZ',
      weight: 1,
      maxScore: 20,
    }),
    params(ip, token, 'POST /grades/evaluations'),
  );
  if (!expectOk(ev, 'création de l’évaluation', 201)) return;
  // Saisie : l'enseignant tape les notes puis enregistre (avec une correction ensuite).
  sleep(2 + Math.random() * 3);
  const grades = students.map((studentId, k) => ({
    studentId,
    value: String(((k * 7 + it) % 15) + 5).replace(/^(\d+)$/, k % 4 === 0 ? '$1,5' : '$1'),
  }));
  const url = `${API}/grades/evaluations/${ev.json('id')}/grades`;
  expectOk(
    http.put(
      url,
      JSON.stringify({ grades }),
      params(ip, token, 'PUT /grades/evaluations/:id/grades'),
    ),
    'enregistrement des notes',
  );
  sleep(1 + Math.random() * 2);
  grades[0].value = 'ABS';
  expectOk(
    http.put(
      url,
      JSON.stringify({ grades: grades.slice(0, 3) }),
      params(ip, token, 'PUT /grades/evaluations/:id/grades'),
    ),
    'correction de notes',
  );
  expectOk(http.get(sheetUrl, params(ip, token, 'GET /grades/sheet')), 'relecture de la grille');
  sleep(2 + Math.random() * 3);
}
