/* eslint-disable @typescript-eslint/no-require-imports -- fichier CommonJS exécuté tel quel par Node et par Vercel */
// Fonction Vercel : toute requête est confiée à l'API Nest démarrée une fois par instance
// (voir src/serverless.ts, compilé dans dist/ par la construction).
module.exports = require('../dist/serverless.js').default;
