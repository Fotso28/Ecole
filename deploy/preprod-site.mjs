// Site de préproduction (docs/vercel.md) : node deploy/preprod-site.mjs <adresse du site>
const SITE = process.argv[2];
let n = 0,
  ko = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) ko++;
  console.log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ' · ' + detail : ''}`);
};
for (const [path, label] of [
  ['/connexion', 'page de connexion'],
  ['/parent/connexion', 'connexion des parents'],
  ['/verifier', 'vérification publique des documents'],
  ['/manifest.webmanifest', 'manifeste de l’application'],
  ['/sw.js', 'service worker (lecture hors connexion)'],
]) {
  const r = await fetch(SITE + path);
  const t = await r.text();
  check(label, r.status === 200, `${r.status}`);
  if (path === '/connexion') check('bandeau « Préproduction »', t.includes('Préproduction'));
}
const login = await fetch(SITE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'direction@demo.cm', password: 'Ecole2026!demo' }),
});
const body = await login.json().catch(() => ({}));
const cookie = login.headers.get('set-cookie') ?? '';
check(
  'connexion via le site (réécriture /api)',
  login.status === 200 && !!body.accessToken,
  `${login.status}`,
);
check('cookie posé pour le domaine du site', /HttpOnly/i.test(cookie) && !/Domain=/i.test(cookie));
const refresh = await fetch(SITE + '/api/auth/refresh', {
  method: 'POST',
  headers: { cookie: cookie.split(';')[0] },
});
const rb = await refresh.json().catch(() => ({}));
check(
  'session renouvelée par le cookie (rechargement de page)',
  refresh.status === 200 && !!rb.accessToken,
  `${refresh.status}`,
);
const auth = { authorization: `Bearer ${body.accessToken}` };
const dash = await fetch(SITE + '/api/dashboard', { headers: auth });
const d = await dash.json().catch(() => ({}));
check('tableau de bord via le site', dash.status === 200, `${d?.enrollment?.total ?? '?'} élèves`);
const st = await fetch(SITE + '/api/students?search=ngono', { headers: auth });
const sb = await st.json().catch(() => ({}));
check(
  'recherche d’élèves via le site',
  st.status === 200,
  `${(sb.items ?? sb).length ?? '?'} résultat(s)`,
);
const otp = await fetch(SITE + '/api/auth/otp/request', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ phone: '677123456' }),
});
check('demande de code SMS parent (écrit dans les journaux)', otp.status === 202, `${otp.status}`);
console.log(`\n${n - ko}/${n} contrôles réussis`);
process.exit(ko ? 1 : 0);
