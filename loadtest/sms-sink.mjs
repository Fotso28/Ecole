// Fausse passerelle SMS des tests de charge : reçoit POST /send { to, text } comme
// l'agrégateur réel et rend le dernier message d'un numéro (GET /last?to=+237…),
// ce qui permet aux scripts k6 de lire le code de connexion des parents.
import { createServer } from 'node:http';

const last = new Map();
let received = 0;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sink');
  if (req.method === 'POST' && url.pathname === '/send') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { to, text } = JSON.parse(body);
        last.set(to, { text, count: (last.get(to)?.count ?? 0) + 1 });
        received++;
        res.writeHead(202).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  if (url.pathname === '/last') {
    const entry = last.get(url.searchParams.get('to'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(entry ?? { text: null, count: 0 }));
    return;
  }
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received, numbers: last.size }));
    return;
  }
  res.writeHead(404).end();
}).listen(8025, () => console.log('Passerelle SMS de test sur le port 8025'));
