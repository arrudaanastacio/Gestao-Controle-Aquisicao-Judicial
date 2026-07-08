// =====================================================================
// estoque.js
// Carrega a query de Itens em Estoque e expõe uma função para buscá-los.
// Sempre traz TODAS as unidades de uma vez.
// =====================================================================
const fs = require('fs');
const path = require('path');
const { consultar } = require('./db-oracle');

const SQL_ESTOQUE = fs.readFileSync(
  path.join(__dirname, 'query-estoque.sql'),
  'utf8'
);

/**
 * Busca os itens em estoque de todas as unidades.
 * @returns {Promise<Array<Object>>} linhas como objetos { COLUNA: valor }
 */
async function buscarEstoque() {
  return consultar(SQL_ESTOQUE);
}

module.exports = { buscarEstoque };
