// Test de fumée de préproduction (docs/vercel.md) : node deploy/preprod-smoke.mjs <API> <CRON_SECRET>
const [API, CRON] = process.argv.slice(2);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ' · ' + detail : ''}`);
};
const j = async (path, opts = {}) => {
  const r = await fetch(API + path, opts);
  let body = null;
  try {
    body = await r.clone().json();
  } catch {}
  return { r, body };
};

// Santé et en-têtes de sécurité
{
  const { r } = await j('/health');
  check('santé de l’API et de la base', r.status === 200);
  check(
    'en-têtes de sécurité (HSTS, nosniff, CSP)',
    !!r.headers.get('strict-transport-security') &&
      r.headers.get('x-content-type-options') === 'nosniff' &&
      !!r.headers.get('content-security-policy'),
  );
}
// Routes qui doivent être fermées en production
check('documentation Swagger fermée', (await fetch(API + '/docs')).status === 404);
check(
  'outil de développement /dev fermé',
  (await fetch(API + '/dev/sms/last?to=677123456')).status === 404,
);
check('tâches planifiées fermées sans secret', (await fetch(API + '/jobs/outbox')).status === 404);
if (CRON)
  check(
    'tâche planifiée avec le secret',
    (await fetch(API + '/jobs/outbox', { headers: { authorization: `Bearer ${CRON}` } })).status ===
      200,
  );
// CORS : une origine étrangère n'est pas autorisée
{
  const r = await fetch(API + '/health', { headers: { origin: 'https://pirate.example' } });
  check('CORS refuse une origine étrangère', !r.headers.get('access-control-allow-origin'));
}
// Erreurs sans fuite technique
{
  const { r, body } = await j('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"x"}',
  });
  check(
    'erreur de saisie propre (400, sans pile technique)',
    r.status === 400 &&
      !JSON.stringify(body).includes('stack') &&
      !JSON.stringify(body).includes('/node_modules/'),
  );
}
// Connexion du personnel et cookie de session
const login = await j('/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'direction@demo.cm', password: 'Ecole2026!demo' }),
});
const token = login.body?.accessToken;
const cookie = login.r.headers.get('set-cookie') ?? '';
check('connexion de la direction (démonstration)', login.r.status === 200 && !!token);
check(
  'cookie de session HttpOnly, Secure, SameSite',
  /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite/i.test(cookie),
  cookie.split(';').slice(1).join(';').trim(),
);
const auth = { authorization: `Bearer ${token}` };
// Données métier (Row-Level Security active : rôle ecole_app)
{
  const { r, body } = await j('/dashboard', { headers: auth });
  check(
    'tableau de bord',
    r.status === 200 && !!body?.enrollment,
    `${body?.enrollment?.total ?? '?'} élèves`,
  );
}
{
  const { r, body } = await j('/students?search=ngono%20paul', { headers: auth });
  const items = body?.items ?? body;
  check(
    'recherche « ngono paul » (accents, deux mots)',
    r.status === 200 && Array.isArray(items) && items.length > 0,
    `${Array.isArray(items) ? items.length : 0} résultat(s)`,
  );
}
{
  const { r } = await j('/settings', { headers: auth });
  check('paramètres de l’école', r.status === 200);
}
// PDF (polices et génération sur la plateforme) : aperçu d'un modèle, sans numéro du registre
for (const type of ['STUDENT_CARD', 'SCHOOL_CERTIFICATE']) {
  const r = await fetch(`${API}/documents/templates/${type}/preview`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Spécimen',
      headerLines: ['MINESEC'],
      signatoryTitle: 'Le Principal',
    }),
  });
  const b = Buffer.from(await r.arrayBuffer());
  check(
    `PDF généré (${type})`,
    r.status === 200 && b.subarray(0, 4).toString() === '%PDF',
    `${b.length} octets`,
  );
}
// Limitation des tentatives de connexion
{
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(API + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'direction@demo.cm', password: 'mauvais' }),
    });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  check('limitation des tentatives de connexion (429)', limited);
}
const ko = results.filter((r) => !r.ok);
console.log(`\n${results.length - ko.length}/${results.length} contrôles réussis`);
process.exit(ko.length ? 1 : 0);
