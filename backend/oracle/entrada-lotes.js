// =====================================================================
// entrada-lotes.js
// Carrega a query de Movimentações de Entrada (com lotes/validade) e
// expõe uma função para buscá-las. Janela de datas (últimos 12 meses)
// é calculada dentro da própria query SQL (SYSDATE) — desliza sozinha.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

const SQL_ENTRADA_LOTES = fs.readFileSync(
  path.join(__dirname, 'query-entrada-lotes.sql'),
  'utf8'
);

/**
 * Busca as movimentações de Entrada dos últimos 12 meses (todas as unidades).
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarEntradaLotes() {
  return consultar(SQL_ENTRADA_LOTES);
}

module.exports = { buscarEntradaLotes };
