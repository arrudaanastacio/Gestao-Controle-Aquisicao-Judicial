// =====================================================================
// saida-lotes.js
// Carrega a query de Movimentações de Saída (com lotes/validade) e
// expõe uma função para buscá-las. Janela de datas (últimos 12 meses)
// é calculada dentro da própria query SQL (SYSDATE) — desliza sozinha.
// Espelha o saida-lotes.js irmão da Entrada (entrada-lotes.js).
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

const SQL_SAIDA_LOTES = fs.readFileSync(
  path.join(__dirname, 'query-saida-lotes.sql'),
  'utf8'
);

/**
 * Busca as movimentações de Saída dos últimos 12 meses (só Tenente Pena).
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarSaidaLotes() {
  return consultar(SQL_SAIDA_LOTES);
}

module.exports = { buscarSaidaLotes };
