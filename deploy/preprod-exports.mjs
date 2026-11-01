// Exports de préproduction (docs/vercel.md) : node deploy/preprod-exports.mjs <API>
const API = process.argv[2];
let n = 0,
  ko = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) ko++;
  console.log(`${ok ? 'OK ' : 'KO '} ${name}${detail ? ' · ' + detail : ''}`);
};
const login = await fetch(API + '/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'direction@demo.cm', password: 'Ecole2026!demo' }),
});
const { accessToken } = await login.json();
const auth = { authorization: `Bearer ${accessToken}` };
const json = async (p) => (await fetch(API + p, { headers: auth })).json().catch(() => ({}));
const MAGIC = { pdf: '%PDF', xlsx: 'PK', csv: null };
async function file(label, path) {
  const r = await fetch(API + path, { headers: auth });
  const b = Buffer.from(await r.arrayBuffer());
  const kind = path.match(/\.(pdf|xlsx|csv)(\?|$)/)?.[1] ?? 'pdf';
  const magic = MAGIC[kind];
  const ok =
    r.status === 200 && (magic ? b.subarray(0, magic.length).toString() === magic : b.length > 0);
  check(
    label,
    ok,
    `${r.status} · ${b.length} octets${ok ? '' : ' · ' + b.subarray(0, 120).toString()}`,
  );
}
const today = new Date().toISOString().slice(0, 10);
const from = '2026-09-01';
await file('tableau de bord (PDF)', '/dashboard/export.pdf');
await file('tableau de bord (Excel)', '/dashboard/export.xlsx');
await file('modèle d’import des élèves (Excel)', '/students/import/template.xlsx');
await file('journal des paiements (CSV)', `/finance/payments/export.csv?from=${from}&to=${today}`);
for (const kind of ['journal', 'balance', 'bilan']) {
  await file(
    `comptabilité ${kind} (PDF)`,
    `/accounting/reports/${kind}/export.pdf?from=${from}&to=${today}`,
  );
  await file(
    `comptabilité ${kind} (Excel)`,
    `/accounting/reports/${kind}/export.xlsx?from=${from}&to=${today}`,
  );
}
const payments = await json('/finance/payments?status=SUCCESS');
const payment = (payments.items ?? payments)[0];
if (payment)
  await file('reçu de paiement (PDF, QR)', `/finance/payments/${payment.id}/receipt.pdf`);
else check('reçu de paiement (PDF, QR)', false, 'aucun paiement');
const students = await json('/students?search=ngono');
const student = (students.items ?? students)[0];
if (student)
  await file('relevé de notes (PDF)', `/transcripts/students/${student.id}/pdf?scope=year`);
else check('relevé de notes (PDF)', false, 'aucun élève');
let payroll = false;
for (const m of ['2026-09', '2026-10', '2026-11']) {
  const r = await fetch(`${API}/hr/payroll/${m}/payslips.pdf`, { headers: auth });
  if (r.status === 200) {
    const b = Buffer.from(await r.arrayBuffer());
    check(
      `bulletins de paie ${m} (PDF)`,
      b.subarray(0, 4).toString() === '%PDF',
      `${b.length} octets`,
    );
    payroll = true;
    break;
  }
}
if (!payroll) check('bulletins de paie (PDF)', false, 'aucun mois disponible');
console.log(`\n${n - ko}/${n} exports réussis`);
process.exit(ko ? 1 : 0);
