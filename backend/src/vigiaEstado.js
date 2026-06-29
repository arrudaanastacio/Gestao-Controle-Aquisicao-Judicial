// Guarda a "assinatura" (mtime|tamanho) do último arquivo importado por cada
// vigia, de forma persistente. Assim, se o arquivo for atualizado com o sistema
// DESLIGADO, ao ligar o vigia detecta a diferença e importa.

const fs = require('node:fs');
const path = require('node:path');

const ARQ = path.join(__dirname, '..', 'data', '_vigia_estado.json');

function ler() {
  try { return JSON.parse(fs.readFileSync(ARQ, 'utf8')); }
  catch { return {}; }
}

function lerAssinatura(chave) {
  return ler()[chave] || null;
}

function salvarAssinatura(chave, assinatura) {
  const obj = ler();
  obj[chave] = assinatura;
  try { fs.writeFileSync(ARQ, JSON.stringify(obj, null, 2), 'utf8'); }
  catch (e) { console.error('[VIGIA] não consegui salvar o estado:', e.message); }
}

module.exports = { lerAssinatura, salvarAssinatura };
